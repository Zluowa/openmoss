import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HoolaCanvasJobSnapshot } from "../hoolaCanvasBridge";
import { MossMediaJobsService, type MossMediaCredential } from "../mossMediaJobsService";
import {
  makeAgentGatewayMediaTools,
  MOSS_MEDIA_TOOL_NAMES,
  type AgentGatewayMediaToolsInput,
} from "./mediaTools";
import { GatewayToolError, type ToolContext } from "./toolRuntime";

const MODEL = "gpt-image-2-official";
const credential: MossMediaCredential = {
  account: { id: "user-a", realm: "memfire-phone" },
  realm: "memfire-phone",
  accessToken: "SECRET_ACCOUNT_BEARER",
  gatewayBaseUrl: "https://gateway.example/v1",
  installedModelIds: [MODEL],
};
const job: HoolaCanvasJobSnapshot = {
  success: true,
  jobId: "moss_native_1",
  projectId: "thread:thread-1",
  status: "queued",
  prompt: "A cat",
  createdAt: "2026-10-09T00:00:00.000Z",
  modelId: MODEL,
  operation: "text_to_image",
  imageUrls: [],
  videoUrls: [],
  retryCount: 0,
  persistenceStatus: "pending",
  billingStatus: "pending",
  errorCategory: "none",
};
const generateArgs = { modelId: MODEL, prompt: "A cat", idempotencyKey: "request-1" };

function harness(
  providedService?: AgentGatewayMediaToolsInput["service"],
  workspace?: string,
  openCanvas?: AgentGatewayMediaToolsInput["openCanvas"],
) {
  let current = credential;
  let active = true;
  let admitted = 0;
  const service: AgentGatewayMediaToolsInput["service"] = providedService ?? {
    list: vi.fn<MossMediaJobsService["list"]>(async (auth) => ({
      account: { ...auth.account, creditBalance: 941 },
      models: [{ id: MODEL, label: "GPT Image", kind: "image", installed: true, available: true }],
      jobs: [job, { ...job, jobId: "moss_other", projectId: "thread:thread-2" }],
    })),
    create: vi.fn<MossMediaJobsService["create"]>(async (_args, _auth, authorize) => {
      await authorize?.();
      admitted += 1;
      return job;
    }),
    check: vi.fn<MossMediaJobsService["check"]>(async () => job),
  };
  const tools = makeAgentGatewayMediaTools({
    service,
    resolveCredential: Effect.sync(() => current),
    ...(workspace ? { resolveWorkspaceRoot: () => Effect.succeed(workspace) } : {}),
    ...(openCanvas ? { openCanvas } : {}),
  });
  const context: ToolContext = {
    principal: {
      kind: "provider-session",
      sessionKey: "session-1",
      threadId: "thread-1",
      provider: "codex",
      turnId: "turn-1",
    },
    callerThreadId: "thread-1",
    callerThreadLabel: "Media",
    callerSessionKey: "session-1",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn-1",
    jsonRpcRequestId: 1,
    assertCallerTurnActive: () =>
      active
        ? Effect.void
        : Effect.fail(new GatewayToolError("caller_turn_inactive", "Turn ended")),
  };
  const invoke = async (
    name: (typeof MOSS_MEDIA_TOOL_NAMES)[number],
    args: Record<string, unknown> = {},
    caller = context,
  ) => {
    const result = await Effect.runPromise(
      tools.find((tool) => tool.definition.name === name)!.handler(args, caller),
    );
    return {
      result,
      body: JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}"),
    };
  };
  return {
    service,
    tools,
    context,
    invoke,
    setCredential: (value: MossMediaCredential) => {
      current = value;
    },
    endTurn: () => {
      active = false;
    },
    admitted: () => admitted,
  };
}

describe("native official media tools", () => {
  it("opens Canvas only through the explicit tool, without catalog, generation, polling or payments", async () => {
    const openCanvas = vi.fn(() => Effect.void);
    const h = harness(undefined, undefined, openCanvas);
    const { body, result } = await h.invoke("moss_canvas_open");
    expect(result.isError).not.toBe(true);
    expect(body).toMatchObject({ opened: true, threadId: "thread-1", supplierRequests: 0 });
    expect(openCanvas).toHaveBeenCalledWith({ threadId: "thread-1" }, h.context);
    expect(h.service.create).not.toHaveBeenCalled();
    expect(h.service.check).not.toHaveBeenCalled();
    expect(h.service.list).not.toHaveBeenCalled();
  });
  it("rejects an image from another caller thread before opening Canvas", async () => {
    const openCanvas = vi.fn(() => Effect.void);
    const h = harness(undefined, undefined, openCanvas);
    h.service.readOwnedJob = vi.fn(async () => ({
      ...job,
      projectId: "thread:other",
      imageUrls: ["https://assets.example/image.png"],
    }));
    const { result } = await h.invoke("moss_canvas_open", { jobId: job.jobId });
    expect(result.isError).toBe(true);
    expect(openCanvas).not.toHaveBeenCalled();
  });
  it("rechecks the account after loading an existing image for Canvas", async () => {
    const openCanvas = vi.fn(() => Effect.void);
    const h = harness(undefined, undefined, openCanvas);
    h.service.readOwnedJob = vi.fn(async () => {
      h.setCredential({ ...credential, account: { ...credential.account, id: "other" } });
      return { ...job, imageUrls: ["https://assets.example/image.png"] };
    });
    const { result } = await h.invoke("moss_canvas_open", { jobId: job.jobId });
    expect(result.isError).toBe(true);
    expect(openCanvas).not.toHaveBeenCalled();
    expect(h.service.create).not.toHaveBeenCalled();
  });
  it("does not accept a model supplied folder or open Canvas after the caller turn ends", async () => {
    const openCanvas = vi.fn(() => Effect.void);
    const h = harness(undefined, undefined, openCanvas);
    expect((await h.invoke("moss_canvas_open", { folderPath: "C:/outside" })).result.isError).toBe(
      true,
    );
    h.endTurn();
    expect((await h.invoke("moss_canvas_open")).result.isError).toBe(true);
    expect(openCanvas).not.toHaveBeenCalled();
  });
  it("reads a workspace mask without returning base64 and submits it with the original account/turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-native-mask-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=",
      "base64",
    );
    try {
      writeFileSync(join(root, "source.png"), png);
      writeFileSync(join(root, "mask.png"), png);
      const h = harness(undefined, root);
      const args = {
        ...generateArgs,
        referencePaths: ["source.png"],
        maskPath: "mask.png",
        background: "transparent",
        outputFormat: "png",
      };
      const result = await h.invoke("moss_media_generate", args);
      expect(result.result.isError).not.toBe(true);
      const submitted = vi.mocked(h.service.create).mock.calls[0]![0] as Record<string, unknown>;
      expect(submitted).toMatchObject({
        referenceImages: [`data:image/png;base64,${png.toString("base64")}`],
        maskImage: `data:image/png;base64,${png.toString("base64")}`,
        background: "transparent",
        outputFormat: "png",
      });
      expect(submitted).not.toHaveProperty("maskPath");
      expect(submitted).not.toHaveProperty("referencePaths");
      expect(JSON.stringify(result)).not.toContain("base64");
      h.setCredential({ ...credential, account: { ...credential.account, id: "changed" } });
      expect((await h.invoke("moss_media_generate", args)).body.error.code).toBe(
        "media_account_changed",
      );
      expect(h.service.create).toHaveBeenCalledTimes(1);
      const noOriginal = harness(undefined, root);
      expect(
        (
          await noOriginal.invoke("moss_media_generate", {
            ...args,
            referencePaths: [],
            referenceImages: ["https://assets.example/source.png"],
          })
        ).body.error.code,
      ).toBe("invalid_mask_image");
      expect(noOriginal.service.create).not.toHaveBeenCalled();
      const different = Buffer.from(png);
      different.writeUInt32BE(2, 16);
      writeFileSync(join(root, "mask.png"), different);
      expect((await noOriginal.invoke("moss_media_generate", args)).body.error.code).toBe(
        "invalid_mask_image",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires a workspace for masks and rejects unsupported parameter combinations", async () => {
    const h = harness();
    expect(
      (await h.invoke("moss_media_generate", { ...generateArgs, maskPath: "mask.png" })).body.error
        .code,
    ).toBe("workspace_required");
    for (const change of [
      { maskPath: "" },
      { background: "transparent", outputFormat: "jpeg" },
      { maskImage: "model-generated-base64" },
      { outputFormat: "svg" },
    ])
      expect(
        (await h.invoke("moss_media_generate", { ...generateArgs, ...change })).body.error.code,
      ).toBe("invalid_request");
    expect(h.service.create).not.toHaveBeenCalled();
  });
  it("counts inline references together with local mask bytes in the encoded request limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-native-mask-budget-"));
    try {
      const bytes = Buffer.alloc(3 * 1024 * 1024);
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=",
        "base64",
      ).copy(bytes);
      writeFileSync(join(root, "mask.png"), bytes);
      const h = harness(undefined, root);
      const result = await h.invoke("moss_media_generate", {
        ...generateArgs,
        referenceImages: [`data:image/png;base64,${bytes.toString("base64")}`],
        maskPath: "mask.png",
      });
      expect(result.body.error.code).toBe("request_too_large");
      expect(h.service.create).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("uses existing capability and active-turn gates, without broadening session grants", () => {
    const { tools } = harness();
    expect(tools.map((tool) => tool.definition.name)).toEqual(MOSS_MEDIA_TOOL_NAMES);
    expect(tools.map((tool) => tool.requiredCapability)).toEqual([
      "thread:write",
      "thread:read",
      "thread:write",
      "thread:read",
    ]);
    expect(tools.every((tool) => tool.requiresActiveTurn)).toBe(true);
  });

  it("exposes models and only this thread's jobs without the global account or wallet", async () => {
    const h = harness();
    const { result, body } = await h.invoke("moss_media_list");
    expect(body.models).toHaveLength(1);
    expect(body.jobs.map((item: HoolaCanvasJobSnapshot) => item.jobId)).toEqual([job.jobId]);
    expect(body.account).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("creditBalance");
    expect(JSON.stringify(result)).not.toContain(credential.account.id);
    expect(JSON.stringify(result)).not.toContain(credential.realm);
    expect(JSON.stringify(result)).not.toContain(credential.accessToken);
    expect(h.service.list).toHaveBeenCalledWith(credential);
  });

  it("submits in the caller's thread with stable idempotency and no credential input", async () => {
    const h = harness();
    const { body, result } = await h.invoke("moss_media_generate", generateArgs);
    expect(result.isError).not.toBe(true);
    expect(body.jobId).toBe(job.jobId);
    expect(h.admitted()).toBe(1);
    expect(h.service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ...generateArgs,
        projectId: "thread:thread-1",
        metadata: { sourceSurface: "moss-agent-media", threadId: "thread-1" },
      }),
      credential,
      expect.any(Function),
      undefined,
      { threadId: "thread-1", turnId: "turn-1" },
    );
    expect(JSON.stringify(result)).not.toContain(credential.accessToken);
  });

  it("rejects account rebinding within a turn before any job is admitted", async () => {
    const h = harness();
    await h.invoke("moss_media_list");
    h.setCredential({ ...credential, account: { ...credential.account, id: "user-b" } });
    const { body } = await h.invoke("moss_media_generate", generateArgs);
    expect(body.error.code).toBe("media_account_changed");
    expect(h.admitted()).toBe(0);
    expect(h.service.create).not.toHaveBeenCalled();
    const next = await h.invoke("moss_media_list", {}, { ...h.context, callerTurnId: "turn-2" });
    expect(next.result.isError).not.toBe(true);
    expect(h.service.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: { ...credential.account, id: "user-b" } }),
    );
    expect(next.body.account).toBeUndefined();
  });

  it("rechecks a turn retired while waiting for catalog preflight", async () => {
    const h = harness();
    vi.mocked(h.service.create).mockImplementationOnce(async (_input, _auth, authorize) => {
      h.endTurn();
      await authorize?.();
      throw new Error("Should never admit a job");
    });
    const { result, body } = await h.invoke("moss_media_generate", generateArgs);
    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("caller_turn_inactive");
    expect(h.admitted()).toBe(0);
  });

  it("rechecks installation and account after catalog wait immediately before reservation", async () => {
    const h = harness();
    vi.mocked(h.service.create).mockImplementationOnce(async (_input, _auth, authorize) => {
      h.setCredential({ ...credential, installedModelIds: [] });
      await authorize?.();
      throw new Error("Should never admit a job");
    });
    const { body } = await h.invoke("moss_media_generate", generateArgs);
    expect(body.error.code).toBe("media_skill_not_installed");
    expect(h.admitted()).toBe(0);
  });

  it("fails closed when the active account switches during admission", async () => {
    const h = harness();
    vi.mocked(h.service.create).mockImplementationOnce(async (_input, _auth, authorize) => {
      h.setCredential({ ...credential, account: { ...credential.account, id: "other-account" } });
      await authorize?.();
      throw new Error("Should never admit a job");
    });
    const { body } = await h.invoke("moss_media_generate", generateArgs);
    expect(body.error.code).toBe("media_account_changed");
    expect(h.admitted()).toBe(0);
  });

  it("rejects credential/authority override args and unsafe references before service calls", async () => {
    const h = harness();
    for (const args of [
      { ...generateArgs, apiKey: "secret" },
      { ...generateArgs, projectId: "someone-else" },
      { ...generateArgs, referenceImages: ["file:///etc/passwd"] },
      { ...generateArgs, referenceImages: ["https://user:secret@host/image.png"] },
      { ...generateArgs, referenceImages: ["data:image/svg+xml;base64,AA=="] },
    ]) {
      expect((await h.invoke("moss_media_generate", args)).body.error.code).toBe("invalid_request");
    }
    expect(h.service.create).not.toHaveBeenCalled();
  });

  it.each([
    { referenceImages: ["https://assets.example/source.png"] },
    { referencePaths: ["source.png"] },
    { referenceImages: "https://assets.example/source.png" },
    { referencePaths: {} },
    { sourceVideo: "https://assets.example/source.mp4" },
    { generationMode: "all-reference" },
    { metadata: { referenceVideos: ["https://assets.example/source.mp4"] } },
  ])(
    "rejects unsupported video intent before file reads or service creation: %j",
    async (options) => {
      const h = harness();
      const { body, result } = await h.invoke("moss_media_generate", {
        ...generateArgs,
        modelId: "kling-v3-omni",
        ...options,
      });
      expect(result.isError).toBe(true);
      expect(body.error.code).toMatch(
        /^(invalid_request|invalid_video_options|unsupported_video_options)$/u,
      );
      expect(h.service.create).not.toHaveBeenCalled();
      expect(h.admitted()).toBe(0);
    },
  );

  it("keeps plain video tool requests compatible", async () => {
    const h = harness();
    h.setCredential({ ...credential, installedModelIds: [MODEL, "wan3.0-video"] });
    const { result } = await h.invoke("moss_media_generate", {
      ...generateArgs,
      modelId: "wan3.0-video",
      referenceImages: [],
      duration: 5,
      generateAudio: false,
      promptExtend: true,
    });
    expect(result.isError).not.toBe(true);
    expect(h.service.create).toHaveBeenCalledOnce();
  });

  it("preserves supported video frames and reference durations through native tools", async () => {
    const h = harness();
    h.setCredential({ ...credential, installedModelIds: [MODEL, "MiniMax-H3-Max"] });
    const referenceVideos = ["https://assets.example/clip.mp4"];
    const { result } = await h.invoke("moss_media_generate", {
      ...generateArgs,
      modelId: "MiniMax-H3-Max",
      generationMode: "reference",
      referenceImages: ["https://assets.example/ref.png"],
      referenceVideos,
      referenceVideoDurations: [3],
      resolution: "768P",
      duration: 5,
    });
    expect(result.isError).not.toBe(true);
    expect(vi.mocked(h.service.create).mock.calls[0]?.[0]).toMatchObject({
      generationMode: "reference",
      referenceVideos,
      referenceVideoDurations: [3],
    });
  });
  it("promotes thirty local Seedance references without lowering image-model or byte limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-native-video-references-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=",
      "base64",
    );
    try {
      const referencePaths = Array.from({ length: 30 }, (_, index) => `reference-${index}.png`);
      for (const reference of referencePaths) writeFileSync(join(root, reference), png);
      const h = harness(undefined, root);
      h.setCredential({ ...credential, installedModelIds: [MODEL, "doubao-seedance-2.5"] });
      const { result } = await h.invoke("moss_media_generate", {
        ...generateArgs,
        modelId: "doubao-seedance-2.5",
        referencePaths,
        duration: 5,
      });
      expect(result.isError).not.toBe(true);
      const submitted = vi.mocked(h.service.create).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(submitted.referenceImages).toHaveLength(30);
      expect(submitted).not.toHaveProperty("referencePaths");
      expect(JSON.stringify(result)).not.toContain("base64");
      const imageOnly = harness(undefined, root);
      expect(
        (
          await imageOnly.invoke("moss_media_generate", {
            ...generateArgs,
            referencePaths: referencePaths.slice(0, 5),
          })
        ).result.isError,
      ).toBe(true);
      expect(imageOnly.service.create).not.toHaveBeenCalled();
      expect(
        (
          await h.invoke("moss_media_generate", {
            ...generateArgs,
            modelId: "doubao-seedance-2.5",
            referencePaths: [...referencePaths, referencePaths[0]],
          })
        ).result.isError,
      ).toBe(true);
      expect(h.service.create).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gets jobs only through the account-scoped service and keeps errors secret-free", async () => {
    const h = harness();
    expect((await h.invoke("moss_media_get", { jobId: job.jobId })).body.jobId).toBe(job.jobId);
    expect(h.service.check).toHaveBeenCalledWith(job.jobId, credential, job.projectId);
    vi.mocked(h.service.check).mockImplementationOnce(async () => {
      throw new Error(`Transport leaked ${credential.accessToken}`);
    });
    const failure = await h.invoke("moss_media_get", { jobId: job.jobId });
    expect(failure.body.error.code).toBe("media_request_failed");
    expect(JSON.stringify(failure)).not.toContain(credential.accessToken);
  });

  it("denies another thread's job and legacy jobs without trusted ownership", async () => {
    const h = harness();
    for (const projectId of ["thread:thread-2", "images-workspace", undefined]) {
      vi.mocked(h.service.check).mockResolvedValueOnce({
        ...job,
        projectId,
      } as HoolaCanvasJobSnapshot);
      const denied = await h.invoke("moss_media_get", { jobId: job.jobId });
      expect(denied.result.isError).toBe(true);
      expect(denied.body.error.code).toBe("job_not_found");
      expect(JSON.stringify(denied)).not.toContain(job.prompt);
    }
  });

  it("rejects a bill query result after its account changes during the wait", async () => {
    const h = harness();
    let finish!: (value: HoolaCanvasJobSnapshot) => void;
    vi.mocked(h.service.check).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.invoke("moss_media_get", { jobId: job.jobId });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.setCredential({ ...credential, account: { ...credential.account, id: "account-b" } });
    finish({ ...job, status: "succeeded", billingStatus: "captured" });
    const result = await pending;
    expect(result.body.error.code).toBe("media_account_changed");
    expect(JSON.stringify(result)).not.toContain(job.prompt);
  });

  it("restores thread ownership from disk for a new session in the same thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-native-thread-media-"));
    try {
      const service = new MossMediaJobsService({
        stateDirectory: directory,
        fetchImpl: async (url) =>
          String(url).endsWith("/catalog")
            ? Response.json({
                account: { ...credential.account, creditBalance: 941 },
                models: [{ id: MODEL, label: "GPT Image", kind: "image", available: true }],
              })
            : Response.json(
                { billingStatus: "released", error: { code: "provider_rejected" } },
                { status: 400 },
              ),
      });
      const creator = harness(service);
      const created = await creator.invoke("moss_media_generate", generateArgs);
      expect(created.result.isError).not.toBe(true);
      await vi.waitFor(() =>
        expect(service.get(created.body.jobId, credential).status).toBe("failed_terminal"),
      );
      const restored = new MossMediaJobsService({
        stateDirectory: directory,
        fetchImpl: async () => {
          throw new Error("Restoring a terminal job must not request provider generation");
        },
      });
      const reader = harness(restored);
      const nextSession = {
        ...reader.context,
        callerSessionKey: "session-restored",
        callerTurnId: "turn-restored",
        principal: {
          ...reader.context.principal,
          sessionKey: "session-restored",
          turnId: "turn-restored",
        },
      };
      const recovered = await reader.invoke(
        "moss_media_get",
        { jobId: created.body.jobId },
        nextSession,
      );
      expect(recovered.result.isError, JSON.stringify(recovered.body)).not.toBe(true);
      expect(recovered.body.projectId).toBe("thread:thread-1");
      expect(recovered.body.jobId).toBe(created.body.jobId);
      const denied = await reader.invoke(
        "moss_media_get",
        { jobId: created.body.jobId },
        {
          ...nextSession,
          callerThreadId: "thread-2",
          principal: { ...nextSession.principal, threadId: "thread-2" },
        },
      );
      expect(denied.body.error.code).toBe("job_not_found");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
