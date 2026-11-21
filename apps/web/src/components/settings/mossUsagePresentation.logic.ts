// FILE: mossUsagePresentation.logic.ts
// Purpose: Pure presentation helpers for Settings → Usage & limits (reset countdowns,
//          quota meter tones, exhausted-limit detection, legacy-wallet visibility, and
//          per-product / per-model breakdown rows).
// Layer: Web settings logic (pure)
// Exports: formatMossResetCountdown, mossUsageLimitTone, findExhaustedMossQuotaWindow,
//          shouldShowLegacyCreditBalanceCard, buildUsageBreakdownRows

import type { MossPayQuota, MossPayUsageLimit } from "@moss/contracts";

import { isBuiltInFreeMossPlanCode } from "~/components/auth/MossMembershipPage.logic";
import type { MossLocaleCode } from "~/uiLocale";
import {
  PROVIDER_SERIES_COLOR,
  providerLabel,
  type UsageAnalyticsProvider,
  type UsageAnalyticsView,
} from "./usageAnalytics.logic";

export type MossUsageLimitTone = "healthy" | "warning" | "critical" | "exhausted";

export function mossUsageLimitRemainingPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return used <= 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100)));
}

export function mossUsageLimitTone(remainingPercent: number): MossUsageLimitTone {
  if (remainingPercent <= 0) return "exhausted";
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "warning";
  return "healthy";
}

/**
 * Formats a human-readable reset countdown matching ChatGPT/Claude usage cards
 * (e.g. "6 天 13 小时后重置" / "Resets in 6d 13h"). Returns null when no valid
 * future reset instant exists.
 */
export function formatMossResetCountdown(
  resetsAt: string | null,
  locale: MossLocaleCode,
  nowMs = Date.now(),
): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const remainingSeconds = Math.ceil((resetMs - nowMs) / 1_000);
  if (remainingSeconds <= 0) {
    return locale === "zh-CN" ? "即将重置" : "Resets soon";
  }
  const totalMinutes = Math.ceil(remainingSeconds / 60);
  if (totalMinutes < 60) {
    return locale === "zh-CN" ? `${totalMinutes} 分钟后重置` : `Resets in ${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    if (minutes === 0) {
      return locale === "zh-CN" ? `${totalHours} 小时后重置` : `Resets in ${totalHours}h`;
    }
    return locale === "zh-CN"
      ? `${totalHours} 小时 ${minutes} 分钟后重置`
      : `Resets in ${totalHours}h ${minutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours === 0) {
    return locale === "zh-CN" ? `${days} 天后重置` : `Resets in ${days}d`;
  }
  return locale === "zh-CN" ? `${days} 天 ${hours} 小时后重置` : `Resets in ${days}d ${hours}h`;
}

export interface ExhaustedMossQuotaWindow {
  readonly key: MossPayUsageLimit["key"];
  readonly resetsAt: string | null;
}

/**
 * Finds the first metered Moss window that has reached 0% remaining (100% used).
 * Returns null for unlimited accounts or when every metered window still has room.
 */
export function findExhaustedMossQuotaWindow(
  quota: Pick<MossPayQuota, "usageLimits" | "periodEnd"> | undefined,
  unlimited: boolean,
): ExhaustedMossQuotaWindow | null {
  if (!quota || unlimited) return null;
  for (const limit of quota.usageLimits) {
    const remaining = mossUsageLimitRemainingPercent(limit.used, limit.limit);
    if (remaining === 0) {
      return {
        key: limit.key,
        resetsAt: limit.resetsAt ?? quota.periodEnd,
      };
    }
  }
  return null;
}

/**
 * Only legacy weighted-credit / non-free legacy-token snapshots render the historical
 * credit-balance section. Free starter accounts (`wallet_credits_v1` / `starter-trial`),
 * modern cost-budget plans (`cost_budget_v1`), and errored/unloaded states never show it.
 */
export function shouldShowLegacyCreditBalanceCard(
  quota: Pick<MossPayQuota, "billingModel" | "planCode"> | undefined,
): boolean {
  if (!quota) return false;
  if (quota.billingModel === "wallet_credits_v1" || quota.billingModel === "cost_budget_v1") {
    return false;
  }
  if (isBuiltInFreeMossPlanCode(quota.planCode)) {
    return false;
  }
  return true;
}

const MEDIA_MODEL_PATTERN =
  /(?:seedream|seedance|nano-banana|flux|dall-e|gpt-image|imagen|midjourney|sora|veo|kling|runway|video|image-gen)/iu;

export interface UsageProductBreakdownRow {
  readonly id: string;
  readonly kind: "provider" | "media" | "voice";
  readonly provider?: UsageAnalyticsProvider;
  readonly label: string;
  readonly percent: number;
  readonly tokens: number;
  readonly turns: number;
  readonly sessions?: number;
  readonly color: string;
}

export interface UsageModelBreakdownRow {
  readonly id: string;
  readonly provider: UsageAnalyticsProvider;
  readonly model: string;
  readonly percent: number;
  readonly tokens: number;
  readonly turns: number;
  readonly color: string;
}

export interface UsageBreakdownSummary {
  readonly products: ReadonlyArray<UsageProductBreakdownRow>;
  readonly models: ReadonlyArray<UsageModelBreakdownRow>;
}

/**
 * Builds per-product (Codex, Claude, Gemini, Images & video, Realtime Voice) and
 * top-model breakdown rows for the Settings → Usage overview card.
 */
export function buildUsageBreakdownRows(input: {
  readonly view: UsageAnalyticsView;
  readonly otherLabel: string;
  readonly mediaLabel: string;
  readonly voiceLabel: string;
  readonly realtimeSessionsUsed?: number;
  readonly maxModels?: number;
}): UsageBreakdownSummary {
  const { view } = input;
  const totalTokens = view.totals.tokens;
  const totalTurns = view.totals.turns;

  // Separate image/video generation models (if any appear in local records) so users see
  // media usage clearly alongside agent lanes.
  let mediaTokens = 0;
  let mediaTurns = 0;
  const nonMediaTokensByProvider = new Map<
    UsageAnalyticsProvider,
    { tokens: number; turns: number }
  >();

  for (const model of view.models) {
    if (model.tokens <= 0 && model.turns <= 0) continue;
    if (MEDIA_MODEL_PATTERN.test(model.model)) {
      mediaTokens += model.tokens;
      mediaTurns += model.turns;
      continue;
    }
    const existing = nonMediaTokensByProvider.get(model.provider) ?? { tokens: 0, turns: 0 };
    existing.tokens += model.tokens;
    existing.turns += model.turns;
    nonMediaTokensByProvider.set(model.provider, existing);
  }

  // Fall back to view.providers when models list has no split (e.g. provider-only summary).
  const rawProducts: Array<Omit<UsageProductBreakdownRow, "percent">> = [];
  if (nonMediaTokensByProvider.size > 0 || mediaTokens > 0 || mediaTurns > 0) {
    for (const [provider, amount] of nonMediaTokensByProvider.entries()) {
      rawProducts.push({
        id: `provider:${provider}`,
        kind: "provider",
        provider,
        label: providerLabel(provider, input.otherLabel),
        tokens: amount.tokens,
        turns: amount.turns,
        color: PROVIDER_SERIES_COLOR[provider],
      });
    }
    if (mediaTokens > 0 || mediaTurns > 0) {
      rawProducts.push({
        id: "product:media",
        kind: "media",
        label: input.mediaLabel,
        tokens: mediaTokens,
        turns: mediaTurns,
        color: "var(--warning)",
      });
    }
  } else {
    for (const provider of view.providers) {
      if (provider.tokens <= 0 && provider.turns <= 0) continue;
      rawProducts.push({
        id: `provider:${provider.provider}`,
        kind: "provider",
        provider: provider.provider,
        label: providerLabel(provider.provider, input.otherLabel),
        tokens: provider.tokens,
        turns: provider.turns,
        color: PROVIDER_SERIES_COLOR[provider.provider],
      });
    }
  }

  const denominator = totalTokens > 0 ? totalTokens : totalTurns;
  const products: UsageProductBreakdownRow[] = rawProducts
    .map((row) => {
      const value = totalTokens > 0 ? row.tokens : row.turns;
      const percent = denominator > 0 ? Math.round((value / denominator) * 100) : 0;
      return { ...row, percent };
    })
    .toSorted((left, right) => right.tokens - left.tokens || right.turns - left.turns);

  if (input.realtimeSessionsUsed && input.realtimeSessionsUsed > 0) {
    products.push({
      id: "product:voice",
      kind: "voice",
      label: input.voiceLabel,
      percent: products.length === 0 ? 100 : 0,
      tokens: 0,
      turns: input.realtimeSessionsUsed,
      sessions: input.realtimeSessionsUsed,
      color: "var(--success)",
    });
  }

  const maxModels = input.maxModels ?? 5;
  const models: UsageModelBreakdownRow[] = view.models
    .filter((entry) => entry.tokens > 0 || entry.turns > 0)
    .toSorted((left, right) => right.tokens - left.tokens || right.turns - left.turns)
    .slice(0, maxModels)
    .map((entry) => {
      const value = totalTokens > 0 ? entry.tokens : entry.turns;
      const percent = denominator > 0 ? Math.round((value / denominator) * 100) : 0;
      return {
        id: `${entry.provider}:${entry.model}`,
        provider: entry.provider,
        model: entry.model,
        percent,
        tokens: entry.tokens,
        turns: entry.turns,
        color: PROVIDER_SERIES_COLOR[entry.provider],
      };
    });

  return { products, models };
}
