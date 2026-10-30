import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  MossAccountActiveRealmState,
  MossAccountSelectRealmInput,
  MossCloudAccount,
  MossCloudAccountId,
  MossCloudAccountSummary,
  MossCloudAccountState,
  MossCloudEmail,
  MossCloudExchangeGoogleOAuthCodeInput,
  MossCloudGoogleAuthorizationUrl,
  MossCloudGoogleOAuthFlowId,
  MossCloudStartGoogleOAuthResult,
} from "@synara/contracts";
import { Duration, Effect, Layer, Schedule, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import {
  makeMossManagedProviderCoordinator,
  readMossLocalAuthorityRevision,
  withMossLocalAuthorityTransition,
  type MossManagedBinding,
} from "../mossAccountLifecycleLock";
import {
  MossCloudAccountService,
  type MossCloudAccountServiceShape,
} from "../Services/MossCloudAccountService";
import { MossManagedProvider } from "../Services/MossManagedProvider";
import { MossCloudAccountServiceError } from "../mossCloudAccountErrors";
import {
  createSupabaseGoogleAuth,
  SupabaseMossAuthError,
  type SupabaseGoogleAuthAvailable,
  type SupabaseGoogleAuthAvailability,
  type SupabaseGoogleAuthClient,
  type SupabaseMossAuthAvailability,
  type SupabaseMossAuthClient,
  type SupabaseMossAuthSession,
  type SupabaseMossAuthUser,
  type SupabaseMossPkceChallenge,
} from "../supabaseMossAuth";
import { mossManagedCodexModelsForLane } from "./MossManagedProvider";
import {
  type FetchMossGatewayModelIds,
  type MossGatewayModelCatalogStatus,
  fetchMossGatewayModelIds,
  normalizeMossGatewayModelCatalog,
} from "../mossGatewayModels";

const SESSION_SECRET_PREFIX = "moss.cloud.session";
const PKCE_SECRET_PREFIX = "moss.cloud.pkce";
const SESSION_REFRESH_SKEW_MS = 5 * 60_000;
const SESSION_MAINTENANCE_INTERVAL = Duration.minutes(1);
const PKCE_TTL_MS = 60 * 60 * 1_000;
const EXCHANGE_IDEMPOTENCY_TTL_MS = 60_000;
const GOOGLE_EXCHANGE_RECEIPT_TTL_MS = PKCE_TTL_MS;
const RECOVERY_AUTHORIZATION_TTL_MS = 15 * 60_000;
// Account state is a local, user-visible read. Provider reconciliation is a
// best-effort side effect and must never hold the RPC open for the lifetime of
// a stalled gateway/provider call.
const DEFAULT_PROVIDER_RECONCILE_TIMEOUT_MS = 5_000;
const PKCE_FLOWS = [
  "signup",
  "recovery",
  "google",
] as const satisfies readonly StoredPkce["flow"][];

type BindingRow = {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly emailVerified: number;
  readonly sessionSecretRef: string;
  readonly selected: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
};

type StoredSessionCommon = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly refreshedAt: string;
  readonly recoveryAuthorizedUntil?: number | undefined;
  readonly needsProviderReconcile?: true | undefined;
};

type StoredSessionV1 = StoredSessionCommon & {
  readonly version: 1;
};

type StoredGoogleExchangeReceipt = {
  readonly version: 1;
  readonly codeHash: string;
  readonly flowIdHash: string;
  readonly expiresAt: number;
};

type StoredSessionV2 = StoredSessionCommon & {
  readonly version: 2;
  readonly realm: "supabase-google";
  readonly issuer: string;
  readonly provider: "google";
  readonly googleExchangeReceipt?: StoredGoogleExchangeReceipt | undefined;
};

type StoredSession = StoredSessionV1 | StoredSessionV2;

type StoredLegacyPkce = {
  readonly version: 1;
  readonly flow: "signup" | "recovery";
  readonly verifier: string;
  readonly createdAt: number;
  readonly expiresAt: number;
};

type StoredGooglePkce = {
  readonly version: 2;
  readonly flow: "google";
  readonly realm: "supabase-google";
  readonly issuer: string;
  readonly flowId: string;
  readonly verifier: string;
  readonly createdAt: number;
  readonly expiresAt: number;
};

type StoredPkce = StoredLegacyPkce | StoredGooglePkce;

type AccountMetadata = {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: "active";
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string;
};

export interface MakeMossCloudAccountServiceOptions {
  /** Legacy auth injection remains test-only; the Live layer always creates Google-only auth. */
  readonly auth?: SupabaseGoogleAuthAvailability | SupabaseMossAuthAvailability;
  readonly now?: () => number;
  /** Database-backed model lineup reader; failures remain explicit degraded readiness. */
  readonly fetchGatewayModels?: FetchMossGatewayModelIds;
  /** Bounds provider reconciliation during getState; primarily injectable for focused tests. */
  readonly providerReconcileTimeoutMs?: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isGoogleAuthAvailable = (
  auth: SupabaseGoogleAuthAvailability | SupabaseMossAuthAvailability,
): auth is SupabaseGoogleAuthAvailable =>
  auth.available && "realm" in auth.config && auth.config.realm === "supabase-google";

const isGoogleIdentity = (user: SupabaseMossAuthUser): boolean => {
  const providers = user.appMetadata.providers;
  return (
    user.emailConfirmedAt !== null &&
    user.appMetadata.provider === "google" &&
    Array.isArray(providers) &&
    providers.length === 1 &&
    providers[0] === "google"
  );
};

const legacyEmailPasswordUnavailable = () =>
  new MossCloudAccountServiceError({
    code: "not_configured",
    message: "Email and password authentication is disabled. Sign in with Google instead.",
  });

const safeIso = (value: string | null | undefined, fallback: string): string => {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
};

const displayNameFrom = (
  user: SupabaseMossAuthUser,
  explicit: string | undefined,
): string | null => {
  const candidates = [
    explicit,
    user.userMetadata.display_name,
    user.userMetadata.full_name,
    user.userMetadata.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized.length > 0 && normalized.length <= 80) return normalized;
  }
  return null;
};

const normalizeEmail = (value: string | null | undefined): string | null => {
  const email = value?.trim().toLowerCase() ?? "";
  return email.length > 0 && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
};

const accountMetadataFromUser = (input: {
  readonly user: SupabaseMossAuthUser;
  readonly fallbackEmail?: string | undefined;
  readonly displayName?: string | undefined;
  readonly now: number;
}): AccountMetadata => {
  const fallbackNow = new Date(input.now).toISOString();
  const email = normalizeEmail(input.user.email) ?? normalizeEmail(input.fallbackEmail);
  if (!email) {
    throw new MossCloudAccountServiceError({
      code: "provider_error",
      message: "The Moss authentication service did not return a valid email account.",
    });
  }
  return {
    accountId: input.user.id,
    email,
    displayName: displayNameFrom(input.user, input.displayName),
    status: "active",
    emailVerified: input.user.emailConfirmedAt !== null,
    createdAt: safeIso(input.user.createdAt, fallbackNow),
    updatedAt: safeIso(input.user.updatedAt, fallbackNow),
    lastUsedAt: safeIso(input.user.lastSignInAt, fallbackNow),
  };
};

const toPersistenceError = (message: string, cause?: unknown) =>
  new MossCloudAccountServiceError({
    code: "persistence_failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export const mapSupabaseMossAuthError = (cause: unknown): MossCloudAccountServiceError => {
  if (!(cause instanceof SupabaseMossAuthError)) {
    return new MossCloudAccountServiceError({
      code: "provider_error",
      message: "The Moss authentication service request failed.",
    });
  }
  if (cause.code === "invalid_credentials") {
    return new MossCloudAccountServiceError({
      code: "invalid_credentials",
      message: "The email or password is incorrect.",
    });
  }
  if (cause.code === "email_not_confirmed") {
    return new MossCloudAccountServiceError({
      code: "email_not_verified",
      message: "Verify the email address before signing in.",
    });
  }
  if (
    cause.code === "refresh_token_not_found" ||
    cause.code === "refresh_token_already_used" ||
    cause.code === "session_expired" ||
    cause.code === "session_not_found" ||
    cause.code === "bad_jwt"
  ) {
    return new MossCloudAccountServiceError({
      code: "session_expired",
      message: "The Moss account session expired. Sign in again.",
    });
  }
  if (cause.code === "user_banned") {
    return new MossCloudAccountServiceError({
      code: "account_disabled",
      message: "This Moss account is disabled.",
    });
  }
  if (cause.status === 429 || cause.code.startsWith("over_")) {
    return new MossCloudAccountServiceError({
      code: "rate_limited",
      message: "Too many authentication requests. Try again later.",
    });
  }
  if (cause.code === "network_error" || cause.retryable) {
    return new MossCloudAccountServiceError({
      code: "network_error",
      message: "The Moss authentication service is temporarily unavailable.",
    });
  }
  return new MossCloudAccountServiceError({
    code: "provider_error",
    message: cause.message,
  });
};

const sessionSecretName = (accountId: string): string =>
  `${SESSION_SECRET_PREFIX}.${createHash("sha256").update(accountId).digest("hex")}`;

const pkceSecretName = (flow: StoredPkce["flow"]): string => `${PKCE_SECRET_PREFIX}.${flow}`;

const googleExchangeReceiptHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const secureStringsMatch = (expected: string, received: string): boolean => {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
};

const isStoredGoogleExchangeReceipt = (value: unknown): value is StoredGoogleExchangeReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    receipt.version === 1 &&
    typeof receipt.codeHash === "string" &&
    /^[a-f0-9]{64}$/u.test(receipt.codeHash) &&
    typeof receipt.flowIdHash === "string" &&
    /^[a-f0-9]{64}$/u.test(receipt.flowIdHash) &&
    typeof receipt.expiresAt === "number" &&
    Number.isFinite(receipt.expiresAt)
  );
};

const makeGoogleExchangeReceipt = (
  input: MossCloudExchangeGoogleOAuthCodeInput,
  timestamp: number,
): StoredGoogleExchangeReceipt => ({
  version: 1,
  codeHash: googleExchangeReceiptHash(input.code),
  flowIdHash: googleExchangeReceiptHash(input.flowId),
  expiresAt: timestamp + GOOGLE_EXCHANGE_RECEIPT_TTL_MS,
});

const matchesGoogleExchangeReceipt = (
  session: StoredSession,
  input: MossCloudExchangeGoogleOAuthCodeInput,
  timestamp: number,
): boolean => {
  if (session.version !== 2) return false;
  const receipt = session.googleExchangeReceipt;
  return (
    receipt !== undefined &&
    receipt.expiresAt > timestamp &&
    secureStringsMatch(receipt.codeHash, googleExchangeReceiptHash(input.code)) &&
    secureStringsMatch(receipt.flowIdHash, googleExchangeReceiptHash(input.flowId))
  );
};

const isStoredSession = (value: unknown): value is StoredSession => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  const commonValid =
    typeof session.accessToken === "string" &&
    session.accessToken.length > 0 &&
    typeof session.refreshToken === "string" &&
    session.refreshToken.length > 0 &&
    typeof session.expiresAt === "number" &&
    Number.isFinite(session.expiresAt) &&
    typeof session.refreshedAt === "string" &&
    Number.isFinite(Date.parse(session.refreshedAt)) &&
    (session.recoveryAuthorizedUntil === undefined ||
      (typeof session.recoveryAuthorizedUntil === "number" &&
        Number.isFinite(session.recoveryAuthorizedUntil))) &&
    (session.needsProviderReconcile === undefined || session.needsProviderReconcile === true);
  if (!commonValid) return false;
  if (session.version === 1) return true;
  return (
    session.version === 2 &&
    session.realm === "supabase-google" &&
    typeof session.issuer === "string" &&
    session.issuer.length > 0 &&
    session.provider === "google" &&
    (session.googleExchangeReceipt === undefined ||
      isStoredGoogleExchangeReceipt(session.googleExchangeReceipt))
  );
};

const isStoredPkce = (value: unknown): value is StoredPkce => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pkce = value as Record<string, unknown>;
  const commonValid =
    typeof pkce.verifier === "string" &&
    pkce.verifier.length >= 43 &&
    typeof pkce.createdAt === "number" &&
    Number.isFinite(pkce.createdAt) &&
    typeof pkce.expiresAt === "number" &&
    Number.isFinite(pkce.expiresAt);
  if (!commonValid) return false;
  return (
    (pkce.version === 1 && (pkce.flow === "signup" || pkce.flow === "recovery")) ||
    (pkce.version === 2 &&
      pkce.flow === "google" &&
      pkce.realm === "supabase-google" &&
      typeof pkce.issuer === "string" &&
      pkce.issuer.length > 0 &&
      typeof pkce.flowId === "string" &&
      pkce.flowId.length >= 32 &&
      pkce.flowId.length <= 512 &&
      /^[A-Za-z0-9._~-]+$/u.test(pkce.flowId))
  );
};

const withoutRecoveryAuthorization = (session: StoredSession): StoredSession => {
  const { recoveryAuthorizedUntil: _recoveryAuthorizedUntil, ...rest } = session;
  return rest as StoredSession;
};

const withoutProviderReconcile = (session: StoredSession): StoredSession => {
  const { needsProviderReconcile: _needsProviderReconcile, ...rest } = session;
  return rest as StoredSession;
};

const withProviderReconcile = (session: StoredSession): StoredSession =>
  session.needsProviderReconcile ? session : { ...session, needsProviderReconcile: true };

const stateAccount = (row: BindingRow): MossCloudAccount => ({
  id: row.accountId as MossCloudAccountId,
  email: row.email as MossCloudEmail,
  emailVerified: row.emailVerified === 1,
  displayName: row.displayName,
  status: row.status === "disabled" || row.status === "revoked" ? row.status : "active",
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastLoginAt: row.lastUsedAt,
});

const makePkce = (
  now: number,
  flow: StoredLegacyPkce["flow"],
): {
  readonly stored: StoredLegacyPkce;
  readonly challenge: SupabaseMossPkceChallenge;
} => {
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    stored: {
      version: 1,
      flow,
      verifier,
      createdAt: now,
      expiresAt: now + PKCE_TTL_MS,
    },
    challenge: { codeChallenge, codeChallengeMethod: "s256" },
  };
};

const makeGooglePkce = (
  now: number,
  issuer: string,
): {
  readonly stored: StoredGooglePkce;
  readonly challenge: SupabaseMossPkceChallenge;
} => {
  const verifier = randomBytes(32).toString("base64url");
  const flowId = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    stored: {
      version: 2,
      flow: "google",
      realm: "supabase-google",
      issuer,
      flowId,
      verifier,
      createdAt: now,
      expiresAt: now + PKCE_TTL_MS,
    },
    challenge: { codeChallenge, codeChallengeMethod: "s256" },
  };
};

const flowIdsMatch = secureStringsMatch;

export const makeMossCloudAccountService = (options: MakeMossCloudAccountServiceOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secretStore = yield* ServerSecretStore;
    const managedProvider = yield* MossManagedProvider;
    const managedProviderCoordinator = makeMossManagedProviderCoordinator(
      secretStore,
      managedProvider,
    );
    const semaphore = yield* Semaphore.make(1);
    const auth = options.auth ?? createSupabaseGoogleAuth();
    const now = options.now ?? Date.now;
    const fetchGatewayModels = options.fetchGatewayModels ?? fetchMossGatewayModelIds;
    const providerReconcileTimeoutMs =
      options.providerReconcileTimeoutMs ?? DEFAULT_PROVIDER_RECONCILE_TIMEOUT_MS;
    let managedBinding: MossManagedBinding | null = null;
    let modelGatewayStatus: MossGatewayModelCatalogStatus | undefined;
    let activeRealm: "global" | null = null;
    const successfulExchanges = new Map<
      string,
      {
        readonly accountId: string;
        readonly flow: StoredPkce["flow"];
        readonly expiresAt: number;
      }
    >();

    const requireSessionClient = () =>
      auth.available
        ? Effect.succeed(auth.client)
        : Effect.fail(
            new MossCloudAccountServiceError({
              code: "not_configured",
              message: "Moss account authentication is not configured on this server.",
            }),
          );

    const requireGoogleClient = () =>
      isGoogleAuthAvailable(auth)
        ? Effect.succeed(auth.client)
        : Effect.fail(legacyEmailPasswordUnavailable());

    const requireLegacyClient = () =>
      auth.available && !isGoogleAuthAvailable(auth)
        ? Effect.succeed(auth.client)
        : Effect.fail(legacyEmailPasswordUnavailable());

    /**
     * A stored bearer is routable only through the exact authority that issued it. Legacy
     * email/password sessions deliberately remain parseable so they can be removed locally, but a
     * Google-only production service must never refresh, revoke, or provision from those tokens.
     */
    const isCurrentAuthoritySession = (session: StoredSession): boolean =>
      !isGoogleAuthAvailable(auth) ||
      (session.version === 2 &&
        session.realm === "supabase-google" &&
        session.issuer === auth.config.issuer &&
        session.provider === "google");

    const provisionManagedProvider = (input: {
      readonly accessToken: string;
      readonly gatewayBaseUrl: string;
      readonly models: ReadonlyArray<string>;
      readonly selectionPolicy: "select" | "preserve";
    }) =>
      managedProviderCoordinator
        .provision({
          authority: "supabase-google",
          accessToken: input.accessToken,
          gatewayBaseUrl: input.gatewayBaseUrl,
          models: [...input.models],
          selectionPolicy: input.selectionPolicy,
        })
        .pipe(
          Effect.tap((binding) =>
            Effect.sync(() => {
              managedBinding = binding;
              activeRealm = "global";
            }),
          ),
          Effect.mapError((cause) =>
            cause instanceof MossCloudAccountServiceError
              ? cause
              : toPersistenceError("Failed to reconcile the Moss managed provider.", cause),
          ),
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
                authority: "supabase-google" as const,
                accessToken: input.expectedAccessToken,
              }
            : undefined;
      return managedProviderCoordinator
        .release({
          authority: "supabase-google",
          ...(expected
            ? {
                expected: expected as MossManagedBinding,
              }
            : {}),
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
                    activeRealm = null;
                  }
                })
              : Effect.void,
          ),
          Effect.flatMap((released) =>
            released
              ? Effect.void
              : Effect.fail(new Error("Managed provider release proof did not match.")),
          ),
          Effect.mapError((cause) =>
            cause instanceof MossCloudAccountServiceError
              ? cause
              : toPersistenceError("Failed to fence the Moss managed provider.", cause),
          ),
        );
    };

    const loadSelectedBinding = () =>
      sql<BindingRow>`
        SELECT
          account_id AS "accountId",
          email AS "email",
          display_name AS "displayName",
          status AS "status",
          email_verified AS "emailVerified",
          session_secret_ref AS "sessionSecretRef",
          selected AS "selected",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_used_at AS "lastUsedAt"
        FROM moss_cloud_account_bindings
        WHERE selected = 1
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError((cause) =>
          toPersistenceError("Failed to load the selected Moss account.", cause),
        ),
      );

    const loadBindingByAccountId = (accountId: string) =>
      sql<BindingRow>`
        SELECT
          account_id AS "accountId", email AS "email", display_name AS "displayName",
          status AS "status", email_verified AS "emailVerified",
          session_secret_ref AS "sessionSecretRef", selected AS "selected",
          created_at AS "createdAt", updated_at AS "updatedAt", last_used_at AS "lastUsedAt"
        FROM moss_cloud_account_bindings
        WHERE account_id = ${accountId}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError((cause) =>
          toPersistenceError("Failed to load the Moss account metadata.", cause),
        ),
      );

    const loadBindingByEmail = (email: string) =>
      sql<BindingRow>`
        SELECT
          account_id AS "accountId", email AS "email", display_name AS "displayName",
          status AS "status", email_verified AS "emailVerified",
          session_secret_ref AS "sessionSecretRef", selected AS "selected",
          created_at AS "createdAt", updated_at AS "updatedAt", last_used_at AS "lastUsedAt"
        FROM moss_cloud_account_bindings
        WHERE lower(email) = lower(${email})
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError((cause) =>
          toPersistenceError("Failed to load the Moss account email binding.", cause),
        ),
      );

    const loadAllBindings = () =>
      sql<BindingRow>`
        SELECT
          account_id AS "accountId", email AS "email", display_name AS "displayName",
          status AS "status", email_verified AS "emailVerified",
          session_secret_ref AS "sessionSecretRef", selected AS "selected",
          created_at AS "createdAt", updated_at AS "updatedAt", last_used_at AS "lastUsedAt"
        FROM moss_cloud_account_bindings
        ORDER BY selected DESC, last_used_at DESC, updated_at DESC, lower(email) ASC
      `.pipe(
        Effect.mapError((cause) =>
          toPersistenceError("Failed to list the saved Moss accounts.", cause),
        ),
      );

    const readStoredSession = (secretRef: string, readOnly = false) =>
      secretStore.get(secretRef).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("Failed to restore the Moss account session.", cause),
        ),
        Effect.flatMap((bytes) => {
          if (!bytes) return Effect.succeed<StoredSession | null>(null);
          return Effect.try({
            try: () => {
              const decoded = JSON.parse(textDecoder.decode(bytes)) as unknown;
              if (!isStoredSession(decoded)) throw new Error("invalid session envelope");
              if (
                isGoogleAuthAvailable(auth) &&
                (decoded.version !== 2 ||
                  decoded.realm !== "supabase-google" ||
                  decoded.issuer !== auth.config.issuer ||
                  decoded.provider !== "google")
              ) {
                throw new Error("session authority mismatch");
              }
              if (!isGoogleAuthAvailable(auth) && decoded.version !== 1) {
                throw new Error("session authority mismatch");
              }
              return decoded;
            },
            catch: () =>
              toPersistenceError("The stored Moss account session is invalid and must be reset."),
          });
        }),
        Effect.flatMap((session) => {
          if (
            readOnly ||
            !session ||
            session.recoveryAuthorizedUntil === undefined ||
            session.recoveryAuthorizedUntil > now()
          ) {
            return Effect.succeed(session);
          }
          const cleared = withoutRecoveryAuthorization(session);
          return secretStore.set(secretRef, textEncoder.encode(JSON.stringify(cleared))).pipe(
            Effect.mapError((cause) =>
              toPersistenceError(
                "Failed to expire the Moss password recovery authorization.",
                cause,
              ),
            ),
            Effect.as(cleared),
          );
        }),
      );

    // Snapshot reads are used only by the timeout fallback. They must never
    // expire recovery metadata, clear a malformed session, or otherwise write
    // while an account mutation may still be committing a newer session.
    const readStoredSessionSnapshot = (secretRef: string) =>
      secretStore.get(secretRef).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("Failed to read the Moss account session snapshot.", cause),
        ),
        Effect.flatMap((bytes) => {
          if (!bytes) return Effect.succeed<StoredSession | null>(null);
          return Effect.try({
            try: () => {
              const decoded = JSON.parse(textDecoder.decode(bytes)) as unknown;
              if (!isStoredSession(decoded)) throw new Error("invalid session envelope");
              if (
                isGoogleAuthAvailable(auth) &&
                (decoded.version !== 2 ||
                  decoded.realm !== "supabase-google" ||
                  decoded.issuer !== auth.config.issuer ||
                  decoded.provider !== "google")
              ) {
                throw new Error("session authority mismatch");
              }
              if (!isGoogleAuthAvailable(auth) && decoded.version !== 1) {
                throw new Error("session authority mismatch");
              }
              return decoded;
            },
            catch: () => null,
          });
        }),
        Effect.catch(() => Effect.succeed<StoredSession | null>(null)),
      );

    const accountState = (
      row: BindingRow | null,
      session: StoredSession | null,
    ): MossCloudAccountState => ({
      configured: auth.available,
      authenticated: row !== null && session !== null,
      account: row ? stateAccount(row) : null,
      session:
        row && session
          ? {
              accountId: row.accountId as MossCloudAccountId,
              expiresAt: new Date(session.expiresAt).toISOString(),
              refreshedAt: session.refreshedAt,
            }
          : null,
      emailVerificationRequired: row !== null && row.emailVerified !== 1 && session === null,
      modelGatewayConfigured: auth.available && auth.config.modelGatewayUrl !== null,
      authProvider: "supabase_google",
      ...(row && session && modelGatewayStatus ? { modelGatewayStatus } : {}),
      ...(activeRealm ? { activeRealm } : {}),
      lastAuthFlow:
        session?.recoveryAuthorizedUntil !== undefined && session.recoveryAuthorizedUntil > now()
          ? "recovery"
          : null,
    });

    const accountSummary = (
      row: BindingRow,
      sessionAvailable: boolean,
    ): MossCloudAccountSummary => ({
      id: row.accountId as MossCloudAccountId,
      email: row.email as MossCloudEmail,
      emailVerified: row.emailVerified === 1,
      displayName: row.displayName,
      status: row.status === "disabled" || row.status === "revoked" ? row.status : "active",
      lastUsedAt: row.lastUsedAt,
      selected: row.selected === 1,
      sessionAvailable,
    });

    const upsertBindingRow = (row: BindingRow, selected: 0 | 1) => sql`
      INSERT INTO moss_cloud_account_bindings (
        account_id, email, display_name, status, email_verified,
        session_secret_ref, selected, created_at, updated_at, last_used_at
      ) VALUES (
        ${row.accountId}, ${row.email}, ${row.displayName}, ${row.status}, ${row.emailVerified},
        ${row.sessionSecretRef}, ${selected}, ${row.createdAt}, ${row.updatedAt}, ${row.lastUsedAt}
      )
      ON CONFLICT(account_id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        status = excluded.status,
        email_verified = excluded.email_verified,
        session_secret_ref = excluded.session_secret_ref,
        selected = excluded.selected,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at
    `;

    const persistBinding = (input: {
      readonly metadata: AccountMetadata;
      readonly sessionSecretRef: string;
    }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // A verified Supabase session is authoritative for a recreated account whose
            // email still points at a stale local UUID.
            yield* sql`
              DELETE FROM moss_cloud_account_bindings
              WHERE lower(email) = lower(${input.metadata.email})
                AND account_id <> ${input.metadata.accountId}
            `;
            yield* sql`UPDATE moss_cloud_account_bindings SET selected = 0 WHERE selected = 1`;
            yield* sql`
              INSERT INTO moss_cloud_account_bindings (
                account_id, email, display_name, status, email_verified,
                session_secret_ref, selected, created_at, updated_at, last_used_at
              ) VALUES (
                ${input.metadata.accountId}, ${input.metadata.email}, ${input.metadata.displayName},
                ${input.metadata.status}, ${input.metadata.emailVerified ? 1 : 0},
                ${input.sessionSecretRef}, 1, ${input.metadata.createdAt},
                ${input.metadata.updatedAt}, ${input.metadata.lastUsedAt}
              )
              ON CONFLICT(account_id) DO UPDATE SET
                email = excluded.email,
                display_name = COALESCE(excluded.display_name, moss_cloud_account_bindings.display_name),
                status = excluded.status,
                email_verified = excluded.email_verified,
                session_secret_ref = excluded.session_secret_ref,
                selected = 1,
                updated_at = excluded.updated_at,
                last_used_at = excluded.last_used_at
            `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            toPersistenceError("Failed to persist the Moss account metadata.", cause),
          ),
          Effect.asVoid,
        );

    const restoreBindingSnapshot = (input: {
      readonly targetAccountId: string;
      readonly previouslySelected: BindingRow | null;
      readonly targetBefore: BindingRow | null;
      readonly emailCollisionBefore: BindingRow | null;
    }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE moss_cloud_account_bindings SET selected = 0 WHERE selected = 1`;
            yield* sql`
              DELETE FROM moss_cloud_account_bindings
              WHERE account_id = ${input.targetAccountId}
            `;
            if (input.targetBefore) yield* upsertBindingRow(input.targetBefore, 0);
            if (
              input.emailCollisionBefore &&
              input.emailCollisionBefore.accountId !== input.targetBefore?.accountId
            ) {
              yield* upsertBindingRow(input.emailCollisionBefore, 0);
            }
            if (input.previouslySelected) {
              yield* sql`
                UPDATE moss_cloud_account_bindings
                SET selected = 1
                WHERE account_id = ${input.previouslySelected.accountId}
              `;
            }
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            toPersistenceError("Failed to restore the previous Moss account metadata.", cause),
          ),
          Effect.asVoid,
        );

    const restoreSecretValue = (secretRef: string, value: Uint8Array | null) =>
      (value ? secretStore.set(secretRef, value) : secretStore.remove(secretRef)).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("Failed to restore a previous Moss account session.", cause),
        ),
      );

    const restoreManagedProvider = (
      session: StoredSession | null,
      selectionPolicy: "select" | "preserve",
      previousAccessToken?: string,
    ): Effect.Effect<"ready" | "deferred", MossCloudAccountServiceError> => {
      const gatewayBaseUrl = auth.available ? auth.config.modelGatewayUrl : undefined;
      if (!gatewayBaseUrl || !session || !isCurrentAuthoritySession(session)) {
        return releaseManagedProvider({
          expectedAccessToken: session?.accessToken,
          force: true,
        }).pipe(Effect.as("deferred" as const));
      }

      const provision = fetchGatewayModels({
        gatewayBaseUrl,
        accessToken: session.accessToken,
      }).pipe(
        Effect.flatMap((rawCatalog) => {
          const catalog = normalizeMossGatewayModelCatalog(rawCatalog);
          const status = catalog.status;
          return Effect.sync(() => {
            modelGatewayStatus = status;
          }).pipe(
            Effect.andThen(
              catalog.status === "ready"
                ? provisionManagedProvider({
                    accessToken: session.accessToken,
                    gatewayBaseUrl,
                    // The regional `/v1/models` response is an entitlement
                    // hint and can lag the managed OpenRouter catalog while
                    // a deployment is rolling out.  Provision the canonical
                    // realm lineup so an old response can never collapse the
                    // desktop picker to a stale subset of models.
                    models: [...mossManagedCodexModelsForLane("global")],
                    selectionPolicy,
                  })
                : selectionPolicy === "select"
                  ? releaseManagedProvider({
                      expectedAccessToken: previousAccessToken,
                      force: true,
                    }).pipe(Effect.asVoid)
                  : Effect.void,
            ),
            Effect.as(catalog.status === "ready" ? ("ready" as const) : ("deferred" as const)),
          );
        }),
      );
      if (selectionPolicy === "select") return provision;

      return managedProviderCoordinator
        .getReconcileState({
          authority: "supabase-google",
          accessToken: session.accessToken,
          gatewayBaseUrl,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof MossCloudAccountServiceError
              ? cause
              : toPersistenceError("Failed to verify the Moss managed provider binding.", cause),
          ),
          Effect.flatMap((state) => {
            switch (state) {
              case "current":
                return Effect.sync(() => (activeRealm = "global")).pipe(
                  Effect.as("ready" as const),
                );
              case "owned-by-other":
                return Effect.sync(() => (activeRealm = null)).pipe(Effect.as("deferred" as const));
              case "same-authority-stale":
              case "missing":
                return provision;
              case "collision":
                return Effect.fail(
                  new MossCloudAccountServiceError({
                    code: "provider_error",
                    message: "The reserved Moss provider conflicts with a local provider.",
                  }),
                );
            }
          }),
        );
    };

    const reconcileManagedProvider = (
      row: BindingRow,
      session: StoredSession,
      selectionPolicy: "select" | "preserve" = "preserve",
    ) =>
      Effect.gen(function* () {
        const outcome = yield* restoreManagedProvider(session, selectionPolicy);
        const reconciled =
          outcome === "ready" ? withoutProviderReconcile(session) : withProviderReconcile(session);
        const markerChanged =
          (outcome === "ready" && session.needsProviderReconcile === true) ||
          (outcome === "deferred" && session.needsProviderReconcile !== true);
        if (markerChanged) {
          yield* secretStore
            .set(row.sessionSecretRef, textEncoder.encode(JSON.stringify(reconciled)))
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to persist the reconciled Moss provider state.", cause),
              ),
            );
        }
        return reconciled;
      });

    const markProviderReconcilePending = (row: BindingRow, session: StoredSession) => {
      const pending = withProviderReconcile(session);
      return secretStore
        .set(row.sessionSecretRef, textEncoder.encode(JSON.stringify(pending)))
        .pipe(
          Effect.mapError((cause) =>
            toPersistenceError(
              "Failed to persist the pending Moss provider reconciliation.",
              cause,
            ),
          ),
          Effect.as(pending),
        );
    };

    // Keep state reads responsive when another account mutation owns the
    // serializer while waiting on a provider. This path performs local reads
    // only and never claims that provider reconciliation succeeded.
    const readAccountStateWithoutLock = () =>
      Effect.gen(function* () {
        if (!auth.available) return accountState(null, null);
        const selected = yield* loadSelectedBinding();
        if (!selected) return accountState(null, null);
        const stored = yield* readStoredSessionSnapshot(selected.sessionSecretRef);
        if (!stored) {
          return selected.emailVerified === 1
            ? accountState(null, null)
            : accountState(selected, null);
        }
        if (!isCurrentAuthoritySession(stored)) return accountState(null, null);
        // This fallback may run after a concurrent refresh/sign-in has
        // replaced the protected session. It must remain strictly read-only:
        // writing a retry marker here could resurrect the stale token that we
        // just read and overwrite the newer session.
        // This snapshot is returned because live reconciliation timed out. A
        // prior `ready` value must not survive as evidence for this read.
        modelGatewayStatus = "transport-degraded";
        return accountState(selected, stored);
      });

    const persistSession = (input: {
      readonly session: SupabaseMossAuthSession;
      readonly fallbackEmail?: string | undefined;
      readonly displayName?: string | undefined;
      readonly selectionPolicy: "select" | "preserve";
      readonly recoveryAuthorizedUntil?: number | undefined;
      readonly googleExchangeReceipt?: StoredGoogleExchangeReceipt | undefined;
    }) =>
      Effect.gen(function* () {
        const timestamp = now();
        if (isGoogleAuthAvailable(auth) && !isGoogleIdentity(input.session.user)) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "provider_error",
              message: "The Supabase session was not issued for a Google identity.",
            }),
          );
        }
        const metadata = accountMetadataFromUser({
          user: input.session.user,
          fallbackEmail: input.fallbackEmail,
          displayName: input.displayName,
          now: timestamp,
        });
        const previouslySelected = yield* loadSelectedBinding();
        const secretRef = sessionSecretName(metadata.accountId);
        const targetBefore = yield* loadBindingByAccountId(metadata.accountId);
        const emailBindingBefore = yield* loadBindingByEmail(metadata.email);
        const emailCollisionBefore =
          emailBindingBefore && emailBindingBefore.accountId !== metadata.accountId
            ? emailBindingBefore
            : null;
        const previousSession = previouslySelected
          ? yield* readStoredSession(previouslySelected.sessionSecretRef)
          : null;
        const secretSnapshots = new Map<string, Uint8Array | null>();
        for (const ref of new Set(
          [
            secretRef,
            previouslySelected?.sessionSecretRef,
            emailCollisionBefore?.sessionSecretRef,
          ].filter((value): value is string => value !== undefined),
        )) {
          const value = yield* secretStore
            .get(ref)
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to back up a Moss account session.", cause),
              ),
            );
          secretSnapshots.set(ref, value);
        }
        const retainRotatedTargetSession = targetBefore?.sessionSecretRef === secretRef;
        const commonStored = {
          accessToken: input.session.accessToken,
          refreshToken: input.session.refreshToken,
          expiresAt: input.session.expiresAt,
          refreshedAt: new Date(timestamp).toISOString(),
          needsProviderReconcile: true as const,
          ...(input.recoveryAuthorizedUntil !== undefined &&
          input.recoveryAuthorizedUntil > timestamp
            ? { recoveryAuthorizedUntil: input.recoveryAuthorizedUntil }
            : {}),
        };
        const stored: StoredSession = isGoogleAuthAvailable(auth)
          ? {
              ...commonStored,
              version: 2,
              realm: "supabase-google",
              issuer: auth.config.issuer,
              provider: "google",
              ...(input.googleExchangeReceipt
                ? { googleExchangeReceipt: input.googleExchangeReceipt }
                : {}),
            }
          : { ...commonStored, version: 1 };
        const mutatedSecretRefs = new Set<string>();
        if (!retainRotatedTargetSession) mutatedSecretRefs.add(secretRef);
        let bindingPersisted = false;
        let providerMutationStarted = false;
        let storedForState = stored;

        const persist = Effect.gen(function* () {
          yield* secretStore
            .set(secretRef, textEncoder.encode(JSON.stringify(stored)))
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to protect the Moss account session.", cause),
              ),
            );
          yield* persistBinding({ metadata, sessionSecretRef: secretRef });
          bindingPersisted = true;
          const row = yield* loadSelectedBinding();
          if (!row || row.accountId !== metadata.accountId) {
            return yield* Effect.fail(
              toPersistenceError("Failed to select the persisted Moss account session."),
            );
          }
          providerMutationStarted = true;
          const providerOutcome = yield* restoreManagedProvider(stored, input.selectionPolicy);
          storedForState =
            providerOutcome === "ready"
              ? withoutProviderReconcile(stored)
              : withProviderReconcile(stored);
          yield* secretStore
            .set(secretRef, textEncoder.encode(JSON.stringify(storedForState)))
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to persist the reconciled Moss provider state.", cause),
              ),
            );
          if (
            previouslySelected &&
            previouslySelected.accountId !== metadata.accountId &&
            previousSession?.recoveryAuthorizedUntil !== undefined &&
            previouslySelected.sessionSecretRef !== emailCollisionBefore?.sessionSecretRef
          ) {
            mutatedSecretRefs.add(previouslySelected.sessionSecretRef);
            yield* secretStore
              .set(
                previouslySelected.sessionSecretRef,
                textEncoder.encode(JSON.stringify(withoutRecoveryAuthorization(previousSession))),
              )
              .pipe(
                Effect.mapError((cause) =>
                  toPersistenceError(
                    "Failed to clear the previous Moss password recovery authorization.",
                    cause,
                  ),
                ),
              );
          }
          if (emailCollisionBefore) {
            mutatedSecretRefs.add(emailCollisionBefore.sessionSecretRef);
            yield* secretStore
              .remove(emailCollisionBefore.sessionSecretRef)
              .pipe(
                Effect.mapError((cause) =>
                  toPersistenceError("Failed to remove a stale Moss account session.", cause),
                ),
              );
          }
          return accountState(row, storedForState);
        });

        return yield* persist.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failures: MossCloudAccountServiceError[] = [];
              for (const ref of mutatedSecretRefs) {
                yield* restoreSecretValue(ref, secretSnapshots.get(ref) ?? null).pipe(
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                    }),
                  ),
                );
              }
              if (bindingPersisted) {
                yield* restoreBindingSnapshot({
                  targetAccountId: metadata.accountId,
                  previouslySelected,
                  targetBefore,
                  emailCollisionBefore,
                }).pipe(
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                    }),
                  ),
                );
              }
              if (providerMutationStarted) {
                const providerSession =
                  previouslySelected?.accountId === metadata.accountId ? stored : previousSession;
                const restoredProvider = yield* restoreManagedProvider(
                  providerSession,
                  input.selectionPolicy,
                ).pipe(
                  Effect.as(true),
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                      return false;
                    }),
                  ),
                );
                if (restoredProvider && previouslySelected?.accountId === metadata.accountId) {
                  yield* secretStore
                    .set(
                      secretRef,
                      textEncoder.encode(JSON.stringify(withoutProviderReconcile(stored))),
                    )
                    .pipe(
                      Effect.mapError((cause) =>
                        toPersistenceError(
                          "Failed to persist the reconciled Moss provider state.",
                          cause,
                        ),
                      ),
                      Effect.catch((failure) =>
                        Effect.sync(() => {
                          failures.push(failure);
                        }),
                      ),
                    );
                }
              }
              const rollbackFailure = failures[0];
              if (rollbackFailure) return yield* Effect.fail(rollbackFailure);
              return yield* Effect.fail(error);
            }),
          ),
        );
      });

    const stateAfterPendingSignup = (input: {
      readonly user: SupabaseMossAuthUser;
      readonly fallbackEmail: string;
      readonly displayName?: string | undefined;
    }) =>
      Effect.gen(function* () {
        // Supabase may intentionally return an obfuscated user for duplicate signup.
        // A no-session response therefore cannot authorize local identity replacement.
        void input;
        const selected = yield* loadSelectedBinding();
        if (!selected) return accountState(null, null);
        const stored = yield* readStoredSession(selected.sessionSecretRef).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        return accountState(selected, stored);
      });

    const clearSelectedSession = () =>
      Effect.gen(function* () {
        // Gateway readiness is bound to the selected session generation.
        modelGatewayStatus = undefined;
        const failures: MossCloudAccountServiceError[] = [];
        const selected = yield* loadSelectedBinding().pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push(error);
              return null;
            }),
          ),
        );
        let selectedSession: StoredSession | null = null;
        if (selected) {
          selectedSession = yield* readStoredSession(selected.sessionSecretRef).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          yield* secretStore.remove(selected.sessionSecretRef).pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to clear the Moss account session.", cause),
            ),
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(error);
              }),
            ),
          );
        }
        yield* sql`
          UPDATE moss_cloud_account_bindings
          SET selected = 0, updated_at = ${new Date(now()).toISOString()}
          WHERE selected = 1
        `.pipe(
          Effect.mapError((cause) =>
            toPersistenceError("Failed to clear the selected Moss account.", cause),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push(error);
            }),
          ),
        );
        yield* releaseManagedProvider({
          expectedAccessToken: selectedSession?.accessToken,
          force: true,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push(error);
            }),
          ),
        );
        const failure = failures[0];
        if (failure) {
          return yield* Effect.fail(failure);
        }
      }).pipe((effect) => withMossLocalAuthorityTransition(secretStore, effect));

    const failClosedSession = <A>(
      error: MossCloudAccountServiceError,
    ): Effect.Effect<A, MossCloudAccountServiceError> =>
      clearSelectedSession().pipe(Effect.flatMap(() => Effect.fail(error)));

    const clearMissingVerifiedSession = (selected: BindingRow) =>
      selected.emailVerified === 1
        ? clearSelectedSession()
        : releaseManagedProvider({ force: true });

    const refreshSelected = (force: boolean) =>
      Effect.gen(function* () {
        const client = yield* requireSessionClient();
        const selected = yield* loadSelectedBinding();
        if (!selected) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "Sign in to a Moss account first.",
            }),
          );
        }
        const stored = yield* readStoredSession(selected.sessionSecretRef).pipe(
          Effect.catch((error) => failClosedSession<StoredSession | null>(error)),
        );
        if (!stored) {
          yield* clearMissingVerifiedSession(selected);
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "Sign in to the Moss account again.",
            }),
          );
        }
        if (!isCurrentAuthoritySession(stored)) {
          return yield* failClosedSession<{ selected: BindingRow; stored: StoredSession }>(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "Sign in with Google to continue.",
            }),
          );
        }
        if (!force && stored.expiresAt > now() + SESSION_REFRESH_SKEW_MS) {
          return { selected, stored };
        }
        const refreshed = yield* Effect.tryPromise({
          try: () => client.refresh(stored.refreshToken),
          catch: mapSupabaseMossAuthError,
        }).pipe(
          Effect.catch((error) =>
            error.code === "session_expired" || error.code === "authentication_required"
              ? clearSelectedSession().pipe(Effect.flatMap(() => Effect.fail(error)))
              : Effect.fail(error),
          ),
        );
        if (refreshed.user.id !== selected.accountId) {
          return yield* failClosedSession<{ selected: BindingRow; stored: StoredSession }>(
            new MossCloudAccountServiceError({
              code: "provider_error",
              message: "The refreshed Moss session does not match the selected account.",
            }),
          );
        }
        const state = yield* persistSession({
          session: refreshed,
          fallbackEmail: selected.email,
          selectionPolicy: "preserve",
          recoveryAuthorizedUntil: stored.recoveryAuthorizedUntil,
          ...(stored.version === 2 && stored.googleExchangeReceipt
            ? { googleExchangeReceipt: stored.googleExchangeReceipt }
            : {}),
        });
        const nextSelected = yield* loadSelectedBinding();
        const nextStored = nextSelected
          ? yield* readStoredSession(nextSelected.sessionSecretRef)
          : null;
        if (!state.authenticated || !nextSelected || !nextStored) {
          return yield* Effect.fail(
            toPersistenceError("Failed to restore the refreshed Moss account session."),
          );
        }
        return { selected: nextSelected, stored: nextStored };
      });

    const writePkce = (flow: StoredLegacyPkce["flow"]) =>
      Effect.gen(function* () {
        const value = makePkce(now(), flow);
        yield* secretStore
          .set(pkceSecretName(flow), textEncoder.encode(JSON.stringify(value.stored)))
          .pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to protect the Moss authentication verifier.", cause),
            ),
          );
        return value.challenge;
      });

    const writeGooglePkce = (issuer: string) =>
      Effect.gen(function* () {
        const value = makeGooglePkce(now(), issuer);
        yield* secretStore
          .set(pkceSecretName("google"), textEncoder.encode(JSON.stringify(value.stored)))
          .pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to protect the Google authentication verifier.", cause),
            ),
          );
        return value;
      });

    const clearPkceVerifier = (flow: StoredPkce["flow"]) =>
      secretStore
        .remove(pkceSecretName(flow))
        .pipe(
          Effect.mapError((cause) =>
            toPersistenceError("Failed to clear the Moss authentication verifier.", cause),
          ),
        );

    const clearAllPkceVerifiers = () =>
      Effect.gen(function* () {
        for (const flow of PKCE_FLOWS) {
          yield* clearPkceVerifier(flow);
        }
      });

    const readPkceVerifiers = () =>
      Effect.gen(function* () {
        const candidates: StoredPkce[] = [];
        for (const flow of PKCE_FLOWS) {
          const bytes = yield* secretStore
            .get(pkceSecretName(flow))
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to restore the Moss authentication verifier.", cause),
              ),
            );
          if (!bytes) continue;

          let decoded: unknown = null;
          try {
            decoded = JSON.parse(textDecoder.decode(bytes)) as unknown;
          } catch {
            // Invalid verifier state is unusable and should not poison future flows.
          }
          if (!isStoredPkce(decoded) || decoded.flow !== flow || decoded.expiresAt <= now()) {
            yield* clearPkceVerifier(flow);
            continue;
          }
          candidates.push(decoded);
        }
        return candidates.toSorted((left, right) => right.createdAt - left.createdAt);
      });

    const readGooglePkce = () =>
      Effect.gen(function* () {
        const bytes = yield* secretStore
          .get(pkceSecretName("google"))
          .pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to restore the Google authentication verifier.", cause),
            ),
          );
        if (!bytes) return null;
        let decoded: unknown = null;
        try {
          decoded = JSON.parse(textDecoder.decode(bytes)) as unknown;
        } catch {
          // The fail-closed branch below clears malformed verifier state.
        }
        if (!isStoredPkce(decoded) || decoded.flow !== "google" || decoded.expiresAt <= now()) {
          yield* clearPkceVerifier("google");
          return null;
        }
        return decoded;
      });

    const serialize = <A>(effect: Effect.Effect<A, MossCloudAccountServiceError>) =>
      semaphore.withPermits(1)(effect);

    const serializeLocalTransition = <A>(effect: Effect.Effect<A, MossCloudAccountServiceError>) =>
      withMossLocalAuthorityTransition(secretStore, serialize(effect));

    const listAccountSummaries = () =>
      Effect.gen(function* () {
        const rows = yield* loadAllBindings();
        const accounts: MossCloudAccountSummary[] = [];
        for (const row of rows) {
          const stored = yield* readStoredSession(row.sessionSecretRef).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          accounts.push(
            accountSummary(
              row,
              stored !== null && isCurrentAuthoritySession(stored) && row.status === "active",
            ),
          );
        }
        return { accounts };
      });

    const restoreSelectedRow = (row: BindingRow | null) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE moss_cloud_account_bindings SET selected = 0 WHERE selected = 1`;
            if (row) {
              yield* sql`
                UPDATE moss_cloud_account_bindings
                SET selected = 1
                WHERE account_id = ${row.accountId}
              `;
            }
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            toPersistenceError("Failed to restore the previous Moss account selection.", cause),
          ),
          Effect.asVoid,
        );

    const selectAccountCore = (accountId: string) =>
      Effect.gen(function* () {
        const client = yield* requireSessionClient();
        const target = yield* loadBindingByAccountId(accountId);
        if (!target) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "This saved Moss account is no longer available.",
            }),
          );
        }
        if (target.status !== "active") {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "account_disabled",
              message: "This Moss account can’t be selected.",
            }),
          );
        }

        const stored = yield* readStoredSession(target.sessionSecretRef);
        if (!stored) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "Sign in again to use this Moss account.",
            }),
          );
        }
        if (!isCurrentAuthoritySession(stored)) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "Sign in with Google to use this saved Moss account.",
            }),
          );
        }

        const previouslySelected = yield* loadSelectedBinding();
        if (stored.expiresAt <= now() + SESSION_REFRESH_SKEW_MS) {
          const refreshed = yield* Effect.tryPromise({
            try: () => client.refresh(stored.refreshToken),
            catch: mapSupabaseMossAuthError,
          }).pipe(
            Effect.catch((error) =>
              error.code === "session_expired" || error.code === "authentication_required"
                ? secretStore.remove(target.sessionSecretRef).pipe(
                    Effect.mapError((cause) =>
                      toPersistenceError(
                        "Failed to clear the expired Moss account session.",
                        cause,
                      ),
                    ),
                    Effect.flatMap(() => Effect.fail(error)),
                  )
                : Effect.fail(error),
            ),
          );
          if (refreshed.user.id !== target.accountId) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "The refreshed Moss session does not match the saved account.",
              }),
            );
          }
          return yield* persistSession({
            session: refreshed,
            fallbackEmail: target.email,
            selectionPolicy: "select",
            recoveryAuthorizedUntil: stored.recoveryAuthorizedUntil,
            ...(stored.version === 2 && stored.googleExchangeReceipt
              ? { googleExchangeReceipt: stored.googleExchangeReceipt }
              : {}),
          });
        }

        if (previouslySelected?.accountId === target.accountId) {
          // Selecting an already-selected row is still an explicit user claim.
          // It may replace another realm's managed surface; background
          // restore/getState/refresh continue to use preserve semantics.
          const reconciled = yield* reconcileManagedProvider(target, stored, "select");
          return accountState(target, reconciled);
        }

        const previousSession = previouslySelected
          ? yield* readStoredSession(previouslySelected.sessionSecretRef).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
          : null;
        let previousSessionCleared = false;
        if (previouslySelected && previousSession?.recoveryAuthorizedUntil !== undefined) {
          yield* secretStore
            .set(
              previouslySelected.sessionSecretRef,
              textEncoder.encode(JSON.stringify(withoutRecoveryAuthorization(previousSession))),
            )
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError(
                  "Failed to clear the previous Moss password recovery authorization.",
                  cause,
                ),
              ),
            );
          previousSessionCleared = true;
        }

        let selectionPersisted = false;
        let providerMutationStarted = false;
        const select = Effect.gen(function* () {
          // Readiness is scoped to the selected account. A denied/degraded
          // catalog is fenced inside restoreManagedProvider; successful
          // catalogs keep the existing provider generation until replacement
          // provisioning has completed.
          modelGatewayStatus = undefined;
          providerMutationStarted = true;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE moss_cloud_account_bindings SET selected = 0 WHERE selected = 1`;
                yield* sql`
                  UPDATE moss_cloud_account_bindings
                  SET selected = 1,
                      updated_at = ${new Date(now()).toISOString()},
                      last_used_at = ${new Date(now()).toISOString()}
                  WHERE account_id = ${target.accountId}
                `;
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to select the saved Moss account.", cause),
              ),
            );
          selectionPersisted = true;
          yield* restoreManagedProvider(stored, "select", previousSession?.accessToken);
          const selected = yield* loadSelectedBinding();
          if (!selected || selected.accountId !== target.accountId) {
            return yield* Effect.fail(
              toPersistenceError("Failed to select the saved Moss account session."),
            );
          }
          return accountState(selected, stored);
        });

        return yield* select.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failures: MossCloudAccountServiceError[] = [];
              if (selectionPersisted) {
                yield* restoreSelectedRow(previouslySelected).pipe(
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                    }),
                  ),
                );
              }
              if (providerMutationStarted) {
                yield* restoreManagedProvider(previousSession, "select").pipe(
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                    }),
                  ),
                );
              }
              if (previousSessionCleared && previouslySelected && previousSession) {
                yield* secretStore
                  .set(
                    previouslySelected.sessionSecretRef,
                    textEncoder.encode(JSON.stringify(previousSession)),
                  )
                  .pipe(
                    Effect.mapError((cause) =>
                      toPersistenceError(
                        "Failed to restore the previous Moss account session.",
                        cause,
                      ),
                    ),
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        failures.push(failure);
                      }),
                    ),
                  );
              }
              return yield* Effect.fail(failures[0] ?? error);
            }),
          ),
        );
      });

    const removeAccountCore = (accountId: string) =>
      Effect.gen(function* () {
        let target = yield* loadBindingByAccountId(accountId);
        if (!target) {
          const selected = yield* loadSelectedBinding();
          const stored = selected
            ? yield* readStoredSession(selected.sessionSecretRef).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )
            : null;
          const state = accountState(selected && stored ? selected : null, stored);
          const { accounts } = yield* listAccountSummaries();
          return { state, accounts };
        }

        const targetSession = yield* readStoredSession(target.sessionSecretRef).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (target.selected === 1) {
          const candidates = (yield* loadAllBindings()).filter(
            (row) => row.accountId !== target!.accountId && row.status === "active",
          );
          for (const candidate of candidates) {
            const selected = yield* selectAccountCore(candidate.accountId).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (selected) break;
          }
          target = (yield* loadBindingByAccountId(accountId)) ?? target;
        }

        const stillSelected = target.selected === 1;
        if (stillSelected) {
          yield* releaseManagedProvider({
            expectedAccessToken: targetSession?.accessToken,
            force: true,
          });
        }

        const secretSnapshot = yield* secretStore
          .get(target.sessionSecretRef)
          .pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to read the saved Moss account session.", cause),
            ),
          );
        let secretRemoved = false;
        const remove = Effect.gen(function* () {
          yield* secretStore
            .remove(target!.sessionSecretRef)
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError("Failed to remove the saved Moss account session.", cause),
              ),
            );
          secretRemoved = true;
          yield* sql`
            DELETE FROM moss_cloud_account_bindings
            WHERE account_id = ${target!.accountId}
          `.pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to remove the saved Moss account.", cause),
            ),
          );
        });

        yield* remove.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failures: MossCloudAccountServiceError[] = [];
              if (secretRemoved && secretSnapshot) {
                yield* secretStore.set(target!.sessionSecretRef, secretSnapshot).pipe(
                  Effect.mapError((cause) =>
                    toPersistenceError("Failed to restore the saved Moss account session.", cause),
                  ),
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                    }),
                  ),
                );
              }
              if (stillSelected) {
                yield* restoreManagedProvider(targetSession, "preserve").pipe(
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      failures.push(failure);
                    }),
                  ),
                );
              }
              return yield* Effect.fail(failures[0] ?? error);
            }),
          ),
        );

        if (auth.available && targetSession && isCurrentAuthoritySession(targetSession)) {
          yield* Effect.tryPromise({
            try: () => auth.client.logout(targetSession.accessToken),
            catch: () => null,
          }).pipe(Effect.ignore);
        }

        const selected = yield* loadSelectedBinding();
        const stored = selected
          ? yield* readStoredSession(selected.sessionSecretRef).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
          : null;
        const state = accountState(selected && stored ? selected : null, stored);
        const { accounts } = yield* listAccountSummaries();
        return { state, accounts };
      });

    const restore = () =>
      serialize(
        Effect.gen(function* () {
          // The legacy cloud-account lane shares the reserved Moss provider
          // with phone login. Without a selected cloud binding it has no
          // ownership proof and must not tear down a phone-managed provider.
          const selected = yield* loadSelectedBinding();
          if (!selected) return;
          const stored = yield* readStoredSession(selected.sessionSecretRef).pipe(
            Effect.catch((error) => failClosedSession<StoredSession | null>(error)),
          );
          if (!auth.available) {
            yield* releaseManagedProvider({
              expectedAccessToken: stored?.accessToken,
              force: true,
            });
            return;
          }
          if (!stored) {
            yield* clearMissingVerifiedSession(selected);
            return;
          }
          if (!isCurrentAuthoritySession(stored)) {
            yield* clearSelectedSession();
            return;
          }
          if (stored.expiresAt <= now() + SESSION_REFRESH_SKEW_MS) {
            yield* refreshSelected(true).pipe(
              Effect.catch((error) =>
                error.code === "session_expired" || error.code === "authentication_required"
                  ? Effect.void
                  : Effect.fail(error),
              ),
            );
            return;
          }
          yield* reconcileManagedProvider(selected, stored);
        }),
      );

    const getLocalAuthority: MossCloudAccountServiceShape["getLocalAuthority"] = () =>
      Effect.gen(function* () {
        // A local ownership snapshot must not queue behind refresh or mutate
        // recovery metadata while another lifecycle operation is suspended.
        const revision = readMossLocalAuthorityRevision(secretStore);
        if (revision === null) return { identity: null };
        const selected = yield* loadSelectedBinding();
        const stored = selected ? yield* readStoredSession(selected.sessionSecretRef, true) : null;
        const authority = yield* managedProviderCoordinator
          .getLocalActiveAuthority()
          .pipe(
            Effect.mapError((cause) =>
              toPersistenceError("Failed to read the local Moss account selection.", cause),
            ),
          );
        const current = yield* loadSelectedBinding();
        const currentStored = current
          ? yield* readStoredSession(current.sessionSecretRef, true)
          : null;
        if (readMossLocalAuthorityRevision(secretStore) !== revision) return { identity: null };
        return {
          ...(authority === "supabase-google" ? { activeRealm: "global" as const } : {}),
          identity:
            isGoogleAuthAvailable(auth) &&
            selected?.status === "active" &&
            selected.emailVerified === 1 &&
            current?.status === "active" &&
            current.emailVerified === 1 &&
            current.accountId === selected.accountId &&
            current.sessionSecretRef === selected.sessionSecretRef &&
            stored !== null &&
            isCurrentAuthoritySession(stored) &&
            currentStored !== null &&
            isCurrentAuthoritySession(currentStored)
              ? {
                  realm: "supabase-google" as const,
                  gatewayBaseUrl: auth.config.modelGatewayUrl,
                  account: { id: selected.accountId, realm: "supabase-google" as const },
                  displayName: current.displayName,
                }
              : null,
        };
      });

    const getState = () =>
      serialize(
        Effect.gen(function* () {
          yield* readPkceVerifiers().pipe(Effect.ignore);
          if (!auth.available) return accountState(null, null);
          const selected = yield* loadSelectedBinding();
          if (!selected) return accountState(null, null);
          const stored = yield* readStoredSession(selected.sessionSecretRef).pipe(
            Effect.catch((error) => failClosedSession<StoredSession | null>(error)),
          );
          if (!stored) {
            yield* clearMissingVerifiedSession(selected);
            return selected.emailVerified === 1
              ? accountState(null, null)
              : accountState(selected, null);
          }
          if (!isCurrentAuthoritySession(stored)) {
            yield* clearSelectedSession();
            return accountState(null, null);
          }
          if (stored.expiresAt <= now() + SESSION_REFRESH_SKEW_MS) {
            const refreshed = yield* refreshSelected(true).pipe(
              Effect.catch((error) =>
                error.code === "session_expired" || error.code === "authentication_required"
                  ? Effect.succeed(null)
                  : Effect.fail(error),
              ),
            );
            if (!refreshed) return accountState(null, null);
            return accountState(refreshed.selected, refreshed.stored);
          }
          const reconciled = yield* reconcileManagedProvider(selected, stored).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to reconcile Moss provider while loading account state", {
                code: error.code,
                message: error.message,
              }).pipe(
                Effect.andThen(
                  markProviderReconcilePending(selected, stored).pipe(
                    // The account session is still valid even if this
                    // best-effort retry marker cannot be persisted. Returning
                    // the existing session keeps the state RPC available and
                    // avoids turning a provider cleanup hiccup into logout.
                    Effect.catch((markerError) =>
                      Effect.logWarning("failed to persist pending Moss provider reconciliation", {
                        code: markerError.code,
                        message: markerError.message,
                      }).pipe(Effect.as(stored)),
                    ),
                  ),
                ),
              ),
            ),
          );
          return accountState(selected, reconciled);
        }),
      ).pipe(
        // Include semaphore acquisition in the budget. Startup restore and
        // refresh use the same permit, so a stalled provider must not make the
        // state RPC wait behind that work for the websocket RPC timeout.
        Effect.timeoutOrElse({
          duration: Duration.millis(providerReconcileTimeoutMs),
          onTimeout: () => readAccountStateWithoutLock(),
        }),
      );

    const listAccounts = () => serialize(listAccountSummaries());

    const selectAccount = (input: { readonly accountId: string }) =>
      serializeLocalTransition(selectAccountCore(input.accountId));

    const removeAccount = (input: { readonly accountId: string }) =>
      serializeLocalTransition(removeAccountCore(input.accountId));

    const signUp = (input: {
      readonly email: string;
      readonly password: string;
      readonly displayName?: string | undefined;
    }) =>
      serializeLocalTransition(
        Effect.gen(function* () {
          const client = yield* requireLegacyClient();
          if (!client.config.redirectUrl) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "not_configured",
                message: "Moss email authentication requires a configured callback URL.",
              }),
            );
          }
          const challenge = yield* writePkce("signup");
          const outcome = yield* Effect.tryPromise({
            try: () => client.signup(input.email, input.password, challenge, input.displayName),
            catch: (cause) => ({ cause, error: mapSupabaseMossAuthError(cause) }),
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((failure) =>
              Effect.succeed({
                ok: false as const,
                cause: failure.cause,
                error: failure.error,
              }),
            ),
          );
          if (!outcome.ok) {
            if (
              outcome.cause instanceof SupabaseMossAuthError &&
              (outcome.cause.retryable || outcome.cause.code === "network_error")
            ) {
              return yield* Effect.fail(outcome.error);
            }
            return yield* clearPkceVerifier("signup").pipe(
              Effect.flatMap(() => Effect.fail(outcome.error)),
            );
          }
          const result = outcome.result;
          if (result.session) {
            yield* clearPkceVerifier("signup");
            const state = yield* persistSession({
              session: result.session,
              fallbackEmail: input.email,
              displayName: input.displayName,
              selectionPolicy: "select",
            });
            return { state, verificationRequired: false };
          }
          const state = yield* stateAfterPendingSignup({
            user: result.user,
            fallbackEmail: input.email,
            displayName: input.displayName,
          });
          return { state, verificationRequired: result.confirmationRequired };
        }),
      );

    const signIn = (input: { readonly email: string; readonly password: string }) =>
      serializeLocalTransition(
        Effect.gen(function* () {
          const client = yield* requireLegacyClient();
          const session = yield* Effect.tryPromise({
            try: () => client.signin(input.email, input.password),
            catch: mapSupabaseMossAuthError,
          });
          yield* clearAllPkceVerifiers().pipe(Effect.ignore);
          return yield* persistSession({
            session,
            fallbackEmail: input.email,
            selectionPolicy: "select",
          });
        }),
      );

    const startGoogleOAuth = (): Effect.Effect<
      MossCloudStartGoogleOAuthResult,
      MossCloudAccountServiceError
    > =>
      serialize(
        Effect.gen(function* () {
          const client = yield* requireGoogleClient();
          const value = yield* writeGooglePkce(client.config.issuer);
          const authorizationUrl = yield* Effect.tryPromise({
            try: () =>
              client.createAuthorizeUrl({
                flowId: value.stored.flowId,
                pkce: value.challenge,
              }),
            catch: mapSupabaseMossAuthError,
          }).pipe(
            Effect.catch((error) =>
              clearPkceVerifier("google").pipe(Effect.flatMap(() => Effect.fail(error))),
            ),
          );

          const parsed = yield* Effect.try({
            try: () => new URL(authorizationUrl),
            catch: () =>
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "The Google authorization service returned an invalid URL.",
              }),
          });
          const issuer = new URL(client.config.issuer);
          const expectedRedirectUrl = new URL(client.config.redirectUrl);
          expectedRedirectUrl.searchParams.set("flow_id", value.stored.flowId);
          const expectedRedirect = expectedRedirectUrl.toString();
          if (
            parsed.origin !== issuer.origin ||
            parsed.pathname !== "/auth/v1/authorize" ||
            parsed.searchParams.get("provider") !== "google" ||
            parsed.searchParams.get("redirect_to") !== expectedRedirect ||
            parsed.searchParams.has("state") ||
            parsed.searchParams.get("code_challenge") !== value.challenge.codeChallenge ||
            parsed.searchParams.get("code_challenge_method") !== "s256"
          ) {
            return yield* clearPkceVerifier("google").pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new MossCloudAccountServiceError({
                    code: "provider_error",
                    message: "The Google authorization service returned an unsafe URL.",
                  }),
                ),
              ),
            );
          }

          return {
            authorizationUrl: authorizationUrl as MossCloudGoogleAuthorizationUrl,
            flowId: value.stored.flowId as MossCloudGoogleOAuthFlowId,
            expiresAt: new Date(value.stored.expiresAt).toISOString(),
          };
        }),
      );

    const exchangeGoogleOAuthCode = (
      input: MossCloudExchangeGoogleOAuthCodeInput,
    ): Effect.Effect<MossCloudAccountState, MossCloudAccountServiceError> =>
      serializeLocalTransition(
        Effect.gen(function* () {
          const client = yield* requireGoogleClient();
          const selected = yield* loadSelectedBinding();
          const selectedSession = selected
            ? yield* readStoredSession(selected.sessionSecretRef).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )
            : null;
          if (
            selected?.status === "active" &&
            selectedSession &&
            isCurrentAuthoritySession(selectedSession) &&
            matchesGoogleExchangeReceipt(selectedSession, input, now())
          ) {
            return {
              ...accountState(selected, selectedSession),
              lastAuthFlow: "google",
            };
          }
          const stored = yield* readGooglePkce();
          if (
            !stored ||
            stored.realm !== "supabase-google" ||
            stored.issuer !== client.config.issuer ||
            !flowIdsMatch(stored.flowId, input.flowId)
          ) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "session_expired",
                message: "The Google authentication flow is invalid or expired. Start again.",
              }),
            );
          }

          const outcome = yield* Effect.tryPromise({
            try: () => client.exchangeCode(input.code, stored.verifier),
            catch: mapSupabaseMossAuthError,
          }).pipe(
            Effect.map((session) => ({ ok: true as const, session })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
          // The callback flow is one-time even when the provider response is ambiguous.
          yield* clearPkceVerifier("google");
          if (!outcome.ok) return yield* Effect.fail(outcome.error);
          if (!isGoogleIdentity(outcome.session.user)) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "The Supabase session was not issued for a Google identity.",
              }),
            );
          }
          const state = yield* persistSession({
            session: outcome.session,
            selectionPolicy: "select",
            googleExchangeReceipt: makeGoogleExchangeReceipt(input, now()),
          });
          return { ...state, lastAuthFlow: "google" };
        }),
      );

    const refresh = () =>
      serialize(
        refreshSelected(true).pipe(
          Effect.map(({ selected, stored }) => accountState(selected, stored)),
        ),
      );

    const requestPasswordReset = (input: { readonly email: string }) =>
      serialize(
        Effect.gen(function* () {
          const client = yield* requireLegacyClient();
          if (!client.config.redirectUrl) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "not_configured",
                message: "Moss password recovery requires a configured callback URL.",
              }),
            );
          }
          const challenge = yield* writePkce("recovery");
          const outcome = yield* Effect.tryPromise({
            try: () => client.recover(input.email, challenge),
            catch: (cause) => ({ cause, error: mapSupabaseMossAuthError(cause) }),
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catch((failure) =>
              Effect.succeed({
                ok: false as const,
                cause: failure.cause,
                error: failure.error,
              }),
            ),
          );
          if (!outcome.ok) {
            if (
              outcome.cause instanceof SupabaseMossAuthError &&
              (outcome.cause.retryable || outcome.cause.code === "network_error")
            ) {
              return yield* Effect.fail(outcome.error);
            }
            return yield* clearPkceVerifier("recovery").pipe(
              Effect.flatMap(() => Effect.fail(outcome.error)),
            );
          }
          return { ok: true as const };
        }),
      );

    const exchangeCode = (input: { readonly code: string }) =>
      serializeLocalTransition(
        Effect.gen(function* () {
          const client = yield* requireLegacyClient();
          const codeHash = createHash("sha256").update(input.code).digest("hex");
          const timestamp = now();
          for (const [hash, cached] of successfulExchanges) {
            if (cached.expiresAt <= timestamp) successfulExchanges.delete(hash);
          }
          const cached = successfulExchanges.get(codeHash);
          if (cached) {
            const selected = yield* loadSelectedBinding();
            const stored =
              selected?.accountId === cached.accountId
                ? yield* readStoredSession(selected.sessionSecretRef).pipe(
                    Effect.catch(() => Effect.succeed(null)),
                  )
                : null;
            if (selected && stored) {
              return {
                ...accountState(selected, stored),
                lastAuthFlow: cached.flow,
              };
            }
            // A cached callback may never resurrect a session after sign-out,
            // removal, or an intervening account switch.
            successfulExchanges.delete(codeHash);
          }
          const candidates = (yield* readPkceVerifiers()).filter(
            (candidate): candidate is StoredLegacyPkce => candidate.flow !== "google",
          );
          if (candidates.length === 0) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "session_expired",
                message: "The authentication link is no longer valid. Request a new link.",
              }),
            );
          }

          let lastError: MossCloudAccountServiceError | null = null;
          for (const candidate of candidates) {
            const outcome = yield* Effect.tryPromise({
              try: () => client.exchangeCode(input.code, candidate.verifier),
              catch: (cause) => ({ cause, error: mapSupabaseMossAuthError(cause) }),
            }).pipe(
              Effect.map((session) => ({ ok: true as const, session })),
              Effect.catch((failure) =>
                Effect.succeed({
                  ok: false as const,
                  cause: failure.cause,
                  error: failure.error,
                }),
              ),
            );

            if (outcome.ok) {
              yield* clearPkceVerifier(candidate.flow);
              const state = yield* persistSession({
                session: outcome.session,
                selectionPolicy: "select",
                ...(candidate.flow === "recovery"
                  ? { recoveryAuthorizedUntil: now() + RECOVERY_AUTHORIZATION_TTL_MS }
                  : {}),
              });
              successfulExchanges.set(codeHash, {
                accountId: outcome.session.user.id,
                flow: candidate.flow,
                expiresAt: now() + EXCHANGE_IDEMPOTENCY_TTL_MS,
              });
              return { ...state, lastAuthFlow: candidate.flow };
            }

            lastError = outcome.error;
            if (
              outcome.cause instanceof SupabaseMossAuthError &&
              (outcome.cause.retryable || outcome.cause.code === "network_error")
            ) {
              return yield* Effect.fail(outcome.error);
            }
          }

          return yield* Effect.fail(
            lastError ??
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "The authentication request was rejected.",
              }),
          );
        }),
      );

    const updatePassword = (input: { readonly password: string }) =>
      serialize(
        Effect.gen(function* () {
          const client = yield* requireLegacyClient();
          const { selected, stored } = yield* refreshSelected(false);
          if (
            stored.recoveryAuthorizedUntil === undefined ||
            stored.recoveryAuthorizedUntil <= now()
          ) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "session_expired",
                message: "Password recovery authorization expired. Request a new link.",
              }),
            );
          }
          const updatedUser = yield* Effect.tryPromise({
            try: () => client.updatePassword(stored.accessToken, input.password),
            catch: mapSupabaseMossAuthError,
          });
          if (updatedUser.id !== selected.accountId) {
            return yield* failClosedSession<never>(
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "The updated Moss account does not match the selected account.",
              }),
            );
          }
          yield* secretStore
            .set(
              selected.sessionSecretRef,
              textEncoder.encode(JSON.stringify(withoutRecoveryAuthorization(stored))),
            )
            .pipe(
              Effect.mapError((cause) =>
                toPersistenceError(
                  "Failed to clear the Moss password recovery authorization.",
                  cause,
                ),
              ),
              Effect.catch((error) => failClosedSession<void>(error)),
            );
          return { ok: true as const };
        }),
      );

    const logout = () =>
      serializeLocalTransition(
        Effect.gen(function* () {
          const client = auth.available ? auth.client : null;
          const accessToken = yield* loadSelectedBinding().pipe(
            Effect.flatMap((selected) =>
              selected
                ? readStoredSession(selected.sessionSecretRef).pipe(
                    Effect.map((stored) =>
                      stored && isCurrentAuthoritySession(stored) ? stored.accessToken : null,
                    ),
                  )
                : Effect.succeed(null),
            ),
            Effect.catch(() => Effect.succeed(null)),
          );
          let revoked = false;
          if (client && accessToken) {
            revoked = yield* Effect.tryPromise({
              try: () => client.logout(accessToken),
              catch: () => false,
            }).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
          }
          yield* clearAllPkceVerifiers().pipe(Effect.ignore);
          yield* clearSelectedSession();
          successfulExchanges.clear();
          return { revoked };
        }),
      );

    const getAccessToken = () =>
      serialize(
        Effect.gen(function* () {
          if (!auth.available) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "not_configured",
                message: "The Moss account service is not configured on this server.",
              }),
            );
          }
          const { stored } = yield* refreshSelected(false);
          return stored.accessToken;
        }),
      );

    const getAuthorityCredential: MossCloudAccountServiceShape["getAuthorityCredential"] = () =>
      serialize(
        Effect.gen(function* () {
          if (!isGoogleAuthAvailable(auth)) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "not_configured",
                message: "Google authentication is not configured on this server.",
              }),
            );
          }
          const { stored } = yield* refreshSelected(false);
          if (
            stored.version !== 2 ||
            stored.realm !== "supabase-google" ||
            stored.issuer !== auth.config.issuer ||
            stored.provider !== "google"
          ) {
            return yield* failClosedSession<never>(
              new MossCloudAccountServiceError({
                code: "authentication_required",
                message: "The selected account does not have a valid Google authority.",
              }),
            );
          }
          return {
            realm: "supabase-google",
            issuer: auth.config.issuer,
            accessToken: stored.accessToken,
            gatewayBaseUrl: auth.config.modelGatewayUrl,
            realtimeRelayUrl: auth.config.realtimeRelayUrl,
          };
        }),
      );

    const activateRealm: MossCloudAccountServiceShape["activateRealm"] = (input) =>
      serializeLocalTransition(
        Effect.gen(function* () {
          if (input?.realm !== undefined && input.realm !== "global") {
            return yield* new MossCloudAccountServiceError({
              code: "provider_error",
              message: "Google 账号只能激活全球模型网关。",
            });
          }
          const { selected, stored } = yield* refreshSelected(false);
          yield* reconcileManagedProvider(selected, stored, "select");
          return { activeRealm: activeRealm } satisfies MossAccountActiveRealmState;
        }),
      );

    const getGatewayAccessToken = () =>
      Effect.gen(function* () {
        if (!auth.available || !auth.config.modelGatewayUrl) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "not_configured",
              message: "The Moss model gateway is not configured on this server.",
            }),
          );
        }
        return yield* getAccessToken();
      });

    return {
      restore,
      getState,
      getLocalAuthority,
      listAccounts,
      selectAccount,
      removeAccount,
      signUp,
      signIn,
      startGoogleOAuth,
      exchangeGoogleOAuthCode,
      refresh,
      requestPasswordReset,
      exchangeCode,
      updatePassword,
      logout,
      getAccessToken,
      getAuthorityCredential,
      activateRealm,
      getGatewayAccessToken,
    } satisfies MossCloudAccountServiceShape;
  });

export const startMossCloudAccountSessionMaintenance = (
  service: Pick<MossCloudAccountServiceShape, "getState">,
) =>
  service.getState().pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning("failed to maintain Moss cloud account session", {
        code: error.code,
        message: error.message,
      }),
    ),
    Effect.delay(SESSION_MAINTENANCE_INTERVAL),
    Effect.repeat(Schedule.spaced(SESSION_MAINTENANCE_INTERVAL)),
    Effect.forkScoped,
    Effect.asVoid,
  );

export const MossCloudAccountServiceLive = Layer.effect(
  MossCloudAccountService,
  makeMossCloudAccountService(),
);
