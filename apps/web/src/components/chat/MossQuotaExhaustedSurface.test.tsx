import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MossQuotaAdmission } from "~/lib/mossQuotaAdmission";
import { MossQuotaExhaustedSurface } from "./MossQuotaExhaustedSurface";

const localeState = vi.hoisted(() => ({ locale: "zh-CN" as "en" | "zh-CN" }));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localeState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localeState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Record<string, string | number>,
      ) => actual.formatMossTranslation(localeState.locale, key, values),
    }),
  };
});

const decision = (overrides: Partial<Extract<MossQuotaAdmission, { kind: "exhausted" }>> = {}) =>
  ({
    kind: "exhausted",
    remainingPercent: 0,
    limit: 50,
    used: 50,
    resetAt: "2026-08-24T00:00:00.000Z",
    usagePeriod: "weekly",
    usageBasis: "hidden-cost",
    ...overrides,
  }) as Extract<MossQuotaAdmission, { kind: "exhausted" }>;

describe("MossQuotaExhaustedSurface", () => {
  it("renders the Chinese hidden-cost state and internal plan CTA", () => {
    localeState.locale = "zh-CN";
    const markup = renderToStaticMarkup(
      <MossQuotaExhaustedSurface decision={decision()} onOpenPlans={() => undefined} />,
    );

    expect(markup).toContain("额度不足");
    expect(markup).toContain("当前套餐已不足以支持下一次调用");
    expect(markup).toContain('data-testid="moss-quota-open-plans"');
    expect(markup).toContain("查看套餐");
    expect(markup).toContain("重置时间");
    expect(markup).not.toMatch(/(?:token|USD|成本|¥|￥)/u);
  });

  it("does not render reset copy when reset evidence is invalid", () => {
    localeState.locale = "zh-CN";
    const markup = renderToStaticMarkup(
      <MossQuotaExhaustedSurface
        decision={decision({ resetAt: null })}
        onOpenPlans={() => undefined}
      />,
    );

    expect(markup).not.toContain("重置时间");
    expect(markup).not.toContain("2026");
  });

  it("keeps English Moss-owned copy and labels non-weekly windows honestly", () => {
    localeState.locale = "en";
    const markup = renderToStaticMarkup(
      <MossQuotaExhaustedSurface
        decision={decision({ usagePeriod: "period" })}
        onOpenPlans={() => undefined}
      />,
    );

    expect(markup).toContain("Not enough usage left");
    expect(markup).toContain("View plans");
    expect(markup).not.toContain("Weekly usage limit");
    const expectedResetDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(decision().resetAt!));
    expect(markup).toContain(`Resets ${expectedResetDate}`);
  });
});
