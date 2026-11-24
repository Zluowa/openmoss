import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppRail, railItemGlyphs } from "./AppRail";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { SidebarActivityBellButton } from "./Sidebar";
import { TooltipProvider } from "./ui/tooltip";

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

// Walk 2026-11-24 (D-6): after the welcome, an unrequested popover 「活动 / 查看运行中的任务、
// 已完成的工作以及需要你关注的事项。」 floated over the chat. Moss shows no coach marks: the
// bell and the rail's Tasks button explain themselves only in their hover tooltip.

const screens: Awaited<ReturnType<typeof render>>[] = [];

/** Tooltip popups a person can see right now. */
function visiblePopups(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-slot='tooltip-popup']")).filter(
    (element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      );
    },
  );
}

beforeEach(() => {
  localStorage.clear();
  // Startup announcements are done: the moment the old coach marks appeared.
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false, startupSettled: true });
});
afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
  localStorage.clear();
});

it("opens no popover over the page on a fresh profile, and keeps the startup slot free", async () => {
  screens.push(
    await render(
      <TooltipProvider>
        <SidebarActivityBellButton
          active={false}
          showUnreadDot={false}
          shortcutLabel={null}
          onClick={() => {}}
        />
        <AppRail
          items={[
            {
              id: "tasks",
              glyphs: railItemGlyphs("tasks"),
              label: "Tasks",
              badge: null,
              active: false,
              onSelect: () => {},
            },
          ]}
          shortcuts={[]}
          bottomItems={[]}
        />
      </TooltipProvider>,
    ),
  );
  await expect.element(page.getByRole("button", { name: "Switch to activity view" })).toBeVisible();
  // The old hint opened as soon as the slot settled; give it more than enough time.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(visiblePopups()).toHaveLength(0);
  expect(useAnnouncementSheetSlotStore.getState().owner).toBeNull();
});

it("names the bell and the Tasks button in a short tooltip on hover", async () => {
  screens.push(
    await render(
      <TooltipProvider delay={0}>
        {/* Apart, so one tooltip never covers the other button. */}
        <div style={{ display: "flex", gap: 240, padding: 40 }}>
          <SidebarActivityBellButton
            active={false}
            showUnreadDot={false}
            shortcutLabel="Ctrl+Shift+A"
            onClick={() => {}}
          />
          <AppRail
            items={[
              {
                id: "tasks",
                glyphs: railItemGlyphs("tasks"),
                label: "Tasks",
                badge: null,
                active: false,
                onSelect: () => {},
              },
            ]}
            shortcuts={[]}
            bottomItems={[]}
          />
        </div>
      </TooltipProvider>,
    ),
  );
  await page.getByRole("button", { name: "Switch to activity view" }).hover();
  await expect
    .poll(() => visiblePopups().map((popup) => popup.textContent))
    .toEqual(["Activity view (Ctrl+Shift+A)"]);
  await page.getByRole("button", { name: "Tasks", exact: true }).hover();
  await expect.poll(() => visiblePopups().map((popup) => popup.textContent)).toEqual(["Tasks"]);
});
