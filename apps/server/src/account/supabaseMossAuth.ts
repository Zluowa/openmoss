/**
 * Small, dependency-free client for the GoTrue-compatible Auth REST API used
 * by Moss across MemFire Cloud and hosted Supabase.
 *
 * This module deliberately keeps the publishable key inside the client closure.
 * Callers only receive a non-secret view of the resolved configuration, which
 * makes accidental logging of credentials less likely.
 */

import {
  isMemFireCloudApiHostname,
  isMossCloudRegion,
  type MossCloudRegion,
} from "@synara/shared/mossProductionPublicConfig";

export const MOSS_SUPABASE_CONFIG_ENV_KEYS = {
  cloudRegion: "MOSS_CLOUD_REGION",
  supabaseUrl: "MOSS_SUPABASE_URL",
  publishableKey: "MOSS_SUPABASE_PUBLISHABLE_KEY",
  legacyAnonKey: "MOSS_SUPABASE_ANON_KEY",
  redirectUrl: "MOSS_AUTH_REDIRECT_URL",
  modelGatewayUrl: "MOSS_MODEL_GATEWAY_URL",
} as const;

export const MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS = {
  url: "MOSS_MEMFIRE_PHONE_URL",
  publishableKey: "MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY",
  modelGatewayUrl: "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL",
  realtimeRelayUrl: "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL",
} as const;

export const MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS = {
  url: "MOSS_SUPABASE_GOOGLE_URL",
  publishableKey: "MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY",
  redirectUrl: "MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL",
  modelGatewayUrl: "MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL",
  realtimeRelayUrl: "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL",
} as const;

export const MOSS_GOOGLE_AUTH_REDIRECT_ALLOWLIST = ["moss://auth/callback"] as const;

export type SupabaseMossAuthOperation =
  | "authorize_google"
  | "signup"
  | "signin"
  | "send_phone_otp"
  | "verify_phone_otp"
  | "refresh"
  | "get_user"
  | "recover"
  | "exchange_code"
  | "update_password"
  | "logout";

export interface SupabaseMossAuthUser {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: string | null;
  readonly audience: string | null;
  readonly emailConfirmedAt: string | null;
  readonly phoneConfirmedAt: string | null;
  readonly lastSignInAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly appMetadata: Readonly<Record<string, unknown>>;
  readonly userMetadata: Readonly<Record<string, unknown>>;
}

export interface SupabaseMossAuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly expiresInSeconds: number;
  /** Absolute expiration time as Unix milliseconds. */
  readonly expiresAt: number;
  readonly user: SupabaseMossAuthUser;
}

export interface SupabaseMossSignupResult {
  readonly user: SupabaseMossAuthUser;
  readonly session: SupabaseMossAuthSession | null;
  /** True when Supabase accepted signup but is waiting for email confirmation. */
  readonly confirmationRequired: boolean;
}

export interface SupabaseMossAuthAcceptedResult {
  readonly accepted: true;
}

export interface SupabaseMossPkceChallenge {
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "s256";
}

export type MossAuthRealm = "memfire-phone" | "supabase-google";

export interface MossRealmAuthPublicConfig {
  readonly realm: MossAuthRealm;
  /** Canonical GoTrue issuer URL ending in `/auth/v1`. */
  readonly issuer: string;
  readonly cloudRegion: MossCloudRegion;
  readonly modelGatewayUrl: string;
  readonly realtimeRelayUrl: string;
}

export interface MemFirePhoneAuthPublicConfig extends MossRealmAuthPublicConfig {
  readonly realm: "memfire-phone";
  readonly cloudRegion: "cn";
}

export interface SupabaseGoogleAuthPublicConfig extends MossRealmAuthPublicConfig {
  readonly realm: "supabase-google";
  readonly cloudRegion: "global";
  readonly redirectUrl: (typeof MOSS_GOOGLE_AUTH_REDIRECT_ALLOWLIST)[number];
}

export interface MemFirePhoneAuthClient {
  readonly config: MemFirePhoneAuthPublicConfig;
  readonly sendPhoneOtp: SupabaseMossAuthClient["sendPhoneOtp"];
  readonly verifyPhoneOtp: SupabaseMossAuthClient["verifyPhoneOtp"];
  readonly refresh: SupabaseMossAuthClient["refresh"];
  readonly getUser: SupabaseMossAuthClient["getUser"];
  readonly logout: SupabaseMossAuthClient["logout"];
}

export interface SupabaseGoogleAuthorizeInput {
  readonly flowId: string;
  readonly pkce: SupabaseMossPkceChallenge;
}

export interface SupabaseGoogleAuthClient {
  readonly config: SupabaseGoogleAuthPublicConfig;
  readonly createAuthorizeUrl: (input: SupabaseGoogleAuthorizeInput) => Promise<string>;
  readonly exchangeCode: SupabaseMossAuthClient["exchangeCode"];
  readonly refresh: SupabaseMossAuthClient["refresh"];
  readonly getUser: SupabaseMossAuthClient["getUser"];
  readonly logout: SupabaseMossAuthClient["logout"];
}

export interface SupabaseMossAuthClient {
  readonly config: SupabaseMossAuthPublicConfig;
  readonly signup: (
    email: string,
    password: string,
    pkce: SupabaseMossPkceChallenge,
    displayName?: string | undefined,
  ) => Promise<SupabaseMossSignupResult>;
  readonly signin: (email: string, password: string) => Promise<SupabaseMossAuthSession>;
  readonly sendPhoneOtp: (phone: string) => Promise<SupabaseMossAuthAcceptedResult>;
  readonly verifyPhoneOtp: (phone: string, token: string) => Promise<SupabaseMossAuthSession>;
  readonly refresh: (refreshToken: string) => Promise<SupabaseMossAuthSession>;
  readonly getUser: (accessToken: string) => Promise<SupabaseMossAuthUser>;
  readonly recover: (
    email: string,
    pkce: SupabaseMossPkceChallenge,
  ) => Promise<SupabaseMossAuthAcceptedResult>;
  readonly exchangeCode: (
    authCode: string,
    codeVerifier: string,
  ) => Promise<SupabaseMossAuthSession>;
  readonly updatePassword: (
    accessToken: string,
    newPassword: string,
  ) => Promise<SupabaseMossAuthUser>;
  readonly logout: (accessToken: string) => Promise<SupabaseMossAuthAcceptedResult>;
}

export interface SupabaseMossAuthPublicConfig {
  readonly cloudRegion: MossCloudRegion | null;
  readonly supabaseUrl: string;
  readonly redirectUrl: string | null;
  readonly modelGatewayUrl: string | null;
}

export interface CreateSupabaseMossAuthOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface SupabaseMossAuthUnavailable {
  readonly status: "unavailable";
  readonly available: false;
  readonly reason: "missing_configuration" | "invalid_configuration" | "fetch_unavailable";
  readonly message: string;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface SupabaseMossAuthAvailable {
  readonly status: "available";
  readonly available: true;
  readonly config: SupabaseMossAuthPublicConfig;
  readonly client: SupabaseMossAuthClient;
}

export type SupabaseMossAuthAvailability = SupabaseMossAuthUnavailable | SupabaseMossAuthAvailable;

export interface MemFirePhoneAuthAvailable {
  readonly status: "available";
  readonly available: true;
  readonly config: MemFirePhoneAuthPublicConfig;
  readonly client: MemFirePhoneAuthClient;
}

export type MemFirePhoneAuthAvailability = SupabaseMossAuthUnavailable | MemFirePhoneAuthAvailable;

export interface SupabaseGoogleAuthAvailable {
  readonly status: "available";
  readonly available: true;
  readonly config: SupabaseGoogleAuthPublicConfig;
  readonly client: SupabaseGoogleAuthClient;
}

export type SupabaseGoogleAuthAvailability =
  | SupabaseMossAuthUnavailable
  | SupabaseGoogleAuthAvailable;

interface ResolvedSupabaseMossAuthConfig extends SupabaseMossAuthPublicConfig {
  readonly publishableKey: string;
}

interface SupabaseMossAuthErrorOptions {
  readonly operation: SupabaseMossAuthOperation;
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly message: string;
}

/** Error values contain only normalized metadata and never copy response bodies. */
export class SupabaseMossAuthError extends Error {
  override readonly name = "SupabaseMossAuthError";
  readonly operation: SupabaseMossAuthOperation;
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(options: SupabaseMossAuthErrorOptions) {
    super(options.message);
    this.operation = options.operation;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      message: this.message,
      operation: this.operation,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

const KNOWN_SUPABASE_ERROR_CODES = new Set([
  "bad_code_verifier",
  "bad_json",
  "bad_jwt",
  "captcha_failed",
  "conflict",
  "email_exists",
  "email_not_confirmed",
  "email_provider_disabled",
  "flow_state_expired",
  "flow_state_not_found",
  "hook_reject",
  "identity_already_exists",
  "identity_not_found",
  "invalid_credentials",
  "not_found",
  "otp_disabled",
  "otp_expired",
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "provider_disabled",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "request_timeout",
  "same_password",
  "session_expired",
  "session_not_found",
  "signup_disabled",
  "unexpected_failure",
  "user_banned",
  "user_not_found",
  "validation_failed",
  "weak_password",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * GoTrue stores E.164 phone numbers without the leading plus sign. Keep the
 * Moss account boundary canonical so verify, refresh, and get-user all compare
 * and persist the same mainland phone representation.
 */
const normalizeAuthPhone = (value: unknown): string | null => {
  const phone = stringOrNull(value);
  if (!phone) return null;
  if (/^861[3-9]\d{9}$/u.test(phone)) return `+${phone}`;
  return phone;
};

const recordOrEmpty = (value: unknown): Readonly<Record<string, unknown>> =>
  isRecord(value) ? { ...value } : {};

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeBaseUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

const isSupabaseHostedProjectHostname = (hostname: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/u.test(hostname.toLowerCase());

const normalizeRealmAuthOrigin = (
  value: string,
  hostnameMatches: (hostname: string) => boolean,
): string | null => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !hostnameMatches(parsed.hostname)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const normalizeStrictHttpsUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    ) {
      return null;
    }
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
};

const normalizeManagedGatewayUrl = (
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const httpsUrl = normalizeStrictHttpsUrl(value);
  if (httpsUrl) return httpsUrl;
  const loopbackUrl = normalizeBaseUrl(value);
  if (!loopbackUrl) return null;
  const parsed = new URL(loopbackUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return null;
  const trustedOrigins = new Set(
    String(env.MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS ?? "")
      .split(/[\s,]+/u)
      .map((candidate) => candidate.trim())
      .filter(Boolean),
  );
  return trustedOrigins.has(parsed.origin) ? loopbackUrl : null;
};

export const normalizeStrictHttpsOrigin = (value: string): string | null => {
  const normalized = normalizeStrictHttpsUrl(value);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  return parsed.pathname === "/" ? parsed.origin : null;
};

const normalizeRedirectUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
      return null;
    }
    if (parsed.protocol === "moss:") {
      return parsed.hostname === "auth" && parsed.pathname === "/callback"
        ? "moss://auth/callback"
        : null;
    }
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const readTrimmed = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | null => {
  const value = env[key]?.trim();
  return value ? value : null;
};

const unavailable = (
  reason: SupabaseMossAuthUnavailable["reason"],
  missing: readonly string[] = [],
  invalid: readonly string[] = [],
): SupabaseMossAuthUnavailable => ({
  status: "unavailable",
  available: false,
  reason,
  message:
    reason === "missing_configuration"
      ? "Moss account authentication is unavailable because required configuration is missing."
      : reason === "invalid_configuration"
        ? "Moss account authentication is unavailable because configuration is invalid."
        : "Moss account authentication is unavailable because fetch is not supported.",
  missing: [...missing],
  invalid: [...invalid],
});

const normalizeUser = (
  value: unknown,
  operation: SupabaseMossAuthOperation,
): SupabaseMossAuthUser => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw protocolError(operation);
  }

  return {
    id: value.id,
    email: stringOrNull(value.email),
    phone: normalizeAuthPhone(value.phone),
    role: stringOrNull(value.role),
    audience: stringOrNull(value.aud),
    emailConfirmedAt: stringOrNull(value.email_confirmed_at),
    phoneConfirmedAt: stringOrNull(value.phone_confirmed_at),
    lastSignInAt: stringOrNull(value.last_sign_in_at),
    createdAt: stringOrNull(value.created_at),
    updatedAt: stringOrNull(value.updated_at),
    appMetadata: recordOrEmpty(value.app_metadata),
    userMetadata: recordOrEmpty(value.user_metadata),
  };
};

const protocolError = (operation: SupabaseMossAuthOperation): SupabaseMossAuthError =>
  new SupabaseMossAuthError({
    operation,
    code: "invalid_response",
    status: null,
    retryable: false,
    message: "The authentication service returned an invalid response.",
  });

const inputError = (operation: SupabaseMossAuthOperation): SupabaseMossAuthError =>
  new SupabaseMossAuthError({
    operation,
    code: "invalid_input",
    status: null,
    retryable: false,
    message: "The authentication request contains invalid input.",
  });

const normalizeSession = (
  value: unknown,
  operation: SupabaseMossAuthOperation,
  now: () => number,
  userOverride?: unknown,
): SupabaseMossAuthSession => {
  if (!isRecord(value)) throw protocolError(operation);

  const accessToken = stringOrNull(value.access_token);
  const refreshToken = stringOrNull(value.refresh_token);
  if (!accessToken || !refreshToken) throw protocolError(operation);

  const expiresInSeconds = Math.max(0, finiteNumber(value.expires_in) ?? 0);
  const expiresAtSeconds = finiteNumber(value.expires_at);
  const expiresAt =
    expiresAtSeconds === null
      ? now() + expiresInSeconds * 1_000
      : Math.max(0, expiresAtSeconds * 1_000);

  return {
    accessToken,
    refreshToken,
    tokenType: stringOrNull(value.token_type) ?? "bearer",
    expiresInSeconds,
    expiresAt,
    user: normalizeUser(value.user ?? userOverride, operation),
  };
};

const safeServerErrorCode = (
  value: unknown,
  operation: SupabaseMossAuthOperation,
  status: number,
): string | null => {
  if (!isRecord(value)) return null;
  const candidate =
    typeof value.error_code === "string"
      ? value.error_code
      : typeof value.code === "string"
        ? value.code
        : null;
  if (candidate) {
    const normalized = candidate.trim().toLowerCase();
    if (KNOWN_SUPABASE_ERROR_CODES.has(normalized)) return normalized;
  }
  // GoTrue reports a rejected refresh grant through the OAuth `error` field.
  if (
    operation === "refresh" &&
    status === 400 &&
    typeof value.error === "string" &&
    value.error.trim().toLowerCase() === "invalid_grant"
  ) {
    return "session_expired";
  }
  return null;
};

const httpErrorMessage = (status: number): string => {
  if (status === 401 || status === 403) {
    return "The authentication request was not authorized.";
  }
  if (status === 409 || status === 422) {
    return "The authentication request conflicts with the current account state.";
  }
  if (status === 429) {
    return "The authentication service rate limit was reached. Try again later.";
  }
  if (status >= 500) {
    return "The authentication service is temporarily unavailable.";
  }
  return "The authentication request was rejected.";
};

const requireEmail = (email: string, operation: SupabaseMossAuthOperation): string => {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    !normalized.includes("@") ||
    /[\r\n]/.test(normalized)
  ) {
    throw inputError(operation);
  }
  return normalized;
};

const requireMainlandPhone = (phone: string, operation: SupabaseMossAuthOperation): string => {
  const compact = phone.trim().replace(/[\s().-]/gu, "");
  const domestic = compact.startsWith("+86")
    ? compact.slice(3)
    : compact.startsWith("86") && compact.length === 13
      ? compact.slice(2)
      : compact;
  if (!/^1[3-9]\d{9}$/u.test(domestic)) throw inputError(operation);
  return `+86${domestic}`;
};

const requireSecretInput = (value: string, operation: SupabaseMossAuthOperation): string => {
  if (value.length === 0 || /[\r\n]/.test(value)) throw inputError(operation);
  return value;
};

const requireOAuthFlowId = (value: string): string => {
  if (!/^[A-Za-z0-9._~-]{32,512}$/u.test(value)) throw inputError("authorize_google");
  return value;
};

const requirePkceChallenge = (pkce: SupabaseMossPkceChallenge): string => {
  if (
    pkce.codeChallengeMethod !== "s256" ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(pkce.codeChallenge)
  ) {
    throw inputError("authorize_google");
  }
  return pkce.codeChallenge;
};

const requirePkceVerifier = (value: string): string => {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) throw inputError("exchange_code");
  return value;
};

const isExclusivePhoneIdentity = (user: SupabaseMossAuthUser): boolean => {
  const providers = user.appMetadata.providers;
  return (
    user.phone !== null &&
    user.phoneConfirmedAt !== null &&
    user.appMetadata.provider === "phone" &&
    Array.isArray(providers) &&
    providers.length === 1 &&
    providers[0] === "phone"
  );
};

const pkceBody = (
  pkce: SupabaseMossPkceChallenge,
  operation: SupabaseMossAuthOperation,
): Readonly<Record<string, string>> => ({
  code_challenge: requireSecretInput(pkce.codeChallenge, operation),
  code_challenge_method: pkce.codeChallengeMethod,
});

const signupMetadataBody = (
  displayName: string | undefined,
  operation: SupabaseMossAuthOperation,
): Readonly<Record<string, unknown>> => {
  if (displayName === undefined) return {};
  const normalized = displayName.trim();
  if (normalized.length === 0 || normalized.length > 80 || /[\0\r\n]/.test(normalized)) {
    throw inputError(operation);
  }
  return { data: { display_name: normalized } };
};

type CloudRegionVerifier = (operation: SupabaseMossAuthOperation) => Promise<void>;

const createCloudRegionVerifier = (
  config: ResolvedSupabaseMossAuthConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): CloudRegionVerifier => {
  let regionVerification: Promise<void> | null = null;
  return (operation) => {
    if (!config.cloudRegion) return Promise.resolve();
    if (regionVerification) return regionVerification;

    regionVerification = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(
            `${config.supabaseUrl}/rest/v1/rpc/moss_get_public_cloud_region`,
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                apikey: config.publishableKey,
                "Content-Type": "application/json",
                "X-Client-Info": "moss-desktop",
              },
              body: "{}",
              redirect: "error",
              signal: controller.signal,
            },
          );
        } catch {
          throw new SupabaseMossAuthError({
            operation,
            code: "cloud_region_unavailable",
            status: null,
            retryable: true,
            message: "The regional Moss account service could not be verified.",
          });
        }

        let body: string;
        try {
          body = await response.text();
        } catch {
          throw new SupabaseMossAuthError({
            operation,
            code: "cloud_region_unavailable",
            status: response.status,
            retryable: true,
            message: "The regional Moss account service could not be verified.",
          });
        }
        if (!response.ok || body.length > 64) {
          throw new SupabaseMossAuthError({
            operation,
            code: "cloud_region_unavailable",
            status: response.status,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            message: "The regional Moss account service could not be verified.",
          });
        }

        let remoteRegion: unknown;
        try {
          remoteRegion = JSON.parse(body) as unknown;
        } catch {
          remoteRegion = null;
        }
        if (remoteRegion !== config.cloudRegion) {
          throw new SupabaseMossAuthError({
            operation,
            code: "cloud_region_mismatch",
            status: response.status,
            retryable: false,
            message: "This Moss build is connected to the wrong regional account service.",
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    })().catch((cause) => {
      regionVerification = null;
      throw cause;
    });
    return regionVerification;
  };
};

const createClient = (
  config: ResolvedSupabaseMossAuthConfig,
  fetchImpl: typeof fetch,
  now: () => number,
  timeoutMs: number,
  verifyCloudRegion: CloudRegionVerifier = createCloudRegionVerifier(config, fetchImpl, timeoutMs),
): SupabaseMossAuthClient => {
  const authUrl = (
    pathname: string,
    query?: Readonly<Record<string, string | undefined>>,
  ): string => {
    const url = new URL(`${config.supabaseUrl}/auth/v1/${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  };

  const request = async (
    operation: SupabaseMossAuthOperation,
    pathname: string,
    options: {
      readonly method: "GET" | "POST" | "PUT";
      readonly body?: Readonly<Record<string, unknown>>;
      readonly accessToken?: string;
      readonly query?: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<unknown> => {
    await verifyCloudRegion(operation);
    const headers = new Headers({
      Accept: "application/json",
      apikey: config.publishableKey,
      "X-Client-Info": "moss-desktop",
    });
    if (options.body) headers.set("Content-Type", "application/json");
    if (options.accessToken) headers.set("Authorization", `Bearer ${options.accessToken}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(authUrl(pathname, options.query), {
          method: options.method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
      } catch {
        throw new SupabaseMossAuthError({
          operation,
          code: "network_error",
          status: null,
          retryable: true,
          message: "The authentication service could not be reached.",
        });
      }

      let responseBody: unknown = null;
      if (response.status !== 204) {
        let text: string;
        try {
          text = await response.text();
        } catch {
          throw new SupabaseMossAuthError({
            operation,
            code: "network_error",
            status: response.status,
            retryable: true,
            message: "The authentication service response could not be read.",
          });
        }
        if (text.length > 0) {
          try {
            responseBody = JSON.parse(text) as unknown;
          } catch {
            if (response.ok) throw protocolError(operation);
          }
        }
      }

      if (!response.ok) {
        throw new SupabaseMossAuthError({
          operation,
          code:
            safeServerErrorCode(responseBody, operation, response.status) ??
            `http_${response.status}`,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          message: httpErrorMessage(response.status),
        });
      }

      return responseBody;
    } finally {
      clearTimeout(timeout);
    }
  };

  const publicConfig: SupabaseMossAuthPublicConfig = {
    cloudRegion: config.cloudRegion,
    supabaseUrl: config.supabaseUrl,
    redirectUrl: config.redirectUrl,
    modelGatewayUrl: config.modelGatewayUrl,
  };

  return {
    config: publicConfig,

    signup: async (email, password, pkce, displayName) => {
      const operation = "signup" as const;
      const payload = await request(operation, "signup", {
        method: "POST",
        query: { redirect_to: config.redirectUrl ?? undefined },
        body: {
          email: requireEmail(email, operation),
          password: requireSecretInput(password, operation),
          ...pkceBody(pkce, operation),
          ...signupMetadataBody(displayName, operation),
        },
      });
      if (!isRecord(payload)) throw protocolError(operation);

      const rawUser = isRecord(payload.user) ? payload.user : payload;
      const user = normalizeUser(rawUser, operation);
      const rawSession = isRecord(payload.session)
        ? payload.session
        : typeof payload.access_token === "string"
          ? payload
          : null;
      const session = rawSession ? normalizeSession(rawSession, operation, now, rawUser) : null;
      return { user, session, confirmationRequired: session === null };
    },

    signin: async (email, password) => {
      const operation = "signin" as const;
      const payload = await request(operation, "token", {
        method: "POST",
        query: { grant_type: "password" },
        body: {
          email: requireEmail(email, operation),
          password: requireSecretInput(password, operation),
        },
      });
      return normalizeSession(payload, operation, now);
    },

    sendPhoneOtp: async (phone) => {
      const operation = "send_phone_otp" as const;
      await request(operation, "otp", {
        method: "POST",
        body: {
          phone: requireMainlandPhone(phone, operation),
          create_user: true,
        },
      });
      return { accepted: true };
    },

    verifyPhoneOtp: async (phone, token) => {
      const operation = "verify_phone_otp" as const;
      const normalizedPhone = requireMainlandPhone(phone, operation);
      const payload = await request(operation, "verify", {
        method: "POST",
        body: {
          phone: normalizedPhone,
          token: requireSecretInput(token, operation),
          type: "sms",
        },
      });
      const session = normalizeSession(payload, operation, now);
      if (session.user.phone !== normalizedPhone || session.user.phoneConfirmedAt === null) {
        throw protocolError(operation);
      }
      return session;
    },

    refresh: async (refreshToken) => {
      const operation = "refresh" as const;
      const payload = await request(operation, "token", {
        method: "POST",
        query: { grant_type: "refresh_token" },
        body: { refresh_token: requireSecretInput(refreshToken, operation) },
      });
      return normalizeSession(payload, operation, now);
    },

    getUser: async (accessToken) => {
      const operation = "get_user" as const;
      const payload = await request(operation, "user", {
        method: "GET",
        accessToken: requireSecretInput(accessToken, operation),
      });
      const rawUser = isRecord(payload) && isRecord(payload.user) ? payload.user : payload;
      return normalizeUser(rawUser, operation);
    },

    recover: async (email, pkce) => {
      const operation = "recover" as const;
      await request(operation, "recover", {
        method: "POST",
        query: { redirect_to: config.redirectUrl ?? undefined },
        body: {
          email: requireEmail(email, operation),
          ...pkceBody(pkce, operation),
        },
      });
      return { accepted: true };
    },

    exchangeCode: async (authCode, codeVerifier) => {
      const operation = "exchange_code" as const;
      const payload = await request(operation, "token", {
        method: "POST",
        query: { grant_type: "pkce" },
        body: {
          auth_code: requireSecretInput(authCode, operation),
          code_verifier: requireSecretInput(codeVerifier, operation),
        },
      });
      return normalizeSession(payload, operation, now);
    },

    updatePassword: async (accessToken, newPassword) => {
      const operation = "update_password" as const;
      const payload = await request(operation, "user", {
        method: "PUT",
        accessToken: requireSecretInput(accessToken, operation),
        body: { password: requireSecretInput(newPassword, operation) },
      });
      const rawUser = isRecord(payload) && isRecord(payload.user) ? payload.user : payload;
      return normalizeUser(rawUser, operation);
    },

    logout: async (accessToken) => {
      const operation = "logout" as const;
      await request(operation, "logout", {
        method: "POST",
        accessToken: requireSecretInput(accessToken, operation),
      });
      return { accepted: true };
    },
  };
};

/**
 * Legacy test and non-strict compatibility factory.
 *
 * @deprecated Production services must select `createMemFirePhoneAuth` or
 * `createSupabaseGoogleAuth`; this combined client makes realm fallback
 * representable and is therefore unsuitable for strict production routing.
 */
export const createSupabaseMossAuth = (
  options: CreateSupabaseMossAuthOptions = {},
): SupabaseMossAuthAvailability => {
  const env = options.env ?? process.env;
  const supabaseUrlValue = readTrimmed(env, MOSS_SUPABASE_CONFIG_ENV_KEYS.supabaseUrl);
  const publishableKey =
    readTrimmed(env, MOSS_SUPABASE_CONFIG_ENV_KEYS.publishableKey) ??
    readTrimmed(env, MOSS_SUPABASE_CONFIG_ENV_KEYS.legacyAnonKey) ??
    readTrimmed(env, "SUPABASE_ANON_KEY");

  const missing: string[] = [];
  if (!supabaseUrlValue) missing.push(MOSS_SUPABASE_CONFIG_ENV_KEYS.supabaseUrl);
  if (!publishableKey) missing.push(MOSS_SUPABASE_CONFIG_ENV_KEYS.publishableKey);
  if (!supabaseUrlValue || !publishableKey) {
    return unavailable("missing_configuration", missing);
  }

  const redirectUrlValue = readTrimmed(env, MOSS_SUPABASE_CONFIG_ENV_KEYS.redirectUrl);
  const modelGatewayUrlValue = readTrimmed(env, MOSS_SUPABASE_CONFIG_ENV_KEYS.modelGatewayUrl);
  const cloudRegionValue = readTrimmed(env, MOSS_SUPABASE_CONFIG_ENV_KEYS.cloudRegion);
  const normalizedCloudRegion = cloudRegionValue?.toLowerCase();
  const cloudRegion = isMossCloudRegion(normalizedCloudRegion) ? normalizedCloudRegion : null;
  const supabaseUrl = normalizeBaseUrl(supabaseUrlValue);
  const redirectUrl = redirectUrlValue ? normalizeRedirectUrl(redirectUrlValue) : null;
  const modelGatewayUrl = modelGatewayUrlValue ? normalizeBaseUrl(modelGatewayUrlValue) : null;

  const invalid: string[] = [];
  if (cloudRegionValue && !cloudRegion) invalid.push(MOSS_SUPABASE_CONFIG_ENV_KEYS.cloudRegion);
  if (!supabaseUrl) invalid.push(MOSS_SUPABASE_CONFIG_ENV_KEYS.supabaseUrl);
  if (redirectUrlValue && !redirectUrl) invalid.push(MOSS_SUPABASE_CONFIG_ENV_KEYS.redirectUrl);
  if (modelGatewayUrlValue && !modelGatewayUrl) {
    invalid.push(MOSS_SUPABASE_CONFIG_ENV_KEYS.modelGatewayUrl);
  }
  if (!supabaseUrl || invalid.length > 0) {
    return unavailable("invalid_configuration", [], invalid);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return unavailable("fetch_unavailable");

  const config: ResolvedSupabaseMossAuthConfig = {
    cloudRegion,
    supabaseUrl,
    publishableKey,
    redirectUrl,
    modelGatewayUrl,
  };
  const publicConfig: SupabaseMossAuthPublicConfig = {
    cloudRegion,
    supabaseUrl,
    redirectUrl,
    modelGatewayUrl,
  };

  return {
    status: "available",
    available: true,
    config: publicConfig,
    client: createClient(
      config,
      fetchImpl,
      options.now ?? Date.now,
      Math.max(1, Math.min(options.timeoutMs ?? 15_000, 120_000)),
    ),
  };
};

const boundedTimeoutMs = (value: number | undefined): number =>
  // The MemFire SMS hook chain (Auth -> moss-send-sms-hook -> moss-sms-relay ->
  // Aliyun) has been observed to take ~35s on a cold path; 15s timed out the
  // phone OTP send and made login fail spuriously. Keep the 120s hard cap.
  Math.max(1, Math.min(value ?? 60_000, 120_000));

/**
 * Creates the mainland phone-only Auth client. The factory intentionally reads
 * no legacy or Supabase Google settings, so cross-realm fallback cannot occur.
 */
export const createMemFirePhoneAuth = (
  options: CreateSupabaseMossAuthOptions = {},
): MemFirePhoneAuthAvailability => {
  const env = options.env ?? process.env;
  const urlValue = readTrimmed(env, MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.url);
  const publishableKey = readTrimmed(env, MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.publishableKey);
  const modelGatewayUrlValue = readTrimmed(env, MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.modelGatewayUrl);
  const realtimeRelayUrlValue = readTrimmed(env, MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.realtimeRelayUrl);

  const missing: string[] = [];
  if (!urlValue) missing.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.url);
  if (!publishableKey) missing.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.publishableKey);
  if (!modelGatewayUrlValue) missing.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.modelGatewayUrl);
  if (!realtimeRelayUrlValue) missing.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.realtimeRelayUrl);
  if (!urlValue || !publishableKey || !modelGatewayUrlValue || !realtimeRelayUrlValue) {
    return unavailable("missing_configuration", missing);
  }

  const supabaseUrl = normalizeRealmAuthOrigin(urlValue, isMemFireCloudApiHostname);
  const modelGatewayUrl = normalizeManagedGatewayUrl(modelGatewayUrlValue, env);
  const realtimeRelayUrl = normalizeStrictHttpsOrigin(realtimeRelayUrlValue);
  const invalid: string[] = [];
  if (!supabaseUrl) invalid.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.url);
  if (!modelGatewayUrl) invalid.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.modelGatewayUrl);
  if (!realtimeRelayUrl) invalid.push(MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.realtimeRelayUrl);
  if (!supabaseUrl || !modelGatewayUrl || !realtimeRelayUrl) {
    return unavailable("invalid_configuration", [], invalid);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return unavailable("fetch_unavailable");

  const timeoutMs = boundedTimeoutMs(options.timeoutMs);
  const resolved: ResolvedSupabaseMossAuthConfig = {
    cloudRegion: "cn",
    supabaseUrl,
    publishableKey,
    redirectUrl: null,
    modelGatewayUrl,
  };
  const verifyCloudRegion = createCloudRegionVerifier(resolved, fetchImpl, timeoutMs);
  const goTrue = createClient(
    resolved,
    fetchImpl,
    options.now ?? Date.now,
    timeoutMs,
    verifyCloudRegion,
  );
  const config: MemFirePhoneAuthPublicConfig = {
    realm: "memfire-phone",
    issuer: `${supabaseUrl}/auth/v1`,
    cloudRegion: "cn",
    modelGatewayUrl,
    realtimeRelayUrl,
  };
  const client: MemFirePhoneAuthClient = {
    config,
    sendPhoneOtp: goTrue.sendPhoneOtp,
    verifyPhoneOtp: async (phone, token) => {
      const session = await goTrue.verifyPhoneOtp(phone, token);
      if (!isExclusivePhoneIdentity(session.user)) throw protocolError("verify_phone_otp");
      return session;
    },
    refresh: async (refreshToken) => {
      const session = await goTrue.refresh(refreshToken);
      if (!isExclusivePhoneIdentity(session.user)) throw protocolError("refresh");
      return session;
    },
    getUser: async (accessToken) => {
      const user = await goTrue.getUser(accessToken);
      if (!isExclusivePhoneIdentity(user)) throw protocolError("get_user");
      return user;
    },
    logout: goTrue.logout,
  };

  return { status: "available", available: true, config, client };
};

/**
 * Creates the hosted Supabase Google-only OAuth client. It accepts only the
 * desktop callback allowlist, pins provider=google, and requires a one-time
 * Moss flow id plus S256 PKCE. The flow id lives in the approved redirect
 * URL's query because GoTrue owns the upstream OAuth `state` parameter and
 * preserves `redirect_to` while appending its PKCE code. It never reads
 * MemFire or legacy settings.
 */
export const createSupabaseGoogleAuth = (
  options: CreateSupabaseMossAuthOptions = {},
): SupabaseGoogleAuthAvailability => {
  const env = options.env ?? process.env;
  const urlValue = readTrimmed(env, MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.url);
  const publishableKey = readTrimmed(env, MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.publishableKey);
  const redirectUrlValue = readTrimmed(env, MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.redirectUrl);
  const modelGatewayUrlValue = readTrimmed(env, MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.modelGatewayUrl);
  const realtimeRelayUrlValue = readTrimmed(
    env,
    MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.realtimeRelayUrl,
  );

  const missing: string[] = [];
  if (!urlValue) missing.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.url);
  if (!publishableKey) missing.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.publishableKey);
  if (!redirectUrlValue) missing.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.redirectUrl);
  if (!modelGatewayUrlValue) missing.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.modelGatewayUrl);
  if (!realtimeRelayUrlValue) missing.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.realtimeRelayUrl);
  if (
    !urlValue ||
    !publishableKey ||
    !redirectUrlValue ||
    !modelGatewayUrlValue ||
    !realtimeRelayUrlValue
  ) {
    return unavailable("missing_configuration", missing);
  }

  const supabaseUrl = normalizeRealmAuthOrigin(urlValue, isSupabaseHostedProjectHostname);
  const redirectUrl = MOSS_GOOGLE_AUTH_REDIRECT_ALLOWLIST.includes(
    redirectUrlValue as (typeof MOSS_GOOGLE_AUTH_REDIRECT_ALLOWLIST)[number],
  )
    ? (redirectUrlValue as (typeof MOSS_GOOGLE_AUTH_REDIRECT_ALLOWLIST)[number])
    : null;
  const modelGatewayUrl = normalizeManagedGatewayUrl(modelGatewayUrlValue, env);
  const realtimeRelayUrl = normalizeStrictHttpsOrigin(realtimeRelayUrlValue);
  const invalid: string[] = [];
  if (!supabaseUrl) invalid.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.url);
  if (!redirectUrl) invalid.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.redirectUrl);
  if (!modelGatewayUrl) invalid.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.modelGatewayUrl);
  if (!realtimeRelayUrl) invalid.push(MOSS_SUPABASE_GOOGLE_AUTH_ENV_KEYS.realtimeRelayUrl);
  if (!supabaseUrl || !redirectUrl || !modelGatewayUrl || !realtimeRelayUrl) {
    return unavailable("invalid_configuration", [], invalid);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return unavailable("fetch_unavailable");

  const timeoutMs = boundedTimeoutMs(options.timeoutMs);
  const resolved: ResolvedSupabaseMossAuthConfig = {
    cloudRegion: "global",
    supabaseUrl,
    publishableKey,
    redirectUrl,
    modelGatewayUrl,
  };
  const verifyCloudRegion = createCloudRegionVerifier(resolved, fetchImpl, timeoutMs);
  const goTrue = createClient(
    resolved,
    fetchImpl,
    options.now ?? Date.now,
    timeoutMs,
    verifyCloudRegion,
  );
  const config: SupabaseGoogleAuthPublicConfig = {
    realm: "supabase-google",
    issuer: `${supabaseUrl}/auth/v1`,
    cloudRegion: "global",
    redirectUrl,
    modelGatewayUrl,
    realtimeRelayUrl,
  };
  const client: SupabaseGoogleAuthClient = {
    config,
    createAuthorizeUrl: async (input) => {
      const flowId = requireOAuthFlowId(input.flowId);
      const codeChallenge = requirePkceChallenge(input.pkce);
      await verifyCloudRegion("authorize_google");
      const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
      const callbackUrl = new URL(redirectUrl);
      callbackUrl.searchParams.set("flow_id", flowId);
      url.searchParams.set("provider", "google");
      url.searchParams.set("redirect_to", callbackUrl.toString());
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "s256");
      return url.toString();
    },
    exchangeCode: (authCode, codeVerifier) =>
      goTrue.exchangeCode(authCode, requirePkceVerifier(codeVerifier)),
    refresh: goTrue.refresh,
    getUser: goTrue.getUser,
    logout: goTrue.logout,
  };

  return { status: "available", available: true, config, client };
};
