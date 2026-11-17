// FILE: popups.visual.tsx
// Purpose: Pixel baseline of Moss's list, popup and layer wrappers open (menu, select, combobox,
//          popover, tooltip, dialog, alert dialog, sheet, toast), light and dark, at the default
//          (comfortable) density. Taken on main before the move from Base UI to UI SDK (round
//          20261118-ui-sdk); later pull requests and library upgrades compare against it.
//          Run with `bun run test:browser:visual` in apps/web.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import {
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogClose,
} from "./alert-dialog";
import { Button } from "./button";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "./menu";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "./popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "./sheet";
import { ToastProvider, toastManager } from "./toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

// The toast stack reads the route to keep a thread's toasts on that thread.
vi.mock("@tanstack/react-router", () => ({ useParams: () => undefined }));
vi.mock("../../hooks/useDiffRouteSearch", () => ({ useDiffRouteSearch: () => ({}) }));

const THEMES = ["light", "dark"] as const;

function Stage({ children }: { children: ReactNode }) {
  return (
    <BrowserThemeFixture>
      <TooltipProvider>
        <div className="h-screen w-screen bg-background p-6 text-foreground">{children}</div>
      </TooltipProvider>
    </BrowserThemeFixture>
  );
}

function shownAt(selector: string): () => HTMLElement | null {
  return () => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).opacity === "1"
      ? element
      : null;
  };
}

async function shootElement(find: () => HTMLElement | null, name: string) {
  await expect.poll(find, { timeout: 3_000 }).not.toBeNull();
  await document.fonts.ready;
  // Two frames, then any running entry animation must have finished.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(
    find()!
      .getAnimations({ subtree: true })
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  await expect.element(page.elementLocator(find()!)).toMatchScreenshot(name);
}

describe.each(THEMES)("popups and layers (%s)", (theme) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(1200, 900);
  });
  afterEach(() => restoreTheme());

  it("menu with groups, a checkbox row, a shortcut and a submenu", async () => {
    await render(
      <Stage>
        <Menu open>
          <MenuTrigger render={<Button variant="outline" />}>更多</MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>对话</MenuGroupLabel>
              <MenuItem>
                重命名 <MenuShortcut>F2</MenuShortcut>
              </MenuItem>
              <MenuItem>复制链接</MenuItem>
              <MenuCheckboxItem checked>置顶</MenuCheckboxItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>移到空间</MenuSubTrigger>
            </MenuSub>
            <MenuItem variant="destructive">删除</MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      </Stage>,
    );
    await shootElement(shownAt('[role="menu"]'), `menu-${theme}`);
  });

  it("select open", async () => {
    await render(
      <Stage>
        <Select
          open
          value="comfortable"
          items={{ compact: "紧凑", comfortable: "舒适", spacious: "宽松" }}
        >
          <SelectTrigger aria-label="密度" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup surface="settings">
            <SelectItem value="compact">紧凑</SelectItem>
            <SelectItem value="comfortable">舒适</SelectItem>
            <SelectItem value="spacious">宽松</SelectItem>
          </SelectPopup>
        </Select>
      </Stage>,
    );
    await shootElement(shownAt('[role="listbox"]'), `select-${theme}`);
  });

  it("combobox open with search", async () => {
    const branches = ["main", "release/1.0.7", "feat/ui-sdk-controls"];
    await render(
      <Stage>
        <Combobox items={branches} open value="main">
          <ComboboxTrigger render={<Button variant="outline" />}>分支</ComboboxTrigger>
          <ComboboxPopup align="start" side="bottom" className="w-72">
            <div className="border-b p-1">
              <ComboboxInput aria-label="搜索分支" placeholder="搜索分支" showTrigger={false} />
            </div>
            <ComboboxList>
              {branches.map((branch, index) => (
                <ComboboxItem key={branch} value={branch} index={index}>
                  {branch}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </Stage>,
    );
    await shootElement(shownAt('[data-slot="combobox-popup"]'), `combobox-${theme}`);
  });

  it("popover and tooltip", async () => {
    await render(
      <Stage>
        <div className="flex gap-40">
          <Popover open>
            <PopoverTrigger render={<Button variant="outline" />}>详情</PopoverTrigger>
            <PopoverPopup side="bottom" align="start" className="w-64">
              <PopoverTitle>项目详情</PopoverTitle>
              <PopoverDescription>今天更新过。</PopoverDescription>
            </PopoverPopup>
          </Popover>
          <Tooltip open>
            <TooltipTrigger render={<Button variant="ghost" />}>提示</TooltipTrigger>
            <TooltipPopup side="bottom">复制路径</TooltipPopup>
          </Tooltip>
        </div>
      </Stage>,
    );
    await shootElement(shownAt('[data-slot="popover-popup"]'), `popover-${theme}`);
    await shootElement(shownAt('[data-slot="tooltip-popup"]'), `tooltip-${theme}`);
  });

  it("dialog", async () => {
    await render(
      <Stage>
        <Dialog open>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>重命名对话</DialogTitle>
              <DialogDescription>新名称会显示在侧边栏。</DialogDescription>
            </DialogHeader>
            <DialogPanel>内容区域</DialogPanel>
            <DialogFooter>
              <Button variant="ghost">取消</Button>
              <Button>保存</Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </Stage>,
    );
    await shootElement(shownAt('[role="dialog"]'), `dialog-${theme}`);
  });

  it("alert dialog", async () => {
    await render(
      <Stage>
        <AlertDialog open>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这段对话？</AlertDialogTitle>
              <AlertDialogDescription>删除后无法恢复。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>取消</AlertDialogClose>
              <Button variant="destructive">删除</Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </Stage>,
    );
    await shootElement(shownAt('[role="alertdialog"]'), `alert-dialog-${theme}`);
  });

  it("sheet", async () => {
    await render(
      <Stage>
        <Sheet open>
          <SheetPopup side="right">
            <SheetHeader>
              <SheetTitle>设置</SheetTitle>
              <SheetDescription>外观与密度</SheetDescription>
            </SheetHeader>
            <SheetPanel>面板内容</SheetPanel>
          </SheetPopup>
        </Sheet>
      </Stage>,
    );
    await shootElement(shownAt('[role="dialog"]'), `sheet-${theme}`);
  });

  it("toast", async () => {
    await render(
      <Stage>
        <ToastProvider>
          <span />
        </ToastProvider>
      </Stage>,
    );
    toastManager.add({ type: "success", title: "已保存", description: "设置已更新。", timeout: 0 });
    const toastTitle = shownAt('[data-slot="toast-viewport"] [data-slot="toast-title"]');
    await shootElement(
      () => toastTitle()?.closest<HTMLElement>('[data-slot="toast-viewport"] > *') ?? null,
      `toast-${theme}`,
    );
  });
});
