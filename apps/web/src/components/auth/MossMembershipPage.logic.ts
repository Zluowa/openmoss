// FILE: MossMembershipPage.logic.ts
// Purpose: Pure membership-catalog presentation rules kept outside the React refresh boundary.

import type { MossPayPlan } from "@synara/contracts";

import type { MossLocaleCode } from "~/uiLocale";

export function formatMossMembershipPriceNumber(cents: number, locale: MossLocaleCode): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(Math.max(0, cents) / 100);
}

export function isCurrentMossPlan(
  currentPlanCode: string | null | undefined,
  candidatePlanCode: string,
): boolean {
  const current = currentPlanCode?.trim() ?? "";
  return current.length > 0 && current === candidatePlanCode;
}

export function visibleMossMembershipPlans(plans: readonly MossPayPlan[]): readonly MossPayPlan[] {
  return plans
    .filter((plan) => plan.monthlyPriceCny > 0)
    .toSorted((left, right) => left.sortOrder - right.sortOrder);
}

export function mossMembershipPlanName(plan: Pick<MossPayPlan, "code" | "displayName">): string {
  return (
    ({ basic: "Basic", plus: "Plus", pro: "Pro", max: "Max" } as const)[
      plan.code as "basic" | "plus" | "pro" | "max"
    ] ?? plan.displayName
  );
}

export function mossMembershipAgentUsageMultiplier(
  plan: Pick<MossPayPlan, "monthlyPriceCny">,
  basicMonthlyPriceCny: number,
): number {
  if (
    !Number.isFinite(plan.monthlyPriceCny) ||
    plan.monthlyPriceCny <= 0 ||
    !Number.isFinite(basicMonthlyPriceCny) ||
    basicMonthlyPriceCny <= 0
  ) {
    return 1;
  }
  return Math.max(1, Math.floor(plan.monthlyPriceCny / basicMonthlyPriceCny));
}

export function safeMossPayOrderErrorMessage(_error: unknown, locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "支付服务暂时不可用，请稍后重试。"
    : "The payment service is temporarily unavailable. Try again shortly.";
}
