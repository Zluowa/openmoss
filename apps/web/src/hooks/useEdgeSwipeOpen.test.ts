import { describe, expect, it } from "vitest";
import { isEdgeSwipeOpen } from "./useEdgeSwipeOpen";

describe("isEdgeSwipeOpen", () => {
  it("opens for a rightward swipe that starts at the left edge", () => {
    expect(isEdgeSwipeOpen({ startX: 4, startY: 300, x: 80, y: 310 })).toBe(true);
  });

  it("ignores swipes that start away from the edge", () => {
    expect(isEdgeSwipeOpen({ startX: 60, startY: 300, x: 200, y: 300 })).toBe(false);
  });

  it("ignores short or mostly vertical movement", () => {
    expect(isEdgeSwipeOpen({ startX: 4, startY: 300, x: 40, y: 300 })).toBe(false);
    expect(isEdgeSwipeOpen({ startX: 4, startY: 300, x: 70, y: 380 })).toBe(false);
  });
});
