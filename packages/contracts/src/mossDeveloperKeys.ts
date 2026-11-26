import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { MossMediaNanoCny } from "./mossPay";

export const MOSS_DEVELOPER_INITIAL_GRANT_FEN = 300 as const;
export const MOSS_DEVELOPER_INITIAL_GRANT_NANO_CNY = "3000000000" as const;

export const MossDeveloperCapability = Schema.Literals(["llm", "image", "video", "voice"]);
export type MossDeveloperCapability = typeof MossDeveloperCapability.Type;

export const MossDeveloperApiKeyStatus = Schema.Literals(["active", "revoked"]);
export type MossDeveloperApiKeyStatus = typeof MossDeveloperApiKeyStatus.Type;

export const MossDeveloperLedgerEventType = Schema.Literals([
  "initial_grant",
  "reserve",
  "capture",
  "release",
  "debit",
]);
export type MossDeveloperLedgerEventType = typeof MossDeveloperLedgerEventType.Type;

export const MossDeveloperLedgerCapability = Schema.Literals([
  "grant",
  "llm",
  "image",
  "video",
  "voice",
]);
export type MossDeveloperLedgerCapability = typeof MossDeveloperLedgerCapability.Type;

export const MossDeveloperApiKey = Schema.String.check(
  Schema.isMinLength(20),
  Schema.isMaxLength(256),
  Schema.isPattern(/^moss_dk_(?:cn_|gl_)?[A-Za-z0-9_-]{32,64}$/u),
);
export type MossDeveloperApiKey = typeof MossDeveloperApiKey.Type;

/**
 * Only the masked prefix and metadata ever cross back to the client after creation.
 * Raw key material is returned once on creation and never persisted on the server.
 */
export const MossDeveloperApiKeyRecord = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  keyPrefix: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  scopes: Schema.Array(MossDeveloperCapability),
  status: MossDeveloperApiKeyStatus,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type MossDeveloperApiKeyRecord = typeof MossDeveloperApiKeyRecord.Type;

export const MossDeveloperWalletSummary = Schema.Struct({
  initialGrantFen: NonNegativeInt,
  availableFen: NonNegativeInt,
  heldFen: NonNegativeInt,
  spentFen: NonNegativeInt,
  availableNanoCny: MossMediaNanoCny,
  heldNanoCny: MossMediaNanoCny,
  spentNanoCny: MossMediaNanoCny,
});
export type MossDeveloperWalletSummary = typeof MossDeveloperWalletSummary.Type;

export const MossDeveloperCapabilityBreakdown = Schema.Struct({
  capability: MossDeveloperCapability,
  requestCount: NonNegativeInt,
  spentNanoCny: MossMediaNanoCny,
});
export type MossDeveloperCapabilityBreakdown = typeof MossDeveloperCapabilityBreakdown.Type;

export const MossDeveloperLedgerEntry = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  eventType: MossDeveloperLedgerEventType,
  capability: MossDeveloperLedgerCapability,
  modelId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  apiKeyId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  deltaAvailableNanoCny: TrimmedNonEmptyString.check(
    Schema.isPattern(/^-?(?:0|[1-9][0-9]{0,18})$/),
  ),
  availableAfterNanoCny: MossMediaNanoCny,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type MossDeveloperLedgerEntry = typeof MossDeveloperLedgerEntry.Type;

export const MossDeveloperApiKeysState = Schema.Struct({
  configured: Schema.Boolean,
  authenticated: Schema.Boolean,
  gatewayBaseUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  localGatewayBaseUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  wallet: Schema.NullOr(MossDeveloperWalletSummary),
  breakdown: Schema.Array(MossDeveloperCapabilityBreakdown),
  keys: Schema.Array(MossDeveloperApiKeyRecord),
  recentLedger: Schema.Array(MossDeveloperLedgerEntry),
});
export type MossDeveloperApiKeysState = typeof MossDeveloperApiKeysState.Type;

export const MossDeveloperCreateApiKeyInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  scopes: Schema.optional(Schema.Array(MossDeveloperCapability)),
});
export type MossDeveloperCreateApiKeyInput = typeof MossDeveloperCreateApiKeyInput.Type;

export const MossDeveloperCreateApiKeyResult = Schema.Struct({
  key: MossDeveloperApiKeyRecord,
  secretKey: MossDeveloperApiKey,
  wallet: MossDeveloperWalletSummary,
});
export type MossDeveloperCreateApiKeyResult = typeof MossDeveloperCreateApiKeyResult.Type;

export const MossDeveloperRevokeApiKeyInput = Schema.Struct({
  keyId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type MossDeveloperRevokeApiKeyInput = typeof MossDeveloperRevokeApiKeyInput.Type;

export const MossDeveloperRevokeApiKeyResult = Schema.Struct({
  revoked: Schema.Boolean,
  key: Schema.NullOr(MossDeveloperApiKeyRecord),
});
export type MossDeveloperRevokeApiKeyResult = typeof MossDeveloperRevokeApiKeyResult.Type;
