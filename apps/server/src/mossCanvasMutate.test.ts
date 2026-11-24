import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMossCanvasStores, mossCanvasStorageFor } from "./mossCanvasStorage";
import {
  applyMossCanvasOpsToSnapshot,
  MOSS_CANVAS_MUTATE_RECORD_VERSIONS,
  mutateMossCanvas,
  nextTldrawIndexAbove,
  parseMossCanvasMutateOps,
} from "./mossCanvasMutate";
import { readMossCanvasSummary } from "./mossCanvasSummary";

// The built Canvas bundle (scripts/prepare-moss-canvas-bundle.ts; CI's Desktop Build job), or the
// one MOSS_CANVAS_BUNDLE_DIR names. Without it the storage round trip cannot run.
const BUNDLE_DIR =
  process.env.MOSS_CANVAS_BUNDLE_DIR?.trim() ||
  resolve(fileURLToPath(new URL("../../..", import.meta.url)), "apps/desktop/canvas-bundle");
const HAS_BUNDLE = existsSync(join(BUNDLE_DIR, "apps/codex-canvas"));

/** A board as the Canvas editor saves it: its own schema travels with it. */
function savedBoard(versions: Record<string, number> = MOSS_CANVAS_MUTATE_RECORD_VERSIONS) {
  return {
    document: {
      store: {
        "document:document": {
          id: "document:document",
          typeName: "document",
          gridSize: 10,
          name: "",
          meta: {},
        },
        "page:page": { id: "page:page", typeName: "page", name: "画布", index: "a1", meta: {} },
      },
      schema: { schemaVersion: 2, sequences: { "com.tldraw.store": 5, ...versions } },
    },
    session: { version: 0, currentPageId: "page:page" },
  };
}

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
      existingSnapshot: savedBoard(),
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

  it("edits only a board the editor saved, with the record versions it builds", () => {
    expect(() =>
      applyMossCanvasOpsToSnapshot({ ops: [{ op: "addNote", text: "无处可写" }] }),
    ).toThrow("canvas_not_open");
    // A moved Canvas pin: the stored note version differs, so the server refuses instead of
    // writing a record the editor cannot load; the edit then goes through the open editor.
    expect(() =>
      applyMossCanvasOpsToSnapshot({
        existingSnapshot: savedBoard({
          ...MOSS_CANVAS_MUTATE_RECORD_VERSIONS,
          "com.tldraw.shape.note": 14,
        }),
        ops: [{ op: "addNote", text: "新版本" }],
      }),
    ).toThrow("canvas_open_required");
    const ok = applyMossCanvasOpsToSnapshot({
      existingSnapshot: savedBoard(),
      ops: [{ op: "addNote", text: "能写" }],
    });
    // The stored schema is kept as it was.
    expect((ok.snapshot.document as { schema: unknown }).schema).toEqual(
      savedBoard().document.schema,
    );
  });

  it.skipIf(!HAS_BUNDLE)(
    "persists to hosted Canvas storage and round-trips through readMossCanvasSummary",
    async () => {
      vi.stubEnv("MOSS_CANVAS_BUNDLE_DIR", BUNDLE_DIR);
      const stateDirectory = mkdtempSync(join(tmpdir(), "moss-canvas-mutate-"));
      try {
        const workspace = { threadId: "thread-mutate-1", cwd: stateDirectory, title: "协作白板" };
        await expect(
          mutateMossCanvas({
            stateDirectory,
            identity,
            workspace,
            ops: [{ op: "addNote", text: "x" }],
          }),
        ).rejects.toThrow("canvas_not_open");
        // The editor saved the conversation's board once.
        const store = await mossCanvasStorageFor(stateDirectory, identity, workspace);
        const created = (await store.request("projects.create", {
          title: "协作白板",
          snapshot: savedBoard(),
        })) as { relativePath: string };
        await store.request("projects.setActive", { relativePath: created.relativePath });
        const write1 = await mutateMossCanvas({
          stateDirectory,
          identity,
          workspace,
          title: "协作白板",
          ops: [
            { op: "addFrame", key: "frame-main", name: "方案规划" },
            { op: "addNote", key: "note-a", text: "接入右侧白板", frame: "frame-main" },
            {
              op: "addShape",
              key: "box-b",
              geo: "rectangle",
              text: "支持 MCP",
              frame: "frame-main",
            },
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
    },
  );
});
