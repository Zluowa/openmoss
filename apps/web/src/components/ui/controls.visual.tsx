// FILE: controls.visual.tsx
// Purpose: Pixel baseline of Moss's form-control wrappers in their main states, light and dark, at
//          the default (comfortable) density. Taken on main before the move from Base UI to UI SDK
//          (round 20261118-ui-sdk) and kept so every later change of the library underneath the
//          wrappers is compared against it. Run with `bun run test:browser:visual` in apps/web.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import type { ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { CentralIcon } from "~/lib/central-icons";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";
import { Radio, RadioGroup } from "./radio-group";
import { ScrollArea } from "./scroll-area";
import { Separator } from "./separator";
import { Slider } from "./slider";
import { Switch } from "./switch";
import { Textarea } from "./textarea";
import { Toggle } from "./toggle";

const THEMES = ["light", "dark"] as const;
const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "subtle",
  "chrome",
  "chrome-outline",
  "destructive",
  "destructive-outline",
  "primary-outline",
  "secondary-outline",
  "glass",
  "link",
] as const;
const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon", "icon-lg"] as const;

function Sheet({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <BrowserThemeFixture>
      <div
        data-testid={testId}
        className="inline-flex flex-col gap-4 bg-background p-5 text-foreground"
        style={{ width: 760 }}
      >
        {children}
      </div>
    </BrowserThemeFixture>
  );
}

async function shoot(testId: string, name: string) {
  // Let fonts, the theme store and any entry transition settle before the capture.
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await expect.element(page.getByTestId(testId)).toMatchScreenshot(name);
}

describe.each(THEMES)("controls (%s)", (theme) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(1200, 900);
    // Park the pointer in a corner: a press in an earlier case leaves it over a control, which
    // would then be captured in its hover state.
    await userEvent.hover(page.elementLocator(document.body), { position: { x: 1, y: 1 } });
  });
  afterEach(() => {
    restoreTheme();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("buttons: variants by size", async () => {
    await render(
      <Sheet testId="buttons">
        {BUTTON_VARIANTS.map((variant) => (
          <div key={variant} className="flex items-center gap-2">
            {BUTTON_SIZES.map((size) => (
              <Button key={size} variant={variant} size={size}>
                <CentralIcon name="plus" /> 新建
              </Button>
            ))}
            {ICON_SIZES.map((size) => (
              <Button key={size} variant={variant} size={size} aria-label="添加">
                <CentralIcon name="plus" />
              </Button>
            ))}
            <Button variant={variant} disabled>
              停用
            </Button>
            <Button variant={variant} shape="capsule">
              胶囊
            </Button>
          </div>
        ))}
      </Sheet>,
    );
    await shoot("buttons", `buttons-${theme}`);
  });

  it("button with keyboard focus", async () => {
    await render(
      <Sheet testId="button-focus">
        <div className="flex gap-3">
          <Button variant="outline">前</Button>
          <Button>聚焦</Button>
          <Button variant="ghost">后</Button>
        </div>
      </Sheet>,
    );
    (page.getByRole("button", { name: "前" }).element() as HTMLElement).focus();
    await userEvent.tab();
    await shoot("button-focus", `button-focus-${theme}`);
  });

  it("checkboxes, radios and switches", async () => {
    await render(
      <Sheet testId="choices">
        <div className="flex items-center gap-6">
          <Checkbox aria-label="未选" checked={false} />
          <Checkbox aria-label="已选" checked />
          <Checkbox aria-label="部分" checked={false} indeterminate />
          <Checkbox aria-label="停用未选" checked={false} disabled />
          <Checkbox aria-label="停用已选" checked disabled />
          <Checkbox aria-label="无效" checked={false} aria-invalid />
          <Label>
            <Checkbox defaultChecked /> 记住选择
          </Label>
        </div>
        <RadioGroup defaultValue="b" className="flex-row gap-6">
          <Label>
            <Radio value="a" /> 紧凑
          </Label>
          <Label>
            <Radio value="b" /> 舒适
          </Label>
          <Label>
            <Radio value="c" disabled /> 宽松
          </Label>
        </RadioGroup>
        <div className="flex items-center gap-6">
          <Switch aria-label="关" checked={false} />
          <Switch aria-label="开" checked />
          <Switch aria-label="停用关" checked={false} disabled />
          <Switch aria-label="停用开" checked disabled />
          <Label>
            <Switch defaultChecked /> 联网搜索
          </Label>
        </div>
      </Sheet>,
    );
    await shoot("choices", `choices-${theme}`);
  });

  it("choices with keyboard focus", async () => {
    await render(
      <Sheet testId="choices-focus">
        <div className="flex items-center gap-6">
          <Button variant="ghost">起点</Button>
          <Checkbox aria-label="复选" checked />
          <Switch aria-label="开关" checked />
        </div>
      </Sheet>,
    );
    (page.getByRole("button", { name: "起点" }).element() as HTMLElement).focus();
    await userEvent.tab();
    await shoot("choices-focus", `checkbox-focus-${theme}`);
    await userEvent.tab();
    await shoot("choices-focus", `switch-focus-${theme}`);
  });

  it("sliders", async () => {
    const noop = () => {};
    await render(
      <Sheet testId="sliders">
        <div className="flex flex-col gap-5" style={{ width: 320 }}>
          <Slider aria-label="最小" value={0} min={0} max={100} onValueChange={noop} />
          <Slider aria-label="中间" value={40} min={0} max={100} onValueChange={noop} />
          <Slider aria-label="最大" value={100} min={0} max={100} onValueChange={noop} />
          <Slider
            aria-label="强度"
            value={2}
            min={0}
            max={4}
            step={1}
            showStepMarks
            onValueChange={noop}
          />
          <Slider
            aria-label="大号"
            value={3}
            min={0}
            max={4}
            step={1}
            size="large"
            showStepMarks
            onValueChange={noop}
          />
          <Slider aria-label="停用" value={60} min={0} max={100} disabled onValueChange={noop} />
        </div>
      </Sheet>,
    );
    await shoot("sliders", `sliders-${theme}`);
    (page.getByRole("slider", { name: "中间" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Shift}");
    await shoot("sliders", `slider-focus-${theme}`);
  });

  it("toggles", async () => {
    await render(
      <Sheet testId="toggles">
        <div className="flex items-center gap-3">
          {(["default", "outline"] as const).map((variant) =>
            (["xs", "sm", "default", "lg"] as const).map((size) => (
              <Toggle key={`${variant}-${size}`} variant={variant} size={size} aria-label="摘要">
                <CentralIcon name="list-bullets" />
              </Toggle>
            )),
          )}
        </div>
        <div className="flex items-center gap-3">
          <Toggle defaultPressed aria-label="按下">
            <CentralIcon name="list-bullets" /> 按下
          </Toggle>
          <Toggle variant="outline" defaultPressed aria-label="按下描边">
            按下描边
          </Toggle>
          <Toggle disabled aria-label="停用">
            停用
          </Toggle>
        </div>
      </Sheet>,
    );
    await shoot("toggles", `toggles-${theme}`);
  });

  it("text fields", async () => {
    await render(
      <Sheet testId="fields">
        <div className="grid grid-cols-2 gap-3">
          <Input aria-label="空" placeholder="搜索对话" />
          <Input aria-label="有值" defaultValue="Moss 桌面版" />
          <Input aria-label="小" size="sm" placeholder="小号" />
          <Input aria-label="大" size="lg" placeholder="大号" />
          <Input aria-label="柔和" variant="soft" placeholder="柔和底色" />
          <Input aria-label="胶囊" shape="capsule" placeholder="胶囊" />
          <Input aria-label="停用" disabled defaultValue="停用" />
          <Input aria-label="无效" aria-invalid defaultValue="无效输入" />
        </div>
        <Textarea aria-label="备注" placeholder="写点什么…" />
        <Textarea aria-label="多行" defaultValue={"第一行\n第二行\n第三行"} size="sm" />
        <div className="flex h-8 items-center gap-3">
          <Label htmlFor="visual-name">名称</Label>
          <Separator orientation="vertical" />
          <span>右侧</span>
        </div>
        <Separator />
      </Sheet>,
    );
    await shoot("fields", `fields-${theme}`);
    (page.getByRole("textbox", { name: "有值" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{End}");
    await shoot("fields", `field-focus-${theme}`);
  });

  it("scroll area with its scrollbar shown", async () => {
    await render(
      <Sheet testId="scroll">
        <div className="h-40 w-64 rounded-control border">
          <ScrollArea>
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 30 }, (_, index) => (
                <span key={index}>第 {index + 1} 行</span>
              ))}
            </div>
          </ScrollArea>
        </div>
      </Sheet>,
    );
    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    await userEvent.hover(viewport);
    viewport.scrollTop = 200;
    await expect
      .poll(() =>
        Number(
          getComputedStyle(
            document.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]')!,
          ).opacity,
        ),
      )
      .toBe(1);
    await shoot("scroll", `scroll-area-${theme}`);
  });
});
