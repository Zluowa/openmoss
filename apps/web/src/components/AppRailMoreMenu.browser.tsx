// FILE: AppRailMoreMenu.browser.tsx
// Purpose: Browser coverage for feature rows, independent pin actions, and navigation.
// Layer: Web component tests
import "../index.css";
import { useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PluginIcon } from "~/lib/icons";
import { AppRailMoreMenu } from "./AppRailMoreMenu";

describe("feature menu", () => {
  it("keeps pinning separate from opening a plugin and keeps the menu usable", async () => {
    const openPlugin = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      const [pinned, setPinned] = useState(false);
      return (
        <AppRailMoreMenu
          open={open}
          onOpenChange={setOpen}
          onCustomize={() => {}}
          destinations={[
            { key: "projects", label: "Projects", icon: PluginIcon, onSelect: () => {} },
          ]}
          plugins={[
            {
              key: "figma",
              label: "Figma",
              icon: PluginIcon,
              onSelect: openPlugin,
              pinned,
              onTogglePin: () => setPinned(!pinned),
            },
          ]}
          utilities={[]}
        />
      );
    }
    await render(<Harness />);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect.element(page.getByText("Common plugins", { exact: true })).toBeVisible();
    // Pins are a secondary control: a 12px glyph in a 24px hit area (layout sizes, so the
    // popup's open animation does not skew them).
    const pin = page.getByRole("menuitem", { name: "Pin to sidebar: Figma", exact: true });
    const pinElement = pin.element() as HTMLElement;
    expect([pinElement.offsetWidth, pinElement.offsetHeight]).toEqual([24, 24]);
    const pinGlyph = pinElement.firstElementChild as HTMLElement;
    expect([pinGlyph.offsetWidth, pinGlyph.offsetHeight]).toEqual([12, 12]);
    await page.getByRole("menuitem", { name: "Pin to sidebar: Figma", exact: true }).click();
    expect(openPlugin).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("menuitem", { name: "Unpin from sidebar: Figma", exact: true }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "Unpin from sidebar: Figma", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Pin to sidebar: Figma", exact: true }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "Figma", exact: true }).click();
    expect(openPlugin).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("menuitem", { name: "Figma", exact: true }))
      .not.toBeInTheDocument();
  });

  it("adds and removes projects as rail shortcuts from a submenu", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
      return (
        <>
          <output data-testid="pinned">{[...pinned].join(",")}</output>
          <AppRailMoreMenu
            open={open}
            onOpenChange={setOpen}
            onCustomize={() => {}}
            destinations={[]}
            plugins={[]}
            utilities={[]}
            shortcuts={{
              projects: [{ key: "project:p1", label: "Profile" }],
              pinnedKeys: pinned,
              onToggle: (key) =>
                setPinned((previous) => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                }),
            }}
          />
        </>
      );
    }
    await render(<Harness />);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Projects in the sidebar", exact: true }).click();
    // Only projects can be pinned: Spaces were removed, so no Spaces group is listed.
    expect(page.getByText("Spaces", { exact: true }).elements()).toHaveLength(0);
    await page.getByRole("menuitemcheckbox", { name: "Profile", exact: true }).click();
    await expect.element(page.getByTestId("pinned")).toHaveTextContent("project:p1");
  });
});
