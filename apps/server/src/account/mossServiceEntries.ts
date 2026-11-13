// FILE: mossServiceEntries.ts
// Purpose: Picks which of a service's configured entries (base URLs) Moss uses. The CN model
// gateway and CN payments each have a primary entry and, since the 2026-11-12 incident (direct
// mainland HTTPS to the primary was reset after the TLS handshake), fallback entries that reach
// the same server another way. The failover is sticky: an entry that fails below HTTP is
// suspect for a cool-down, and Moss returns to an earlier entry only after the cool-down and
// several good health checks in a row, spread over minutes.
// Layer: account (server). Which entries exist and may receive a credential is decided by the
// release manifest and the trust checks, never here.
// Why: from mainland networks the primary was intermittent (about one request in six got
// through). Deciding by one health check kept Moss on an entry that reset most real requests,
// and flapped between entries, re-provisioning the Moss lanes on every change.

import type { ProviderRuntimeEvent } from "@moss/contracts";
import { splitMossServiceUrlList } from "@moss/shared/mossProductionPublicConfig";
import { Duration, Effect, Schedule, Stream } from "effect";

import { mossManagedGatewayEntriesForAuthority } from "../provider/mossManagedGatewayTrust";

/** How long one health check may take before the entry counts as unreachable. */
export const MOSS_SERVICE_ENTRY_PROBE_TIMEOUT_MS = 4_000;
/** How often the entries in use are checked again. */
export const MOSS_SERVICE_ENTRY_REPROBE_INTERVAL_MS = 5 * 60_000;
/** Reported failures check the other entries again at most this often. */
export const MOSS_SERVICE_ENTRY_FAILURE_RECHECK_MS = 15_000;
/**
 * An entry that failed below HTTP (a failed health check, or a real request reported through
 * `reportConnectionFailure`) is suspect this long: it is not chosen while another entry
 * answers, and its good health checks do not count yet. Every new failure starts it again.
 */
export const MOSS_SERVICE_ENTRY_SUSPECT_COOLDOWN_MS = 30 * 60_000;
/** After its cool-down, an entry that failed must pass this many health checks in a row. */
export const MOSS_SERVICE_ENTRY_RETURN_GOOD_PROBES = 4;
/** Those health checks count only when at least this far apart. */
export const MOSS_SERVICE_ENTRY_RETURN_PROBE_SPACING_MS = 60_000;
/**
 * At first use every entry is checked this many times at once (separate connections). An
 * entry is trusted over a later one only when every check passed. A healthy primary costs
 * one round trip, as before; an entry passing one request in six passes all three once in 216.
 */
export const MOSS_SERVICE_ENTRY_FIRST_USE_SAMPLES = 3;

export type MossServiceEntryProbe = (healthUrl: string, signal: AbortSignal) => Promise<boolean>;

export interface MossServiceEntryChange {
  /** Which service, in words for the log ("CN model gateway"). */
  readonly service: string;
  readonly from: string;
  readonly to: string;
}

export interface MossServiceEntryRouter {
  readonly service: string;
  /** Primary first. */
  readonly entries: ReadonlyArray<string>;
  /** The entry in use now: the primary until a check says otherwise. */
  readonly current: () => string;
  /**
   * The entry to use. The first call checks the entries and waits for the answer; later calls
   * return at once and, when a check is due, start one in the background.
   */
  readonly ensure: () => Promise<string>;
  /**
   * A real request to `url` failed before any HTTP response. The entry becomes suspect; when
   * it is the one in use, the other entries are checked (at most every few seconds) and the
   * entry to use next is returned.
   */
  readonly reportConnectionFailure: (url: string) => Promise<string>;
  /**
   * A hint that `url` may have failed, from a source that cannot prove it. When it is the
   * entry in use, every entry is checked again (at most every few seconds); only those health
   * checks can move Moss. Returns the entry to use next.
   */
  readonly recheck: (url: string) => Promise<string>;
  /**
   * Checks the entries again when a check is due. Does nothing for a router nobody has used
   * yet, so a person who never uses this service never sends it a request.
   */
  readonly refreshIfDue: () => Promise<void>;
  /** True when the last check reached no entry at all. */
  readonly allUnreachable: () => boolean;
}

const sameEntry = (a: string, b: string) => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

const listeners = new Set<(change: MossServiceEntryChange) => void>();

/** Called whenever any router changes its entry. Returns the unsubscribe function. */
export function subscribeMossServiceEntryChanges(
  listener: (change: MossServiceEntryChange) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The one log line for a change: service and host names only, never a path or credential. */
export function describeMossServiceEntryChange(change: MossServiceEntryChange): string {
  return `Moss ${change.service} entry changed: ${new URL(change.from).host} -> ${new URL(change.to).host}`;
}

const CONNECTION_FAILURE_CODE =
  /^(?:E(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|NOTFOUND|AI_AGAIN|AI_FAIL|HOSTUNREACH|NETUNREACH|NETDOWN|PROTO)|UND_ERR_\w+|ERR_TLS_\w+|ERR_SSL_\w+|ERR_SOCKET_\w+|\w*CERT\w*|UNABLE_TO_\w+|Connection(?:Refused|Closed|Reset)|FailedToOpenSocket|TLSHandshakeFailed)$/u;

/**
 * Whether a fetch failure happened below HTTP: a reset, a refused or timed-out connection, a
 * TLS failure or a DNS failure. Any HTTP response, even a 5xx, is an answer from the service
 * and never moves Moss to another entry. With `timeouts: false` the caller's own request
 * timeout does not count: for a long request (a model call, a media job) it says nothing about
 * the path, only that no answer came in time.
 */
export function isMossConnectionLevelFailure(
  cause: unknown,
  options: { readonly timeouts?: boolean } = {},
): boolean {
  const timeouts = options.timeouts ?? true;
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const record = current as { readonly code?: unknown; readonly name?: unknown };
    if (typeof record.code === "string" && CONNECTION_FAILURE_CODE.test(record.code)) return true;
    if (record.name === "TimeoutError" || record.name === "AbortError") return timeouts;
    if (current instanceof TypeError && current.message === "fetch failed") return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

const defaultProbe: MossServiceEntryProbe = async (healthUrl, signal) => {
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "Moss" },
      redirect: "error",
      cache: "no-store",
      signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
};

/** What the router knows about one entry. */
interface EntryHealth {
  /** Whether the entry answered at least one health check of the last round that checked it. */
  answered: boolean | null;
  /** When it last failed below HTTP; null when it never did. */
  failedAt: number | null;
  /** Suspect until then (exclusive). */
  suspectUntil: number;
  /** Good health checks in a row since its cool-down ended, counted at most once per spacing. */
  goodStreak: number;
  lastCountedGoodAt: number | null;
}

/**
 * How good an entry is to use, lower is better:
 * 0 trusted (answers; never failed, or passed its return checks),
 * 1 on its way back (answers, cool-down over, return checks not complete yet),
 * 2 suspect (answers, but failed within the cool-down),
 * 3 does not answer.
 */
type EntryRank = 0 | 1 | 2 | 3;

export function makeMossServiceEntryRouter(input: {
  readonly service: string;
  readonly entries: ReadonlyArray<string>;
  /** The unauthenticated health URL of an entry. */
  readonly healthUrl: (entry: string) => string;
  readonly probe?: MossServiceEntryProbe;
  readonly now?: () => number;
  readonly probeTimeoutMs?: number;
  readonly reprobeIntervalMs?: number;
  readonly failureRecheckMs?: number;
  readonly suspectCooldownMs?: number;
  readonly returnGoodProbes?: number;
  readonly returnProbeSpacingMs?: number;
  readonly firstUseSamples?: number;
}): MossServiceEntryRouter {
  const entries = [...new Set(input.entries)];
  const probe = input.probe ?? defaultProbe;
  const now = input.now ?? Date.now;
  const probeTimeoutMs = input.probeTimeoutMs ?? MOSS_SERVICE_ENTRY_PROBE_TIMEOUT_MS;
  const reprobeIntervalMs = input.reprobeIntervalMs ?? MOSS_SERVICE_ENTRY_REPROBE_INTERVAL_MS;
  const failureRecheckMs = input.failureRecheckMs ?? MOSS_SERVICE_ENTRY_FAILURE_RECHECK_MS;
  const cooldownMs = input.suspectCooldownMs ?? MOSS_SERVICE_ENTRY_SUSPECT_COOLDOWN_MS;
  const returnGoodProbes = input.returnGoodProbes ?? MOSS_SERVICE_ENTRY_RETURN_GOOD_PROBES;
  const spacingMs = input.returnProbeSpacingMs ?? MOSS_SERVICE_ENTRY_RETURN_PROBE_SPACING_MS;
  const firstUseSamples = Math.max(
    1,
    input.firstUseSamples ?? MOSS_SERVICE_ENTRY_FIRST_USE_SAMPLES,
  );
  const health: EntryHealth[] = entries.map(() => ({
    answered: null,
    failedAt: null,
    suspectUntil: 0,
    goodStreak: 0,
    lastCountedGoodAt: null,
  }));
  let activeIndex = 0;
  let checkedAt: number | null = null;
  let changedAt: number | null = null;
  let unreachable = false;
  let inflight: Promise<string> | null = null;

  const current = () => entries[activeIndex] ?? "";

  const recordFailure = (index: number, answered: boolean) => {
    const entry = health[index]!;
    const at = now();
    entry.answered = answered;
    entry.failedAt = at;
    entry.suspectUntil = at + cooldownMs;
    entry.goodStreak = 0;
    entry.lastCountedGoodAt = null;
  };

  const recordPass = (index: number) => {
    const entry = health[index]!;
    const at = now();
    entry.answered = true;
    if (entry.failedAt === null || at < entry.suspectUntil) return;
    if (entry.lastCountedGoodAt !== null && at - entry.lastCountedGoodAt < spacingMs) return;
    entry.goodStreak += 1;
    entry.lastCountedGoodAt = at;
  };

  /** One round's samples of an entry: every one passed, or how many did. */
  const record = (index: number, passes: number, samples: number) => {
    if (passes === samples) recordPass(index);
    else recordFailure(index, passes > 0);
  };

  /** Failed once, cool-down over, return checks not complete. */
  const onWayBack = (index: number) => {
    const entry = health[index]!;
    return (
      entry.failedAt !== null && now() >= entry.suspectUntil && entry.goodStreak < returnGoodProbes
    );
  };

  const rank = (index: number): EntryRank => {
    const entry = health[index]!;
    if (entry.answered !== true) return 3;
    if (entry.failedAt === null) return 0;
    if (now() < entry.suspectUntil) return 2;
    return entry.goodStreak >= returnGoodProbes ? 0 : 1;
  };

  const select = (index: number) => {
    if (index === activeIndex) return;
    const change = { service: input.service, from: current(), to: entries[index]! };
    activeIndex = index;
    changedAt = now();
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure never changes which entry is used.
      }
    }
  };

  /**
   * Picks the entry from what is known. While the entry in use is trusted, Moss moves only
   * back to an earlier trusted entry, and only once a cool-down has passed since the last
   * change. When the entry in use is not trusted (it failed), the best-ranked entry is used,
   * the entry in use winning a tie. When no entry answers, nothing changes.
   */
  const choose = () => {
    const ranks = entries.map((_, index) => rank(index));
    unreachable = ranks.every((value) => value === 3);
    if (unreachable) return;
    if (ranks[activeIndex] === 0) {
      const earlier = ranks.findIndex((value, index) => value === 0 && index < activeIndex);
      if (earlier >= 0 && (changedAt === null || now() - changedAt >= cooldownMs)) {
        select(earlier);
      }
      return;
    }
    const best = Math.min(...ranks);
    if (ranks[activeIndex] !== best) select(ranks.indexOf(best as EntryRank));
  };

  /**
   * Checks `indices`, each `samples` times at once, and records what answered. With
   * `firstTrusted`, the round ends as soon as the earliest entry passes every check and no
   * earlier one can still: a healthy primary costs one round trip.
   */
  const runRound = async (
    indices: ReadonlyArray<number>,
    samples: number,
    firstTrusted: boolean,
  ) => {
    const controllers = indices.map(() => new AbortController());
    const timers = controllers.map((controller) =>
      setTimeout(() => controller.abort(), probeTimeoutMs),
    );
    const outcomes = indices.map((index, position) => {
      const signal = controllers[position]!.signal;
      const checks = Array.from({ length: samples }, () =>
        probe(input.healthUrl(entries[index]!), signal).catch(() => false),
      );
      let passedSoFar = 0;
      // Resolves true once every check passed, false once one failed.
      const verdict = new Promise<boolean>((resolve) => {
        for (const check of checks) {
          void check.then((ok) => {
            if (!ok) resolve(false);
            else if (++passedSoFar === samples) resolve(true);
          });
        }
      });
      const passes = Promise.all(checks).then((results) => results.filter(Boolean).length);
      return { index, verdict, passes, passedSoFar: () => passedSoFar };
    });
    try {
      if (firstTrusted) {
        for (const [position, outcome] of outcomes.entries()) {
          if (!(await outcome.verdict)) continue;
          // Earlier entries failed a check (their slower checks are not waited for); later
          // entries were not needed.
          for (const earlier of outcomes.slice(0, position)) {
            record(earlier.index, earlier.passedSoFar(), samples);
          }
          recordPass(outcome.index);
          return;
        }
      }
      for (const outcome of outcomes) record(outcome.index, await outcome.passes, samples);
    } finally {
      checkedAt = now();
      for (const timer of timers) clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    }
  };

  const allIndices = entries.map((_, index) => index);

  const refresh = (kind: "first" | "due" | "failure"): Promise<string> => {
    inflight ??= (async () => {
      if (kind === "first") await runRound(allIndices, firstUseSamples, true);
      else if (kind === "due") await runRound(allIndices, 1, false);
      // The entry in use just failed; a lucky answer from it now would prove nothing.
      else
        await runRound(
          allIndices.filter((index) => index !== activeIndex),
          1,
          false,
        );
      choose();
      return current();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  /**
   * A check is due every re-probe interval, and every spacing while an earlier entry is on
   * its way back, so a recovered primary needs minutes, not hours, to collect its checks.
   */
  const checkDue = () => {
    if (checkedAt === null) return false;
    const elapsed = now() - checkedAt;
    if (elapsed >= reprobeIntervalMs) return true;
    return (
      elapsed >= spacingMs && health.some((_, index) => index < activeIndex && onWayBack(index))
    );
  };

  return {
    service: input.service,
    entries,
    current,
    ensure: async () => {
      if (entries.length < 2) return current();
      if (checkedAt === null) return refresh("first");
      if (checkDue()) void refresh("due");
      return current();
    },
    reportConnectionFailure: async (url) => {
      const index = entries.findIndex((entry) => sameEntry(entry, url));
      if (entries.length < 2 || index < 0) return current();
      recordFailure(index, false);
      if (index !== activeIndex) return current();
      if (inflight) return inflight;
      const othersKnown = health.every(
        (entry, other) => other === activeIndex || entry.answered !== null,
      );
      if (othersKnown && checkedAt !== null && now() - checkedAt < failureRecheckMs) {
        // Every other entry was checked moments ago: decide from those answers.
        choose();
        return current();
      }
      return refresh("failure");
    },
    recheck: async (url) => {
      if (entries.length < 2 || !sameEntry(url, current())) return current();
      if (inflight) return inflight;
      if (checkedAt !== null && now() - checkedAt < failureRecheckMs) return current();
      return refresh("due");
    },
    refreshIfDue: async () => {
      if (entries.length < 2 || !checkDue()) return;
      await refresh("due");
    },
    allUnreachable: () => unreachable,
  };
}

const routers = new Map<string, MossServiceEntryRouter>();

function cachedRouter(key: string, build: () => MossServiceEntryRouter): MossServiceEntryRouter {
  let router = routers.get(key);
  if (!router) {
    router = build();
    routers.set(key, router);
  }
  return router;
}

/** Forgets every router's state. Tests only. */
export function resetMossServiceEntryRoutersForTest(): void {
  routers.clear();
}

/** Makes `router` one of the routers in use, as a configured one would be. Tests only. */
export function registerMossServiceEntryRouterForTest(router: MossServiceEntryRouter): void {
  routers.set(`test:${router.entries.join(" ")}`, router);
}

/**
 * The router in use that lists `url` as one of its entries, or null (a Google account's
 * gateway, a service nobody used yet). Credentials carry the entry they were issued with, so
 * this is how a request finds the router that owns its entry.
 */
export function mossServiceEntryRouterFor(url: string): MossServiceEntryRouter | null {
  for (const router of routers.values()) {
    if (router.entries.some((entry) => sameEntry(entry, url))) return router;
  }
  return null;
}

/**
 * The entry a request should go to: the router's entry in use when `url` is one of its
 * entries (it may have changed since the credential was issued), else `url` itself.
 */
export function mossServiceEntryInUse(
  url: string,
  router: MossServiceEntryRouter | null = mossServiceEntryRouterFor(url),
): string {
  return router && router.entries.some((entry) => sameEntry(entry, url)) ? router.current() : url;
}

/**
 * Sends one request to the entry in use. A failure below HTTP is reported, so the entry
 * becomes suspect and the next request goes elsewhere. Only when `retryOnNextEntry` (a read, a
 * catalog, a status poll: asking twice changes nothing) is the same request sent once more to
 * the next usable entry within this call. A request that creates, charges or starts work is
 * never sent to a second entry: the caller reports its usual error and the person's next
 * attempt goes to the entry that works. HTTP answers, even 5xx, are returned as they are.
 */
export async function fetchViaMossServiceEntries(input: {
  /** The entry the caller's credential names. */
  readonly entry: string;
  readonly send: (entry: string) => Promise<Response>;
  readonly retryOnNextEntry: boolean;
  /** Whether the caller's own timeout counts as a connection failure (short requests only). */
  readonly timeoutIsConnectionFailure?: boolean;
  /** The router to use; by default the router in use that lists `entry`. */
  readonly router?: MossServiceEntryRouter | null;
}): Promise<Response> {
  const router = input.router === undefined ? mossServiceEntryRouterFor(input.entry) : input.router;
  const listed = router?.entries.some((entry) => sameEntry(entry, input.entry)) === true;
  const first = mossServiceEntryInUse(input.entry, router);
  const failedBelowHttp = (cause: unknown) =>
    isMossConnectionLevelFailure(cause, { timeouts: input.timeoutIsConnectionFailure ?? true });
  try {
    return await input.send(first);
  } catch (cause) {
    if (!router || !listed || !failedBelowHttp(cause)) throw cause;
    const next = await router.reportConnectionFailure(first);
    if (!input.retryOnNextEntry || next === first) throw cause;
    try {
      return await input.send(next);
    } catch (retryCause) {
      if (failedBelowHttp(retryCause)) await router.reportConnectionFailure(next);
      throw retryCause;
    }
  }
}

export function mossModelGatewayHealthUrl(entry: string): string {
  return `${new URL(entry).origin}/functions/v1/moss-model-gateway/healthz`;
}

export function mossPayHealthUrl(entry: string): string {
  return `${entry.replace(/\/+$/u, "")}/healthz`;
}

export const MOSS_CN_MODEL_GATEWAY_SERVICE = "CN model gateway";

/**
 * The CN model gateway's entries (phone and enterprise-key lanes share them). `primary` is
 * the phone realm's already validated gateway URL; without it the configured primary is used.
 */
export function mossCnModelGatewayEntries(
  env: Readonly<Record<string, string | undefined>> = process.env,
  primary?: string,
): MossServiceEntryRouter {
  const configured = mossManagedGatewayEntriesForAuthority("memfire-phone", env);
  const entries = primary ? [primary, ...configured.slice(1)] : [...configured];
  return cachedRouter(`model:${entries.join(" ")}`, () =>
    makeMossServiceEntryRouter({
      service: MOSS_CN_MODEL_GATEWAY_SERVICE,
      entries,
      healthUrl: mossModelGatewayHealthUrl,
    }),
  );
}

export const MOSS_MEMFIRE_PHONE_PAY_BASE_URL_ENV_KEY = "MOSS_MEMFIRE_PHONE_PAY_BASE_URL";
export const MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS_ENV_KEY =
  "MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS";

/** One payment entry exactly as configured, or undefined when it is unusable. */
export function parseMossPayEntry(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const loopbackHttp = url.protocol === "http:" && url.hostname === "127.0.0.1";
    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/**
 * The CN payment entries: the configured payment URL, then its listed fallbacks. Only entries
 * listed for payments are ever used; a model gateway entry never becomes a payment entry.
 */
export function mossCnPayEntries(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MossServiceEntryRouter | null {
  const primary = parseMossPayEntry(env[MOSS_MEMFIRE_PHONE_PAY_BASE_URL_ENV_KEY]);
  if (!primary) return null;
  const fallbacks = splitMossServiceUrlList(env[MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS_ENV_KEY])
    .map(parseMossPayEntry)
    .filter((entry): entry is string => entry !== undefined && entry.startsWith("https://"));
  const entries = [primary, ...fallbacks];
  return cachedRouter(`pay:${entries.join(" ")}`, () =>
    makeMossServiceEntryRouter({ service: "CN payment", entries, healthUrl: mossPayHealthUrl }),
  );
}

/**
 * Logs each entry change once and hands a CN model gateway change to the lanes that were
 * provisioned with the old entry. Every minute, routers already in use are checked again when
 * a check is due, so Moss returns to a recovered primary without a request failing.
 */
export const startMossServiceEntryMaintenance = (input: {
  readonly onCnModelGatewayChange: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<never>();
    const run = Effect.runForkWith(services);
    const unsubscribe = subscribeMossServiceEntryChanges((change) => {
      run(
        Effect.logInfo(describeMossServiceEntryChange(change)).pipe(
          Effect.andThen(
            change.service === MOSS_CN_MODEL_GATEWAY_SERVICE
              ? input.onCnModelGatewayChange
              : Effect.void,
          ),
        ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* Effect.promise(async () => {
      await Promise.all([...routers.values()].map((router) => router.refreshIfDue()));
    }).pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    );
  });

/**
 * Codex's code for a turn whose model request failed to connect. The managed Codex lane sends
 * with `request_max_retries = 0`, so a reset on the gateway entry ends the turn with it. Codex
 * 0.166.0's app-server types give this variant an `httpStatusCode: number | null`, so it is not
 * proof that no HTTP response arrived: it is treated as a hint only.
 */
export const MOSS_LANE_CONNECTION_FAILURE_CODE = "httpConnectionFailed";

/**
 * Chat traffic from the agent CLIs goes straight to the gateway entry their lane was
 * provisioned with, so the router never sees its resets. When a Moss Codex lane's turn fails
 * with Codex's connection-failure code, the router re-checks its entries (`recheck`): the
 * entry is not marked failed on this evidence, and only the health checks can move Moss, so a
 * wrong reading costs one extra round of checks. If the router then changes entry, the change
 * listener re-provisions the lanes. Lanes whose gateway is not an entry of a router in use (a
 * Google account, someone's own Codex) are left alone, as are the other agents: their
 * failures cannot be told apart from model errors.
 */
export const reportMossLaneConnectionFailures = (input: {
  readonly events: Stream.Stream<ProviderRuntimeEvent>;
  /** The gateway URL a provider instance was provisioned with, or null. */
  readonly gatewayBaseUrlOf: (instanceId: string) => Effect.Effect<string | null>;
}) =>
  Stream.runForEach(input.events, (event) =>
    event.type === "turn.completed" &&
    event.provider === "codex" &&
    event.payload.state === "failed" &&
    event.payload.errorCode === MOSS_LANE_CONNECTION_FAILURE_CODE &&
    event.providerInstanceId !== undefined
      ? input.gatewayBaseUrlOf(event.providerInstanceId).pipe(
          Effect.flatMap((url) => {
            const router = url ? mossServiceEntryRouterFor(url) : null;
            return url && router ? Effect.promise(() => router.recheck(url)) : Effect.void;
          }),
          Effect.forkScoped,
          Effect.asVoid,
        )
      : Effect.void,
  ).pipe(Effect.forkScoped, Effect.asVoid);
