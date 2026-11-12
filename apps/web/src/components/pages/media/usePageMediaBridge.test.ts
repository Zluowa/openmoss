import { describe, expect, it, vi } from "vitest";

import { waitForMossImageJob, type MossImageJob } from "~/lib/mossImagesClient";
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
  const channel = {
    mediaJob: vi.fn(),
    mediaResult: vi.fn(),
    setMediaCatalog: vi.fn(),
    mediaAsset: vi.fn(),
  };
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
    readAsset: vi.fn(async () => ({ contentType: "image/png", bytes: new ArrayBuffer(4) })),
    ...overrides,
  };
  return { channel, deps, runner: createPageMediaRunner(channel, deps) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("page media cards run through Moss's media API", () => {
  it("posts the card's job as built, follows it, and puts the saved image's Moss address in the page", async () => {
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
      // The durable Moss media address (not a library copy the page frame could not load).
      url: "/api/moss/media/assets/moss_job_1/0",
      name: "一只白兔吃胡萝卜",
    });
  });

  // What Moss's media route really answers for a finished job: the supplier's https link and
  // the file Moss saved, under its durable address.
  const served = (kind: "image" | "video"): MossImageJob =>
    job({
      status: "succeeded",
      ...(kind === "video" ? { operation: "video" as const } : {}),
      imageUrls: kind === "image" ? ["https://assets.example/lamp.png"] : [],
      ...(kind === "video" ? { videoUrls: ["https://assets.example/sea.mp4"] } : {}),
      persistenceStatus: "ready",
      billingStatus: "captured",
      assets: [
        {
          assetId: "a".repeat(64),
          index: 0,
          kind,
          contentType: kind === "image" ? "image/png" : "video/mp4",
          byteLength: 9,
          downloadPath: "/api/moss/media/assets/moss_job_1/0",
        },
      ],
    });
  // A stub of Moss's media route: the job stays running for a while, then finishes.
  const stubRoute = (finished: MossImageJob, runningAnswers: number) => {
    let answers = 0;
    return vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/moss/media/jobs/moss_job_1");
      answers += 1;
      return Response.json(
        answers <= runningAnswers
          ? job({
              status: "running",
              ...(finished.operation ? { operation: finished.operation } : {}),
            })
          : finished,
      );
    });
  };
  it.each(["image", "video"] as const)(
    "lands a late %s result in its card, after many running answers",
    async (kind) => {
      const finished = served(kind);
      const route = stubRoute(finished, 6);
      const { channel, runner } = setup({
        requestJob: vi.fn(async () =>
          job({
            status: "queued",
            ...(finished.operation ? { operation: finished.operation } : {}),
          }),
        ),
        waitForJob: (input) => waitForMossImageJob({ ...input, fetchImpl: route, pollMs: 1 }),
      });
      runner.handle({
        event: "media-generate",
        blockId: "late",
        requestId: `req-late-${kind}`,
        kind,
        request: { prompt: "x" },
      });
      await vi.waitFor(() => expect(channel.mediaResult).toHaveBeenCalled());
      // Seven answers from the route: six "running", then the finished job.
      expect(route).toHaveBeenCalledTimes(7);
      expect(
        channel.mediaJob.mock.calls.map(([update]) => update.status).filter((s) => s === "running")
          .length,
      ).toBeGreaterThanOrEqual(6);
      expect(channel.mediaResult).toHaveBeenCalledWith(
        expect.objectContaining({
          blockId: "late",
          kind,
          url: "/api/moss/media/assets/moss_job_1/0",
        }),
      );
    },
  );

  it("hands the page frame a saved file's bytes once per address, and nothing for other addresses", async () => {
    let release!: () => void;
    const readAsset = vi.fn(
      () =>
        new Promise<{ contentType: string; bytes: ArrayBuffer }>((resolve) => {
          release = () => resolve({ contentType: "video/mp4", bytes: new ArrayBuffer(8) });
        }),
    );
    const { channel, runner } = setup({ readAsset });
    const url = "/api/moss/media/assets/moss_job_1/0";
    runner.handle({ event: "media-asset-request", url });
    runner.handle({ event: "media-asset-request", url });
    expect(readAsset).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(channel.mediaAsset).toHaveBeenCalledTimes(1));
    expect(channel.mediaAsset).toHaveBeenCalledWith(url, {
      contentType: "video/mp4",
      bytes: expect.any(ArrayBuffer),
    });
    // A file Moss cannot read is answered with null, so the frame stops waiting.
    const failing = setup({ readAsset: vi.fn(async () => Promise.reject(new Error("401"))) });
    failing.runner.handle({ event: "media-asset-request", url });
    await vi.waitFor(() => expect(failing.channel.mediaAsset).toHaveBeenCalledWith(url, null));
    // The channel accepts only saved Moss media addresses.
    expect(parsePageEditorAiEvent({ event: "media-asset-request", url })).toEqual({
      event: "media-asset-request",
      url,
    });
    for (const bad of [
      "/api/library-image/lib-1",
      "https://evil.example/a.png",
      "/api/moss/media/assets/moss_x/0?token=t",
    ])
      expect(parsePageEditorAiEvent({ event: "media-asset-request", url: bad })).toBeNull();
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
