import {
  MOSS_ACCESS_LANE_SPECS,
  mossAccessLaneForAuthority,
  type MossAccessAuthority,
} from "@synara/shared/mossRealmCatalog";

/** @deprecated The single-authority gateway is not a trusted production route. */
export const MOSS_MODEL_GATEWAY_URL_ENV_KEY = "MOSS_MODEL_GATEWAY_URL";
export const MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY = "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL";
export const MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL_ENV_KEY =
  "MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL";
export const MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY = "MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS";

/** Canonical CN model gateway used by the phone/MemFire authority. */
export const MOSS_CN_MODEL_GATEWAY_HOST = "moss-models.comiction.cn";

/**
 * Identity authority whose bearer a managed engine forwards: a phone or Google
 * account session, or a Moss enterprise API key. Enterprise keys use the
 * mainland gateway of their lane's realm, so they share the CN gateway URL.
 */
export type MossManagedGatewayAuthority = MossAccessAuthority;
export const MOSS_MANAGED_GATEWAY_AUTHORITIES = [
  "memfire-phone",
  "supabase-google",
  "moss-enterprise-key",
] as const satisfies ReadonlyArray<MossManagedGatewayAuthority>;

export function isMossManagedGatewayAuthority(
  value: unknown,
): value is MossManagedGatewayAuthority {
  return (MOSS_MANAGED_GATEWAY_AUTHORITIES as ReadonlyArray<unknown>).includes(value);
}

const MOSS_MANAGED_GATEWAY_PATH = "/functions/v1/moss-model-gateway";
const NON_CANONICAL_DOT_SEGMENT = /(?:^|[\\/])(?:\.|%2e){1,2}(?=[\\/?#]|$)/i;

interface NormalizedGateway {
  readonly origin: string;
  readonly url: string;
}

function normalizedGateway(
  value: string | undefined,
  options: { readonly allowLoopbackHttp: boolean },
): NormalizedGateway | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  // WHATWG URL parsing removes literal and percent-encoded dot segments. Reject
  // them before parsing so an ambiguous raw path cannot become the trusted path.
  if (NON_CANONICAL_DOT_SEGMENT.test(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    const allowedProtocol =
      url.protocol === "https:" ||
      (options.allowLoopbackHttp && url.protocol === "http:" && url.hostname === "127.0.0.1");
    if (!allowedProtocol || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    if (pathname !== MOSS_MANAGED_GATEWAY_PATH) return undefined;
    return {
      origin: url.origin,
      url: `${url.origin}${MOSS_MANAGED_GATEWAY_PATH}`,
    };
  } catch {
    return undefined;
  }
}

function trustedOrigin(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function configuredGatewayForAuthority(
  authority: MossManagedGatewayAuthority,
  env: Readonly<Record<string, string | undefined>>,
): NormalizedGateway | undefined {
  const realm = MOSS_ACCESS_LANE_SPECS[mossAccessLaneForAuthority(authority)].realm;
  const key =
    realm === "cn"
      ? MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY
      : MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL_ENV_KEY;
  return normalizedGateway(env[key], {
    allowLoopbackHttp: false,
  });
}

function isExplicitlyTrustedLoopback(
  candidate: NormalizedGateway,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const url = new URL(candidate.origin);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    explicitlyTrustedOrigins(env).has(candidate.origin)
  );
}

function explicitlyTrustedOrigins(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const candidate of (env[MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY] ?? "").split(/[\s,]+/)) {
    const origin = trustedOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * A Moss account token may only be forwarded to the exact Edge gateway path
 * configured by one of the two v2 account-authority routes. The only override
 * is an exact 127.0.0.1 origin explicitly enabled for local development.
 */
export function isTrustedMossManagedGatewayUrl(
  value: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const candidate = normalizedGateway(value, { allowLoopbackHttp: true });
  if (!candidate) return false;

  for (const authority of MOSS_MANAGED_GATEWAY_AUTHORITIES) {
    const configuredGateway = configuredGatewayForAuthority(authority, env);
    if (configuredGateway?.url === candidate.url) return true;
  }

  return isExplicitlyTrustedLoopback(candidate, env);
}

/**
 * Realm-specific variant for code that already holds an authority-bound
 * credential. It prevents a token from one authority being paired with the
 * other authority's otherwise trusted regional gateway.
 */
export function isTrustedMossManagedGatewayUrlForAuthority(
  value: string | undefined,
  authority: MossManagedGatewayAuthority,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const candidate = normalizedGateway(value, { allowLoopbackHttp: true });
  if (!candidate) return false;
  const configuredGateway = configuredGatewayForAuthority(authority, env);
  if (configuredGateway?.url === candidate.url) return true;
  return isExplicitlyTrustedLoopback(candidate, env);
}
