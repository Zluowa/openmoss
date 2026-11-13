import { Schema } from "effect";

import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas";

export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-session-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthSessionRole = Schema.Literals(["owner", "client"]);
export type AuthSessionRole = typeof AuthSessionRole.Type;

export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthBootstrapInput = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthBootstrapInput = typeof AuthBootstrapInput.Type;

export const AuthBootstrapResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBootstrapResult = typeof AuthBootstrapResult.Type;

export const AuthBearerBootstrapResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: Schema.Literal("bearer-session-token"),
  expiresAt: Schema.DateTimeUtc,
  sessionToken: TrimmedNonEmptyString,
});
export type AuthBearerBootstrapResult = typeof AuthBearerBootstrapResult.Type;

export const AuthWebSocketTokenResult = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTokenResult = typeof AuthWebSocketTokenResult.Type;

export const AuthLogoutResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthLogoutResult = typeof AuthLogoutResult.Type;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  role: AuthSessionRole,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  role: AuthSessionRole,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const AuthPairingCredentialAccess = Schema.Literals(["client", "ownerDevice"]);
export type AuthPairingCredentialAccess = typeof AuthPairingCredentialAccess.Type;

export const AuthCreatePairingCredentialInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * `ownerDevice` pairs another device of the owner (their phone) with full owner
   * access. Only an owner session can create either kind of code.
   */
  access: Schema.optionalKey(AuthPairingCredentialAccess),
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

// ── Account sign-in from the owner's phone ─────────────────────────────
//
// The phone and this computer are signed in to the same Moss account. The phone never
// sends its account token here: it asks for a one-time code, writes the code and a fresh
// public key into the account's own metadata at the account service, and asks for a
// pending request. Nothing is granted until a person at this computer allows it; the
// session then goes back sealed to the phone's key (`@moss/shared/mossAccountSealedDelivery`).

/** The two Moss account services a computer can be signed in to. */
export const AuthAccountRealm = Schema.Literals(["memfire-phone", "supabase-google"]);
export type AuthAccountRealm = typeof AuthAccountRealm.Type;

export const AuthAccountChallengeInput = Schema.Struct({
  realm: AuthAccountRealm,
});
export type AuthAccountChallengeInput = typeof AuthAccountChallengeInput.Type;

export const AuthAccountChallengeResult = Schema.Struct({
  challengeId: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthAccountChallengeResult = typeof AuthAccountChallengeResult.Type;

export const AuthAccountRequestInput = Schema.Struct({
  realm: AuthAccountRealm,
  challengeId: TrimmedNonEmptyString,
  /** What the phone calls itself; shown on this computer as untrusted text. */
  deviceName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type AuthAccountRequestInput = typeof AuthAccountRequestInput.Type;

export const AuthAccountRequestResult = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
  /**
   * 16 random bytes (base64url) the computer drew after reading the phone's key. The check
   * code folds them in, so the phone can show its code only once this reply has arrived.
   */
  checkNonce: TrimmedNonEmptyString,
});
export type AuthAccountRequestResult = typeof AuthAccountRequestResult.Type;

export const AuthAccountStatusInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
});
export type AuthAccountStatusInput = typeof AuthAccountStatusInput.Type;

/** The phone's session, sealed to the phone's public key (wire format version 3). */
export const AuthAccountSealedSession = Schema.Struct({
  v: Schema.Literal(3),
  epk: TrimmedNonEmptyString,
  n: TrimmedNonEmptyString,
  ct: TrimmedNonEmptyString,
});
export type AuthAccountSealedSession = typeof AuthAccountSealedSession.Type;

export const AuthAccountStatusResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    expiresAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    sealed: AuthAccountSealedSession,
  }),
]);
export type AuthAccountStatusResult = typeof AuthAccountStatusResult.Type;

/** Why a computer refused an account sign-in; sent as `reason` beside `error`. */
export const AuthAccountLoginRefusal = Schema.Literals([
  "phone_access_off",
  "confirmation_unavailable",
  "request_denied",
  "request_expired",
  "too_many_attempts",
  "account_mismatch",
  "computer_not_signed_in",
  "challenge_expired",
  "account_service_unavailable",
  /** A refusal that says nothing about why (sent to callers that are not yet trusted). */
  "refused",
]);
export type AuthAccountLoginRefusal = typeof AuthAccountLoginRefusal.Type;

export const AuthAccountLoginRefused = Schema.Struct({
  error: TrimmedNonEmptyString,
  reason: AuthAccountLoginRefusal,
});
export type AuthAccountLoginRefused = typeof AuthAccountLoginRefused.Type;

/** One phone waiting for a person at this computer to allow it. */
export const AuthAccountPendingRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  /** Sanitised, at most 40 characters; null when the phone gave none. */
  deviceName: Schema.NullOr(TrimmedNonEmptyString),
  /** The account, from this computer's own session: an email or a masked phone number. */
  accountLabel: Schema.NullOr(TrimmedNonEmptyString),
  /** The 4-digit code the phone shows for the same attempt. */
  checkCode: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthAccountPendingRequest = typeof AuthAccountPendingRequest.Type;

export const AuthAccountPendingRequests = Schema.Struct({
  requests: Schema.Array(AuthAccountPendingRequest),
});
export type AuthAccountPendingRequests = typeof AuthAccountPendingRequests.Type;

export const AuthAccountDecisionInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
});
export type AuthAccountDecisionInput = typeof AuthAccountDecisionInput.Type;

/** Local-owner methods for the confirmation in the Moss window on this computer. */
export const ACCOUNT_SIGN_IN_WS_METHODS = {
  subscribe: "auth.accountSignIn.subscribe",
  approve: "auth.accountSignIn.approve",
  deny: "auth.accountSignIn.deny",
} as const;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  role: Schema.optionalKey(AuthSessionRole),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type AuthSessionState = typeof AuthSessionState.Type;
