import { randomUUID } from "node:crypto";

import type {
  MossAccountActiveRealmState,
  MossAccountSelectRealmInput,
  MossAccountSessionId,
  MossAccountSessionState,
  MossAccountSmsChallengeId,
  MossAccountUser,
  MossAccountUserId,
  MossPhoneNumber,
} from "@synara/contracts";
import { MossAccountSession as MossAccountSessionSchema } from "@synara/contracts";
import type { MossAccountSession } from "@synara/contracts";
import { Effect, Layer, Schema, Semaphore } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import {
  makeMossManagedProviderCoordinator,
  readMossLocalAuthorityRevision,
  withMossLocalAuthorityTransition,
  type MossManagedBinding,
} from "../mossAccountLifecycleLock";
import {
  createMemFirePhoneAuth,
  SupabaseMossAuthError,
  type MemFirePhoneAuthAvailability,
  type SupabaseMossAuthSession,
} from "../supabaseMossAuth";
import { MossAccountServiceError } from "../mossAccountErrors";
import {
  MossPhoneAccountService,
  type MossPhoneAccountServiceShape,
} from "../Services/MossPhoneAccountService";
import { MossManagedProvider } from "../Services/MossManagedProvider";
import { mossManagedCodexModelsForLane } from "./MossManagedProvider";
import {
  type FetchMossGatewayModelIds,
  type MossGatewayModelCatalogStatus,
  fetchMossGatewayModelIds,
  normalizeMossGatewayModelCatalog,
} from "../mossGatewayModels";

const SESSION_SECRET_NAME = "moss.phone.session";
const LOGOUT_PENDING_SECRET_NAME = "moss.phone.logout_pending";
const CHALLENGES_SECRET_NAME = "moss.phone.challenges";
const CHALLENGE_GENERATION_SECRET_NAME = "moss.phone.challenge_generation";
const OTP_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;

type StoredPhoneSessionV2 = {
  readonly version: 2;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: number;
  readonly session: MossAccountSession;
};

type StoredPhoneSessionV3 = {
  readonly version: 3;
  readonly realm: "memfire-phone";
  readonly issuer: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: number;
  readonly session: MossAccountSession;
};

type StoredPhoneSession = StoredPhoneSessionV2 | StoredPhoneSessionV3;

/**
 * Legacy V2 sessions predate the durable realm binding. This decoder is only a
 * local routing guard: the payload is deliberately not trusted for identity or
 * authentication, which still comes from the configured Auth client's
 * refresh/get-user calls below.
 */
function readUnverifiedJwtIssuer(accessToken: string): string | null {
  const segments = accessToken.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0 || !JWT_SEGMENT_PATTERN.test(segment))
  ) {
    return null;
  }

  const encodedPayload = segments[1];
  if (!encodedPayload) return null;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    // Buffer's decoder is intentionally forgiving. Re-encoding makes the
    // compact JWT payload requirement strict and rejects ambiguous input.
    if (payloadBytes.toString("base64url") !== encodedPayload) return null;
    const payload: unknown = JSON.parse(payloadBytes.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const issuer = (payload as Record<string, unknown>).iss;
    return typeof issuer === "string" && issuer.length > 0 && issuer.length <= 2_048
      ? issuer
      : null;
  } catch {
    return null;
  }
}

function normalizeConfiguredIssuer(issuer: string): string | null {
  try {
    const parsed = new URL(issuer);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    if (pathname !== "/auth/v1") return null;
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

const legacySessionMatchesConfiguredIssuer = (
  stored: StoredPhoneSessionV2,
  configuredIssuer: string,
): boolean => {
  const normalizedConfiguredIssuer = normalizeConfiguredIssuer(configuredIssuer);
  return (
    normalizedConfiguredIssuer !== null &&
    readUnverifiedJwtIssuer(stored.accessToken) === normalizedConfiguredIssuer
  );
};

type PendingChallenge = {
  readonly challengeId: string;
  readonly phoneNumber: MossPhoneNumber;
  readonly issuedAt: number;
  readonly issuedGeneration: number;
  readonly expiresAt: number;
};

type StoredLogoutPending = {
  readonly version: 1;
  /**
   * A non-secret durable generation for this cleanup attempt. Presence of the
   * tombstone, rather than any account credential, is the retry signal.
   */
  readonly generation: string;
  readonly requestedAt: number;
};

type StoredChallenges = {
  readonly version: 2;
  readonly challenges: ReadonlyArray<PendingChallenge>;
};

type StoredChallengeGeneration = {
  readonly version: 1;
  readonly generation: number;
};

type ResolvedPhoneSession =
  | {
      readonly authenticated: true;
      readonly state: MossAccountSessionState;
      readonly stored: StoredPhoneSessionV3;
    }
  | {
      readonly authenticated: false;
      readonly state: MossAccountSessionState;
      readonly error: MossAccountServiceError;
    };

export interface MakeMossPhoneAccountServiceOptions {
  readonly auth?: MemFirePhoneAuthAvailability;
  readonly now?: () => number;
  /**
   * Reads the account's database-backed model lineup from the gateway. Tests
   * may inject a legacy stub; live gateway failures are surfaced as degraded
   * readiness and never silently treated as an entitled realm catalog.
   */
  readonly fetchGatewayModels?: FetchMossGatewayModelIds;
}

function normalizeMainlandPhone(raw: string): {
  readonly phoneNumber: MossPhoneNumber;
} {
  const compact = raw.trim().replace(/[\s().-]/gu, "");
  const domesticPhone = compact.startsWith("+86")
    ? compact.slice(3)
    : compact.startsWith("86") && compact.length === 13
      ? compact.slice(2)
      : compact;
  if (!/^1[3-9]\d{9}$/u.test(domesticPhone)) {
    throw new MossAccountServiceError({
      code: "invalid_phone_number",
      message: "请输入有效的中国大陆手机号。",
    });
  }
  return { phoneNumber: `+86${domesticPhone}` as MossPhoneNumber };
}

const normalizePhoneEffect = (raw: string) =>
  Effect.try({
    try: () => normalizeMainlandPhone(raw),
    catch: (cause) =>
      cause instanceof MossAccountServiceError
        ? cause
        : new MossAccountServiceError({
            code: "invalid_phone_number",
            message: "请输入有效的中国大陆手机号。",
            cause,
          }),
  });

/**
 * MemFire returns phone claims in both `8613...` and `+8613...` forms across
 * its Auth endpoints. Moss stores the canonical `+86` form, so all identity
 * checks must compare normalized mainland numbers rather than raw strings.
 */
const authPhoneMatchesStored = (raw: string | null, stored: MossPhoneNumber): boolean => {
  if (typeof raw !== "string") return false;
  try {
    return normalizeMainlandPhone(raw).phoneNumber === stored;
  } catch {
    return false;
  }
};

const mapAuthError = (cause: unknown): MossAccountServiceError => {
  if (!(cause instanceof SupabaseMossAuthError)) {
    return new MossAccountServiceError({
      code: "authentication_service_unavailable",
      message: "手机号登录服务暂时不可用，请稍后再试。",
    });
  }
  const code =
    cause.code === "invalid_input" && cause.operation === "send_phone_otp"
      ? "invalid_phone_number"
      : cause.code === "otp_expired" ||
          (cause.operation === "verify_phone_otp" &&
            (cause.status === 400 || cause.status === 401 || cause.status === 403))
        ? "invalid_verification_code"
        : cause.status === 429 || cause.code.startsWith("over_")
          ? "sms_rate_limited"
          : isExpiredAuthError(cause)
            ? "session_expired"
            : cause.code === "invalid_response"
              ? "invalid_authentication_response"
              : cause.operation === "send_phone_otp"
                ? "sms_send_failed"
                : "authentication_service_unavailable";
  const message =
    code === "invalid_phone_number"
      ? "请输入有效的中国大陆手机号。"
      : code === "invalid_verification_code"
        ? "验证码无效或已过期，请重新获取。"
        : code === "sms_rate_limited"
          ? "验证码请求过于频繁，请稍后再试。"
          : code === "session_expired"
            ? "登录状态已过期，请重新登录。"
            : code === "invalid_authentication_response"
              ? "手机号登录响应异常，请重新获取验证码后再试。"
              : code === "sms_send_failed"
                ? "验证码发送失败，请稍后再试。"
                : "手机号登录服务暂时不可用，请稍后再试。";
  return new MossAccountServiceError({ code, message });
};

const mapSecretError = (_cause: unknown) =>
  new MossAccountServiceError({
    code: "persistence_failed",
    message: "无法安全保存手机号登录状态。",
  });

const mapManagedProviderError = (cause: unknown) =>
  new MossAccountServiceError({
    code: "persistence_failed",
    message: "无法配置 Moss 模型服务。",
    cause,
  });

function parseStoredSession(bytes: Uint8Array): StoredPhoneSession | null {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(bytes));
    if (!value || typeof value !== "object") return null;
    const stored = value as Record<string, unknown>;
    if (
      (stored.version !== 2 && stored.version !== 3) ||
      typeof stored.accessToken !== "string" ||
      stored.accessToken.length === 0 ||
      stored.accessToken.length > 16_384 ||
      typeof stored.refreshToken !== "string" ||
      stored.refreshToken.length === 0 ||
      stored.refreshToken.length > 16_384 ||
      typeof stored.accessTokenExpiresAt !== "number" ||
      !Number.isFinite(stored.accessTokenExpiresAt) ||
      !stored.session
    ) {
      return null;
    }
    const common = {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      accessTokenExpiresAt: stored.accessTokenExpiresAt,
      session: Schema.decodeUnknownSync(MossAccountSessionSchema)(stored.session),
    };
    if (stored.version === 2) return { version: 2, ...common };
    if (
      stored.realm !== "memfire-phone" ||
      typeof stored.issuer !== "string" ||
      stored.issuer.length === 0 ||
      stored.issuer.length > 2_048
    ) {
      return null;
    }
    return {
      version: 3,
      realm: "memfire-phone",
      issuer: stored.issuer,
      ...common,
    };
  } catch {
    return null;
  }
}

function parseStoredChallenges(bytes: Uint8Array): StoredChallenges | null {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(bytes));
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<StoredChallenges>;
    if (stored.version !== 2 || !Array.isArray(stored.challenges)) return null;
    const challenges: PendingChallenge[] = [];
    for (const entry of stored.challenges) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as PendingChallenge).challengeId !== "string" ||
        (entry as PendingChallenge).challengeId.length === 0 ||
        typeof (entry as PendingChallenge).phoneNumber !== "string" ||
        !/^\+861[3-9]\d{9}$/u.test((entry as PendingChallenge).phoneNumber) ||
        typeof (entry as PendingChallenge).issuedAt !== "number" ||
        !Number.isFinite((entry as PendingChallenge).issuedAt) ||
        typeof (entry as PendingChallenge).issuedGeneration !== "number" ||
        !Number.isInteger((entry as PendingChallenge).issuedGeneration) ||
        (entry as PendingChallenge).issuedGeneration < 0 ||
        typeof (entry as PendingChallenge).expiresAt !== "number" ||
        !Number.isFinite((entry as PendingChallenge).expiresAt)
      ) {
        return null;
      }
      challenges.push({
        challengeId: (entry as PendingChallenge).challengeId,
        phoneNumber: (entry as PendingChallenge).phoneNumber,
        issuedAt: (entry as PendingChallenge).issuedAt,
        issuedGeneration: (entry as PendingChallenge).issuedGeneration,
        expiresAt: (entry as PendingChallenge).expiresAt,
      });
    }
    return { version: 2, challenges };
  } catch {
    return null;
  }
}

function parseStoredChallengeGeneration(bytes: Uint8Array): StoredChallengeGeneration | null {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(bytes));
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<StoredChallengeGeneration>;
    if (
      stored.version !== 1 ||
      typeof stored.generation !== "number" ||
      !Number.isSafeInteger(stored.generation) ||
      stored.generation < 0 ||
      stored.generation >= Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    return { version: 1, generation: stored.generation };
  } catch {
    return null;
  }
}

const signedOutState = (configured: boolean): MossAccountSessionState => ({
  configured,
  authenticated: false,
  session: null,
  smsProvider: "aliyun",
  aliyunSmsConfigured: configured,
});

const unresolvedPhoneSession = (
  configured: boolean,
  code:
    | "authentication_service_unavailable"
    | "authentication_required"
    | "session_expired"
    | "persistence_failed",
  message: string,
): ResolvedPhoneSession => ({
  authenticated: false,
  state: signedOutState(configured),
  error: new MossAccountServiceError({ code, message }),
});

const resolvedPhoneSession = (
  stored: StoredPhoneSessionV3,
  session: MossAccountSession,
  configured = true,
  modelGatewayStatus?: MossGatewayModelCatalogStatus,
  selectedRealm: "cn" | null = null,
): ResolvedPhoneSession => ({
  authenticated: true,
  stored,
  state: {
    configured,
    authenticated: true,
    session,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
    ...(modelGatewayStatus ? { modelGatewayStatus } : {}),
    ...(selectedRealm ? { activeRealm: selectedRealm } : {}),
  },
});

function sessionFromAuthResult(
  result: SupabaseMossAuthSession,
  phoneNumber: MossPhoneNumber,
  now: number,
): MossAccountSession {
  const createdAt = result.user.createdAt ?? new Date(now).toISOString();
  const updatedAt = result.user.updatedAt ?? createdAt;
  const displayName = [
    result.user.userMetadata.display_name,
    result.user.userMetadata.full_name,
    result.user.userMetadata.name,
  ].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80,
  );

  const user: MossAccountUser = {
    id: result.user.id as MossAccountUserId,
    phoneNumber,
    displayName: displayName?.trim() ?? null,
    role: "member",
    status: "active",
    createdAt,
    updatedAt,
    lastLoginAt: new Date(now).toISOString(),
  };
  return {
    id: `moss_phone_${randomUUID()}` as MossAccountSessionId,
    user,
    createdAt: new Date(now).toISOString(),
    // This contract field describes the current bearer lifetime. Durable login
    // ownership is the refresh token plus explicit server revocation/logout;
    // the client must never treat this timestamp as an OTP boundary.
    expiresAt: new Date(result.expiresAt).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  };
}

function isExpiredAuthError(cause: SupabaseMossAuthError): boolean {
  return (
    cause.status === 401 ||
    cause.code === "bad_jwt" ||
    cause.code === "session_expired" ||
    cause.code === "session_not_found" ||
    cause.code === "refresh_token_not_found" ||
    cause.code === "refresh_token_already_used"
  );
}

export const makeMossPhoneAccountService = Effect.fn(function* (
  options: MakeMossPhoneAccountServiceOptions = {},
) {
  const secretStore = yield* ServerSecretStore;
  const managedProvider = yield* MossManagedProvider;
  const managedProviderCoordinator = makeMossManagedProviderCoordinator(
    secretStore,
    managedProvider,
  );
  const lifecycleSemaphore = yield* Semaphore.make(1);
  const auth = options.auth ?? createMemFirePhoneAuth();
  const now = options.now ?? Date.now;
  const fetchGatewayModels = options.fetchGatewayModels ?? fetchMossGatewayModelIds;
  const challenges = new Map<string, PendingChallenge>();
  let managedBinding: MossManagedBinding | null = null;
  let modelGatewayStatus: MossGatewayModelCatalogStatus | undefined;
  let activeRealm: "cn" | null = null;

  const serialize = <A>(effect: Effect.Effect<A, MossAccountServiceError>) =>
    lifecycleSemaphore.withPermits(1)(effect);

  const serializeLocalTransition = <A>(effect: Effect.Effect<A, MossAccountServiceError>) =>
    withMossLocalAuthorityTransition(secretStore, serialize(effect));

  const provisionManagedProvider = (input: {
    readonly accessToken: string;
    readonly gatewayBaseUrl: string;
    readonly models: ReadonlyArray<string>;
    readonly selectionPolicy: "select" | "preserve";
  }) =>
    managedProviderCoordinator
      .provision({
        authority: "memfire-phone",
        accessToken: input.accessToken,
        gatewayBaseUrl: input.gatewayBaseUrl,
        models: [...input.models],
        selectionPolicy: input.selectionPolicy,
      })
      .pipe(
        Effect.tap((binding) =>
          Effect.sync(() => {
            managedBinding = binding;
          }),
        ),
        Effect.mapError(mapManagedProviderError),
        Effect.asVoid,
      );

  const releaseManagedProvider = (input: {
    readonly expectedAccessToken?: string | undefined;
    readonly force?: boolean | undefined;
  }) => {
    const expected =
      managedBinding &&
      (input.expectedAccessToken === undefined ||
        managedBinding.accessToken === input.expectedAccessToken)
        ? managedBinding
        : input.expectedAccessToken
          ? {
              authority: "memfire-phone" as const,
              accessToken: input.expectedAccessToken,
            }
          : undefined;
    return managedProviderCoordinator
      .release({
        authority: "memfire-phone",
        ...(expected ? { expected: expected as MossManagedBinding } : {}),
        ...(input.force ? { force: true } : {}),
      })
      .pipe(
        Effect.tap((released) =>
          released
            ? Effect.sync(() => {
                const expectedBindingId =
                  expected && "bindingId" in expected ? expected.bindingId : undefined;
                if (
                  managedBinding &&
                  (expectedBindingId === undefined ||
                    managedBinding.bindingId === expectedBindingId)
                ) {
                  managedBinding = null;
                }
              })
            : Effect.void,
        ),
        Effect.flatMap((released) =>
          released
            ? Effect.void
            : Effect.fail(new Error("Managed provider release proof did not match.")),
        ),
        Effect.mapError(mapManagedProviderError),
      );
  };

  const removeStoredSession = () =>
    secretStore.remove(SESSION_SECRET_NAME).pipe(Effect.mapError(mapSecretError));

  const readStoredSessionEnvelope = () =>
    secretStore.get(SESSION_SECRET_NAME).pipe(
      Effect.mapError(mapSecretError),
      Effect.map((bytes) => {
        if (!bytes) return { exists: false as const, stored: null };
        const stored = parseStoredSession(bytes);
        // Invalid state is still removed only after a durable logout tombstone
        // exists. Otherwise a crash here could strand managed credentials with
        // no remaining cleanup signal.
        return { exists: true as const, stored };
      }),
    );

  const readStoredSession = () =>
    readStoredSessionEnvelope().pipe(Effect.map(({ stored }) => stored));

  const persistStoredSession = (stored: StoredPhoneSession) =>
    secretStore
      .set(SESSION_SECRET_NAME, textEncoder.encode(JSON.stringify(stored)))
      .pipe(Effect.mapError(mapSecretError));

  const readStoredChallenges = () =>
    secretStore.get(CHALLENGES_SECRET_NAME).pipe(
      Effect.mapError(mapSecretError),
      Effect.map((bytes) => {
        if (!bytes) return { exists: false as const, stored: null };
        return { exists: true as const, stored: parseStoredChallenges(bytes) };
      }),
    );

  const persistStoredChallenges = (entries: ReadonlyArray<PendingChallenge>) =>
    entries.length === 0
      ? secretStore.remove(CHALLENGES_SECRET_NAME).pipe(Effect.mapError(mapSecretError))
      : secretStore
          .set(
            CHALLENGES_SECRET_NAME,
            textEncoder.encode(
              JSON.stringify({ version: 2, challenges: entries } satisfies StoredChallenges),
            ),
          )
          .pipe(Effect.mapError(mapSecretError));

  const readChallengeGeneration = () =>
    secretStore.get(CHALLENGE_GENERATION_SECRET_NAME).pipe(
      Effect.mapError(mapSecretError),
      Effect.flatMap((bytes) => {
        if (!bytes) return Effect.succeed(0);
        const stored = parseStoredChallengeGeneration(bytes);
        if (stored) return Effect.succeed(stored.generation);
        const error = new MossAccountServiceError({
          code: "persistence_failed",
          message: "已保存的手机号验证码代际状态无效，已安全清除。",
        });
        return secretStore
          .remove(CHALLENGE_GENERATION_SECRET_NAME)
          .pipe(Effect.mapError(mapSecretError), Effect.andThen(Effect.fail(error)));
      }),
    );

  const persistChallengeGeneration = (generation: number) =>
    secretStore
      .set(
        CHALLENGE_GENERATION_SECRET_NAME,
        textEncoder.encode(
          JSON.stringify({ version: 1, generation } satisfies StoredChallengeGeneration),
        ),
      )
      .pipe(Effect.mapError(mapSecretError));

  const synchronizeChallengeCache = (entries: ReadonlyArray<PendingChallenge>) =>
    Effect.sync(() => {
      challenges.clear();
      for (const entry of entries) {
        challenges.set(entry.challengeId, entry);
      }
    });

  const loadChallenges = () =>
    readStoredChallenges().pipe(
      Effect.flatMap(({ exists, stored }) => {
        if (!exists) {
          return synchronizeChallengeCache([]).pipe(Effect.as<ReadonlyArray<PendingChallenge>>([]));
        }
        if (!stored) {
          return persistStoredChallenges([]).pipe(
            Effect.andThen(synchronizeChallengeCache([])),
            Effect.andThen(
              Effect.fail(
                new MossAccountServiceError({
                  code: "persistence_failed",
                  message: "已保存的手机号验证码状态无效，已安全清除。",
                }),
              ),
            ),
          );
        }
        const liveEntries = stored.challenges.filter((entry) => entry.expiresAt > now());
        return persistStoredChallenges(liveEntries).pipe(
          Effect.andThen(synchronizeChallengeCache(liveEntries)),
          Effect.as<ReadonlyArray<PendingChallenge>>(liveEntries),
        );
      }),
    );

  const upsertChallenge = (entry: PendingChallenge) =>
    loadChallenges().pipe(
      Effect.flatMap((entries) => {
        const next = [
          ...entries.filter(
            (candidate) =>
              candidate.challengeId !== entry.challengeId &&
              candidate.phoneNumber !== entry.phoneNumber,
          ),
          entry,
        ];
        return persistStoredChallenges(next).pipe(Effect.andThen(synchronizeChallengeCache(next)));
      }),
    );

  const consumeChallenge = (challengeId: string) =>
    loadChallenges().pipe(
      Effect.flatMap((entries) => {
        const next = entries.filter((entry) => entry.challengeId !== challengeId);
        return persistStoredChallenges(next).pipe(Effect.andThen(synchronizeChallengeCache(next)));
      }),
    );

  const retirePhoneChallenges = (phoneNumber: MossPhoneNumber) =>
    loadChallenges().pipe(
      Effect.flatMap((entries) => {
        const next = entries.filter((entry) => entry.phoneNumber !== phoneNumber);
        return persistStoredChallenges(next).pipe(Effect.andThen(synchronizeChallengeCache(next)));
      }),
    );

  const readLogoutPending = () =>
    secretStore.get(LOGOUT_PENDING_SECRET_NAME).pipe(Effect.mapError(mapSecretError));

  const persistLogoutPending = () => {
    const pending: StoredLogoutPending = {
      version: 1,
      generation: randomUUID(),
      requestedAt: now(),
    };
    return secretStore
      .set(LOGOUT_PENDING_SECRET_NAME, textEncoder.encode(JSON.stringify(pending)))
      .pipe(Effect.mapError(mapSecretError));
  };

  const ensureLogoutPending = () =>
    readLogoutPending().pipe(
      Effect.flatMap((pending) => (pending ? Effect.void : persistLogoutPending())),
    );

  const removeLogoutPending = () =>
    secretStore.remove(LOGOUT_PENDING_SECRET_NAME).pipe(Effect.mapError(mapSecretError));

  const synchronizeManagedProvider = (
    stored: StoredPhoneSessionV3,
    selectionPolicy: "select" | "preserve",
  ): Effect.Effect<MossGatewayModelCatalogStatus | undefined, MossAccountServiceError> => {
    const gatewayBaseUrl = auth.available ? auth.config.modelGatewayUrl : undefined;
    const reconcile = gatewayBaseUrl
      ? fetchGatewayModels({ gatewayBaseUrl, accessToken: stored.accessToken }).pipe(
          Effect.flatMap((rawCatalog) => {
            const catalog = normalizeMossGatewayModelCatalog(rawCatalog);
            const status = catalog.status;
            return Effect.sync(() => {
              modelGatewayStatus = status;
            }).pipe(
              Effect.andThen(
                catalog.status === "ready"
                  ? provisionManagedProvider({
                      accessToken: stored.accessToken,
                      gatewayBaseUrl,
                      // The managed CN lineup is the product catalog. Account
                      // plans control spend through quota/credits, so Basic
                      // accounts must see the same models as paid tiers.
                      models: [...mossManagedCodexModelsForLane("cn")],
                      selectionPolicy,
                    }).pipe(Effect.tap(() => Effect.sync(() => (activeRealm = "cn"))))
                  : Effect.sync(() => (activeRealm = null)),
              ),
              Effect.as(status),
            );
          }),
        )
      : releaseManagedProvider({
          expectedAccessToken: stored.accessToken,
          force: true,
        }).pipe(
          Effect.tap(() => Effect.sync(() => (activeRealm = null))),
          Effect.as(undefined),
        );
    if (selectionPolicy === "select" || !gatewayBaseUrl) {
      return reconcile;
    }
    return managedProviderCoordinator
      .getReconcileState({
        authority: "memfire-phone",
        accessToken: stored.accessToken,
        gatewayBaseUrl,
      })
      .pipe(
        Effect.mapError(mapManagedProviderError),
        Effect.flatMap((state) => {
          switch (state) {
            case "current":
              return Effect.sync(() => (activeRealm = "cn")).pipe(Effect.as(modelGatewayStatus));
            case "owned-by-other":
              return Effect.sync(() => (activeRealm = null)).pipe(Effect.as(modelGatewayStatus));
            case "same-authority-stale":
            case "missing":
              return reconcile;
            case "collision":
              return Effect.fail(
                new MossAccountServiceError({
                  code: "persistence_failed",
                  message: "Moss 托管服务商与现有本地服务商配置冲突。",
                }),
              );
          }
        }),
      );
  };

  const clearStoredSessionAndManagedProvider = (logoutPendingAlreadyStored = false) =>
    Effect.gen(function* () {
      // Gateway readiness belongs to the selected credential generation. Never
      // let a signed-out or replaced phone account inherit the prior status.
      modelGatewayStatus = undefined;
      activeRealm = null;
      if (!logoutPendingAlreadyStored) yield* ensureLogoutPending();
      const stored = yield* readStoredSession().pipe(Effect.catch(() => Effect.succeed(null)));

      const failures: MossAccountServiceError[] = [];
      yield* removeStoredSession().pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error);
          }),
        ),
      );
      yield* releaseManagedProvider({
        expectedAccessToken: stored?.accessToken,
        force: true,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error);
          }),
        ),
      );
      const failure = failures[0];
      if (failure) return yield* failure;
      // The tombstone is the sole retry state after the phone secret is gone.
      // Delete it only after both secret removal and managed-provider disable
      // (including its runtime stop) have completed successfully.
      yield* removeLogoutPending();
    }).pipe((effect) => withMossLocalAuthorityTransition(secretStore, effect));

  const invalidateChallengesForPendingLogout = () =>
    readChallengeGeneration().pipe(
      Effect.flatMap((generation) => persistChallengeGeneration(generation + 1)),
      Effect.andThen(persistStoredChallenges([])),
      Effect.andThen(synchronizeChallengeCache([])),
    );

  const finishPendingLogout = () =>
    readLogoutPending().pipe(
      Effect.flatMap((pending) =>
        pending
          ? invalidateChallengesForPendingLogout().pipe(
              Effect.andThen(clearStoredSessionAndManagedProvider(true)),
              Effect.as(true),
            )
          : Effect.succeed(false),
      ),
    );

  const clearStoredSessionAndManagedProviderIfNeeded = (force: boolean) =>
    force
      ? clearStoredSessionAndManagedProvider()
      : managedProvider.needsDisable().pipe(
          Effect.mapError(mapManagedProviderError),
          Effect.flatMap((needsDisable) =>
            needsDisable ? clearStoredSessionAndManagedProvider() : Effect.void,
          ),
        );

  const disableManagedProviderPreservingStoredSession = (expectedAccessToken?: string) =>
    managedProvider.needsDisable().pipe(
      Effect.mapError(mapManagedProviderError),
      Effect.flatMap((needsDisable) =>
        needsDisable
          ? readStoredSession().pipe(
              Effect.catch(() => Effect.succeed(null)),
              Effect.flatMap((stored) =>
                releaseManagedProvider({
                  expectedAccessToken: expectedAccessToken ?? stored?.accessToken,
                  force: true,
                }),
              ),
            )
          : Effect.void,
      ),
    );

  type ResolveSessionMode = "synchronize" | "validate-only";

  const resolveSession = (
    mode: ResolveSessionMode = "synchronize",
  ): Effect.Effect<ResolvedPhoneSession, MossAccountServiceError> =>
    Effect.gen(function* () {
      const finishedPendingLogout = yield* finishPendingLogout();
      if (finishedPendingLogout) {
        return unresolvedPhoneSession(
          auth.available,
          "authentication_required",
          "请先登录 Moss 手机号账号。",
        );
      }

      const storedEnvelope = yield* readStoredSessionEnvelope();
      const stored = storedEnvelope.stored;
      if (!stored) {
        modelGatewayStatus = undefined;
        // A genuinely absent session with an already credential-free
        // provider is the normal signed-out state. Corrupt state or an
        // active/conflicting reserved surface still fails closed through the
        // durable logout path.
        yield* clearStoredSessionAndManagedProviderIfNeeded(storedEnvelope.exists);
        return storedEnvelope.exists
          ? unresolvedPhoneSession(
              auth.available,
              "persistence_failed",
              "已保存的手机号登录状态无效，已安全清除。",
            )
          : unresolvedPhoneSession(
              auth.available,
              "authentication_required",
              "请先登录 Moss 手机号账号。",
            );
      }

      // Missing configuration prevents comparing a syntactically valid legacy
      // issuer, but it is not needed to reject a token that has no parseable
      // issuer at all. Clear that intrinsically unroutable state locally even
      // while Auth is offline.
      if (stored.version === 2 && readUnverifiedJwtIssuer(stored.accessToken) === null) {
        yield* clearStoredSessionAndManagedProvider();
        return unresolvedPhoneSession(
          auth.available,
          "authentication_required",
          "旧手机号登录状态无法确认属于当前 MemFire 项目，请重新登录。",
        );
      }

      if (!auth.available) {
        // Missing/transient runtime configuration is not an account revocation.
        // Retain the durable verified session, but fence the managed provider
        // until a live server validation can supply a usable bearer again.
        yield* disableManagedProviderPreservingStoredSession();
        return stored.version === 3
          ? resolvedPhoneSession(stored, stored.session, false)
          : unresolvedPhoneSession(
              false,
              "authentication_service_unavailable",
              "手机号登录服务暂时不可用，无法验证旧登录状态。",
            );
      }

      if (
        stored.version === 2 &&
        !legacySessionMatchesConfiguredIssuer(stored, auth.config.issuer)
      ) {
        yield* clearStoredSessionAndManagedProvider();
        return unresolvedPhoneSession(
          true,
          "authentication_required",
          "旧手机号登录状态无法确认属于当前 MemFire 项目，请重新登录。",
        );
      }

      if (stored.version === 3 && stored.issuer !== auth.config.issuer) {
        yield* clearStoredSessionAndManagedProvider();
        return unresolvedPhoneSession(
          true,
          "session_expired",
          "手机号登录状态不属于当前 MemFire 项目，请重新登录。",
        );
      }

      let current = stored;
      if (stored.accessTokenExpiresAt <= now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
        const refreshed = yield* Effect.tryPromise({
          try: () => auth.client.refresh(stored.refreshToken),
          catch: (cause) => cause,
        }).pipe(
          Effect.map((session) => ({ kind: "refreshed" as const, session })),
          Effect.catch((cause) =>
            Effect.succeed({
              kind:
                cause instanceof SupabaseMossAuthError && isExpiredAuthError(cause)
                  ? ("expired" as const)
                  : ("offline" as const),
            }),
          ),
        );
        if (refreshed.kind === "expired") {
          yield* clearStoredSessionAndManagedProvider();
          return unresolvedPhoneSession(
            true,
            "session_expired",
            "手机号登录状态已过期，请重新登录。",
          );
        }
        if (refreshed.kind === "refreshed") {
          if (
            refreshed.session.user.id !== stored.session.user.id ||
            !authPhoneMatchesStored(refreshed.session.user.phone, stored.session.user.phoneNumber)
          ) {
            yield* clearStoredSessionAndManagedProvider();
            return unresolvedPhoneSession(
              true,
              "session_expired",
              "手机号登录状态已过期，请重新登录。",
            );
          }
          current = {
            version: 3,
            realm: "memfire-phone",
            issuer: auth.config.issuer,
            accessToken: refreshed.session.accessToken,
            refreshToken: refreshed.session.refreshToken,
            accessTokenExpiresAt: refreshed.session.expiresAt,
            session: {
              ...stored.session,
              expiresAt: new Date(refreshed.session.expiresAt).toISOString(),
              lastSeenAt: new Date(now()).toISOString(),
            },
          };
          // Replace the single credential value before touching the previously
          // usable runtime. A failed atomic set therefore leaves the old
          // durable session recoverable; a crash after the set recovers the new
          // generation on the next getSession call.
          yield* persistStoredSession(current).pipe(
            Effect.catch((error) =>
              disableManagedProviderPreservingStoredSession().pipe(
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          );
          yield* disableManagedProviderPreservingStoredSession(stored.accessToken);
        } else {
          if (current.version !== 3) {
            yield* disableManagedProviderPreservingStoredSession();
            return unresolvedPhoneSession(
              true,
              "authentication_service_unavailable",
              "手机号登录服务暂时不可用，无法验证旧登录状态。",
            );
          }
          if (current.accessTokenExpiresAt <= now()) {
            // The durable account metadata and refresh token remain useful
            // while the authentication service is temporarily unreachable,
            // but an expired bearer must never remain routable through the
            // managed provider surface.
            yield* disableManagedProviderPreservingStoredSession();
          } else if (mode === "synchronize") {
            yield* synchronizeManagedProvider(current, "preserve");
          }
          return resolvedPhoneSession(current, stored.session, true, modelGatewayStatus);
        }
      }

      const validation = yield* Effect.tryPromise({
        try: () => auth.client.getUser(current.accessToken),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((result) => ({ kind: "valid" as const, result })),
        Effect.catch((cause) =>
          Effect.succeed({
            kind:
              cause instanceof SupabaseMossAuthError && isExpiredAuthError(cause)
                ? ("expired" as const)
                : ("offline" as const),
          }),
        ),
      );
      if (
        validation.kind === "expired" ||
        (validation.kind === "valid" &&
          (validation.result.id !== current.session.user.id ||
            !authPhoneMatchesStored(validation.result.phone, current.session.user.phoneNumber)))
      ) {
        yield* clearStoredSessionAndManagedProvider();
        return unresolvedPhoneSession(
          true,
          "session_expired",
          "手机号登录状态已过期，请重新登录。",
        );
      }
      if (mode === "validate-only" && validation.kind === "offline") {
        return yield* Effect.fail(
          new MossAccountServiceError({
            code: "authentication_service_unavailable",
            message: "手机号登录服务暂时不可用，无法验证登录状态。",
          }),
        );
      }
      if (validation.kind === "valid" && current.version === 2) {
        const upgraded: StoredPhoneSessionV3 = {
          version: 3,
          realm: "memfire-phone",
          issuer: auth.config.issuer,
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
          accessTokenExpiresAt: current.accessTokenExpiresAt,
          session: current.session,
        };
        yield* persistStoredSession(upgraded);
        current = upgraded;
      }
      if (current.version !== 3) {
        return yield* Effect.fail(
          new MossAccountServiceError({
            code: "persistence_failed",
            message: "手机号登录状态无法安全升级。",
          }),
        );
      }
      if (mode === "synchronize") {
        // A valid phone session must remain visible to the client even when a
        // stale local provider binding temporarily blocks managed-provider
        // reconciliation.  Provider ownership is a maintenance concern; it
        // must not turn an authenticated account into the login screen.
        yield* synchronizeManagedProvider(current, "preserve").pipe(
          Effect.catch((error) =>
            error.code === "persistence_failed" &&
            error.message === "Moss 托管服务商与现有本地服务商配置冲突。"
              ? Effect.logWarning("Moss phone session restored without provider reconciliation", {
                  code: error.code,
                }).pipe(Effect.asVoid)
              : Effect.fail(error),
          ),
        );
      }
      return resolvedPhoneSession(
        current,
        {
          ...current.session,
          lastSeenAt: new Date(now()).toISOString(),
        },
        true,
        modelGatewayStatus,
        activeRealm,
      );
    });

  const getSession: MossPhoneAccountServiceShape["getSession"] = () =>
    serialize(resolveSession()).pipe(Effect.map((resolved) => resolved.state));

  const getLocalAuthority: MossPhoneAccountServiceShape["getLocalAuthority"] = () =>
    Effect.gen(function* () {
      // Do not acquire the network lifecycle permit or run its cleanup path.
      // A durable logout intent fences reads even before cleanup can finish.
      const revision = readMossLocalAuthorityRevision(secretStore);
      if (revision === null) return { identity: null };
      if (yield* readLogoutPending()) return { identity: null };
      const stored = yield* readStoredSession();
      const selected = yield* managedProviderCoordinator
        .getLocalActiveAuthority()
        .pipe(Effect.mapError(mapManagedProviderError));
      const current = yield* readStoredSession();
      if (yield* readLogoutPending()) return { identity: null };
      if (readMossLocalAuthorityRevision(secretStore) !== revision) return { identity: null };
      return {
        ...(selected === "memfire-phone" ? { activeRealm: "cn" as const } : {}),
        identity:
          auth.available &&
          stored?.version === 3 &&
          current?.version === 3 &&
          stored.issuer === auth.config.issuer &&
          current.issuer === auth.config.issuer &&
          stored.session.id === current.session.id &&
          stored.session.user.id === current.session.user.id
            ? {
                realm: "memfire-phone" as const,
                gatewayBaseUrl: auth.config.modelGatewayUrl,
                account: { id: current.session.user.id, realm: "memfire-phone" as const },
                displayName: current.session.user.displayName,
                phoneNumber: current.session.user.phoneNumber,
              }
            : null,
      };
    });

  const restoreSession: MossPhoneAccountServiceShape["restoreSession"] = () =>
    serialize(
      resolveSession("validate-only").pipe(
        Effect.flatMap((resolved) => {
          if (!resolved.authenticated) return Effect.fail(resolved.error);
          if (!auth.available || resolved.stored.accessTokenExpiresAt <= now()) {
            return Effect.fail(
              new MossAccountServiceError({
                code: "authentication_service_unavailable",
                message: "手机号登录服务暂时不可用，无法刷新访问令牌。",
              }),
            );
          }
          return Effect.void;
        }),
      ),
    );

  const getAccessToken: MossPhoneAccountServiceShape["getAccessToken"] = () =>
    serialize(
      resolveSession().pipe(
        Effect.flatMap((resolved) =>
          !resolved.authenticated
            ? Effect.fail(resolved.error)
            : !auth.available
              ? Effect.fail(
                  new MossAccountServiceError({
                    code: "authentication_service_unavailable",
                    message: "手机号登录服务暂时不可用，无法刷新访问令牌。",
                  }),
                )
              : resolved.stored.accessTokenExpiresAt > now()
                ? Effect.succeed(resolved.stored.accessToken)
                : Effect.fail(
                    new MossAccountServiceError({
                      code: "authentication_service_unavailable",
                      message: "手机号登录服务暂时不可用，无法刷新访问令牌。",
                    }),
                  ),
        ),
      ),
    );

  const getAuthorityCredential: MossPhoneAccountServiceShape["getAuthorityCredential"] = () =>
    serialize(
      resolveSession().pipe(
        Effect.flatMap((resolved) => {
          if (!resolved.authenticated) return Effect.fail(resolved.error);
          if (!auth.available || resolved.stored.accessTokenExpiresAt <= now()) {
            return Effect.fail(
              new MossAccountServiceError({
                code: "authentication_service_unavailable",
                message: "手机号登录服务暂时不可用，无法刷新访问令牌。",
              }),
            );
          }
          if (
            resolved.stored.realm !== "memfire-phone" ||
            resolved.stored.issuer !== auth.config.issuer
          ) {
            return Effect.fail(
              new MossAccountServiceError({
                code: "session_expired",
                message: "手机号登录状态不属于当前 MemFire 项目，请重新登录。",
              }),
            );
          }
          return Effect.succeed({
            realm: "memfire-phone" as const,
            issuer: auth.config.issuer,
            accessToken: resolved.stored.accessToken,
            gatewayBaseUrl: auth.config.modelGatewayUrl,
            realtimeRelayUrl: auth.config.realtimeRelayUrl,
          });
        }),
      ),
    );

  const activateRealm: MossPhoneAccountServiceShape["activateRealm"] = (input) =>
    serializeLocalTransition(
      Effect.gen(function* () {
        if (input?.realm !== undefined && input.realm !== "cn") {
          return yield* new MossAccountServiceError({
            code: "persistence_failed",
            message: "手机号账号只能激活国内模型网关。",
          });
        }
        if (!auth.available) {
          return yield* new MossAccountServiceError({
            code: "authentication_service_unavailable",
            message: "手机号登录服务暂时不可用，无法激活国内模型网关。",
          });
        }
        const resolved = yield* resolveSession();
        if (!resolved.authenticated) return yield* Effect.fail(resolved.error);
        const gatewayStatus = yield* synchronizeManagedProvider(resolved.stored, "select");
        return {
          activeRealm: activeRealm,
          ...(gatewayStatus ? { modelGatewayStatus: gatewayStatus } : {}),
        } satisfies MossAccountActiveRealmState;
      }),
    );

  const startPhoneLogin: MossPhoneAccountServiceShape["startPhoneLogin"] = (input) =>
    serialize(
      Effect.gen(function* () {
        if (!auth.available) {
          return yield* new MossAccountServiceError({
            code: "authentication_service_unavailable",
            message: "手机号登录服务尚未配置。",
          });
        }
        // A previous logout attempt is a hard account boundary. Complete its
        // durable fence before issuing an OTP that should remain usable.
        yield* finishPendingLogout();
        const normalized = yield* normalizePhoneEffect(input.phoneNumber);
        // Retire any earlier local mapping before a new OTP is issued. If the
        // provider accepts the send but durable challenge persistence fails, no
        // previous challenge id can be reused with the newly issued OTP.
        yield* retirePhoneChallenges(normalized.phoneNumber);
        const sendPhoneOtpOnce = () =>
          Effect.tryPromise({
            try: () => auth.client.sendPhoneOtp(normalized.phoneNumber),
            catch: (cause) => cause,
          });
        // Cloud-region verification runs before the Auth provider dispatch. A
        // typed cold-start verifier failure proves that no OTP request was
        // dispatched, so recover it exactly once. Ambiguous transport errors
        // could have sent a second SMS or issued a different code and remain
        // fail-closed.
        yield* sendPhoneOtpOnce().pipe(
          Effect.catch((cause) =>
            cause instanceof SupabaseMossAuthError &&
            cause.operation === "send_phone_otp" &&
            cause.code === "cloud_region_unavailable"
              ? sendPhoneOtpOnce()
              : Effect.fail(cause),
          ),
          Effect.mapError(mapAuthError),
        );
        const challengeId = `moss_phone_challenge_${randomUUID()}`;
        const generation = yield* readChallengeGeneration();
        const issuedAt = now();
        const expiresAt = issuedAt + OTP_TTL_MS;
        yield* upsertChallenge({
          challengeId,
          ...normalized,
          issuedAt,
          issuedGeneration: generation,
          expiresAt,
        });
        return {
          challengeId: challengeId as MossAccountSmsChallengeId,
          phoneNumber: normalized.phoneNumber,
          expiresAt: new Date(expiresAt).toISOString(),
          provider: "aliyun",
          delivery: "sent",
        };
      }),
    );

  const verifyPhoneLogin: MossPhoneAccountServiceShape["verifyPhoneLogin"] = (input) =>
    serializeLocalTransition(
      Effect.gen(function* () {
        // A replacement login may win only after any earlier durable logout has
        // fully disabled the managed provider and retired its tombstone.
        yield* finishPendingLogout();
        if (!auth.available) {
          return yield* new MossAccountServiceError({
            code: "authentication_service_unavailable",
            message: "手机号登录服务尚未配置。",
          });
        }
        const normalized = yield* normalizePhoneEffect(input.phoneNumber);
        const challenge =
          (yield* loadChallenges()).find((entry) => entry.challengeId === input.challengeId) ??
          null;
        if (!challenge || challenge.phoneNumber !== normalized.phoneNumber) {
          return yield* new MossAccountServiceError({
            code: "challenge_not_found",
            message: "验证码请求不存在，请重新获取验证码。",
          });
        }
        if (challenge.expiresAt <= now()) {
          yield* consumeChallenge(input.challengeId);
          return yield* new MossAccountServiceError({
            code: "challenge_expired",
            message: "验证码已过期，请重新获取。",
          });
        }
        const challengeGeneration = yield* readChallengeGeneration();
        if (challenge.issuedGeneration !== challengeGeneration) {
          yield* consumeChallenge(input.challengeId);
          return yield* new MossAccountServiceError({
            code: "challenge_not_found",
            message: "验证码请求不存在，请重新获取验证码。",
          });
        }
        const code = input.code.trim();
        if (!/^\d{6}$/u.test(code)) {
          return yield* new MossAccountServiceError({
            code: "invalid_verification_code",
            message: "请输入 6 位短信验证码。",
          });
        }
        const previousStoredSession = yield* readStoredSessionEnvelope();
        const result = yield* Effect.tryPromise({
          try: () => auth.client.verifyPhoneOtp(challenge.phoneNumber, code),
          catch: mapAuthError,
        });
        yield* consumeChallenge(input.challengeId);
        const session = sessionFromAuthResult(result, normalized.phoneNumber, now());
        const stored: StoredPhoneSession = {
          version: 3,
          realm: "memfire-phone",
          issuer: auth.config.issuer,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          accessTokenExpiresAt: result.expiresAt,
          session,
        };
        // Retire the previous managed generation before committing the
        // replacement phone identity. If the process exits after the new
        // session is persisted but before provision completes, the managed
        // reservation is therefore disabled rather than still carrying the
        // previous account's token/runtime.
        yield* clearStoredSessionAndManagedProviderIfNeeded(previousStoredSession.exists);
        yield* persistStoredSession(stored);
        const gatewayStatus = yield* synchronizeManagedProvider(stored, "select").pipe(
          Effect.catch((error) =>
            clearStoredSessionAndManagedProvider().pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );
        return {
          configured: true,
          authenticated: true,
          session,
          smsProvider: "aliyun",
          aliyunSmsConfigured: true,
          ...(gatewayStatus ? { modelGatewayStatus: gatewayStatus } : {}),
          activeRealm: activeRealm ?? undefined,
        } satisfies MossAccountSessionState;
      }),
    );

  const logout: MossPhoneAccountServiceShape["logout"] = () =>
    serializeLocalTransition(
      Effect.gen(function* () {
        const stored = yield* readStoredSession();
        // Persist the retry intent before the remote revocation. A process exit
        // or hung auth request must not lose the fact that local managed state
        // still needs to be disabled.
        yield* ensureLogoutPending();
        const belongsToConfiguredIssuer =
          stored && auth.available
            ? stored.version === 3
              ? stored.issuer === auth.config.issuer
              : legacySessionMatchesConfiguredIssuer(stored, auth.config.issuer)
            : false;
        if (stored && auth.available && belongsToConfiguredIssuer) {
          yield* Effect.tryPromise({
            try: () => auth.client.logout(stored.accessToken),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
        // Even with no phone secret, disable any orphaned managed reservation.
        // An existing tombstone is reused so its generation survives retries.
        yield* finishPendingLogout();
        return { revokedCount: stored ? 1 : 0 };
      }),
    );

  // Recovery is intentionally lazy. The server can expose its typed health
  // route before a slow credential store settles, while getSession, start and
  // verify all cross the same serialized durable logout fence before they can
  // publish or consume account/provider state.
  return {
    getSession,
    getLocalAuthority,
    restoreSession,
    getAccessToken,
    getAuthorityCredential,
    activateRealm,
    startPhoneLogin,
    verifyPhoneLogin,
    logout,
  };
});

export const MossPhoneAccountServiceLive = Layer.effect(
  MossPhoneAccountService,
  makeMossPhoneAccountService(),
);
