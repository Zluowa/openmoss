import type { MossPayPlan } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  formatMossMembershipPriceNumber,
  isCurrentMossPlan,
  mossMembershipAgentUsageMultiplier,
  mossMembershipPlanName,
  visibleMossMembershipPlans,
} from "./MossMembershipPage.logic";

function plan(code: string, sortOrder: number, monthlyPriceCny = 4_900): MossPayPlan {
  return {
    code,
    displayName: code,
    monthlyPriceCny,
    monthlyCreditLimit: 87,
    fiveHourCreditLimit: 12,
    weeklyCreditLimit: 24,
    standardTaskEstimate: 30,
    billingModel: "weighted_credits_v1",
    monthlyTokenLimit: 5_000_000,
    monthlyRequestLimit: 2_000,
    modelAllowlist: [],
    monthlyRealtimeCostLimitNanoUsd: 0,
    monthlyRealtimeSessionLimit: 0,
    realtimeModelAllowlist: [],
    estimatedRealtimeMinutes: 0,
    sortOrder,
  };
}

describe("Moss membership catalog rules", () => {
  it("keeps the CNY symbol separate without duplicating it in English", () => {
    expect(formatMossMembershipPriceNumber(4_900, "zh-CN")).toBe("49");
    expect(formatMossMembershipPriceNumber(4_900, "en")).toBe("49");
    expect(formatMossMembershipPriceNumber(990, "en")).toBe("9.90");
  });

  it("marks a plan current only for an exact authoritative plan code", () => {
    expect(isCurrentMossPlan("basic", "basic")).toBe(true);
    expect(isCurrentMossPlan("starter-trial", "basic")).toBe(false);
    expect(isCurrentMossPlan(null, "basic")).toBe(false);
  });

  it("keeps the four product tier names canonical across regional catalogs", () => {
    expect(mossMembershipPlanName({ code: "max", displayName: "最大" })).toBe("Max");
    expect(mossMembershipPlanName({ code: "enterprise", displayName: "Enterprise" })).toBe(
      "Enterprise",
    );
  });

  it("expresses Agent usage as a price-backed multiple of Basic", () => {
    expect(mossMembershipAgentUsageMultiplier({ monthlyPriceCny: 4_900 }, 4_900)).toBe(1);
    expect(mossMembershipAgentUsageMultiplier({ monthlyPriceCny: 9_900 }, 4_900)).toBe(2);
    expect(mossMembershipAgentUsageMultiplier({ monthlyPriceCny: 19_900 }, 4_900)).toBe(4);
    expect(mossMembershipAgentUsageMultiplier({ monthlyPriceCny: 69_900 }, 4_900)).toBe(14);
    expect(mossMembershipAgentUsageMultiplier({ monthlyPriceCny: Number.NaN }, 4_900)).toBe(1);
  });

  it("keeps only priced personal SKUs and preserves server ordering", () => {
    expect(
      visibleMossMembershipPlans([
        plan("max", 40),
        plan("trial", 0, 0),
        plan("basic", 10),
        plan("plus", 20),
      ]).map((entry) => entry.code),
    ).toEqual(["basic", "plus", "max"]);
  });
});
