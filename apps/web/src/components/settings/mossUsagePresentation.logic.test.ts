import type { MossPayQuota, StatsGetUsageAnalyticsResult } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUsageBreakdownRows,
  findExhaustedMossQuotaWindow,
  formatMossResetCountdown,
  mossUsageLimitTone,
  shouldShowLegacyCreditBalanceCard,
} from "./mossUsagePresentation.logic";
import { buildUsageAnalyticsView, usageAnalyticsWindow } from "./usageAnalytics.logic";

describe("formatMossResetCountdown", () => {
  const NOW = Date.parse("2026-11-22T00:00:00.000Z");

  it("formats days and hours in Chinese and English", () => {
    const resetsAt = new Date(NOW + (6 * 24 + 13) * 3_600_000).toISOString();
    expect(formatMossResetCountdown(resetsAt, "zh-CN", NOW)).toBe("6 天 13 小时后重置");
    expect(formatMossResetCountdown(resetsAt, "en", NOW)).toBe("Resets in 6d 13h");
  });

  it("formats hours and minutes for short windows such as 5-hour limits", () => {
    const resetsAt = new Date(NOW + (3 * 60 + 25) * 60_000).toISOString();
    expect(formatMossResetCountdown(resetsAt, "zh-CN", NOW)).toBe("3 小时 25 分钟后重置");
    expect(formatMossResetCountdown(resetsAt, "en", NOW)).toBe("Resets in 3h 25m");
  });

  it("handles minutes, imminent resets, and missing timestamps", () => {
    expect(formatMossResetCountdown(new Date(NOW + 18 * 60_000).toISOString(), "zh-CN", NOW)).toBe(
      "18 分钟后重置",
    );
    expect(formatMossResetCountdown(new Date(NOW - 10_000).toISOString(), "zh-CN", NOW)).toBe(
      "即将重置",
    );
    expect(formatMossResetCountdown(new Date(NOW - 10_000).toISOString(), "en", NOW)).toBe(
      "Resets soon",
    );
    expect(formatMossResetCountdown(null, "zh-CN", NOW)).toBeNull();
    expect(formatMossResetCountdown("not-a-date", "en", NOW)).toBeNull();
  });
});

describe("mossUsageLimitTone", () => {
  it("classifies exhausted, critical, warning, and healthy thresholds", () => {
    expect(mossUsageLimitTone(0)).toBe("exhausted");
    expect(mossUsageLimitTone(1)).toBe("critical");
    expect(mossUsageLimitTone(10)).toBe("critical");
    expect(mossUsageLimitTone(11)).toBe("warning");
    expect(mossUsageLimitTone(25)).toBe("warning");
    expect(mossUsageLimitTone(26)).toBe("healthy");
    expect(mossUsageLimitTone(100)).toBe("healthy");
  });
});

describe("findExhaustedMossQuotaWindow & shouldShowLegacyCreditBalanceCard", () => {
  const baseQuota = (overrides: Partial<MossPayQuota> = {}): MossPayQuota => ({
    planCode: "basic",
    billingModel: "cost_budget_v1",
    usageLimits: [
      {
        key: "five_hour",
        durationSeconds: 18_000,
        limit: 12,
        used: 3,
        resetsAt: "2026-11-22T05:00:00.000Z",
      },
      {
        key: "weekly",
        durationSeconds: 604_800,
        limit: 24,
        used: 24,
        resetsAt: "2026-11-28T00:00:00.000Z",
      },
    ],
    quotaPolicyMode: "metered",
    periodStart: "2026-11-21T00:00:00.000Z",
    periodEnd: "2026-11-28T00:00:00.000Z",
    windowId: "w-1",
    windowSource: "weekly",
    windowDurationSeconds: 604_800,
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
    ...overrides,
  });

  it("detects the exhausted window on metered plans and ignores unlimited plans", () => {
    expect(findExhaustedMossQuotaWindow(baseQuota(), false)).toEqual({
      key: "weekly",
      resetsAt: "2026-11-28T00:00:00.000Z",
    });
    expect(findExhaustedMossQuotaWindow(baseQuota(), true)).toBeNull();
    expect(
      findExhaustedMossQuotaWindow(
        baseQuota({
          usageLimits: [
            { key: "weekly", durationSeconds: 604_800, limit: 24, used: 12, resetsAt: null },
          ],
        }),
        false,
      ),
    ).toBeNull();
  });

  it("never shows the legacy credit balance card on errors, free tier, or cost-budget plans", () => {
    expect(shouldShowLegacyCreditBalanceCard(undefined)).toBe(false);
    expect(
      shouldShowLegacyCreditBalanceCard({
        billingModel: "wallet_credits_v1",
        planCode: "starter-trial",
      }),
    ).toBe(false);
    expect(
      shouldShowLegacyCreditBalanceCard({ billingModel: "cost_budget_v1", planCode: "plus" }),
    ).toBe(false);
    expect(
      shouldShowLegacyCreditBalanceCard({
        billingModel: "legacy_tokens",
        planCode: "starter-trial",
      }),
    ).toBe(false);
    expect(
      shouldShowLegacyCreditBalanceCard({ billingModel: "weighted_credits_v1", planCode: "basic" }),
    ).toBe(true);
  });
});

describe("buildUsageBreakdownRows", () => {
  it("groups provider activity, separates media models, and ranks top models by share", () => {
    const now = new Date("2026-11-22T12:00:00");
    const window = usageAnalyticsWindow("7d", now);
    const sampleHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10).toISOString();
    const result: StatsGetUsageAnalyticsResult = {
      generatedAt: "2026-11-22T00:00:00.000Z",
      scope: "moss",
      from: window.previousFrom!.toISOString(),
      to: window.to.toISOString(),
      projects: [],
      tokens: [
        {
          hour: sampleHour,
          origin: "user",
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          projectId: null,
          tokens: 60_000,
          cacheReadTokens: 10_000,
          unpricedTokens: 0,
          unsplitTokens: 0,
        },
        {
          hour: sampleHour,
          origin: "user",
          provider: "codex",
          model: "gpt-5.4",
          projectId: null,
          tokens: 30_000,
          cacheReadTokens: 2_000,
          unpricedTokens: 0,
          unsplitTokens: 0,
        },
        {
          hour: sampleHour,
          origin: "user",
          provider: "codex",
          model: "doubao-seedream-4",
          projectId: null,
          tokens: 10_000,
          cacheReadTokens: 0,
          unpricedTokens: 0,
          unsplitTokens: 0,
        },
      ],
      turns: [
        {
          hour: sampleHour,
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          projectId: null,
          turns: 12,
          failedTurns: 0,
        },
        {
          hour: sampleHour,
          provider: "codex",
          model: "gpt-5.4",
          projectId: null,
          turns: 8,
          failedTurns: 0,
        },
        {
          hour: sampleHour,
          provider: "codex",
          model: "doubao-seedream-4",
          projectId: null,
          turns: 4,
          failedTurns: 0,
        },
      ],
      costs: [],
      unavailableProviders: [],
      sessionFileProviders: [],
      pricing: { status: "bundled", fetchedAt: null },
    };

    const view = buildUsageAnalyticsView(result, window);
    const breakdown = buildUsageBreakdownRows({
      view,
      otherLabel: "其他",
      mediaLabel: "图片与视频",
      voiceLabel: "实时语音",
      realtimeSessionsUsed: 3,
    });

    expect(breakdown.products.map((row) => [row.label, row.percent])).toEqual([
      ["Claude", 60],
      ["Codex", 30],
      ["图片与视频", 10],
      ["实时语音", 0],
    ]);
    expect(breakdown.products[3]?.sessions).toBe(3);
    expect(breakdown.models.map((row) => [row.model, row.percent])).toEqual([
      ["claude-opus-4-6", 60],
      ["gpt-5.4", 30],
      ["doubao-seedream-4", 10],
    ]);
  });
});
