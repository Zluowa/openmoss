// FILE: standardParts.browser.tsx
// Purpose: The shared badge, sheet header and empty state draw the design standard's values
//          (docs/design/moss-design-standard.md), light and dark: measured off the rendered box.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { Badge } from "./badge";
import { Button } from "./button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./empty";
import { Sheet, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "./sheet";

const THEMES = ["light", "dark"] as const;

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

/** Alpha of a computed colour (`rgb()`, `rgba()`, `oklab(… / a)`, `color(srgb … / a)`). */
function alphaOf(color: string): number {
  if (color === "transparent") return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]) / (slash[2] === "%" ? 100 : 1);
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color);
  return rgba ? Number(rgba[1]) : 1;
}

function px(value: string): number {
  return Number.parseFloat(value);
}

describe.each(THEMES)("standard shared parts (%s)", (theme) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(1200, 800);
  });
  afterEach(() => restoreTheme());

  it("draws the default badge as the quiet tint: ink at 8% (16% dark), ink text, 18 high, 12 px", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="bg-background p-6">
          <span data-testid="ink" className="text-foreground">
            ink
          </span>
          <Badge data-testid="badge">测试版</Badge>
        </div>
      </BrowserThemeFixture>,
    );
    const badge = element('[data-testid="badge"]');
    const style = getComputedStyle(badge);
    expect(badge.getBoundingClientRect().height).toBe(18);
    expect(px(style.fontSize)).toBe(12);
    expect(alphaOf(style.backgroundColor)).toBeCloseTo(theme === "dark" ? 0.16 : 0.08, 2);
    expect(style.color).toBe(getComputedStyle(element('[data-testid="ink"]')).color);
  });

  it("gives the sheet header the dialog's values: title 15, padding 16, no footer band", async () => {
    await render(
      <BrowserThemeFixture>
        <Sheet open>
          <SheetPopup side="right">
            <SheetHeader>
              <SheetTitle>来源</SheetTitle>
            </SheetHeader>
            <SheetPanel>内容</SheetPanel>
            <SheetFooter>
              <Button>完成</Button>
            </SheetFooter>
          </SheetPopup>
        </Sheet>
      </BrowserThemeFixture>,
    );
    await expect.poll(() => document.querySelector('[data-slot="sheet-title"]')).not.toBeNull();
    const popup = element('[data-slot="sheet-popup"]').getBoundingClientRect();
    const header = getComputedStyle(element('[data-slot="sheet-header"]'));
    const title = getComputedStyle(element('[data-slot="sheet-title"]'));
    const footer = getComputedStyle(element('[data-slot="sheet-footer"]'));
    expect(px(title.fontSize)).toBe(15);
    expect(px(header.paddingTop)).toBe(16);
    expect(px(header.paddingLeft)).toBe(16);
    expect(px(header.paddingRight)).toBe(16);
    expect(alphaOf(footer.backgroundColor)).toBe(0);
    expect(px(footer.borderTopWidth)).toBe(0);
    // The close control is the dialog's: a 28 px square, 8 px in from the top-right corner.
    const close = element('[data-slot="sheet-popup"] > button').getBoundingClientRect();
    expect(close.height).toBe(28);
    expect(close.width).toBe(28);
    expect(Math.round(popup.right - close.right)).toBe(8);
    expect(Math.round(close.top - popup.top)).toBe(8);
  });

  it("draws the empty state as one 14 px line and its action, with no illustration", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="flex h-80 bg-background">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>还没有拉取请求</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm">
                重试
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      </BrowserThemeFixture>,
    );
    const empty = element('[data-slot="empty"]');
    const title = element('[data-slot="empty-title"]');
    expect(empty.querySelector("svg")).toBeNull();
    expect(empty.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    expect(px(getComputedStyle(title).fontSize)).toBe(14);
    // One line: its height is the 20 px line of 14 px UI text.
    expect(title.getBoundingClientRect().height).toBe(20);
    expect(px(getComputedStyle(empty).paddingTop)).toBe(24);
  });
});
