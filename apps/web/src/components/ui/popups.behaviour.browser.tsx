// FILE: popups.behaviour.browser.tsx
// Purpose: Behaviour contract of Moss's list and popup wrappers (menu, select, combobox): they
//          appear instantly, move and pick with the keyboard, close on Escape with focus back on
//          the trigger, and leave the highlighted option alone while Enter confirms a pinyin
//          candidate. Written against the wrappers' exported API, so it passes on the primitive
//          library underneath them today and after it changes (round 20261118-ui-sdk).
// Layer: Web component tests (real Chromium, real rendered parts, trusted keyboard input).

import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { composeChineseWithEnter } from "../../test/imeComposition";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./combobox";
import { Button } from "./button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./popover";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const BRANCHES = ["main", "release/1.0.7", "feat/ui-sdk-controls", "fix/login"];

// No body wipe between tests: the popups render through portals, and pulling those out from under
// React before vitest-browser-react unmounts them crashes the next render (removeChild).

/** A popup counts as shown while it is in the page with a painted box. */
function shown(selector: string): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element || element.closest("[hidden]")) return null;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? element : null;
}

/** The popup must be fully painted on the first frame it exists: no fade, no scale-in. */
async function expectInstant(popup: () => HTMLElement | null) {
  await expect.poll(popup, { interval: 5, timeout: 1_000 }).not.toBeNull();
  const element = popup()!;
  const style = getComputedStyle(element);
  expect(Number(style.opacity)).toBe(1);
  expect(style.transform === "none" || style.transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  expect(element.getAnimations({ subtree: false }).length).toBe(0);
}

/** A popover may fade in (Moss popovers do); it must be painted within a few frames. */
async function expectInstantOrQuick(popup: () => HTMLElement | null) {
  await expect.poll(popup, { interval: 5, timeout: 1_000 }).not.toBeNull();
}

describe("Menu", () => {
  function Fixture({ onSelect }: { onSelect: (label: string) => void }) {
    return (
      <Menu>
        <MenuTrigger render={<button type="button" />}>更多</MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuItem onClick={() => onSelect("重命名")}>重命名</MenuItem>
          <MenuItem onClick={() => onSelect("归档")}>归档</MenuItem>
          <MenuItem onClick={() => onSelect("删除")}>删除</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    );
  }

  it("appears instantly and closes on Escape with focus back on its trigger", async () => {
    await render(<Fixture onSelect={vi.fn()} />);
    const trigger = page.getByRole("button", { name: "更多" });
    await trigger.click();
    await expectInstant(() => shown('[role="menu"]'));
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => shown('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element());
  });

  it("opens from the keyboard, moves with arrows and activates with Enter", async () => {
    const onSelect = vi.fn();
    await render(<Fixture onSelect={onSelect} />);
    const trigger = page.getByRole("button", { name: "更多" });
    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: "重命名" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: "归档" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("归档");
    await expect.poll(() => shown('[role="menu"]')).toBeNull();
  });
});

describe("Menu rows", () => {
  // Contracts the wrappers keep from Base UI. Each case fails without its wrapper fix.

  it("keeps the menu open when a checkbox or radio row changes, and closes on a plain row", async () => {
    function Fixture() {
      const [wrap, setWrap] = useState(false);
      const [size, setSize] = useState("小");
      return (
        <Menu>
          <MenuTrigger render={<button type="button" />}>视图</MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            <MenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
              自动换行
            </MenuCheckboxItem>
            <MenuRadioGroup value={size} onValueChange={setSize}>
              <MenuRadioItem value="小">小</MenuRadioItem>
              <MenuRadioItem value="大">大</MenuRadioItem>
            </MenuRadioGroup>
            <MenuItem>重置</MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      );
    }
    await render(<Fixture />);
    await page.getByRole("button", { name: "视图" }).click();
    const wrap = page.getByRole("menuitemcheckbox", { name: "自动换行" });
    await wrap.click();
    await expect.element(wrap).toHaveAttribute("aria-checked", "true");
    const large = page.getByRole("menuitemradio", { name: "大" });
    await large.click();
    await expect.element(large).toHaveAttribute("aria-checked", "true");
    expect(shown('[data-slot="menu-popup"]')).not.toBeNull();
    await page.getByRole("menuitem", { name: "重置" }).click();
    await expect.poll(() => shown('[data-slot="menu-popup"]')).toBeNull();
  });

  it.each(["pointer", "Enter"] as const)(
    "runs a radio row's onClick after the choice, so a handler that closes the menu keeps it (%s)",
    async (input) => {
      const events: string[] = [];
      function Fixture() {
        const [open, setOpen] = useState(false);
        const [tone, setTone] = useState("默认");
        return (
          <Menu open={open} onOpenChange={setOpen}>
            <MenuTrigger render={<button type="button" />}>语气：{tone}</MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              <MenuRadioGroup
                value={tone}
                onValueChange={(next: string) => {
                  events.push(`choose ${next}`);
                  setTone(next);
                }}
              >
                {["默认", "简洁", "详细"].map((label) => (
                  <MenuRadioItem
                    key={label}
                    value={label}
                    onClick={() => {
                      events.push(`click ${label}`);
                      setOpen(false);
                    }}
                  >
                    {label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        );
      }
      await render(<Fixture />);
      const trigger = page.getByRole("button", { name: "语气：默认" });
      const concise = page.getByRole("menuitemradio", { name: "简洁" });
      if (input === "pointer") {
        await trigger.click();
        await concise.click();
      } else {
        (trigger.element() as HTMLElement).focus();
        await userEvent.keyboard("{ArrowDown}");
        await expect.element(page.getByRole("menuitemradio", { name: "默认" })).toHaveFocus();
        await userEvent.keyboard("{ArrowDown}");
        await expect.element(concise).toHaveFocus();
        await userEvent.keyboard("{Enter}");
      }
      await expect.poll(() => events).toEqual(["choose 简洁", "click 简洁"]);
      await expect.element(page.getByRole("button", { name: "语气：简洁" })).toBeVisible();
      await expect.poll(() => shown('[data-slot="menu-popup"]')).toBeNull();
    },
  );

  it("lets a control inside a row take its own press without choosing the row", async () => {
    const onRow = vi.fn();
    const onStar = vi.fn();
    await render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>模型</MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuItem onClick={onRow}>
            <span>GPT-5.5</span>
            <button type="button" aria-label="收藏 GPT-5.5" onClick={onStar}>
              ☆
            </button>
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    await page.getByRole("button", { name: "模型" }).click();
    await page.getByRole("button", { name: "收藏 GPT-5.5" }).click();
    expect(onStar).toHaveBeenCalledOnce();
    expect(onRow).not.toHaveBeenCalled();
    expect(shown('[data-slot="menu-popup"]')).not.toBeNull();
    // The row itself still chooses.
    await page.getByRole("menuitem", { name: /GPT-5.5/ }).click({ position: { x: 8, y: 8 } });
    expect(onRow).toHaveBeenCalledOnce();
  });

  it.each(["pointer", "Enter"] as const)(
    "reports a press on the radio row already chosen (%s), as Base UI did",
    async (input) => {
      // A picker may show the same model chosen under two accounts and commit on any press.
      const onValueChange = vi.fn();
      await render(
        <Menu>
          <MenuTrigger render={<button type="button" />}>模型</MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            <MenuRadioGroup value="sonnet" onValueChange={onValueChange}>
              <MenuRadioItem value="sonnet">Claude Sonnet</MenuRadioItem>
              <MenuRadioItem value="opus">Claude Opus</MenuRadioItem>
            </MenuRadioGroup>
          </ComposerPickerMenuPopup>
        </Menu>,
      );
      const trigger = page.getByRole("button", { name: "模型" });
      const chosen = page.getByRole("menuitemradio", { name: "Claude Sonnet" });
      if (input === "pointer") {
        await trigger.click();
        await chosen.click();
      } else {
        (trigger.element() as HTMLElement).focus();
        await userEvent.keyboard("{ArrowDown}");
        await expect.element(chosen).toHaveFocus();
        await userEvent.keyboard("{Enter}");
      }
      await expect.poll(() => onValueChange.mock.calls.map(([value]) => value)).toEqual(["sonnet"]);
    },
  );

  it("chooses a row that is also a tooltip trigger, with a React event", async () => {
    // The rail's pin buttons are menu rows rendered as tooltip triggers; their click handlers
    // are merged and read the React event (`nativeEvent`), as Base UI handed it.
    const onPin = vi.fn((event: React.MouseEvent<HTMLElement>) => event.nativeEvent.type);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    try {
      await render(
        <Menu>
          <MenuTrigger render={<button type="button" />}>更多</MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            <Tooltip>
              <TooltipTrigger
                render={<MenuItem closeOnClick={false} aria-label="固定：插件" onClick={onPin} />}
              >
                ★
              </TooltipTrigger>
              <TooltipPopup>固定</TooltipPopup>
            </Tooltip>
          </ComposerPickerMenuPopup>
        </Menu>,
      );
      await page.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menuitem", { name: "固定：插件" }).click();
      await expect.poll(() => onPin.mock.results.map((result) => result.value)).toEqual(["click"]);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("closes after a plain row whose handler takes the press over (preventDefault)", async () => {
    // The sidebar's PR opener prevents the default to own the press; Base UI closed the menu
    // anyway, and a row that closes on choice still does.
    const onOpen = vi.fn((event: React.MouseEvent<HTMLElement>) => event.preventDefault());
    await render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>3 个拉取请求</MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuItem onClick={onOpen}>#97 修复小组件快照</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    await page.getByRole("button", { name: "3 个拉取请求" }).click();
    await page.getByRole("menuitem", { name: "#97 修复小组件快照" }).click();
    expect(onOpen).toHaveBeenCalledOnce();
    await expect.poll(() => shown('[data-slot="menu-popup"]')).toBeNull();
  });

  it("leaves focus in a field a row opened, rather than handing it back to the trigger", async () => {
    // UI SDK hands focus back once the menu has finished closing (Base UI at once); a field
    // the row opened and focused in between keeps it (the docx preview's change request).
    function Fixture() {
      const [asking, setAsking] = useState(false);
      return (
        <div className="flex flex-col gap-4 p-8">
          <Menu>
            <MenuTrigger render={<button type="button" />}>缩放</MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              <MenuItem onClick={() => setAsking(true)}>请求修改</MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
          {asking ? <textarea autoFocus aria-label="修改内容" /> : null}
        </div>
      );
    }
    await render(<Fixture />);
    await page.getByRole("button", { name: "缩放" }).click();
    await page.getByRole("menuitem", { name: "请求修改" }).click();
    await expect.poll(() => shown('[data-slot="menu-popup"]')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(page.getByRole("textbox", { name: "修改内容" })).toHaveFocus();
  });

  it("hands a radio group's number values back as numbers", async () => {
    const onValueChange = vi.fn();
    await render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>线宽</MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuRadioGroup value={2} onValueChange={onValueChange}>
            {[1, 2, 4].map((width) => (
              <MenuRadioItem key={width} value={width}>
                {`${width} 像素`}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    await page.getByRole("button", { name: "线宽" }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "2 像素" }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "4 像素" }).click();
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange.mock.calls[0]![0]).toBe(4);
  });
});

describe("Menu with a submenu, by a real pointer path", () => {
  // A person opens a submenu, moves back to a sibling row of the parent menu and presses it. The
  // press must choose that row the first time (Base UI's behaviour; the model picker relies on it).
  it.each(["press", "hover"] as const)(
    "chooses a parent row on the first press while a submenu opened by %s is still open",
    async (opening) => {
      const onSelect = vi.fn();
      await render(
        <div className="p-8">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>对话</MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              <MenuItem onClick={() => onSelect("重命名")}>重命名</MenuItem>
              <MenuSub>
                <MenuSubTrigger>移到空间</MenuSubTrigger>
                <MenuSubPopup>
                  <MenuItem onClick={() => onSelect("工作")}>工作</MenuItem>
                  <MenuItem onClick={() => onSelect("个人")}>个人</MenuItem>
                </MenuSubPopup>
              </MenuSub>
              <MenuItem onClick={() => onSelect("归档")}>归档</MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        </div>,
      );
      await page.getByRole("button", { name: "对话" }).click();
      const subTrigger = page.getByRole("menuitem", { name: "移到空间" });
      if (opening === "press") await subTrigger.click();
      else await subTrigger.hover();
      await expect.element(page.getByRole("menuitem", { name: "工作" })).toBeVisible();
      // Back to the parent: a sibling row, pressed once.
      await page.getByRole("menuitem", { name: "归档" }).click();
      await expect.poll(() => onSelect.mock.calls.map(([label]) => label)).toEqual(["归档"]);
    },
  );
});

describe("Submenu on a narrow window", () => {
  // A phone-width window, with the menu at its left edge: the submenu fits on neither side. It
  // must still be reachable (Base UI moved it below its row), so its rows can be pressed.
  it("opens below its row when neither side has room, and its rows can be chosen", async () => {
    const onPick = vi.fn();
    const [width, height] = [window.innerWidth, window.innerHeight];
    await page.viewport(390, 700);
    try {
      await render(
        <div className="p-2">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>更多</MenuTrigger>
            <ComposerPickerMenuPopup align="start" className="w-64 min-w-64">
              <MenuSub>
                <MenuSubTrigger>帮助</MenuSubTrigger>
                <MenuSubPopup className="w-64 min-w-64">
                  <MenuItem onClick={() => onPick("按键绑定")}>按键绑定</MenuItem>
                  <MenuItem onClick={() => onPick("反馈")}>反馈</MenuItem>
                </MenuSubPopup>
              </MenuSub>
            </ComposerPickerMenuPopup>
          </Menu>
        </div>,
      );
      await page.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menuitem", { name: "帮助" }).click();
      const row = page.getByRole("menuitem", { name: "按键绑定" });
      await expect.element(row).toBeVisible();
      await expect
        .poll(() => {
          const box = row.element().getBoundingClientRect();
          return box.left >= 0 && box.right <= window.innerWidth;
        })
        .toBe(true);
      await row.click();
      expect(onPick).toHaveBeenCalledWith("按键绑定");
    } finally {
      await page.viewport(width, height);
    }
  });
});

describe("A dialog opened from a menu row", () => {
  // A row asks for confirmation in a dialog while its menu would stay open (a radio row). The
  // dialog's first press must do its job, as on Base UI, not only close the menu.
  it("takes its first press", async () => {
    const onClose = vi.fn();
    function Fixture() {
      const [confirming, setConfirming] = useState(false);
      return (
        <div className="p-8">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>状态</MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              <MenuRadioGroup value="打开" onValueChange={() => setConfirming(true)}>
                <MenuRadioItem value="打开">打开</MenuRadioItem>
                <MenuRadioItem value="关闭">关闭</MenuRadioItem>
              </MenuRadioGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogPopup>
              <DialogTitle>关闭这个拉取请求？</DialogTitle>
              <Button onClick={onClose}>确认关闭</Button>
            </DialogPopup>
          </Dialog>
        </div>
      );
    }
    await render(<Fixture />);
    await page.getByRole("button", { name: "状态" }).click();
    await page.getByRole("menuitemradio", { name: "关闭" }).click();
    await expect.element(page.getByRole("dialog", { name: "关闭这个拉取请求？" })).toBeVisible();
    await expect.poll(() => shown('[data-slot="menu-popup"]')).toBeNull();
    await page.getByRole("button", { name: "确认关闭" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Menu outside press", () => {
  it.each(["no submenu", "submenu open"] as const)(
    "only closes the menu (%s): the press does not reach what is under it",
    async (state) => {
      const onOutside = vi.fn();
      await render(
        <div className="flex gap-40 p-8">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>对话</MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              <MenuItem>重命名</MenuItem>
              <MenuSub>
                <MenuSubTrigger>移到空间</MenuSubTrigger>
                <MenuSubPopup>
                  <MenuItem>工作</MenuItem>
                </MenuSubPopup>
              </MenuSub>
            </ComposerPickerMenuPopup>
          </Menu>
          <Button variant="outline" onClick={onOutside}>
            外面的按钮
          </Button>
        </div>,
      );
      await page.getByRole("button", { name: "对话" }).click();
      if (state === "submenu open") {
        await page.getByRole("menuitem", { name: "移到空间" }).click();
        await expect.element(page.getByRole("menuitem", { name: "工作" })).toBeVisible();
      }
      // A press where the button is, whatever covers it (Base UI covered the page while a menu
      // was open; UI SDK swallows the press instead).
      await page.getByRole("button", { name: "外面的按钮" }).click({ force: true });
      await expect.poll(() => shown('[data-slot="menu-popup"]')).toBeNull();
      expect(onOutside).not.toHaveBeenCalled();
    },
  );
});

describe("Menu trigger rendered as a Moss Button", () => {
  it("keeps the trigger's slot and opens from the keyboard", async () => {
    const onSelect = vi.fn();
    await render(
      <Menu>
        <MenuTrigger render={<Button variant="outline" />}>操作</MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuItem onClick={() => onSelect("复制")}>复制</MenuItem>
          <MenuItem onClick={() => onSelect("移动")}>移动</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    const trigger = page.getByRole("button", { name: "操作" });
    // Code, tests and theme rules select popup triggers by this slot.
    await expect.element(trigger).toHaveAttribute("data-slot", "menu-trigger");
    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: "复制" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    // As in the other keyboard cases: the next key waits for the focus move it depends on.
    await expect.element(page.getByRole("menuitem", { name: "移动" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("移动");
    await expect.poll(() => shown('[role="menu"]')).toBeNull();
  });

  it("opens from a click and closes on Escape with focus back on the button", async () => {
    await render(
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />} />
        <ComposerPickerMenuPopup align="start">
          <MenuItem>重命名</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    const trigger = page.getByRole("button", { name: "更多操作" });
    await trigger.click();
    await expectInstant(() => shown('[role="menu"]'));
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => shown('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element());
  });
});

describe("Tooltip", () => {
  it("opens after its delay on hover, on keyboard focus at once, and closes on Escape", async () => {
    await render(
      <div className="flex gap-4 p-8">
        <Button variant="ghost">前</Button>
        <Tooltip>
          <TooltipTrigger delay={200} render={<Button variant="ghost" aria-label="复制路径" />}>
            复制
          </TooltipTrigger>
          <TooltipPopup>复制路径到剪贴板</TooltipPopup>
        </Tooltip>
      </div>,
    );
    const tip = () => shown('[data-slot="tooltip-popup"]');
    const trigger = page.getByRole("button", { name: "复制路径" });
    await trigger.hover();
    // Not before the delay the trigger asked for.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tip()).toBeNull();
    await expect.poll(tip, { timeout: 1_500 }).not.toBeNull();
    expect(tip()?.textContent).toBe("复制路径到剪贴板");
    await userEvent.unhover(trigger);
    await expect.poll(tip).toBeNull();

    (page.getByRole("button", { name: "前" }).element() as HTMLElement).focus();
    await userEvent.tab();
    await expect.poll(tip, { timeout: 1_500 }).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.poll(tip).toBeNull();
    await expect.element(trigger).toHaveFocus();
  });

  it("leaves Escape to a focused field's own handler while a tooltip shows", async () => {
    const fieldEscape = vi.fn();
    await render(
      <div className="flex gap-4 p-8">
        <Tooltip>
          <TooltipTrigger delay={0} render={<Button variant="ghost" aria-label="缩放" />}>
            100%
          </TooltipTrigger>
          <TooltipPopup>缩放</TooltipPopup>
        </Tooltip>
        <textarea
          aria-label="修改要求"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            fieldEscape();
          }}
        />
      </div>,
    );
    const tip = () => shown('[data-slot="tooltip-popup"]');
    // The pointer rests on the trigger (as after choosing a zoom row) while the field has focus.
    await page.getByRole("button", { name: "缩放" }).hover();
    await expect.poll(tip, { timeout: 1_500 }).not.toBeNull();
    (page.getByRole("textbox", { name: "修改要求" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    expect(fieldEscape).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("textbox", { name: "修改要求" })).toHaveFocus();
  });

  it("describes its trigger to assistive technology", async () => {
    await render(
      <Tooltip open>
        <TooltipTrigger render={<Button variant="ghost" aria-label="设置" />} />
        <TooltipPopup>打开设置</TooltipPopup>
      </Tooltip>,
    );
    const trigger = page.getByRole("button", { name: "设置" }).element();
    await expect.poll(() => shown('[data-slot="tooltip-popup"]')).not.toBeNull();
    const described = trigger.getAttribute("aria-describedby") ?? "";
    const labelled = trigger.getAttribute("aria-labelledby") ?? "";
    const ids = `${described} ${labelled}`.trim().split(/\s+/).filter(Boolean);
    const texts = ids.map((id) => document.getElementById(id)?.textContent ?? "");
    expect(texts.join(" ")).toContain("打开设置");
  });

  it("draws only the tooltip that shows, with the caller's style on its surface", async () => {
    await render(
      <div className="flex gap-4 p-8">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" aria-label="复制" />} />
          <TooltipPopup style={{ maxWidth: "12rem" }}>复制消息</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" aria-label="编辑" />} />
          <TooltipPopup>编辑消息</TooltipPopup>
        </Tooltip>
      </div>,
    );
    // Closed tooltips leave no surface and no text in the page (Base UI's behaviour).
    expect(document.querySelectorAll('[data-slot="tooltip-popup"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain("复制消息");
    (page.getByRole("button", { name: "复制" }).element() as HTMLElement).focus();
    await expect
      .poll(() => document.querySelectorAll('[data-slot="tooltip-popup"]').length)
      .toBe(1);
    const surface = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
    expect(surface.textContent).toBe("复制消息");
    expect(surface.style.maxWidth).toBe("12rem");
    await userEvent.keyboard("{Escape}");
    await expect
      .poll(() => document.querySelectorAll('[data-slot="tooltip-popup"]').length)
      .toBe(0);
  });
});

describe("Popover", () => {
  it("opens on press, takes focus into its content, closes on Escape and outside press", async () => {
    await render(
      <div className="flex gap-4 p-8">
        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>详情</PopoverTrigger>
          <PopoverPopup side="bottom" align="start" className="w-64">
            <PopoverTitle>项目详情</PopoverTitle>
            <Button>好的</Button>
          </PopoverPopup>
        </Popover>
        <Button variant="ghost">外面</Button>
      </div>,
    );
    const surface = () => shown('[data-slot="popover-popup"]');
    const trigger = page.getByRole("button", { name: "详情" });
    await trigger.click();
    await expectInstantOrQuick(surface);
    await expect.element(trigger).toHaveAttribute("data-popup-open");
    await expect.element(page.getByRole("button", { name: "好的" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.poll(surface).toBeNull();
    await expect.element(trigger).toHaveFocus();

    await trigger.click();
    await expect.poll(surface).not.toBeNull();
    await page.getByRole("button", { name: "外面" }).click();
    await expect.poll(surface).toBeNull();
  });
});

describe("Select", () => {
  function Fixture({ onValueChange }: { onValueChange: (value: unknown) => void }) {
    const [value, setValue] = useState<string | null>("comfortable");
    return (
      <Select
        value={value}
        onValueChange={(next) => {
          onValueChange(next);
          setValue(next as string);
        }}
        items={{ compact: "Compact", comfortable: "Comfortable", spacious: "Spacious" }}
      >
        <SelectTrigger aria-label="Density">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup surface="settings">
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="comfortable">Comfortable</SelectItem>
          <SelectItem value="spacious">Spacious</SelectItem>
        </SelectPopup>
      </Select>
    );
  }

  it("appears instantly, picks with the keyboard and returns focus to its trigger", async () => {
    const onValueChange = vi.fn();
    await render(<Fixture onValueChange={onValueChange} />);
    const trigger = page.getByRole("combobox", { name: "Density" });
    await trigger.click();
    await expectInstant(() => shown('[role="listbox"]'));
    // The list highlights the current value a frame or more after it is shown; an arrow key
    // pressed before that starts from no highlight and lands on the first item (main run
    // 44172496124 picked "compact"). Wait for each highlight, as a person sees it, before the
    // next key.
    await expect
      .element(page.getByRole("option", { name: "Comfortable" }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: "Spacious" }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("spacious");
    await expect.poll(() => shown('[role="listbox"]')).toBeNull();
    await expect.element(trigger).toHaveFocus();
    await expect.element(trigger).toHaveTextContent("Spacious");
  });

  it("closes on Escape without changing the value", async () => {
    const onValueChange = vi.fn();
    await render(<Fixture onValueChange={onValueChange} />);
    const trigger = page.getByRole("combobox", { name: "Density" });
    await trigger.click();
    await expect.poll(() => shown('[role="listbox"]')).not.toBeNull();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => shown('[role="listbox"]')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    await expect.element(trigger).toHaveFocus();
  });
});

/** An option drawn the way the theme list draws one: an icon beside a name. */
function ThemeOption({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true">Aa</span>
      <span>{name}</span>
    </span>
  );
}

function inViewport(element: Element) {
  const box = element.getBoundingClientRect();
  return box.top >= -1 && box.bottom <= window.innerHeight + 1;
}

describe("Select with rich options", () => {
  // Real Moss lists draw an icon beside a name that differs from the stored value (the theme
  // list: "Aa" + 陶土 for "clay"). The option must show what the caller drew, not its value, and
  // typeahead goes by the name (the values here share no letters with the names).
  const THEMES = [
    { value: "t1", name: "Clay 陶土" },
    { value: "t2", name: "Lavender 薰衣草" },
    { value: "t3", name: "Moss 苔藓" },
  ];

  it("shows each option's own content and types ahead by its text", async () => {
    const onValueChange = vi.fn();
    await render(
      <Select defaultValue="t1" onValueChange={onValueChange}>
        <SelectTrigger aria-label="主题">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup surface="settings">
          {THEMES.map((theme) => (
            <SelectItem key={theme.value} value={theme.value}>
              <ThemeOption name={theme.name} />
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>,
    );
    await page.getByRole("combobox", { name: "主题" }).click();
    for (const theme of THEMES) {
      const option = page.getByRole("option", { name: theme.name });
      await expect.element(option).toBeVisible();
      expect(option.element().textContent).toBe(`Aa${theme.name}`);
    }
    // Typeahead goes by what a person reads, not by the stored value.
    await userEvent.keyboard("m");
    const moss = page.getByRole("option", { name: "Moss 苔藓" });
    await expect.poll(() => moss.element().matches(":focus, [data-highlighted]")).toBe(true);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => onValueChange.mock.calls.at(-1)?.[0]).toBe("t3");
  });
});

describe("Positioners", () => {
  // UI SDK shows popups with the Popover API; its browser defaults (a white Canvas background,
  // overflow: auto) must not reach Moss's positioners, or frosted surfaces show white behind.
  it("are transparent, unclipped boxes for every popup kind", async () => {
    await render(
      <div className="flex gap-4 p-8">
        <Menu defaultOpen>
          <MenuTrigger render={<Button variant="outline" />}>菜单</MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            <MenuItem>一项</MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>,
    );
    await expect.poll(() => shown('[data-slot="menu-popup"]')).not.toBeNull();
    const positioner = shown('[data-slot="menu-popup"]')!.closest<HTMLElement>(
      '[data-slot$="-positioner"]',
    )!;
    const style = getComputedStyle(positioner);
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.overflow).toBe("visible");
    expect(style.color).toBe(getComputedStyle(document.body).color);
  });
});

describe("Long popups keep to the room on screen", () => {
  const LONG = Array.from({ length: 60 }, (_, index) => `选项 ${index + 1}`);

  it("caps a long select to the space on screen and scrolls inside it", async () => {
    const [width, height] = [window.innerWidth, window.innerHeight];
    await page.viewport(600, 420);
    try {
      await render(
        <div className="flex h-[400px] items-end p-4">
          <Select defaultValue={LONG[0]}>
            <SelectTrigger aria-label="长列表">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup surface="settings" alignItemWithTrigger={false} align="end">
              {LONG.map((label) => (
                <SelectItem key={label} value={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>,
      );
      await page.getByRole("combobox", { name: "长列表" }).click();
      await expect.poll(() => shown('[data-slot="select-popup"]')).not.toBeNull();
      const popup = shown('[data-slot="select-popup"]')!;
      await expect.poll(() => inViewport(popup)).toBe(true);
      const list = popup.querySelector<HTMLElement>('[data-slot="menu-popup-body"]')!;
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      // Base UI's scroll arrows: more below at the top, more above at the bottom.
      await expect
        .poll(() => popup.querySelector('[data-slot="select-scroll-down-arrow"]'))
        .not.toBeNull();
      expect(popup.querySelector('[data-slot="select-scroll-up-arrow"]')).toBeNull();
      list.scrollTop = list.scrollHeight;
      await expect
        .poll(() => popup.querySelector('[data-slot="select-scroll-up-arrow"]'))
        .not.toBeNull();
      await expect
        .poll(() => popup.querySelector('[data-slot="select-scroll-down-arrow"]'))
        .toBeNull();
      await userEvent.keyboard("{Escape}");
    } finally {
      await page.viewport(width, height);
    }
  });

  it("caps a long menu the same way", async () => {
    const [width, height] = [window.innerWidth, window.innerHeight];
    await page.viewport(600, 420);
    try {
      await render(
        <div className="flex h-[400px] items-end p-4">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>移到项目</MenuTrigger>
            <ComposerPickerMenuPopup align="start">
              {LONG.map((label) => (
                <MenuItem key={label}>{label}</MenuItem>
              ))}
            </ComposerPickerMenuPopup>
          </Menu>
        </div>,
      );
      await page.getByRole("button", { name: "移到项目" }).click();
      await expect.poll(() => shown('[data-slot="menu-popup"]')).not.toBeNull();
      await expect.poll(() => inViewport(shown('[data-slot="menu-popup"]')!)).toBe(true);
      await userEvent.keyboard("{Escape}");
    } finally {
      await page.viewport(width, height);
    }
  });
});

describe("Combobox with search", () => {
  function Fixture({ onValueChange }: { onValueChange: (value: unknown) => void }) {
    const [query, setQuery] = useState("");
    const filtered = BRANCHES.filter((branch) => branch.includes(query));
    return (
      <Combobox
        items={BRANCHES}
        filteredItems={filtered}
        autoHighlight
        value={null}
        onValueChange={onValueChange}
      >
        <ComboboxTrigger data-testid="branch-trigger">分支</ComboboxTrigger>
        <ComboboxPopup align="start" side="bottom" className="w-80">
          <div className="border-b p-1">
            <ComboboxInput
              aria-label="搜索分支"
              placeholder="搜索分支"
              showTrigger={false}
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ComboboxEmpty>没有匹配的分支</ComboboxEmpty>
          <ComboboxList>
            {filtered.map((branch, index) => (
              <ComboboxItem key={branch} value={branch} index={index}>
                {branch}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }

  it.each(["Enter", "Process"] as const)(
    "leaves the highlighted option unpicked while Enter (%s) confirms a pinyin candidate",
    async (confirmKey) => {
      const onValueChange = vi.fn();
      await render(<Fixture onValueChange={onValueChange} />);
      await page.getByTestId("branch-trigger").click();
      const search = page.getByRole("combobox", { name: "搜索分支" });
      await expect.element(search).toBeVisible();
      // The pinyin being composed ("fe") matches a branch, which is auto-highlighted while the
      // candidate is confirmed.
      await composeChineseWithEnter(
        search.element() as HTMLElement,
        "fe",
        "分支",
        confirmKey,
        async () => {
          await expect
            .element(page.getByRole("option", { name: "feat/ui-sdk-controls" }))
            .toBeVisible();
        },
      );
      await expect.poll(() => (search.element() as HTMLInputElement).value).toBe("分支");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(onValueChange).not.toHaveBeenCalled();
      await expect.element(search).toBeVisible();
    },
  );

  it("picks the highlighted option with a plain Enter", async () => {
    const onValueChange = vi.fn();
    await render(<Fixture onValueChange={onValueChange} />);
    await page.getByTestId("branch-trigger").click();
    const search = page.getByRole("combobox", { name: "搜索分支" });
    await search.fill("rel");
    await expect.element(page.getByRole("option", { name: "release/1.0.7" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => onValueChange.mock.calls[0]?.[0]).toBe("release/1.0.7");
  });
});
