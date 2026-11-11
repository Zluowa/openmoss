import { describe, expect, it, vi } from "vitest";

import type { MossImageJob } from "~/lib/mossImagesClient";
import { parsePageEditorAiEvent } from "~/lib/pageRichEditorChannel";
import { createPageMediaRunner, type PageMediaBridgeDeps } from "./usePageMediaBridge";

const job = (overrides: Partial<MossImageJob> = {}): MossImageJob => ({
  jobId: "moss_job_1",
  status: "running",
  prompt: "一只白兔吃胡萝卜",
  createdAt: "2026-11-11T08:00:00.000Z",
  modelId: "seedream-5-0",
  imageUrls: [],
  billingStatus: "pending",
  ...overrides,
});
const finishedImage = job({
  status: "succeeded",
  imageUrls: ["/api/moss/media/assets/moss_job_1/0"],
  assets: [
    {
      assetId: "a",
      index: 0,
      kind: "image",
      contentType: "image/png",
      byteLength: 5,
      downloadPath: "/api/moss/media/assets/moss_job_1/0",
    },
  ],
});
const finishedVideo = job({
  status: "succeeded",
  operation: "video",
  imageUrls: [],
  videoUrls: ["/api/moss/media/assets/moss_job_1/0"],
  assets: [
    {
      assetId: "v",
      index: 0,
      kind: "video",
      contentType: "video/mp4",
      byteLength: 9,
      downloadPath: "/api/moss/media/assets/moss_job_1/0",
    },
  ],
});

function setup(overrides: Partial<PageMediaBridgeDeps> = {}) {
  const channel = { mediaJob: vi.fn(), mediaResult: vi.fn(), setMediaCatalog: vi.fn() };
  const deps: PageMediaBridgeDeps = {
    loadCatalog: vi.fn(async () => ({
      account: { id: "a", realm: "cn" },
      models: [
        {
          id: "seedream-5-0",
          label: "Seedream",
          kind: "image" as const,
          installed: true,
          available: true,
        },
      ],
      jobs: [],
    })),
    requestJob: vi.fn(async () => job({ status: "queued" })),
    loadJob: vi.fn(async () => job()),
    waitForJob: vi.fn(async () => finishedImage),
    saveImage: vi.fn(async () => "/api/library-image/item_1"),
    ...overrides,
  };
  return { channel, deps, runner: createPageMediaRunner(channel, deps) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("page media cards run through Moss's media API", () => {
  it("posts the card's job as built, follows it, and puts the saved image in the page", async () => {
    const { channel, deps, runner } = setup();
    const request = {
      projectId: "moss-page",
      modelId: "seedream-5-0",
      prompt: "一只白兔",
      idempotencyKey: "req-12345678",
    };
    runner.handle({
      event: "media-generate",
      blockId: "b1",
      requestId: "req-12345678",
      kind: "image",
      request,
    });
    await flush();
    await flush();
    expect(deps.requestJob).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(channel.mediaJob.mock.calls.map(([update]) => update.status)).toEqual([
      "submitting",
      "queued",
    ]);
    expect(channel.mediaJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockId: "b1", requestId: "req-12345678", jobId: "moss_job_1" }),
    );
    expect(channel.mediaResult).toHaveBeenCalledWith({
      blockId: "b1",
      requestId: "req-12345678",
      kind: "image",
      url: "/api/library-image/item_1",
      name: "一只白兔吃胡萝卜",
    });
  });

  it("keeps a finished video by its saved media address", async () => {
    const { channel, runner } = setup({ waitForJob: vi.fn(async () => finishedVideo) });
    runner.handle({
      event: "media-generate",
      blockId: "b2",
      requestId: "req-video-1",
      kind: "video",
      request: { prompt: "x" },
    });
    await flush();
    await flush();
    expect(channel.mediaResult).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video", url: "/api/moss/media/assets/moss_job_1/0" }),
    );
  });

  it("only observes a job after a reload, never submitting it again", async () => {
    const { channel, deps, runner } = setup();
    runner.handle({
      event: "media-resume",
      blockId: "b1",
      requestId: "req-12345678",
      jobId: "moss_job_1",
    });
    await flush();
    await flush();
    expect(deps.requestJob).not.toHaveBeenCalled();
    expect(deps.loadJob).toHaveBeenCalledWith("moss_job_1", expect.any(AbortSignal));
    expect(channel.mediaResult).toHaveBeenCalled();
  });

  it("tells the card why a job failed and sends a second click for the same request no new job", async () => {
    const { deps, runner } = setup({
      waitForJob: vi.fn(() => new Promise<MossImageJob>(() => undefined)),
    });
    const event = {
      event: "media-generate" as const,
      blockId: "b1",
      requestId: "req-12345678",
      kind: "image" as const,
      request: { prompt: "x" },
    };
    runner.handle(event);
    runner.handle(event);
    await flush();
    expect(deps.requestJob).toHaveBeenCalledTimes(1);
    const failing = setup({
      requestJob: vi.fn(async () => Promise.reject(new Error("套餐额度已用完。"))),
    });
    failing.runner.handle(event);
    await flush();
    expect(failing.channel.mediaJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", error: "套餐额度已用完。" }),
    );
  });

  it("sends the cards Moss's model catalog, or that it can't be reached", async () => {
    const { channel, runner } = setup();
    await runner.loadCatalog();
    expect(channel.setMediaCatalog).toHaveBeenLastCalledWith({
      status: "ready",
      models: [{ id: "seedream-5-0", available: true, installed: true }],
    });
    vi.useFakeTimers();
    try {
      const offline = setup({
        loadCatalog: vi.fn(async () => ({
          account: null,
          models: [],
          jobs: [],
          errorCode: "media_catalog_unavailable",
        })),
      });
      const done = offline.runner.loadCatalog();
      await vi.advanceTimersByTimeAsync(0);
      expect(offline.channel.setMediaCatalog).toHaveBeenLastCalledWith({
        status: "unavailable",
        models: [],
      });
      offline.runner.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only well-formed media events from the editor", () => {
    expect(
      parsePageEditorAiEvent({
        event: "media-generate",
        blockId: "b1",
        requestId: "req-12345678",
        kind: "image",
        request: { prompt: "x" },
      }),
    ).not.toBeNull();
    expect(
      parsePageEditorAiEvent({
        event: "media-generate",
        blockId: "b1",
        requestId: "bad id",
        kind: "image",
        request: {},
      }),
    ).toBeNull();
    expect(
      parsePageEditorAiEvent({
        event: "media-generate",
        blockId: "b1",
        requestId: "req-12345678",
        kind: "music",
        request: {},
      }),
    ).toBeNull();
    expect(
      parsePageEditorAiEvent({
        event: "media-resume",
        blockId: "b1",
        requestId: "r",
        jobId: "moss_job_1",
      }),
    ).not.toBeNull();
    expect(
      parsePageEditorAiEvent({
        event: "media-resume",
        blockId: "b1",
        requestId: "r",
        jobId: "../x",
      }),
    ).toBeNull();
  });
});
