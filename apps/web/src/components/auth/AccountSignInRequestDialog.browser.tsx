// FILE: AccountSignInRequestDialog.browser.tsx
// Purpose: The confirmation for a phone's account sign-in, in a real browser: both languages,
//   both themes, the safe choice focused, no Escape or outside-click dismissal, and the
//   untrusted name as text.
// Layer: Auth UI browser tests
// Exports: none
import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { buildThemeCssVariables, DEFAULT_CHROME_THEME_BY_VARIANT } from "../../theme/theme.logic";
import {
  ACCOUNT_SIGN_IN_SETTLE_MS,
  AccountSignInRequestDialog,
} from "./AccountSignInRequestDialog";

/** Both buttons wait a moment after a request comes on screen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, ACCOUNT_SIGN_IN_SETTLE_MS + 150));

const locale = vi.hoisted(() => ({ current: "en" as "en" | "zh-CN" }));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: locale.current,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(locale.current, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(locale.current, key, values),
    }),
  };
});

const NOW = Date.UTC(2026, 10, 13, 8, 0, 0);
const request = {
  requestId: "request-1",
  deviceName: "Pixel <b>8</b>",
  accountLabel: "138****8000",
  checkCode: "4815",
  expiresAtMs: NOW + 90_000,
};

function applyTheme(variant: "light" | "dark") {
  const { variables } = buildThemeCssVariables(
    { codeThemeId: "codex", theme: DEFAULT_CHROME_THEME_BY_VARIANT[variant] },
    variant,
  );
  for (const [name, value] of Object.entries(variables)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.documentElement.classList.toggle("dark", variant === "dark");
}

async function renderDialog(
  overrides: Partial<Parameters<typeof AccountSignInRequestDialog>[0]> = {},
) {
  const onAllow = vi.fn();
  const onDeny = vi.fn();
  const screen = await render(
    <AccountSignInRequestDialog
      request={request}
      othersWaiting={0}
      nowMs={NOW}
      busy={false}
      failed={false}
      onAllow={onAllow}
      onDeny={onDeny}
      {...overrides}
    />,
  );
  return { screen, onAllow, onDeny };
}

describe("AccountSignInRequestDialog", () => {
  afterEach(() => {
    document.documentElement.style.cssText = "";
    document.documentElement.classList.remove("dark");
    document.body.innerHTML = "";
    locale.current = "en";
    vi.restoreAllMocks();
  });

  it("asks in English with the check code, focuses Don't allow, and allows on request", async () => {
    applyTheme("light");
    const { screen, onAllow, onDeny } = await renderDialog({ othersWaiting: 1 });
    try {
      await expect
        .element(page.getByText("Allow “Pixel <b>8</b>” to use this computer?"))
        .toBeInTheDocument();
      // The phone's name is text, never markup.
      expect(document.querySelector("[data-testid=account-sign-in-request] b")).toBeNull();
      await expect
        .element(page.getByText(/your Moss account 138\*\*\*\*8000/u))
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("account-sign-in-check-code"))
        .toHaveTextContent("4 8 1 5");
      await expect
        .element(page.getByText(/ends in 90 s\. 1 more phones are waiting\./u))
        .toBeInTheDocument();
      const deny = page.getByRole("button", { name: "Don't allow" });
      await expect.element(deny).toHaveFocus();
      const allow = page.getByRole("button", { name: "Allow", exact: true });
      await settle();
      await allow.click();
      expect(onAllow).toHaveBeenCalledWith("request-1");
      expect(onDeny).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("asks in Chinese in the dark theme, and Escape neither closes nor answers it", async () => {
    locale.current = "zh-CN";
    applyTheme("dark");
    const { screen, onAllow, onDeny } = await renderDialog({ failed: true });
    try {
      await expect
        .element(page.getByText("允许「Pixel <b>8</b>」使用这台电脑吗？"))
        .toBeInTheDocument();
      await expect.element(page.getByText("核对码", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Moss 没能回应这部手机，请在手机上重试。");
      await expect.element(page.getByRole("button", { name: "不允许" })).toHaveFocus();
      await expect.element(page.getByRole("button", { name: "允许", exact: true })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      const backdrop = document.querySelector<HTMLElement>("[data-slot=alert-dialog-backdrop]");
      if (backdrop) await userEvent.click(backdrop, { force: true });
      expect(onDeny).not.toHaveBeenCalled();
      expect(onAllow).not.toHaveBeenCalled();
      await expect.element(page.getByTestId("account-sign-in-request")).toBeVisible();
      await settle();
      await page.getByRole("button", { name: "不允许" }).click();
      expect(onDeny).toHaveBeenCalledWith("request-1");
    } finally {
      await screen.unmount();
    }
  });

  it("names an unnamed phone plainly and disables both choices while answering", async () => {
    applyTheme("light");
    const { screen, onAllow } = await renderDialog({
      request: { ...request, deviceName: null, accountLabel: null },
      busy: true,
    });
    try {
      await expect
        .element(page.getByText("Allow a phone to use this computer?"))
        .toBeInTheDocument();
      await expect
        .element(page.getByText(/A phone signed in to your Moss account wants to connect/u))
        .toBeInTheDocument();
      await settle();
      await expect
        .element(page.getByRole("button", { name: "Allow", exact: true }))
        .toHaveAttribute("aria-disabled", "true");
      await expect
        .element(page.getByRole("button", { name: "Don't allow" }))
        .toHaveAttribute("aria-disabled", "true");
      expect(onAllow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps both choices inactive for a moment when another request comes on screen", async () => {
    applyTheme("light");
    const { screen, onAllow, onDeny } = await renderDialog();
    try {
      const allowButton = () =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            "[data-testid=account-sign-in-request] button",
          ),
        ].find((button) => button.textContent === "Allow")!;
      await settle();
      await expect
        .element(page.getByTestId("account-sign-in-check-code"))
        .toHaveTextContent("4 8 1 5");
      await screen.rerender(
        <AccountSignInRequestDialog
          request={{ ...request, requestId: "request-2", checkCode: "2222" }}
          othersWaiting={0}
          nowMs={NOW}
          busy={false}
          failed={false}
          onAllow={onAllow}
          onDeny={onDeny}
        />,
      );
      await expect
        .element(page.getByTestId("account-sign-in-check-code"))
        .toHaveTextContent("2 2 2 2");
      const allow = page.getByRole("button", { name: "Allow", exact: true });
      await expect.element(allow).toHaveAttribute("aria-disabled", "true");
      await expect
        .element(page.getByRole("button", { name: "Don't allow" }))
        .toHaveAttribute("aria-disabled", "true");
      // A click that arrives now (meant for the request that was on screen) does nothing.
      allowButton().click();
      expect(onAllow).not.toHaveBeenCalled();
      await settle();
      await expect.element(allow).toHaveAttribute("aria-disabled", "false");
      await allow.click();
      expect(onAllow).toHaveBeenCalledWith("request-2");
      expect(onDeny).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows nothing when no phone is waiting", async () => {
    const { screen } = await renderDialog({ request: null });
    try {
      expect(document.querySelector("[data-testid=account-sign-in-request]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
