// FILE: mossProductionPublicConfig.ts
// Purpose: Defines and validates the non-secret, dual-authority routing manifest embedded in Moss releases.
// Layer: Shared release/runtime contract

export const MOSS_PRODUCTION_PUBLIC_CONFIG_FILE = "moss-production-public-config.json";
export const MOSS_PRODUCTION_CONFIG_VERSION = 2 as const;

export const MOSS_CLOUD_REGIONS = ["cn", "global"] as const;
export type MossCloudRegion = (typeof MOSS_CLOUD_REGIONS)[number];
export const MOSS_CLOUD_REGION_HEADER = "x-moss-cloud-region";

export const MOSS_AUTH_AUTHORITIES = ["memfire-phone", "supabase-google"] as const;
export type MossAuthAuthority = (typeof MOSS_AUTH_AUTHORITIES)[number];

export const MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS = [
  "MOSS_PRODUCTION_CONFIG_VERSION",
  "MOSS_MEMFIRE_PHONE_URL",
  "MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY",
  "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL",
  "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL",
  "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
  "MOSS_SUPABASE_GOOGLE_URL",
  "MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY",
  "MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL",
  "MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL",
  "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL",
] as const;

/** @deprecated Prefer MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS for the v2 environment projection. */
export const MOSS_PRODUCTION_PUBLIC_CONFIG_KEYS = MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS;

export type MossProductionPublicConfigKey = (typeof MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS)[number];
export type MossProductionPublicConfigInput = Readonly<
  Partial<Record<MossProductionPublicConfigKey, string | undefined>>
>;

export const MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS = [
  "MOSS_CLOUD_REGION",
  "MOSS_SUPABASE_URL",
  "MOSS_SUPABASE_PUBLISHABLE_KEY",
  "MOSS_AUTH_REDIRECT_URL",
  "MOSS_MODEL_GATEWAY_URL",
  "MOSS_REALTIME_RELAY_URL",
] as const;

export type MossLegacyProductionPublicConfigKey =
  (typeof MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS)[number];
export type MossLegacyProductionPublicConfigInput = Readonly<
  Partial<Record<MossLegacyProductionPublicConfigKey, string | undefined>>
>;

export interface MossMemFirePhonePublicRealm {
  readonly authority: "memfire-phone";
  readonly region: "cn";
  readonly authUrl: string;
  readonly publishableKey: string;
  readonly modelGatewayUrl: string;
  readonly realtimeRelayUrl: string;
  /** Absent in older v2 releases; phone payments stay disabled until configured. */
  readonly payBaseUrl?: string;
}

export interface MossSupabaseGooglePublicRealm {
  readonly authority: "supabase-google";
  readonly region: "global";
  readonly authUrl: string;
  readonly publishableKey: string;
  readonly authRedirectUrl: "moss://auth/callback";
  readonly modelGatewayUrl: string;
  readonly realtimeRelayUrl: string;
}

export interface MossProductionPublicConfig {
  readonly version: typeof MOSS_PRODUCTION_CONFIG_VERSION;
  readonly authRealms: Readonly<{
    readonly "memfire-phone": MossMemFirePhonePublicRealm;
    readonly "supabase-google": MossSupabaseGooglePublicRealm;
  }>;
}

/**
 * Legacy v1 is retained only for explicit development/import tooling. Packaged production loading
 * and the strict release builder intentionally do not call this compatibility parser.
 */
export interface MossLegacyProductionPublicConfig {
  readonly MOSS_CLOUD_REGION: MossCloudRegion;
  readonly MOSS_SUPABASE_URL: string;
  readonly MOSS_SUPABASE_PUBLISHABLE_KEY: string;
  readonly MOSS_AUTH_REDIRECT_URL: string;
  readonly MOSS_MODEL_GATEWAY_URL: string;
  readonly MOSS_REALTIME_RELAY_URL: string;
}

export class MossProductionPublicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MossProductionPublicConfigError";
  }
}

export function isMossCloudRegion(value: unknown): value is MossCloudRegion {
  return typeof value === "string" && MOSS_CLOUD_REGIONS.includes(value as MossCloudRegion);
}

export function requireMossCloudRegion(value: string | undefined): MossCloudRegion {
  const normalized = value?.trim().toLowerCase();
  if (!isMossCloudRegion(normalized)) {
    throw new MossProductionPublicConfigError("MOSS_CLOUD_REGION must be exactly cn or global.");
  }
  return normalized;
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

export function isMemFireCloudApiHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.baseapi\.memfiredb\.com$/u.test(
    hostname.toLowerCase(),
  );
}

export function isSupabaseProjectHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/u.test(hostname.toLowerCase());
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "ip6-localhost" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:0" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    return (
      octets.every((octet) => octet >= 0 && octet <= 255) &&
      (octets[0] === 127 || octets.every((octet) => octet === 0))
    );
  }

  return normalized.startsWith("::ffff:127.");
}

function isHostnameAtOrBelow(hostname: string, parent: string): boolean {
  const normalized = normalizedHostname(hostname);
  return normalized === parent || normalized.endsWith(`.${parent}`);
}

function isForbiddenUpstreamHostname(hostname: string): boolean {
  return (
    isHostnameAtOrBelow(hostname, "i-helios.top") || isHostnameAtOrBelow(hostname, "openai.com")
  );
}

function requireInputValue(
  input: MossProductionPublicConfigInput,
  key: MossProductionPublicConfigKey,
): string {
  const value = input[key]?.trim();
  if (!value) {
    throw new MossProductionPublicConfigError(`Missing required production setting ${key}.`);
  }
  return value;
}

function requireLegacyInputValue(
  input: MossLegacyProductionPublicConfigInput,
  key: MossLegacyProductionPublicConfigKey,
): string {
  const value = input[key]?.trim();
  if (!value) {
    throw new MossProductionPublicConfigError(`Missing required legacy setting ${key}.`);
  }
  return value;
}

function requirePublishableKey(key: MossProductionPublicConfigKey, value: string): string {
  if (/\s/u.test(value) || value.length > 4096) {
    throw new MossProductionPublicConfigError(
      `${key} must be a non-empty public client key without whitespace.`,
    );
  }
  return value;
}

function parsePublicHttpsUrl(key: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MossProductionPublicConfigError(`${key} must be a valid HTTPS URL.`);
  }

  if (url.protocol !== "https:") {
    throw new MossProductionPublicConfigError(`${key} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new MossProductionPublicConfigError(`${key} must not contain URL credentials.`);
  }
  if (url.search || url.hash || value.endsWith("?") || value.endsWith("#")) {
    throw new MossProductionPublicConfigError(
      `${key} must not contain query parameters or fragments.`,
    );
  }
  if (isLoopbackHostname(url.hostname)) {
    throw new MossProductionPublicConfigError(`${key} must not target a loopback host.`);
  }
  return url;
}

function requireCanonicalProjectOrigin(input: {
  readonly key: MossProductionPublicConfigKey;
  readonly value: string;
  readonly provider: "MemFire" | "Supabase";
}): string {
  const url = parsePublicHttpsUrl(input.key, input.value);
  const hostnameMatches =
    input.provider === "MemFire"
      ? isMemFireCloudApiHostname(url.hostname)
      : isSupabaseProjectHostname(url.hostname);
  if (!hostnameMatches || url.pathname !== "/" || url.port) {
    throw new MossProductionPublicConfigError(
      `${input.key} must use a canonical ${input.provider} project origin.`,
    );
  }
  if (input.value !== url.origin && input.value !== `${url.origin}/`) {
    throw new MossProductionPublicConfigError(
      `${input.key} must use the exact canonical ${input.provider} hostname and default HTTPS port.`,
    );
  }
  return url.origin;
}

function requireModelGatewayUrl(input: {
  readonly key: MossProductionPublicConfigKey;
  readonly value: string;
  readonly authority: MossAuthAuthority;
  readonly authUrl: string;
}): string {
  const url = parsePublicHttpsUrl(input.key, input.value);
  const canonical = `${url.origin}${url.pathname}`;
  if (input.value !== canonical || url.port) {
    throw new MossProductionPublicConfigError(
      `${input.key} must use a canonical URL without dot segments, hostname aliases, an explicit default port, query, or fragment.`,
    );
  }
  if (
    url.pathname !== "/functions/v1/moss-model-gateway" &&
    url.pathname !== "/functions/v1/moss-model-gateway/v1"
  ) {
    throw new MossProductionPublicConfigError(
      `${input.key} must use /functions/v1/moss-model-gateway with an optional /v1 suffix.`,
    );
  }
  if (isForbiddenUpstreamHostname(url.hostname)) {
    throw new MossProductionPublicConfigError(`${input.key} must target a Moss gateway.`);
  }

  const authOrigin = new URL(input.authUrl).origin;
  if (input.authority === "supabase-google") {
    if (url.origin !== authOrigin) {
      throw new MossProductionPublicConfigError(
        `${input.key} must use the same fixed Supabase project origin as MOSS_SUPABASE_GOOGLE_URL.`,
      );
    }
  } else if (
    url.origin === authOrigin ||
    isMemFireCloudApiHostname(url.hostname) ||
    isSupabaseProjectHostname(url.hostname)
  ) {
    throw new MossProductionPublicConfigError(
      `${input.key} must use a dedicated domestic Moss gateway origin, not either Auth control plane.`,
    );
  }
  return input.value;
}

function requireRealtimeRelayOrigin(key: MossProductionPublicConfigKey, value: string): string {
  const url = parsePublicHttpsUrl(key, value);
  if (url.pathname !== "/" || url.port) {
    throw new MossProductionPublicConfigError(`${key} must be an HTTPS origin without a path.`);
  }
  if (value !== url.origin && value !== `${url.origin}/`) {
    throw new MossProductionPublicConfigError(
      `${key} must use the exact canonical hostname and default HTTPS port.`,
    );
  }
  if (
    isForbiddenUpstreamHostname(url.hostname) ||
    isMemFireCloudApiHostname(url.hostname) ||
    isSupabaseProjectHostname(url.hostname)
  ) {
    throw new MossProductionPublicConfigError(
      `${key} must target a dedicated Moss relay origin, not an Auth or upstream provider origin.`,
    );
  }
  return url.origin;
}

function requirePhonePaymentBaseUrl(value: string): string {
  const key = "MOSS_MEMFIRE_PHONE_PAY_BASE_URL";
  const url = parsePublicHttpsUrl(key, value);
  const canonical = `${url.origin}/functions/v1/moss-pay`;
  if (url.port || (value !== canonical && value !== `${canonical}/`)) {
    throw new MossProductionPublicConfigError(
      `${key} must use a canonical HTTPS URL with /functions/v1/moss-pay and the default port.`,
    );
  }
  if (
    isForbiddenUpstreamHostname(url.hostname) ||
    isMemFireCloudApiHostname(url.hostname) ||
    isSupabaseProjectHostname(url.hostname)
  ) {
    throw new MossProductionPublicConfigError(
      `${key} must target a dedicated Moss payment origin, not an Auth or upstream provider origin.`,
    );
  }
  return canonical;
}

export function resolveMossProductionPublicConfig(
  input: MossProductionPublicConfigInput,
): MossProductionPublicConfig {
  const version = requireInputValue(input, "MOSS_PRODUCTION_CONFIG_VERSION");
  if (version !== String(MOSS_PRODUCTION_CONFIG_VERSION)) {
    throw new MossProductionPublicConfigError(
      "MOSS_PRODUCTION_CONFIG_VERSION must be exactly 2 for strict production.",
    );
  }

  const memFireAuthUrl = requireCanonicalProjectOrigin({
    key: "MOSS_MEMFIRE_PHONE_URL",
    value: requireInputValue(input, "MOSS_MEMFIRE_PHONE_URL"),
    provider: "MemFire",
  });
  const supabaseAuthUrl = requireCanonicalProjectOrigin({
    key: "MOSS_SUPABASE_GOOGLE_URL",
    value: requireInputValue(input, "MOSS_SUPABASE_GOOGLE_URL"),
    provider: "Supabase",
  });
  const memFireRelayUrl = requireRealtimeRelayOrigin(
    "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL",
    requireInputValue(input, "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL"),
  );
  const supabaseRelayUrl = requireRealtimeRelayOrigin(
    "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL",
    requireInputValue(input, "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL"),
  );
  if (memFireRelayUrl === supabaseRelayUrl) {
    throw new MossProductionPublicConfigError(
      "MemFire phone and Supabase Google must use distinct relay origins.",
    );
  }

  const googleRedirectUrl = requireInputValue(input, "MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL");
  if (googleRedirectUrl !== "moss://auth/callback") {
    throw new MossProductionPublicConfigError(
      "MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL must be exactly moss://auth/callback.",
    );
  }

  const phonePayValue = input.MOSS_MEMFIRE_PHONE_PAY_BASE_URL?.trim();
  const phonePayBaseUrl = phonePayValue ? requirePhonePaymentBaseUrl(phonePayValue) : undefined;

  return {
    version: MOSS_PRODUCTION_CONFIG_VERSION,
    authRealms: {
      "memfire-phone": {
        authority: "memfire-phone",
        region: "cn",
        authUrl: memFireAuthUrl,
        publishableKey: requirePublishableKey(
          "MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY",
          requireInputValue(input, "MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY"),
        ),
        modelGatewayUrl: requireModelGatewayUrl({
          key: "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL",
          value: requireInputValue(input, "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL"),
          authority: "memfire-phone",
          authUrl: memFireAuthUrl,
        }),
        realtimeRelayUrl: memFireRelayUrl,
        ...(phonePayBaseUrl ? { payBaseUrl: phonePayBaseUrl } : {}),
      },
      "supabase-google": {
        authority: "supabase-google",
        region: "global",
        authUrl: supabaseAuthUrl,
        publishableKey: requirePublishableKey(
          "MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY",
          requireInputValue(input, "MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY"),
        ),
        authRedirectUrl: googleRedirectUrl,
        modelGatewayUrl: requireModelGatewayUrl({
          key: "MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL",
          value: requireInputValue(input, "MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL"),
          authority: "supabase-google",
          authUrl: supabaseAuthUrl,
        }),
        realtimeRelayUrl: supabaseRelayUrl,
      },
    },
  };
}

function parseJsonObject(rawJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new MossProductionPublicConfigError("Production public config is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MossProductionPublicConfigError("Production public config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MossProductionPublicConfigError(`${path} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlyArray<string>,
  path: string,
  optionalKeys: ReadonlyArray<string> = [],
): void {
  const allowed = new Set([...allowedKeys, ...optionalKeys]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new MossProductionPublicConfigError(
      `${path} contains unsupported setting ${unexpected}.`,
    );
  }
  const missing = allowedKeys.find((key) => !(key in record));
  if (missing) {
    throw new MossProductionPublicConfigError(`${path} is missing required setting ${missing}.`);
  }
}

function requireStringField(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new MossProductionPublicConfigError(`${path}.${key} must be a string.`);
  }
  return value;
}

export function parseMossProductionPublicConfig(rawJson: string): MossProductionPublicConfig {
  const document = parseJsonObject(rawJson);
  if (document.version !== MOSS_PRODUCTION_CONFIG_VERSION) {
    throw new MossProductionPublicConfigError(
      "Strict production public config must use version 2 with both auth realms.",
    );
  }
  requireExactKeys(document, ["version", "authRealms"], "Production public config");

  const realms = requireRecord(document.authRealms, "Production public config authRealms");
  requireExactKeys(realms, MOSS_AUTH_AUTHORITIES, "Production public config authRealms");
  const memFire = requireRecord(
    realms["memfire-phone"],
    "Production public config authRealms.memfire-phone",
  );
  const supabase = requireRecord(
    realms["supabase-google"],
    "Production public config authRealms.supabase-google",
  );
  requireExactKeys(
    memFire,
    ["authority", "region", "authUrl", "publishableKey", "modelGatewayUrl", "realtimeRelayUrl"],
    "Production public config authRealms.memfire-phone",
    ["payBaseUrl"],
  );
  requireExactKeys(
    supabase,
    [
      "authority",
      "region",
      "authUrl",
      "publishableKey",
      "authRedirectUrl",
      "modelGatewayUrl",
      "realtimeRelayUrl",
    ],
    "Production public config authRealms.supabase-google",
  );
  if (memFire.authority !== "memfire-phone" || memFire.region !== "cn") {
    throw new MossProductionPublicConfigError(
      "The memfire-phone realm must be fixed to authority memfire-phone and region cn.",
    );
  }
  if (supabase.authority !== "supabase-google" || supabase.region !== "global") {
    throw new MossProductionPublicConfigError(
      "The supabase-google realm must be fixed to authority supabase-google and region global.",
    );
  }

  return resolveMossProductionPublicConfig({
    MOSS_PRODUCTION_CONFIG_VERSION: String(document.version),
    MOSS_MEMFIRE_PHONE_URL: requireStringField(memFire, "authUrl", "memfire-phone"),
    MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: requireStringField(
      memFire,
      "publishableKey",
      "memfire-phone",
    ),
    MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: requireStringField(
      memFire,
      "modelGatewayUrl",
      "memfire-phone",
    ),
    MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL: requireStringField(
      memFire,
      "realtimeRelayUrl",
      "memfire-phone",
    ),
    MOSS_MEMFIRE_PHONE_PAY_BASE_URL:
      "payBaseUrl" in memFire
        ? requireStringField(memFire, "payBaseUrl", "memfire-phone")
        : undefined,
    MOSS_SUPABASE_GOOGLE_URL: requireStringField(supabase, "authUrl", "supabase-google"),
    MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: requireStringField(
      supabase,
      "publishableKey",
      "supabase-google",
    ),
    MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: requireStringField(
      supabase,
      "authRedirectUrl",
      "supabase-google",
    ),
    MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: requireStringField(
      supabase,
      "modelGatewayUrl",
      "supabase-google",
    ),
    MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: requireStringField(
      supabase,
      "realtimeRelayUrl",
      "supabase-google",
    ),
  });
}

export function serializeMossProductionPublicConfig(config: MossProductionPublicConfig): string {
  const validated = parseMossProductionPublicConfig(JSON.stringify(config));
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function toMossProductionPublicConfigEnv(
  config: MossProductionPublicConfig,
): Readonly<Record<MossProductionPublicConfigKey, string>> {
  const validated = parseMossProductionPublicConfig(JSON.stringify(config));
  const memFire = validated.authRealms["memfire-phone"];
  const supabase = validated.authRealms["supabase-google"];
  return {
    MOSS_PRODUCTION_CONFIG_VERSION: String(validated.version),
    MOSS_MEMFIRE_PHONE_URL: memFire.authUrl,
    MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: memFire.publishableKey,
    MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: memFire.modelGatewayUrl,
    MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL: memFire.realtimeRelayUrl,
    MOSS_MEMFIRE_PHONE_PAY_BASE_URL: memFire.payBaseUrl ?? "",
    MOSS_SUPABASE_GOOGLE_URL: supabase.authUrl,
    MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: supabase.publishableKey,
    MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: supabase.authRedirectUrl,
    MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: supabase.modelGatewayUrl,
    MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: supabase.realtimeRelayUrl,
  };
}

/**
 * Replaces whatever Moss routing configuration a launch environment carried with the
 * release manifest's. Inherited v1 single-region aliases and partial v2 keys are dropped
 * first, so a process never mixes two authorities.
 */
export function applyMossProductionPublicConfigEnv(
  env: NodeJS.ProcessEnv,
  config: MossProductionPublicConfig,
): NodeJS.ProcessEnv {
  const applied = { ...env };
  for (const key of MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS) delete applied[key];
  for (const key of MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS) delete applied[key];
  return { ...applied, ...toMossProductionPublicConfigEnv(config) };
}

function requireLegacyPublicHttpsUrl(key: MossLegacyProductionPublicConfigKey, value: string): URL {
  const url = parsePublicHttpsUrl(key, value);
  return url;
}

export function resolveLegacyMossProductionPublicConfig(
  input: MossLegacyProductionPublicConfigInput,
): MossLegacyProductionPublicConfig {
  const cloudRegion = requireMossCloudRegion(requireLegacyInputValue(input, "MOSS_CLOUD_REGION"));
  const authUrlValue = requireLegacyInputValue(input, "MOSS_SUPABASE_URL");
  const authUrl = requireLegacyPublicHttpsUrl("MOSS_SUPABASE_URL", authUrlValue);
  if (authUrl.pathname !== "/") {
    throw new MossProductionPublicConfigError("Legacy MOSS_SUPABASE_URL must be an HTTPS origin.");
  }
  if (cloudRegion === "cn" && !isMemFireCloudApiHostname(authUrl.hostname)) {
    throw new MossProductionPublicConfigError(
      "Legacy cn MOSS_SUPABASE_URL must use a MemFire Cloud API origin.",
    );
  }

  const redirectUrl = requireLegacyInputValue(input, "MOSS_AUTH_REDIRECT_URL");
  if (redirectUrl !== "moss://auth/callback") {
    requireLegacyPublicHttpsUrl("MOSS_AUTH_REDIRECT_URL", redirectUrl);
  }
  const gatewayUrl = requireLegacyInputValue(input, "MOSS_MODEL_GATEWAY_URL");
  const gateway = requireLegacyPublicHttpsUrl("MOSS_MODEL_GATEWAY_URL", gatewayUrl);
  if (
    gateway.pathname !== "/functions/v1/moss-model-gateway" &&
    gateway.pathname !== "/functions/v1/moss-model-gateway/v1"
  ) {
    throw new MossProductionPublicConfigError(
      "Legacy MOSS_MODEL_GATEWAY_URL must use the Moss model gateway function path.",
    );
  }
  const relayValue = requireLegacyInputValue(input, "MOSS_REALTIME_RELAY_URL");
  const relay = requireLegacyPublicHttpsUrl("MOSS_REALTIME_RELAY_URL", relayValue);
  if (relay.pathname !== "/" || isForbiddenUpstreamHostname(relay.hostname)) {
    throw new MossProductionPublicConfigError(
      "Legacy MOSS_REALTIME_RELAY_URL must use a Moss HTTPS origin.",
    );
  }

  return {
    MOSS_CLOUD_REGION: cloudRegion,
    MOSS_SUPABASE_URL: authUrl.origin,
    MOSS_SUPABASE_PUBLISHABLE_KEY: requireLegacyInputValue(input, "MOSS_SUPABASE_PUBLISHABLE_KEY"),
    MOSS_AUTH_REDIRECT_URL: redirectUrl,
    MOSS_MODEL_GATEWAY_URL: gatewayUrl,
    MOSS_REALTIME_RELAY_URL: relay.origin,
  };
}

export function parseLegacyMossProductionPublicConfig(
  rawJson: string,
): MossLegacyProductionPublicConfig {
  const record = parseJsonObject(rawJson);
  requireExactKeys(record, MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS, "Legacy public config");
  const input: Partial<Record<MossLegacyProductionPublicConfigKey, string | undefined>> = {};
  for (const key of MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS) {
    const value = record[key];
    if (typeof value !== "string") {
      throw new MossProductionPublicConfigError(`${key} must be a string.`);
    }
    input[key] = value;
  }
  return resolveLegacyMossProductionPublicConfig(input);
}
