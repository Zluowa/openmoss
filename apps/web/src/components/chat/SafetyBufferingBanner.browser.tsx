import "../../index.css";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../theme/theme.logic";
import { TurnId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SAFETY_BUFFERING_DISMISSED_KEY, SafetyBufferingBanner } from "./SafetyBufferingBanner";
import type { SafetyBufferingState } from "./safetyBuffering";

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
const state: SafetyBufferingState = {
  turnId: TurnId.makeUnsafe("safety-turn"),
  model: "current-model",
  fasterModel: "faster-model",
  reasons: ["user_risk"],
  useCases: ["cyber"],
};
const shot = (name: string) =>
  page.screenshot({ path: `../../../../../.tmp/ui-parity/parity5/pass5-moss-${name}.png` });
let previousRootStyle: string | null;
beforeEach(async () => {
  previousRootStyle = document.documentElement.getAttribute("style");
  const { variables } = buildThemeCssVariables(
    resolveThemePack(DEFAULT_THEME_STATE, "light"),
    "light",
  );
  for (const [name, value] of Object.entries(variables))
    document.documentElement.style.setProperty(name, value);
  localStorage.removeItem(SAFETY_BUFFERING_DISMISSED_KEY);
  await page.viewport(960, 720);
});

afterEach(() => {
  if (previousRootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", previousRootStyle);
});

describe("safety buffering banner", () => {
  it("confirms retry, preserves the current attempt when cancelled, and guards duplicate clicks", async () => {
    let complete: (() => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const screen = await render(
      <div style={{ width: 736, padding: 24 }}>
        <SafetyBufferingBanner
          threadId="thread"
          state={state}
          canRetry
          onRetry={onRetry}
          fasterModelName="Faster Model"
        />
      </div>,
    );
    try {
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("Giving this request a little extra thought");
      await expect.element(page.getByRole("status")).toHaveAttribute("aria-live", "polite");
      await shot("safety-buffering-active");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect
        .element(page.getByRole("dialog"))
        .toHaveTextContent("Any file changes or other actions already taken will remain.");
      await expect.element(page.getByRole("dialog")).toHaveTextContent("using Faster Model");
      await shot("safety-buffering-retry-confirmation");
      await page.getByRole("button", { name: "Keep waiting" }).click();
      expect(onRetry).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByRole("button", { name: "Stop and retry" }).click();
      expect(onRetry).toHaveBeenCalledExactlyOnceWith(state.turnId);
      await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeDisabled();
      complete?.();
      await expect
        .element(page.getByRole("button", { name: "Retry", exact: true }))
        .not.toBeDisabled();
    } finally {
      complete?.();
      await screen.unmount();
    }
  });

  it.each([false, true])(
    "omits unsupported retry and its description (capability %s)",
    async (canRetry) => {
      const screen = await render(
        <SafetyBufferingBanner
          threadId="thread"
          state={{ ...state, fasterModel: canRetry ? null : state.fasterModel }}
          canRetry={canRetry}
          onRetry={vi.fn()}
        />,
      );
      try {
        await expect.element(page.getByRole("status")).toBeVisible();
        expect(document.body.textContent).not.toContain("If you'd rather not wait");
        await expect
          .element(page.getByRole("button", { name: "Retry", exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("dismisses this turn, keeps a new turn visible, and does not reopen stale confirmation", async () => {
    const banner = (value: SafetyBufferingState | null) => (
      <SafetyBufferingBanner threadId="thread" state={value} canRetry onRetry={vi.fn()} />
    );
    const screen = await render(banner(state));
    try {
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await screen.rerender(banner(null));
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      const next = { ...state, turnId: TurnId.makeUnsafe("next-turn") };
      await screen.rerender(banner(next));
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.getByRole("menuitem", { name: "This time", exact: true }).click();
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-testid=safety-buffering-banner]")?.closest("[inert]"),
      ).not.toBeNull();
      await screen.rerender(banner({ ...next, turnId: TurnId.makeUnsafe("third-turn") }));
      await expect.element(page.getByRole("status")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("persists Don't show again across mounts at narrow width", async () => {
    await page.viewport(390, 720);
    const banner = (
      <div style={{ padding: 16 }}>
        <SafetyBufferingBanner threadId="thread" state={state} canRetry onRetry={vi.fn()} />
      </div>
    );
    const screen = await render(banner);
    try {
      await shot("safety-buffering-390");
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.getByRole("menuitem", { name: "Don’t show again" }).click();
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-testid=safety-buffering-banner]")?.closest("[inert]"),
      ).not.toBeNull();
      expect(localStorage.getItem(SAFETY_BUFFERING_DISMISSED_KEY)).toBe("true");
    } finally {
      await screen.unmount();
    }
    const reloaded = await render(banner);
    try {
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-testid=safety-buffering-banner]")?.closest("[inert]"),
      ).not.toBeNull();
    } finally {
      await reloaded.unmount();
    }
  });
});
