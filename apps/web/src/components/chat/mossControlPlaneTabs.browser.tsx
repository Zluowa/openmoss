// FILE: mossControlPlaneTabs.browser.tsx
// Purpose: The Moss shell's surface rows (a developer panel behind the off-by-default "Show Moss
//          shell" flag) switch the panel's view, so they are the shared Tabs: the access strip's
//          row and the control panel's own segmented row, each tab with its icon and the data
//          hooks that tests and the agent bridge find it by. No native tooltips.
// Layer: Web appearance tests (real Chromium, real Moss CSS)

import "../../index.css";

import { ThreadId } from "@moss/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossControlPlanePanelView, MossNativeShellAccessStrip } from "./MossControlPlanePanel";

afterEach(async () => {
  await cleanup();
});

it("draws the access strip's surfaces as the shared tabs, with their icons and data hooks", async () => {
  const onSurfaceChange = vi.fn();
  await render(
    <MossNativeShellAccessStrip
      activeSurface="events"
      threadId={ThreadId.makeUnsafe("thread-control-plane")}
      onSurfaceChange={onSurfaceChange}
    />,
  );
  const strip = page.getByRole("tablist", { name: "Moss shell surfaces" });
  await expect.element(strip).toBeVisible();
  expect(strip.element().getAttribute("data-slot")).toBe("tabs");
  const events = page.getByRole("tab", { name: "Events" }).element() as HTMLElement;
  expect(events.getAttribute("aria-selected")).toBe("true");
  expect(events.dataset.activeSurface).toBe("true");
  expect(events.dataset.mossNativeShellSurface).toBe("events");
  expect(
    events.querySelector("[data-slot='tab-leading'] [data-slot='central-icon']"),
  ).not.toBeNull();
  const launch = document.querySelector<HTMLElement>(
    "[data-moss-native-launch-plan-access='true'][data-moss-native-shell-surface='launch-plan']",
  )!;
  expect(launch.getAttribute("role")).toBe("tab");
  expect(strip.element().querySelector("[title]")).toBeNull();
  await userEvent.click(launch);
  expect(onSurfaceChange).toHaveBeenCalledWith("launch-plan");
});

it("draws the control panel's own surface row as the shared segmented control", async () => {
  const onSurfaceChange = vi.fn();
  await page.viewport(1280, 800);
  await render(
    <MossControlPlanePanelView
      activeSurface="sessions"
      events={[]}
      launchPlanInspector={null}
      loopLedgerDashboard={null}
      threadLabel="thread-control-plane"
      onSurfaceChange={onSurfaceChange}
    />,
  );
  const row = page.getByRole("tablist", { name: "Moss control surfaces" });
  await expect.element(row).toBeVisible();
  expect(row.element().getAttribute("data-variant")).toBe("segmented");
  await expect
    .element(page.getByRole("tab", { name: "Sessions" }))
    .toHaveAttribute("aria-selected", "true");
  expect(row.element().querySelector("[title]")).toBeNull();
  await userEvent.click(page.getByRole("tab", { name: "Ledger" }));
  expect(onSurfaceChange).toHaveBeenCalledWith("ledger");
});
