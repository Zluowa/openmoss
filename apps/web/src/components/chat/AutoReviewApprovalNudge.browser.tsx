// FILE: AutoReviewApprovalNudge.browser.tsx
// Purpose: Browser coverage for Auto-review nudge actions, pending guard, and retry path.

import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { toastManager } from "../ui/toast";
import { buildThemeCssVariables, DEFAULT_CHROME_THEME_BY_VARIANT } from "../../theme/theme.logic";
import { AUTO_REVIEW_LEARN_MORE_URL, AutoReviewApprovalNudge } from "./AutoReviewApprovalNudge";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("en", key, values),
    }),
  };
});

describe("AutoReviewApprovalNudge", () => {
  let previousStyle: string;
  beforeEach(() => {
    previousStyle = document.documentElement.style.cssText;
    const { variables } = buildThemeCssVariables(
      { codeThemeId: "codex", theme: DEFAULT_CHROME_THEME_BY_VARIANT.light },
      "light",
    );
    for (const [name, value] of Object.entries(variables)) {
      document.documentElement.style.setProperty(name, value);
    }
  });
  afterEach(() => {
    document.documentElement.style.cssText = previousStyle;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders the exact contract, autofocuses enable, scopes Enter, and dismisses", async () => {
    const onDismiss = vi.fn();
    const onEnable = vi.fn(async () => undefined);
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    const screen = await render(
      <AutoReviewApprovalNudge onDismiss={onDismiss} onEnable={onEnable} />,
    );

    try {
      await expect.element(page.getByText("Want fewer approval prompts?")).toBeInTheDocument();
      await expect
        .element(
          page.getByText(
            "ChatGPT can automatically approve eligible actions while it works. This may use more credits.",
          ),
        )
        .toBeInTheDocument();
      const learnMore = page.getByRole("link", { name: "Learn more." });
      expect(learnMore.element()).toHaveAttribute("href", AUTO_REVIEW_LEARN_MORE_URL);

      const enable = page.getByRole("button", { name: /Approve for me/u });
      expect(getComputedStyle(enable.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      await expect.poll(() => document.activeElement).toBe(enable.element());
      outside.focus();
      await userEvent.keyboard("{Enter}");
      expect(onEnable).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Keep manual approvals" }).click();
      expect(onDismiss).toHaveBeenCalledTimes(1);
      outside.remove();
    } finally {
      await screen.unmount();
      outside.remove();
    }
  });

  it("guards both actions while enabling is pending", async () => {
    let resolveEnable: (() => void) | undefined;
    const onEnable = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEnable = resolve;
        }),
    );
    const onDismiss = vi.fn();
    const screen = await render(
      <AutoReviewApprovalNudge onDismiss={onDismiss} onEnable={onEnable} />,
    );

    try {
      const enable = page.getByRole("button", { name: /Approve for me/u });
      const dismiss = page.getByRole("button", { name: "Keep manual approvals" });
      enable.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(enable).toBeDisabled();
      await expect.element(dismiss).toBeDisabled();
      // Native form submissions in the same render must share the pending guard.
      const form = enable.element().closest("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await enable.click({ force: true });
      await dismiss.click({ force: true });
      expect(onEnable).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();

      resolveEnable?.();
      await expect.element(enable).toBeEnabled();
      await dismiss.click();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("toasts the exact failure and allows a retry", async () => {
    const toastSpy = vi
      .spyOn(toastManager, "add")
      .mockImplementation(() => "auto-review-enable-failed" as never);
    const onEnable = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("mode switch failed"))
      .mockResolvedValueOnce(undefined);
    const screen = await render(
      <AutoReviewApprovalNudge onDismiss={() => {}} onEnable={onEnable} />,
    );

    try {
      const enable = page.getByRole("button", { name: /Approve for me/u });
      await enable.click();
      await expect.poll(() => toastSpy.mock.calls.length).toBe(1);
      expect(toastSpy).toHaveBeenCalledWith({
        type: "error",
        title: "Could not enable Auto-review — try again",
      });
      await expect.element(enable).toBeEnabled();

      await enable.click();
      await expect.poll(() => onEnable.mock.calls.length).toBe(2);
      expect(toastSpy).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
