import { afterEach, describe, expect, it } from "vitest";

import {
  MOSS_CANVAS_SELECTION_TTL_MS,
  readMossCanvasLiveSelection,
  recordMossCanvasLiveSelection,
  resetMossCanvasLiveSelections,
} from "./mossCanvasLiveSelection";

const asset = `moss-canvas-asset:${"a".repeat(64)}.png`;
const report = (sequence: number, documentEpoch = 1, text = "我爱你") => ({
  documentEpoch,
  sequence,
  images: [{ shapeId: "shape:moss-media-moss_1-0", assetId: asset, title: "小猫" }],
  content: [{ shapeId: "shape:love", kind: "text", text }],
});

afterEach(() => resetMossCanvasLiveSelections());

describe("Moss Canvas live selection", () => {
  it("keeps the newest selection per thread and ignores late older reports", () => {
    expect(recordMossCanvasLiveSelection("thread-1", report(2), 1_000)).toBe(true);
    expect(recordMossCanvasLiveSelection("thread-1", report(1, 1, "旧的"), 1_001)).toBe(false);
    expect(readMossCanvasLiveSelection("thread-1", 1_002)).toMatchObject({
      sequence: 2,
      images: [{ title: "小猫" }],
      content: [{ kind: "text", text: "我爱你" }],
    });
    // A newer document starts its own sequence.
    expect(recordMossCanvasLiveSelection("thread-1", report(1, 2, "新的"), 1_003)).toBe(true);
    expect(readMossCanvasLiveSelection("thread-1", 1_004)?.content[0]?.text).toBe("新的");
    expect(readMossCanvasLiveSelection("thread-2", 1_004)).toBeNull();
  });

  it("clears on an empty report and expires when nobody refreshed it", () => {
    recordMossCanvasLiveSelection("thread-1", report(1), 0);
    recordMossCanvasLiveSelection(
      "thread-1",
      { documentEpoch: 1, sequence: 2, images: [], content: [] },
      1,
    );
    expect(readMossCanvasLiveSelection("thread-1", 2)).toBeNull();
    recordMossCanvasLiveSelection("thread-1", report(3), 10);
    expect(readMossCanvasLiveSelection("thread-1", 10 + MOSS_CANVAS_SELECTION_TTL_MS)).toBeNull();
  });

  it("refuses foreign or oversized data as a whole", () => {
    expect(recordMossCanvasLiveSelection("../thread", report(1))).toBe(false);
    expect(
      recordMossCanvasLiveSelection("thread-1", {
        ...report(1),
        images: [{ shapeId: "shape:x", assetId: "https://outside.test/a.png", title: "x" }],
      }),
    ).toBe(false);
    expect(
      recordMossCanvasLiveSelection("thread-1", {
        ...report(1),
        content: [{ shapeId: "shape:x", kind: "text", text: "x".repeat(501) }],
      }),
    ).toBe(false);
    expect(
      recordMossCanvasLiveSelection("thread-1", {
        ...report(1),
        content: [{ shapeId: "shape:x", kind: "<script>" }],
      }),
    ).toBe(false);
    expect(readMossCanvasLiveSelection("thread-1")).toBeNull();
  });
});
