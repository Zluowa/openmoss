import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readMossCanvasSummary,
  summarizeMossCanvasConversation,
  summarizeMossCanvasSnapshot,
} from "./mossCanvasSummary";

const identity = {
  account: { id: "user-a", realm: "memfire-phone" as const },
  realm: "memfire-phone" as const,
  gatewayBaseUrl: "https://gateway.example/v1",
};

describe("Moss Canvas summary for agents", () => {
  it("lists shapes, their text and asset names from a tldraw snapshot", () => {
    const summary = summarizeMossCanvasSnapshot({
      document: {
        store: {
          "asset:1": { typeName: "asset", id: "asset:1", props: { name: "cat.png" } },
          "shape:a": {
            typeName: "shape",
            type: "image",
            x: 10.4,
            y: 20,
            props: { assetId: "asset:1", w: 512, h: 512 },
          },
          "shape:b": {
            typeName: "shape",
            type: "text",
            x: 0,
            y: 0,
            props: {
              richText: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "海报标题" }] }],
              },
            },
          },
          "shape:c": { typeName: "shape", type: "note", props: { text: "  记得换背景  " } },
          "page:1": { typeName: "page", id: "page:1" },
        },
      },
    });
    expect(summary.shapeCounts).toEqual({ image: 1, text: 1, note: 1 });
    expect(summary.shapes).toEqual([
      { type: "image", assetName: "cat.png", x: 10, y: 20, width: 512, height: 512 },
      { type: "text", text: "海报标题", x: 0, y: 0 },
      { type: "note", text: "记得换背景" },
    ]);
    expect(summary.truncated).toBe(false);
  });

  it("reads a Canvas media card's prompt, model and job, under a Moss type name", () => {
    const summary = summarizeMossCanvasSnapshot({
      store: {
        "shape:moss-media-moss_1-0": {
          typeName: "shape",
          type: "hoola-card",
          x: 0,
          y: 0,
          props: {
            w: 640,
            h: 480,
            pageJson: JSON.stringify({
              pageType: "IMAGE",
              title: "gpt-image-2.5-flare",
              prompt: "一只坐在窗边的小猫",
              imageGeneration: { modelId: "gpt-image-2.5-flare", prompt: "一只坐在窗边的小猫" },
              generationJobId: "moss_1",
              generationStatus: "succeeded",
            }),
          },
        },
      },
    });
    expect(summary.shapeCounts).toEqual({ "moss-card": 1 });
    expect(summary.shapes[0]).toEqual({
      type: "moss-card",
      media: {
        kind: "image",
        prompt: "一只坐在窗边的小猫",
        modelId: "gpt-image-2.5-flare",
        jobId: "moss_1",
        status: "succeeded",
      },
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
    expect(JSON.stringify(summary)).not.toContain("hoola");
  });

  it("bounds what it returns and tolerates unknown snapshots", () => {
    const store = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `shape:${index}`,
        { typeName: "shape", type: "geo", props: { text: "x".repeat(400) } },
      ]),
    );
    const summary = summarizeMossCanvasSnapshot({ store });
    expect(summary.shapeCounts).toEqual({ geo: 80 });
    expect(summary.shapes).toHaveLength(60);
    expect(summary.truncated).toBe(true);
    expect(summary.shapes[0]!.text!.length).toBeLessThanOrEqual(280);
    expect(summarizeMossCanvasSnapshot(null)).toEqual({
      shapeCounts: {},
      shapes: [],
      truncated: false,
    });
  });

  it("lists this conversation's generated media", () => {
    expect(
      summarizeMossCanvasConversation({
        version: 1,
        items: [
          {
            jobId: "moss_1",
            kind: "image",
            status: "succeeded",
            prompt: "一只猫",
            modelId: "gpt-image-2.5-flare",
            outputs: ["moss-canvas-asset:a.png"],
          },
          { jobId: "moss_2", kind: "video", status: "running", outputs: [] },
          { nope: true },
        ],
      }),
    ).toEqual([
      {
        jobId: "moss_1",
        kind: "image",
        status: "succeeded",
        prompt: "一只猫",
        modelId: "gpt-image-2.5-flare",
        outputs: 1,
      },
      { jobId: "moss_2", kind: "video", status: "running", outputs: 0 },
    ]);
  });

  it("reports a Canvas that does not exist yet without creating it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moss-canvas-summary-"));
    try {
      const summary = await readMossCanvasSummary({
        stateDirectory: cwd,
        identity,
        workspace: { threadId: "thread-1", cwd, title: "会话画布" },
      });
      expect(summary).toEqual({
        exists: false,
        title: "会话画布",
        shapeCounts: {},
        shapes: [],
        truncated: false,
        media: [],
      });
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
