import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

it.each(["removed", "retained", "emptied"] as const)(
  "keeps measured content intact when an active scroll target is %s after removing a row",
  async (target) => {
    const host = document.createElement("div");
    Object.assign(host.style, { width: "320px", height: "240px" });
    document.body.append(host);
    const root = createRoot(host);
    const listRef = createRef<LegendListRef>();
    const rows = Array.from({ length: 12 }, (_, index) => index);
    const renderList = (data: number[]) =>
      flushSync(() =>
        root.render(
          <LegendList
            ref={listRef}
            data={data}
            keyExtractor={(item) => String(item)}
            estimatedItemSize={24}
            drawDistance={1_000}
            recycleItems={false}
            style={{ width: 320, height: 240 }}
            renderItem={({ item }) => <div style={{ height: 60 }}>{item}</div>}
          />,
        ),
      );
    let unsubscribe: (() => void) | undefined;
    try {
      renderList(rows);
      await expect.poll(() => listRef.current?.getState().contentLength).toBe(720);
      const sizes: number[] = [];
      unsubscribe = listRef.current!.getState().listen("totalSize", (size) => sizes.push(size));
      const scroll = listRef.current!.scrollToIndex({
        index: target === "retained" ? 5 : 11,
        viewPosition: 1,
        animated: true,
      });
      // Change the data while the real animated request still references its old index.
      renderList(target === "emptied" ? [] : rows.slice(0, -1));
      await scroll;
      const expectedLength = target === "emptied" ? 0 : 660;
      await expect.poll(() => listRef.current!.getState().contentLength).toBe(expectedLength);
      expect(sizes.length).toBeGreaterThan(0);
      // A later correct measurement must not conceal an intermediate height reset,
      // which can clamp the native scroll position before the next scroll event.
      expect(sizes).toEqual(Array.from({ length: sizes.length }, () => expectedLength));
      if (target === "emptied") {
        renderList(rows);
        await expect.poll(() => listRef.current!.getState().contentLength).toBe(720);
        await listRef.current!.scrollToEnd({ animated: false });
        const node = listRef.current!.getScrollableNode() as HTMLElement;
        await expect
          .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
          .toBeLessThanOrEqual(1);
      }
    } finally {
      unsubscribe?.();
      flushSync(() => root.unmount());
      host.remove();
    }
  },
);
