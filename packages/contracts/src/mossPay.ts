import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

// Moss 会员/积分支付契约。档位与积分包的数字由 memfire `moss_plans` /
// `moss_point_packages` 表配置（后台可改），前端只读，不写死。

export const MossPayOrderType = Schema.Literals(["plan", "points", "media_topup"]);
export type MossPayOrderType = typeof MossPayOrderType.Type;

export const MossPayPlan = Schema.Struct({
  code: TrimmedNonEmptyString,
  displayName: Schema.String,
  monthlyPriceCny: Schema.Number,
  /** Internal display unit: provider-cost cents for cost v1, weighted credits during rollout. */
  monthlyCreditLimit: Schema.Number,
  /** Rolling five-hour guardrail, expressed in the same billing-model unit. */
  fiveHourCreditLimit: Schema.Number,
  /** Rolling seven-day guardrail, expressed in the same billing-model unit. */
  weeklyCreditLimit: Schema.Number,
  /** Product estimate only; actual tasks vary by model, cache hits, context, and output. */
  standardTaskEstimate: Schema.Number,
  /** Versioned settlement policy so clients never infer token equivalence. */
  billingModel: Schema.Literals(["cost_budget_v1", "weighted_credits_v1"]),
  /** Legacy transition fields; retained while older gateway deployments drain. */
  monthlyTokenLimit: Schema.Number,
  monthlyRequestLimit: Schema.Number,
  modelAllowlist: Schema.Array(Schema.String),
  monthlyRealtimeCostLimitNanoUsd: Schema.Number,
  monthlyRealtimeSessionLimit: Schema.Number,
  realtimeModelAllowlist: Schema.Array(Schema.String),
  estimatedRealtimeMinutes: Schema.Number,
  sortOrder: Schema.Number,
});
export type MossPayPlan = typeof MossPayPlan.Type;

export const MossPayPointPackage = Schema.Struct({
  code: TrimmedNonEmptyString,
  displayName: Schema.String,
  priceCny: Schema.Number,
  points: Schema.Number,
  tokensPerPoint: Schema.Number,
  sortOrder: Schema.Number,
});
export type MossPayPointPackage = typeof MossPayPointPackage.Type;

export const MossPayRailId = Schema.Literals(["wechat_pay", "stripe_checkout"]);
export type MossPayRailId = typeof MossPayRailId.Type;

export const MossPayPaymentMethod = Schema.Struct({
  id: MossPayRailId,
  displayName: Schema.String,
  kind: Schema.Literals(["qr", "hosted"]),
});
export type MossPayPaymentMethod = typeof MossPayPaymentMethod.Type;

/** Exact nano-CNY amounts never pass through JavaScript floating point. */
export const MossMediaNanoCny = Schema.String.check(
  Schema.makeFilter(
    (value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
  ),
);

export const MossPayMediaWallet = Schema.Struct({
  walletKind: Schema.Literals(["media_cost_v1"]),
  currency: Schema.Literals(["CNY"]),
  pointsPerCny: Schema.Literals([100]),
  availableNanoCny: MossMediaNanoCny,
  heldNanoCny: MossMediaNanoCny,
  /** Missing only on older deployments. Reviews never imply a completed refund. */
  reviewRequired: Schema.optional(Schema.Boolean),
});
export type MossPayMediaWallet = typeof MossPayMediaWallet.Type;

export const MossPayMediaTopupPackage = Schema.Struct({
  code: TrimmedNonEmptyString,
  displayName: Schema.String,
  currency: Schema.Literals(["CNY", "USD"]),
  amountMinor: PositiveInt,
  rail: MossPayRailId,
  available: Schema.Boolean,
  creditNanoCny: Schema.NullOr(MossMediaNanoCny),
  fxVersion: Schema.NullOr(TrimmedNonEmptyString),
});
export type MossPayMediaTopupPackage = typeof MossPayMediaTopupPackage.Type;

export const MossPayCatalog = Schema.Struct({
  plans: Schema.Array(MossPayPlan),
  pointPackages: Schema.Array(MossPayPointPackage),
  /** Exactly one rail, chosen by the verified account realm. The client never picks. */
  paymentMethods: Schema.Array(MossPayPaymentMethod),
  /** Independent media cost wallet; absent while a regional deployment rolls out. */
  mediaTopupPackages: Schema.optional(Schema.Array(MossPayMediaTopupPackage)),
  mediaWallet: Schema.optional(Schema.NullOr(MossPayMediaWallet)),
});
export type MossPayCatalog = typeof MossPayCatalog.Type;

export const MossPayCreateOrderInput = Schema.Struct({
  orderType: MossPayOrderType,
  itemCode: TrimmedNonEmptyString,
  /** Required by the server for media_topup; retry an uncertain request with the same key. */
  idempotencyKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type MossPayCreateOrderInput = typeof MossPayCreateOrderInput.Type;

export const MossPayOrder = Schema.Struct({
  outTradeNo: Schema.String,
  orderType: MossPayOrderType,
  itemCode: Schema.String,
  amountCny: Schema.Number,
  /** Exact settled minor units used to derive the revenue-backed cost budget. */
  amountMinor: Schema.Number,
  currency: Schema.Literals(["CNY", "USD"]),
  status: Schema.String,
  rail: Schema.optional(MossPayRailId),
  codeUrl: Schema.NullOr(Schema.String),
  checkoutUrl: Schema.NullOr(Schema.String),
  mediaCreditNanoCny: Schema.optional(MossMediaNanoCny),
  fxVersion: Schema.optional(TrimmedNonEmptyString),
  identityRealm: Schema.optional(Schema.Literals(["memfire-phone", "supabase-google"])),
  checkoutError: Schema.optional(Schema.NullOr(Schema.String)),
  refundReviewRequired: Schema.optional(Schema.Boolean),
});
export type MossPayOrder = typeof MossPayOrder.Type;

export function isMossPayOrderSettled(status: string, refundReviewRequired = false): boolean {
  return status === "fulfilled" && !refundReviewRequired;
}

export const MossPayGetOrderInput = Schema.Struct({
  outTradeNo: TrimmedNonEmptyString,
});
export type MossPayGetOrderInput = typeof MossPayGetOrderInput.Type;

export const MossPayQuotaPolicyMode = Schema.Literals(["metered", "unlimited", "unavailable"]);
export type MossPayQuotaPolicyMode = typeof MossPayQuotaPolicyMode.Type;

export const MossPayBillingModel = Schema.Literals([
  "cost_budget_v1",
  "weighted_credits_v1",
  "legacy_tokens",
]);
export type MossPayBillingModel = typeof MossPayBillingModel.Type;

export const MossPayUsageWindowKey = Schema.Literals([
  "five_hour",
  "weekly",
  "monthly",
  "lifetime",
]);
export type MossPayUsageWindowKey = typeof MossPayUsageWindowKey.Type;

export const MossPayUsageLimit = Schema.Struct({
  key: MossPayUsageWindowKey,
  /** Exact provider/accounting window duration when known. */
  durationSeconds: Schema.NullOr(PositiveInt),
  /** Provider-cost cents for cost v1, weighted credits for v1, or legacy tokens. */
  limit: Schema.NullOr(Schema.Number),
  used: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type MossPayUsageLimit = typeof MossPayUsageLimit.Type;

// 账号当前额度与积分快照（账号页展示用）。
export const MossPayQuota = Schema.Struct({
  planCode: Schema.NullOr(Schema.String),
  billingModel: MossPayBillingModel,
  /** Canonical Codex-style windows, ordered by the server. */
  usageLimits: Schema.Array(MossPayUsageLimit),
  /** Explicit policy state; unavailable is never inferred as unlimited. */
  quotaPolicyMode: MossPayQuotaPolicyMode,
  periodStart: Schema.NullOr(IsoDateTime),
  periodEnd: Schema.NullOr(IsoDateTime),
  /** Opaque provider identity for this exact window; never synthesized by the client. */
  windowId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /**
   * Opaque server role/source for the window (for example `weekly` or `primary`).
   * Clients must not infer a natural calendar boundary from this value.
   */
  windowSource: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  /** Provider duration, or the exact difference between valid provider period bounds. */
  windowDurationSeconds: Schema.NullOr(PositiveInt),
  /**
   * Provider-defined token bound. Null never implies unlimited; only the
   * explicit unlimited policy with both request/token bounds null is unlimited.
   */
  tokenLimit: Schema.NullOr(Schema.Number),
  tokensUsed: Schema.Number,
  /** Provider-defined request bound. Null is unknown unless policy mode is explicitly unlimited. */
  requestLimit: Schema.NullOr(Schema.Number),
  requestsUsed: Schema.Number,
  creditBalance: Schema.Number,
  realtimeConfigured: Schema.Boolean,
  realtimeModelAllowlist: Schema.Array(Schema.String),
  realtimeCostLimitNanoUsd: Schema.NullOr(Schema.Number),
  realtimeCostUsedNanoUsd: Schema.Number,
  realtimeCostReservedNanoUsd: Schema.Number,
  realtimeSessionLimit: Schema.NullOr(Schema.Number),
  realtimeSessionsUsed: Schema.Number,
  realtimeEstimatedMinutesRemaining: Schema.NullOr(Schema.Number),
});
export type MossPayQuota = typeof MossPayQuota.Type;
