// FILE: cursorRule.browser.tsx
// Purpose: The cursor rule (design standard, "光标"), as Claude desktop sets it: every control
//          shows the arrow in the desktop app and the hand on the web; a link in text shows the
//          hand in both; a disabled control shows the arrow. One part of each kind.
// Layer: UI primitive browser regression

import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "./button";
import { HitArea } from "./hit-area";
import { IconButton } from "./icon-button";
import { ListRow } from "./list-row";
import { Menu, MenuItem } from "./menu";
import { Switch } from "./switch";
import { Tabs } from "./tabs";
import { TextLink } from "./text-link";

const anchor = { getBoundingClientRect: () => new DOMRect(24, 24, 0, 0) };

function Parts() {
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <Button data-testid="button">保存</Button>
      <IconButton data-testid="icon-button" label="复制">
        <span aria-hidden>⧉</span>
      </IconButton>
      <HitArea data-testid="hit-area">一张卡片</HitArea>
      <HitArea data-testid="hit-area-disabled" disabled>
        停用的卡片
      </HitArea>
      <ListRow data-testid="list-row" title="一行" onClick={() => {}} />
      <div data-testid="custom-row" className="cursor-interaction">
        自己画的整行
      </div>
      <span data-testid="variant" className="[span&]:cursor-interaction">
        变体
      </span>
      <Tabs
        ariaLabel="视图"
        tabs={[
          { id: "a", label: "概览" },
          { id: "b", label: "文件" },
        ]}
        selected="a"
        onSelect={() => {}}
      />
      <Switch data-testid="switch" aria-label="开关" />
      <p>
        看 <TextLink href="#docs">说明</TextLink>
      </p>
      <Menu open>
        <ComposerPickerMenuPopup anchor={anchor} align="start" side="bottom" size="normal">
          <MenuItem>重命名</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

function cursorOf(element: Element | null): string {
  if (!element) throw new Error("part not rendered");
  return getComputedStyle(element).cursor;
}

function cursors() {
  const listRow = document.querySelector("[data-testid='list-row']");
  return {
    button: cursorOf(document.querySelector("[data-testid='button']")),
    iconButton: cursorOf(page.getByRole("button", { name: "复制" }).element()),
    hitArea: cursorOf(document.querySelector("[data-testid='hit-area']")),
    listRow: cursorOf(listRow?.querySelector("button") ?? listRow),
    tab: cursorOf(page.getByRole("tab", { name: "文件" }).element()),
    menuItem: cursorOf(page.getByRole("menuitem", { name: "重命名" }).element()),
    switch: cursorOf(page.getByRole("switch", { name: "开关" }).element()),
    textLink: cursorOf(page.getByRole("link", { name: "说明" }).element()),
    disabled: cursorOf(document.querySelector("[data-testid='hit-area-disabled']")),
    customRow: cursorOf(document.querySelector("[data-testid='custom-row']")),
    variant: cursorOf(document.querySelector("[data-testid='variant']")),
  };
}

afterEach(async () => {
  await cleanup();
  delete document.documentElement.dataset.runtime;
});

describe("cursor rule", () => {
  it("on the web: controls and links show the hand, a disabled control the arrow", async () => {
    await render(<Parts />);
    await expect.element(page.getByRole("menuitem", { name: "重命名" })).toBeVisible();
    expect(cursors()).toEqual({
      button: "pointer",
      iconButton: "pointer",
      hitArea: "pointer",
      listRow: "pointer",
      tab: "pointer",
      menuItem: "pointer",
      switch: "pointer",
      textLink: "pointer",
      disabled: "default",
      customRow: "pointer",
      variant: "pointer",
    });
  });

  it("in the desktop app: controls show the arrow, only the link in text the hand", async () => {
    document.documentElement.dataset.runtime = "electron";
    await render(<Parts />);
    await expect.element(page.getByRole("menuitem", { name: "重命名" })).toBeVisible();
    expect(cursors()).toEqual({
      button: "default",
      iconButton: "default",
      hitArea: "default",
      listRow: "default",
      tab: "default",
      menuItem: "default",
      switch: "default",
      textLink: "pointer",
      disabled: "default",
      customRow: "default",
      variant: "default",
    });
  });
});
