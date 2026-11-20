// FILE: MossQuotaExhaustedSurface.browser.tsx
// Purpose: Verifies quota recovery and composer layout in both languages and themes.
// Layer: Chat component browser tests

import "../../index.css";

import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { MossQuotaExhaustedSurface, type UsageLimitBanner } from "./MossQuotaExhaustedSurface";

const fixture = vi.hoisted(() => ({ locale: "zh-CN" as "en" | "zh-CN" }));
vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: fixture.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(fixture.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Record<string, string | number>,
      ) => actual.formatMossTranslation(fixture.locale, key, values),
    }),
  };
});

const resetAt = "2026-11-23T23:00:00Z";
const accountLabel = "Personal account";
const usageUrl = "https://chatgpt.com/codex/settings/usage";

it.each(
  (["light", "dark"] as const).flatMap((theme) =>
    (["en", "zh-CN"] as const).flatMap((locale) =>
      (["moss", "personal"] as const).map((lane) => ({ theme, locale, lane })),
    ),
  ),
)("renders and recovers from a $lane limit in $locale $theme", async ({ theme, locale, lane }) => {
  const moss = lane === "moss";
  fixture.locale = locale;
  document.documentElement.classList.toggle("dark", theme === "dark");
  await page.viewport(theme === "light" ? 920 : 390, 420);
  const onAction = vi.fn();
  const onSend = vi.fn();
  const limit: UsageLimitBanner = moss
    ? { lane, resetAt }
    : { lane, resetAt, accountLabel, usageUrl };
  const screen = await render(
    <main className="mx-auto flex max-w-2xl flex-col gap-2 p-3">
      <p>Partial answer still in the conversation</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <MossQuotaExhaustedSurface limit={limit} onAction={onAction} />
        <div className="flex gap-2">
          <Input aria-label="Message" />
          <Button type="submit">Send</Button>
        </div>
      </form>
    </main>,
  );
  try {
    const banner = page.getByRole("status");
    const editor = page.getByRole("textbox", { name: "Message" });
    const heading =
      locale === "zh-CN"
        ? moss
          ? "Moss 额度已用完"
          : `${accountLabel} 用量已达上限`
        : moss
          ? "Moss usage limit reached"
          : `${accountLabel} usage limit reached`;
    await expect.element(banner).toHaveTextContent(heading);
    await expect.element(banner).toHaveTextContent(locale === "zh-CN" ? "重置" : "Resets");
    await expect.element(page.getByText("Partial answer still in the conversation")).toBeVisible();
    const box = banner.element().getBoundingClientRect();
    expect(box.height).toBeGreaterThan(35);
    expect(box.bottom).toBeLessThan(editor.element().getBoundingClientRect().top);
    expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
    if (!moss) {
      await expect.element(banner.getByRole("link")).toHaveAttribute("href", usageUrl);
    } else {
      await expect.element(banner.getByRole("link")).not.toBeInTheDocument();
    }
    if (import.meta.env.VITE_MOSS_QUOTA_SHOTS) {
      await page.screenshot({
        path: `__screenshots__/quota-limit/quota-${lane}-${locale}-${theme}.png`,
      });
    }
    await userEvent.click(
      banner.getByRole("button", {
        name:
          locale === "zh-CN"
            ? moss
              ? "开通会员"
              : "切换到 Moss"
            : moss
              ? "Get membership"
              : "Switch to Moss",
      }),
    );
    expect(onAction).toHaveBeenCalledOnce();
    await userEvent.fill(editor, "Continue");
    await userEvent.click(page.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
    document.documentElement.classList.remove("dark");
  }
});
