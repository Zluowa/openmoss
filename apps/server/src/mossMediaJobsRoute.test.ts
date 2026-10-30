import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ServiceMap } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { outboundHttp } from "@synara/shared/outboundHttp";
import { MossMediaAssetStore } from "./mossMediaAssets";
import * as canvasStorage from "./mossCanvasStorage";
import * as canvasWorkspace from "./mossCanvasWorkspace";
import * as mediaPromotion from "./mossCanvasMediaPromotion";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPayService } from "./account/Services/MossPayService";
import { AuthError, ServerAuth, type AuthRequest } from "./auth/Services/ServerAuth";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";

vi.mock("./config", async () => {
  const { ServiceMap } = await import("effect");
  return { ServerConfig: ServiceMap.Service("media-route-test/ServerConfig") };
});
vi.mock("@synara/shared/providerInstances", () => ({
  codexAccountInstanceId: (id: string) => `codex_${id}`,
}));

import { ServerConfig } from "./config";
import { mossMediaJobsEffectRouteLayer } from "./mossMediaJobsRoute";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const gateway = "https://gateway.example/functions/v1/moss-model-gateway/v1";
const modelId = "gpt-image-2.5-flare";
const body = { modelId, prompt: "A blue sailboat", idempotencyKey: "route-operation" };

function harness(
  options: {
    cookie?: boolean;
    installed?: boolean;
    catalogGate?: () => Promise<void>;
    quotaGate?: () => Promise<void>;
    sessionGate?: (read: number) => Promise<void>;
    authorityUnavailable?: boolean;
    desktopToken?: boolean;
    remote?: boolean;
    role?: "owner" | "client";
    query?: () => Promise<Response>;
    submit?: () => Promise<Response>;
    textCatalogGate?: () => Promise<void>;
    textSubmit?: () => Promise<Response>;
  } = {},
) {
  const state = {
    accountId: "account-a",
    submissions: 0,
    textSubmissions: 0,
    accountReads: 0,
    quotaReads: 0,
    authorityReads: 0,
    pluginDiscoveryFailed: false,
    nativePluginDiscoveryFailed: false,
  };
  const directory = mkdtempSync(join(tmpdir(), "moss-media-route-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      await options.textCatalogGate?.();
      return Response.json({ data: [{ id: "deepseek-v4-pro" }] });
    }
    if (url.endsWith("/v1/chat/completions")) {
      state.textSubmissions += 1;
      return options.textSubmit
        ? options.textSubmit()
        : Response.json({
            choices: [{ message: { content: "A canvas paragraph" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
    }
    if (url.endsWith("/catalog")) {
      await options.catalogGate?.();
      return Response.json({
        models: [
          {
            id: modelId,
            label: "GPT Image",
            kind: "image",
            available: true,
            supportsReferences: true,
          },
        ],
      });
    }
    if (url.endsWith("/generations")) {
      state.submissions += 1;
      if (options.submit) return options.submit();
      return Response.json(
        { taskToken: "private-task-token", billingStatus: "pending" },
        { status: 202 },
      );
    }
    if (options.query) return options.query();
    return Response.json({
      pending: false,
      imageUrls: ["https://assets.example/one.png", "https://assets.example/two.png"],
      billingStatus: "captured",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(outboundHttp, "request").mockImplementation(async (request) => ({
    status: 200,
    body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    headers: new Headers({ "content-type": "image/png" }),
    url: String(request.url),
  }));
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, {
      stateDir: directory,
      host: options.remote ? "0.0.0.0" : "127.0.0.1",
      authToken: "desktop-startup-secret",
    } as ServiceMap.Service.Shape<typeof ServerConfig>),
    Layer.succeed(ServerAuth, {
      authenticateHttpRequest: (request: AuthRequest) =>
        request.headers.authorization === "Bearer native-session"
          ? Effect.succeed({
              sessionId: "session",
              subject: "desktop",
              method: "bootstrap",
              role: options.role ?? "owner",
              credentialSource: options.cookie ? "cookie" : "bearer",
            })
          : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 })),
    } as unknown as ServiceMap.Service.Shape<typeof ServerAuth>),
    Layer.succeed(MossPhoneAccountService, {
      getLocalAuthority: () =>
        Effect.gen(function* () {
          const read = ++state.accountReads;
          if (options.sessionGate) yield* Effect.promise(() => options.sessionGate!(read));
          return {
            activeRealm: "cn",
            identity: {
              realm: "memfire-phone",
              gatewayBaseUrl: gateway,
              account: { id: state.accountId, realm: "memfire-phone" },
            },
          };
        }),
      getSession: () =>
        Effect.gen(function* () {
          const read = ++state.accountReads;
          if (options.sessionGate) yield* Effect.promise(() => options.sessionGate!(read));
          return {
            authenticated: true,
            activeRealm: "cn",
            session: { user: { id: state.accountId } },
          };
        }),
      getAuthorityCredential: () =>
        Effect.suspend(() => {
          state.authorityReads += 1;
          if (options.authorityUnavailable)
            return Effect.fail(new Error("Authentication service unavailable"));
          return Effect.succeed({
            realm: "memfire-phone",
            gatewayBaseUrl: gateway,
            issuer: "https://auth.example",
            realtimeRelayUrl: "wss://relay.example",
            accessToken: `header.${Buffer.from(JSON.stringify({ sub: state.accountId })).toString("base64url")}.signature`,
          });
        }),
    } as unknown as ServiceMap.Service.Shape<typeof MossPhoneAccountService>),
    Layer.succeed(MossEnterpriseKeyAccount, {
      getActiveAuthorityCredential: () => Effect.succeed(null),
    } as unknown as ServiceMap.Service.Shape<typeof MossEnterpriseKeyAccount>),
    Layer.succeed(MossCloudAccountService, {
      getState: () => Effect.succeed({ authenticated: false, account: null }),
      getLocalAuthority: () => Effect.succeed({ identity: null }),
    } as unknown as ServiceMap.Service.Shape<typeof MossCloudAccountService>),
    Layer.succeed(MossPayService, {
      getQuota: () =>
        Effect.tryPromise({
          try: () => {
            state.quotaReads += 1;
            return options.quotaGate?.() ?? Promise.resolve();
          },
          catch: (error) => error,
        }).pipe(
          Effect.map(() => ({
            planCode: "plus",
            creditBalance: 1000000,
            periodEnd: null,
          })),
        ),
    } as unknown as ServiceMap.Service.Shape<typeof MossPayService>),
    Layer.succeed(ProviderDiscoveryService, {
      listPlugins: () =>
        state.pluginDiscoveryFailed
          ? Effect.fail(new Error("Private process observer failure"))
          : state.nativePluginDiscoveryFailed
            ? Effect.succeed({
                marketplaces: [],
                marketplaceLoadErrors: [
                  {
                    marketplacePath: "codex-native",
                    message: "Private runtime timeout diagnostic",
                  },
                ],
                source: "error",
              })
            : Effect.succeed({
                marketplaces: [
                  {
                    name: "moss-bundled",
                    plugins: [
                      {
                        id: "moss-imagegen@moss-bundled",
                        installed: options.installed !== false,
                        enabled: true,
                        availability: "AVAILABLE",
                      },
                    ],
                  },
                ],
              }),
    } as unknown as ServiceMap.Service.Shape<typeof ProviderDiscoveryService>),
  );
  const server = HttpRouter.toWebHandler(
    mossMediaJobsEffectRouteLayer.pipe(HttpRouter.provideRequest(services)),
    { disableLogger: true },
  );
  cleanups.push(server.dispose);
  const request = (path = "", init: RequestInit = {}) =>
    server.handler(
      new Request(
        `http://127.0.0.1:3773${path.startsWith("/api/") ? path : `/api/moss/media/jobs${path}`}`,
        {
          ...init,
          headers: {
            host: "127.0.0.1:3773",
            ...(options.desktopToken ? {} : { authorization: "Bearer native-session" }),
            ...init.headers,
          },
        },
      ),
    );
  const create = (headers?: Record<string, string>) =>
    request("", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { state, fetchMock, request, create };
}

describe("Moss media HTTP route", () => {
  it("binds owned media promotion to the selected workspace before reading its assets", async () => {
    const app = harness();
    const workspace = {
      threadId: "upload-thread",
      cwd: app.state.accountId,
      title: "Selected folder",
    };
    vi.spyOn(canvasWorkspace, "resolveMossCanvasWorkspace").mockReturnValue(
      Effect.succeed(workspace),
    );
    const readAsset = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "video/mp4",
    }));
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue({
      request: vi.fn(),
      readAsset,
      readKnowledgeAsset: vi.fn(),
      close: vi.fn(),
    });
    const promote = vi
      .spyOn(mediaPromotion, "promoteMossCanvasOwnedMediaAsset")
      .mockImplementation(async (input, _credential, scope, reader) => {
        expect(scope.threadId).toBe(workspace.threadId);
        await reader(input.assetName as string);
        return Response.json({ status: "ready", url: "https://storage.example/reference.mp4" });
      });
    const body = {
      assetName: `${"a".repeat(64)}.mp4`,
      modelId: "MiniMax-H3",
      projectId: "project-a",
      pageId: "page-a",
      idempotencyKey: "upload-once",
      expectedAccount: { id: "account-a", realm: "memfire-phone" },
      expectedWorkspace: { threadId: workspace.threadId, fingerprint: "stale" },
    };
    const send = (value: typeof body) =>
      app.request("/api/moss/media/canvas/assets/promote?canvasThread=upload-thread", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect((await send(body)).status).toBe(409);
    expect(promote).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
    const response = await send({
      ...body,
      expectedWorkspace: {
        ...body.expectedWorkspace,
        fingerprint: canvasWorkspace.mossCanvasWorkspaceFingerprint(workspace),
      },
    });
    expect(response.status).toBe(200);
    expect(promote).toHaveBeenCalledOnce();
    expect(readAsset).toHaveBeenCalledExactlyOnceWith(body.assetName);
    expect(app.state.submissions).toBe(0);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("uses one revalidated Canvas identity snapshot without an unchecked metadata read", async () => {
    let app: ReturnType<typeof harness>;
    app = harness({
      sessionGate: async (read) => {
        if (read === 3) app.state.accountId = "account-b";
      },
    });
    const response = await app.request("/api/moss/media/canvas/account");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authenticated: true, user: { id: "account-a" } });
    expect(app.state.accountReads).toBe(2);
    expect(app.state.accountId).toBe("account-a");
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an account switch during the final Canvas identity check", async () => {
    let app: ReturnType<typeof harness>;
    app = harness({
      sessionGate: async (read) => {
        if (read === 2) app.state.accountId = "account-b";
      },
    });
    const response = await app.request("/api/moss/media/canvas/account");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { generationMode: "all-reference", subjectReferenceImages: ["https://assets.example/ref.png"] },
    { metadata: { source_video: "https://assets.example/source.mp4" } },
    { referenceImages: "https://assets.example/ref.png" },
  ])("returns 400 for unsupported video input before any gateway traffic: %j", async (options) => {
    const app = harness();
    const response = await app.request("", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3773" },
      body: JSON.stringify({ ...body, modelId: "wan3.0-video", ...options }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
    expect(app.state.submissions).toBe(0);
  });

  it("rejects a foreign expected account or absent image on Canvas import without supplier traffic", async () => {
    const app = harness();
    const workspace = {
      threadId: "thread-folder",
      cwd: mkdtempSync(join(tmpdir(), "moss-import-folder-")),
      title: "Selected folder",
    };
    cleanups.push(() => rmSync(workspace.cwd, { recursive: true, force: true }));
    vi.spyOn(canvasWorkspace, "resolveMossCanvasWorkspace").mockReturnValue(
      Effect.succeed(workspace),
    );
    const input = {
      jobId: "moss_absent",
      expectedWorkspace: {
        threadId: workspace.threadId,
        fingerprint: canvasWorkspace.mossCanvasWorkspaceFingerprint(workspace),
      },
      expectedAccount: { id: "foreign", realm: "memfire-phone" },
    };
    const send = (body: unknown) =>
      app.request("/api/moss/media/canvas/import-job?canvasThread=thread-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await send(input)).status).toBe(409);
    expect(
      (await send({ ...input, expectedAccount: { id: "account-a", realm: "memfire-phone" } }))
        .status,
    ).toBe(404);
    expect(app.state.submissions).toBe(0);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });
  const textBody = {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "One paragraph" }],
    max_tokens: 128,
    stream: false,
    operationId: "text-route-operation-1234",
    expectedAccount: { id: "account-a", realm: "memfire-phone" },
  };
  const textRequest = (value: ReturnType<typeof harness>, input = textBody) =>
    value.request("/api/moss/media/canvas/text/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

  it("uses the current account text gateway once", async () => {
    const value = harness();
    const response = await textRequest(value);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "A canvas paragraph" } }],
    });
    expect(value.state.textSubmissions).toBe(1);
  });

  it("rejects text generation from a paired client and from a previous account", async () => {
    const client = harness({ role: "client" });
    expect((await textRequest(client)).status).toBe(403);
    expect(client.state.textSubmissions).toBe(0);
    const value = harness();
    value.state.accountId = "account-b";
    expect((await textRequest(value)).status).toBe(409);
    expect(value.state.textSubmissions).toBe(0);
  });

  it("does not dispatch after the account switches during text model discovery", async () => {
    let value: ReturnType<typeof harness>;
    value = harness({
      textCatalogGate: async () => {
        value.state.accountId = "account-b";
      },
    });
    expect((await textRequest(value)).status).toBe(409);
    expect(value.state.textSubmissions).toBe(0);
  });

  it("withholds the old account result without another paid dispatch after a switch", async () => {
    let value: ReturnType<typeof harness>;
    value = harness({
      textSubmit: async () => {
        value.state.accountId = "account-b";
        return Response.json({ choices: [{ message: { content: "Old account output" } }] });
      },
    });
    const response = await textRequest(value);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("Old account output");
    expect(value.state.textSubmissions).toBe(1);
  });

  const canvasStore = () => ({
    request: vi.fn(async (_method: string, _input?: Record<string, unknown>) => ({ saved: true })),
    readAsset: vi.fn(async () => ({
      bytes: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    })),
    readKnowledgeAsset: vi.fn(async () => ({
      bytes: new TextEncoder().encode("My note"),
      contentType: "text/plain",
    })),
    close: vi.fn(),
  });
  const storageBody = (method = "workspace.writeCanvasSnapshot") =>
    JSON.stringify({
      method,
      input: { snapshot: { document: { store: {}, schema: {} }, session: {} } },
      expectedAccount: { id: "account-a", realm: "memfire-phone" },
    });

  it("accepts the hosted Canvas in-memory startup bearer without placing it in URLs", async () => {
    const app = harness({ desktopToken: true });
    const headers = {
      authorization: "Bearer desktop-startup-secret",
      origin: "http://127.0.0.1:3773",
    };
    const account = await app.request("/api/moss/media/canvas/account", { headers });
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ authenticated: true });
    const store = canvasStore();
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue(store);
    const saved = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: storageBody(),
    });
    expect(saved.status).toBe(200);
    expect(store.request).toHaveBeenCalledOnce();
    expect(app.state.submissions).toBe(0);
  });

  it("keeps the startup bearer local and rejects untrusted browser origins", async () => {
    const remote = harness({ desktopToken: true, remote: true });
    expect(
      (await remote.request("", { headers: { authorization: "Bearer desktop-startup-secret" } }))
        .status,
    ).toBe(401);
    const local = harness({ desktopToken: true });
    expect(
      (await local.request("", { headers: { authorization: "Bearer incorrect-startup-secret" } }))
        .status,
    ).toBe(401);
    expect(
      (
        await local.request("", {
          headers: {
            authorization: "Bearer desktop-startup-secret",
            origin: "https://untrusted.example",
          },
        })
      ).status,
    ).toBe(403);
    expect(local.state.accountReads).toBe(0);
    expect(remote.state.accountReads).toBe(0);
    expect(local.state.submissions).toBe(0);
    expect(remote.state.submissions).toBe(0);
  });

  it("binds hosted storage and binary reads to the verified active account", async () => {
    const app = harness(),
      store = canvasStore();
    const createStore = vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue(store);
    const response = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: storageBody(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { saved: true } });
    expect(createStore.mock.calls[0]?.[1]).toMatchObject({
      account: { id: "account-a", realm: "memfire-phone" },
    });
    const asset = await app.request(
      `/api/moss/media/canvas/assets/${"a".repeat(64)}.png?canvasAccount=account-a&canvasRealm=memfire-phone`,
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    const note = await app.request(
      "/api/moss/media/canvas/knowledge/notes/a.txt?canvasAccount=account-a&canvasRealm=memfire-phone",
    );
    expect(await note.text()).toBe("My note");
    expect(store.readKnowledgeAsset).toHaveBeenCalledWith("notes/a.txt");
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects stale storage or asset account bindings before loading a store", async () => {
    const app = harness();
    const load = vi.spyOn(canvasStorage, "mossCanvasStorageFor");
    app.state.accountId = "account-b";
    const response = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: storageBody(),
    });
    expect(response.status).toBe(409);
    const asset = await app.request(
      `/api/moss/media/canvas/assets/${"a".repeat(64)}.png?canvasAccount=account-a&canvasRealm=memfire-phone`,
    );
    expect(asset.status).toBe(409);
    expect(load).not.toHaveBeenCalled();
  });

  it("rechecks the account after loading storage before applying a mutation", async () => {
    const app = harness(),
      store = canvasStore();
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockImplementation(async () => {
      app.state.accountId = "account-b";
      return store;
    });
    const response = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: storageBody(),
    });
    expect(response.status).toBe(409);
    expect(store.request).not.toHaveBeenCalled();
  });

  it("preserves the original snapshot revision conflict instead of acknowledging a save", async () => {
    const app = harness(),
      store = canvasStore();
    store.request.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { code: "SNAPSHOT_REVISION_CONFLICT", statusCode: 409 }),
    );
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue(store);
    const response = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: storageBody(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "SNAPSHOT_REVISION_CONFLICT" } });
  });

  it("does not repeat an asset promotion after an unknown transport result", async () => {
    const app = harness();
    const promote = vi
      .spyOn(canvasStorage, "promoteMossCanvasAsset")
      .mockRejectedValueOnce(new Error("unknown transport result"));
    const response = await app.request("/api/moss/media/canvas/assets/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId,
        prompt: "reference",
        expectedAccount: { id: "account-a", realm: "memfire-phone" },
      }),
    });
    expect(response.status).toBe(503);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("does not send a stale Canvas account request to a supplier", async () => {
    const app = harness();
    const promote = vi.spyOn(canvasStorage, "promoteMossCanvasAsset");
    app.state.accountId = "account-b";
    for (const endpoint of ["assets/promote", "segments", "media-generation/authorize"]) {
      const response = await app.request(`/api/moss/media/canvas/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: storageBody(),
      });
      expect(response.status).toBe(409);
    }
    expect(promote).not.toHaveBeenCalled();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("denies a paired client access to hosted Canvas storage", async () => {
    const app = harness({ role: "client" });
    const load = vi.spyOn(canvasStorage, "mossCanvasStorageFor");
    const response = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: storageBody(),
    });
    expect(response.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });
  it("restores a paged conversation using only local GETs and rejects foreign cursor and parent replay", async () => {
    const app = harness();
    const create = async (payload: Record<string, unknown>) => {
      const response = await app.request("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(202);
      const job = (await response.json()) as { jobId: string; conversationId: string };
      await vi.waitFor(async () => {
        const page = (await (await app.request("/api/moss/media/history?kind=image")).json()) as {
          jobs: Array<{ jobId: string; status: string }>;
        };
        expect(page.jobs.find((item) => item.jobId === job.jobId)?.status).toBe("succeeded");
      });
      return job;
    };
    const first = await create(body);
    expect(first.conversationId).toMatch(/^mossconv_[a-f0-9]{32}$/u);
    const second = await create({
      ...body,
      idempotencyKey: "second-round",
      prompt: "Make the sails red",
      conversationId: first.conversationId,
      parentJobId: first.jobId,
    });
    const callsBeforeRead = app.fetchMock.mock.calls.length;
    const firstPage = (await (
      await app.request(`/api/moss/media/conversations/${first.conversationId}?limit=1`)
    ).json()) as { jobs: Array<{ jobId: string; parentJobId: string | null }>; nextCursor: string };
    expect(firstPage.jobs).toMatchObject([{ jobId: second.jobId, parentJobId: first.jobId }]);
    const secondPage = await (
      await app.request(
        `/api/moss/media/conversations/${first.conversationId}?limit=1&cursor=${firstPage.nextCursor}`,
      )
    ).json();
    expect(secondPage).toMatchObject({
      kind: "image",
      jobs: [{ jobId: first.jobId, parentJobId: null }],
      nextCursor: null,
    });
    const history = (await (
      await app.request("/api/moss/media/history?kind=image&limit=1")
    ).json()) as { nextCursor: string };
    expect(
      (await app.request(`/api/moss/media/history?kind=video&cursor=${history.nextCursor}`)).status,
    ).toBe(400);
    for (const query of [
      "limit=0",
      "limit=51",
      "limit=1&limit=2",
      "kind=all",
      "cursor=../../private",
      "unexpected=1",
    ])
      expect((await app.request(`/api/moss/media/history?${query}`)).status).toBe(400);
    expect(app.fetchMock.mock.calls).toHaveLength(callsBeforeRead);
    app.state.accountId = "account-b";
    expect(await (await app.request("/api/moss/media/history?kind=image")).json()).toMatchObject({
      jobs: [],
      nextCursor: null,
    });
    expect(
      (await app.request(`/api/moss/media/history?kind=image&cursor=${history.nextCursor}`)).status,
    ).toBe(400);
    expect(
      (await app.request(`/api/moss/media/conversations/${first.conversationId}`)).status,
    ).toBe(404);
    const foreignParent = await app.request("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        conversationId: first.conversationId,
        parentJobId: first.jobId,
      }),
    });
    expect(foreignParent.status).toBe(409);
    expect(app.state.submissions).toBe(2);
    expect(app.fetchMock.mock.calls).toHaveLength(callsBeforeRead);
  });

  it("retains the owner boundary on both local history endpoints", async () => {
    const app = harness({ role: "client" });
    expect((await app.request("/api/moss/media/history?kind=image")).status).toBe(403);
    expect(
      (await app.request(`/api/moss/media/conversations/mossconv_${"a".repeat(32)}`)).status,
    ).toBe(403);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });
  it("returns the recovered terminal result in the first explicit GET after an uncertain submit", async () => {
    const app = harness({
      submit: async () => {
        throw new Error("lost accepted submission response");
      },
      query: async () =>
        Response.json({
          status: "completed",
          pending: false,
          billingStatus: "captured",
          creditsCharged: 3,
          imageUrl: "https://assets.example/recovered.png",
        }),
    });
    const created = (await (await app.create({ origin: "http://127.0.0.1:3773" })).json()) as {
      jobId: string;
    };
    await vi.waitFor(async () => {
      const catalog = (await (await app.request()).json()) as { jobs: Array<{ status: string }> };
      expect(catalog.jobs[0]?.status).toBe("reconciliation_required");
    });
    const checked = await app.request(`/${created.jobId}`);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({
      jobId: created.jobId,
      status: "succeeded",
      billingStatus: "captured",
      imageUrls: ["https://assets.example/recovered.png"],
    });
    expect(app.state.submissions).toBe(1);
  });

  it("rejects a late bill check response after the account changes", async () => {
    let querying = false;
    let finish!: (response: Response) => void;
    const app = harness({
      query: async () => {
        if (!querying)
          return Response.json({
            status: "completed",
            pending: false,
            billingStatus: "unknown",
            imageUrl: "https://assets.example/finished.png",
          });
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
    });
    const created = (await (await app.create({ origin: "http://127.0.0.1:3773" })).json()) as {
      jobId: string;
    };
    await vi.waitFor(async () => {
      const catalog = (await (await app.request()).json()) as { jobs: Array<{ status: string }> };
      expect(catalog.jobs[0]?.status).toBe("succeeded");
    });
    querying = true;
    const pending = app.request(`/${created.jobId}`);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    app.state.accountId = "account-b";
    finish(
      Response.json({
        status: "completed",
        pending: false,
        billingStatus: "captured",
        creditsCharged: 3,
      }),
    );
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    expect(app.state.submissions).toBe(1);
  });

  it("denies valid paired client sessions before accessing the host account or its funds", async () => {
    const app = harness({ role: "client" });
    for (const path of ["", "/moss_unknown", "/../assets/moss_unknown/0"]) {
      const response = await app.request(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "owner_authorization_required" },
      });
    }
    const submit = await app.create({ origin: "moss://app" });
    expect(submit.status).toBe(403);
    expect(await submit.json()).toMatchObject({ error: { code: "owner_authorization_required" } });
    expect(app.state.accountReads).toBe(0);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the real desktop token-only transport for catalog, generation and cached assets", async () => {
    const app = harness({ desktopToken: true });
    const query = "?token=desktop-startup-secret";
    const init = { headers: { origin: "moss://app" } };
    expect((await app.request(query, init)).status).toBe(200);
    const created = await app.request(query, {
      method: "POST",
      headers: { origin: "moss://app", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(202);
    const job = (await created.json()) as { jobId: string };
    await vi.waitFor(async () =>
      expect(await (await app.request(`/${job.jobId}${query}`, init)).json()).toMatchObject({
        status: "succeeded",
        persistenceStatus: "ready",
      }),
    );
    expect((await app.request(`/../assets/${job.jobId}/0${query}`, init)).status).toBe(200);
    expect(app.state.submissions).toBe(1);
  });

  it("rejects missing/wrong desktop tokens and untrusted origins", async () => {
    const app = harness({ desktopToken: true });
    for (const path of ["", "?token=wrong", "?token="]) {
      expect((await app.request(path, { headers: { origin: "moss://app" } })).status).toBe(401);
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { origin: "moss://app", "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await app.request("?token=desktop-startup-secret", {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps trusted-origin CORS on authentication failures so the renderer can read them", async () => {
    const app = harness({ desktopToken: true });
    const trusted = await app.request("/api/moss/media/history?limit=24&kind=image", {
      headers: { origin: "moss://app" },
    });
    expect(trusted.status).toBe(401);
    expect(trusted.headers.get("access-control-allow-origin")).toBe("moss://app");
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
    expect(trusted.headers.get("cache-control")).toBe("no-store");
    expect(await trusted.json()).toEqual({ error: expect.any(String) });
    const untrusted = await app.request("/api/moss/media/history?limit=24&kind=image", {
      headers: { origin: "https://attacker.example" },
    });
    expect(untrusted.status).toBe(401);
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept the startup token on a remotely bound server", async () => {
    const app = harness({ desktopToken: true, remote: true });
    expect(
      (await app.request("?token=desktop-startup-secret", { headers: { origin: "moss://app" } }))
        .status,
    ).toBe(401);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("requires native authentication before accessing account state or gateway", async () => {
    const app = harness();
    expect((await app.request("", { headers: { authorization: "Bearer wrong" } })).status).toBe(
      401,
    );
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects untrusted and opaque origins, including GET recovery requests", async () => {
    const app = harness();
    for (const origin of ["https://attacker.example", "null"]) {
      expect((await app.create({ origin })).status).toBe(403);
      expect((await app.request("", { headers: { origin } })).status).toBe(403);
    }
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("requires a trusted origin for cookie-authenticated mutations", async () => {
    const app = harness({ cookie: true });
    expect((await app.create()).status).toBe(403);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("uses actual installed plugins and retains all outputs under the active account", async () => {
    const app = harness();
    const catalog = (await (await app.request()).json()) as { models: unknown[] };
    expect(catalog.models[0]).toMatchObject({ id: modelId, installed: true, available: true });
    const response = await app.create({ origin: "http://127.0.0.1:3773" });
    expect(response.status).toBe(202);
    const created = (await response.json()) as { jobId: string };
    await vi.waitFor(async () =>
      expect(await (await app.request(`/${created.jobId}`)).json()).toMatchObject({
        status: "succeeded",
        imageUrls: ["https://assets.example/one.png", "https://assets.example/two.png"],
      }),
    );
    const assetPath = `/../assets/${created.jobId}/0`;
    const cached = await app.request(assetPath);
    expect(cached.status).toBe(200);
    expect(cached.headers.get("content-type")).toBe("image/png");
    expect(cached.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );
    app.state.accountId = "account-b";
    expect((await app.request(assetPath)).status).toBe(404);
    expect((await app.request(`/${created.jobId}`)).status).toBe(404);
    expect(await (await app.request()).json()).toMatchObject({ jobs: [] });
    expect(app.state.submissions).toBe(1);
  });

  it("prevents a stale account from submitting after the asynchronous catalog check", async () => {
    let unblock!: () => void;
    let catalogEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      catalogEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const app = harness({
      catalogGate: async () => {
        catalogEntered();
        await gate;
      },
    });
    const pending = app.create();
    await entered;
    app.state.accountId = "account-b";
    unblock();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    expect(app.state.submissions).toBe(0);
  });

  it("refuses generation when the native skill is not installed", async () => {
    const app = harness({ installed: false });
    expect((await app.create()).status).toBe(403);
    expect(app.state.submissions).toBe(0);
  });

  it.each(["thrown", "native-result"])(
    "retains history and fails closed for %s plugin discovery failure",
    async (failure) => {
      const app = harness();
      const created = (await (await app.create()).json()) as { jobId: string };
      await vi.waitFor(async () =>
        expect(await (await app.request(`/${created.jobId}`)).json()).toMatchObject({
          status: "succeeded",
        }),
      );
      app.state.pluginDiscoveryFailed = failure === "thrown";
      app.state.nativePluginDiscoveryFailed = failure === "native-result";
      // The local history checkpoint follows the live terminal observation.
      await vi.waitFor(async () => {
        const listing = await app.request();
        expect(listing.status).toBe(200);
        expect(await listing.json()).toMatchObject({
          account: { id: "account-a", realm: "memfire-phone" },
          models: [],
          jobs: [expect.objectContaining({ jobId: created.jobId, status: "succeeded" })],
          errorCode: "media_plugin_discovery_unavailable",
        });
      });
      const rejected = await app.create();
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toEqual({
        error: { code: "media_plugin_discovery_unavailable" },
      });
      expect(app.state.submissions).toBe(1);
      app.state.accountId = "account-b";
      expect(await (await app.request()).json()).toMatchObject({
        account: { id: "account-b" },
        jobs: [],
      });
    },
  );

  it("rejects a stale renderer account before any catalog request or charge", async () => {
    const app = harness();
    app.state.accountId = "account-b";
    const response = await app.request("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        expectedAccount: { id: "account-a", realm: "memfire-phone" },
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "media_account_changed" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks the account lease after asynchronous cache housekeeping before creating any job", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(MossMediaAssetStore.prototype, "collectUnreferenced").mockImplementation(async () => {
      entered();
      await gate;
    });
    const app = harness();
    const creating = app.create();
    await started;
    app.state.accountId = "account-b";
    release();
    const response = await creating;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    expect(app.state.submissions).toBe(0);
    app.state.accountId = "account-a";
    expect(await (await app.request()).json()).toMatchObject({ jobs: [] });
  });

  it("serves the hosted canvas account and quota from the Moss account services", async () => {
    const app = harness();
    const account = await app.request("/api/moss/media/canvas/account");
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({
      authenticated: true,
      authority: "moss-desktop-database",
      realm: "memfire-phone",
      user: { id: "account-a", name: "Moss 用户" },
    });
    const quota = await app.request("/api/moss/media/canvas/quota");
    expect(quota.status).toBe(200);
    expect(await quota.json()).toMatchObject({ planCode: "plus", creditBalance: 1000000 });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("opens the owned local Canvas when cloud quota is unavailable without inventing billing fields", async () => {
    const app = harness({
      quotaGate: async () => {
        throw new Error("Cloud quota unavailable");
      },
    });
    const workspace = {
      threadId: "thread-folder",
      cwd: "/fixture/original",
      title: "Saved Canvas",
    };
    vi.spyOn(canvasWorkspace, "resolveMossCanvasWorkspace").mockReturnValue(
      Effect.succeed(workspace),
    );
    const account = await app.request("/api/moss/media/canvas/account?canvasThread=thread-folder");
    expect(account.status).toBe(200);
    const identity = (await account.json()) as {
      user: Record<string, unknown>;
      workspace: { threadId: string; fingerprint: string };
    };
    expect(identity).toMatchObject({
      authenticated: true,
      realm: "memfire-phone",
      user: { id: "account-a" },
      workspace: {
        threadId: workspace.threadId,
        fingerprint: canvasWorkspace.mossCanvasWorkspaceFingerprint(workspace),
      },
    });
    expect(identity).not.toHaveProperty("quota");
    for (const field of ["plan", "credits", "planExpiresAt"])
      expect(identity.user).not.toHaveProperty(field);
    expect(app.state.quotaReads).toBe(0);
    const store = canvasStore();
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue(store);
    const saved = await app.request("/api/moss/media/canvas/storage?canvasThread=thread-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(storageBody()), expectedWorkspace: identity.workspace }),
    });
    expect(saved.status).toBe(200);
    expect(store.request).toHaveBeenCalledOnce();
    const quota = await app.request("/api/moss/media/canvas/quota?canvasThread=thread-folder");
    expect(quota.status).toBe(503);
    expect(await quota.json()).not.toHaveProperty("creditBalance");
    expect(app.state.quotaReads).toBe(1);
    expect(app.fetchMock).not.toHaveBeenCalled();
    expect(app.state.submissions).toBe(0);
  });

  it("withholds local Canvas identity after the account changes during its read", async () => {
    let app: ReturnType<typeof harness>;
    app = harness({
      sessionGate: async (read) => {
        if (read === 2) app.state.accountId = "account-b";
      },
    });
    const response = await app.request("/api/moss/media/canvas/account");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    expect(app.state.quotaReads).toBe(0);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("withholds local Canvas identity after its conversation directory changes", async () => {
    const app = harness();
    let reads = 0;
    vi.spyOn(canvasWorkspace, "resolveMossCanvasWorkspace").mockImplementation(() =>
      Effect.sync(() => ({
        threadId: "thread-folder",
        title: "Saved Canvas",
        cwd: ++reads === 1 ? "/fixture/original" : "/fixture/changed",
      })),
    );
    const response = await app.request("/api/moss/media/canvas/account?canvasThread=thread-folder");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "canvas_workspace_changed" } });
    expect(app.state.quotaReads).toBe(0);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("does not turn a successful local identity read into permission to generate through an unavailable gateway", async () => {
    const app = harness({
      quotaGate: async () => {
        throw new Error("Cloud quota unavailable");
      },
      catalogGate: async () => {
        throw new Error("Cloud catalog unavailable");
      },
    });
    expect((await app.request("/api/moss/media/canvas/account")).status).toBe(200);
    expect((await app.create()).status).toBe(503);
    expect(app.state.submissions).toBe(0);
    expect(app.state.quotaReads).toBe(0);
    expect(app.fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps local Canvas identity and saves available while cloud credentials cannot refresh", async () => {
    const app = harness({ authorityUnavailable: true });
    const store = canvasStore();
    vi.spyOn(canvasStorage, "mossCanvasStorageFor").mockResolvedValue(store);
    const identity = await app.request("/api/moss/media/canvas/account");
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({ authenticated: true, user: { id: "account-a" } });
    const saved = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: storageBody(),
    });
    expect(saved.status).toBe(200);
    expect(store.request).toHaveBeenCalledOnce();
    expect(app.state.authorityReads).toBe(0);
    expect(app.fetchMock).not.toHaveBeenCalled();
    const history = await app.request();
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      account: { id: "account-a", realm: "memfire-phone" },
      models: [],
      jobs: [],
      errorCode: "authentication_service_unavailable",
    });
    expect((await app.create()).status).toBe(401);
    expect(app.state.submissions).toBe(0);
  });

  it("rejects quota reads after the account changes", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const app = harness({
      quotaGate: async () => {
        entered();
        await gate;
      },
    });
    const quotaPending = app.request("/api/moss/media/canvas/quota");
    await started;
    app.state.accountId = "account-b";
    release();
    const changedQuota = await quotaPending;
    expect(changedQuota.status).toBe(409);
    expect(await changedQuota.json()).toMatchObject({ error: { code: "account_changed" } });
    app.state.accountId = "account-a";
    const quota = await app.request("/api/moss/media/canvas/quota");
    expect(quota.status).toBe(200);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("lists open jobs for a project and rejects malformed project ids", async () => {
    const app = harness();
    const open = await app.request("/api/moss/media/projects/project-1/jobs/open");
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ jobs: [] });
    expect((await app.request("/api/moss/media/projects/thread%3Athread-1/jobs/open")).status).toBe(
      200,
    );
    const malformed = await app.request("/api/moss/media/projects/bad%20id/jobs/open");
    expect(malformed.status).toBe(404);
    expect(app.fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a directory change during text model lookup before sending a paid request", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let selected = {
      threadId: "thread-folder",
      cwd: "/fixture/original",
      title: "Selected folder",
    };
    vi.spyOn(canvasWorkspace, "resolveMossCanvasWorkspace").mockImplementation(() =>
      Effect.sync(() => selected),
    );
    const fingerprint = canvasWorkspace.mossCanvasWorkspaceFingerprint(selected);
    const app = harness({
      textCatalogGate: async () => {
        entered();
        await gate;
      },
    });
    const pending = app.request(
      "/api/moss/media/canvas/text/completions?canvasThread=thread-folder",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          operationId: "folder-race",
          stream: false,
          messages: [{ role: "user", content: "Fixture text" }],
          expectedAccount: { id: "account-a", realm: "memfire-phone" },
          expectedWorkspace: { threadId: selected.threadId, fingerprint },
        }),
      },
    );
    await started;
    selected = { ...selected, cwd: "/fixture/changed" };
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "canvas_workspace_changed" } });
    expect(app.state.textSubmissions).toBe(0);
  });

  it("rejects renderer job projections and unavailable thread context without falling back to global storage", async () => {
    const app = harness();
    const stores = vi.spyOn(canvasStorage, "mossCanvasStorageFor");
    const rpc = await app.request("/api/moss/media/canvas/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "host.syncConversationJob",
        expectedAccount: { id: "account-a", realm: "memfire-phone" },
        input: { job: { jobId: "moss_fake" } },
      }),
    });
    expect(rpc.status).toBe(403);
    const unbound = await app.request("/api/moss/media/canvas/storage?canvasThread=thread-absent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "projects.list" }),
    });
    expect(unbound.status).toBe(503);
    expect(stores).not.toHaveBeenCalled();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });
});
