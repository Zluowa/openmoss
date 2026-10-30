// FILE: SettingsSidebarNav.browser.tsx
// Purpose: Exercise the settings search control through real Chromium DOM behavior.

import "../index.css";

import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsSidebarNav } from "./SettingsSidebarNav";

describe("SettingsSidebarNav search", () => {
  it("filters sections into ranked results, selects the top match on Enter, and clears on Escape", async () => {
    const onSelectSection = vi.fn();
    const screen = await render(
      <SettingsSidebarNav activeSection="history" onSelectSection={onSelectSection} />,
    );

    try {
      // Idle state: the section nav is visible and the active section is marked.
      const sectionsNav = page.getByRole("navigation", { name: "Settings sections" });
      await expect.element(sectionsNav).toBeVisible();
      expect(
        document.querySelector('[aria-label="Settings sections"] [aria-current="page"]'),
      ).not.toBeNull();

      const input = page.getByRole("textbox", { name: "Search settings" });
      await expect.element(input).toBeVisible();

      // Typing swaps the section nav for the ranked results list.
      await input.fill("appearance");
      await expect
        .element(page.getByRole("list", { name: "Settings search results" }))
        .toBeVisible();
      expect(document.querySelector('[aria-label="Settings sections"]')).toBeNull();
      expect(
        document.querySelector('[aria-label="Settings search results"]')?.textContent,
      ).toContain("Theme");

      // Escape clears the query and restores the section nav.
      await userEvent.keyboard("{Escape}");
      await expect.element(sectionsNav).toBeVisible();
      expect(
        document.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')?.value,
      ).toBe("");

      // Enter chooses the top-ranked result, deep-linking to its anchor target.
      await input.fill("picker order");
      await expect
        .element(page.getByRole("list", { name: "Settings search results" }))
        .toBeVisible();
      await userEvent.keyboard("{Enter}");
      expect(onSelectSection).toHaveBeenCalledExactlyOnceWith("providers", {
        target: "setting-available-clis",
      });
      await expect.element(sectionsNav).toBeVisible();

      // A query with no matches renders the empty state instead of the nav.
      await input.fill("zzzz-no-such-setting");
      await expect.element(page.getByText("No matching settings.")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
