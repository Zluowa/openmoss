import type { HtmlRenderReference } from "@moss/shared/htmlRender";
import { describe, expect, it } from "vitest";

import {
  latestHtmlRenderBySurface,
  placeHtmlRenders,
  type HtmlRenderPublication,
} from "./htmlRenderSurfaces";

const page = (attachmentId: string, surface?: string): HtmlRenderReference => ({
  attachmentId,
  title: `Page ${attachmentId}`,
  height: 300,
  ...(surface === undefined ? {} : { surface }),
});

const published = (
  id: string,
  turnId: string | null,
  htmlRender?: HtmlRenderReference,
): HtmlRenderPublication => ({ id, turnId, ...(htmlRender ? { htmlRender } : {}) });

describe("latestHtmlRenderBySurface", () => {
  it("keeps each surface's newest page and ignores standalone pages and other entries", () => {
    const latest = latestHtmlRenderBySurface([
      published("a1", "t1", page("a", "build")),
      published("w1", "t1"),
      published("b1", "t1", page("b")),
      published("a2", "t2", page("a2", "build")),
      published("c1", "t2", page("c", "tests")),
    ]);

    expect([...latest.keys()]).toEqual(["build", "tests"]);
    expect(latest.get("build")?.attachmentId).toBe("a2");
    expect(latest.get("tests")?.attachmentId).toBe("c");
  });
});

describe("placeHtmlRenders", () => {
  it("shows pages without a surface exactly as published", () => {
    const first = page("a");
    const second = page("b");
    const placed = placeHtmlRenders([
      published("p1", "t1", first),
      published("w1", "t1"),
      published("p2", "t2", second),
    ]);

    expect([...placed.keys()]).toEqual(["p1", "p2"]);
    expect(placed.get("p1")).toEqual({ id: "p1", htmlRender: first });
    expect(placed.get("p2")?.htmlRender).toBe(second);
    expect(placed.get("p2")).not.toHaveProperty("liveId");
  });

  it("shows a surface's newest page where it first appeared and a note in each later turn", () => {
    const newest = page("v3", "build");
    const placed = placeHtmlRenders([
      published("v1", "t1", page("v1", "build")),
      published("other", "t1", page("x")),
      published("v2", "t2", page("v2", "build")),
      published("v3", "t3", newest),
    ]);

    expect(placed.get("v1")).toEqual({ id: "v1", htmlRender: newest });
    expect(placed.get("v2")).toEqual({ id: "v2", htmlRender: page("v2", "build"), liveId: "v1" });
    expect(placed.get("v3")).toEqual({ id: "v3", htmlRender: newest, liveId: "v1" });
    expect(placed.get("other")?.htmlRender.attachmentId).toBe("x");
  });

  it("keeps one note per later turn, at the turn's last update, and none in the first turn", () => {
    const placed = placeHtmlRenders([
      published("v1", "t1", page("v1", "progress")),
      published("v2", "t1", page("v2", "progress")),
      published("v3", "t2", page("v3", "progress")),
      published("v4", "t2", page("v4", "progress")),
      published("v5", "t2", page("v5", "progress")),
    ]);

    expect([...placed.keys()]).toEqual(["v1", "v5"]);
    expect(placed.get("v1")?.htmlRender.attachmentId).toBe("v5");
    expect(placed.get("v5")?.liveId).toBe("v1");
  });

  it("keeps surfaces apart and never coalesces publications without a turn", () => {
    const placed = placeHtmlRenders([
      published("b1", null, page("b1", "build")),
      published("t1", null, page("t1", "tests")),
      published("b2", null, page("b2", "build")),
      published("b3", null, page("b3", "build")),
      published("t2", "turn", page("t2", "tests")),
    ]);

    expect(placed.get("b1")?.htmlRender.attachmentId).toBe("b3");
    expect(placed.get("t1")?.htmlRender.attachmentId).toBe("t2");
    expect(placed.get("b2")?.liveId).toBe("b1");
    expect(placed.get("b3")?.liveId).toBe("b1");
    expect(placed.get("t2")?.liveId).toBe("t1");
  });

  it("moves the page to the next publication when the first one is gone", () => {
    const placed = placeHtmlRenders([
      published("v2", "t2", page("v2", "build")),
      published("v3", "t3", page("v3", "build")),
    ]);

    expect(placed.get("v2")).toEqual({ id: "v2", htmlRender: page("v3", "build") });
    expect(placed.get("v3")?.liveId).toBe("v2");
  });
});
