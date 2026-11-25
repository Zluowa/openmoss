// FILE: textAction.browser.tsx
// Purpose: The quiet text action is the shared ghost Button: 13 px (xs) or 14 px (sm), the normal
//          weight role, the muted ink that turns to the foreground on hover, and a press target.
// Layer: UI primitive browser regression

import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { TextAction } from "./text-action";

/** The computed value a class resolves to in Moss's CSS. */
function probe(className: string, property: "fontWeight" | "color"): string {
  const element = document.createElement("span");
  element.className = className;
  document.body.append(element);
  const value = getComputedStyle(element)[property];
  element.remove();
  return value;
}

afterEach(async () => {
  await cleanup();
});

it("is the shared ghost Button at 13 px, the normal weight and the muted ink", async () => {
  const onClick = vi.fn();
  await render(
    <div>
      <div data-testid="away" style={{ width: 20, height: 20 }} />
      <div style={{ padding: 80 }}>
        <TextAction onClick={onClick}>清除</TextAction>
      </div>
    </div>,
  );
  const action = page.getByRole("button", { name: "清除", exact: true });
  await expect.element(action).toBeVisible();
  // Park the shared browser pointer away from the button so an earlier test file's
  // pointer position cannot leave :hover active on mount.
  await userEvent.hover(page.getByTestId("away"));
  const element = action.element() as HTMLElement;
  expect(element.getAttribute("data-slot")).toBe("button");
  expect(element.hasAttribute("data-text-action")).toBe(true);
  const style = getComputedStyle(element);
  expect(style.fontSize).toBe("13px");
  expect(style.fontWeight).toBe(probe("font-normal", "fontWeight"));
  await expect
    .poll(() => getComputedStyle(element).color)
    .toBe(probe("text-muted-foreground", "color"));
  await userEvent.hover(action);
  await expect.poll(() => getComputedStyle(element).color).toBe(probe("text-foreground", "color"));
  await action.click();
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("comes at 14 px on its own line (sm)", async () => {
  await render(<TextAction size="sm">Load earlier messages</TextAction>);
  const action = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await expect.element(action).toBeVisible();
  expect(getComputedStyle(action.element()).fontSize).toBe("14px");
});
