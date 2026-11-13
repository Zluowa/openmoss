import { describe, expect, it, vi } from "vitest";

import { chainMcpAppWheel, decodeMcpAppWheelMessage } from "./wheelChain";

describe("decodeMcpAppWheelMessage", () => {
  it("takes finite numbers only, with exactly the wheel keys, and clamps them", () => {
    expect(decodeMcpAppWheelMessage({ type: "moss:wheel", deltaX: 4, deltaY: -80 })).toEqual({
      deltaX: 4,
      deltaY: -80,
    });
    expect(decodeMcpAppWheelMessage({ type: "moss:wheel", deltaX: -5000, deltaY: 5000 })).toEqual({
      deltaX: -1000,
      deltaY: 1000,
    });
    for (const invalid of [
      null,
      [],
      { type: "moss:print-theme", deltaX: 0, deltaY: 1 },
      { type: "moss:wheel", deltaX: "1", deltaY: 1 },
      { type: "moss:wheel", deltaX: 0, deltaY: Number.NaN },
      { type: "moss:wheel", deltaX: 0, deltaY: 1, scrollTo: 0 },
      { type: "moss:wheel", deltaY: 1 },
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: {} },
    ]) {
      expect(decodeMcpAppWheelMessage(invalid)).toBeNull();
    }
  });
});

describe("chainMcpAppWheel", () => {
  it("scrolls the transcript that holds the widget's slot by the delta", () => {
    const scroller = { scrollTop: 200, scrollLeft: 0 };
    const anchor = {
      closest: (selector: string) =>
        selector === '[data-chat-scroll-container="true"]' ? scroller : null,
    } as unknown as Element;
    expect(chainMcpAppWheel(anchor, { deltaX: 0, deltaY: 120 })).toBe(true);
    expect(scroller.scrollTop).toBe(320);
    expect(chainMcpAppWheel(anchor, { deltaX: 0, deltaY: -40 })).toBe(true);
    expect(scroller.scrollTop).toBe(280);
    expect(scroller.scrollLeft).toBe(0);
  });

  it("tells the transcript about the gesture first, then moves it by the whole first wheel", () => {
    class FakeWheelEvent {
      defaultPrevented = false;
      constructor(
        readonly type: string,
        readonly init: { deltaY: number; bubbles: boolean; cancelable: boolean },
      ) {}
    }
    vi.stubGlobal("WheelEvent", FakeWheelEvent);
    try {
      const scroller = { scrollTop: 1_000, scrollLeft: 0 };
      const seen: Array<{ deltaY: number; scrollTopThen: number }> = [];
      let cancel = false;
      const anchor = {
        closest: () => scroller,
        dispatchEvent: (event: FakeWheelEvent) => {
          // The transcript's own wheel handler: it sees the gesture before the scroll lands.
          seen.push({ deltaY: event.init.deltaY, scrollTopThen: scroller.scrollTop });
          expect(event.init).toMatchObject({ bubbles: true, cancelable: true });
          return !cancel;
        },
      } as unknown as Element;
      // The very first wheel over the widget moves the chat by all of it, not a few px.
      expect(chainMcpAppWheel(anchor, { deltaX: 0, deltaY: 300 })).toBe(true);
      expect(scroller.scrollTop).toBe(1_300);
      expect(seen).toEqual([{ deltaY: 300, scrollTopThen: 1_000 }]);
      // A listener that cancels the wheel keeps the chat where it is.
      cancel = true;
      expect(chainMcpAppWheel(anchor, { deltaX: 0, deltaY: -300 })).toBe(true);
      expect(scroller.scrollTop).toBe(1_300);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does nothing outside a transcript or without a slot", () => {
    const anchor = { closest: () => null } as unknown as Element;
    expect(chainMcpAppWheel(anchor, { deltaX: 0, deltaY: 120 })).toBe(false);
    expect(chainMcpAppWheel(null, { deltaX: 0, deltaY: 120 })).toBe(false);
  });
});
