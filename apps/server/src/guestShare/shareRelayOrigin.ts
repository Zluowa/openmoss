/**
 * Which Moss share relay serves an owner, through which of its entries, and the account bearer
 * that registers shares there.
 *
 * The link follows the owner's region: a phone (MemFire) sign-in registers on the CN relay, a
 * Google (Supabase) sign-in on the global one. Each relay has several entries (hostnames of the
 * same relay, the preferred one first); the realm's entry router picks the one in use, as for
 * the model gateway. The two realms' relays are different relays: a share or a bearer of one
 * never goes to the other. `MOSS_SHARE_RELAY_URL` overrides the origin for development and
 * self-hosting (that one origin, no router); plain `http://localhost` and `http://127.0.0.1`
 * origins are accepted only through this override. With a loopback override,
 * `MOSS_SHARE_RELAY_DEV_BEARER` stands in for the account bearer (the dev relay accepts any
 * bearer), so sharing can be tried without a signed-in account.
 */
import { MOSS_REALMS, type MossRealm } from "@moss/shared/mossRealmCatalog";
import { Effect } from "effect";

import {
  sharedMossServiceEntryRouter,
  type MossServiceEntryRouter,
} from "../account/mossServiceEntries.ts";
import type {
  MossCloudAccountServiceShape,
  MossSupabaseGoogleAuthorityCredential,
} from "../account/Services/MossCloudAccountService.ts";
import type {
  MossMemFirePhoneAuthorityCredential,
  MossPhoneAccountServiceShape,
} from "../account/Services/MossPhoneAccountService.ts";
import { mossCloudRegionForAuthority } from "../account/mossActiveAuthorityCredential.ts";
import type { MossAccountServiceError } from "../account/mossAccountErrors.ts";
import type { MossCloudAccountServiceError } from "../account/mossCloudAccountErrors.ts";
import { guestShareOwnerError, type GuestShareOwnerError } from "./Errors.ts";

export const MOSS_SHARE_RELAY_URL_ENV_KEY = "MOSS_SHARE_RELAY_URL";
export const MOSS_SHARE_RELAY_DEV_BEARER_ENV_KEY = "MOSS_SHARE_RELAY_DEV_BEARER";

/**
 * Each realm's relay entries, the preferred one first. The entries of one realm reach the same
 * relay, so a share registered through one is known through the others. The older hostnames
 * stay listed: links issued on them, and shares registered by older versions, keep working.
 */
export const SHARE_RELAY_ENTRIES_BY_REALM: Readonly<Record<MossRealm, ReadonlyArray<string>>> = {
  cn: ["https://share.mossbotai.com", "https://moss-share.comiction.cn"],
  global: ["https://share-global.mossbotai.com", "https://moss-share.inkcomicai.com"],
};

/** The relay's unauthenticated health check, at the origin root. */
export const shareRelayHealthUrl = (origin: string): string => `${origin}/healthz`;

const SHARE_RELAY_SERVICE_BY_REALM: Readonly<Record<MossRealm, string>> = {
  cn: "CN share relay",
  global: "global share relay",
};

/** A realm's entry router. Tests hand in their own; Moss uses the shared ones. */
export type ShareRelayEntryRouters = (realm: MossRealm) => MossServiceEntryRouter;

export const shareRelayEntryRouter: ShareRelayEntryRouters = (realm) =>
  sharedMossServiceEntryRouter({
    service: SHARE_RELAY_SERVICE_BY_REALM[realm],
    entries: SHARE_RELAY_ENTRIES_BY_REALM[realm],
    healthUrl: shareRelayHealthUrl,
  });

/**
 * One relay as Moss reaches it: its entries and their router, or one origin and no router (the
 * override, or an origin this build does not list).
 */
export interface ShareRelayEntries {
  readonly entries: ReadonlyArray<string>;
  readonly router: MossServiceEntryRouter | null;
}

const isLoopbackHostname = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** A relay origin: https anywhere, or http on a loopback host. Null when the value is unusable. */
export function parseShareRelayOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.origin;
}

export const isLoopbackShareRelayOrigin = (origin: string): boolean =>
  isLoopbackHostname(new URL(origin).hostname);

export function shareRelayOriginOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[MOSS_SHARE_RELAY_URL_ENV_KEY]?.trim();
  return value ? parseShareRelayOrigin(value) : null;
}

/** The dev bearer, honored only for a loopback override so it can never reach a real relay. */
export function shareRelayDevBearer(
  env: NodeJS.ProcessEnv = process.env,
  origin: string | null = shareRelayOriginOverride(env),
): string | null {
  const bearer = env[MOSS_SHARE_RELAY_DEV_BEARER_ENV_KEY]?.trim();
  return bearer && origin !== null && isLoopbackShareRelayOrigin(origin) ? bearer : null;
}

/** A realm's relay: the override alone when one is set, else the realm's entries. */
export function shareRelayEntriesForRealm(
  realm: MossRealm,
  env: NodeJS.ProcessEnv = process.env,
  routers: ShareRelayEntryRouters = shareRelayEntryRouter,
): ShareRelayEntries {
  const override = shareRelayOriginOverride(env);
  if (override !== null) return { entries: [override], router: null };
  const router = routers(realm);
  return { entries: router.entries, router };
}

/**
 * The relay a stored share's origin belongs to, for the host side (its socket and deletion),
 * which needs no account. With the override set, or for an origin no realm lists, that origin
 * alone, as before relays had entries.
 */
export function shareRelayEntriesForOrigin(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
  routers: ShareRelayEntryRouters = shareRelayEntryRouter,
): ShareRelayEntries {
  if (shareRelayOriginOverride(env) === null) {
    for (const realm of MOSS_REALMS) {
      const router = routers(realm);
      if (router.entries.includes(origin)) return { entries: router.entries, router };
    }
  }
  return { entries: [origin], router: null };
}

export interface ShareRelayAccount {
  /**
   * Where a new share is registered and its link built: the override, or the realm's entry in
   * use. The bearer is sent to no origin outside `relay.entries`.
   */
  readonly origin: string;
  readonly bearer: string;
  readonly relay: ShareRelayEntries;
}

/**
 * Whether a share stored with `origin` lives on the account's relay, through any of its
 * entries. Only then may the account's bearer renew it.
 */
export const isOnAccountShareRelay = (account: ShareRelayAccount, origin: string): boolean =>
  account.relay.entries.includes(origin);

export interface ShareRelayAccountSources {
  readonly phoneAccount: Pick<
    MossPhoneAccountServiceShape,
    "getAuthorityCredential" | "getLocalAuthority"
  >;
  readonly cloudAccount: Pick<
    MossCloudAccountServiceShape,
    "getAuthorityCredential" | "getLocalAuthority"
  >;
  readonly env?: NodeJS.ProcessEnv;
  readonly routers?: ShareRelayEntryRouters;
}

type AccountCredential =
  | MossMemFirePhoneAuthorityCredential
  | MossSupabaseGoogleAuthorityCredential;
type AccountCredentialLookup = Effect.Effect<
  AccountCredential,
  MossAccountServiceError | MossCloudAccountServiceError
>;

// Failures that mean "this sign-in is not available", so the other realm may still serve.
const SIGNED_OUT_CODES: ReadonlySet<string> = new Set([
  "authentication_required",
  "session_expired",
  "not_configured",
]);

/**
 * The relay and bearer for the owner's account. The active realm is tried first; the other
 * sign-in only when the first is absent. An enterprise key never registers shares: links need
 * an attributable person, which is what a phone or Google account provides. The first call for
 * a realm checks its entries (at most one health-check timeout); later calls return at once.
 */
export function resolveShareRelayAccount(
  sources: ShareRelayAccountSources,
): Effect.Effect<ShareRelayAccount, GuestShareOwnerError> {
  const env = sources.env ?? process.env;
  const override = shareRelayOriginOverride(env);
  const devBearer = shareRelayDevBearer(env, override);
  if (override !== null && devBearer !== null) {
    return Effect.succeed({
      origin: override,
      bearer: devBearer,
      relay: { entries: [override], router: null },
    });
  }
  const phone: AccountCredentialLookup = sources.phoneAccount.getAuthorityCredential();
  const cloud: AccountCredentialLookup = sources.cloudAccount.getAuthorityCredential();
  return Effect.gen(function* () {
    const activeRealm = yield* Effect.all([
      sources.phoneAccount.getLocalAuthority().pipe(
        Effect.map((state) => state.activeRealm ?? null),
        Effect.orElseSucceed(() => null),
      ),
      sources.cloudAccount.getLocalAuthority().pipe(
        Effect.map((state) => state.activeRealm ?? null),
        Effect.orElseSucceed(() => null),
      ),
    ]).pipe(Effect.map(([phoneRealm, cloudRealm]) => phoneRealm ?? cloudRealm));
    const candidates: ReadonlyArray<AccountCredentialLookup> =
      activeRealm === "global" ? [cloud, phone] : [phone, cloud];
    let transientFailure: unknown = undefined;
    for (const candidate of candidates) {
      const result = yield* Effect.result(candidate);
      if (result._tag === "Success") {
        const credential = result.success;
        const relay = shareRelayEntriesForRealm(
          mossCloudRegionForAuthority(credential.realm),
          env,
          sources.routers,
        );
        const router = relay.router;
        const origin =
          router === null ? relay.entries[0]! : yield* Effect.promise(() => router.ensure());
        return { origin, bearer: credential.accessToken, relay };
      }
      if (!SIGNED_OUT_CODES.has(result.failure.code)) transientFailure = result.failure;
    }
    return yield* transientFailure === undefined
      ? guestShareOwnerError("guest_share.account_required")
      : guestShareOwnerError("guest_share.relay_unavailable", transientFailure);
  });
}
