import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ServiceMap } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPayService } from "./account/Services/MossPayService";
import { AuthError, ServerAuth, type AuthRequest } from "./auth/Services/ServerAuth";
import { HoolaCanvasBridgeBroker } from "./hoolaCanvasBridge";
import { MossMediaHistory } from "./mossMediaHistory";
import {
  mediaAccountScope,
  MossMediaJobsError,
  type MossMediaCredential,
} from "./mossMediaJobsService";
import { mossMediaJobsServiceFor } from "./mossMediaAuthority";
import * as canvasWorkspace from "./mossCanvasWorkspace";

vi.mock("./config", async () => {
  const { ServiceMap } = await import("effect");
  return { ServerConfig: ServiceMap.Service("media-origin-test/ServerConfig") };
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
const credential: MossMediaCredential = {
  realm: "memfire-phone",
  accessToken: "private-unused-token",
  gatewayBaseUrl: gateway,
  account: { id: "account-a", realm: "memfire-phone" },
};

async function harness(options: { role?: "owner" | "client"; bound?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "moss-media-origin-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = await realpath(directory);
  const workspace = { threadId: "original-thread", cwd, title: "Original annotations" };
  const state = { accountId: credential.account.id };
  const fetchMock = vi.fn(() => Promise.reject(new Error("Unexpected supplier request")));
  const cloudRead = vi.fn(() => Effect.die("Canvas origin must use the local account identity"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
  const broker = new HoolaCanvasBridgeBroker();
  broker.create({
    projectId: "thread:untrusted-snapshot-thread",
    operation: "text_to_image",
    modelId: "gpt-image-2-official",
    prompt: "Existing local output",
    idempotencyKey: "origin-fixture",
  });
  const job = broker.durableJobs()[0]!;
  const scope = mediaAccountScope(credential);
  await new MossMediaHistory(directory).save(scope, job);
  const bindingPath = join(directory, "media-job-workspaces", scope, `${job.snapshot.jobId}.json`);
  const writeBinding = async (value: unknown = { version: 1, ...workspace }) => {
    await mkdir(join(directory, "media-job-workspaces", scope), { recursive: true });
    await writeFile(bindingPath, typeof value === "string" ? value : JSON.stringify(value));
  };
  if (options.bound !== false) await writeBinding();
  const resolveWorkspace = vi
    .spyOn(canvasWorkspace, "resolveMossCanvasWorkspace")
    .mockImplementation((threadId) =>
      threadId === workspace.threadId
        ? Effect.succeed(workspace)
        : Effect.fail(new MossMediaJobsError("canvas_thread_not_found", 404)),
    );
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, {
      stateDir: directory,
      host: "127.0.0.1",
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
              credentialSource: "bearer",
            })
          : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 })),
    } as unknown as ServiceMap.Service.Shape<typeof ServerAuth>),
    Layer.succeed(MossPhoneAccountService, {
      getLocalAuthority: () =>
        Effect.sync(() => ({
          activeRealm: "cn",
          identity: {
            realm: credential.realm,
            gatewayBaseUrl: gateway,
            account: { id: state.accountId, realm: credential.realm },
          },
        })),
      getSession: cloudRead,
      getAuthorityCredential: cloudRead,
    } as unknown as ServiceMap.Service.Shape<typeof MossPhoneAccountService>),
    Layer.succeed(MossEnterpriseKeyAccount, {
      getActiveAuthorityCredential: () => Effect.succeed(null),
    } as unknown as ServiceMap.Service.Shape<typeof MossEnterpriseKeyAccount>),
    Layer.succeed(MossCloudAccountService, {
      getLocalAuthority: () => Effect.succeed({ activeRealm: null, identity: null }),
      getState: cloudRead,
      getAuthorityCredential: cloudRead,
    } as unknown as ServiceMap.Service.Shape<typeof MossCloudAccountService>),
    Layer.succeed(MossPayService, {
      getQuota: () => Effect.die("Canvas origin must not query billing"),
    } as unknown as ServiceMap.Service.Shape<typeof MossPayService>),
  );
  const server = HttpRouter.toWebHandler(
    mossMediaJobsEffectRouteLayer.pipe(HttpRouter.provideRequest(services)),
    { disableLogger: true },
  );
  cleanups.push(server.dispose);
  const request = (suffix = "", authenticated = true) =>
    server.handler(
      new Request(
        `http://127.0.0.1:3773/api/moss/media/jobs/${job.snapshot.jobId}/canvas-origin${suffix}`,
        {
          headers: {
            host: "127.0.0.1:3773",
            ...(authenticated ? { authorization: "Bearer native-session" } : {}),
          },
        },
      ),
    );
  return {
    state,
    directory,
    workspace,
    job,
    bindingPath,
    writeBinding,
    resolveWorkspace,
    fetchMock,
    cloudRead,
    request,
    service: mossMediaJobsServiceFor(directory),
  };
}

describe("read-only media Canvas origin", () => {
  it("returns only the durable bound origin without supplier traffic or trusting client/snapshot threads", async () => {
    const app = await harness();
    const check = vi.spyOn(app.service, "check");
    const listing = vi.spyOn(app.service, "list");
    const response = await app.request("?canvasThread=unrelated-active-draft");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: credential.account,
      threadId: "original-thread",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(app.resolveWorkspace.mock.calls).toEqual([["original-thread"], ["original-thread"]]);
    expect(app.fetchMock).not.toHaveBeenCalled();
    expect(app.cloudRead).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(listing).not.toHaveBeenCalled();
  });

  it("returns null only for an owned legacy job without binding, ignoring its snapshot thread", async () => {
    const app = await harness({ bound: false });
    const response = await app.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: credential.account, threadId: null });
    expect(app.resolveWorkspace).not.toHaveBeenCalled();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a foreign account even when an original binding exists", async () => {
    const app = await harness();
    app.state.accountId = "account-b";
    const response = await app.request();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "job_not_found" } });
    expect(app.resolveWorkspace).not.toHaveBeenCalled();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("requires owner authentication before reading origin", async () => {
    const app = await harness({ role: "client" });
    expect((await app.request("", false)).status).toBe(401);
    const response = await app.request();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "owner_authorization_required" },
    });
    expect(app.resolveWorkspace).not.toHaveBeenCalled();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "broken JSON", value: "{broken-json" },
    { label: "null", value: "null" },
    { label: "array", value: "[]" },
    { label: "oversized", value: " ".repeat(8193) },
  ])("fails closed for a corrupt existing binding: $label", async ({ value }) => {
    const app = await harness();
    await app.writeBinding(value);
    const response = await app.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "canvas_origin_unavailable" } });
    expect(app.resolveWorkspace).not.toHaveBeenCalled();
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["invalid-thread", "missing-workspace", "foreign-image-origin"])(
    "fails closed for invalid bound metadata: %s",
    async (invalid) => {
      const app = await harness();
      await app.writeBinding({
        version: 1,
        ...app.workspace,
        ...(invalid === "invalid-thread" ? { threadId: "../unsafe" } : {}),
        ...(invalid === "missing-workspace" ? { cwd: join(app.directory, "missing") } : {}),
        ...(invalid === "foreign-image-origin"
          ? { imageOrigin: { threadId: "another-thread", turnId: "turn-1" } }
          : {}),
      });
      const response = await app.request();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "canvas_origin_unavailable" } });
      expect(app.fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the original thread has been deleted", async () => {
    const app = await harness();
    app.resolveWorkspace.mockReturnValue(
      Effect.fail(new MossMediaJobsError("canvas_thread_not_found", 404)),
    );
    const response = await app.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "canvas_origin_unavailable" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a current original workspace that differs from the canonical bound directory", async () => {
    const app = await harness();
    app.resolveWorkspace.mockReturnValue(
      Effect.succeed({ ...app.workspace, cwd: join(app.directory, "another") }),
    );
    const response = await app.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "canvas_origin_unavailable" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks the original workspace before returning the origin", async () => {
    const app = await harness();
    app.resolveWorkspace
      .mockReturnValueOnce(Effect.succeed(app.workspace))
      .mockReturnValueOnce(Effect.fail(new MossMediaJobsError("canvas_thread_not_found", 404)));
    const response = await app.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "canvas_origin_unavailable" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks the active account after reading the bound origin", async () => {
    const app = await harness();
    const original = app.service.readOwnedCanvasOrigin.bind(app.service);
    vi.spyOn(app.service, "readOwnedCanvasOrigin").mockImplementation(async (...args) => {
      const origin = await original(...args);
      app.state.accountId = "account-b";
      return origin;
    });
    const response = await app.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    expect(app.fetchMock).not.toHaveBeenCalled();
  });
});
