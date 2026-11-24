// Walk 2026-11-24 (R-9): the sidebar toggle and the back/forward arrows stay in one place at
// the left of the title bar, panel open or collapsed; a page header starts to their right and
// keeps a no-drag box over them, so all three stay clickable in the Windows title bar.

import "../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const navigation = vi.hoisted(() => ({ back: vi.fn(), forward: vi.fn() }));
vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/appNavigation", () => ({
  useAppNavigationState: () => ({ canGoBack: true, canGoForward: true }),
  goBackInAppHistory: navigation.back,
  goForwardInAppHistory: navigation.forward,
}));

import { AppShellTopStrip } from "./AppShellTopStrip";
import {
  SidebarHeaderNavigationControls,
  SidebarLeadingControlsDock,
} from "./SidebarHeaderNavigationControls";
import { SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";

const RAIL_WIDTH = 52;

function Shell() {
  const [open, setOpen] = useState(true);
  const [routeColumn, setRouteColumn] = useState<HTMLElement | null>(null);
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  return (
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={setOpen} mobileSheet={false}>
        <SidebarLeadingControlsDock routeColumn={routeColumn} railSlot={railSlot}>
          <div style={{ display: "flex", width: 1100, height: 400 }}>
            <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
              <AppShellTopStrip />
              <div style={{ display: "flex", flex: 1 }}>
                <div ref={setRailSlot} style={{ width: RAIL_WIDTH, flexShrink: 0 }} />
                <div style={{ width: open ? 260 : 0, overflow: "hidden" }} />
              </div>
            </div>
            <div ref={setRouteColumn} style={{ flex: 1, minWidth: 0 }}>
              <header className="drag-region flex h-11 items-center gap-2 px-4">
                <SidebarHeaderNavigationControls collapsedGapClassName="-me-2" />
                <span>Page title</span>
              </header>
            </div>
          </div>
        </SidebarLeadingControlsDock>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const screens: Awaited<ReturnType<typeof render>>[] = [];
afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
  navigation.back.mockReset();
  navigation.forward.mockReset();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));
const controls = ["Toggle thread sidebar", "Back", "Forward"] as const;
const button = (name: (typeof controls)[number]) =>
  page.getByRole("button", { name, exact: true }).element() as HTMLElement;
const places = () =>
  controls.map((name) => {
    const rect = button(name).getBoundingClientRect();
    return [name, Math.round(rect.left), Math.round(rect.top)] as const;
  });

it("keeps the three controls in one place, clickable, with the page header to their right", async () => {
  await page.viewport(1280, 600);
  screens.push(await render(<Shell />));
  await expect.element(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await settle();
  const open = places();

  await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
  await settle();
  expect(places()).toEqual(open);

  // The page title starts right of the cluster, and a no-drag box covers the cluster in the
  // header (the header itself is a drag region that comes later in the document).
  const forward = button("Forward").getBoundingClientRect();
  expect(page.getByText("Page title").element().getBoundingClientRect().left).toBeGreaterThan(
    forward.right,
  );
  const shield = document.querySelector<HTMLElement>("[data-leading-controls-clearance] > div")!;
  expect(getComputedStyle(shield).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  const shieldBox = shield.getBoundingClientRect();
  for (const name of controls) {
    const rect = button(name).getBoundingClientRect();
    if (rect.right > RAIL_WIDTH) {
      // Every control that reaches over the header is wholly under the no-drag box.
      expect(shieldBox.left, name).toBeLessThanOrEqual(rect.left + 0.5);
      expect(shieldBox.right, name).toBeGreaterThanOrEqual(rect.right - 0.5);
    }
  }

  // Each control takes its click with the panel collapsed.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect(navigation.back).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  expect(navigation.forward).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
  await settle();
  expect(places()).toEqual(open);
});
