import { describe, expect, it } from "vitest";

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

  it("does nothing outside a transcript or without a slot", () => {
    const anchor = { closest: () => null } as unknown as Element;
    expect(chainMcpAppWheel(anchor, { deltaX: 0, deltaY: 120 })).toBe(false);
    expect(chainMcpAppWheel(null, { deltaX: 0, deltaY: 120 })).toBe(false);
  });
});
