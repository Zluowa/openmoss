// FILE: mossServiceEntries.ts
// Purpose: Picks which of a service's configured entries (base URLs) Moss uses. The CN model
// gateway and CN payments each have a primary entry and, since the 2026-11-12 incident (direct
// mainland HTTPS to the primary was reset after the TLS handshake), fallback entries that reach
// the same server another way. A connection-level failure moves to the next entry that answers
// its health check; the primary is checked again in the background so Moss returns to it.
// Layer: account (server). Which entries exist and may receive a credential is decided by the
// release manifest and the trust checks, never here.

import { splitMossServiceUrlList } from "@moss/shared/mossProductionPublicConfig";
import { Duration, Effect, Schedule } from "effect";

import { mossManagedGatewayEntriesForAuthority } from "../provider/mossManagedGatewayTrust";

/** How long one health check may take before the entry counts as unreachable. */
export const MOSS_SERVICE_ENTRY_PROBE_TIMEOUT_MS = 4_000;
/** How often the entries are checked again, so a recovered primary is used again. */
export const MOSS_SERVICE_ENTRY_REPROBE_INTERVAL_MS = 5 * 60_000;
/** Reported failures re-check the entries at most this often. */
export const MOSS_SERVICE_ENTRY_FAILURE_RECHECK_MS = 15_000;

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
   * return at once and, when the last check is old, start a new one in the background.
   */
  readonly ensure: () => Promise<string>;
  /**
   * A real request to `url` failed before any HTTP response. Checks the entries again (at
   * most every few seconds) and returns the entry to use next.
   */
  readonly reportConnectionFailure: (url: string) => Promise<string>;
  /**
   * Checks the entries again when the last check is old. Does nothing for a router nobody has
   * used yet, so a person who never uses this service never sends it a request.
   */
  readonly refreshIfDue: () => Promise<void>;
  /** True when the last check reached no entry at all. */
  readonly allUnreachable: () => boolean;
}

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
 * and never moves Moss to another entry.
 */
export function isMossConnectionLevelFailure(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const record = current as { readonly code?: unknown; readonly name?: unknown };
    if (typeof record.code === "string" && CONNECTION_FAILURE_CODE.test(record.code)) return true;
    if (record.name === "TimeoutError" || record.name === "AbortError") return true;
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
}): MossServiceEntryRouter {
  const entries = [...new Set(input.entries)];
  const probe = input.probe ?? defaultProbe;
  const now = input.now ?? Date.now;
  const probeTimeoutMs = input.probeTimeoutMs ?? MOSS_SERVICE_ENTRY_PROBE_TIMEOUT_MS;
  const reprobeIntervalMs = input.reprobeIntervalMs ?? MOSS_SERVICE_ENTRY_REPROBE_INTERVAL_MS;
  const failureRecheckMs = input.failureRecheckMs ?? MOSS_SERVICE_ENTRY_FAILURE_RECHECK_MS;
  let activeIndex = 0;
  let checkedAt: number | null = null;
  let unreachable = false;
  let inflight: Promise<string> | null = null;

  const current = () => entries[activeIndex] ?? "";

  const select = (index: number) => {
    if (index === activeIndex) return;
    const change = { service: input.service, from: current(), to: entries[index]! };
    activeIndex = index;
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure never changes which entry is used.
      }
    }
  };

  const check = async (): Promise<string> => {
    const controllers = entries.map(() => new AbortController());
    const timers = controllers.map((controller) =>
      setTimeout(() => controller.abort(), probeTimeoutMs),
    );
    // Every entry is checked at once; the earliest entry in order that answers wins, so a
    // healthy primary is chosen as soon as it answers and a dead one costs one timeout.
    const answers = entries.map((entry, index) =>
      probe(input.healthUrl(entry), controllers[index]!.signal).catch(() => false),
    );
    try {
      for (const [index, answer] of answers.entries()) {
        if (await answer) {
          unreachable = false;
          select(index);
          return current();
        }
      }
      // Nothing answered: keep the entry in use, and let the caller report the outage.
      unreachable = true;
      return current();
    } finally {
      checkedAt = now();
      for (const timer of timers) clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    }
  };

  const refresh = (): Promise<string> => {
    inflight ??= check().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    service: input.service,
    entries,
    current,
    ensure: async () => {
      if (entries.length < 2) return current();
      if (checkedAt === null) return refresh();
      if (now() - checkedAt >= reprobeIntervalMs) void refresh();
      return current();
    },
    reportConnectionFailure: async (url) => {
      if (entries.length < 2 || url !== current()) return current();
      if (inflight) return inflight;
      if (checkedAt !== null && now() - checkedAt < failureRecheckMs) return current();
      return refresh();
    },
    refreshIfDue: async () => {
      if (entries.length < 2 || checkedAt === null) return;
      if (now() - checkedAt >= reprobeIntervalMs) await refresh();
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
 * their last check is old, so Moss returns to a recovered primary without a request failing.
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
