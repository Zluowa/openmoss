import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";

import {
  MossMediaJobsService,
  mediaAccountScope,
  type MossMediaCredential,
  type MossConversationImageObservation,
} from "./mossMediaJobsService";
import { HoolaCanvasBridgeBroker } from "./hoolaCanvasBridge";
import { MossMediaHistory } from "./mossMediaHistory";
import { MossMediaAssetStore } from "./mossMediaAssets";
import { readMossMediaLibraryItems } from "./mossMediaLibrary";
import * as canvasStorage from "./mossCanvasStorage";
import { conversationImageActivityCommands } from "./agentGateway/mediaImageActivities";

const directories: string[] = [];
function stateDirectory() {
  const path = mkdtempSync(join(tmpdir(), "moss-media-service-"));
  directories.push(path);
  return path;
}
beforeEach(() => {
  vi.spyOn(outboundHttp, "request").mockImplementation(async (request) => ({
    status: 200,
    body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    headers: new Headers({ "content-type": "image/png" }),
    url: String(request.url),
  }));
});
afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

const credential: MossMediaCredential = {
  realm: "memfire-phone",
  accessToken: "private-account-bearer",
  gatewayBaseUrl: "https://gateway.example/functions/v1/moss-model-gateway/v1",
  account: { id: "account-a", realm: "memfire-phone" },
  installedModelIds: ["gpt-image-2-official"],
};
const request = {
  prompt: "An ink drawing",
  modelId: "gpt-image-2-official",
  idempotencyKey: "operation-1",
};
const catalog = () =>
  Response.json({
    models: [
      {
        id: request.modelId,
        label: "GPT Image",
        kind: "image",
        available: true,
        supportsReferences: true,
        priceLabel: "2 积分",
      },
    ],
  });

describe("MossMediaJobsService", () => {
  it("delivers saved images to the original turn without polling or Markdown and replays them without billing again", async () => {
    const directory = stateDirectory();
    const workspace = { threadId: "thread-gallery", cwd: directory, title: "Gallery" };
    const assetsRoot = join(directory, ".moss", "canvas", "fixture", "assets");
    let reportedAssetsRoot = assetsRoot;
    await mkdir(assetsRoot, { recursive: true });
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue({
      request: vi.fn(async (method, input) => {
        if (method === "workspace.importAssetBytes") {
          const bytes = Buffer.from(String(input?.bytesBase64), "base64");
          const name = `${createHash("sha256").update(bytes).digest("hex")}.png`;
          await writeFile(join(assetsRoot, name), bytes);
          return { url: `moss-canvas-asset:${name}` };
        }
        if (method === "workspace.info") return { assetsRoot: reportedAssetsRoot };
        return {};
      }),
      readAsset: vi.fn(),
      readKnowledgeAsset: vi.fn(),
      close: vi.fn(),
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/catalog")) return catalog();
      if (String(url).endsWith("/generations")) return Response.json({ taskToken: "fixture-task" });
      return Response.json({
        status: "completed",
        pending: false,
        billingStatus: "captured",
        imageUrls: ["https://assets.example/one.png", "https://assets.example/two.png"],
      });
    });
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl,
      brokerOptions: { pollMs: 0 },
    });
    service.setCanvasWorkspaceResolver(async () => workspace);
    const observations: MossConversationImageObservation[] = [];
    service.setConversationImageObserver(async (value) => {
      observations.push(value);
    });
    const created = await service.create(
      { ...request, projectId: "thread:thread-gallery" },
      credential,
      undefined,
      directory,
      { threadId: "thread-gallery", turnId: "turn-created" },
    );
    // The background broker publishes completion itself; this test never polls
    // get/check to manufacture the initial completion observation.
    await vi.waitFor(() =>
      expect(observations.some((item) => item.outputs.length === 2)).toBe(true),
    );
    expect(observations[0]?.snapshot.status).toBe("queued");
    const completion = observations.find((item) => item.outputs.length === 2)!;
    expect(completion.origin).toEqual({ threadId: "thread-gallery", turnId: "turn-created" });
    expect(completion.accountScope).toBe(mediaAccountScope(credential));
    expect(completion.snapshot.billingStatus).toBe("captured");
    expect(completion.outputs.map((output) => output.index)).toEqual([0, 1]);
    expect(readFileSync(completion.outputs[0]!.path).byteLength).toBeGreaterThan(0);
    const originalCommands = conversationImageActivityCommands(completion);
    // A bad/missing Canvas path can never publish a guessed successful artifact.
    // Its supplier result stays captured and a later local repair can redeliver.
    reportedAssetsRoot = stateDirectory();
    await service.check(created.jobId, credential, "thread:thread-gallery");
    expect(observations.at(-1)).toMatchObject({ outputs: [], projectionFailed: true });
    expect((await service.readOwnedJob(created.jobId, credential)).billingStatus).toBe("captured");
    reportedAssetsRoot = assetsRoot;
    await service.check(created.jobId, credential, "thread:thread-gallery");
    expect(conversationImageActivityCommands(observations.at(-1)!)).toEqual(originalCommands);
    const generationCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).endsWith("/generations"),
    );
    expect(generationCalls).toHaveLength(1);
    fetchImpl.mockClear();

    const noNetwork = vi.fn<typeof fetch>();
    const restored = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: noNetwork });
    restored.setCanvasWorkspaceResolver(async () => workspace);
    const replay: MossConversationImageObservation[] = [];
    restored.setConversationImageObserver(async (value) => {
      replay.push(value);
    });
    await restored.check(created.jobId, credential, "thread:thread-gallery");
    // Reusing an idempotency key in a later turn may observe the job, but must
    // never move the origin, create a fresh gallery item, or issue another POST.
    await restored.create(
      { ...request, projectId: "thread:thread-gallery" },
      credential,
      undefined,
      directory,
      { threadId: "thread-gallery", turnId: "turn-later" },
    );
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.every((item) => item.origin.turnId === "turn-created")).toBe(true);
    expect(conversationImageActivityCommands(replay.at(-1)!)).toEqual(originalCommands);
    expect(noNetwork).not.toHaveBeenCalled();
    await expect(
      restored.check(
        created.jobId,
        { ...credential, account: { ...credential.account, id: "other" } },
        "thread:thread-gallery",
      ),
    ).rejects.toMatchObject({ code: "job_not_found" });
    const replayCount = replay.length;
    await expect(
      restored.check(created.jobId, credential, "thread:other-thread"),
    ).rejects.toMatchObject({ code: "job_not_found" });
    expect(replay).toHaveLength(replayCount);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent server conversation origin before catalog or generation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new MossMediaJobsService({ stateDirectory: stateDirectory(), fetchImpl });
    await expect(
      service.create(
        { ...request, projectId: "thread:thread-owner" },
        credential,
        undefined,
        undefined,
        { threadId: "thread-other", turnId: "turn-other" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps supplier state and billing intact when the transcript observer fails", async () => {
    const directory = stateDirectory();
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue({
      request: vi.fn(async () => ({})),
      readAsset: vi.fn(),
      readKnowledgeAsset: vi.fn(),
      close: vi.fn(),
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/catalog")
        ? catalog()
        : Response.json(
            { billingStatus: "released", error: { code: "provider_rejected" } },
            { status: 400 },
          ),
    );
    const service = new MossMediaJobsService({ stateDirectory: directory, fetchImpl });
    service.setCanvasWorkspaceResolver(async () => ({
      threadId: "thread-failure",
      cwd: directory,
      title: "Failure",
    }));
    const observer = vi.fn(async () => {
      throw new Error("fixture persistence failed");
    });
    service.setConversationImageObserver(observer);
    const created = await service.create(
      { ...request, projectId: "thread:thread-failure" },
      credential,
      undefined,
      directory,
      { threadId: "thread-failure", turnId: "turn-failure" },
    );
    await vi.waitFor(async () =>
      expect((await service.readOwnedJob(created.jobId, credential)).status).toBe(
        "failed_terminal",
      ),
    );
    const bill = await service.readOwnedJob(created.jobId, credential);
    expect(bill.billingStatus).toBe("released");
    expect(observer).toHaveBeenCalled();
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/generations")),
    ).toHaveLength(1);
    fetchImpl.mockClear();
    await service.check(created.jobId, credential, "thread:thread-failure");
    expect((await service.readOwnedJob(created.jobId, credential)).billingStatus).toBe("released");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("restores saved outputs into this account's Library without catalog, generation or reconciliation requests", async () => {
    const directory = stateDirectory();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/catalog")) return catalog();
      if (String(url).endsWith("/generations")) return Response.json({ taskToken: "fixture-task" });
      return Response.json({
        status: "completed",
        pending: false,
        billingStatus: "captured",
        imageUrl: "https://assets.example/result.png",
      });
    });
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl,
      brokerOptions: { pollMs: 0 },
    });
    const created = await service.create(request, credential);
    await vi.waitFor(() =>
      expect(service.get(created.jobId, credential).persistenceStatus).toBe("ready"),
    );
    const bill = await service.readOwnedJob(created.jobId, credential);
    fetchImpl.mockClear();
    const items = await readMossMediaLibraryItems(directory, credential);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      mediaJobId: created.jobId,
      mediaImageIndex: 0,
      kind: "image",
      path: null,
      previewPath: `/api/moss/media/assets/${created.jobId}/0`,
    });
    expect(
      await readMossMediaLibraryItems(directory, {
        ...credential,
        account: { ...credential.account, id: "another-account" },
      }),
    ).toEqual([]);
    expect(await service.readOwnedJob(created.jobId, credential)).toEqual(bill);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("imports an owned cached image into the selected conversation without another supplier call or billing change", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/catalog")) return catalog();
      if (String(url).endsWith("/generations")) return Response.json({ taskToken: "fixture-task" });
      return Response.json({
        status: "completed",
        pending: false,
        billingStatus: "captured",
        imageUrl: "https://assets.example/result.png",
      });
    });
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      brokerOptions: { pollMs: 0 },
      fetchImpl,
    });
    const created = await service.create(request, credential);
    await vi.waitFor(() =>
      expect(service.get(created.jobId, credential).persistenceStatus).toBe("ready"),
    );
    const before = await service.readOwnedJob(created.jobId, credential);
    const sync = vi.fn(async (method: string) =>
      method === "workspace.importAssetBytes"
        ? { url: `moss-canvas-asset:${"a".repeat(64)}.png` }
        : {},
    );
    const stores = vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue({
      request: sync,
      readAsset: vi.fn(),
      readKnowledgeAsset: vi.fn(),
      close: vi.fn(),
    });
    const authorize = vi.fn(async () => undefined);
    fetchImpl.mockClear();
    const result = await service.importCanvasJob(
      created.jobId,
      credential,
      { threadId: "chosen-thread", cwd: stateDirectory(), title: "Selected folder" },
      authorize,
    );
    expect(result).toEqual({ jobId: created.jobId, imported: true, supplierRequests: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stores.mock.calls.at(-1)?.[2]).toMatchObject({ threadId: "chosen-thread" });
    expect(sync).toHaveBeenCalledWith(
      "host.syncConversationJob",
      expect.objectContaining({ job: expect.objectContaining({ jobId: created.jobId }) }),
    );
    expect(await service.readOwnedJob(created.jobId, credential)).toEqual(before);
    sync.mockClear();
    await expect(
      service.importCanvasJob(
        created.jobId,
        { ...credential, account: { ...credential.account, id: "other" } },
        { threadId: "chosen-thread", cwd: stateDirectory(), title: "Selected folder" },
      ),
    ).rejects.toMatchObject({ code: "job_not_found" });
    expect(sync).not.toHaveBeenCalled();
    await expect(
      service.importCanvasJob(
        created.jobId,
        credential,
        { threadId: "chosen-thread", cwd: stateDirectory(), title: "Selected folder" },
        async () => {
          throw new Error("fixture lease changed");
        },
      ),
    ).rejects.toThrow("fixture lease changed");
    expect(sync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("projects conversation outputs through the trusted workspace without changing billing on a local save failure", async () => {
    const directory = stateDirectory();
    let creates = 0;
    let rejected = false;
    const sync = vi.fn(async (method: string, input?: Record<string, unknown>) => {
      if (method === "workspace.importAssetBytes")
        return { url: `moss-canvas-asset:${"a".repeat(64)}.png` };
      if (
        method === "host.syncConversationJob" &&
        (input?.job as { status?: string })?.status === "succeeded" &&
        !rejected
      ) {
        rejected = true;
        throw new Error("fixture projection failure");
      }
      return {};
    });
    const stores = vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue({
      request: sync,
      readAsset: vi.fn(),
      readKnowledgeAsset: vi.fn(),
      close: vi.fn(),
    });
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      brokerOptions: { pollMs: 0 },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/catalog")) return catalog();
        if (String(url).endsWith("/generations")) {
          creates++;
          return Response.json({ taskToken: "fixture-task" });
        }
        return Response.json({
          status: "completed",
          pending: false,
          billingStatus: "captured",
          imageUrl: "https://assets.example/result.png",
        });
      },
    });
    const workspace = { threadId: "thread-a", cwd: directory, title: "Conversation A" };
    const resolveWorkspace = vi.fn(async () => workspace);
    service.setCanvasWorkspaceResolver(resolveWorkspace);
    const created = await service.create({ ...request, projectId: "thread:thread-a" }, credential);
    resolveWorkspace.mockResolvedValue({ ...workspace, cwd: stateDirectory() });
    await vi.waitFor(() => expect(service.get(created.jobId, credential).status).toBe("succeeded"));
    const restored = await service.check(created.jobId, credential, "thread:thread-a");
    expect(restored.billingStatus).toBe("captured");
    expect(creates).toBe(1);
    expect(stores).toHaveBeenCalledWith(directory, credential, workspace);
    expect(resolveWorkspace).toHaveBeenCalledTimes(1);
    const binding = readFileSync(
      join(
        directory,
        "media-job-workspaces",
        mediaAccountScope(credential),
        `${created.jobId}.json`,
      ),
      "utf8",
    );
    expect(JSON.parse(binding).cwd).toBe(workspace.cwd);
    expect(binding).not.toContain(credential.accessToken);
    expect(binding).not.toContain(credential.gatewayBaseUrl);
    const completed = sync.mock.calls.filter(
      ([method, input]) =>
        method === "host.syncConversationJob" &&
        (input?.job as { status?: string })?.status === "succeeded",
    );
    expect(completed.length).toBeGreaterThan(1);
    expect((completed.at(-1)?.[1]?.job as { outputs: string[] }).outputs[0]).toMatch(
      /^moss-canvas-asset:/,
    );
  });
  it("records only catalog status and counts, without account or credential contents", async () => {
    const messages = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      fetchImpl: async () =>
        Response.json({
          account: credential.account,
          models: [{ id: request.modelId, label: "private-user-prompt", kind: "image" }],
        }),
    });
    const result = await service.list(credential);
    expect(result.models).toHaveLength(1);
    const observation = messages.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(observation).toContain("upstreamStatus=200");
    expect(observation).toContain("modelsCount=1");
    for (const privateValue of [
      credential.accessToken,
      credential.account.id,
      "private-user-prompt",
    ])
      expect(observation).not.toContain(privateValue);
  });

  it("retains the upstream failure status while keeping upstream error bodies out of logs", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      fetchImpl: async () =>
        Response.json({ error: { message: credential.accessToken } }, { status: 503 }),
    });
    expect((await service.list(credential)).errorCode).toBe("media_catalog_unavailable");
    const observation = warnings.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(observation).toContain("upstreamStatus=503");
    expect(observation).toContain('errorCode="media_catalog_unavailable"');
    expect(observation).not.toContain(credential.accessToken);
    expect(observation).not.toContain(credential.account.id);
  });

  it("imports legacy JSON as stable single-round conversations at revision zero", async () => {
    const directory = stateDirectory(),
      scope = mediaAccountScope(credential);
    const statePath = join(directory, "media-jobs", `${scope}.json`);
    const broker = new HoolaCanvasBridgeBroker({
      statePath,
      pollMs: 0,
      fetchImpl: async (url) =>
        String(url).endsWith("/generations")
          ? Response.json({ taskToken: "legacy-task" })
          : Response.json({
              status: "completed",
              pending: false,
              billingStatus: "captured",
              imageUrl: "https://assets.example/legacy.png",
            }),
    });
    const created = broker.create({
      ...request,
      projectId: "images-workspace",
      operation: "text_to_image",
    });
    await broker.run(created.jobId, credential);
    const legacy = JSON.parse(readFileSync(statePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    for (const job of legacy.jobs) delete job.revision;
    await writeFile(statePath, JSON.stringify(legacy));
    const noProvider = vi.fn<typeof fetch>();
    const restored = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: noProvider });
    const page = await restored.history(credential);
    expect(page.jobs[0]).toMatchObject({
      jobId: created.jobId,
      revision: 0,
      conversationId: created.conversationId,
      parentJobId: null,
      status: "succeeded",
    });
    const restarted = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: noProvider,
    });
    expect((await restarted.history(credential)).jobs).toEqual(page.jobs);
    expect((await restarted.check(created.jobId, credential)).revision).toBe(0);
    expect(noProvider).not.toHaveBeenCalled();
  });
  it("coalesces concurrent identical creates at the durable identity boundary", async () => {
    let submissions = 0;
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      brokerOptions: { pollMs: 0 },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/catalog")) return catalog();
        if (String(url).endsWith("/generations")) {
          submissions++;
          return Response.json({ taskToken: "one-task" });
        }
        return Response.json({
          status: "completed",
          pending: false,
          billingStatus: "captured",
          imageUrl: "https://assets.example/one.png",
        });
      },
    });
    const created = await Promise.all(
      Array.from({ length: 8 }, () => service.create(request, credential)),
    );
    expect(new Set(created.map((job) => job.jobId)).size).toBe(1);
    await vi.waitFor(() =>
      expect(service.get(created[0]!.jobId, credential).status).toBe("succeeded"),
    );
    expect(submissions).toBe(1);
    expect((await service.history(credential)).jobs).toHaveLength(1);
  });
  it.each([true, false])(
    "never resubmits a pre-crash queued history job (active checkpoint %s)",
    async (activeCheckpoint) => {
      const directory = stateDirectory(),
        scope = mediaAccountScope(credential);
      const history = new MossMediaHistory(directory);
      const broker = new HoolaCanvasBridgeBroker(
        activeCheckpoint ? { statePath: join(directory, "media-jobs", `${scope}.json`) } : {},
      );
      const created = broker.create({
        ...request,
        projectId: "images-workspace",
        operation: "text_to_image",
      });
      await history.save(scope, broker.durableJobs()[0]!);
      const query = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          status: "failed",
          terminal: true,
          billingStatus: "released",
          error: { code: "job_not_found" },
        }),
      );
      const service = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: query });
      expect((await service.history(credential)).jobs[0]?.jobId).toBe(created.jobId);
      expect((await service.conversation(created.conversationId!, credential)).jobs[0]?.jobId).toBe(
        created.jobId,
      );
      expect(query).not.toHaveBeenCalled();
      const checked = await service.check(created.jobId, credential);
      expect(checked).toMatchObject({
        jobId: created.jobId,
        status: "failed_terminal",
        billingStatus: "released",
      });
      expect(checked.revision).toBeGreaterThan(created.revision!);
      expect(query).toHaveBeenCalledTimes(1);
      expect(String(query.mock.calls[0]?.[0])).toMatch(/\/query$/u);
      const calls = query.mock.calls.length;
      expect((await service.create(request, credential)).jobId).toBe(created.jobId);
      expect(query.mock.calls).toHaveLength(calls);
    },
  );
  it("keeps evicted history, assets, and request identity through disk restart without another provider POST", async () => {
    const directory = stateDirectory();
    const scope = mediaAccountScope(credential);
    const history = new MossMediaHistory(directory);
    const assets = new MossMediaAssetStore(directory);
    let submissions = 0;
    const broker = new HoolaCanvasBridgeBroker({
      statePath: join(directory, "media-jobs", `${scope}.json`),
      pollMs: 0,
      persistHistory: (job) => history.save(scope, job),
      cacheOutputs: (id, urls, kind) => assets.cache(scope, id, urls, kind),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/generations")) {
          submissions++;
          return Response.json({ taskToken: `task-${submissions}` });
        }
        return Response.json({
          status: "completed",
          pending: false,
          billingStatus: "captured",
          imageUrl: "https://assets.example/kept.png",
        });
      },
    });
    const input = { ...request, projectId: "images-workspace", operation: "text_to_image" };
    const first = broker.create(input);
    await broker.run(first.jobId, credential);
    for (let index = 1; index <= 256; index++) {
      const created = broker.create({ ...input, idempotencyKey: `later-${index}` });
      await broker.run(created.jobId, credential);
    }
    expect(broker.list()).toHaveLength(256);
    expect(broker.get(first.jobId)).toBeNull();
    expect(submissions).toBe(257);
    const unexpected = vi.fn<typeof fetch>();
    const restored = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: unexpected });
    expect(await restored.create(request, credential)).toMatchObject({
      jobId: first.jobId,
      status: "succeeded",
    });
    await expect(
      restored.create({ ...request, prompt: "changed" }, credential),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await restored.readAsset(first.jobId, 0, credential)).bytes).toHaveLength(9);
    const seen = new Set<string>();
    let page = await restored.history(credential, { kind: "image", limit: 50 });
    for (;;) {
      page.jobs.forEach((job) => seen.add(job.jobId));
      if (!page.nextCursor) break;
      page = await restored.history(credential, {
        kind: "image",
        limit: 50,
        cursor: page.nextCursor,
      });
    }
    expect(seen.size).toBe(257);
    expect(seen.has(first.jobId)).toBe(true);
    expect((await restored.conversation(first.conversationId!, credential)).jobs[0]?.jobId).toBe(
      first.jobId,
    );
    expect(unexpected).not.toHaveBeenCalled();
    await assets.collectUnreferenced(
      scope,
      () => new Set(),
      (id) => history.hasAsset(scope, id),
    );
    expect((await restored.readAsset(first.jobId, 0, credential)).bytes).toHaveLength(9);
    for (const foreign of [
      { ...credential, account: { ...credential.account, id: "foreign" } },
      {
        ...credential,
        realm: "supabase-google" as const,
        account: { ...credential.account, realm: "supabase-google" as const },
      },
      { ...credential, gatewayBaseUrl: "https://other.example/v1" },
    ]) {
      expect((await restored.history(foreign)).jobs).toEqual([]);
      await expect(restored.check(first.jobId, foreign)).rejects.toMatchObject({
        code: "job_not_found",
      });
      await expect(restored.readAsset(first.jobId, 0, foreign)).rejects.toMatchObject({
        code: "job_not_found",
        status: 404,
      });
    }
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("fails closed before generation when the durable database is unavailable and retains committed output", async () => {
    const directory = stateDirectory();
    const history = new MossMediaHistory(directory);
    await history.page(mediaAccountScope(credential));
    const file = join(directory, "media-history", "history.sqlite");
    await rename(file, `${file}.saved`);
    await mkdir(file);
    const upstream = vi.fn<typeof fetch>();
    const service = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: upstream });
    await expect(service.create(request, credential)).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
    expect((await service.history(credential)).jobs).toEqual([]);
  });

  it("preserves an unindexed cached output if only the durable pending job survived a crash", async () => {
    const directory = stateDirectory(),
      scope = mediaAccountScope(credential);
    const history = new MossMediaHistory(directory),
      assets = new MossMediaAssetStore(directory);
    const broker = new HoolaCanvasBridgeBroker();
    const created = broker.create({
      ...request,
      projectId: "images-workspace",
      operation: "text_to_image",
    });
    await history.save(scope, broker.durableJobs()[0]!);
    const cached = await assets.cache(
      scope,
      created.jobId,
      ["https://assets.example/inflight.png"],
      "image",
    );
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (url) =>
        String(url).endsWith("/catalog")
          ? catalog()
          : Response.json({ error: { code: "fixture_rejected" } }, { status: 400 }),
    });
    const next = await service.create(
      { ...request, idempotencyKey: "another-request" },
      credential,
    );
    await vi.waitFor(() =>
      expect(service.get(next.jobId, credential).status).toBe("failed_terminal"),
    );
    expect(await assets.read(scope, cached[0]!)).toHaveLength(9);
    expect(
      (await service.history(credential)).jobs.some((item) => item.jobId === created.jobId),
    ).toBe(true);
    // The history checkpoint strips upload bytes but retains the original digest.
    const disk = await history.get(scope, created.jobId);
    expect(disk?.checkpoint.input.referenceImages).toEqual([]);
  });
  it("exposes only explicit editing capabilities and refuses unavailable edits before generation", async () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=";
    let enabled = false;
    const generations = vi.fn();
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/catalog"))
          return Response.json({
            models: [
              {
                id: request.modelId,
                label: "GPT",
                kind: "image",
                available: true,
                supportsReferences: true,
                supportsMaskEdits: enabled,
                supportsTransparentBackground: enabled,
              },
            ],
          });
        generations();
        return Response.json({ error: { code: "fixture_rejected" } }, { status: 400 });
      },
    });
    const masked = { ...request, referenceImages: [png], maskImage: png };
    expect((await service.list(credential)).models[0]).toMatchObject({
      supportsMaskEdits: false,
      supportsTransparentBackground: false,
    });
    await expect(service.create(masked, credential)).rejects.toMatchObject({
      code: "mask_edits_not_supported",
    });
    await expect(
      service.create({ ...request, background: "transparent" }, credential),
    ).rejects.toMatchObject({ code: "transparent_background_not_supported" });
    expect(generations).not.toHaveBeenCalled();
    enabled = true;
    expect((await service.list(credential)).models[0]).toMatchObject({
      supportsMaskEdits: true,
      supportsTransparentBackground: true,
    });
    await expect(
      service.create({ ...masked, referenceImages: [] }, credential),
    ).rejects.toMatchObject({ code: "invalid_mask_image" });
    expect(generations).not.toHaveBeenCalled();
    const created = await service.create(masked, credential);
    await vi.waitFor(() =>
      expect(service.get(created.jobId, credential).status).toBe("failed_terminal"),
    );
    expect(generations).toHaveBeenCalledTimes(1);
  });
  it("preserves exact media money and its FX snapshot across gateway, persistence, and restart", async () => {
    const directory = stateDirectory();
    const mediaWallet = {
      walletKind: "media_cost_v1",
      currency: "CNY",
      pointsPerCny: 100,
      availableNanoCny: "9007199254740993",
      heldNanoCny: "401670000",
      reviewRequired: true,
    };
    const billing = {
      walletKind: "media_cost_v1",
      creditsCharged: 0,
      creditsReserved: 0,
      currency: "USD",
      reservedNanoCny: "401670000",
      chargedNanoCny: "66945000",
      availableNanoCny: "9007199254740993",
      heldNanoCny: "0",
      actualCostNano: 10_000_000,
      fxVersion: "frankfurter-v2:USD:CNY:2026-10-10:13389-2000",
      fxNumerator: "13389",
      fxDenominator: "2000",
      fxAsof: "2026-10-10",
      fxSource: "https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY&expand=providers",
    };
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/catalog"))
          return Response.json({
            ...((await catalog().json()) as Record<string, unknown>),
            account: credential.account,
            mediaWallet,
          });
        if (String(input).endsWith("/generations"))
          return Response.json({ taskToken: "cost-task" });
        return Response.json({
          status: "completed",
          pending: false,
          billingStatus: "captured",
          imageUrl: "https://assets.example/cost.png",
          ...billing,
        });
      },
    });
    expect(await service.list(credential)).toMatchObject({ mediaWallet });
    const created = await service.create(request, credential);
    await vi.waitFor(() => expect(service.get(created.jobId, credential).status).toBe("succeeded"));
    expect(service.get(created.jobId, credential)).toMatchObject({
      billingStatus: "captured",
      billing,
    });
    const unexpectedFetch = vi.fn<typeof fetch>();
    const restored = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: unexpectedFetch,
    });
    expect(await restored.check(created.jobId, credential)).toMatchObject({
      billingStatus: "captured",
      billing,
    });
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong owner",
      { ...credential.account, id: "someone-else" },
      "9007199254740993",
      "media_catalog_account_mismatch",
    ],
    ["unbound account", undefined, "9007199254740993", "media_catalog_invalid"],
    ["lossy number", credential.account, 9007199254740992, "media_catalog_invalid"],
    ["overflow", credential.account, "9223372036854775808", "media_catalog_invalid"],
  ])(
    "does not expose a media wallet with %s",
    async (_case, account, availableNanoCny, errorCode) => {
      const service = new MossMediaJobsService({
        stateDirectory: stateDirectory(),
        fetchImpl: async () =>
          Response.json({
            ...((await catalog().json()) as Record<string, unknown>),
            account,
            mediaWallet: {
              walletKind: "media_cost_v1",
              currency: "CNY",
              pointsPerCny: 100,
              availableNanoCny,
              heldNanoCny: "0",
            },
          }),
      });
      const result = await service.list(credential);
      expect(result).toMatchObject({ errorCode, models: [] });
      expect(result).not.toHaveProperty("mediaWallet");
    },
  );

  it("recovers a completed job's late bill once after restart without resubmitting or replacing assets", async () => {
    const directory = stateDirectory();
    let submissions = 0;
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/catalog")) return catalog();
        if (String(input).endsWith("/generations")) {
          submissions += 1;
          return Response.json({ taskToken: "original-task-token", billingStatus: "pending" });
        }
        return Response.json({
          status: "completed",
          pending: false,
          billingStatus: "unknown",
          imageUrl: "https://assets.example/finished.png",
        });
      },
    });
    const created = await service.create(request, credential);
    await vi.waitFor(() => expect(service.get(created.jobId, credential).status).toBe("succeeded"));
    const before = service.get(created.jobId, credential);
    const downloads = vi.mocked(outboundHttp.request).mock.calls.length;
    let finish!: (response: Response) => void;
    const query = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/media/query");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        taskToken: "original-task-token",
        operationId: expect.stringMatching(/^hoola-canvas:/u),
      });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const restored = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: query });
    await expect(
      restored.check(created.jobId, {
        ...credential,
        account: { ...credential.account, id: "other" },
      }),
    ).rejects.toThrow("job_not_found");
    await expect(restored.check(created.jobId, credential, "thread:other")).rejects.toThrow(
      "job_not_found",
    );
    expect(query).not.toHaveBeenCalled();
    const checks = [
      restored.check(created.jobId, credential),
      restored.check(created.jobId, credential),
    ];
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(restored.get(created.jobId, credential).status).toBe("succeeded");
    finish(
      Response.json({
        status: "completed",
        pending: false,
        billingStatus: "captured",
        creditsCharged: 3,
        creditsReserved: 10,
        actualCostNano: 30_000_000,
        currency: "USD",
      }),
    );
    const results = await Promise.all(checks);
    for (const result of results)
      expect(result).toMatchObject({
        status: "succeeded",
        billingStatus: "captured",
        billing: { creditsCharged: 3 },
        assets: before.assets,
        imageUrls: before.imageUrls,
      });
    await restored.check(created.jobId, credential);
    expect(query).toHaveBeenCalledTimes(1);
    expect(submissions).toBe(1);
    expect(vi.mocked(outboundHttp.request).mock.calls.length).toBe(downloads);
    const persisted = new MossMediaJobsService({ stateDirectory: directory, fetchImpl: query });
    expect((await persisted.check(created.jobId, credential)).billingStatus).toBe("captured");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "failed", "missing"])(
    "preserves completed output and hold after a %s bill check",
    async (failure) => {
      let checking = false;
      const service = new MossMediaJobsService({
        stateDirectory: stateDirectory(),
        fetchImpl: async (input) => {
          if (String(input).endsWith("/catalog")) return catalog();
          if (String(input).endsWith("/generations"))
            return Response.json({ taskToken: "same-task-token" });
          if (checking && failure === "transport") throw new Error("network offline");
          if (checking && failure === "failed")
            return Response.json({ status: "failed", pending: false, billingStatus: "released" });
          return Response.json({
            status: "completed",
            pending: false,
            billingStatus: "unknown",
            imageUrl: "https://assets.example/finished.png",
          });
        },
      });
      const created = await service.create(request, credential);
      await vi.waitFor(() =>
        expect(service.get(created.jobId, credential).status).toBe("succeeded"),
      );
      const before = service.get(created.jobId, credential);
      checking = true;
      if (failure === "missing")
        expect((await service.check(created.jobId, credential)).billingStatus).toBe("unknown");
      else await expect(service.check(created.jobId, credential)).rejects.toThrow();
      expect(service.get(created.jobId, credential)).toMatchObject({
        status: "succeeded",
        billingStatus: "unknown",
        imageUrls: before.imageUrls,
        assets: before.assets,
      });
    },
  );

  it("checks the server-bound project before resuming a task for a native caller", async () => {
    const directory = stateDirectory();
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/catalog")) return catalog();
        throw new Error("lost submission reply");
      },
    });
    const created = await service.create(
      { ...request, projectId: "thread:owner-thread" },
      credential,
    );
    await vi.waitFor(async () =>
      expect((await service.list(credential)).jobs[0]?.status).toBe("reconciliation_required"),
    );
    const resumedFetch = vi.fn(async () =>
      Response.json({ error: { code: "recovery_unavailable" } }, { status: 409 }),
    );
    const restarted = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: resumedFetch,
    });
    expect(() => restarted.get(created.jobId, credential, "thread:other-thread")).toThrow(
      "job_not_found",
    );
    expect(resumedFetch).not.toHaveBeenCalled();
    expect(restarted.get(created.jobId, credential, "thread:owner-thread").projectId).toBe(
      "thread:owner-thread",
    );
    await vi.waitFor(() => expect(resumedFetch).toHaveBeenCalledOnce());
  });

  it("submits installed GPT Image 2.5 variants from the authoritative catalog", async () => {
    for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      let submittedModel: unknown;
      const current = { ...credential, installedModelIds: [modelId] };
      const service = new MossMediaJobsService({
        stateDirectory: stateDirectory(),
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/catalog"))
            return Response.json({
              models: [
                {
                  id: modelId,
                  label: "GPT Image 2.5",
                  kind: "image",
                  available: true,
                  supportsReferenceImages: true,
                },
              ],
            });
          if (String(url).endsWith("/generations")) {
            submittedModel = JSON.parse(String(init?.body)).modelId;
            return Response.json({ taskToken: "gpt25-task" }, { status: 202 });
          }
          return Response.json({
            pending: false,
            imageUrl: "https://assets.example/gpt25.png",
            billingStatus: "captured",
          });
        },
      });
      const created = await service.create({ ...request, modelId }, current);
      await vi.waitFor(() => expect(service.get(created.jobId, current).status).toBe("succeeded"));
      expect(submittedModel).toBe(modelId);
    }
  });
  it("retains every output and partitions history by user, realm, and gateway", async () => {
    let submissions = 0;
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      brokerOptions: { pollMs: 0 },
      fetchImpl: async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${credential.accessToken}`,
        );
        if (String(input).endsWith("/catalog"))
          return Response.json({
            models: [{ id: request.modelId, label: "GPT Image", kind: "image", available: true }],
            account: { ...credential.account, creditBalance: 813 },
          });
        if (String(input).endsWith("/generations")) {
          submissions += 1;
          return Response.json(
            { taskToken: "secret-task-token", billingStatus: "pending" },
            { status: 202 },
          );
        }
        return Response.json({
          pending: false,
          status: "completed",
          billingStatus: "captured",
          creditsReserved: 12,
          creditsCharged: 5,
          actualCostNano: 45_000_000,
          currency: "USD",
          nanoPerCredit: 10_000_000,
          roundingNano: 5_000_000,
          priceVersion: "verified-v1",
          imageUrls: ["https://assets.example/one.png", "https://assets.example/two.png"],
          imageUrl: "https://assets.example/one.png",
        });
      },
    });
    const job = await service.create(request, credential);
    await vi.waitFor(() => expect(service.get(job.jobId, credential).status).toBe("succeeded"));
    const completed = service.get(job.jobId, credential);
    expect(completed.imageUrls).toEqual([
      "https://assets.example/one.png",
      "https://assets.example/two.png",
    ]);
    expect(completed.billingStatus).toBe("captured");
    expect(completed.persistenceStatus).toBe("ready");
    expect(completed.assets).toHaveLength(2);
    const restarted = new MossMediaJobsService({ stateDirectory: service.options.stateDirectory });
    expect((await restarted.readAsset(job.jobId, 0, credential)).bytes.byteLength).toBe(9);
    await expect(
      restarted.readAsset(job.jobId, 0, {
        ...credential,
        account: { ...credential.account, id: "another-user" },
      }),
    ).rejects.toMatchObject({ code: "job_not_found", status: 404 });
    expect(completed.billing).toEqual({
      creditsReserved: 12,
      creditsCharged: 5,
      actualCostNano: 45_000_000,
      currency: "USD",
      nanoPerCredit: 10_000_000,
      roundingNano: 5_000_000,
      priceVersion: "verified-v1",
    });
    expect((await service.list(credential)).account).toMatchObject({ creditBalance: 813 });
    expect(completed.createdAt).toMatch(/^\d{4}-/u);
    const replay = await service.create(request, credential);
    expect(replay.jobId).toBe(job.jobId);
    expect(submissions).toBe(1);
    for (const other of [
      { ...credential, account: { ...credential.account, id: "account-b" } },
      { ...credential, gatewayBaseUrl: "https://other.example/v1" },
      {
        ...credential,
        realm: "supabase-google" as const,
        account: { ...credential.account, realm: "supabase-google" as const },
      },
    ]) {
      expect(() => service.get(job.jobId, other)).toThrow("job_not_found");
      expect((await service.list(other)).jobs).toEqual([]);
    }
    const serialized = JSON.stringify(await service.list(credential));
    expect(serialized).not.toContain(credential.accessToken);
    expect(serialized).not.toContain("secret-task-token");
  });

  it("never resubmits an uncertain creation, including after restart", async () => {
    const directory = stateDirectory();
    let submissions = 0;
    const fetchImpl = async (input: string | URL | Request) => {
      if (String(input).endsWith("/catalog")) return catalog();
      if (String(input).endsWith("/media/query"))
        return Response.json({ error: { code: "recovery_unavailable" } }, { status: 409 });
      submissions += 1;
      throw new Error("network disconnected after provider accepted");
    };
    const service = new MossMediaJobsService({ stateDirectory: directory, fetchImpl });
    const created = await service.create(request, credential);
    await vi.waitFor(async () =>
      expect((await service.list(credential)).jobs[0]?.status).toBe("reconciliation_required"),
    );
    expect((await service.list(credential)).jobs[0]?.billingStatus).toBe("unknown");
    const restored = new MossMediaJobsService({ stateDirectory: directory, fetchImpl });
    expect((await restored.create(request, credential)).jobId).toBe(created.jobId);
    await vi.waitFor(async () =>
      expect((await restored.list(credential)).jobs[0]?.status).toBe("reconciliation_required"),
    );
    expect(submissions).toBe(1);
    const file = readdirSync(join(directory, "media-jobs"))[0]!;
    expect(readFileSync(join(directory, "media-jobs", file), "utf8")).not.toContain(
      credential.accessToken,
    );
  });

  it("recovers a lost creation reply from the account ledger without resubmitting", async () => {
    const directory = stateDirectory();
    let submissions = 0;
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/catalog")) return catalog();
        submissions += 1;
        throw new Error("lost 202 reply after gateway committed task");
      },
    });
    const created = await service.create(request, credential);
    await vi.waitFor(async () =>
      expect((await service.list(credential)).jobs[0]?.status).toBe("reconciliation_required"),
    );
    const restored = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input, init) => {
        expect(String(input)).toContain("/media/query");
        const query = JSON.parse(String(init?.body));
        expect(query.operationId).toMatch(/^hoola-canvas:/u);
        expect(query.taskToken).toBeUndefined();
        return Response.json({
          taskToken: "refreshed-private-token",
          pending: false,
          imageUrls: ["https://assets.example/recovered.png"],
          billingStatus: "captured",
        });
      },
    });
    restored.get(created.jobId, credential);
    await vi.waitFor(async () => {
      // list's catalog fetch is deliberately absent in this recovery fixture.
      expect(restored.get(created.jobId, credential).status).toBe("succeeded");
    });
    expect(submissions).toBe(1);
    const file = readdirSync(join(directory, "media-jobs"))[0]!;
    expect(readFileSync(join(directory, "media-jobs", file), "utf8")).toContain(
      "refreshed-private-token",
    );
  });

  it("resumes a known task after a query outage without another chargeable submit", async () => {
    const directory = stateDirectory();
    let submissions = 0;
    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/catalog")) return catalog();
        if (String(input).endsWith("/generations")) {
          submissions += 1;
          return Response.json(
            { taskToken: "known-task", billingStatus: "pending" },
            { status: 202 },
          );
        }
        throw new Error("query connection lost");
      },
    });
    const created = await service.create(request, credential);
    await vi.waitFor(async () =>
      expect((await service.list(credential)).jobs[0]?.status).toBe("reconciliation_required"),
    );
    const restored = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: async (input) => {
        expect(String(input)).toContain("/media/query");
        return Response.json({
          pending: false,
          status: "completed",
          billingStatus: "captured",
          imageUrl: "https://assets.example/recovered.png",
        });
      },
    });
    restored.get(created.jobId, credential);
    await vi.waitFor(() =>
      expect(restored.get(created.jobId, credential).status).toBe("succeeded"),
    );
    expect(submissions).toBe(1);
  });

  it("rejects uninstalled skills, unavailable pricing, and changed idempotent payloads", async () => {
    const service = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      fetchImpl: async (input) =>
        String(input).endsWith("/catalog")
          ? catalog()
          : Response.json(
              { error: { code: "insufficient_credits" }, billingStatus: "released" },
              { status: 402 },
            ),
    });
    await expect(service.create(request, { ...credential, installedModelIds: [] })).rejects.toThrow(
      "media_skill_not_installed",
    );
    const job = await service.create(request, credential);
    await vi.waitFor(() =>
      expect(service.get(job.jobId, credential).status).toBe("failed_terminal"),
    );
    expect(service.get(job.jobId, credential).billingStatus).toBe("released");
    await expect(service.create({ ...request, prompt: "Changed" }, credential)).rejects.toThrow(
      "idempotency_conflict",
    );
    const unavailable = new MossMediaJobsService({
      stateDirectory: stateDirectory(),
      fetchImpl: async () =>
        Response.json({
          models: [
            {
              id: request.modelId,
              label: "GPT Image",
              kind: "image",
              available: false,
              unavailableReason: "pricing_unavailable",
            },
          ],
        }),
    });
    await expect(unavailable.create(request, credential)).rejects.toThrow("pricing_unavailable");
  });
});
