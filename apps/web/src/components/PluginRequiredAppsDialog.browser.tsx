// FILE: PluginRequiredAppsDialog.browser.tsx
// Purpose: Browser contract for the multi-app onboarding dialog.

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("../localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

import { PluginRequiredAppsDialog, type PluginRequiredApp } from "./PluginRequiredAppsDialog";

const APPS: readonly PluginRequiredApp[] = [
  {
    id: "connector/github",
    name: "GitHub",
    description: "Work with repositories",
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: false,
    logoUrl: null,
    logoUrlDark: null,
    status: "pending",
  },
  {
    id: "connector/gmail",
    name: "Gmail",
    description: "Work with mail",
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: true,
    logoUrl: null,
    logoUrlDark: null,
    status: "connected",
  },
];

describe("PluginRequiredAppsDialog", () => {
  beforeEach(() => {
    localizationTestState.locale = "en";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the exact dynamic zh-CN regular-dialog contract and never an alertdialog", async () => {
    localizationTestState.locale = "zh-CN";
    const screen = await render(
      <PluginRequiredAppsDialog
        open
        pluginName="GitHub"
        pluginLogoUrl={null}
        apps={APPS}
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        onViewDetails={vi.fn()}
        onTryNow={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(0);
      await expect.element(page.getByText("将应用连接到 GitHub")).toBeInTheDocument();
      await expect
        .element(page.getByText("从你已在使用的应用中获得相关性更强的帮助。你也可以稍后再设置。"))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "连接", exact: true }))
        .toBeInTheDocument();
      await expect.element(page.getByText("已连接", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "查看详情" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "立即试用 GitHub" }))
        .toBeInTheDocument();

      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.className).toContain("max-w-[480px]");
      expect(dialog?.className).toContain("max-h-[min(720px,calc(100vh-2rem))]");
    } finally {
      await screen.unmount();
    }
  });

  it("single-flights Connect and exposes View details / Try now exactly once", async () => {
    const onConnect = vi.fn();
    const onViewDetails = vi.fn();
    const onTryNow = vi.fn();
    const screen = await render(
      <PluginRequiredAppsDialog
        open
        pluginName="GitHub"
        pluginLogoUrl={null}
        apps={APPS}
        onOpenChange={vi.fn()}
        onConnect={onConnect}
        onViewDetails={onViewDetails}
        onTryNow={onTryNow}
      />,
    );
    try {
      const connect = document.querySelector<HTMLButtonElement>(
        'button[data-plugin-required-app-id="connector/github"]',
      );
      expect(connect).not.toBeNull();
      connect?.click();
      connect?.click();
      expect(onConnect).toHaveBeenCalledTimes(1);

      await page.getByRole("button", { name: "View details" }).click();
      await page.getByRole("button", { name: "Try GitHub now" }).click();
      expect(onViewDetails).toHaveBeenCalledTimes(1);
      expect(onTryNow).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
