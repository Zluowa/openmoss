import { LegendList } from "@legendapp/list/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";

it("blocks hidden rows from pointer hit testing without changing their inherited interaction styles", async () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "320px",
    height: "240px",
  });
  document.body.append(host);
  const root = createRoot(host);
  const onClick = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <LegendList
          data={Array.from({ length: 12 }, (_, index) => `row-${index}`)}
          keyExtractor={(item) => item}
          estimatedItemSize={48}
          drawDistance={1_000}
          recycleItems={false}
          initialScrollAtEnd
          data-testid="reveal-list"
          style={{ width: 320, height: 240 }}
          renderItem={({ item }) => (
            <button
              data-item={item}
              type="button"
              onClick={onClick}
              style={{ display: "block", width: "100%", height: 48 }}
            >
              {item}
            </button>
          )}
        />,
      ),
    );
    const scroller = host.querySelector<HTMLElement>('[data-testid="reveal-list"]')!;
    const wrapper = scroller.querySelector<HTMLElement>('div[style*="opacity"]')!;
    const button = host.querySelector<HTMLButtonElement>('[data-item="row-11"]')!;
    expect(wrapper.style.opacity).toBe("0");
    scroller.scrollTop = scroller.scrollHeight;
    const hiddenRect = button.getBoundingClientRect();
    const point = {
      x: hiddenRect.x + hiddenRect.width / 2,
      y: hiddenRect.y + hiddenRect.height / 2,
    };
    const hiddenPointerEvents = getComputedStyle(button).pointerEvents;
    const hiddenScrollHeight = scroller.scrollHeight;
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(240);
    expect(button.contains(document.elementFromPoint(point.x, point.y))).toBe(false);
    await page.elementLocator(host).click({ position: { ...point }, force: true });
    expect(onClick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await expect.poll(() => wrapper.style.opacity).toBe("1");
    const visibleButton = host.querySelector<HTMLButtonElement>('[data-item="row-11"]')!;
    const visibleRect = visibleButton.getBoundingClientRect();
    expect(scroller.scrollHeight).toBe(hiddenScrollHeight);
    expect(visibleRect.width).toBe(hiddenRect.width);
    expect(visibleRect.height).toBe(hiddenRect.height);
    expect(
      Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
    ).toBeLessThanOrEqual(1);
    expect(visibleButton.contains(document.elementFromPoint(point.x, point.y))).toBe(true);
    await page.elementLocator(visibleButton).click();
    expect(onClick).toHaveBeenCalledOnce();
    // Revealing must not invalidate every descendant's inherited pointer-events value.
    expect(getComputedStyle(visibleButton).pointerEvents).toBe(hiddenPointerEvents);
  } finally {
    vi.useRealTimers();
    flushSync(() => root.unmount());
    host.remove();
  }
});
