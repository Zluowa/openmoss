import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MossPayCreateOrderInput,
  MossPayMediaWallet,
  MossPayQuota,
  MossPayOrder,
  isMossPayOrderSettled,
} from "./mossPay";

const decodeQuota = Schema.decodeUnknownSync(MossPayQuota);

describe("media top-up wire contracts", () => {
  it("retains optional refund review and never treats paid or reviewed orders as applied purchases", () => {
    const value = {
      outTradeNo: "MOSSplan1",
      orderType: "plan",
      itemCode: "basic",
      amountCny: 4900,
      amountMinor: 4900,
      currency: "CNY",
      status: "fulfilled",
      codeUrl: null,
      checkoutUrl: null,
    };
    const decodeOrder = Schema.decodeUnknownSync(MossPayOrder);
    expect(decodeOrder(value).refundReviewRequired).toBeUndefined();
    expect(decodeOrder({ ...value, refundReviewRequired: true }).refundReviewRequired).toBe(true);
    expect(() => decodeOrder({ ...value, refundReviewRequired: "false" })).toThrow();
    expect(isMossPayOrderSettled("paid")).toBe(false);
    expect(isMossPayOrderSettled("fulfilled", true)).toBe(false);
    expect(isMossPayOrderSettled("fulfilled")).toBe(true);
  });
  it("keeps nano-CNY exact above the JavaScript safe integer limit", () => {
    const wallet = Schema.decodeUnknownSync(MossPayMediaWallet)({
      walletKind: "media_cost_v1",
      currency: "CNY",
      pointsPerCny: 100,
      availableNanoCny: "9007199254740993",
      heldNanoCny: "17",
    });
    expect(wallet.availableNanoCny).toBe("9007199254740993");
  });
  it.each([100, -1, "-1", "1.1", "1e9", "01", "NaN", "9223372036854775808"])(
    "rejects non-canonical monetary amounts: %j",
    (value) => {
      expect(() =>
        Schema.decodeUnknownSync(MossPayMediaWallet)({
          walletKind: "media_cost_v1",
          currency: "CNY",
          pointsPerCny: 100,
          availableNanoCny: value,
          heldNanoCny: "0",
        }),
      ).toThrow();
    },
  );
  it("supports independent media top-up and retains legacy input compatibility", () => {
    expect(
      Schema.decodeUnknownSync(MossPayCreateOrderInput)({
        orderType: "media_topup",
        itemCode: "cn-cny-10",
        idempotencyKey: "same-request-123",
      }),
    ).toMatchObject({ orderType: "media_topup", idempotencyKey: "same-request-123" });
    expect(
      Schema.decodeUnknownSync(MossPayCreateOrderInput)({ orderType: "plan", itemCode: "plus" }),
    ).toMatchObject({ orderType: "plan" });
  });
});

describe("MossPayQuota", () => {
  it("retains provider-defined quota-window identity and both usage meters", () => {
    expect(
      decodeQuota({
        planCode: "starter",
        billingModel: "weighted_credits_v1",
        usageLimits: [
          {
            key: "weekly",
            durationSeconds: 604_800,
            limit: 24,
            used: 3,
            resetsAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        quotaPolicyMode: "metered",
        periodStart: "2026-08-10T00:00:00.000Z",
        periodEnd: "2026-08-17T00:00:00.000Z",
        windowId: "provider-window-2026-08-10",
        windowSource: "provider-weekly",
        windowDurationSeconds: 604_800,
        tokenLimit: 100_000,
        tokensUsed: 12_345,
        requestLimit: 500,
        requestsUsed: 42,
        creditBalance: 8,
        realtimeConfigured: true,
        realtimeModelAllowlist: ["gpt-realtime"],
        realtimeCostLimitNanoUsd: 500_000_000,
        realtimeCostUsedNanoUsd: 100_000_000,
        realtimeCostReservedNanoUsd: 20_000_000,
        realtimeSessionLimit: 20,
        realtimeSessionsUsed: 3,
        realtimeEstimatedMinutesRemaining: 18,
      }),
    ).toMatchObject({
      periodStart: "2026-08-10T00:00:00.000Z",
      periodEnd: "2026-08-17T00:00:00.000Z",
      windowId: "provider-window-2026-08-10",
      windowSource: "provider-weekly",
      windowDurationSeconds: 604_800,
      tokenLimit: 100_000,
      tokensUsed: 12_345,
      requestLimit: 500,
      requestsUsed: 42,
    });
  });

  it("represents unavailable provider window metadata explicitly", () => {
    const quota = decodeQuota({
      planCode: null,
      billingModel: "legacy_tokens",
      usageLimits: [],
      quotaPolicyMode: "unavailable",
      periodStart: null,
      periodEnd: null,
      windowId: null,
      windowSource: null,
      windowDurationSeconds: null,
      tokenLimit: null,
      tokensUsed: 0,
      requestLimit: null,
      requestsUsed: 0,
      creditBalance: 0,
      realtimeConfigured: false,
      realtimeModelAllowlist: [],
      realtimeCostLimitNanoUsd: null,
      realtimeCostUsedNanoUsd: 0,
      realtimeCostReservedNanoUsd: 0,
      realtimeSessionLimit: null,
      realtimeSessionsUsed: 0,
      realtimeEstimatedMinutesRemaining: null,
    });

    expect(quota).toMatchObject({
      periodStart: null,
      periodEnd: null,
      windowId: null,
      windowSource: null,
      windowDurationSeconds: null,
    });
  });

  it("accepts cost-budget windows without inventing token or request limits", () => {
    expect(
      decodeQuota({
        planCode: "basic",
        billingModel: "cost_budget_v1",
        usageLimits: [
          {
            key: "monthly",
            durationSeconds: 2_678_400,
            limit: 420,
            used: 42,
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
        ],
        quotaPolicyMode: "metered",
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        windowId: "cost-window-basic",
        windowSource: "monthly",
        windowDurationSeconds: 2_678_400,
        tokenLimit: null,
        tokensUsed: 0,
        requestLimit: null,
        requestsUsed: 1,
        creditBalance: 4_855,
        realtimeConfigured: true,
        realtimeModelAllowlist: ["gpt-realtime-2.1"],
        realtimeCostLimitNanoUsd: 4_200_000_000,
        realtimeCostUsedNanoUsd: 0,
        realtimeCostReservedNanoUsd: 0,
        realtimeSessionLimit: 2_000,
        realtimeSessionsUsed: 0,
        realtimeEstimatedMinutesRemaining: null,
      }),
    ).toMatchObject({
      billingModel: "cost_budget_v1",
      quotaPolicyMode: "metered",
      tokenLimit: null,
      requestLimit: null,
    });
  });
});
