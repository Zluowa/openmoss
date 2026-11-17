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
import { Menu, MenuItem, MenuTrigger } from "./menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";

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
    await userEvent.keyboard("{ArrowDown}");
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
