import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

it.each([
  {
    name: "CSS native inset with reader navigation",
    dataChanged: true,
    targetLast: true,
    footer: 64,
    viewOffset: 0,
    reader: true,
    cssInset: true,
  },
  {
    name: "CSS native inset with custom offset",
    dataChanged: true,
    targetLast: true,
    footer: 64,
    viewOffset: 144,
    reader: false,
    cssInset: true,
  },
  {
    name: "CSS native inset",
    dataChanged: true,
    targetLast: true,
    footer: 64,
    viewOffset: 0,
    reader: false,
    cssInset: true,
  },
  {
    name: "CSS native inset without data change",
    dataChanged: false,
    targetLast: true,
    footer: 64,
    viewOffset: 0,
    reader: false,
    cssInset: true,
  },
  {
    name: "unchanged data",
    dataChanged: false,
    targetLast: true,
    footer: 0,
    viewOffset: 0,
    reader: false,
  },
  {
    name: "removed leading row",
    dataChanged: true,
    targetLast: true,
    footer: 0,
    viewOffset: 0,
    reader: false,
  },
  {
    name: "header and footer",
    dataChanged: true,
    targetLast: true,
    footer: 64,
    viewOffset: 0,
    reader: false,
  },
  {
    name: "custom end offset",
    dataChanged: true,
    targetLast: true,
    footer: 64,
    viewOffset: 80,
    reader: false,
  },
  {
    name: "nonfinal target",
    dataChanged: true,
    targetLast: false,
    footer: 0,
    viewOffset: 0,
    reader: false,
  },
  {
    name: "reader navigation",
    dataChanged: true,
    targetLast: true,
    footer: 0,
    viewOffset: 0,
    reader: true,
  },
])(
  "preserves a shrinking current target: $name",
  async ({ dataChanged, targetLast, footer, viewOffset, reader, cssInset }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const css = document.createElement("style");
    css.textContent = ".ci816-native-inset { padding-top: 16px; }";
    document.head.append(css);
    const root = createRoot(host);
    const listRef = createRef<LegendListRef>();
    const rows = Array.from({ length: 12 }, (_, i) => i);
    const targetItem = targetLast ? 11 : 5;
    const renderList = (data: number[], height: number) =>
      flushSync(() =>
        root.render(
          <LegendList
            className={cssInset ? "ci816-native-inset" : undefined}
            ref={listRef}
            data={data}
            extraData={height}
            keyExtractor={String}
            estimatedItemSize={60}
            drawDistance={2000}
            recycleItems={false}
            maintainVisibleContentPosition
            maintainScrollAtEnd={false}
            ListHeaderComponent={footer ? <div style={{ height: 23 }} /> : undefined}
            ListFooterComponent={footer ? <div style={{ height: footer }} /> : undefined}
            style={{ height: 240, width: 320 }}
            renderItem={({ item }) => (
              <div data-shrink-item={item} style={{ height: item === targetItem ? height : 60 }}>
                {item}
              </div>
            )}
          />,
        ),
      );
    try {
      renderList(rows, 200);
      await expect
        .poll(() => listRef.current?.getState().contentLength)
        .toBe(860 + footer + (footer ? 23 : 0));
      await listRef.current!.scrollToEnd({ animated: false });
      const node = listRef.current!.getScrollableNode() as HTMLElement;
      await expect
        .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
        .toBeLessThanOrEqual(1);
      const next = dataChanged ? rows.slice(1) : rows;
      if (dataChanged) renderList(next, 200);
      const pending = cssInset
        ? listRef.current!.scrollToEnd({ animated: false, viewOffset })
        : listRef.current!.scrollToIndex({
            index: next.indexOf(targetItem),
            viewPosition: 1,
            viewOffset,
            animated: false,
          });
      if (reader) await listRef.current!.scrollToOffset({ offset: 200, animated: false });
      renderList(next, 157);
      await pending;
      await expect
        .poll(() => listRef.current!.getState().contentLength)
        .toBe((dataChanged ? 757 : 817) + footer + (footer ? 23 : 0));
      const customCssTarget =
        cssInset && viewOffset > 0
          ? listRef.current!.getState().contentLength - node.clientHeight + footer - viewOffset
          : null;
      const expectedOffset = reader
        ? 200
        : customCssTarget !== null
          ? customCssTarget
          : targetLast
            ? node.scrollHeight - node.clientHeight - viewOffset
            : next.indexOf(targetItem) * 60 + 157 - 240;
      await expect.poll(() => Math.abs(node.scrollTop - expectedOffset)).toBeLessThanOrEqual(1);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      css.remove();
    }
  },
);
