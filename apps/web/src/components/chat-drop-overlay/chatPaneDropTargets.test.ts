// FILE: chatPaneDropTargets.test.ts
// Purpose: Cover the pointer-drag path onto chat panes: which pane a point lands in, how a
//          zone maps to a split, and the drag lifecycle against registered panes.
// Layer: UI helpers test

import { ThreadId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelThreadTabDrag,
  dropThreadTabDrag,
  dropZoneToDirectionSide,
  moveThreadTabDrag,
  registerChatPaneDropTarget,
  resolveChatPaneDropTargetAt,
  type ChatPaneDropTarget,
} from "./chatPaneDropTargets";

const THREAD_A = ThreadId.makeUnsafe("thread-a");

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

describe("resolveChatPaneDropTargetAt", () => {
  it("picks the innermost pane containing the point", () => {
    const outer = { target: "outer", rect: rect(0, 0, 800, 600) };
    const inner = { target: "inner", rect: rect(400, 0, 400, 600) };

    expect(resolveChatPaneDropTargetAt([outer, inner], { x: 500, y: 300 })).toBe("inner");
    expect(resolveChatPaneDropTargetAt([outer, inner], { x: 100, y: 300 })).toBe("outer");
  });

  it("ignores hidden (zero-size) panes and points outside every pane", () => {
    const hidden = { target: "hidden", rect: rect(0, 0, 0, 0) };
    const pane = { target: "pane", rect: rect(0, 0, 200, 200) };

    expect(resolveChatPaneDropTargetAt([hidden, pane], { x: 0, y: 0 })).toBe("pane");
    expect(resolveChatPaneDropTargetAt([pane], { x: 300, y: 50 })).toBeNull();
  });
});

describe("dropZoneToDirectionSide", () => {
  it.each([
    ["top", "vertical", "first"],
    ["bottom", "vertical", "second"],
    ["left", "horizontal", "first"],
    ["right", "horizontal", "second"],
  ] as const)("maps %s to a %s split on the %s side", (zone, direction, side) => {
    expect(dropZoneToDirectionSide(zone)).toEqual({ direction, side });
  });
});

describe("thread tab drag lifecycle", () => {
  const unregisters: Array<() => void> = [];
  afterEach(() => {
    cancelThreadTabDrag();
    for (const unregister of unregisters.splice(0)) unregister();
  });

  function registerPane(zone: "left" | "right" | null) {
    const target = {
      getRect: () => rect(0, 0, 400, 300),
      resolveZone: vi.fn(() => zone),
      showZone: vi.fn(),
      drop: vi.fn(),
    } satisfies ChatPaneDropTarget;
    unregisters.push(registerChatPaneDropTarget(target));
    return target;
  }

  const drag = (point: { x: number; y: number }) =>
    moveThreadTabDrag({
      ownerId: "strip",
      payload: { threadId: THREAD_A },
      ghost: { title: "Thread A", icon: null },
      point,
    });

  it("previews the pane under the pointer and drops the tab there as a split", () => {
    const pane = registerPane("right");

    drag({ x: 300, y: 150 });
    expect(pane.showZone).toHaveBeenLastCalledWith("right");

    expect(dropThreadTabDrag()).toBe(true);
    expect(pane.showZone).toHaveBeenLastCalledWith(null);
    expect(pane.drop).toHaveBeenCalledWith({
      threadId: THREAD_A,
      direction: "horizontal",
      side: "second",
    });
  });

  it("drops nothing over a pane that refuses the tab, or after a cancel", () => {
    const refusing = registerPane(null);

    drag({ x: 300, y: 150 });
    expect(refusing.showZone).not.toHaveBeenCalledWith("right");
    expect(dropThreadTabDrag()).toBe(false);

    for (const unregister of unregisters.splice(0)) unregister();
    const pane = registerPane("left");
    drag({ x: 20, y: 150 });
    cancelThreadTabDrag();
    expect(pane.showZone).toHaveBeenLastCalledWith(null);
    expect(dropThreadTabDrag()).toBe(false);
    expect(pane.drop).not.toHaveBeenCalled();
  });
});
