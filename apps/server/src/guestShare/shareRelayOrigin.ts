/**
 * Which Moss share relay serves an owner, and the account bearer that registers shares there.
 *
 * The link follows the owner's region: a phone (MemFire) sign-in registers on the CN relay, a
 * Google (Supabase) sign-in on the global one. `MOSS_SHARE_RELAY_URL` overrides the origin for
 * development and self-hosting; plain `http://localhost` and `http://127.0.0.1` origins are
 * accepted only through this override. With a loopback override, `MOSS_SHARE_RELAY_DEV_BEARER`
 * stands in for the account bearer (the dev relay accepts any bearer), so sharing can be tried
 * without a signed-in account.
 */
import type { MossRealm } from "@synara/shared/mossRealmCatalog";
import { Effect } from "effect";

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

export const SHARE_RELAY_ORIGIN_BY_REALM: Readonly<Record<MossRealm, string>> = {
  cn: "https://moss-share.comiction.cn",
  global: "https://moss-share.inkcomicai.com",
};

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

export function shareRelayOriginForRealm(
  realm: MossRealm,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return shareRelayOriginOverride(env) ?? SHARE_RELAY_ORIGIN_BY_REALM[realm];
}

export interface ShareRelayAccount {
  readonly origin: string;
  readonly bearer: string;
}

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
 * an attributable person, which is what a phone or Google account provides.
 */
export function resolveShareRelayAccount(
  sources: ShareRelayAccountSources,
): Effect.Effect<ShareRelayAccount, GuestShareOwnerError> {
  const env = sources.env ?? process.env;
  const override = shareRelayOriginOverride(env);
  const devBearer = shareRelayDevBearer(env, override);
  if (override !== null && devBearer !== null) {
    return Effect.succeed({ origin: override, bearer: devBearer });
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
        return {
          origin: shareRelayOriginForRealm(mossCloudRegionForAuthority(credential.realm), env),
          bearer: credential.accessToken,
        };
      }
      if (!SIGNED_OUT_CODES.has(result.failure.code)) transientFailure = result.failure;
    }
    return yield* transientFailure === undefined
      ? guestShareOwnerError("guest_share.account_required")
      : guestShareOwnerError("guest_share.relay_unavailable", transientFailure);
  });
}
