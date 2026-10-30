import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { MessageId } from "@synara/contracts";
import { createRef, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useTailAnchorScroll } from "./useTailAnchorScroll";

const anchorId = MessageId.makeUnsafe("handoff-anchor");
const rows = Array.from({ length: 12 }, (_, index) => index);

it.each([false, true, "after-handoff", "native-clamp", "immediate-overflow"] as const)(
  "hands the native anchor position to the list before its delayed scroll event (detached=%s)",
  async (detached) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const listRef = createRef<LegendListRef>();
    const ownership = { current: false };
    let pendingEnd: Promise<void> | undefined;
    const onFinished = vi.fn(() => {
      const state = listRef.current!.getState().isWithinMaintainScrollAtEndThreshold;
      if (detached === "after-handoff") {
        node!.scrollTop = 200;
      } else if (detached === "native-clamp") {
        const oldOffset = node!.scrollTop;
        renderList(400, true);
        expect(node!.scrollTop).toBeLessThan(oldOffset);
        expect(node!.scrollHeight - node!.clientHeight - node!.scrollTop).toBeLessThanOrEqual(1);
      }
      return state;
    });
    function Harness({ height, follow }: { height: number; follow: boolean }) {
      const timelineRoot = useRef<HTMLDivElement>(null);
      useTailAnchorScroll({
        listRef,
        timelineRootRef: timelineRoot,
        anchorMessageId: anchorId,
        anchorScrollInFlightRef: ownership,
        animateAnchorSlide: detached === "immediate-overflow",
        contentChangeSignal: height,
        messageChangeSignal: height,
        onAnchorSlideFinished: onFinished,
      });
      return (
        <div ref={timelineRoot}>
          <LegendList
            ref={listRef}
            data={rows}
            extraData={height}
            keyExtractor={String}
            estimatedItemSize={60}
            drawDistance={2000}
            maintainScrollAtEnd={follow}
            maintainScrollAtEndThreshold={0.1}
            style={{ height: 240, width: 320 }}
            renderItem={({ item }) => (
              <div
                {...(item === 10 ? { "data-message-id": anchorId } : {})}
                style={{ height: item === 10 ? 20 : item === 11 ? height : 60 }}
              />
            )}
          />
        </div>
      );
    }
    const renderList = (height: number, follow = false) =>
      flushSync(() => root.render(<Harness height={height} follow={follow} />));
    let node: HTMLElement | null = null;
    const blockNativeEvent = (event: Event) => {
      if (event.target === node) event.stopImmediatePropagation();
    };
    window.addEventListener("scroll", blockNativeEvent, true);
    window.addEventListener("scrollend", blockNativeEvent, true);
    let glideClock =
      detached === "immediate-overflow" ? vi.spyOn(performance, "now").mockReturnValue(0) : null;
    try {
      renderList(220);
      node = listRef.current!.getScrollableNode() as HTMLElement;
      const scrollToEnd = listRef.current!.scrollToEnd.bind(listRef.current);
      vi.spyOn(listRef.current!, "scrollToEnd").mockImplementation((options) => {
        pendingEnd = scrollToEnd(options);
        return pendingEnd;
      });
      if (detached === "immediate-overflow") {
        // The full response arrives before the send motion can finish. Advance
        // real layout frames while remaining inside that motion's first 80ms.
        renderList(2_000);
        for (let frame = 0; frame < 6; frame += 1) {
          glideClock!.mockReturnValue(frame * 16);
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        expect(onFinished).toHaveBeenCalledTimes(1);
        expect(ownership.current).toBe(false);
        glideClock!.mockRestore();
        glideClock = null;
        await pendingEnd;
        expect(node.scrollHeight - node.clientHeight - node.scrollTop).toBeLessThanOrEqual(1);
        return;
      }
      await expect.poll(() => node!.scrollTop).toBe(600);
      expect(onFinished).not.toHaveBeenCalled();
      // Native writes from the anchor precede the browser's coalesced event.
      // The virtualizer has not yet learned that the reader reached the bottom.
      expect(listRef.current!.getState().isWithinMaintainScrollAtEndThreshold).toBe(false);
      if (detached === true) {
        ownership.current = false;
        node.scrollTop = 200;
      }
      renderList(500);
      await expect.poll(() => onFinished.mock.calls.length).toBe(1);
      expect(ownership.current).toBe(false);
      if (detached === "after-handoff") {
        await pendingEnd;
        expect(node.scrollTop).toBe(200);
        // Cancellation resolves its own request and leaves a later explicit
        // return to the bottom usable, rather than poisoning pending state.
        await listRef.current!.scrollToEnd({ animated: false });
        expect(node.scrollHeight - node.clientHeight - node.scrollTop).toBeLessThanOrEqual(1);
        return;
      }
      if (detached === true) {
        expect(node.scrollTop).toBe(200);
        expect(onFinished.mock.results[0]?.value).toBe(false);
      } else {
        // A new, larger-than-threshold chunk can commit before the native event.
        renderList(626, true);
        await expect
          .poll(() => node!.scrollHeight - node!.clientHeight - node!.scrollTop)
          .toBeLessThanOrEqual(1);
      }
    } finally {
      glideClock?.mockRestore();
      window.removeEventListener("scroll", blockNativeEvent, true);
      window.removeEventListener("scrollend", blockNativeEvent, true);
      flushSync(() => root.unmount());
      host.remove();
    }
  },
);
