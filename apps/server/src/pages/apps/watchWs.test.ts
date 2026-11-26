import http from "node:http";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PageApp, PageAppAiEvent } from "@moss/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { AuthControlPlaneLive } from "../../auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "../../auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "../../auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "../../auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "../../auth/Layers/SessionCredentialService";
import { ServerConfig } from "../../config";
import { makeBoundedNodeHttpServer } from "../../nodeHttpServer";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { pageAppsApiRouteLayer } from "./httpRoute";
import { makePageAppsServiceShape, PageAppsService } from "./PageAppsService";

const STARTUP_TOKEN = "synthetic-page-app-owner";

const fakeAi = {
  ask: async function* (): AsyncGenerator<PageAppAiEvent> {
    yield { type: "text", delta: "Hel" };
    yield { type: "text", delta: "lo" };
    yield { type: "done", text: "Hello", model: "fake-model" };
  },
};

type WatchServerMessage =
  | { type: "event"; id: string; value: unknown }
  | { type: "error"; id: string; error: { code: string; message: string } }
  | { type: "end"; id: string };

async function startFixture() {
  const configLayer = ServerConfig.layerTest(
    process.cwd(),
    { prefix: "moss-page-apps-ws-" },
    {
      host: "127.0.0.1",
      authToken: STARTUP_TOKEN,
      mode: "desktop",
    },
  ).pipe(Layer.provide(NodeServices.layer));

  const sessionLayer = SessionCredentialServiceLive.pipe(Layer.provide(ServerSecretStoreLive));
  const controlLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionLayer),
  );
  const authLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionLayer),
    Layer.provide(controlLayer),
  );
  const pageAppsLayer = Layer.effect(
    PageAppsService,
    makePageAppsServiceShape({ ai: fakeAi }),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

  const services = Layer.mergeAll(
    authLayer,
    sessionLayer,
    pageAppsLayer,
    configLayer,
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStoreLive),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const scope = await Effect.runPromise(Scope.make("sequential"));
  const context = await Effect.runPromise(Layer.buildWithScope(services, scope));
  let node: http.Server | undefined;

  await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const server = yield* makeBoundedNodeHttpServer(
          () => {
            node = http.createServer();
            return node;
          },
          { port: 0, host: "127.0.0.1" },
        );
        yield* server.serve(yield* HttpRouter.toHttpEffect(pageAppsApiRouteLayer));
      }).pipe(Effect.provide(context)),
      scope,
    ),
  );

  const address = (node as http.Server | undefined)?.address();
  if (!address || typeof address !== "object") throw new Error("Missing test listener");

  const httpOrigin = `http://127.0.0.1:${address.port}`;
  const wsOrigin = `ws://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();

  const apiCall = async <T = unknown>(op: string, body: unknown): Promise<T> => {
    const response = await fetch(`${httpOrigin}/api/page-apps/${op}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STARTUP_TOKEN}`,
        Origin: httpOrigin,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `POST /api/page-apps/${op} failed: ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  };

  const connect = async (options?: { origin?: string; host?: string; token?: string }) => {
    const token = options?.token ?? STARTUP_TOKEN;
    const socket = new WebSocket(`${wsOrigin}/api/page-apps/watch-ws?token=${token}`, {
      headers: {
        Origin: options?.origin ?? httpOrigin,
        ...(options?.host ? { Host: options.host } : {}),
      },
    });
    sockets.add(socket);

    const messages: WatchServerMessage[] = [];
    const waiters: Array<() => void> = [];
    const notify = () => {
      while (waiters.length > 0) waiters.shift()?.();
    };

    socket.on("message", (raw: RawData) => {
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString("utf8");
      messages.push(JSON.parse(text) as WatchServerMessage);
      notify();
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`Upgrade rejected ${response.statusCode}`));
      });
    });

    const waitFor = async <T extends WatchServerMessage>(
      predicate: (msg: WatchServerMessage) => msg is T,
      timeoutMs = 3000,
    ): Promise<T> => {
      const existingIndex = messages.findIndex(predicate);
      if (existingIndex >= 0) {
        const [matched] = messages.splice(existingIndex, 1);
        return matched as T;
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              const idx = waiters.indexOf(onMsg);
              if (idx >= 0) waiters.splice(idx, 1);
              resolve();
            },
            Math.max(10, deadline - Date.now()),
          );
          const onMsg = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.push(onMsg);
        });
        const idx = messages.findIndex(predicate);
        if (idx >= 0) {
          const [matched] = messages.splice(idx, 1);
          return matched as T;
        }
      }
      throw new Error(`Timed out waiting for watch message; remaining=${JSON.stringify(messages)}`);
    };

    return {
      socket,
      messages,
      send: (payload: unknown) => socket.send(JSON.stringify(payload)),
      waitFor,
    };
  };

  return {
    httpOrigin,
    wsOrigin,
    apiCall,
    connect,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

describe("GET /api/page-apps/watch-ws", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("multiplexes concurrent db.watchDoc and db.watchQuery streams, supports unwatch, and ends finite streams", async () => {
    const fx = await startFixture();
    cleanups.push(fx.close);

    const created = await fx.apiCall<{ app: PageApp }>("mutate", {
      op: "create",
      requestId: randomUUID(),
      scopeSpaceId: null,
      html: "<!doctype html><html><head><title>WS Test</title></head><body>hi</body></html>",
      capabilities: { db: {}, ai: {} },
    });
    const app = created.app;
    await fx.apiCall("consent", { op: "set", appId: app.id, capability: "db", state: "granted" });
    await fx.apiCall("consent", { op: "set", appId: app.id, capability: "ai", state: "granted" });

    const client = await fx.connect();

    client.send({
      type: "watch",
      id: "doc-1",
      input: {
        appId: app.id,
        revision: app.revision,
        capability: "db",
        method: "watchDoc",
        args: { path: "tasks/t1" },
      },
    });
    client.send({
      type: "watch",
      id: "query-1",
      input: {
        appId: app.id,
        revision: app.revision,
        capability: "db",
        method: "watchQuery",
        args: { collection: "tasks" },
      },
    });

    const initialDoc = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "event" }> =>
        msg.type === "event" && msg.id === "doc-1",
    );
    expect(initialDoc.value).toMatchObject({ exists: false });

    const initialQuery = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "event" }> =>
        msg.type === "event" && msg.id === "query-1",
    );
    expect((initialQuery.value as { docs: unknown[] }).docs).toEqual([]);

    await fx.apiCall("call", {
      appId: app.id,
      revision: app.revision,
      capability: "db",
      method: "set",
      args: { path: "tasks/t1", data: { title: "First" } },
    });

    const docUpdate = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "event" }> =>
        msg.type === "event" && msg.id === "doc-1",
    );
    expect(docUpdate.value).toMatchObject({ exists: true, data: { title: "First" } });

    const queryUpdate = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "event" }> =>
        msg.type === "event" && msg.id === "query-1",
    );
    expect((queryUpdate.value as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual([
      "t1",
    ]);

    client.send({ type: "unwatch", id: "doc-1" });
    await new Promise((resolve) => setTimeout(resolve, 40));

    await fx.apiCall("call", {
      appId: app.id,
      revision: app.revision,
      capability: "db",
      method: "set",
      args: { path: "tasks/t1", data: { title: "Second" } },
    });

    const secondQueryUpdate = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "event" }> =>
        msg.type === "event" && msg.id === "query-1",
    );
    expect(
      (secondQueryUpdate.value as { docs: Array<{ data: { title: string } }> }).docs[0]?.data.title,
    ).toBe("Second");
    expect(client.messages.some((msg) => msg.id === "doc-1")).toBe(false);

    // Finite stream (`ai.ask`) emits events and terminates with `end`
    client.send({
      type: "watch",
      id: "ai-1",
      input: {
        appId: app.id,
        revision: app.revision,
        capability: "ai",
        method: "ask",
        args: { input: "hi" },
      },
    });
    const aiDone = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "end" }> =>
        msg.type === "end" && msg.id === "ai-1",
    );
    expect(aiDone.type).toBe("end");
    expect(
      client.messages.filter((msg) => msg.type === "event" && msg.id === "ai-1").length,
    ).toBeGreaterThanOrEqual(1);

    // Closing the socket cleanly tears down active watch fibers
    client.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }, 20_000);

  it("enforces subscription limit (64) and forwards service errors per id", async () => {
    const fx = await startFixture();
    cleanups.push(fx.close);

    const created = await fx.apiCall<{ app: PageApp }>("mutate", {
      op: "create",
      requestId: randomUUID(),
      scopeSpaceId: null,
      html: "<!doctype html><html><head><title>Limit Test</title></head><body>hi</body></html>",
      capabilities: { db: {}, ai: {} },
    });
    const app = created.app;
    await fx.apiCall("consent", { op: "set", appId: app.id, capability: "db", state: "granted" });

    const client = await fx.connect();

    // ai is not granted -> error frame for that subscription id, socket stays open
    client.send({
      type: "watch",
      id: "denied-ai",
      input: {
        appId: app.id,
        revision: app.revision,
        capability: "ai",
        method: "ask",
        args: { input: "hi" },
      },
    });
    const denied = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "error" }> =>
        msg.type === "error" && msg.id === "denied-ai",
    );
    expect(denied.error.code).toBe("not_granted");

    // Fill 64 concurrent db subscriptions, 65th must fail with resource_exhausted
    for (let i = 0; i < 64; i += 1) {
      client.send({
        type: "watch",
        id: `sub-${i}`,
        input: {
          appId: app.id,
          revision: app.revision,
          capability: "db",
          method: "watchDoc",
          args: { path: `tasks/t${i}` },
        },
      });
    }
    await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "event" }> =>
        msg.type === "event" && msg.id === "sub-63",
    );

    client.send({
      type: "watch",
      id: "sub-overflow",
      input: {
        appId: app.id,
        revision: app.revision,
        capability: "db",
        method: "watchDoc",
        args: { path: "tasks/overflow" },
      },
    });
    const overflow = await client.waitFor(
      (msg): msg is Extract<WatchServerMessage, { type: "error" }> =>
        msg.type === "error" && msg.id === "sub-overflow",
    );
    expect(overflow.error.code).toBe("resource_exhausted");
  }, 20_000);

  it("rejects *.moss-app.localhost host, untrusted origins, and wrong HTTP methods, while preserving SSE watch", async () => {
    const fx = await startFixture();
    cleanups.push(fx.close);

    await expect(fx.connect({ host: "abc.moss-app.localhost:6010" })).rejects.toThrow(
      "Upgrade rejected 404",
    );

    await expect(fx.connect({ origin: "https://evil.example" })).rejects.toThrow(
      "Upgrade rejected 403",
    );

    const wrongPost = await fetch(`${fx.httpOrigin}/api/page-apps/watch-ws`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STARTUP_TOKEN}`,
        Origin: fx.httpOrigin,
      },
      body: "{}",
    });
    expect(wrongPost.status).toBe(405);

    const wrongGet = await fetch(`${fx.httpOrigin}/api/page-apps/watch`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${STARTUP_TOKEN}`,
        Origin: fx.httpOrigin,
      },
    });
    expect(wrongGet.status).toBe(405);

    // SSE fallback still works
    const created = await fx.apiCall<{ app: PageApp }>("mutate", {
      op: "create",
      requestId: randomUUID(),
      scopeSpaceId: null,
      html: "<!doctype html><html><head><title>SSE</title></head><body>hi</body></html>",
      capabilities: { db: {} },
    });
    await fx.apiCall("consent", {
      op: "set",
      appId: created.app.id,
      capability: "db",
      state: "granted",
    });

    const controller = new AbortController();
    const sseResponse = await fetch(`${fx.httpOrigin}/api/page-apps/watch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STARTUP_TOKEN}`,
        Origin: fx.httpOrigin,
      },
      body: JSON.stringify({
        appId: created.app.id,
        revision: created.app.revision,
        capability: "db",
        method: "watchQuery",
        args: { collection: "tasks" },
      }),
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseResponse.body?.getReader();
    const firstChunk = await reader?.read();
    const decoded = new TextDecoder().decode(firstChunk?.value);
    expect(decoded).toContain("data: ");
    controller.abort();
  }, 20_000);
});
