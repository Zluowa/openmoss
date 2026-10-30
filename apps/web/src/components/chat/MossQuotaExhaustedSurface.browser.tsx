import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { MossQuotaAdmission } from "~/lib/mossQuotaAdmission";
import { MossQuotaExhaustedSurface } from "./MossQuotaExhaustedSurface";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "zh-CN" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("zh-CN", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Record<string, string | number>,
      ) => actual.formatMossTranslation("zh-CN", key, values),
    }),
  };
});

const exhaustedDecision = {
  kind: "exhausted",
  remainingPercent: 0,
  limit: 50,
  used: 50,
  resetAt: null,
  usagePeriod: "weekly",
  usageBasis: "hidden-cost",
} as Extract<MossQuotaAdmission, { kind: "exhausted" }>;

afterEach(() => {
  document.body.replaceChildren();
});

it("renders the hidden-cost inline banner without a blocking dialog and opens plans", async () => {
  const onOpenPlans = vi.fn();
  const screen = await render(
    <MossQuotaExhaustedSurface decision={exhaustedDecision} onOpenPlans={onOpenPlans} />,
  );

  try {
    await expect.element(page.getByRole("heading", { name: "额度不足" })).toBeVisible();
    const banner = page.getByTestId("moss-quota-exhausted-banner");
    await expect.element(banner).toBeVisible();
    expect(banner.element().getAttribute("role")).toBe("status");
    expect(banner.element().getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const plansButton = page.getByRole("button", { name: "查看套餐" });
    await expect.element(plansButton).toBeVisible();
    await userEvent.click(plansButton);
    expect(onOpenPlans).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
