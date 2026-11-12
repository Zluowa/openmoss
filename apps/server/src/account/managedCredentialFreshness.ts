import { isMossEnterpriseApiKey } from "@moss/shared/mossRealmCatalog";
import type { ResolvedProviderInstance } from "@moss/shared/providerInstances";
import {
  isTrustedMossManagedGatewayUrlForAuthority,
  type MossManagedGatewayAuthority,
} from "../provider/mossManagedGatewayTrust";

/**
 * A managed CLI keeps the bearer it was started with until Moss restarts it, and
 * Moss restarts it only between turns. So a turn is safe only while its bearer
 * outlives it. Moss session bearers are JWTs that live about 60 minutes (round 10
 * saw expiries 55 m 46 s apart under a 5-minute refresh lead). Moss therefore
 * refreshes once 30 minutes or less remain, and before each send restarts a live
 * process whose bearer has under 25 minutes left; the 5 minutes between the two
 * leave room for the refresh to have landed. Every turn then starts with at least
 * 25 minutes of bearer. When the token carries `iat`, the leads scale with its own
 * lifetime (half, and five twelfths) so a shorter-lived realm still refreshes in
 * time instead of every minute.
 */
export const MOSS_BEARER_REFRESH_LEAD_MS = 30 * 60_000;
export const MOSS_BEARER_SEND_ROTATION_LEAD_MS = 25 * 60_000;
const MANAGED_IDS = new Set([
  "codex_moss",
  "claude_moss",
  "opencode_moss",
  "pi_moss",
  "grok_moss",
  "hermes_moss",
  "kimi_moss",
  "minimax_moss",
  "zcode_moss",
]);
/** Relays whose bearer is the shared MOSS_ACCESS_TOKEN variable. */
const MOSS_ACCESS_TOKEN_DRIVERS = new Set<string>([
  "opencode",
  "pi",
  "grok",
  "hermes",
  "kimi",
  "minimax",
  "zcode",
]);

const readJwtSecondsClaim = (token: string | undefined, claim: "exp" | "iat"): number | null => {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
    );
    if (!payload || typeof payload !== "object" || !(claim in payload)) return null;
    const value = (payload as Record<string, unknown>)[claim];
    return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
  } catch {
    return null;
  }
};

/** A session bearer's own expiry, or null for a key or anything else that is not a JWT. */
export function readManagedBearerExpiryMs(token: string | undefined): number | null {
  return readJwtSecondsClaim(token, "exp");
}

const scaledLeadMs = (token: string | undefined, capMs: number, share: number): number => {
  const expiresAt = readJwtSecondsClaim(token, "exp");
  const issuedAt = readJwtSecondsClaim(token, "iat");
  const lifetime = expiresAt !== null && issuedAt !== null ? expiresAt - issuedAt : null;
  return lifetime !== null && lifetime > 0 ? Math.min(capMs, lifetime * share) : capMs;
};

/** Refresh the account session once this little of the bearer is left. */
export function mossBearerRefreshLeadMs(token: string | undefined): number {
  return scaledLeadMs(token, MOSS_BEARER_REFRESH_LEAD_MS, 1 / 2);
}

/** Before a send, restart a live process whose bearer has less than this left. */
export function mossBearerSendRotationLeadMs(token: string | undefined): number {
  return scaledLeadMs(token, MOSS_BEARER_SEND_ROTATION_LEAD_MS, 5 / 12);
}

/**
 * The account that must rotate this managed lane before a send, or null when its
 * bearer still has enough left for a long turn. JWT expiry is only a scheduling
 * hint; account services still validate Auth.
 */
export function managedCredentialRefreshAuthority(
  instance: ResolvedProviderInstance | undefined,
  env: Readonly<Record<string, string | undefined>>,
  now = Date.now(),
): MossManagedGatewayAuthority | null {
  if (!instance || !instance.enabled || !MANAGED_IDS.has(instance.instanceId)) return null;
  const gateway = instance.config.gatewayBaseUrl;
  if (typeof gateway !== "string") return null;
  const authority = (["memfire-phone", "supabase-google"] as const).find((candidate) =>
    isTrustedMossManagedGatewayUrlForAuthority(gateway, candidate, env),
  );
  if (!authority) return null;
  const credentialKey =
    instance.driver === "claudeAgent"
      ? "ANTHROPIC_AUTH_TOKEN"
      : MOSS_ACCESS_TOKEN_DRIVERS.has(instance.driver)
        ? "MOSS_ACCESS_TOKEN"
        : "OPENAI_API_KEY";
  const token = instance.environment[credentialKey];
  // Enterprise keys do not expire on a schedule; revocation surfaces as a 401.
  if (token && isMossEnterpriseApiKey(token)) return null;
  // Missing/malformed managed credentials must reconcile before dispatch.
  const expiresAt = readManagedBearerExpiryMs(token);
  if (expiresAt !== null && expiresAt > now + mossBearerSendRotationLeadMs(token)) return null;
  return authority;
}
