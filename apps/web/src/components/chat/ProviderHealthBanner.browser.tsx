// FILE: ProviderHealthBanner.browser.tsx
// Purpose: Mounted browser proof that provider health recovery UI never renders runtime diagnostics.
// Layer: Chat status browser test

import type { ServerProviderStatus } from "@synara/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import { ProviderHealthBanner } from "./ProviderHealthBanner";
import { MossLocalizationProvider } from "~/localization";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

// zh-CN 表面：裸挂载默认 localization context 按浏览器语言解析为 en，统一以 zh Provider 包裹。
function renderZh(ui: Parameters<typeof render>[0]) {
  return render(<MossLocalizationProvider>{ui}</MossLocalizationProvider>);
}

const UNSAFE_ANTIGRAVITY_MESSAGE =
  "Provider adapter request failed (antigravity) for models: Plugin install failed.\n    at run (C:\\Users\\person\\agy\\adapter.js:9:2)\nAuthorization: Bearer agy-secret-token";

function unsafeStatus(message: string): ServerProviderStatus {
  return {
    provider: "antigravity",
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    status: "error",
    available: false,
    availability: "unavailable",
    authStatus: "authenticated",
    checkedAt: "2026-08-12T06:00:00.000Z",
    message,
    unavailableReason: "CLI stderr: /Users/person/.config/agy/credentials.json token=agy-secret",
  };
}

describe("ProviderHealthBanner mounted safety", () => {
  it.each([
    [
      "unknown runtime diagnostic",
      "EACCES /Users/person/.config/agy/token.json\n    at load (/Users/person/provider.js:4:2)",
    ],
    ["recognized first line with a raw suffix", UNSAFE_ANTIGRAVITY_MESSAGE],
  ])("renders typed recovery UI for %s", async (_name, message) => {
    const onManageProviders = vi.fn();
    const screen = await renderZh(
      <ProviderHealthBanner status={unsafeStatus(message)} onManageProviders={onManageProviders} />,
    );

    try {
      const alert = page.getByRole("alert");
      await expect.element(alert).toBeVisible();
      await expect.element(page.getByText("Antigravity 服务商当前不可用。")).toBeVisible();
      const manageButton = page.getByRole("button", { name: "管理服务商" });
      await expect.element(manageButton).toBeVisible();

      const alertElement = alert.element();
      const description = alertElement.querySelector('[data-slot="alert-description"]');
      expect(description).toHaveAttribute("title", "Antigravity 服务商当前不可用。");
      expect(alertElement.outerHTML).not.toContain(message);
      expect(alertElement.outerHTML).not.toMatch(
        /EACCES|Provider adapter request failed|Plugin install failed|adapter\.js|provider\.js|Bearer|agy-secret|credentials\.json|token\.json|C:\\Users|\/Users\/person|stderr/iu,
      );

      await manageButton.click();
      expect(onManageProviders).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    {
      provider: "claudeAgent" as const,
      instanceId: "claude_work" as const,
      displayName: "Claude Work",
      message: "Run claude login; stderr points to /Users/person/.claude/auth.json",
    },
    {
      provider: "gemini" as const,
      instanceId: "gemini_work" as const,
      displayName: "Gemini Work",
      message: "Run gemini login; token path /Users/person/.config/gemini/token.json",
    },
    {
      provider: "antigravity" as const,
      instanceId: "antigravity" as const,
      displayName: "Antigravity",
      message: "agy login failed; Bearer agy-secret from C:\\Users\\person\\.agy\\auth.json",
    },
  ])("mounts provider-agnostic auth recovery for $displayName", async (fixture) => {
    const onManageProviders = vi.fn();
    const status: ServerProviderStatus = {
      provider: fixture.provider,
      instanceId: fixture.instanceId,
      driver: fixture.provider,
      displayName: fixture.displayName,
      status: "error",
      available: false,
      authStatus: "unauthenticated",
      checkedAt: "2026-08-12T06:00:00.000Z",
      message: fixture.message,
    };
    const screen = await renderZh(
      <ProviderHealthBanner status={status} onManageProviders={onManageProviders} />,
    );

    try {
      const safeMessage = `${fixture.displayName} 尚未登录。请打开服务商设置并登录。`;
      const alert = page.getByRole("alert");
      await expect.element(page.getByText(safeMessage)).toBeVisible();
      const description = alert.element().querySelector('[data-slot="alert-description"]');
      expect(description).toHaveAttribute("title", safeMessage);
      expect(alert.element().outerHTML).not.toContain(fixture.message);
      expect(alert.element().outerHTML).not.toMatch(
        /codex login|claude login|gemini login|agy login|Bearer|agy-secret|C:\\Users|\/Users\/person|stderr|auth\.json|token\.json/iu,
      );

      const manageButton = page.getByRole("button", { name: "管理服务商" });
      await manageButton.click();
      expect(onManageProviders).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
});
