import { describe, expect, it, vi } from "vitest";

import type { UsageEventSubject } from "@synara/contracts";

import {
  APIMART_OFFICIAL_MEDIA_ORIGIN,
  MOSS_OFFICIAL_MEDIA_INSTRUMENTATION,
  MossOfficialMediaConflictError,
  MossOfficialMediaTransportError,
  createApiMartOfficialMediaTransport,
  createMossOfficialMediaExecutor,
  type ApiMartOfficialMediaTransport,
  type MossOfficialMediaCheckpoint,
  type MossOfficialMediaCheckpointStore,
  type MossOfficialMediaExecutionRequest,
} from "./mossOfficialMediaExecutor.ts";

const subject = {
  provider: "codex",
  providerInstanceId: "codex_moss",
  accountRef: "account-ref-1",
} as const satisfies UsageEventSubject;

const imageRequest = {
  subject,
  invocationId: "skill-invocation-1",
  skillRef: "moss-official-imagegen",
  attemptIndex: 0,
  role: "primary",
  prompt: "a content-bearing prompt that must never enter checkpoints",
  media: {
    kind: "image",
    model: "gpt-image-2",
    size: "16:9",
    resolution: "2k",
  },
  occurredAt: "2026-08-13T01:02:03.000Z",
  threadId: "thread-1",
  turnId: "turn-1",
  requestId: "request-1",
} as const satisfies MossOfficialMediaExecutionRequest;

const completedImageTask = {
  taskId: "task-image-1",
  state: "completed",
  actualTimeSeconds: "52",
  costUsd: "0.05279",
  creditsCost: "3",
  artifactRefs: ["apimart-artifact-image-1"],
  imageOutputCount: "1",
  providerPayloadDigest: "a".repeat(64),
} as const;

class TestCheckpointStore implements MossOfficialMediaCheckpointStore {
  readonly durability = "DURABLE" as const;
  readonly checkpoints = new Map<string, MossOfficialMediaCheckpoint>();

  async reserve(checkpoint: MossOfficialMediaCheckpoint) {
    const existing = this.checkpoints.get(checkpoint.operationGraph.attemptOperationId);
    if (existing) return { status: "existing" as const, checkpoint: existing };
    this.checkpoints.set(checkpoint.operationGraph.attemptOperationId, checkpoint);
    return { status: "inserted" as const, checkpoint };
  }

  async load(attemptOperationId: string) {
    return this.checkpoints.get(attemptOperationId) ?? null;
  }

  async compareAndSet(
    attemptOperationId: string,
    expectedRevision: number,
    next: MossOfficialMediaCheckpoint,
  ) {
    const current = this.checkpoints.get(attemptOperationId);
    if (!current) return { status: "missing" as const };
    if (current.revision !== expectedRevision) {
      return { status: "stale" as const, checkpoint: current };
    }
    this.checkpoints.set(attemptOperationId, next);
    return { status: "updated" as const, checkpoint: next };
  }
}

function scriptedTransport(
  overrides: Partial<ApiMartOfficialMediaTransport> = {},
): ApiMartOfficialMediaTransport {
  return {
    submit: vi.fn(async () => ({ taskId: "task-image-1" })),
    getTask: vi.fn(async () => completedImageTask),
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

describe("createApiMartOfficialMediaTransport", () => {
  it("uses the fixed APIMart origin, bearer injection, manual redirects, and n=1 for images", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ code: 200, data: [{ status: "submitted", task_id: "task-image-1" }] }),
    );
    const transport = createApiMartOfficialMediaTransport({
      getToken: async () => "server-only-token",
      fetchImpl,
    });

    await expect(transport.submit(imageRequest.media, imageRequest.prompt)).resolves.toEqual({
      taskId: "task-image-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    if (!init) throw new Error("expected request init");
    expect(url).toBe(`${APIMART_OFFICIAL_MEDIA_ORIGIN}/v1/images/generations`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer server-only-token");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-image-2",
      prompt: imageRequest.prompt,
      n: 1,
      size: "16:9",
      resolution: "2k",
    });
  });

  it.each([
    {
      model: "sora-2" as const,
      duration: 8,
      aspectRatio: "16:9" as const,
      resolution: "720p" as const,
      ratioField: "aspect_ratio",
    },
    {
      model: "veo3.1-fast-official" as const,
      duration: 8,
      aspectRatio: "9:16" as const,
      resolution: "1080p" as const,
      ratioField: "aspect_ratio",
    },
    {
      model: "doubao-seedance-2.0" as const,
      duration: 5,
      aspectRatio: "21:9" as const,
      resolution: "720p" as const,
      ratioField: "size",
    },
  ])("submits documented video model $model with its exact parameter names", async (entry) => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ code: 200, data: [{ status: "submitted", task_id: "task-video-1" }] }),
    );
    const transport = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl,
    });

    await transport.submit(
      {
        kind: "video",
        model: entry.model,
        duration: entry.duration,
        aspectRatio: entry.aspectRatio,
        resolution: entry.resolution,
      },
      "video prompt",
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${APIMART_OFFICIAL_MEDIA_ORIGIN}/v1/videos/generations`);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: entry.model,
      prompt: "video prompt",
      duration: entry.duration,
      resolution: entry.resolution,
      [entry.ratioField]: entry.aspectRatio,
    });
    expect(typeof body.duration).toBe("number");
    expect(body).not.toHaveProperty(entry.ratioField === "size" ? "aspect_ratio" : "size");
  });

  it("queries only the fixed task path with language=zh and parses content-free completion", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        code: 200,
        data: {
          id: "task-video-1",
          status: "completed",
          actual_time: 19,
          cost: 0.4,
          credits_cost: 7,
          result: {
            videos: [{ url: ["https://upload.apimart.ai/f/video/private-output.mp4"] }],
            thumbnail_url: "https://upload.apimart.ai/f/video/private-thumbnail.jpg",
          },
        },
      }),
    );
    const transport = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl,
    });

    const result = await transport.getTask("task-video-1");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${APIMART_OFFICIAL_MEDIA_ORIGIN}/v1/tasks/task-video-1?language=zh`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(result).toMatchObject({
      state: "completed",
      taskId: "task-video-1",
      actualTimeSeconds: "19",
      costUsd: "0.4",
      creditsCost: "7",
    });
    expect(result.artifactRefs).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(JSON.stringify(result)).not.toContain("private-output");
  });

  it("enforces request, response, timeout, and redirect bounds with sanitized errors", async () => {
    const token = "must-not-leak-token";
    const providerBody = "must-not-leak-provider-body";
    const requestFetch = vi.fn<FetchLike>();
    const requestBounded = createApiMartOfficialMediaTransport({
      getToken: async () => token,
      fetchImpl: requestFetch,
      maxRequestBytes: 32,
    });
    await expect(
      requestBounded.submit(imageRequest.media, imageRequest.prompt),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(requestFetch).not.toHaveBeenCalled();

    const responseBounded = createApiMartOfficialMediaTransport({
      getToken: async () => token,
      fetchImpl: async () => new Response(providerBody.repeat(20), { status: 200 }),
      maxResponseBytes: 32,
    });
    const responseError = await responseBounded
      .submit({ kind: "image", model: "gpt-image-2" }, "x")
      .catch((error: unknown) => error);
    expect(responseError).toMatchObject({ code: "response_too_large" });
    expect(String(responseError)).not.toContain(token);
    expect(String(responseError)).not.toContain(providerBody);

    const redirected = createApiMartOfficialMediaTransport({
      getToken: async () => token,
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    });
    await expect(
      redirected.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({ code: "redirect_rejected" });

    const timedOut = createApiMartOfficialMediaTransport({
      getToken: async () => token,
      fetchImpl: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("x", "AbortError")),
          );
        }),
      timeoutMs: 5,
    });
    await expect(
      timedOut.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({ code: "timeout", submissionMayHaveBeenAccepted: true });
  });

  it("distinguishes definite 4xx rejection from ambiguous 5xx and rejects non-200 envelopes", async () => {
    const providerBody = "provider-body-must-not-leak";
    const rejected = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl: async () => new Response(providerBody, { status: 401 }),
    });
    const rejectedError = await rejected
      .submit({ kind: "image", model: "gpt-image-2" }, "x")
      .catch((error: unknown) => error);
    expect(rejectedError).toMatchObject({
      code: "provider_rejected",
      httpStatus: 401,
      submissionMayHaveBeenAccepted: false,
    });
    expect(String(rejectedError)).not.toContain(providerBody);

    const unavailable = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl: async () => new Response(providerBody, { status: 503 }),
    });
    await expect(
      unavailable.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({
      code: "provider_http",
      httpStatus: 503,
      submissionMayHaveBeenAccepted: true,
    });

    const rejectedEnvelope = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl: async () =>
        jsonResponse({
          code: 401,
          data: [{ status: "submitted", task_id: "must-not-be-accepted" }],
        }),
    });
    await expect(
      rejectedEnvelope.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({
      code: "provider_rejected",
      httpStatus: 401,
      submissionMayHaveBeenAccepted: false,
    });

    const acceptedWithoutTask = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl: async () => jsonResponse({ code: 200, data: [{ status: "submitted" }] }),
    });
    await expect(
      acceptedWithoutTask.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({
      code: "invalid_response",
      submissionMayHaveBeenAccepted: true,
    });

    const missingToken = createApiMartOfficialMediaTransport({
      getToken: async () => "",
      fetchImpl: vi.fn<FetchLike>(),
    });
    await expect(
      missingToken.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({
      code: "invalid_request",
      submissionMayHaveBeenAccepted: false,
    });

    const tokenFetch = vi.fn<FetchLike>();
    const tokenTimedOut = createApiMartOfficialMediaTransport({
      getToken: async () => await new Promise<string>(() => undefined),
      fetchImpl: tokenFetch,
      timeoutMs: 5,
    });
    await expect(
      tokenTimedOut.submit({ kind: "image", model: "gpt-image-2" }, "x"),
    ).rejects.toMatchObject({ code: "timeout", submissionMayHaveBeenAccepted: false });
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported models and unsafe task identifiers before network access", async () => {
    const fetchImpl = vi.fn();
    const transport = createApiMartOfficialMediaTransport({
      getToken: async () => "token",
      fetchImpl,
    });

    await expect(
      transport.submit({ kind: "video", model: "unknown-video" as "sora-2", duration: 8 }, "x"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      transport.submit({ kind: "video", model: "sora-2", duration: 5, resolution: "720p" }, "x"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      transport.submit(
        {
          kind: "video",
          model: "veo3.1-fast-official",
          duration: 8,
          aspectRatio: "1:1",
        },
        "x",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      transport.submit(
        {
          kind: "video",
          model: "doubao-seedance-2.0",
          duration: 16,
          resolution: "720p",
        },
        "x",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(transport.getTask("../../credential")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      transport.submit(
        {
          kind: "image",
          model: "gpt-image-2",
          quality: "high",
        } as unknown as MossOfficialMediaExecutionRequest["media"],
        "x",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createMossOfficialMediaExecutor", () => {
  it("durably reserves before one paid POST and never repeats it for the same operation", async () => {
    const store = new TestCheckpointStore();
    const transport = scriptedTransport();
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport,
      now: () => "2026-08-13T01:02:04.000Z",
    });

    const first = await executor.startOrResume(imageRequest);
    expect(first.status).toBe("submitted");
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.checkpoint)).not.toContain(imageRequest.prompt);
    expect(first.checkpoint).toMatchObject({ state: "submitted", revision: 1 });

    const second = await executor.startOrResume(imageRequest);
    expect(second.status).toBe("completed");
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.getTask).toHaveBeenCalledTimes(1);
    if (second.status !== "completed") throw new Error("expected completed");
    expect(second.receipt.billingDisposition).toBe("authoritative-settlement");
    expect(second.receipt.events.map((event) => event.kind)).toEqual([
      "operation.lifecycle",
      "operation.lifecycle",
      "billing.settlement",
    ]);
    expect(second.receipt.events.at(-1)).toMatchObject({
      kind: "billing.settlement",
      payload: {
        money: { currency: "USD", nanoUnits: "52790000", basis: "provider-reported" },
        credits: [{ ledger: "apimart-credit", delta: "-3" }],
      },
    });
    expect(second.checkpoint.operationGraph).toMatchObject({
      invocationOperationId: second.receipt.skillOperationId,
      taskOperationId: second.receipt.requestOperationId,
    });
    expect(second.receipt.events[1]).toMatchObject({
      operation: {
        operationId: second.checkpoint.operationGraph.taskOperationId,
        parentOperationId: second.checkpoint.operationGraph.attemptOperationId,
        mediaJobId: "task-image-1",
      },
    });

    const replay = await executor.startOrResume(imageRequest);
    expect(replay.status).toBe("completed");
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.getTask).toHaveBeenCalledTimes(1);
    if (replay.status !== "completed") throw new Error("expected completed replay");
    expect(replay.receipt.events).toEqual(second.receipt.events);
  });

  it("reconciles a known provider task after restart without the original prompt", async () => {
    const store = new TestCheckpointStore();
    const transport = scriptedTransport();
    const firstProcess = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport,
      now: () => "2026-08-13T01:02:04.000Z",
    });

    const submitted = await firstProcess.startOrResume(imageRequest);
    expect(submitted.status).toBe("submitted");
    expect(transport.submit).toHaveBeenCalledTimes(1);

    const secondProcess = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport,
      now: () => "2026-08-13T01:03:04.000Z",
    });
    const recovered = await secondProcess.reconcileCheckpoint(
      submitted.checkpoint.operationGraph.attemptOperationId,
    );

    expect(recovered.status).toBe("completed");
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.getTask).toHaveBeenCalledTimes(1);
  });

  it("durably acknowledges one exact terminal receipt and replays the acknowledgement", async () => {
    const store = new TestCheckpointStore();
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport: scriptedTransport(),
      now: () => "2026-08-13T01:02:04.000Z",
    });
    await executor.startOrResume(imageRequest);
    const completed = await executor.startOrResume(imageRequest);
    if (completed.status !== "completed") throw new Error("expected completed");

    const acknowledged = await executor.acknowledgeReceipt(imageRequest, completed.receipt);
    expect(acknowledged.receiptAppend).toMatchObject({
      state: "appended",
      eventIds: completed.receipt.events.map((event) => event.eventId),
    });

    const replay = await executor.acknowledgeReceipt(imageRequest, completed.receipt);
    expect(replay).toEqual(acknowledged);
  });

  it("coordinates concurrent starters so only the atomic reservation owner can POST", async () => {
    const store = new TestCheckpointStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = vi.fn(async () => {
      await gate;
      return { taskId: "task-image-1" };
    });
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport: scriptedTransport({ submit }),
      now: () => "2026-08-13T01:02:04.000Z",
    });

    const firstPromise = executor.startOrResume(imageRequest);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const second = await executor.startOrResume(imageRequest);
    expect(second.status).toBe("needs_reconciliation");
    release();
    await expect(firstPromise).resolves.toMatchObject({ status: "submitted" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("reattaches the known task after a stale post-submit CAS without another paid POST", async () => {
    const store = new TestCheckpointStore();
    let injectStale = true;
    const checkpointStore: MossOfficialMediaCheckpointStore = {
      durability: "DURABLE",
      reserve: (checkpoint) => store.reserve(checkpoint),
      load: (operationId) => store.load(operationId),
      compareAndSet: async (operationId, revision, next) => {
        if (injectStale) {
          injectStale = false;
          const current = store.checkpoints.get(operationId)!;
          const raced: MossOfficialMediaCheckpoint = {
            ...current,
            state: "submission_ambiguous",
            revision: current.revision + 1,
          };
          store.checkpoints.set(operationId, raced);
          return { status: "stale", checkpoint: raced };
        }
        return store.compareAndSet(operationId, revision, next);
      },
    };
    const transport = scriptedTransport();
    const executor = createMossOfficialMediaExecutor({
      checkpointStore,
      transport,
      now: () => "2026-08-13T01:02:04.000Z",
    });

    const first = await executor.startOrResume(imageRequest);
    expect(first).toMatchObject({
      status: "submitted",
      checkpoint: { state: "submitted", revision: 2, taskId: "task-image-1" },
    });
    const completed = await executor.startOrResume(imageRequest);
    expect(completed.status).toBe("completed");
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "network", "provider_http", "invalid_response"] as const)(
    "turns uncertain %s submit outcome into resumable reconciliation without another POST",
    async (errorCode) => {
      const store = new TestCheckpointStore();
      const submitError = new MossOfficialMediaTransportError(errorCode, true);
      const transport = scriptedTransport({
        submit: vi.fn(async () => Promise.reject(submitError)),
      });
      const executor = createMossOfficialMediaExecutor({
        checkpointStore: store,
        transport,
        now: () => "2026-08-13T01:02:04.000Z",
      });

      const first = await executor.startOrResume(imageRequest);
      expect(first).toMatchObject({
        status: "needs_reconciliation",
        checkpoint: { state: "submission_ambiguous" },
      });
      const resumed = await executor.startOrResume(imageRequest);
      expect(resumed.status).toBe("needs_reconciliation");
      expect(transport.submit).toHaveBeenCalledTimes(1);

      const attached = await executor.attachTaskId(imageRequest, "task-image-1");
      expect(attached).toMatchObject({ state: "submitted", taskId: "task-image-1" });
      const completed = await executor.startOrResume(imageRequest);
      expect(completed.status).toBe("completed");
      expect(transport.submit).toHaveBeenCalledTimes(1);
    },
  );

  it("terminalizes a definite rejection with actionable metadata and never auto-reposts", async () => {
    const store = new TestCheckpointStore();
    const transport = scriptedTransport({
      submit: vi.fn(async () =>
        Promise.reject(new MossOfficialMediaTransportError("provider_rejected", false, 401)),
      ),
    });
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport,
      now: () => "2026-08-13T01:02:04.000Z",
    });

    const first = await executor.startOrResume(imageRequest);
    expect(first).toMatchObject({
      status: "submission_failed",
      failure: { code: "provider_rejected", httpStatus: 401 },
      checkpoint: { state: "submission_rejected" },
    });
    if (first.status !== "submission_failed") throw new Error("expected submission_failed");
    expect(first.receipt.events.some((event) => event.kind === "billing.settlement")).toBe(false);
    expect(first.receipt.events.at(-1)).toMatchObject({
      kind: "operation.lifecycle",
      payload: { state: "failed" },
    });

    await expect(executor.startOrResume(imageRequest)).resolves.toEqual(first);
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.getTask).not.toHaveBeenCalled();
  });

  it("rejects same invocation attempt with a different paid payload before POST", async () => {
    const store = new TestCheckpointStore();
    const transport = scriptedTransport();
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport,
      now: () => "2026-08-13T01:02:04.000Z",
    });
    await executor.startOrResume(imageRequest);

    await expect(
      executor.startOrResume({ ...imageRequest, prompt: "different paid payload" }),
    ).rejects.toBeInstanceOf(MossOfficialMediaConflictError);
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it("reconciles the same completed task idempotently and fails closed on changed payload", async () => {
    const store = new TestCheckpointStore();
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(completedImageTask)
      .mockResolvedValueOnce(completedImageTask)
      .mockResolvedValueOnce({
        ...completedImageTask,
        costUsd: "0.06279",
        providerPayloadDigest: "b".repeat(64),
      });
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport: scriptedTransport({ getTask }),
      now: () => "2026-08-13T01:02:04.000Z",
    });
    await executor.startOrResume(imageRequest);
    await executor.startOrResume(imageRequest);

    await expect(executor.reconcileTask(imageRequest)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(executor.reconcileTask(imageRequest)).rejects.toBeInstanceOf(
      MossOfficialMediaConflictError,
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "records %s lifecycle without any settlement",
    async (state) => {
      const store = new TestCheckpointStore();
      const executor = createMossOfficialMediaExecutor({
        checkpointStore: store,
        transport: scriptedTransport({
          getTask: vi.fn(async () => ({
            taskId: "task-image-1",
            state,
            providerPayloadDigest: "c".repeat(64),
          })),
        }),
        now: () => "2026-08-13T01:02:04.000Z",
      });
      await executor.startOrResume(imageRequest);
      const result = await executor.startOrResume(imageRequest);

      expect(result.status).toBe(state);
      if (result.status !== state) throw new Error(`expected ${state}`);
      expect(result.receipt.events.some((event) => event.kind === "billing.settlement")).toBe(
        false,
      );
      expect(result.receipt.events.at(-1)).toMatchObject({
        kind: "operation.lifecycle",
        payload: { state },
      });
    },
  );

  it("records a provider-authoritative unpriced completion without a settlement", async () => {
    const store = new TestCheckpointStore();
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: store,
      transport: scriptedTransport({
        getTask: vi.fn(async () => ({
          taskId: "task-image-1",
          state: "completed" as const,
          providerPayloadDigest: "d".repeat(64),
          artifactRefs: ["apimart-artifact-image-1"],
          imageOutputCount: "1",
        })),
      }),
      now: () => "2026-08-13T01:02:04.000Z",
    });
    await executor.startOrResume(imageRequest);
    const result = await executor.startOrResume(imageRequest);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.receipt.billingDisposition).toBe("unpriced-observation");
    expect(result.receipt.events.some((event) => event.kind === "billing.settlement")).toBe(false);
    expect(result.receipt.events.at(-1)).toMatchObject({
      kind: "usage.delta",
      source: { authority: "provider-reported" },
      payload: {
        meters: [{ metric: "image_output_count", unit: "count", quantity: "1" }],
      },
    });
  });

  it("refuses paid execution without a store claiming durable atomic checkpoints", async () => {
    const store = new TestCheckpointStore();
    const executor = createMossOfficialMediaExecutor({
      checkpointStore: {
        durability: "MEMORY_ONLY",
        reserve: (checkpoint) => store.reserve(checkpoint),
        load: (operationId) => store.load(operationId),
        compareAndSet: (operationId, revision, next) =>
          store.compareAndSet(operationId, revision, next),
      },
      transport: scriptedTransport(),
    });
    await expect(executor.startOrResume(imageRequest)).rejects.toMatchObject({
      code: "durable_checkpoint_required",
    });
  });

  it("reports the implemented server coordinator and the remaining live gateway gaps", () => {
    expect(MOSS_OFFICIAL_MEDIA_INSTRUMENTATION).toEqual({
      executorCore: "PRODUCTION_COORDINATOR_READY",
      durableCheckpointCaller: "PRIVATE_ATOMIC_FILE_IMPLEMENTED",
      durableUsageAppender: "ATOMIC_APPENDER_REQUIRED_NO_LIVE_GATEWAY",
      artifactPersistence: "OPAQUE_REFS_ONLY_NO_ARTIFACT_STORE",
      productionWiring: "SERVER_FACTORY_BLOCKED_NO_MEDIA_GATEWAY_OR_SKILL_ENTRY",
    });
  });
});
