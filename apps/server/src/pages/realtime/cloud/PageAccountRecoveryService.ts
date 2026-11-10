import {
  PageId,
  PagesRpcError,
  type PageAccountRecoveryInput,
  type PageAccountRecoveryResult,
} from "@moss/contracts";
import { randomBytes } from "node:crypto";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MossCloudAccountService } from "../../../account/Services/MossCloudAccountService";
import { MossPhoneAccountService } from "../../../account/Services/MossPhoneAccountService";
import {
  onMossLocalAuthorityTransition,
  readMossLocalAuthorityRevision,
} from "../../../account/mossAccountLifecycleLock";
import { ServerSecretStore } from "../../../auth/Services/ServerSecretStore";
import { PagesService } from "../../Services/PagesService";
import { requireWsOwnerSession } from "../../../wsOwnerAuthorization";
import {
  AccountPageRecovery,
  AccountRecoveryPublication,
  type AccountPageRecoveryContext,
} from "./control/accountPageRecovery";
import { makeAccountPageRecovery } from "./control/accountPageRecoveryClient";
import { AccountRecoveryRuntime } from "./control/accountRecoveryRuntime";
import { makeAccountRecoveryPublication } from "./control/accountRecoveryPublication";
import { tenantRef } from "./control/roomControlProtocol";
import type { PageSpaceSync } from "./PageSpaceSyncService";
import { SpaceSyncProvision } from "./spaceSyncProvision";
import { AccountPublicationMenu } from "./AccountPublicationMenu";

interface Api {
  apply(
    input: PageAccountRecoveryInput,
    sync?: typeof PageSpaceSync.Service,
  ): Effect.Effect<PageAccountRecoveryResult, PagesRpcError>;
}
export class PageAccountRecoveryRpcService extends ServiceMap.Service<
  PageAccountRecoveryRpcService,
  Api
>()("moss/pages/PageAccountRecoveryRpcService") {}
const denied = () =>
  new PagesRpcError({ code: "forbidden", message: "Account page recovery is unavailable." });
const stale = () =>
  new PagesRpcError({ code: "conflict", message: "Refresh the list of synced pages." });
export const ownerAccountRecovery = (
  service: Api | undefined,
  input: PageAccountRecoveryInput,
  sync?: typeof PageSpaceSync.Service,
) =>
  requireWsOwnerSession.pipe(
    Effect.mapError(denied),
    Effect.andThen(() =>
      service
        ? service.apply(input, sync)
        : input.op === "availability"
          ? Effect.succeed({ kind: "availability" as const, available: false })
          : Effect.fail(denied()),
    ),
  );

const make = Effect.gen(function* () {
  const phone = yield* MossPhoneAccountService;
  const global = yield* MossCloudAccountService;
  const secrets = yield* ServerSecretStore;
  const provider = Option.getOrUndefined(yield* Effect.serviceOption(AccountPageRecovery));
  const writer = Option.getOrUndefined(yield* Effect.serviceOption(AccountRecoveryPublication));
  const runtime = Option.getOrUndefined(yield* Effect.serviceOption(AccountRecoveryRuntime));
  // Tests and explicitly embedded callers may inject a transport without the
  // process runtime. The production layer always supplies the runtime, so a
  // missing or degraded runtime remains fail-closed there.
  const remoteConfigured =
    runtime === undefined || (runtime.health.state === "ready" && runtime.transport !== null);
  const publication = new AccountPublicationMenu();
  const permits = yield* Effect.services<never>();
  const run = Effect.runPromiseWith(permits);
  const pending = new Set<AbortController>();
  const observed = new Map<
    string,
    { id: string; tenant: string; revision: number; version: number; expires: number }
  >();
  let closed = false;
  const invalidate = () => {
    observed.clear();
    publication.clear();
    for (const attempt of pending) attempt.abort();
  };
  const unsubscribe = onMossLocalAuthorityTransition(secrets, invalidate);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      unsubscribe();
      invalidate();
    }),
  );

  async function apply(
    input: PageAccountRecoveryInput,
    outer: AbortSignal,
    sync?: typeof PageSpaceSync.Service,
  ): Promise<PageAccountRecoveryResult> {
    const publishing = input.op === "publication-status" || input.op === "set-publication";
    if (closed || !remoteConfigured || !(publishing ? writer : provider)) {
      if (input.op === "availability") return { kind: "availability", available: false };
      if (input.op === "publication-status")
        return {
          kind: "publication",
          available: false,
          allowed: false,
          confirmedCount: 0,
          lastConfirmedAt: null,
          observation: "",
        };
      throw denied();
    }
    const revision = readMossLocalAuthorityRevision(secrets);
    if (revision === null || outer.aborted || pending.size >= 16) throw denied();
    const attempt = new AbortController();
    pending.add(attempt);
    const signal = AbortSignal.any([outer, attempt.signal]);
    const assertCurrent = () => {
      if (signal.aborted || closed || readMossLocalAuthorityRevision(secrets) !== revision)
        throw stale();
    };
    try {
      const accounts = await run(
        Effect.all([phone.getLocalAuthority(), global.getLocalAuthority()], { concurrency: 2 }),
      );
      assertCurrent();
      const matches = accounts.flatMap(({ identity, activeRealm }) => {
        if (!identity || (activeRealm !== "cn" && activeRealm !== "global")) return [];
        if (activeRealm === "cn" && identity.realm !== "memfire-phone") return [];
        if (activeRealm === "global" && identity.realm !== "supabase-google") return [];
        // The account services also expose the enterprise-key lane. The
        // runtime checks above are the narrowing boundary for recovery, whose
        // control plane has only the two signed-in account realms.
        return [
          identity as unknown as {
            realm: "memfire-phone" | "supabase-google";
            account: { id: string };
            gatewayBaseUrl: string;
          },
        ];
      });
      if (input.op === "availability")
        return { kind: "availability", available: matches.length === 1 };
      if (input.op === "publication-status" && matches.length !== 1)
        return {
          kind: "publication",
          available: false,
          allowed: false,
          confirmedCount: 0,
          lastConfirmedAt: null,
          observation: "",
        };
      if (matches.length !== 1) throw denied();
      const account = matches[0]!;
      const tenant = tenantRef(account.realm, account.account.id);
      const context: AccountPageRecoveryContext = {
        realm: account.realm,
        tenantRef: tenant,
        authorityRevision: revision,
        signal,
        assertCurrent,
        currentCredential: async () => {
          assertCurrent();
          const credential =
            account.realm === "memfire-phone"
              ? await run(phone.getAuthorityCredential())
              : await run(global.getAuthorityCredential());
          assertCurrent();
          if (
            credential.realm !== account.realm ||
            credential.gatewayBaseUrl !== account.gatewayBaseUrl
          )
            throw denied();
          return credential.accessToken;
        },
      };
      if (input.op === "publication-status" || input.op === "set-publication")
        return await publication.apply(input, context, writer, sync);
      if (!provider) throw denied();
      if (input.op === "list") {
        const { items } = await provider.list(context);
        assertCurrent();
        if (items.length > 64 || new Set(items.map((i) => i.recoveryId)).size !== items.length)
          throw denied();
        const now = Date.now();
        for (const [key, entry] of observed) if (entry.expires <= now) observed.delete(key);
        return {
          kind: "list",
          items: items.flatMap((item) => {
            const expiry = Date.parse(item.expiresAt);
            if (!Number.isFinite(expiry) || expiry <= now) return [];
            const observation = randomBytes(32).toString("hex");
            if (observed.size >= 128) observed.delete(observed.keys().next().value!);
            observed.set(observation, {
              id: item.recoveryId,
              tenant,
              revision,
              version: item.checkpointVersion,
              expires: Math.min(expiry, now + 60_000),
            });
            return [
              {
                recoveryId: item.recoveryId,
                title: item.title,
                confirmedAt: item.confirmedAt,
                observation,
              },
            ];
          }),
        };
      }
      const entry = observed.get(input.observation);
      observed.delete(input.observation);
      if (
        !entry ||
        entry.id !== input.recoveryId ||
        entry.tenant !== tenant ||
        entry.revision !== revision ||
        entry.expires <= Date.now()
      )
        throw stale();
      const result = await provider.restore(context, {
        recoveryId: entry.id,
        expectedCheckpointVersion: entry.version,
        targetScopeSpaceId: null,
      });
      assertCurrent();
      if (result.checkpointVersion !== entry.version) throw stale();
      return { kind: "restored", pageId: Schema.decodeUnknownSync(PageId)(result.pageId) };
    } finally {
      pending.delete(attempt);
      attempt.abort();
    }
  }
  return {
    apply: (input: PageAccountRecoveryInput, sync?: typeof PageSpaceSync.Service) =>
      Effect.tryPromise({
        try: (signal) => apply(input, signal, sync),
        catch: (cause) => (cause instanceof PagesRpcError ? cause : denied()),
      }),
  };
});
export const PageAccountRecoveryRpcLive = Layer.effect(PageAccountRecoveryRpcService, make);

/**
 * Local page installation is deliberately a separate layer from the RPC
 * facade. It can only construct a client when the server runtime has an
 * explicit recovery origin; no fallback relay or generated key is allowed.
 */
export const AccountPageRecoveryLive = Layer.effect(
  AccountPageRecovery,
  Effect.gen(function* () {
    const runtime = yield* AccountRecoveryRuntime;
    const sql = yield* SqlClient.SqlClient;
    const pages = yield* PagesService;
    if (!runtime.transport) {
      return {
        list: async () => {
          throw new Error("Account recovery transport is not configured");
        },
        restore: async () => {
          throw new Error("Account recovery transport is not configured");
        },
      } satisfies typeof AccountPageRecovery.Service;
    }
    return makeAccountPageRecovery(runtime.transport, sql, pages);
  }),
);

/** Owner publication is only composed when the independent space provisioner
 * supplies real owner rooms and lifecycle fencing. A configured transport by
 * itself cannot opt a page into the cloud. */
export const AccountRecoveryPublicationLive = Layer.effect(
  AccountRecoveryPublication,
  Effect.gen(function* () {
    const runtime = yield* AccountRecoveryRuntime;
    const provision = Option.getOrUndefined(yield* Effect.serviceOption(SpaceSyncProvision));
    const config = provision?.accountRecovery?.();
    if (!runtime.transport || !config) {
      return {
        status: async () => ({
          state: "unavailable",
          allowed: false,
          confirmedCount: 0,
          lastConfirmedAt: null,
        }),
        saveConfirmed: async () => {
          throw new Error("Account recovery publication is not provisioned");
        },
        revoke: async () => {
          throw new Error("Account recovery publication is not provisioned");
        },
      } satisfies typeof AccountRecoveryPublication.Service;
    }
    return makeAccountRecoveryPublication({ ...config, transport: runtime.transport });
  }),
);
