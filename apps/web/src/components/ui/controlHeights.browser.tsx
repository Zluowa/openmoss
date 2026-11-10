import "../../index.css";

import type { CSSProperties } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { getAppTypographyCssVariables } from "~/lib/appTypography";
import { CentralIcon } from "~/lib/central-icons";
import { getDensityCssVariables } from "~/lib/appDensity";
import { SIDEBAR_HEADER_ROW_CLASS_NAME } from "~/sidebarRowStyles";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { SidebarGlyph } from "../sidebarGlyphs";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Menu, MenuItem, MenuTrigger } from "./menu";
import { Select, SelectTrigger, SelectValue } from "./select";
import { Switch } from "./switch";

// A field and a button of one size share a toolbar row, so they must share a height.
const LADDER = [
  { size: "sm", heightPx: 28 },
  { size: "default", heightPx: 32 },
  { size: "lg", heightPx: 40 },
] as const;
const originalRootStyle = document.documentElement.getAttribute("style");

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function setFontSize(size: number) {
  for (const [key, value] of Object.entries(getAppTypographyCssVariables(size))) {
    document.documentElement.style.setProperty(key, value);
  }
}

beforeEach(async () => {
  await page.viewport(1200, 800);
});
afterEach(() => {
  if (originalRootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", originalRootStyle);
});

describe("comfortable control geometry", () => {
  it.each(LADDER)("keeps $size fields and buttons on $heightPx", async ({ size, heightPx }) => {
    await render(
      <div>
        <Input aria-label="Field" size={size} />
        <Button data-testid="button" size={size}>
          Save
        </Button>
        <Select>
          <SelectTrigger data-testid="select" aria-label="Choice" size={size}>
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
        </Select>
      </div>,
    );

    for (const selector of [
      '[data-slot="input-control"]',
      '[data-testid="button"]',
      '[data-testid="select"]',
    ]) {
      expect(element(selector).getBoundingClientRect().height).toBe(heightPx);
    }
  });

  it.each([16, 18].flatMap((fontSize) => LADDER.map((size) => ({ fontSize, ...size }))))(
    "keeps $size controls aligned and readable at font $fontSize",
    async ({ fontSize, size, heightPx }) => {
      setFontSize(fontSize);
      await render(
        <div>
          <Input aria-label="Field" size={size} defaultValue="中文与 English" />
          <Button data-testid="button" size={size}>
            保存设置
          </Button>
          <Select>
            <SelectTrigger data-testid="select" aria-label="Choice" size={size}>
              <SelectValue placeholder="选择" />
            </SelectTrigger>
          </Select>
        </div>,
      );
      for (const selector of [
        '[data-slot="input-control"]',
        '[data-testid="button"]',
        '[data-testid="select"]',
      ]) {
        const control = element(selector);
        expect(control.getBoundingClientRect().height).toBeCloseTo((heightPx * fontSize) / 14, 1);
        expect(control.clientHeight).toBeGreaterThanOrEqual(
          parseFloat(getComputedStyle(control).lineHeight),
        );
      }
      const input = element('[data-slot="input"]');
      expect(input.clientHeight).toBeGreaterThanOrEqual(
        parseFloat(getComputedStyle(input).lineHeight),
      );
    },
  );

  it("uses distinct body, supporting, prose, code and title line boxes", async () => {
    await render(
      <div style={{ fontFamily: '"Synthetic UI", monospace' }}>
        <span data-role="ui" className="text-ui">
          界面
        </span>
        <span data-role="lg" className="text-ui-lg">
          小标题
        </span>
        <span data-role="sm" className="text-ui-sm">
          说明
        </span>
        <span data-role="xs" className="text-ui-xs">
          提示
        </span>
        <span data-role="tiny" className="text-ui-2xs">
          时间
        </span>
        <span data-role="prose" className="text-chat">
          正文
        </span>
        <span data-role="code" className="text-chat-code">
          code
        </span>
        <h1 data-role="title" className={PAGE_TITLE_CLASS_NAME}>
          页面标题
        </h1>
      </div>,
    );
    for (const [role, font, line] of [
      ["ui", 14, 20],
      ["lg", 15, 20],
      ["sm", 13, 17],
      ["xs", 12, 17],
      ["tiny", 11, 17],
      ["prose", 16, 24],
      ["code", 13, 19],
      ["title", 22, 28],
    ] as const) {
      const style = getComputedStyle(element(`[data-role="${role}"]`));
      expect(parseFloat(style.fontSize)).toBe(font);
      expect(parseFloat(style.lineHeight)).toBeCloseTo(line, 2);
      expect(style.fontFamily).toContain("Synthetic UI");
    }
  });

  it.each([14, 18])(
    "keeps sidebar rows, icons and toggles on their roles at font %s",
    async (fontSize) => {
      setFontSize(fontSize);
      const scale = fontSize / 14;
      await render(
        <div style={getDensityCssVariables() as CSSProperties}>
          <div data-testid="row" className={SIDEBAR_HEADER_ROW_CLASS_NAME}>
            <SidebarGlyph
              icon={({ className }) => <svg className={className} />}
              variant="leading"
            />
            新对话
          </div>
          <Checkbox aria-label="Enable agent" />
          <Switch aria-label="Enable setting" />
          <Button size="sm" data-testid="small-icon">
            <CentralIcon name="settings" />
            Settings
          </Button>
        </div>,
      );
      expect(parseFloat(getComputedStyle(element('[data-testid="row"]')).fontSize)).toBe(fontSize);
      expect(element('[data-testid="row"]').getBoundingClientRect().height).toBeCloseTo(
        32 * scale,
        1,
      );
      expect(element('[data-testid="row"] svg').getBoundingClientRect().width).toBeCloseTo(
        20 * scale,
        1,
      );
      expect(element('[data-slot="checkbox"]').getBoundingClientRect().width).toBeCloseTo(
        20 * scale,
        1,
      );
      expect(element('[data-slot="switch"]').getBoundingClientRect().height).toBeCloseTo(
        16 * scale + 4,
        1,
      );
      expect(
        parseFloat(
          getComputedStyle(element('[data-testid="small-icon"] [data-slot="central-icon"]')).width,
        ),
      ).toBeCloseTo(16 * scale, 1);
      await page.getByRole("checkbox", { name: "Enable agent" }).click();
      await expect.element(page.getByRole("checkbox", { name: "Enable agent" })).toBeChecked();
      await page.getByRole("switch", { name: "Enable setting" }).click();
      await expect.element(page.getByRole("switch", { name: "Enable setting" })).toBeChecked();
    },
  );

  it.each([14, 18])("scales portalled menu rows with font %s", async (fontSize) => {
    setFontSize(fontSize);
    await render(
      <Menu>
        <MenuTrigger render={<Button />}>Open menu</MenuTrigger>
        <ComposerPickerMenuPopup fixedWidth>
          <MenuItem>
            <CentralIcon name="settings" />
            设置
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect.element(page.getByRole("menuitem", { name: "设置" })).toBeVisible();
    // Menus open with Claude's 120 ms scale-in from 0.98; poll until the row has settled.
    await expect
      .poll(() => element('[data-slot="menu-item"]').getBoundingClientRect().height)
      .toBeCloseTo((32 * fontSize) / 14, 1);
    expect(
      parseFloat(
        getComputedStyle(element('[data-slot="menu-item"] [data-slot="central-icon"]')).width,
      ),
    ).toBeCloseTo((20 * fontSize) / 14, 1);
  });

  it("retains the small dialog title role separately from a large title", async () => {
    await render(
      <Dialog open>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Small panel title</DialogTitle>
          </DialogHeader>
          <h2 data-testid="large-title" className="text-title">
            Large connection title
          </h2>
        </DialogPopup>
      </Dialog>,
    );
    expect(getComputedStyle(element('[data-slot="dialog-title"]')).fontSize).toBe("15px");
    expect(getComputedStyle(element('[data-testid="large-title"]')).fontSize).toBe("22px");
  });
});
