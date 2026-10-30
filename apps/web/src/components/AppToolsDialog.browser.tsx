// FILE: AppToolsDialog.browser.tsx
// Purpose: Browser-level parity tests for the Codex Apps tools dialog.

import "../index.css";

import type { ProviderAppInfo, ProviderAppTool } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppToolsDialog } from "./AppToolsDialog";

function app(overrides: Partial<ProviderAppInfo> = {}): ProviderAppInfo {
  return {
    id: "gmail",
    name: "Gmail",
    description: "Read and send mail",
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

function tool(overrides: Partial<ProviderAppTool> = {}): ProviderAppTool {
  return {
    name: "search_mail",
    description: "Search mail",
    disabledReason: null,
    visibility: null,
    accessBadges: ["READ"],
    ...overrides,
  };
}

describe("AppToolsDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders exact loading, summary, Write-first sections, collapse state, and admin-disabled rows", async () => {
    let resolveTools: ((tools: readonly ProviderAppTool[]) => void) | undefined;
    const loadTools = vi.fn(
      () =>
        new Promise<readonly ProviderAppTool[]>((resolve) => {
          resolveTools = resolve;
        }),
    );
    const screen = await render(
      <AppToolsDialog
        app={app()}
        open
        onOpenChange={vi.fn()}
        loadTools={loadTools}
        onSetAppEnabled={vi.fn()}
        onOpenAppUrl={vi.fn(async () => true)}
        onTryNow={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Loading tools…")).toBeInTheDocument();
      resolveTools?.([
        tool({ name: "send_mail", description: "Send mail", accessBadges: ["WRITE"] }),
        tool(),
        tool({
          name: "delete_mail",
          description: "Delete mail",
          accessBadges: ["WRITE", "DESTRUCTIVE"],
          disabledReason: "disabled_by_admin",
        }),
      ]);
      await expect
        .element(page.getByText("The Gmail app contains 3 actions (2 write, 1 read)"))
        .toBeInTheDocument();
      const headers = document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="app-tools-section-header"]',
      );
      expect(headers).toHaveLength(2);
      expect(headers[0]?.textContent).toContain("Write");
      expect(headers[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(headers[1]?.textContent).toContain("Read");
      await expect.element(page.getByText("Disabled by admin")).toBeInTheDocument();
      expect(
        page.getByText("delete_mail").element().closest('[data-testid="app-tool-row"]'),
      ).toHaveClass("opacity-60");
      await page.getByTestId("app-tools-section-header").first().click();
      await vi.waitFor(() => expect(headers[0]?.getAttribute("aria-expanded")).toBe("false"));
      await expect.element(page.getByText("send_mail")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders exact empty/error states and gates Try now", async () => {
    const screen = await render(
      <AppToolsDialog
        app={app({ description: null, isEnabled: false })}
        open
        onOpenChange={vi.fn()}
        loadTools={async () => []}
        onSetAppEnabled={vi.fn()}
        onOpenAppUrl={vi.fn(async () => true)}
        onTryNow={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("Tools for this app")).toBeInTheDocument();
      await expect.element(page.getByText("Disabled")).toBeInTheDocument();
      await expect.element(page.getByText("No tools available for this app.")).toBeInTheDocument();
      const tryNow = page.getByRole("button", { name: "Try now" });
      await expect.element(tryNow).toBeDisabled();
      expect(tryNow.element().closest('[data-testid="app-try-now-tooltip"]')).toHaveAttribute(
        "data-tooltip",
        "Enable and connect this app to try it now",
      );
    } finally {
      await screen.unmount();
    }

    const failed = await render(
      <AppToolsDialog
        app={app()}
        open
        onOpenChange={vi.fn()}
        loadTools={async () => {
          throw new Error("raw failure");
        }}
        onSetAppEnabled={vi.fn()}
        onOpenAppUrl={vi.fn(async () => true)}
        onTryNow={vi.fn()}
      />,
    );
    try {
      await expect
        .element(page.getByText("Unable to load tools for this app."))
        .toBeInTheDocument();
      await expect.element(page.getByText("raw failure")).toBeInTheDocument();
    } finally {
      await failed.unmount();
    }
  });

  it("toggles, opens connector-aware Manage on ChatGPT, and inserts Try now once", async () => {
    const onSetAppEnabled = vi.fn();
    const onOpenAppUrl = vi.fn(async () => true);
    const onTryNow = vi.fn();
    const current = app();
    const screen = await render(
      <AppToolsDialog
        app={current}
        open
        onOpenChange={vi.fn()}
        loadTools={async () => [tool()]}
        onSetAppEnabled={onSetAppEnabled}
        onOpenAppUrl={onOpenAppUrl}
        onTryNow={onTryNow}
      />,
    );
    try {
      await page.getByRole("switch", { name: "Disable app" }).click();
      expect(onSetAppEnabled).toHaveBeenCalledWith(current, false);
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByText("Manage on ChatGPT").click();
      expect(onOpenAppUrl).toHaveBeenCalledWith(
        "https://chatgpt.com/gpts/editor#settings/Connectors?connector=gmail&product-sku=CODEX&referrer=codex",
      );
      await page.getByRole("button", { name: "Try now" }).click();
      expect(onTryNow).toHaveBeenCalledWith(current);
    } finally {
      await screen.unmount();
    }
  });
});
