// FILE: sharedParts.browser.tsx
// Purpose: The shared tabs (and their segmented variant), card, list row, page header and text
//          link draw the design standard's values (docs/design/moss-design-standard.md), light
//          and dark: height, radius, font size and where the actions sit, off the rendered box.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { Button } from "./button";
import { Card } from "./card";
import { ListRow } from "./list-row";
import { PageHeader } from "./page-header";
import { Tabs } from "./tabs";
import { TextLink } from "./text-link";

const THEMES = ["light", "dark"] as const;
const TAB_ITEMS = [
  { id: "all", label: "全部" },
  { id: "pages", label: "页面" },
  { id: "sheets", label: "表格" },
] as const;

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function elements(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)];
}

/** Alpha of a computed colour (`rgb()`, `rgba()`, `oklab(… / a)`, `color(srgb … / a)`). */
function alphaOf(color: string): number {
  if (color === "transparent") return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]) / (slash[2] === "%" ? 100 : 1);
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color);
  return rgba ? Number(rgba[1]) : 1;
}

const px = (value: string) => Number.parseFloat(value);
const box = (node: HTMLElement) => node.getBoundingClientRect();

describe.each(THEMES)("shared parts (%s)", (theme) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(1200, 800);
    await userEvent.hover(page.elementLocator(document.body), { position: { x: 1, y: 1 } });
  });
  afterEach(() => restoreTheme());

  it("draws tabs 28 high at radius 8 and 14 px, only the selected one tinted, and moves with arrows", async () => {
    const onSelect = vi.fn();
    await render(
      <BrowserThemeFixture>
        <div className="bg-background p-6">
          <Tabs ariaLabel="分类" tabs={TAB_ITEMS} selected="all" onSelect={onSelect} />
        </div>
      </BrowserThemeFixture>,
    );
    const tabs = elements('[role="tab"]');
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      const style = getComputedStyle(tab);
      expect(box(tab).height).toBe(28);
      expect(px(style.borderTopLeftRadius)).toBe(8);
      expect(px(style.fontSize)).toBe(14);
    }
    expect(alphaOf(getComputedStyle(tabs[0]!).backgroundColor)).toBeCloseTo(0.05, 2);
    expect(alphaOf(getComputedStyle(tabs[1]!).backgroundColor)).toBe(0);
    tabs[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("pages");
  });

  it("draws the segmented variant as a 28 high hairline track with 24 high segments at radius 6", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="bg-background p-6">
          <Tabs
            ariaLabel="视图"
            tabs={TAB_ITEMS}
            selected="pages"
            onSelect={() => {}}
            variant="segmented"
          />
        </div>
      </BrowserThemeFixture>,
    );
    const track = element('[role="tablist"]');
    const trackStyle = getComputedStyle(track);
    expect(box(track).height).toBe(28);
    expect(px(trackStyle.borderTopLeftRadius)).toBe(8);
    expect(px(trackStyle.borderTopWidth)).toBe(1);
    for (const tab of elements('[role="tab"]')) {
      expect(box(tab).height).toBe(24);
      expect(px(getComputedStyle(tab).borderTopLeftRadius)).toBe(6);
      expect(px(getComputedStyle(tab).fontSize)).toBe(14);
      // Inside the track, 2 px in from its top edge (hairline plus 1 px inset).
      expect(box(tab).top - box(track).top).toBe(2);
    }
  });

  it("draws a card at radius 12 with a hairline, no shadow, and a thumbnail clipped to its corners", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="w-64 bg-background p-6">
          <Card data-testid="card" thumbnail={<div className="h-20 bg-info" />}>
            <div className="p-3 text-ui">照片</div>
          </Card>
        </div>
      </BrowserThemeFixture>,
    );
    const card = element('[data-testid="card"]');
    const style = getComputedStyle(card);
    expect(px(style.borderTopLeftRadius)).toBe(12);
    expect(px(style.borderTopWidth)).toBe(1);
    expect(style.boxShadow).toBe("none");
    expect(style.overflow).toBe("hidden");
    const thumbnail = element('[data-slot="card-thumbnail"]');
    expect(box(thumbnail).top - box(card).top).toBe(1);
    expect(box(thumbnail).width).toBe(box(card).width - 2);
    expect(box(thumbnail).height).toBe(81);
  });

  it("draws list rows 32 and 48 high at radius 8, with actions at the right edge", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="w-96 bg-background p-6">
          <ListRow
            data-testid="compact"
            title="设计稿"
            actions={
              <Button size="xs" variant="ghost">
                打开
              </Button>
            }
            onClick={() => {}}
          />
          <ListRow
            data-testid="large"
            size="lg"
            title="季度报告"
            description="昨天"
            leading={<div className="size-10 rounded-control bg-info" />}
          />
        </div>
      </BrowserThemeFixture>,
    );
    const compact = element('[data-testid="compact"]');
    const large = element('[data-testid="large"]');
    expect(box(compact).height).toBe(32);
    expect(box(large).height).toBe(48);
    expect(px(getComputedStyle(compact).borderTopLeftRadius)).toBe(8);
    expect(px(getComputedStyle(compact.querySelector(".truncate")!).fontSize)).toBe(14);
    const actions = element('[data-testid="compact"] [data-slot="list-row-actions"]');
    // 12 px row padding to the right edge, centred on the row.
    expect(box(compact).right - box(actions).right).toBe(12);
    expect(box(actions).top + box(actions).height / 2).toBe(box(compact).top + 16);
    // A clickable row fills with 3.5% ink under the pointer.
    expect(alphaOf(getComputedStyle(compact).backgroundColor)).toBe(0);
    await userEvent.hover(page.elementLocator(compact));
    await expect
      .poll(() => alphaOf(getComputedStyle(compact).backgroundColor))
      .toBeCloseTo(0.035, 3);
  });

  it("makes a clickable list row one keyboard button with a frame around the whole row", async () => {
    const openRow = vi.fn();
    const openAction = vi.fn();
    await render(
      <BrowserThemeFixture>
        <div className="w-96 bg-background p-6">
          <ListRow
            data-testid="row"
            title="设计稿"
            onClick={openRow}
            actions={
              <Button size="xs" variant="ghost" onClick={openAction}>
                打开
              </Button>
            }
          />
        </div>
      </BrowserThemeFixture>,
    );
    const row = element('[data-testid="row"]');
    expect(getComputedStyle(row).boxShadow).toBe("none");
    await userEvent.keyboard("{Tab}");
    const focused = document.activeElement as HTMLElement;
    expect(focused.tagName).toBe("BUTTON");
    expect(row.contains(focused)).toBe(true);
    expect(focused.textContent).toBe("设计稿");
    // The focus frame is drawn on the row, not on the text inside it.
    await expect.poll(() => getComputedStyle(row).boxShadow).not.toBe("none");
    await userEvent.keyboard("{Enter}");
    expect(openRow).toHaveBeenCalledTimes(1);
    // The row's hit area covers the row; its action stays a separate button above it.
    await userEvent.click(page.getByRole("button", { name: "打开" }));
    expect(openAction).toHaveBeenCalledTimes(1);
    expect(openRow).toHaveBeenCalledTimes(1);
    const rowBox = box(row);
    expect(
      document.elementFromPoint(rowBox.left + 4, rowBox.top + rowBox.height / 2)?.closest("button"),
    ).toBe(focused);
  });

  it("draws the page header title at 22/28 with its actions at the right", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="w-[720px] bg-background px-6">
          <PageHeader title="任务" actions={<Button size="sm">新建</Button>} />
        </div>
      </BrowserThemeFixture>,
    );
    const header = element('[data-slot="page-header"]');
    const title = element('[data-slot="page-header"] h1');
    const actions = element('[data-slot="page-header-actions"]');
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(px(getComputedStyle(title).fontSize)).toBe(22);
    expect(box(title).height).toBe(28);
    expect(box(title).left).toBe(box(header).left);
    expect(box(actions).right).toBe(box(header).right);
    expect(box(actions).height).toBe(28);
  });

  it("draws a text link in the accent colour, underlined only on hover", async () => {
    await render(
      <BrowserThemeFixture>
        <p className="bg-background p-6 text-ui text-foreground" data-testid="text">
          打开 <TextLink href="#docs">说明</TextLink>
        </p>
      </BrowserThemeFixture>,
    );
    const link = element('[data-slot="text-link"]');
    const text = element('[data-testid="text"]');
    expect(getComputedStyle(link).color).not.toBe(getComputedStyle(text).color);
    expect(getComputedStyle(link).textDecorationLine).toBe("none");
    expect(px(getComputedStyle(link).fontSize)).toBe(14);
    await userEvent.hover(page.elementLocator(link));
    await expect.poll(() => getComputedStyle(link).textDecorationLine).toBe("underline");
  });
});
