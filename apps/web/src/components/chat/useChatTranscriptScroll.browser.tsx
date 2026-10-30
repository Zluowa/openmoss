import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, ThreadId } from "@synara/contracts";
import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import type { TimelineEntry } from "../../session-logic";

const EMPTY_TIMELINE: [] = [];
const waitForFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

describe("transcript follow after switching threads", () => {
  it.each([
    "no reader",
    "reader before shrink",
    "reader during shrink",
    "reader after an uncommitted shrink notification",
  ] as const)("observes a real completing layout (%s)", async (mode) => {
    const node = document.createElement("div");
    node.style.cssText =
      "height:200px;width:320px;overflow:auto;overflow-anchor:none;position:fixed;left:0;top:0";
    const content = document.createElement("div");
    content.style.height = "1000px";
    node.append(content);
    document.body.append(node);
    node.scrollTop = 800;
    const listeners = new Set<(size: number) => void>();
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    let holdScroll = false;
    let deferNative = false;
    const pending: Array<() => void> = [];
    const nativeEvents: Event[] = [];
    const queuedNotifications: Array<() => void> = [];
    const notify = () =>
      controls?.onIsAtEndChange(node.scrollHeight - node.clientHeight - node.scrollTop <= 1);
    const onScroll = (event: Event) => {
      nativeEvents.push(event);
      if (deferNative) queuedNotifications.push(notify);
      else notify();
    };
    node.addEventListener("scroll", onScroll);
    const scrollToEnd = vi.fn(async () => {
      if (holdScroll) await new Promise<void>((resolve) => pending.push(resolve));
      node.scrollTop = node.scrollHeight - node.clientHeight;
    });
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
        getState: () => ({
          listen: (_key: "totalSize", callback: (size: number) => void) => {
            listeners.add(callback);
            return () => listeners.delete(callback);
          },
        }),
      } as unknown as LegendListRef,
    };
    function CompletingLayout({ streaming }: { streaming: boolean }) {
      useLayoutEffect(() => {
        if (streaming) return;
        if (mode === "reader before shrink") node.scrollTop = 300;
        // Size listeners run before React applies the corresponding DOM size.
        for (const callback of listeners) callback(904);
        if (mode === "reader after an uncommitted shrink notification") {
          // A virtual estimate is not evidence of any real browser clamp.
          node.scrollTop = 788;
        } else {
          content.style.height = "904px";
          expect(node.scrollHeight - node.clientHeight).toBe(704);
          expect(node.scrollTop).toBe(mode === "reader before shrink" ? 300 : 704);
          if (mode === "reader during shrink") node.scrollTop = 300;
        }
        for (const callback of listeners) callback(4000);
        content.style.height = "4000px";
      }, [streaming]);
      return null;
    }
    function Harness({ streaming }: { streaming: boolean }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("completion-commit-layout"),
        legendListRef: listRef,
        timelineEntries: [
          {
            kind: "message",
            id: "tail",
            createdAt: "2026-10-11T00:00:00Z",
            message: {
              id: MessageId.makeUnsafe("tail"),
              role: "assistant",
              streaming,
              text: streaming ? "Started" : "Completed",
              createdAt: "2026-10-11T00:00:00Z",
            },
          },
        ],
        hasStreamingAssistantText: streaming,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return <CompletingLayout streaming={streaming} />;
    }
    const screen = await render(<Harness streaming />);
    try {
      await waitForFrames();
      controls!.onIsAtEndChange(true);
      scrollToEnd.mockClear();
      nativeEvents.length = 0;
      deferNative = true;
      holdScroll = true;
      await screen.rerender(<Harness streaming={false} />);
      await expect.poll(() => pending.length).toBe(1);
      await expect.poll(() => nativeEvents.length).toBeGreaterThan(0);
      expect(nativeEvents.every((event) => event.isTrusted)).toBe(true);
      deferNative = false;
      for (const deliver of queuedNotifications.splice(0)) deliver();
      await waitForFrames();
      // Inspect ownership before a late imperative write could hide an error.
      // The adapter does not model LegendList's own pending-write cancellation.
      expect(controls!.isUserScrollDetached).toBe(mode !== "no reader");
      holdScroll = false;
      for (const release of pending.splice(0)) release();
      await waitForFrames();
      if (mode === "no reader") {
        expect(scrollToEnd).toHaveBeenCalledTimes(2);
        expect(node.scrollHeight - node.clientHeight - node.scrollTop).toBeLessThanOrEqual(4);
      }
    } finally {
      holdScroll = false;
      deferNative = false;
      for (const release of pending.splice(0)) release();
      await screen.unmount();
      await waitForFrames();
      node.removeEventListener("scroll", onScroll);
      node.remove();
      expect(listeners.size).toBe(0);
    }
  });

  it("keeps one live geometry subscription across commits and rejects disposed listeners", async () => {
    const node = document.createElement("div");
    const makeList = () => {
      const listeners = new Set<() => void>();
      const getScrollableNode = vi.fn(() => node);
      const unsubscribe = vi.fn();
      const list = {
        scrollToEnd: async () => {},
        getScrollableNode,
        getState: () => ({
          listen: (_key: "totalSize", listener: () => void) => {
            listeners.add(listener);
            return () => {
              unsubscribe();
              listeners.delete(listener);
            };
          },
        }),
      } as unknown as LegendListRef;
      return { list, listeners, unsubscribe, getScrollableNode };
    };
    const first = makeList();
    const second = makeList();
    const listRef: { current: LegendListRef | null } = { current: first.list };
    function Harness({
      revision,
      owner = listRef,
    }: {
      revision: number;
      owner?: { current: LegendListRef | null };
    }) {
      useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("geometry-list-identity"),
        legendListRef: owner,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return <span>{revision}</span>;
    }
    const screen = await render(
      <StrictMode>
        <Harness revision={0} />
      </StrictMode>,
    );
    let unmounted = false;
    try {
      expect(first.listeners.size).toBe(1);
      expect(first.unsubscribe).toHaveBeenCalledTimes(1);
      const originalListener = [...first.listeners][0]!;
      await screen.rerender(
        <StrictMode>
          <Harness revision={1} />
        </StrictMode>,
      );
      expect([...first.listeners]).toEqual([originalListener]);
      expect(first.unsubscribe).toHaveBeenCalledTimes(1);
      listRef.current = second.list;
      await screen.rerender(
        <StrictMode>
          <Harness revision={2} />
        </StrictMode>,
      );
      expect(first.listeners.size).toBe(0);
      expect(second.listeners.size).toBe(1);
      first.getScrollableNode.mockClear();
      originalListener();
      expect(first.getScrollableNode).not.toHaveBeenCalled();
      // Returning to the same list object must not revive its old callback.
      listRef.current = first.list;
      await screen.rerender(
        <StrictMode>
          <Harness revision={3} />
        </StrictMode>,
      );
      expect(second.listeners.size).toBe(0);
      expect(first.listeners.size).toBe(1);
      first.getScrollableNode.mockClear();
      originalListener();
      expect(first.getScrollableNode).not.toHaveBeenCalled();
      const currentListener = [...first.listeners][0]!;
      const replacementOwner = { current: first.list };
      await screen.rerender(
        <StrictMode>
          <Harness revision={4} owner={replacementOwner} />
        </StrictMode>,
      );
      expect(first.listeners.size).toBe(1);
      expect([...first.listeners][0]).not.toBe(currentListener);
      first.getScrollableNode.mockClear();
      currentListener();
      expect(first.getScrollableNode).not.toHaveBeenCalled();
      const finalListener = [...first.listeners][0]!;
      await screen.unmount();
      unmounted = true;
      expect(first.listeners.size).toBe(0);
      first.getScrollableNode.mockClear();
      finalListener();
      expect(first.getScrollableNode).not.toHaveBeenCalled();
    } finally {
      if (!unmounted) await screen.unmount();
    }
  });

  it("does not acquire live-output follow from a historical transcript's native scroll", async () => {
    const node = document.createElement("div");
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000, writable: true },
      clientHeight: { value: 200 },
      scrollTop: { value: 800, writable: true },
    });
    const scrollToEnd = vi.fn(async () => {
      node.scrollTop = node.scrollHeight - node.clientHeight;
    });
    const listRef = {
      current: { scrollToEnd, getScrollableNode: () => node } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness() {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("native-reader-navigation"),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness />);
    try {
      await waitForFrames();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      controls!.onIsAtEndChange(true);
      scrollToEnd.mockClear();
      // Native navigation can come from accessibility or another viewport
      // controller without a preceding pointer/wheel event on the transcript.
      node.scrollTop = 100;
      controls!.onIsAtEndChange(false);
      await waitForFrames();
      expect(node.scrollTop).toBe(100);
      expect(scrollToEnd).not.toHaveBeenCalled();
      Object.defineProperty(node, "scrollHeight", { value: 2_000 });
      controls!.onIsAtEndChange(false);
      await waitForFrames();
      expect(node.scrollTop).toBe(100);
      expect(scrollToEnd).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    "following",
    "detached",
    "another thread",
    "another tail",
    "replacement list",
    "replacement container",
    "native reader",
    "native reader near end",
    "native reader with shrink",
    "native reader during recovery",
    "clamped layout",
    "coalesced clamped layout",
    "native reader before coalesced reflow",
    "native reader near end before coalesced reflow",
    "native reader during coalesced reflow",
    "native reader near end during coalesced reflow",
  ] as const)(
    "handles late completed-message layout without taking reader ownership (%s)",
    async (ownership) => {
      let node = document.createElement("div");
      Object.defineProperties(node, {
        scrollHeight: { value: 1_000, writable: true },
        clientHeight: { value: 200 },
        scrollTop: { value: 800, writable: true },
      });
      const sizeListeners = new Set<(size: number) => void>();
      const notifySize = () => {
        for (const listener of sizeListeners) listener(node.scrollHeight);
      };
      const listRef = {
        current: {
          scrollToEnd: async () => {
            node.scrollTop = node.scrollHeight - node.clientHeight;
          },
          getScrollableNode: () => node,
          getState: () => ({
            listen: (_key: "totalSize", listener: (size: number) => void) => {
              sizeListeners.add(listener);
              return () => sizeListeners.delete(listener);
            },
          }),
        } as unknown as LegendListRef,
      };
      let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
      function Harness({
        streaming,
        threadId = "completed-message-layout",
        messageId = "late-completed-message",
      }: {
        streaming: boolean;
        threadId?: string;
        messageId?: string;
      }) {
        controls = useChatTranscriptScroll({
          activeThreadId: ThreadId.makeUnsafe(threadId),
          legendListRef: listRef,
          timelineEntries: [
            {
              kind: "message",
              id: messageId,
              createdAt: "2026-03-17T19:12:28.000Z",
              message: {
                id: MessageId.makeUnsafe(messageId),
                role: "assistant",
                text: streaming ? "Started" : "Completed",
                streaming,
                createdAt: "2026-03-17T19:12:28.000Z",
              },
            },
          ],
          hasStreamingAssistantText: streaming,
          composerTranscriptInsetPx: 0,
          isInactiveSplitPane: false,
        });
        return null;
      }
      const screen = await render(<Harness streaming />);
      try {
        await waitForFrames();
        await screen.rerender(<Harness streaming={false} />);
        await waitForFrames();
        if (ownership === "another thread") {
          await screen.rerender(<Harness streaming={false} threadId="historical-thread" />);
        } else if (ownership === "another tail") {
          await screen.rerender(<Harness streaming={false} messageId="historical-tail" />);
        }
        await waitForFrames();
        // The actual streaming-to-completed transition has settled. A later
        // layout notification arrives with no more provider text to follow.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        controls!.onIsAtEndChange(true);
        expect(sizeListeners.size).toBe(1);
        if (ownership === "replacement list") {
          listRef.current = { ...listRef.current };
          node.scrollTop = 500;
          await screen.rerender(<Harness streaming={false} />);
          // The new imperative list can reuse its predecessor's DOM node.
          // Neither its scroll baseline nor its subscription may survive.
          expect(sizeListeners.size).toBe(1);
        } else if (ownership === "replacement container") {
          node = document.createElement("div");
          Object.defineProperties(node, {
            scrollHeight: { value: 1_000, writable: true },
            clientHeight: { value: 200 },
            scrollTop: { value: 500, writable: true },
          });
          notifySize();
        }
        if (ownership === "detached") controls!.onTranscriptNavigate();
        const coalescedReflow = ownership.includes("coalesced");
        const nearEndReader = ownership.startsWith("native reader near end");
        const readerScrollTop = nearEndReader
          ? ownership === "native reader near end before coalesced reflow"
            ? 767
            : coalescedReflow
              ? 755
              : 788
          : 100;
        if (coalescedReflow) {
          if (ownership.includes("before coalesced reflow")) {
            node.scrollTop = nearEndReader ? 790 : readerScrollTop;
          }
          notifySize();
          Object.defineProperty(node, "scrollHeight", { value: 967 });
          node.scrollTop = Math.min(node.scrollTop, 767);
          if (ownership.includes("during coalesced reflow")) {
            node.scrollTop = readerScrollTop;
          }
          // LegendList measures again while the DOM is still clamped to its
          // intermediate bottom. The native scroll event is coalesced until
          // after this next growth, hiding the 33px range loss from that event.
          notifySize();
          Object.defineProperty(node, "scrollHeight", { value: 1_053 });
          controls!.onIsAtEndChange(nearEndReader);
          await waitForFrames();
          expect(controls!.isUserScrollDetached).toBe(ownership.startsWith("native reader"));
          expect(node.scrollTop).toBe(
            ownership.startsWith("native reader") ? readerScrollTop : 853,
          );
          // The next notification is a separate later layout, after the
          // current recovery's programmatic-scroll guard has settled.
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        } else if (ownership === "clamped layout") {
          Object.defineProperty(node, "scrollHeight", { value: 700 });
          node.scrollTop = 500;
          // A browser clamp after shrink is not reader navigation, even when
          // the list has not reconciled its virtual end notification yet.
          controls!.onIsAtEndChange(false);
        } else if (ownership.startsWith("native reader")) {
          if (ownership === "native reader with shrink") {
            Object.defineProperty(node, "scrollHeight", { value: 700 });
          } else if (ownership === "native reader during recovery") {
            Object.defineProperty(node, "scrollHeight", { value: 2_000 });
            controls!.onIsAtEndChange(false);
          }
          node.scrollTop = readerScrollTop;
          // A virtual end threshold can still report true after a small native
          // upward movement. Real viewport ownership must not depend on it.
          controls!.onIsAtEndChange(nearEndReader);
          await waitForFrames();
          expect(node.scrollTop).toBe(readerScrollTop);
          expect(controls!.isUserScrollDetached).toBe(true);
        }
        Object.defineProperty(node, "scrollHeight", { value: 12_000 });
        controls!.onIsAtEndChange(false);
        await waitForFrames();
        expect(node.scrollTop).toBe(
          ownership === "following" ||
            ownership.endsWith("clamped layout") ||
            ownership.startsWith("replacement")
            ? 11_800
            : ownership.startsWith("native reader")
              ? readerScrollTop
              : 800,
        );
      } finally {
        await screen.unmount();
        expect(sizeListeners.size).toBe(0);
      }
    },
  );

  it.each([false, true])(
    "settles final text after list measurement while respecting reader ownership (detached: %s)",
    async (detached) => {
      const node = document.createElement("div");
      Object.defineProperties(node, {
        scrollHeight: { value: 1_000, writable: true },
        clientHeight: { value: 200 },
        scrollTop: { value: 800, writable: true },
      });
      let deferMeasurement = false;
      let finishMeasurement: (() => void) | undefined;
      const scrollToEnd = vi.fn(async () => {
        node.scrollTop = node.scrollHeight - node.clientHeight;
        if (deferMeasurement) {
          deferMeasurement = false;
          await new Promise<void>((resolve) => {
            finishMeasurement = resolve;
          });
        }
      });
      const listRef = {
        current: { scrollToEnd, getScrollableNode: () => node } as unknown as LegendListRef,
      };
      let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
      function Harness({ streaming }: { streaming: boolean }) {
        controls = useChatTranscriptScroll({
          activeThreadId: ThreadId.makeUnsafe("final-batch"),
          legendListRef: listRef,
          timelineEntries: [
            {
              kind: "message",
              id: "final-message",
              createdAt: "2026-03-17T19:12:28.000Z",
              message: {
                id: MessageId.makeUnsafe("final-message"),
                role: "assistant",
                text: streaming ? "Started" : "Final paragraph. ".repeat(500),
                streaming,
                createdAt: "2026-03-17T19:12:28.000Z",
              },
            },
          ],
          hasStreamingAssistantText: streaming,
          composerTranscriptInsetPx: 0,
          isInactiveSplitPane: false,
        });
        return null;
      }
      const screen = await render(<Harness streaming />);
      try {
        await waitForFrames();
        deferMeasurement = true;
        await screen.rerender(<Harness streaming={false} />);
        await vi.waitFor(() => expect(finishMeasurement).toBeDefined());
        // The imperative jump starts with the old row height. The final batch is
        // measured before its promise resolves, without another message event.
        Object.defineProperty(node, "scrollHeight", { value: 12_000 });
        if (detached) controls!.onTranscriptNavigate();
        finishMeasurement!();
        await waitForFrames();
        expect(node.scrollTop).toBe(detached ? 800 : 11_800);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("follows an idle destination after leaving a detached transcript", async () => {
    // Detached nodes have no layout, so model an overflowing viewport directly.
    const node = document.createElement("div");
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 300, writable: true },
    });
    const scrollToEnd = vi.fn(async () => {
      node.scrollTop = 800;
    });
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness({
      threadId,
      timelineEntries = EMPTY_TIMELINE,
    }: {
      threadId: string;
      timelineEntries?: TimelineEntry[];
    }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness threadId="first" />);
    try {
      await waitForFrames();
      controls!.onTranscriptNavigate();
      await screen.rerender(<Harness threadId="first" />);
      await waitForFrames();
      expect(controls!.isUserScrollDetached).toBe(true);

      for (const threadId of ["second", "first"]) {
        node.scrollTop = 300;
        scrollToEnd.mockClear();
        await screen.rerender(<Harness threadId={threadId} />);
        await waitForFrames();
        expect(controls!.isUserScrollDetached).toBe(false);
        expect(scrollToEnd).toHaveBeenCalledTimes(1);
        expect(node.scrollTop).toBe(800);
        scrollToEnd.mockClear();
        for (const detail of ["Inspecting the boundary", "Verifying cancellation"]) {
          await screen.rerender(
            <Harness
              threadId={threadId}
              timelineEntries={[
                {
                  kind: "work",
                  id: "live-reasoning",
                  createdAt: "2026-03-17T19:12:28.000Z",
                  entry: {
                    id: "live-reasoning",
                    createdAt: "2026-03-17T19:12:28.000Z",
                    tone: "tool",
                    label: "Reasoning trace",
                    toolCallId: "reasoning-item",
                    toolStatus: "running",
                    detail,
                  },
                },
              ]}
            />,
          );
          await waitForFrames();
          expect(scrollToEnd).not.toHaveBeenCalled();
        }
        // Detach again so the return trip starts from a detached reader too.
        controls!.onTranscriptNavigate();
        await screen.rerender(<Harness threadId={threadId} />);
      }
    } finally {
      await screen.unmount();
    }
  });

  it.each([false, true])(
    "keeps live follow during the scroll guard (switch while pending: %s)",
    async (switchWhilePending) => {
      let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
      const node = document.createElement("div");
      node.style.cssText = "height: 200px; overflow: auto";
      const content = document.createElement("div");
      content.style.height = "1000px";
      node.append(content);
      document.body.append(node);
      let lastEndScrollTime = 0;
      const listRef = {
        current: {
          scrollToEnd: async () => {
            lastEndScrollTime = performance.now();
            node.scrollTop = node.scrollHeight;
          },
          getScrollableNode: () => node,
        } as unknown as LegendListRef,
      };
      function Harness({ threadId }: { threadId: string }) {
        controls = useChatTranscriptScroll({
          activeThreadId: ThreadId.makeUnsafe(threadId),
          legendListRef: listRef,
          timelineEntries: EMPTY_TIMELINE,
          hasStreamingAssistantText: true,
          composerTranscriptInsetPx: 0,
          isInactiveSplitPane: false,
        });
        return null;
      }
      const screen = await render(<Harness threadId="first" />);
      try {
        await waitForFrames();
        await screen.rerender(<Harness threadId="second" />);
        await waitForFrames();
        expect(node.scrollHeight - node.clientHeight - node.scrollTop).toBe(0);
        // A newly measured row can grow before the native scroll guard expires.
        // The list reports this geometry change without a reader gesture.
        content.style.height = "1600px";
        // Control only this notification's timestamp so a stalled test runner
        // cannot accidentally put it outside the native-scroll protection window.
        const notifyLayoutChange = () => {
          const clock = vi.spyOn(performance, "now").mockReturnValue(lastEndScrollTime);
          try {
            controls!.onIsAtEndChange(false);
          } finally {
            clock.mockRestore();
          }
        };
        notifyLayoutChange();
        if (switchWhilePending) {
          await screen.rerender(<Harness threadId="third" />);
          await waitForFrames();
          content.style.height = "2000px";
          notifyLayoutChange();
        }
        await vi.waitFor(() =>
          expect(node.scrollHeight - node.clientHeight - node.scrollTop).toBe(0),
        );
        expect(controls!.isUserScrollDetached).toBe(false);
      } finally {
        await screen.unmount();
        node.remove();
      }
    },
  );

  it("preserves send-anchor ownership when an idle destination starts streaming", async () => {
    const node = document.createElement("div");
    const scrollToEnd = vi.fn(async () => {});
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness({ threadId, streaming }: { threadId: string; streaming: boolean }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: streaming,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness threadId="first" streaming={false} />);
    try {
      await waitForFrames();
      await screen.rerender(<Harness threadId="second" streaming={false} />);
      await waitForFrames();
      scrollToEnd.mockClear();

      // Sending owns the scroll before the optimistic row appears. Provider text
      // can arrive while the 320ms anchor slide is still moving that row.
      controls!.tailAnchorScrollInFlightRef.current = true;
      await screen.rerender(<Harness threadId="second" streaming />);
      await waitForFrames();
      expect(scrollToEnd).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

describe("transcript detach on reader gestures", () => {
  function createOverflowingList() {
    // Detached nodes have no layout, so model an overflowing viewport directly.
    const node = document.createElement("div");
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 800, writable: true },
    });
    return {
      current: {
        scrollToEnd: vi.fn(async () => {}),
        getScrollableNode: () => node,
        getState: () => ({ isAtEnd: false }),
      } as unknown as LegendListRef,
    };
  }

  it("commits the detached follow state before an already queued frame runs", async () => {
    const listRef = createOverflowingList();
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    // Stands in for the list, which reads `followLiveOutput` from its last committed render.
    const committedFollow = { current: true };
    function List({ followLiveOutput }: { followLiveOutput: boolean }) {
      useLayoutEffect(() => {
        committedFollow.current = followLiveOutput;
      }, [followLiveOutput]);
      return null;
    }
    function Harness() {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("detach-frame"),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: true,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return <List followLiveOutput={!controls.isUserScrollDetached} />;
    }
    const screen = await render(<Harness />);
    try {
      await waitForFrames();
      expect(committedFollow.current).toBe(true);
      // Browsers deliver wheel input in the same frame as animation callbacks, so the
      // list's already queued maintain-at-end callback runs right after the gesture,
      // before any task React could schedule a deferred render in.
      requestAnimationFrame(() => {
        controls!.onMessagesWheelBase({ ctrlKey: false, deltaY: -120 } as never);
      });
      const followSeenByQueuedFrame = new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => resolve(committedFollow.current));
      });
      expect(await followSeenByQueuedFrame).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("detaches without a flushSync warning when a gesture lands inside a commit", async () => {
    const listRef = createOverflowingList();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function GestureDuringCommit({ fire }: { fire: boolean }) {
      useLayoutEffect(() => {
        if (fire) controls!.onMessagesPointerDownBase();
      }, [fire]);
      return null;
    }
    function Harness({ fire }: { fire: boolean }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("detach-commit"),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return <GestureDuringCommit fire={fire} />;
    }
    const screen = await render(<Harness fire={false} />);
    try {
      await waitForFrames();
      await screen.rerender(<Harness fire />);
      await waitForFrames();
      expect(controls!.isUserScrollDetached).toBe(true);
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("flushSync"))).toBe(
        false,
      );
    } finally {
      consoleError.mockRestore();
      await screen.unmount();
    }
  });
});
