import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { MossAccountRealm } from "./mossAccount";

const EmailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MossCloudAccountId = TrimmedNonEmptyString.pipe(Schema.brand("MossCloudAccountId"));
export type MossCloudAccountId = typeof MossCloudAccountId.Type;

export const MossCloudEmail = TrimmedNonEmptyString.check(
  Schema.isMaxLength(320),
  Schema.isPattern(EmailAddressPattern),
);
export type MossCloudEmail = typeof MossCloudEmail.Type;

// Passwords are intentionally not trimmed: spaces may be meaningful. They are
// accepted only at the RPC boundary and are never persisted in Moss settings.
export const MossCloudPassword = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(128),
);
export type MossCloudPassword = typeof MossCloudPassword.Type;

// Sign-in must remain compatible with accounts created under an older password
// policy. Only new and replacement passwords enforce the current eight-character
// minimum.
export const MossCloudSignInPassword = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);
export type MossCloudSignInPassword = typeof MossCloudSignInPassword.Type;

export const MossCloudAccountStatus = Schema.Literals(["active", "disabled", "revoked"]);
export type MossCloudAccountStatus = typeof MossCloudAccountStatus.Type;

export const MossCloudAccount = Schema.Struct({
  id: MossCloudAccountId,
  email: MossCloudEmail,
  emailVerified: Schema.Boolean,
  displayName: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  status: MossCloudAccountStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastLoginAt: Schema.NullOr(IsoDateTime),
});
export type MossCloudAccount = typeof MossCloudAccount.Type;

export const MossCloudSessionSummary = Schema.Struct({
  accountId: MossCloudAccountId,
  expiresAt: IsoDateTime,
  refreshedAt: IsoDateTime,
});
export type MossCloudSessionSummary = typeof MossCloudSessionSummary.Type;

export const MossCloudAccountState = Schema.Struct({
  configured: Schema.Boolean,
  authenticated: Schema.Boolean,
  account: Schema.NullOr(MossCloudAccount),
  session: Schema.NullOr(MossCloudSessionSummary),
  emailVerificationRequired: Schema.Boolean,
  modelGatewayConfigured: Schema.Boolean,
  authProvider: Schema.Literal("supabase_google"),
  /** Live managed-gateway entitlement/readiness; absent for legacy clients. */
  modelGatewayStatus: Schema.optional(
    Schema.Literals(["ready", "auth-denied", "no-entitlement", "transport-degraded"]),
  ),
  /** Explicitly selected gateway realm. Omitted by older clients. */
  activeRealm: Schema.optional(MossAccountRealm),
  /** Present after a PKCE code exchange so UI routing never trusts callback query hints. */
  lastAuthFlow: Schema.optional(Schema.NullOr(Schema.Literals(["signup", "recovery", "google"]))),
});
export type MossCloudAccountState = typeof MossCloudAccountState.Type;

/**
 * Non-secret identity metadata that is safe to return to the renderer.
 *
 * The session reference and all Supabase credential material intentionally stay
 * server-side. `sessionAvailable` only tells the UI whether this identity can be
 * selected without asking for a password again.
 */
export const MossCloudAccountSummary = Schema.Struct({
  id: MossCloudAccountId,
  email: MossCloudEmail,
  emailVerified: Schema.Boolean,
  displayName: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  status: MossCloudAccountStatus,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  selected: Schema.Boolean,
  sessionAvailable: Schema.Boolean,
});
export type MossCloudAccountSummary = typeof MossCloudAccountSummary.Type;

export const MossCloudListAccountsResult = Schema.Struct({
  accounts: Schema.Array(MossCloudAccountSummary),
});
export type MossCloudListAccountsResult = typeof MossCloudListAccountsResult.Type;

export const MossCloudSelectAccountInput = Schema.Struct({
  accountId: MossCloudAccountId,
});
export type MossCloudSelectAccountInput = typeof MossCloudSelectAccountInput.Type;

export const MossCloudRemoveAccountInput = Schema.Struct({
  accountId: MossCloudAccountId,
});
export type MossCloudRemoveAccountInput = typeof MossCloudRemoveAccountInput.Type;

export const MossCloudRemoveAccountResult = Schema.Struct({
  state: MossCloudAccountState,
  accounts: Schema.Array(MossCloudAccountSummary),
});
export type MossCloudRemoveAccountResult = typeof MossCloudRemoveAccountResult.Type;

export const MossCloudSignUpInput = Schema.Struct({
  email: MossCloudEmail,
  password: MossCloudPassword,
  displayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
});
export type MossCloudSignUpInput = typeof MossCloudSignUpInput.Type;

export const MossCloudSignUpResult = Schema.Struct({
  state: MossCloudAccountState,
  verificationRequired: Schema.Boolean,
});
export type MossCloudSignUpResult = typeof MossCloudSignUpResult.Type;

export const MossCloudSignInInput = Schema.Struct({
  email: MossCloudEmail,
  password: MossCloudSignInPassword,
});
export type MossCloudSignInInput = typeof MossCloudSignInInput.Type;

export const MossCloudSignInResult = MossCloudAccountState;
export type MossCloudSignInResult = typeof MossCloudSignInResult.Type;

export const MossCloudRequestPasswordResetInput = Schema.Struct({
  email: MossCloudEmail,
});
export type MossCloudRequestPasswordResetInput = typeof MossCloudRequestPasswordResetInput.Type;

export const MossCloudExchangeCodeInput = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type MossCloudExchangeCodeInput = typeof MossCloudExchangeCodeInput.Type;

export const MossCloudGoogleOAuthFlowId = TrimmedNonEmptyString.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/u),
).pipe(Schema.brand("MossCloudGoogleOAuthFlowId"));
export type MossCloudGoogleOAuthFlowId = typeof MossCloudGoogleOAuthFlowId.Type;

export const MossCloudGoogleAuthorizationUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(
    /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co\/auth\/v1\/authorize\?[^#\s]+$/u,
  ),
).pipe(Schema.brand("MossCloudGoogleAuthorizationUrl"));
export type MossCloudGoogleAuthorizationUrl = typeof MossCloudGoogleAuthorizationUrl.Type;

export const MossCloudStartGoogleOAuthResult = Schema.Struct({
  authorizationUrl: MossCloudGoogleAuthorizationUrl,
  flowId: MossCloudGoogleOAuthFlowId,
  expiresAt: IsoDateTime,
});
export type MossCloudStartGoogleOAuthResult = typeof MossCloudStartGoogleOAuthResult.Type;

export const MossCloudExchangeGoogleOAuthCodeInput = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  flowId: MossCloudGoogleOAuthFlowId,
});
export type MossCloudExchangeGoogleOAuthCodeInput =
  typeof MossCloudExchangeGoogleOAuthCodeInput.Type;

export const MossCloudUpdatePasswordInput = Schema.Struct({
  password: MossCloudPassword,
});
export type MossCloudUpdatePasswordInput = typeof MossCloudUpdatePasswordInput.Type;

export const MossCloudMutationResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type MossCloudMutationResult = typeof MossCloudMutationResult.Type;

export const MossCloudLogoutResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type MossCloudLogoutResult = typeof MossCloudLogoutResult.Type;
