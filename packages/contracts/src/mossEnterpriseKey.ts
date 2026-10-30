import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

// A Moss-issued enterprise API key signs a desktop in on its own: no phone or
// Google account is needed. Traffic uses the mainland gateway and every model
// vendor (see the `enterprise` lane in @synara/shared/mossRealmCatalog). The
// exact key format is validated server-side; this schema only bounds the input.
export const MossEnterpriseApiKey = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\r\n]+$/u),
);
export type MossEnterpriseApiKey = typeof MossEnterpriseApiKey.Type;

export const MossEnterpriseKeyGatewayStatus = Schema.Literals([
  "ready",
  "auth-denied",
  "no-entitlement",
  "transport-degraded",
]);
export type MossEnterpriseKeyGatewayStatus = typeof MossEnterpriseKeyGatewayStatus.Type;

// The key itself never crosses back to the renderer; only its display prefix.
export const MossEnterpriseKeyState = Schema.Struct({
  /** This build knows the mainland gateway the enterprise lane uses. */
  configured: Schema.Boolean,
  authenticated: Schema.Boolean,
  keyPrefix: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  verifiedAt: Schema.NullOr(IsoDateTime),
  /** Models the gateway granted this key at the last verification. */
  modelCount: NonNegativeInt,
  /** The key currently owns the managed Moss provider surface. */
  active: Schema.Boolean,
  modelGatewayStatus: Schema.optional(MossEnterpriseKeyGatewayStatus),
});
export type MossEnterpriseKeyState = typeof MossEnterpriseKeyState.Type;

export const MossEnterpriseKeySignInInput = Schema.Struct({
  apiKey: MossEnterpriseApiKey,
});
export type MossEnterpriseKeySignInInput = typeof MossEnterpriseKeySignInInput.Type;
