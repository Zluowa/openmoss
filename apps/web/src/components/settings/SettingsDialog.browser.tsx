// FILE: SettingsDialog.browser.tsx
// Purpose: The Settings dialog shell in real Chromium: opens over the app at a page, moves
//          between pages from its list, and closes with × or Esc. The pages themselves are
//          stubbed; their own tests cover them.
// Layer: Browser UI test

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { closeSettings, openSettings, settingsDialogStore } from "~/settingsDialogStore";
import type { SettingsLocation } from "~/settingsLocation";

vi.mock("./SettingsContent", () => ({
  SettingsContent: ({ location }: { location: SettingsLocation }) => (
    <div data-testid="stub-page">
      {location.section}
      {location.pluginTab ? `:${location.pluginTab}` : ""}
    </div>
  ),
}));

import { SettingsDialog, SETTINGS_DIALOG_POPUP_CLASS_NAME } from "./SettingsDialog";

afterEach(() => {
  closeSettings();
});

describe("SettingsDialog", () => {
  it("opens over the app at the requested page and switches pages from its list", async () => {
    const screen = await render(<SettingsDialog />);
    await expect.element(page.getByTestId("settings-dialog")).not.toBeInTheDocument();

    openSettings({ section: "appsnap" });
    await expect.element(page.getByTestId("settings-dialog")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect.element(page.getByTestId("stub-page")).toHaveTextContent("appsnap");

    await page.getByRole("button", { name: "Computer use", exact: true }).click();
    await expect.element(page.getByTestId("stub-page")).toHaveTextContent("computer-use");
    await expect
      .element(page.getByRole("button", { name: "Computer use", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await screen.unmount();
  });

  it("lists the new structure: no System tools, no MCP connections page", async () => {
    const screen = await render(<SettingsDialog />);
    openSettings();
    const nav = page.getByTestId("settings-dialog-nav");
    await expect.element(nav).toBeVisible();
    for (const name of ["Plugins", "Computer use", "AppSnap", "Connections", "General"]) {
      await expect.element(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    expect(nav.element().textContent).not.toContain("System tools");
    expect(nav.element().textContent).not.toContain("MCP connections");
    await screen.unmount();
  });

  it("follows old links to where their controls moved", async () => {
    const screen = await render(<SettingsDialog />);
    openSettings({ section: "integrations" });
    await expect.element(page.getByTestId("stub-page")).toHaveTextContent("plugins:mcp");
    openSettings({ section: "advanced" });
    await expect.element(page.getByTestId("stub-page")).toHaveTextContent("general");
    await screen.unmount();
  });

  it("puts focus on the page and closes with Escape", async () => {
    const screen = await render(<SettingsDialog />);
    openSettings({ section: "general" });
    await expect.element(page.getByTestId("settings-dialog")).toBeVisible();
    // Focus lands on the page, not on the close button, so nothing shows a ring on open.
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe("settings-dialog-page"),
    );
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(settingsDialogStore.getState().isOpen).toBe(false));
    await screen.unmount();
  });

  it("closes with the × button", async () => {
    const screen = await render(<SettingsDialog />);
    openSettings({ section: "general" });
    await expect.element(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await vi.waitFor(() => expect(settingsDialogStore.getState().isOpen).toBe(false));
    await screen.unmount();
  });

  it("uses Claude's dialog geometry: centred, capped at 1024 × 800, 12px corners", async () => {
    await page.viewport(1400, 1000);
    const screen = await render(<SettingsDialog />);
    openSettings();
    const dialog = page.getByTestId("settings-dialog");
    await expect.element(dialog).toBeVisible();
    expect(SETTINGS_DIALOG_POPUP_CLASS_NAME).toContain("max-w-[1024px]");
    await vi.waitFor(() => {
      const box = dialog.element().getBoundingClientRect();
      expect(Math.round(box.width)).toBe(1024);
      expect(Math.round(box.height)).toBe(800);
      expect(Math.round(box.left)).toBe(Math.round((1400 - 1024) / 2));
    });
    expect(getComputedStyle(dialog.element()).borderTopLeftRadius).toBe("12px");
    await screen.unmount();
  });
});
