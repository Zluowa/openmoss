import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeMossImagesError,
  isMossImageJob,
  isMossImageOutputUrl,
  loadMossImagesCatalog,
  loadMossImagesHome,
  loadMossImagesCanvasOrigin,
  loadMossImagesWorkspaceBinding,
  loadMossImagesHistory,
  loadMossImageJob,
  mossImagePreviewSource,
  readMossImageAssetReference,
  MossImagesError,
  readMossImageReference,
  requestMossImagesGenerate,
  waitForMossImageJob,
  type MossImageJob,
} from "./mossImagesClient";

const queued: MossImageJob = {
  jobId: "moss_test_1",
  status: "queued",
  prompt: "A cat",
  createdAt: "2026-10-09T10:00:00.000Z",
  modelId: "gpt-image-2-official",
  imageUrls: [],
  billingStatus: "pending",
};
const succeeded: MossImageJob = {
  ...queued,
  status: "succeeded",
  billingStatus: "captured",
  imageUrls: ["https://assets.example/image.png"],
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.useRealTimers());

describe("historical image Canvas origin", () => {
  const account = { id: "owner", realm: "memfire-phone" };
  it.each(["original-thread", null])(
    "reads only account-bound origin metadata: %s",
    async (threadId) => {
      const fetchImpl = vi.fn(async () => response({ account, threadId }));
      expect(await loadMossImagesCanvasOrigin("moss_owned", undefined, fetchImpl)).toEqual({
        account,
        threadId,
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        "/api/moss/media/jobs/moss_owned/canvas-origin",
        expect.objectContaining({ method: "GET", credentials: "include" }),
      );
    },
  );
  it.each([
    { account, threadId: undefined },
    { account: null, threadId: "thread-a" },
    { account: { id: "", realm: account.realm }, threadId: null },
    { account, threadId: "../../folder" },
  ])("rejects malformed origin rather than treating it as unbound: %j", async (body) => {
    await expect(
      loadMossImagesCanvasOrigin("moss_owned", undefined, async () => response(body)),
    ).rejects.toMatchObject({ code: "invalid_canvas_origin_response" });
  });
  it("does not turn an unavailable original or another owner's job into a legacy import", async () => {
    for (const [code, status] of [
      ["canvas_origin_unavailable", 409],
      ["job_not_found", 404],
    ] as const)
      await expect(
        loadMossImagesCanvasOrigin("moss_owned", undefined, async () =>
          response({ error: { code } }, status),
        ),
      ).rejects.toMatchObject({ code });
    const controller = new AbortController();
    await expect(
      loadMossImagesCanvasOrigin("moss_owned", controller.signal, async () => {
        controller.abort();
        return response({ account, threadId: "original-thread" });
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("conversation image workspace", () => {
  const account = { id: "owner", realm: "memfire-phone" };
  it("uses the trusted folder fingerprint in one generation POST without sending a local path", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? response(queued)
        : response({
            authenticated: true,
            user: account,
            realm: account.realm,
            workspace: { threadId: "thread-a", fingerprint: "a".repeat(64) },
          }),
    );
    const workspace = await loadMossImagesWorkspaceBinding(
      "thread-a",
      account,
      undefined,
      fetchImpl,
    );
    await requestMossImagesGenerate(
      {
        modelId: queued.modelId,
        prompt: "A tree",
        idempotencyKey: "single-image",
        expectedAccount: account,
        workspace,
      },
      undefined,
      fetchImpl,
    );
    const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toContain("canvasThread=thread-a");
    expect(JSON.parse(posts[0]?.[1]?.body as string)).toMatchObject({
      projectId: "thread:thread-a",
      expectedWorkspace: workspace,
    });
    expect(posts[0]?.[1]?.body).not.toContain("cwd");
  });
  it("rejects another account's folder binding before generation", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        authenticated: true,
        user: { id: "other" },
        realm: account.realm,
        workspace: { threadId: "thread-a", fingerprint: "a".repeat(64) },
      }),
    );
    await expect(
      loadMossImagesWorkspaceBinding("thread-a", account, undefined, fetchImpl),
    ).rejects.toMatchObject({ code: "media_account_changed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale or malformed binding without a POST", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        authenticated: true,
        user: account,
        realm: account.realm,
        workspace: { threadId: "thread-b", fingerprint: "a".repeat(64) },
      }),
    );
    await expect(
      loadMossImagesWorkspaceBinding("thread-a", account, undefined, fetchImpl),
    ).rejects.toMatchObject({ code: "canvas_workspace_unavailable" });
    await expect(
      requestMossImagesGenerate(
        {
          modelId: queued.modelId,
          prompt: "A tree",
          idempotencyKey: "single-image",
          workspace: { threadId: "thread-a", fingerprint: "bad" },
        },
        undefined,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "canvas_workspace_changed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("account-bound image client", () => {
  const conversationId = `mossconv_${"a".repeat(32)}`;
  const account = { id: "owner", realm: "memfire-phone" };
  const historyJob = { ...succeeded, conversationId, parentJobId: null };
  it("loads the CLI entry from one local history GET without supplier catalog discovery", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ account, jobs: [historyJob], nextCursor: "older-page" }),
    );
    expect(await loadMossImagesHome(undefined, fetchImpl)).toEqual({
      account,
      models: [],
      jobs: [historyJob],
      nextCursor: "older-page",
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "/api/moss/media/history?limit=24&kind=image",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });
  it("keeps a signed-out CLI entry empty but reports local history failures", async () => {
    expect(
      await loadMossImagesHome(undefined, async () =>
        response({ error: { code: "authentication_required" } }, 401),
      ),
    ).toEqual({ account: null, models: [], jobs: [], nextCursor: null });
    await expect(
      loadMossImagesHome(undefined, async () =>
        response({ error: { code: "media_history_unavailable" } }, 503),
      ),
    ).rejects.toMatchObject({ code: "media_history_unavailable" });
  });
  it.each([
    { account: null },
    { account: { id: "", realm: account.realm } },
    { jobs: [historyJob, historyJob] },
    { jobs: [{ ...historyJob, conversationId: "invalid" }] },
    { nextCursor: "" },
  ])("validates initial history using the same strict page parser: %j", async (overrides) => {
    await expect(
      loadMossImagesHome(undefined, async () =>
        response({ account, jobs: [historyJob], nextCursor: null, ...overrides }),
      ),
    ).rejects.toMatchObject({ code: "invalid_history_response" });
  });
  it("rejects an initial history response after account-bound cancellation", async () => {
    const controller = new AbortController();
    await expect(
      loadMossImagesHome(controller.signal, async () => {
        controller.abort();
        return response({ account, jobs: [historyJob], nextCursor: null });
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("normalizes an authoritative account-change error without retrying transport", async () => {
    const fetchImpl = vi.fn(async () => response({ error: { code: "account_changed" } }, 409));
    await expect(
      loadMossImagesHistory({ expectedAccount: account }, undefined, fetchImpl),
    ).rejects.toMatchObject({ code: "media_account_changed", status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed revisions rather than comparing coerced history versions", () => {
    for (const revision of [-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])
      expect(isMossImageJob({ ...historyJob, revision })).toBe(false);
    expect(isMossImageJob({ ...historyJob, revision: 0 })).toBe(true);
  });
  it("pages local history and a conversation using credentialed GETs without generation or reconciliation", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ account, jobs: [historyJob], nextCursor: "cursor+/=&" }),
    );
    const first = await loadMossImagesHistory({ expectedAccount: account }, undefined, fetchImpl);
    expect(first.jobs).toEqual([historyJob]);
    let [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/moss/media/history?limit=24&kind=image");
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
    expect(init.body).toBeUndefined();
    fetchImpl.mockImplementationOnce(async () =>
      response({ account, conversationId, kind: "image", jobs: [historyJob], nextCursor: null }),
    );
    await loadMossImagesHistory(
      { expectedAccount: account, conversationId, cursor: first.nextCursor! },
      undefined,
      fetchImpl,
    );
    [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain(
      `/api/moss/media/conversations/${conversationId}?limit=50&cursor=cursor%2B%2F%3D%26`,
    );
    expect(init.method).toBe("GET");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    { id: "other", realm: "memfire-phone" },
    { id: "owner", realm: "supabase-global" },
    null,
  ])("rejects history from another account or realm: %j", async (foreign) => {
    await expect(
      loadMossImagesHistory({ expectedAccount: account }, undefined, async () =>
        response({ account: foreign, jobs: [historyJob], nextCursor: null }),
      ),
    ).rejects.toMatchObject({ code: "media_account_changed" });
  });
  it.each([
    { jobs: [historyJob, historyJob] },
    { jobs: [{ ...historyJob, conversationId: "mossconv_bad" }] },
    { jobs: [{ ...historyJob, parentJobId: undefined }] },
    { jobs: [{ ...historyJob, parentJobId: historyJob.jobId }] },
    {
      jobs: [
        { ...historyJob, operation: "video", videoUrls: ["https://assets.example/video.mp4"] },
      ],
    },
    { jobs: Array.from({ length: 25 }, (_, index) => ({ ...historyJob, jobId: `moss_${index}` })) },
    { nextCursor: "" },
    { nextCursor: 2 },
    { nextCursor: "x".repeat(4097) },
  ])("rejects malformed durable history: %j", async (overrides) => {
    await expect(
      loadMossImagesHistory({ expectedAccount: account }, undefined, async () =>
        response({ account, jobs: [historyJob], nextCursor: null, ...overrides }),
      ),
    ).rejects.toMatchObject({ code: "invalid_history_response" });
  });
  it("rejects a foreign conversation and a repeated cursor instead of continuing a paging loop", async () => {
    await expect(
      loadMossImagesHistory({ expectedAccount: account, conversationId }, undefined, async () =>
        response({
          account,
          conversationId,
          kind: "image",
          jobs: [{ ...historyJob, conversationId: `mossconv_${"b".repeat(32)}` }],
          nextCursor: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_history_response" });
    await expect(
      loadMossImagesHistory({ expectedAccount: account, cursor: "same" }, undefined, async () =>
        response({ account, jobs: [], nextCursor: "same" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_history_response" });
  });
  it("rejects a late history response after its owner aborts", async () => {
    const controller = new AbortController();
    await expect(
      loadMossImagesHistory({ expectedAccount: account }, controller.signal, async () => {
        controller.abort();
        return response({ account, jobs: [historyJob], nextCursor: null });
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("binds a follow-up to the selected parent in one POST and rejects incomplete lineage before transport", async () => {
    const fetchImpl = vi.fn(async () => response(queued));
    const input = {
      modelId: queued.modelId,
      prompt: "Edit",
      idempotencyKey: "once",
      conversationId,
      parentJobId: historyJob.jobId,
    };
    await requestMossImagesGenerate(input, undefined, fetchImpl);
    expect(
      JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual(input);
    for (const patch of [
      { parentJobId: undefined },
      { conversationId: undefined },
      { conversationId: "../other" },
      { parentJobId: "../other" },
    ]) {
      await expect(
        requestMossImagesGenerate(
          { ...input, ...patch } as unknown as Parameters<typeof requestMossImagesGenerate>[0],
          undefined,
          fetchImpl,
        ),
      ).rejects.toMatchObject({ code: "invalid_conversation_request" });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      loadMossImagesHistory(
        { expectedAccount: account, conversationId: "../other" },
        undefined,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "invalid_history_request" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("preserves mask/transparent-output parameters in one account-bound POST", async () => {
    const fetchImpl = vi.fn(async () => response(queued));
    const input = {
      modelId: queued.modelId,
      prompt: "Erase selection",
      idempotencyKey: "mask-once",
      referenceImages: ["data:image/png;base64,source"],
      maskImage: "data:image/png;base64,mask",
      background: "transparent" as const,
      outputFormat: "png" as const,
      expectedAccount: { id: "owner", realm: "memfire-phone" },
    };
    await requestMossImagesGenerate(input, undefined, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(init.credentials).toBe("include");
    expect(init.headers).not.toHaveProperty("authorization");
  });
  it("accepts explicit editing capability booleans and rejects malformed catalog claims", async () => {
    const model = {
      id: queued.modelId,
      label: "GPT",
      kind: "image",
      installed: true,
      available: true,
      supportsMaskEdits: true,
      supportsTransparentBackground: true,
    };
    const catalog = { account: { id: "a", realm: "memfire-phone" }, models: [model], jobs: [] };
    expect(
      (await loadMossImagesCatalog(undefined, async () => response(catalog))).models[0],
    ).toEqual(model);
    for (const key of ["supportsMaskEdits", "supportsTransparentBackground"])
      await expect(
        loadMossImagesCatalog(undefined, async () =>
          response({ ...catalog, models: [{ ...model, [key]: "true" }] }),
        ),
      ).rejects.toMatchObject({ code: "invalid_catalog_response" });
    expect(describeMossImagesError(new MossImagesError("", "invalid_mask_image"))).toContain(
      "同尺寸",
    );
  });
  it("validates precise media wallet and task amounts without numeric coercion", async () => {
    const mediaWallet = {
      walletKind: "media_cost_v1",
      currency: "CNY",
      pointsPerCny: 100,
      availableNanoCny: "9007199254740993",
      heldNanoCny: "1",
    };
    const body = { account: { id: "a", realm: "cn" }, models: [], jobs: [], mediaWallet };
    expect(
      (await loadMossImagesCatalog(undefined, async () => response(body))).mediaWallet,
    ).toEqual(mediaWallet);
    expect(
      (
        await loadMossImagesCatalog(undefined, async () =>
          response({ ...body, mediaWallet: { ...mediaWallet, reviewRequired: true } }),
        )
      ).mediaWallet?.reviewRequired,
    ).toBe(true);
    await expect(
      loadMossImagesCatalog(undefined, async () =>
        response({ ...body, mediaWallet: { ...mediaWallet, reviewRequired: "false" } }),
      ),
    ).rejects.toMatchObject({ code: "invalid_catalog_response" });
    for (const availableNanoCny of [1, "-1", "1.1", "1e9", "01"]) {
      await expect(
        loadMossImagesCatalog(undefined, async () =>
          response({ ...body, mediaWallet: { ...mediaWallet, availableNanoCny } }),
        ),
      ).rejects.toMatchObject({ code: "invalid_catalog_response" });
    }
    const billing = { walletKind: "media_cost_v1", chargedNanoCny: "1", creditsCharged: 0 };
    expect(isMossImageJob({ ...succeeded, billing })).toBe(true);
    expect(isMossImageJob({ ...succeeded, billing: { ...billing, chargedNanoCny: 1 } })).toBe(
      false,
    );
  });
  it("submits references with one idempotency key and server-session credentials", async () => {
    const fetchImpl = vi.fn(async () => response(queued));
    const job = await requestMossImagesGenerate(
      {
        modelId: queued.modelId,
        prompt: "  A cat  ",
        idempotencyKey: "request-once",
        referenceImages: ["https://assets.example/source.png"],
        aspectRatio: "1:1",
      },
      undefined,
      fetchImpl,
    );
    expect(job).toEqual(queued);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/moss/media/jobs");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({
      modelId: queued.modelId,
      prompt: "A cat",
      idempotencyKey: "request-once",
      referenceImages: ["https://assets.example/source.png"],
      aspectRatio: "1:1",
    });
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("never retries an uncertain paid POST", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Network unavailable");
    });
    await expect(
      requestMossImagesGenerate(
        { modelId: queued.modelId, prompt: "cat", idempotencyKey: "once" },
        undefined,
        fetchImpl,
      ),
    ).rejects.toThrow("Network unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects empty prompts before submission", async () => {
    const fetchImpl = vi.fn();
    await expect(
      requestMossImagesGenerate(
        { modelId: queued.modelId, prompt: " ", idempotencyKey: "once" },
        undefined,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps authenticated model availability and history scoped to the returned account", async () => {
    const catalog = {
      account: { id: "account-1", realm: "supabase-google" },
      models: [
        {
          id: queued.modelId,
          label: "GPT Image",
          kind: "image",
          installed: true,
          available: false,
          supportsReferences: true,
        },
      ],
      jobs: [succeeded],
    };
    expect(await loadMossImagesCatalog(undefined, async () => response(catalog))).toEqual(catalog);
    expect(
      await loadMossImagesCatalog(undefined, async () =>
        response({ account: null, models: [], jobs: [] }),
      ),
    ).toEqual({ account: null, models: [], jobs: [] });
  });

  it("does not accept a fabricated or unsafe provider image as success", async () => {
    for (const imageUrls of [
      [],
      ["javascript:alert(1)"],
      ["data:image/svg+xml,fake"],
      ["http://assets.example/image.png"],
      ["https://user:secret@assets.example/image.png"],
    ]) {
      expect(isMossImageJob({ ...succeeded, imageUrls })).toBe(false);
    }
    expect(isMossImageOutputUrl("https://assets.example/image.png")).toBe(true);
    await expect(
      loadMossImagesCatalog(undefined, async () =>
        response({ account: null, models: [], jobs: [{ ...succeeded, imageUrls: [] }] }),
      ),
    ).rejects.toMatchObject({ code: "invalid_catalog_response" });
  });

  it("polls through queued/running states without resubmitting generation", async () => {
    vi.useFakeTimers();
    const updates: MossImageJob[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ ...queued, status: "running" }))
      .mockResolvedValueOnce(response(succeeded));
    const pending = waitForMossImageJob({
      job: queued,
      signal: new AbortController().signal,
      onUpdate: (job) => updates.push(job),
      fetchImpl,
      pollMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual(succeeded);
    expect(updates.map((job) => job.status)).toEqual(["running", "succeeded"]);
    expect(
      fetchImpl.mock.calls.every(
        ([url, init]) => url === "/api/moss/media/jobs/moss_test_1" && init.method === "GET",
      ),
    ).toBe(true);
  });

  it("retries transient polling failures, not terminal responses", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ code: "busy" }, 429))
      .mockResolvedValueOnce(response(succeeded));
    const pending = waitForMossImageJob({
      job: queued,
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
      fetchImpl,
      pollMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual(succeeded);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops waiting promptly without pretending to cancel or release billing", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn();
    const onUpdate = vi.fn();
    const pending = waitForMossImageJob({
      job: queued,
      signal: controller.signal,
      onUpdate,
      fetchImpl,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(describeMossImagesError(new DOMException("Aborted", "AbortError"))).toContain(
      "后台任务可能继续运行",
    );
  });

  it("rejects a poll response belonging to another task", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const pending = waitForMossImageJob({
      job: queued,
      signal: new AbortController().signal,
      onUpdate,
      fetchImpl: async () => response({ ...succeeded, jobId: "moss_other" }),
      pollMs: 10,
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "job_identity_mismatch" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("checks a reconciliation job using only its authenticated original GET", async () => {
    const fetchImpl = vi.fn(async () => response(succeeded));
    const controller = new AbortController();
    const signal = controller.signal;
    expect(await loadMossImageJob(queued.jobId, signal, fetchImpl)).toEqual(succeeded);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/moss/media/jobs/${queued.jobId}`,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("rejects a manual recovery result from another job or a retired account request", async () => {
    await expect(
      loadMossImageJob(queued.jobId, new AbortController().signal, async () =>
        response({ ...succeeded, jobId: "moss_other" }),
      ),
    ).rejects.toMatchObject({ code: "job_identity_mismatch" });

    const controller = new AbortController();
    await expect(
      loadMossImageJob(queued.jobId, controller.signal, async () => {
        controller.abort();
        return response(succeeded);
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps unresolved manual recovery unsettled without retrying or creating a job", async () => {
    const job: MossImageJob = {
      ...queued,
      status: "reconciliation_required",
      billingStatus: "unknown",
    };
    const fetchImpl = vi.fn(async () => response(job));
    expect(await loadMossImageJob(job.jobId, new AbortController().signal, fetchImpl)).toEqual(job);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves reconciliation status and unknown fees as a terminal observation", async () => {
    const job: MossImageJob = {
      ...queued,
      status: "reconciliation_required",
      billingStatus: "unknown",
    };
    const fetchImpl = vi.fn();
    expect(
      await waitForMossImageJob({
        job,
        signal: new AbortController().signal,
        onUpdate: vi.fn(),
        fetchImpl,
      }),
    ).toEqual(job);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces sign-in and quota errors without inventing success", async () => {
    const fetchImpl = async () =>
      response({ error: { code: "insufficient_credits", message: "Balance exhausted" } }, 402);
    await expect(
      requestMossImagesGenerate(
        { modelId: queued.modelId, prompt: "cat", idempotencyKey: "once" },
        undefined,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "insufficient_credits", status: 402 });
    expect(
      describeMossImagesError(new MossImagesError("", "authentication_required", 401)),
    ).toContain("登录");
    expect(describeMossImagesError(new MossImagesError("", "insufficient_credits", 402))).toContain(
      "套餐额度已用完",
    );
  });

  it("rejects unsupported and oversized reference uploads before reading bytes", async () => {
    await expect(
      readMossImageReference(new File(["<svg/>"], "image.svg", { type: "image/svg+xml" })),
    ).rejects.toMatchObject({ code: "invalid_reference_type" });
    await expect(
      readMossImageReference(
        new File([new Uint8Array(4 * 1024 * 1024 + 1)], "image.png", { type: "image/png" }),
      ),
    ).rejects.toMatchObject({ code: "reference_too_large" });
  });
  it("prefers durable authenticated assets and rejects foreign download paths", () => {
    const asset = {
      assetId: "a".repeat(64),
      index: 0,
      kind: "image" as const,
      contentType: "image/png",
      byteLength: 128,
      downloadPath: `/api/moss/media/assets/${succeeded.jobId}/0`,
    };
    const durable = { ...succeeded, assets: [asset], persistenceStatus: "ready" as const };
    expect(isMossImageJob(durable)).toBe(true);
    expect(mossImagePreviewSource(durable, 0)).toBe(asset.downloadPath);
    expect(mossImagePreviewSource(succeeded, 0)).toBe(succeeded.imageUrls[0]);
    expect(
      isMossImageJob({
        ...durable,
        assets: [{ ...asset, downloadPath: "https://attacker.example/download" }],
      }),
    ).toBe(false);
    expect(
      isMossImageJob({
        ...durable,
        assets: [{ ...asset, downloadPath: "/api/moss/media/assets/moss_other/0" }],
      }),
    ).toBe(false);
  });

  it("bounds cached reference reads before fetching bytes", async () => {
    const fetchImpl = vi.fn();
    const asset = {
      assetId: "a".repeat(64),
      index: 0,
      kind: "image" as const,
      contentType: "image/png",
      byteLength: 5 * 1024 * 1024,
      downloadPath: `/api/moss/media/assets/${succeeded.jobId}/0`,
    };
    await expect(
      readMossImageAssetReference(asset, new AbortController().signal, fetchImpl),
    ).rejects.toMatchObject({ code: "reference_too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      readMossImageAssetReference(
        { ...asset, byteLength: 128, contentType: "image/avif" },
        new AbortController().signal,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "invalid_reference_type" });
  });
});
