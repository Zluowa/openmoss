// FILE: ThemeCssHooks.primitives.browser.tsx
// Purpose: The theme hooks on Moss's shared primitives (fields, badges, keys, popups, overlay
//          scrollbars) and the right dock show a rule set on them. Renders the real components
//          open, applies theme CSS through `applyThemeCss`, and reads the result off a screenshot.
// Layer: Web appearance tests. The hooks it proves are listed in test/themeHookCoverage.ts.

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { RightDockThreadState } from "../../rightDockStore.logic";
import { installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { PRIMITIVE_HOOKS } from "../../test/themeHookCoverage";
import { measureThemeHook, type ThemeHookProbe } from "../../test/themeHookPaint";
import { applyThemeCss } from "../../theme/themeCss";
import { RightDock } from "../chat/RightDock";
import { Badge } from "./badge";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Kbd } from "./kbd";
import { Menu, MenuItem, MenuPopupBase } from "./menu";
import { Popover, PopoverPopup } from "./popover";
import { ScrollArea } from "./scroll-area";
import { Textarea } from "./textarea";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

const MIN_VISIBLE_SHARE = 0.03;
const SHOTS = "__screenshots__/theme-hooks";

const anchorAt = (x: number, y: number) => ({
  getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
});

const dockState: RightDockThreadState = {
  open: true,
  activePaneId: "notes",
  panes: [
    {
      id: "notes",
      kind: "file",
      filePath: "notes.md",
      threadId: null,
      diffTurnId: null,
      diffFilePath: null,
      pullRequestProjectId: null,
      pullRequestRepository: null,
      pullRequestNumber: null,
      pullRequestInitialTab: null,
    },
  ],
};

function Fixture() {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}
    >
      <TooltipProvider>
        <div className="flex h-screen w-screen bg-background text-foreground">
          <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
            <Input aria-label="Name" defaultValue="Moss" className="w-64" />
            <Textarea aria-label="Notes" defaultValue="Notes" className="w-64" />
            <div className="flex gap-3">
              <Badge>Beta</Badge>
              <Kbd>Ctrl</Kbd>
            </div>
            <div data-testid="scroll-host" className="h-40 w-64 border">
              <ScrollArea>
                <div style={{ height: 1200 }}>Long list</div>
              </ScrollArea>
            </div>
            <Tooltip open>
              <TooltipTrigger render={<span className="mt-20 w-fit">Hover target</span>} />
              <TooltipPopup>Tooltip text</TooltipPopup>
            </Tooltip>
            <Popover open modal={false}>
              <PopoverPopup anchor={anchorAt(420, 60)} side="bottom" align="start">
                <div className="p-6">Popover body</div>
              </PopoverPopup>
            </Popover>
            <Menu open modal={false}>
              <MenuPopupBase anchor={anchorAt(420, 260)} side="bottom" align="start">
                <MenuItem>First item</MenuItem>
                <MenuItem>Second item</MenuItem>
              </MenuPopupBase>
            </Menu>
          </div>
          <RightDock
            state={dockState}
            paneLabelOverrides={{ notes: "notes.md" }}
            minWidth={300}
            defaultWidth="420px"
            shouldAcceptWidth={() => true}
            addMenuKinds={[]}
            onClosePane={() => {}}
            onCollapse={() => {}}
            onOpenChange={() => {}}
            onAddPane={() => {}}
            renderPane={() => <div className="h-full w-full p-4">Notes</div>}
          />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

async function measureHook(selector: string, probe?: ThemeHookProbe) {
  return measureThemeHook(selector, {
    ...(probe ? { probe } : {}),
    minShare: MIN_VISIBLE_SHARE,
    onNotShown: async () => {
      await page.screenshot({
        path: `${SHOTS}/not-shown-${selector.replace(/[^a-z]+/gi, "-")}.png`,
      });
    },
  });
}

describe("theme hooks on shared primitives", () => {
  afterEach(() => {
    applyThemeCss("");
    document.body.innerHTML = "";
  });

  for (const variant of ["light", "dark"] as const) {
    it(`a background on each primitive hook shows (${variant})`, async () => {
      const restoreTheme = installBrowserFixtureTheme(variant);
      document.documentElement.classList.toggle("dark", variant === "dark");
      await page.viewport(1280, 800);
      const screen = await render(<Fixture />);
      try {
        await expect.element(page.getByText("Second item")).toBeVisible();
        await expect.element(page.getByText("Tooltip text")).toBeVisible();
        await expect.element(page.getByText("Popover body")).toBeVisible();
        // Overlay scrollbars show while the pointer is over their area.
        await userEvent.hover(page.getByTestId("scroll-host"));
        await new Promise((resolve) => setTimeout(resolve, 400));
        const results: Record<string, { boxed: boolean; share: number }> = {};
        for (const selector of PRIMITIVE_HOOKS) {
          if (selector === '[data-slot="dialog-popup"]') continue;
          results[selector] = await measureHook(selector);
        }
        console.info(`primitive hooks ${variant}`, JSON.stringify(results));
        for (const [selector, result] of Object.entries(results)) {
          expect.soft(result.boxed, `${selector} has a box`).toBe(true);
          expect
            .soft(result.share, `${selector} shows a background set on it`)
            .toBeGreaterThan(MIN_VISIBLE_SHARE);
        }
      } finally {
        await screen.unmount();
        restoreTheme();
      }
    });

    it(`a background on a dialog shows (${variant})`, async () => {
      const restoreTheme = installBrowserFixtureTheme(variant);
      document.documentElement.classList.toggle("dark", variant === "dark");
      await page.viewport(1280, 800);
      const screen = await render(
        <Dialog open>
          <DialogPopup>
            <DialogTitle>Dialog title</DialogTitle>
            <div className="h-40 p-6">Dialog body</div>
          </DialogPopup>
        </Dialog>,
      );
      try {
        await expect.element(page.getByText("Dialog body")).toBeVisible();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const result = await measureHook('[data-slot="dialog-popup"]');
        console.info(`dialog hook ${variant}`, JSON.stringify(result));
        expect(result.boxed).toBe(true);
        expect(result.share).toBeGreaterThan(MIN_VISIBLE_SHARE);
      } finally {
        await screen.unmount();
        restoreTheme();
      }
    });
  }
});
