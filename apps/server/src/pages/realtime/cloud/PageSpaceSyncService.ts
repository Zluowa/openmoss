import { PagesRpcError, type PageSpaceSyncInput, type PageSpaceSyncState } from "@moss/contracts";
import { Effect, Layer, Option, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MossCloudAccountService } from "../../../account/Services/MossCloudAccountService";
import { MossPhoneAccountService } from "../../../account/Services/MossPhoneAccountService";
import {
  onMossLocalAuthorityTransition,
  readMossLocalAuthorityRevision,
} from "../../../account/mossAccountLifecycleLock";
import { ServerSecretStore } from "../../../auth/Services/ServerSecretStore";
import { ServerConfig } from "../../../config";
import { requireWsOwnerSession } from "../../../wsOwnerAuthorization";
import { scopeKey } from "../../sharing/pageSharingStore";
import { onSpaceMembershipChange } from "../../spaceSyncMembership";
import { makeRoomProfileAccess } from "./roomProfileStorage";
import { tenantRef } from "./control/roomControlProtocol";
import { spaceSyncPreference, spaceTargetKey } from "./spaceSyncPreference";
import {
  inspectSpacePlan,
  SpaceSyncProvision,
  startSpacePlan,
  type SpaceTarget,
} from "./spaceSyncProvision";
import { SpaceSyncObservations } from "./spaceSyncObservations";

const problem = (code: "forbidden" | "not-found" | "storage") =>
  new PagesRpcError({
    code,
    message:
      code === "storage"
        ? "The space sync preference could not be saved or read."
        : code === "not-found"
          ? "Space unavailable."
          : "Space sync is unavailable.",
  });
const conflict = () =>
  new PagesRpcError({ code: "conflict", message: "Space sync settings changed. Reopen the menu." });
interface Api {
  apply(input: PageSpaceSyncInput): Effect.Effect<PageSpaceSyncState, PagesRpcError>;
  /** Local lease ending on disable, account transition, scope change or reprovisioning. */
  recoveryConsent?(target: SpaceTarget): AbortSignal | null;
}
export class PageSpaceSync extends ServiceMap.Service<PageSpaceSync, Api>()(
  "moss/pages/PageSpaceSync",
) {}
export const ownerSpaceSync = (service: Api | undefined, input: PageSpaceSyncInput) =>
  requireWsOwnerSession.pipe(
    Effect.mapError(() => problem("forbidden")),
    Effect.andThen(() => (service ? service.apply(input) : Effect.fail(problem("storage")))),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient,
    config = yield* ServerConfig,
    secrets = yield* ServerSecretStore;
  const phone = yield* MossPhoneAccountService,
    cloud = yield* MossCloudAccountService;
  const provider = Option.getOrUndefined(yield* Effect.serviceOption(SpaceSyncProvision));
  // Only explicit provisioning enables profile inspection or transport restoration.
  const profile = provider ? yield* makeRoomProfileAccess.pipe(Effect.option) : Option.none();
  const permits = yield* Effect.services<never>();
  const run = Effect.runPromiseWith(permits);
  const jobs = new Map<string, { life: AbortController; connected: () => boolean }>();
  const serial = new Map<string, Promise<unknown>>();
  const pending = new Map<string, number>();
  const observations = new SpaceSyncObservations(),
    writing = new Map<string, AbortController>();
  let closed = false;
  const stop = (key: string) => {
    const job = jobs.get(key);
    jobs.delete(key);
    job?.life.abort();
  };
  const stopAll = () => {
    for (const attempt of writing.values()) attempt.abort();
    for (const key of jobs.keys()) stop(key);
  };
  function ordered<T>(key: string, task: () => Promise<T>) {
    const op = (serial.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    serial.set(key, op);
    const release = () => {
      if (serial.get(key) === op) serial.delete(key);
    };
    void op.then(release, release);
    return op;
  }
  async function planFor(target: SpaceTarget) {
    if (!provider || Option.isNone(profile) || closed) return null;
    const revision = readMossLocalAuthorityRevision(secrets);
    if (revision === null) return null;
    const states = await run(
      Effect.all([phone.getLocalAuthority(), cloud.getLocalAuthority()], { concurrency: 2 }),
    );
    const current = states.flatMap((state) => {
      const account = state.identity;
      if (!account) return [];
      const realm =
        state.activeRealm === "cn"
          ? "memfire-phone"
          : state.activeRealm === "global"
            ? "supabase-google"
            : null;
      return realm && account.realm === realm
        ? [{ realm, accountId: account.account.id } as const]
        : [];
    });
    const [account] = current;
    if (current.length !== 1 || !account || readMossLocalAuthorityRevision(secrets) !== revision)
      return null;
    const tenant = tenantRef(account.realm, account.accountId);
    const local = profile.value;
    await run(local.assertCurrent());
    const rooms = provider.rooms();
    if (rooms.length > 64) return null;
    const ids = new Set<string>();
    for (const r of rooms.filter(
      (r) => r.scopeSpaceId === target.scopeSpaceId && r.spaceId === target.spaceId,
    )) {
      const [row] =
        await run(sql`SELECT 1 FROM pages_documents WHERE page_id=${r.pageId} AND space_id=${target.spaceId}
        AND scope_key=${scopeKey(target.scopeSpaceId)} AND trashed_at IS NULL AND kind='page'`);
      if (row) ids.add(r.pageId);
    }
    return inspectSpacePlan(
      target,
      rooms,
      tenant,
      local.storage.profileRef,
      ids,
      revision,
      () => !closed && readMossLocalAuthorityRevision(secrets) === revision,
    );
  }
  async function read(input: SpaceTarget, justCleared = false): Promise<PageSpaceSyncState> {
    const key = spaceTargetKey(input.scopeSpaceId, input.spaceId),
      pref = spaceSyncPreference(config.stateDir, key);
    const revision = readMossLocalAuthorityRevision(secrets);
    if (closed || revision === null || writing.has(key)) throw conflict();
    const [space] = await run(sql`SELECT 1 FROM pages_spaces WHERE space_id=${input.spaceId}
      AND scope_key=${scopeKey(input.scopeSpaceId)} AND trashed_at IS NULL`);
    const disk = await pref.snapshot();
    if (!space && disk.version === "absent" && !justCleared) throw problem("not-found");
    const plan = space && !disk.invalid ? await planFor(input).catch(() => null) : null;
    const available = !!plan,
      enabled = !!plan && disk.binding === plan.binding;
    plan?.release();
    if (
      closed ||
      readMossLocalAuthorityRevision(secrets) !== revision ||
      writing.has(key) ||
      (await pref.snapshot()).version !== disk.version ||
      readMossLocalAuthorityRevision(secrets) !== revision ||
      writing.has(key)
    )
      throw conflict();
    return {
      available,
      enabled,
      connected: enabled && (jobs.get(key)?.connected() ?? false),
      canClear: disk.invalid || (disk.binding !== null && !enabled),
      observation: observations.issue(key, disk.version, revision, plan?.binding ?? null),
    };
  }
  async function settings(input: PageSpaceSyncInput, restore = false): Promise<void> {
    const key = spaceTargetKey(input.scopeSpaceId, input.spaceId),
      pref = spaceSyncPreference(config.stateDir, key);
    const before = await pref.snapshot(),
      revision = readMossLocalAuthorityRevision(secrets);
    if (writing.has(key) || closed || revision === null) throw conflict();
    const observed = restore
      ? undefined
      : observations.claim(input.observation, key, before.version, revision);
    if (!restore && !observed) throw conflict();
    if (restore && (before.invalid || !before.binding || jobs.get(key)?.connected())) return;
    if (before.invalid && input.enabled !== false) throw problem("storage");
    const attempt = new AbortController();
    writing.set(key, attempt);
    observations.invalidate(key);
    if (input.enabled === false) stop(key);
    let job: { life: AbortController; connected: () => boolean } | undefined;
    try {
      await ordered(key, async () => {
        if (closed) throw problem("storage");
        if (
          attempt.signal.aborted ||
          readMossLocalAuthorityRevision(secrets) !== revision ||
          (await pref.snapshot()).version !== before.version ||
          attempt.signal.aborted ||
          readMossLocalAuthorityRevision(secrets) !== revision
        )
          throw conflict();
        if (input.enabled === false) {
          await pref.clear();
          return;
        }
        const [space] = await run(sql`SELECT 1 FROM pages_spaces WHERE space_id=${input.spaceId}
        AND scope_key=${scopeKey(input.scopeSpaceId)} AND trashed_at IS NULL`);
        if (!space) throw problem("not-found");
        const saved = before.binding;
        const plan = await planFor(input);
        if (!plan) throw problem("forbidden");
        if (
          attempt.signal.aborted ||
          readMossLocalAuthorityRevision(secrets) !== revision ||
          (restore ? saved : observed?.binding) !== plan.binding
        ) {
          plan.release();
          throw conflict();
        }
        if (jobs.get(key)?.connected() && saved === plan.binding) {
          plan.release();
          return;
        }
        stop(key);
        if (jobs.size >= 16) {
          plan.release();
          throw problem("forbidden");
        }
        job = { life: attempt, connected: () => false };
        jobs.set(key, job);
        const life = job.life,
          timeout = setTimeout(() => life.abort(), 8000);
        life.signal.addEventListener(
          "abort",
          () => {
            if (jobs.get(key) === job) jobs.delete(key);
          },
          { once: true },
        );
        try {
          if (life.signal.aborted || pending.has(key) || pending.size >= 8)
            throw problem("forbidden");
          const binding = plan.binding;
          const handle = await startSpacePlan(plan, life, <T>(operation: Promise<T>) => {
            pending.set(key, (pending.get(key) ?? 0) + 1);
            return operation.finally(() => {
              const remaining = (pending.get(key) ?? 1) - 1;
              if (remaining) pending.set(key, remaining);
              else pending.delete(key);
            });
          });
          if (life.signal.aborted) throw problem("forbidden");
          if (!restore) {
            await pref.write(binding);
            if (life.signal.aborted) {
              if (saved) await pref.write(saved);
              else await pref.clear();
              throw problem("forbidden");
            }
          }
          job.connected = handle.connected;
        } catch (cause) {
          plan.release();
          if (jobs.get(key) === job) stop(key);
          else life.abort();
          throw cause;
        } finally {
          clearTimeout(timeout);
        }
      });
    } finally {
      writing.delete(key);
    }
  }
  let restoreTask: Promise<void> | undefined,
    restoreAgain = false;
  function restore() {
    if (!provider || closed) return;
    if (restoreTask) {
      restoreAgain = true;
      return;
    }
    restoreTask = Promise.resolve()
      .then(async () => {
        const rooms = provider.rooms();
        if (rooms.length > 64) return;
        const unique = new Map<string, SpaceTarget>();
        for (const r of rooms)
          unique.set(spaceTargetKey(r.scopeSpaceId, r.spaceId), {
            scopeSpaceId: r.scopeSpaceId,
            spaceId: r.spaceId,
          });
        if (unique.size > 16) return;
        for (const target of unique.values()) {
          if (closed) return;
          await settings(target, true).catch(() => undefined);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        restoreTask = undefined;
        if (restoreAgain) {
          restoreAgain = false;
          restore();
        }
      });
  }
  const leaveAccount = onMossLocalAuthorityTransition(secrets, () => {
    observations.invalidate();
    stopAll();
  });
  const leaveMembership = onSpaceMembershipChange(sql, (scope, space) => {
    const key = spaceTargetKey(scope, space);
    observations.invalidate(key);
    writing.get(key)?.abort();
    stop(key);
  });
  const leaveProvision = provider?.listen(() => {
    observations.invalidate();
    stopAll();
    restore();
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      observations.invalidate();
      leaveAccount();
      leaveMembership();
      leaveProvision?.();
      stopAll();
      await Promise.allSettled([restoreTask, ...serial.values()]);
    }),
  );
  restore();
  return {
    recoveryConsent: (target: SpaceTarget) => {
      const key = spaceTargetKey(target.scopeSpaceId, target.spaceId);
      const signal = jobs.get(key)?.life.signal;
      return closed || writing.has(key) || !signal || signal.aborted ? null : signal;
    },
    apply: (input: PageSpaceSyncInput) =>
      Effect.tryPromise({
        try: async () => {
          if (input.enabled !== undefined) await settings(input);
          return read(input, input.enabled === false);
        },
        catch: (cause) =>
          cause instanceof PagesRpcError ? cause : problem(input.enabled ? "forbidden" : "storage"),
      }),
  } satisfies Api;
});
export const PageSpaceSyncLive = Layer.effect(PageSpaceSync, make);
