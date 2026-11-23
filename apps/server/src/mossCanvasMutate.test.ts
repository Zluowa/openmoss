import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMossCanvasStores } from "./mossCanvasStorage";
import {
  applyMossCanvasOpsToSnapshot,
  mutateMossCanvas,
  nextTldrawIndexAbove,
  parseMossCanvasMutateOps,
} from "./mossCanvasMutate";
import { readMossCanvasSummary } from "./mossCanvasSummary";

const BUNDLE_DIR = "D:/DevTemp/moss-build-cache/canvas-bundle/baaa97b54f5a9f9ff06d928c/bundle";

const identity = {
  account: { id: "user-a", realm: "memfire-phone" as const },
  realm: "memfire-phone" as const,
  gatewayBaseUrl: "https://gateway.example/v1",
};

describe("mossCanvasMutate", () => {
  afterEach(() => {
    closeMossCanvasStores();
    vi.unstubAllEnvs();
  });

  it("generates monotonic tldraw base-62 fractional indices", () => {
    expect(nextTldrawIndexAbove(null)).toBe("a1");
    expect(nextTldrawIndexAbove("a1")).toBe("a2");
    expect(nextTldrawIndexAbove("a1CBz")).toBe("a2");
    expect(nextTldrawIndexAbove("az")).toBe("b00");
    expect(nextTldrawIndexAbove("b00")).toBe("b01");
  });

  it("validates ops strictly and rejects malformed inputs", () => {
    expect(() => parseMossCanvasMutateOps([])).toThrow();
    expect(() => parseMossCanvasMutateOps([{ op: "unknown" }])).toThrow();
    expect(() => parseMossCanvasMutateOps([{ op: "addNote", text: "a", extra: 1 }])).toThrow();
    expect(() => parseMossCanvasMutateOps([{ op: "addNote", text: "a", x: 10 }])).toThrow();
    expect(() => parseMossCanvasMutateOps([{ op: "addShape", geo: "invalid" }])).toThrow();
    expect(() =>
      parseMossCanvasMutateOps([
        { op: "addNote", key: "dup", text: "one" },
        { op: "addNote", key: "dup", text: "two" },
      ]),
    ).toThrow();
  });

  it("creates frames, notes, text, geo shapes, connectors, updates, deletes, and clears cleanly", () => {
    const first = applyMossCanvasOpsToSnapshot({
      title: "架构设计",
      ops: [
        { op: "addFrame", key: "f1", name: "核心模块", x: 0, y: 0, w: 600, h: 400 },
        { op: "addNote", key: "n1", text: "用户输入", frame: "f1", color: "yellow" },
        {
          op: "addShape",
          key: "s1",
          geo: "rectangle",
          text: "服务端处理",
          frame: "f1",
          color: "blue",
        },
        { op: "addText", key: "t1", text: "标题说明", size: "l" },
        { op: "connect", key: "a1", from: "n1", to: "s1", text: "调用" },
      ],
    });
    expect(Object.keys(first.created)).toEqual(["f1", "n1", "s1", "t1", "a1"]);
    expect(first.shapeCounts).toEqual({ frame: 1, note: 1, geo: 1, text: 1, arrow: 1 });
    expect(first.shapes.find((shape) => shape.id === first.created.n1)?.text).toBe("用户输入");

    const second = applyMossCanvasOpsToSnapshot({
      existingSnapshot: first.snapshot,
      ops: [
        { op: "update", id: first.created.n1!, text: "更新后输入", color: "green" },
        { op: "delete", ids: [first.created.s1!] },
      ],
    });
    // Deleting s1 also deletes the arrow bound to s1.
    expect(second.deletedCount).toBe(2);
    expect(second.shapeCounts).toEqual({ frame: 1, note: 1, text: 1 });
    expect(second.shapes.find((shape) => shape.id === first.created.n1)?.text).toBe("更新后输入");

    const cleared = applyMossCanvasOpsToSnapshot({
      existingSnapshot: second.snapshot,
      ops: [{ op: "clear" }, { op: "addNote", text: "重新开始" }],
    });
    expect(cleared.deletedCount).toBe(3);
    expect(cleared.shapeCounts).toEqual({ note: 1 });
  });

  it("persists to hosted Canvas storage and round-trips through readMossCanvasSummary", async () => {
    vi.stubEnv("MOSS_CANVAS_BUNDLE_DIR", BUNDLE_DIR);
    const stateDirectory = mkdtempSync(join(tmpdir(), "moss-canvas-mutate-"));
    try {
      const workspace = { threadId: "thread-mutate-1", cwd: stateDirectory, title: "协作白板" };
      const write1 = await mutateMossCanvas({
        stateDirectory,
        identity,
        workspace,
        title: "协作白板",
        ops: [
          { op: "addFrame", key: "frame-main", name: "方案规划" },
          { op: "addNote", key: "note-a", text: "接入右侧白板", frame: "frame-main" },
          { op: "addShape", key: "box-b", geo: "rectangle", text: "支持 MCP", frame: "frame-main" },
          { op: "connect", key: "arrow-ab", from: "note-a", to: "box-b", text: "联动" },
        ],
      });
      expect(write1.revision).toBeTruthy();
      expect(write1.shapeCounts).toEqual({ frame: 1, note: 1, geo: 1, arrow: 1 });

      const summary = await readMossCanvasSummary({
        stateDirectory,
        identity,
        workspace,
      });
      expect(summary.exists).toBe(true);
      expect(summary.title).toBe("协作白板");
      expect(summary.shapeCounts).toEqual({ frame: 1, note: 1, geo: 1, arrow: 1 });
      expect(summary.shapes.some((s) => s.id === write1.created["note-a"])).toBe(true);

      const write2 = await mutateMossCanvas({
        stateDirectory,
        identity,
        workspace,
        ops: [{ op: "update", id: write1.created["note-a"]!, text: "已接入右侧白板" }],
      });
      expect(write2.shapes.find((s) => s.id === write1.created["note-a"])?.text).toBe(
        "已接入右侧白板",
      );
    } finally {
      closeMossCanvasStores();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });
});
