/**
 * A menu under a pointer that does not move. When the popup moves or shrinks out from under a
 * resting pointer (its first placement, rows removed, a view switch), Chrome sends the popup a
 * real `pointerleave` although the person did nothing. UI SDK answered every leave by dropping
 * the highlight and moving focus to the popup, so a keyboard user lost their place: the next
 * arrow started over and the Power picker's hidden slider item missed its key.
 */
import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "./menu";

let setRowCount: (count: number) => void = () => {};

function Fixture() {
  const [rows, setRows] = useState(6);
  setRowCount = setRows;
  return (
    <div style={{ padding: "40px" }}>
      <Menu>
        <MenuTrigger render={<button type="button" />}>更多</MenuTrigger>
        <ComposerPickerMenuPopup align="start" side="bottom">
          {/* Rows past the count stay in the page but take no room, as a view switch does. */}
          {Array.from({ length: 6 }, (_, index) => (
            <MenuItem key={index} className={index < rows ? undefined : "hidden"}>
              {`第 ${index + 1} 项`}
            </MenuItem>
          ))}
        </ComposerPickerMenuPopup>
      </Menu>
      <button type="button" style={{ marginTop: "320px" }}>
        外面
      </button>
    </div>
  );
}

const row = (label: string) => page.getByRole("menuitem", { name: label, exact: true });
const shownMenu = () => document.querySelector('[role="menu"]');
const frames = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

async function openFromKeyboard() {
  (page.getByRole("button", { name: "更多" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(row("第 1 项")).toHaveFocus();
}

/** Moves the real pointer to a page point, then leaves it resting there. */
async function restPointerAt(x: number, y: number) {
  const spot = document.createElement("div");
  spot.style.cssText = `position:fixed;left:${x - 2}px;top:${y - 2}px;width:4px;height:4px;z-index:2147483647`;
  document.body.append(spot);
  await userEvent.hover(spot);
  spot.remove();
}

describe("Menu under a resting pointer", () => {
  it("keeps the keyboard highlight when the popup shrinks out from under a pointer that did not move", async () => {
    await render(<Fixture />);
    await openFromKeyboard();
    const box = (row("第 6 项").element() as HTMLElement).getBoundingClientRect();
    await userEvent.keyboard("{Escape}");
    await expect.poll(shownMenu).toBeNull();

    // The pointer rests where the last row will be, then the menu opens over it from the keyboard.
    await restPointerAt(box.left + box.width / 2, box.top + box.height / 2);
    await openFromKeyboard();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(row("第 2 项")).toHaveFocus();

    // Rows hide; the popup shrinks and the pointer is outside it without having moved.
    setRowCount(2);
    await expect
      .poll(
        () =>
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
            (item) => item.offsetParent,
          ).length,
      )
      .toBe(2);
    await frames(6);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(document.activeElement).toBe(row("第 2 项").element());
    expect(row("第 2 项").element()).toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(row("第 1 项")).toHaveFocus();
  });

  it("still drops a hovered row's highlight when the pointer really moves out of the popup", async () => {
    await render(<Fixture />);
    await page.getByRole("button", { name: "更多" }).click();
    await expect.poll(shownMenu).not.toBeNull();
    await row("第 3 项").hover();
    await expect.element(row("第 3 项")).toHaveAttribute("data-highlighted");

    await page.getByRole("button", { name: "外面" }).hover();
    await expect.element(row("第 3 项")).not.toHaveAttribute("data-highlighted");
    expect(shownMenu()).not.toBeNull();
  });
});
