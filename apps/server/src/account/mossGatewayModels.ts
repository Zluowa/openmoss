// FILE: mossGatewayModels.ts
// Purpose: Ask the regional Moss model gateway which models this account may
// use right now. The gateway answers `/v1/models` from the account's database
// entitlement intersected with the realm catalog, so this is the single
// database-backed source for the model lineup a managed engine presents.
// Layer: account (server). The caller must distinguish an authenticated,
// entitled catalog from an unavailable gateway. In particular, an HTTP error
// must never be collapsed into an empty/null catalog and then presented as a
// usable static realm lineup.

import { Effect } from "effect";

import { isMossConnectionLevelFailure, type MossServiceEntryRouter } from "./mossServiceEntries";

export interface FetchMossGatewayModelIdsInput {
  readonly gatewayBaseUrl: string;
  readonly accessToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export type MossGatewayModelCatalogStatus =
  | "ready"
  | "auth-denied"
  | "no-entitlement"
  | "transport-degraded";

export type MossGatewayModelCatalog = {
  readonly status: MossGatewayModelCatalogStatus;
  readonly models: ReadonlyArray<string>;
  /**
   * Set with "transport-degraded" when no HTTP response arrived at all (a reset, refused or
   * timed-out connection, a TLS or DNS failure), so the caller may try another entry. An HTTP
   * answer, even a 5xx, never sets it.
   */
  readonly connectionFailed?: true;
};

/**
 * The array/null union is retained for injected test doubles and older
 * extensions. The live implementation always returns a tagged catalog.
 */
export type FetchMossGatewayModelIds = (
  input: FetchMossGatewayModelIdsInput,
) => Effect.Effect<MossGatewayModelCatalog | ReadonlyArray<string> | null>;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MODEL_IDS = 512;

export function mossGatewayModelsUrl(gatewayBaseUrl: string): string {
  const url = new URL(gatewayBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/(?:\/v1)+$/, "")}/v1/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function parseMossGatewayModelIds(payload: unknown): ReadonlyArray<string> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    const id =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as { id?: unknown }).id
        : undefined;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed.length === 0 || trimmed.length > 200 || ids.includes(trimmed)) continue;
    ids.push(trimmed);
    if (ids.length >= MAX_MODEL_IDS) break;
  }
  return ids;
}

/** Default implementation against the live gateway. */
export const fetchMossGatewayModelIds: FetchMossGatewayModelIds = (input) =>
  Effect.tryPromise(async () => {
    const fetchImplementation = input.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImplementation(mossGatewayModelsUrl(input.gatewayBaseUrl), {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: "application/json",
          // Cloudflare's CN edge rejects requests with an empty/unknown
          // fingerprint. Keep the production server identity explicit so
          // model discovery works through the real tunnel as it does in the
          // desktop renderer.
          "user-agent": "Moss",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const status =
          response.status === 401 || response.status === 403
            ? "auth-denied"
            : response.status === 404 || response.status === 402
              ? "no-entitlement"
              : "transport-degraded";
        await response.body?.cancel().catch(() => undefined);
        return { status, models: [] } satisfies MossGatewayModelCatalog;
      }
      const payload = await response.json();
      const models = parseMossGatewayModelIds(payload);
      if (models === null) {
        return { status: "transport-degraded", models: [] } satisfies MossGatewayModelCatalog;
      }
      if (models.length === 0) {
        return { status: "no-entitlement", models: [] } satisfies MossGatewayModelCatalog;
      }
      return { status: "ready", models } satisfies MossGatewayModelCatalog;
    } finally {
      clearTimeout(timer);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<MossGatewayModelCatalog>(
        isMossConnectionLevelFailure(error)
          ? { status: "transport-degraded", models: [], connectionFailed: true }
          : { status: "transport-degraded", models: [] },
      ),
    ),
  );

/** Whether a catalog answer says the request never reached the gateway. */
export function isMossGatewayCatalogConnectionFailure(
  result: MossGatewayModelCatalog | ReadonlyArray<string> | null,
): boolean {
  return result !== null && "status" in result && result.connectionFailed === true;
}

/**
 * The catalog from the entry in use, tried once more on the next usable entry when the request
 * failed below HTTP. `/v1/models` is a read, so asking a second entry is safe; the failure is
 * reported, so the entry becomes suspect and the next request goes to the entry that answered.
 * Returns the normalized catalog and the entry that answered (or, when none did, the entry in
 * use now): lanes are provisioned with that entry.
 */
export const fetchMossGatewayCatalogViaEntries = (input: {
  readonly fetchGatewayModels: FetchMossGatewayModelIds;
  readonly entries: MossServiceEntryRouter | null;
  readonly gatewayBaseUrl: string;
  readonly accessToken: string;
}): Effect.Effect<{
  readonly catalog: MossGatewayModelCatalog;
  readonly gatewayBaseUrl: string;
}> =>
  Effect.gen(function* () {
    const { entries, accessToken } = input;
    const ask = (gatewayBaseUrl: string) =>
      input.fetchGatewayModels({ gatewayBaseUrl, accessToken });
    const first = yield* ask(input.gatewayBaseUrl);
    if (!entries || !isMossGatewayCatalogConnectionFailure(first)) {
      return {
        catalog: normalizeMossGatewayModelCatalog(first),
        gatewayBaseUrl: input.gatewayBaseUrl,
      };
    }
    const next = yield* Effect.promise(() => entries.reportConnectionFailure(input.gatewayBaseUrl));
    if (next === input.gatewayBaseUrl) {
      return { catalog: normalizeMossGatewayModelCatalog(first), gatewayBaseUrl: next };
    }
    const second = yield* ask(next);
    if (!isMossGatewayCatalogConnectionFailure(second)) {
      return { catalog: normalizeMossGatewayModelCatalog(second), gatewayBaseUrl: next };
    }
    const after = yield* Effect.promise(() => entries.reportConnectionFailure(next));
    return { catalog: normalizeMossGatewayModelCatalog(second), gatewayBaseUrl: after };
  });

/**
 * Whether a catalog answer lets Moss set up (or keep) its managed lanes. `/v1/models` is an
 * entitlement hint, and lanes are always provisioned with the product lineup. "auth-denied"
 * and "no-entitlement" are answers about the account and stop provisioning. An unreachable
 * gateway ("transport-degraded": timeout, network, a Cloudflare 5xx) is not: skipping there
 * left a signed-in account with every Moss lane torn down after a token refresh, which looks
 * exactly like being signed out. With lanes in place, a chat reports the outage instead.
 */
export function mossGatewayCatalogAllowsProvisioning(catalog: MossGatewayModelCatalog): boolean {
  return catalog.status === "ready" || catalog.status === "transport-degraded";
}

/** Normalize legacy test doubles without making them look production-ready. */
export function normalizeMossGatewayModelCatalog(
  result: MossGatewayModelCatalog | ReadonlyArray<string> | null,
): MossGatewayModelCatalog {
  if (result === null) {
    return { status: "transport-degraded", models: [] };
  }
  if (!("status" in result)) {
    return result.length > 0
      ? { status: "ready", models: result as ReadonlyArray<string> }
      : { status: "no-entitlement", models: [] };
  }
  return result;
}
