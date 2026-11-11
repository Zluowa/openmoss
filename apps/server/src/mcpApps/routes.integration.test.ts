// FILE: routes.integration.test.ts
// Purpose: Interactive connectors through the production HTTP route set against the fixture MCP
//   server over Streamable HTTP, as a Moss connector: a provider row is bound from the
//   proxy-observed tool list, then every widget endpoint is exercised (resource read with the
//   stable origin, full tool result, widget RPC with the SPEC §6 refusals and the approval token
//   flow, model context, downloads) together with the auth, origin and body-cap rules.
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@moss/contracts";
import {
  MCP_APP_MODEL_CONTEXT_ROUTE_PATH,
  MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH,
  MCP_APP_RESOURCE_READ_ROUTE_PATH,
  MCP_APP_RPC_ROUTE_PATH,
  MCP_APP_TOOL_RESULT_ROUTE_PATH,
} from "@moss/shared/mcpAppResource";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHttp } from "../../test-fixtures/mcp-apps/server.mjs";
import { AuthError, ServerAuth, type ServerAuthShape } from "../auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "../config";
import { makeEffectHttpRouteLayer } from "../http";
import type { McpConnectorProxyResult } from "../mcpConnectors/proxy";
import { McpConnectors, type McpConnectorsShape } from "../mcpConnectors/Services/McpConnectors";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderService, type ProviderServiceShape } from "../provider/Services/ProviderService";
import { makeServerReadiness } from "../server/readiness";
import { makeServerShutdownController } from "../serverShutdown";
import { DESKTOP_APP_CORS_ORIGINS } from "../trustedOrigins";
import { makeMcpAppServiceState } from "./Layers/McpAppService";
import { observeConnectorExchange } from "./proxyObserver";
import { McpAppService } from "./Services/McpAppService";
import { mcpAppRefusalNotAppVisible, mcpAppRefusalUnknownTool } from "./toolUi";

const TOKEN = "integration-token";
const ORIGIN = [...DESKTOP_APP_CORS_ORIGINS][0]!;
const THREAD = "thread-ic-integration";
const CALL = "call-fixture-1";
const CONNECTOR_ID = "conn-fixture";
const SERVER = "fixture_connector";

let fixture: http.Server;
let fixtureUrl: string;
let moss: http.Server | null = null;
let mossOrigin: string;
let scope: Scope.Closeable;
const stateDir = mkdtempSync(path.join(os.tmpdir(), "moss-ic-routes-"));
const service = makeMcpAppServiceState({ resultsDirectory: path.join(stateDir, "results") });
let runtimeMode: "approval-required" | "full-access" = "approval-required";

/** Direct loopback forward (the production proxy refuses non-public addresses by design). */
async function forward(request: {
  readonly method: "POST" | "DELETE";
  readonly body?: unknown;
  readonly sessionId?: string | undefined;
  readonly protocolVersion?: string | undefined;
}): Promise<McpConnectorProxyResult> {
  const response = await fetch(fixtureUrl, {
    method: request.method,
    headers: {
      "content-type": "application/json",
      ...(request.sessionId ? { "mcp-session-id": request.sessionId } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    body: text ? { kind: "json", value: JSON.parse(text) } : { kind: "empty" },
  };
}

const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${mossOrigin}${route}?token=${TOKEN}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const rpc = async (method: string, params: Record<string, unknown>, extra = {}) => {
  const response = await post(MCP_APP_RPC_ROUTE_PATH, {
    threadId: THREAD,
    callId: CALL,
    server: SERVER,
    method,
    params,
    ...extra,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
};

beforeAll(async () => {
  fixture = await startHttp(0);
  const address = fixture.address();
  if (!address || typeof address !== "object") throw new Error("no fixture address");
  fixtureUrl = `http://127.0.0.1:${address.port}/mcp`;
  service.setConnectorDirectory([
    { connectorId: CONNECTOR_ID, serverName: SERVER, name: "Fixture", url: fixtureUrl },
  ]);

  const connectors = {
    forward: (connectorId: string, request: Parameters<typeof forward>[0]) =>
      connectorId === CONNECTOR_ID
        ? Effect.promise(() => forward(request))
        : Effect.die(new Error("unknown connector")),
  } as unknown as McpConnectorsShape;
  const auth = {
    authenticateHttpRequest: () =>
      Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
  } as unknown as ServerAuthShape;
  const snapshotQuery = {
    getThreadShellById: () => Effect.succeed(Option.some({ runtimeMode })),
  };
  const config = { host: "127.0.0.1", publicUrl: undefined, authToken: TOKEN } as ServerConfigShape;

  scope = await Effect.runPromise(Scope.make("sequential"));
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.succeed(ServerAuth, auth),
        Layer.succeed(ProviderService, {} as ProviderServiceShape),
        Layer.succeed(McpAppService, service),
        Layer.succeed(McpConnectors, connectors),
        Layer.succeed(ProjectionSnapshotQuery, snapshotQuery as never),
        NodeServices.layer,
      ),
      scope,
    ),
  );
  await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const readiness = yield* makeServerReadiness;
        const shutdownController = yield* makeServerShutdownController();
        const server = yield* NodeHttpServer.make(
          () => {
            moss = http.createServer();
            return moss;
          },
          { port: 0, host: "127.0.0.1" },
        );
        const routes = makeEffectHttpRouteLayer(readiness, shutdownController);
        yield* server.serve(
          yield* HttpRouter.toHttpEffect(routes as unknown as Layer.Layer<never>),
        );
      }).pipe(Effect.provideServices(services)),
      scope,
    ),
  );
  const mossAddress = (moss as http.Server | null)?.address();
  if (!mossAddress || typeof mossAddress !== "object") throw new Error("no Moss address");
  mossOrigin = `http://127.0.0.1:${mossAddress.port}`;

  // A provider session lists the connector's tools and calls the UI tool through the proxy.
  const listed = observeConnectorExchange({
    service,
    connectorId: CONNECTOR_ID,
    threadId: THREAD,
    requestBody: { jsonrpc: "2.0", id: 7, method: "tools/list" },
    result: await forward({
      method: "POST",
      body: { jsonrpc: "2.0", id: 7, method: "tools/list" },
    }),
  });
  const offered = (listed.body as { value: { result: { tools: Array<{ name: string }> } } }).value
    .result.tools;
  expect(offered.map((tool) => tool.name)).toEqual([
    "fixture_show_widget",
    "fixture_model_only",
    "fixture_bad_structured",
  ]);
  const callBody = {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "fixture_show_widget", arguments: { name: "Moss", count: 3 } },
  };
  observeConnectorExchange({
    service,
    connectorId: CONNECTOR_ID,
    threadId: THREAD,
    requestBody: callBody,
    result: await forward({ method: "POST", body: callBody }),
  });
  const row = {
    type: "item.completed",
    eventId: "event-1",
    provider: "opencode",
    createdAt: new Date(0).toISOString(),
    threadId: ThreadId.makeUnsafe(THREAD),
    itemId: CALL,
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "fixture_connector_fixture_show_widget",
      data: {
        toolName: "fixture_connector_fixture_show_widget",
        toolCallId: CALL,
        input: { name: "Moss", count: 3 },
        state: { status: "completed", output: "Hello, Moss! The counter is 3." },
      },
    },
  } as unknown as ProviderRuntimeEvent;
  const bound = service.enrichRuntimeEvent(row);
  const payload = bound.payload as { itemType: string; data: { app?: Record<string, unknown> } };
  expect(payload.itemType).toBe("mcp_tool_call");
  expect(payload.data.app).toEqual({
    resourceUri: "ui://fixture/widget.html",
    source: "toolDefinition",
    server: SERVER,
    serverKey: CONNECTOR_ID,
    serverLabel: "Fixture",
    toolName: "fixture_show_widget",
    toolTitle: "Fixture widget",
    connectorId: CONNECTOR_ID,
    connectorUrl: fixtureUrl,
    isFirstParty: false,
    visibility: ["model", "app"],
  });
  await service.results.flush();
}, 120_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await service.stop();
  await new Promise((resolve) => fixture.close(resolve));
  rmSync(stateDir, { recursive: true, force: true });
});

describe("interactive connector endpoints (Moss connector, Streamable HTTP fixture)", () => {
  it("reads the widget resource through Moss's own client with the stable origin", async () => {
    const response = await post(MCP_APP_RESOURCE_READ_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      server: SERVER,
      resourceUri: "ui://fixture/widget.html",
      source: "toolDefinition",
      toolName: "fixture_show_widget",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.state).toBe("ready");
    expect(body.mimeType).toBe("text/html;profile=mcp-app");
    expect(body.html).toContain("moss-fixture-widget");
    expect(body.stableOrigin).toBe(true);
    expect(body.permissions).toEqual({ clipboardWrite: true });
    expect(body.prefersBorder).toBe(true);
    expect(body.widgetDomain).toBe("fixture.example");
    expect(body.csp.resourceDomains).toEqual(["https://cdn.fixture.example"]);

    const other = await post(MCP_APP_RESOURCE_READ_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      server: SERVER,
      resourceUri: "ui://fixture/other.html",
      source: "toolDefinition",
    });
    expect(other.status).toBe(403);
    const wrongServer = await post(MCP_APP_RESOURCE_READ_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      server: "someone_else",
      resourceUri: "ui://fixture/widget.html",
      source: "toolDefinition",
    });
    expect(wrongServer.status).toBe(403);
  });

  it("serves the full tool result with reserved meta stripped", async () => {
    const response = await post(MCP_APP_TOOL_RESULT_ROUTE_PATH, { threadId: THREAD, callId: CALL });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      input: { name: "Moss", count: 3 },
      result: {
        content: [{ type: "text", text: "Hello, Moss! The counter is 3." }],
        structuredContent: { greeting: "Hello, Moss!", count: 3, items: ["one", "two", "three"] },
        _meta: { "fixture/renderedAt": "1970-01-01T00:00:00.000Z" },
      },
    });
    const missing = await post(MCP_APP_TOOL_RESULT_ROUTE_PATH, {
      threadId: THREAD,
      callId: "nope",
    });
    expect(await missing.json()).toEqual({ status: "missing" });
  });

  it("lists every tool for the widget, app-only ones included", async () => {
    const body = await rpc("tools/list", {});
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "fixture_show_widget",
      "fixture_app_increment",
      "fixture_app_read",
      "fixture_model_only",
      "fixture_bad_structured",
    ]);
  });

  it("refuses unlisted and model-only tools with the host texts", async () => {
    expect(await rpc("tools/call", { name: "fixture_model_only", arguments: {} })).toEqual({
      error: { code: -32600, message: mcpAppRefusalNotAppVisible("fixture_model_only") },
    });
    expect(await rpc("tools/call", { name: "no_such_tool", arguments: {} })).toEqual({
      error: { code: -32600, message: mcpAppRefusalUnknownTool("no_such_tool") },
    });
  });

  it("asks for approval in approval-required mode and accepts the token once", async () => {
    runtimeMode = "approval-required";
    const first = await rpc("tools/call", {
      name: "fixture_app_increment",
      arguments: { count: 3 },
    });
    expect(first.needsApproval).toMatchObject({
      toolName: "fixture_app_increment",
      serverLabel: "Fixture",
      reason: "Fixture 的小组件想使用 Increment",
    });
    const token = first.needsApproval.token as string;
    // A token is bound to the arguments it was issued for.
    const otherArgs = await rpc(
      "tools/call",
      { name: "fixture_app_increment", arguments: { count: 9 } },
      { approvalToken: token },
    );
    expect(otherArgs.needsApproval).toBeDefined();
    const retry = await rpc("tools/call", {
      name: "fixture_app_increment",
      arguments: { count: 3 },
    });
    const approved = await rpc(
      "tools/call",
      {
        name: "fixture_app_increment",
        arguments: { count: 3 },
        _meta: { "moss/x": 1, progressToken: 1 },
      },
      { approvalToken: retry.needsApproval.token },
    );
    expect(approved).toEqual({
      result: {
        content: [{ type: "text", text: "Counter is now 4." }],
        structuredContent: { count: 4 },
      },
    });
    const reused = await rpc(
      "tools/call",
      { name: "fixture_app_increment", arguments: { count: 3 } },
      { approvalToken: retry.needsApproval.token },
    );
    expect(reused.needsApproval).toBeDefined();
    // Read-only tools follow the model's policy: no prompt.
    const read = await rpc("tools/call", { name: "fixture_app_read", arguments: {} });
    expect(read.result.structuredContent).toEqual({ count: 4 });
  });

  it("runs without prompts in full access and refuses non-object structuredContent", async () => {
    runtimeMode = "full-access";
    const bad = await rpc("tools/call", { name: "fixture_bad_structured", arguments: {} });
    expect(bad.error.code).toBe(-32603);
    expect(bad.error.message).toContain("structuredContent of type 'array'");
    runtimeMode = "approval-required";
  });

  it("forwards resources and prompts to the widget's own server", async () => {
    const read = await rpc("resources/read", { uri: "fixture://files/report.txt" });
    expect(read.result.contents[0]).toMatchObject({ text: "Fixture report\n" });
    const list = await rpc("resources/list", {});
    expect(list.result.resources).toHaveLength(2);
    const templates = await rpc("resources/templates/list", {});
    expect(templates.result.resourceTemplates[0].uriTemplate).toBe("fixture://files/{name}");
    const prompts = await rpc("prompts/list", {});
    expect(prompts.result.prompts[0].name).toBe("fixture_prompt");
  });

  it("keeps widgets on their own server and call", async () => {
    const wrongServer = await post(MCP_APP_RPC_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      server: "other_server",
      method: "tools/list",
    });
    expect(wrongServer.status).toBe(403);
    const unknownCall = await post(MCP_APP_RPC_ROUTE_PATH, {
      threadId: THREAD,
      callId: "unknown-call",
      server: SERVER,
      method: "tools/list",
    });
    expect(unknownCall.status).toBe(404);
    const badMethod = await post(MCP_APP_RPC_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      server: SERVER,
      method: "sampling/createMessage",
    });
    expect(badMethod.status).toBe(400);
  });

  it("stores model context per tool, snapshots it on send and enforces the limits", async () => {
    const ok = await post(MCP_APP_MODEL_CONTEXT_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      toolName: "fixture_show_widget",
      content: [{ type: "text", text: "counter=4" }],
      structuredContent: { count: 4 },
    });
    expect(await ok.json()).toEqual({});
    expect(service.modelContext.snapshotForSend(THREAD)).toEqual(["fixture_show_widget"]);
    expect(service.modelContext.readSnapshot(THREAD, "fixture_show_widget").content).toEqual([
      {
        type: "text",
        text: "以下是小组件 fixture_show_widget 在用户上次发送消息时分享的内容。在用户发送下一条消息之前，再次读取会得到相同的结果。",
      },
      { type: "text", text: "counter=4" },
      { type: "text", text: 'structuredContent: {"count":4}' },
    ]);
    const tooBig = await post(MCP_APP_MODEL_CONTEXT_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      toolName: "fixture_show_widget",
      content: [{ type: "text", text: "x".repeat(90_000) }],
    });
    expect(await tooBig.json()).toEqual({
      error: {
        message: "ui/update-model-context content is ~20000 tokens; host limit is 16000 tokens.",
      },
    });
    const otherTool = await post(MCP_APP_MODEL_CONTEXT_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      toolName: "fixture_app_read",
      content: [{ type: "text", text: "x" }],
    });
    expect(((await otherTool.json()) as { error: { message: string } }).error.message).toContain(
      "its own tool",
    );
  });

  it("downloads resource links through the same client", async () => {
    const response = await post(MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH, {
      threadId: THREAD,
      callId: CALL,
      server: SERVER,
      uri: "fixture://files/report.txt",
    });
    expect(await response.json()).toEqual({
      contents: [
        { uri: "fixture://files/report.txt", mimeType: "text/plain", text: "Fixture report\n" },
      ],
    });
    const otherServer = await post(MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH, {
      threadId: THREAD,
      server: "other_server",
      uri: "fixture://files/report.txt",
    });
    expect(otherServer.status).toBe(403);
  });

  it("refuses a stored binding that names no server", async () => {
    await service.results.put({
      threadId: THREAD,
      callId: "call-no-server",
      binding: { resourceUri: "ui://fixture/widget.html", source: "resultMeta" },
      state: "ready",
      input: {},
      result: { content: [] },
      updatedAt: 1,
    });
    const rpcResponse = await post(MCP_APP_RPC_ROUTE_PATH, {
      threadId: THREAD,
      callId: "call-no-server",
      server: SERVER,
      method: "tools/list",
    });
    expect(rpcResponse.status).toBe(403);
    const read = await post(MCP_APP_RESOURCE_READ_ROUTE_PATH, {
      threadId: THREAD,
      callId: "call-no-server",
      server: SERVER,
      resourceUri: "ui://fixture/widget.html",
      source: "resultMeta",
    });
    expect(read.status).toBe(403);
    const download = await post(MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH, {
      threadId: THREAD,
      callId: "call-no-server",
      server: SERVER,
      uri: "fixture://files/report.txt",
    });
    expect(download.status).toBe(403);
  });

  it("applies the same auth, origin and body rules as the resource route", async () => {
    const noToken = await fetch(`${mossOrigin}${MCP_APP_RPC_ROUTE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noToken.status).toBe(401);
    const evil = await post(
      MCP_APP_TOOL_RESULT_ROUTE_PATH,
      { threadId: THREAD, callId: CALL },
      {
        Origin: "https://evil.example.test",
      },
    );
    expect(evil.status).toBe(403);
    const invalid = await post(MCP_APP_TOOL_RESULT_ROUTE_PATH, { threadId: THREAD });
    expect(invalid.status).toBe(400);
    const huge = await post(MCP_APP_TOOL_RESULT_ROUTE_PATH, "x".repeat(20_000));
    expect(huge.status).toBe(413);
    const preflight = await fetch(`${mossOrigin}${MCP_APP_RPC_ROUTE_PATH}`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});
