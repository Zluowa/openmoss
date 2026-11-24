// FILE: hitArea.browser.tsx
// Purpose: The shared hit area has no look of its own (no fill, border or padding), takes keyboard
//          focus with the standard ring, presses once per click or Enter without turning pending,
//          and does nothing when disabled.
// Layer: Web appearance tests (real Chromium, real Moss CSS).

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HitArea } from "./hit-area";

describe("HitArea", () => {
  beforeEach(async () => {
    await page.viewport(800, 600);
  });

  it("is a plain press target: no look, a focus ring on keyboard focus, one press per Enter", async () => {
    // A handler that returns a promise must not hold the target pending.
    const onClick = vi.fn(() => new Promise<void>(() => {}));
    await render(
      <div className="bg-background p-6">
        <HitArea onClick={onClick} className="block w-40">
          <span>照片</span>
        </HitArea>
      </div>,
    );
    const target = document.querySelector<HTMLElement>("[data-hit-area]")!;
    expect(target.tagName).toBe("BUTTON");
    expect(target.textContent).toBe("照片");
    const style = getComputedStyle(target);
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.borderTopWidth).toBe("0px");
    expect(style.paddingTop).toBe("0px");
    // The app's interaction cursor: a hand on the web…
    expect(style.cursor).toBe("pointer");
    expect(style.boxShadow).toBe("none");

    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(target);
    await expect.poll(() => getComputedStyle(target).boxShadow).not.toBe("none");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(target.getAttribute("aria-busy")).toBeNull();
  });

  it("takes the desktop app's arrow, as every interactive target there does", async () => {
    document.documentElement.setAttribute("data-runtime", "electron");
    try {
      await render(
        <HitArea onClick={() => {}} className="block w-40">
          <span>照片</span>
        </HitArea>,
      );
      const target = document.querySelector<HTMLElement>("[data-hit-area]")!;
      expect(getComputedStyle(target).cursor).toBe("default");
    } finally {
      document.documentElement.removeAttribute("data-runtime");
    }
  });

  it("does nothing when disabled and shows it", async () => {
    const onClick = vi.fn();
    await render(
      <HitArea onClick={onClick} disabled aria-label="上传照片" className="size-20">
        <span aria-hidden>+</span>
      </HitArea>,
    );
    const target = document.querySelector<HTMLElement>("[data-hit-area]")!;
    expect(target.getAttribute("aria-label")).toBe("上传照片");
    await userEvent.click(page.elementLocator(target), { force: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(Number(getComputedStyle(target).opacity)).toBeCloseTo(0.64, 2);
    expect(getComputedStyle(target).cursor).toBe("default");
  });
});
