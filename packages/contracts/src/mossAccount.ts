import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const MossAccountUserId = TrimmedNonEmptyString.pipe(Schema.brand("MossAccountUserId"));
export type MossAccountUserId = typeof MossAccountUserId.Type;

export const MossAccountSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("MossAccountSessionId"),
);
export type MossAccountSessionId = typeof MossAccountSessionId.Type;

export const MossAccountSmsChallengeId = TrimmedNonEmptyString.pipe(
  Schema.brand("MossAccountSmsChallengeId"),
);
export type MossAccountSmsChallengeId = typeof MossAccountSmsChallengeId.Type;

export const MossAccountRole = Schema.Literals(["owner", "admin", "member"]);
export type MossAccountRole = typeof MossAccountRole.Type;

export const MossAccountUserStatus = Schema.Literals(["active", "disabled", "revoked"]);
export type MossAccountUserStatus = typeof MossAccountUserStatus.Type;

export const MossSmsProvider = Schema.Literals(["aliyun", "development"]);
export type MossSmsProvider = typeof MossSmsProvider.Type;

/**
 * The model gateway realm selected for the current Moss session. Moss currently
 * has one reserved managed provider surface, so selecting a realm switches
 * that surface; this is not simultaneous dual-realm execution.
 */
export const MossAccountRealm = Schema.Literals(["cn", "global"]);
export type MossAccountRealm = typeof MossAccountRealm.Type;

export const MossAccountSelectRealmInput = Schema.Struct({
  realm: MossAccountRealm,
});
export type MossAccountSelectRealmInput = typeof MossAccountSelectRealmInput.Type;

export const MossAccountActiveRealmState = Schema.Struct({
  activeRealm: Schema.NullOr(MossAccountRealm),
});
export type MossAccountActiveRealmState = typeof MossAccountActiveRealmState.Type;

export const MossPhoneNumber = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
export type MossPhoneNumber = typeof MossPhoneNumber.Type;

export const MossAccountUser = Schema.Struct({
  id: MossAccountUserId,
  phoneNumber: MossPhoneNumber,
  displayName: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  role: MossAccountRole,
  status: MossAccountUserStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastLoginAt: Schema.NullOr(IsoDateTime),
});
export type MossAccountUser = typeof MossAccountUser.Type;

export const MossAccountSession = Schema.Struct({
  id: MossAccountSessionId,
  user: MossAccountUser,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type MossAccountSession = typeof MossAccountSession.Type;

export const MossAccountSessionState = Schema.Struct({
  configured: Schema.Boolean,
  authenticated: Schema.Boolean,
  session: Schema.NullOr(MossAccountSession),
  smsProvider: MossSmsProvider,
  aliyunSmsConfigured: Schema.Boolean,
  /** Live managed-gateway entitlement/readiness; absent for legacy clients. */
  modelGatewayStatus: Schema.optional(
    Schema.Literals(["ready", "auth-denied", "no-entitlement", "transport-degraded"]),
  ),
  /** Explicitly selected gateway realm. Omitted by older clients. */
  activeRealm: Schema.optional(MossAccountRealm),
});
export type MossAccountSessionState = typeof MossAccountSessionState.Type;

export const MossAccountStartPhoneLoginInput = Schema.Struct({
  phoneNumber: MossPhoneNumber,
});
export type MossAccountStartPhoneLoginInput = typeof MossAccountStartPhoneLoginInput.Type;

export const MossAccountStartPhoneLoginResult = Schema.Struct({
  challengeId: MossAccountSmsChallengeId,
  phoneNumber: MossPhoneNumber,
  expiresAt: IsoDateTime,
  provider: MossSmsProvider,
  delivery: Schema.Literals(["sent", "development"]),
  developmentCode: Schema.optional(TrimmedNonEmptyString),
});
export type MossAccountStartPhoneLoginResult = typeof MossAccountStartPhoneLoginResult.Type;

export const MossAccountVerifyPhoneLoginInput = Schema.Struct({
  challengeId: MossAccountSmsChallengeId,
  phoneNumber: MossPhoneNumber,
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(12)),
});
export type MossAccountVerifyPhoneLoginInput = typeof MossAccountVerifyPhoneLoginInput.Type;

export const MossAccountVerifyPhoneLoginResult = MossAccountSessionState;
export type MossAccountVerifyPhoneLoginResult = typeof MossAccountVerifyPhoneLoginResult.Type;

export const MossAccountLogoutResult = Schema.Struct({
  revokedCount: NonNegativeInt,
});
export type MossAccountLogoutResult = typeof MossAccountLogoutResult.Type;
