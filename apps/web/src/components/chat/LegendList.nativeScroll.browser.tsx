import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

it.each([false, true])(
  "preserves a valid native position during a virtual-size rebuild (horizontal: %s)",
  async (horizontal) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const listRef = createRef<LegendListRef>();
    try {
      flushSync(() =>
        root.render(
          <LegendList
            ref={listRef}
            horizontal={horizontal}
            data={Array.from({ length: 12 }, (_, index) => index)}
            keyExtractor={String}
            estimatedItemSize={1}
            drawDistance={1_000}
            recycleItems={false}
            style={horizontal ? { width: 240, height: 320 } : { width: 320, height: 240 }}
            renderItem={({ item }) => (
              <div style={horizontal ? { width: 60, height: 320 } : { height: 60 }}>{item}</div>
            )}
          />,
        ),
      );
      await expect.poll(() => listRef.current?.getState().contentLength).toBe(720);
      const node = listRef.current!.getScrollableNode() as HTMLElement;
      const scrollTo = vi.spyOn(node, "scrollTo");
      const offset = () => (horizontal ? node.scrollLeft : node.scrollTop);
      const nativeContentLength = () => (horizontal ? node.scrollWidth : node.scrollHeight);
      const nativeViewportLength = horizontal ? node.clientWidth : node.clientHeight;
      const atEnd = listRef.current!.scrollToIndex({ index: 11, viewPosition: 1, animated: false });
      expect(offset()).toBe(480);
      // Size reports can precede the matching DOM commit. Keep the rendered
      // viewport authoritative while the next virtual layout is being calculated.
      for (let index = 0; index < 12; index += 1) {
        listRef.current!.setItemSize(
          String(index),
          horizontal ? { width: 1, height: 320 } : { height: 1, width: 320 },
        );
      }
      expect(listRef.current!.getState().contentLength).toBeLessThan(nativeViewportLength);
      expect(nativeContentLength()).toBe(720);
      if (horizontal) node.scrollLeft = 480;
      else node.scrollTop = 480;
      expect(offset()).toBe(480);
      scrollTo.mockClear();
      node.dispatchEvent(new Event("scroll"));
      expect(scrollTo).not.toHaveBeenCalled();
      expect(offset()).toBe(480);
      await atEnd;
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  },
);
