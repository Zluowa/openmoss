import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const rows = Array.from({ length: 12 }, (_, index) => index);

it.each(
  (["queued", "active", "active-late-growth"] as const).flatMap((phase) =>
    (["growth", "reader-scroll", "disabled"] as const).map((change) => ({ phase, change })),
  ),
)(
  "preserves a $phase end follow through growth while respecting $change",
  async ({ phase, change }) => {
    const host = document.createElement("div");
    Object.assign(host.style, { width: "320px", height: "240px" });
    document.body.append(host);
    const root = createRoot(host);
    const listRef = createRef<LegendListRef>();
    const renderList = (height: number, follow = true) =>
      flushSync(() =>
        root.render(
          <LegendList
            ref={listRef}
            data={rows}
            extraData={height}
            keyExtractor={(item) => String(item)}
            estimatedItemSize={60}
            drawDistance={1_000}
            recycleItems={false}
            initialScrollAtEnd
            maintainScrollAtEnd={follow}
            maintainScrollAtEndThreshold={0.1}
            style={{ width: 320, height: 240 }}
            renderItem={({ item }) => (
              <div style={{ height: item === 11 ? height : 60 }}>{item}</div>
            )}
          />,
        ),
      );
    let frameSpy: { mockRestore: () => void } | undefined;
    let timerSpy: { mockRestore: () => void } | undefined;
    let unblockScroll = () => {};
    try {
      renderList(60);
      await expect.poll(() => listRef.current?.getState().isAtEnd).toBe(true);
      const node = listRef.current!.getScrollableNode() as HTMLElement;
      await expect
        .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
        .toBeLessThanOrEqual(1);
      const blockScroll = (event: Event) => {
        if (event.target === node) event.stopImmediatePropagation();
      };
      window.addEventListener("scroll", blockScroll, true);
      window.addEventListener("scrollend", blockScroll, true);
      unblockScroll = () => {
        window.removeEventListener("scroll", blockScroll, true);
        window.removeEventListener("scrollend", blockScroll, true);
      };
      const knownOffset = listRef.current!.getState().scroll;
      const pendingSettles: Array<() => void> = [];
      const browserWindow: Window = window;
      const setTimer = browserWindow.setTimeout.bind(browserWindow);
      if (phase !== "queued") {
        timerSpy = vi
          .spyOn(browserWindow, "setTimeout")
          .mockImplementation((callback, delay, ...args) => {
            if (
              typeof callback === "function" &&
              callback.toString().includes("state.maintainingScrollAtEnd === activeState")
            ) {
              pendingSettles.push(() => callback(...args));
              return 2_000_000 + pendingSettles.length;
            }
            return setTimer(callback, delay, ...args);
          });
      }
      renderList(80);
      await expect.poll(() => node.scrollTop).toBeGreaterThan(knownOffset);
      expect(listRef.current!.getState().scroll).toBe(knownOffset);
      if (phase !== "queued") await expect.poll(() => pendingSettles.length).toBeGreaterThan(0);
      const requestFrame = window.requestAnimationFrame.bind(window);
      const queued: FrameRequestCallback[] = [];
      // Test-only instrumentation holds the library's real queued follow callback.
      // Matching its stack does not replace layout or scroll behavior; the positive
      // capture assertion below fails if a dependency update changes this hook point.
      let holdFollow = phase === "queued";
      frameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        if (holdFollow && new Error().stack?.includes("doMaintainScrollAtEnd")) {
          queued.push(callback);
          return 1_000_000 + queued.length;
        }
        return requestFrame(callback);
      });
      renderList(100);
      if (phase === "queued") await expect.poll(() => queued.length).toBeGreaterThan(0);
      const originalOffset = node.scrollTop;
      renderList(220);
      await expect
        .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
        .toBeGreaterThan(24);
      // The native scroll event can arrive after a larger content layout. Force
      // that real event ordering while retaining the same visible scroll offset.
      unblockScroll();
      node.dispatchEvent(new Event("scroll"));
      await expect
        .poll(() => listRef.current!.getState().isWithinMaintainScrollAtEndThreshold)
        .toBe(false);
      if (phase === "active-late-growth") {
        // Another measurement can arrive after the delayed event, while the
        // previous instant follow still owns its pending settle timer.
        renderList(240);
      }
      if (change === "reader-scroll") {
        node.scrollTop -= 60;
        node.dispatchEvent(new Event("scroll"));
      } else if (change === "disabled") {
        renderList(phase === "active-late-growth" ? 240 : 220, false);
      }
      const offsetBeforeRelease = node.scrollTop;
      expect(offsetBeforeRelease).toBe(
        change === "reader-scroll" ? originalOffset - 60 : originalOffset,
      );
      holdFollow = false;
      timerSpy?.mockRestore();
      timerSpy = undefined;
      for (const settle of pendingSettles) settle();
      for (const callback of queued) callback(performance.now());
      if (change === "growth") {
        await expect
          .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
          .toBeLessThanOrEqual(1);
      } else {
        await new Promise<void>((resolve) => requestFrame(() => requestFrame(() => resolve())));
        expect(node.scrollTop).toBe(offsetBeforeRelease);
      }
    } finally {
      unblockScroll();
      frameSpy?.mockRestore();
      timerSpy?.mockRestore();
      flushSync(() => root.unmount());
      host.remove();
    }
  },
);
