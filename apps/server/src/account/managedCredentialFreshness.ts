import { isMossEnterpriseApiKey } from "@moss/shared/mossRealmCatalog";
import type { ResolvedProviderInstance } from "@moss/shared/providerInstances";
import {
  isTrustedMossManagedGatewayUrlForAuthority,
  type MossManagedGatewayAuthority,
} from "../provider/mossManagedGatewayTrust";

const REFRESH_SKEW_MS = 5 * 60_000;
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

/** A session bearer's own expiry, or null for a key or anything else that is not a JWT. */
export function readManagedBearerExpiryMs(token: string | undefined): number | null {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
    );
    return payload &&
      typeof payload === "object" &&
      "exp" in payload &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/** JWT expiry is only a scheduling hint; account services still validate Auth. */
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
  if (expiresAt !== null && expiresAt > now + REFRESH_SKEW_MS) return null;
  return authority;
}
