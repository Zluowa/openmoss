// Unit tests for the interactive-connector runtime: row binding for each provider shape, the
// model-context store and hint, the disk result store, and Moss's connector MCP client.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { CodexMcpToolCallProjection, ThreadId, type ProviderRuntimeEvent } from "@moss/contracts";
import { Option, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHttp } from "../../test-fixtures/mcp-apps/server.mjs";
import {
  projectCodexMcpAppDescriptor,
  codexMcpAppServerTools,
} from "../provider/Layers/CodexAdapter";
import { parseQualifiedToolName } from "./binding";
import { McpAppConnectorClient, McpAppRpcFailure } from "./connectorClient";
import { makeMcpAppServiceState } from "./Layers/McpAppService";
import {
  appendWidgetContextHint,
  McpAppModelContextStore,
  widgetContextHint,
} from "./modelContext";
import { McpAppResultStore } from "./resultStore";

const tmpRoots: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const event = (type: string, payload: Record<string, unknown>, threadId = "thread-1") =>
  ({
    type,
    eventId: `e-${Math.random()}`,
    provider: "codex",
    createdAt: new Date(0).toISOString(),
    threadId: ThreadId.makeUnsafe(threadId),
    payload,
  }) as unknown as ProviderRuntimeEvent;

const uiTool = (name: string, visibility?: string[]) => ({
  name,
  title: `${name} title`,
  _meta: { ui: { resourceUri: `ui://x/${name}.html`, ...(visibility ? { visibility } : {}) } },
});

describe("binding MCP rows", () => {
  it("prefers the Codex tool definition (mcpAppUi) over result fallbacks", () => {
    expect(
      projectCodexMcpAppDescriptor({
        mcpAppUi: { resourceUri: "ui://def/a.html", preferredModelDisplayMode: "inline" },
        result: { content: [], _meta: { ui: { resourceUri: "ui://result/a.html" } } },
      }),
    ).toEqual({ resourceUri: "ui://def/a.html", source: "toolDefinition" });
    expect(
      projectCodexMcpAppDescriptor({
        result: { content: [], _meta: { "openai/outputTemplate": "ui://o" } },
      }),
    ).toEqual({ resourceUri: "ui://o", source: "resultMeta" });
  });

  it("turns mcpServerStatus/list entries into tool lists", () => {
    expect(
      codexMcpAppServerTools([
        {
          name: "srv",
          tools: { show: { inputSchema: {}, _meta: { ui: { resourceUri: "ui://s" } } } },
          resources: [],
        },
      ]),
    ).toEqual([
      {
        server: "srv",
        tools: [{ name: "show", inputSchema: {}, _meta: { ui: { resourceUri: "ui://s" } } }],
        resources: [],
        resourceTemplates: [],
      },
    ]);
  });

  it("completes a Codex projection's app with the binding and keeps fallbacks", () => {
    const service = makeMcpAppServiceState({ resultsDirectory: tmp("bind-codex-") });
    service.recordProviderTools("thread-1", "srv", [uiTool("show", ["model", "app"])]);
    const data = {
      kind: "codex.mcp_tool_call",
      version: 1,
      callId: "call-1",
      server: "srv",
      tool: "show",
      status: "completed",
      arguments: { a: 1 },
      result: { content: [{ type: "text", text: "ok" }] },
      truncation: { truncated: false, deferredBinary: false },
      app: { resourceUri: "ui://x/show.html", source: "toolDefinition" },
    };
    service.captureCall({
      threadId: "thread-1",
      callId: "call-1",
      input: { a: 1, long: "full" },
      result: { content: [{ type: "text", text: "ok" }], structuredContent: { big: true } },
    });
    const bound = service.enrichRuntimeEvent(
      event("item.completed", { itemType: "mcp_tool_call", data }),
    );
    expect((bound.payload as { data: { app: unknown } }).data.app).toEqual({
      resourceUri: "ui://x/show.html",
      source: "toolDefinition",
      server: "srv",
      serverKey: "srv",
      serverLabel: "srv",
      toolName: "show",
      toolTitle: "show title",
      isFirstParty: false,
      visibility: ["model", "app"],
    });
    expect(service.isCallPending("thread-1", "call-1")).toBe(false);
    const record = service.results.peek("thread-1", "call-1");
    expect(record?.state).toBe("ready");
    expect(record?.input).toEqual({ a: 1, long: "full" });
    expect(record?.result).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { big: true },
    });

    // codex_apps apps each keep their own key.
    const appsData = {
      ...data,
      callId: "call-2",
      server: "codex_apps",
      status: "inProgress",
      result: undefined,
      app: { ...data.app, connectorId: "linear" },
    };
    const appsBound = service.enrichRuntimeEvent(
      event("item.started", { itemType: "mcp_tool_call", data: appsData }),
    );
    expect((appsBound.payload as { data: { app: { serverKey: string } } }).data.app.serverKey).toBe(
      "codex_apps/linear",
    );
    expect(service.isCallPending("thread-1", "call-2")).toBe(true);
  });

  it("projects Claude mcp__ rows only when the tool declares a widget", () => {
    const service = makeMcpAppServiceState({ resultsDirectory: tmp("bind-claude-") });
    service.recordProviderTools("thread-1", "my.server", [uiTool("show"), { name: "plain" }]);
    const row = (toolName: string) =>
      event("item.started", {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: { toolCallId: "toolu_1", callId: "toolu_1", toolName, input: { q: 1 } },
      });
    const plain = row("mcp__my_server__plain");
    expect(service.enrichRuntimeEvent(plain)).toBe(plain);
    const bound = service.enrichRuntimeEvent(row("mcp__my_server__show"));
    const data = (bound.payload as { data: Record<string, any> }).data;
    expect(data.kind).toBe("codex.mcp_tool_call");
    expect(data.status).toBe("inProgress");
    expect(data.result).toBeUndefined();
    expect(data.toolName).toBe("mcp__my_server__show");
    expect(data.app).toMatchObject({ server: "my.server", toolName: "show", visibility: [] });
  });

  it("records a failed Claude row as failed with its reason", () => {
    const service = makeMcpAppServiceState({ resultsDirectory: tmp("bind-failed-") });
    service.recordProviderTools("thread-1", "fixture", [uiTool("bad")]);
    service.enrichRuntimeEvent(
      event("item.completed", {
        itemType: "mcp_tool_call",
        status: "failed",
        data: {
          toolCallId: "toolu_bad",
          toolName: "mcp__fixture__bad",
          input: {},
          result: { type: "tool_result", content: "returned a malformed result", is_error: true },
        },
      }),
    );
    expect(service.results.peek("thread-1", "toolu_bad")).toMatchObject({
      state: "failed",
      error: "returned a malformed result",
    });
  });

  it("projects a failed Claude row (isError, string content) as a readable failed projection", () => {
    // The Claude CLI hands an isError MCP result back as a tool_result whose content is one
    // string. The row must still decode as the projection the web reads, or the card never
    // learns the call failed and keeps loading.
    const service = makeMcpAppServiceState({ resultsDirectory: tmp("bind-failed-text-") });
    service.recordProviderTools("thread-1", "debug", [uiTool("debug-tool")]);
    for (const type of ["item.updated", "item.completed"]) {
      const bound = service.enrichRuntimeEvent(
        event(type, {
          itemType: "mcp_tool_call",
          status: "failed",
          data: {
            toolCallId: "toolu_err",
            toolName: "mcp__debug__debug-tool",
            input: { simulateError: true },
            result: {
              type: "tool_result",
              tool_use_id: "toolu_err",
              content: "Debug text content #1\nDebug text content #2",
              is_error: true,
            },
          },
        }),
      );
      const data = (bound.payload as { data: Record<string, unknown> }).data;
      const decoded = Schema.decodeUnknownOption(CodexMcpToolCallProjection)(data);
      expect(Option.isSome(decoded)).toBe(true);
      expect(data).toMatchObject({
        status: "failed",
        result: {
          content: [{ type: "text", text: "Debug text content #1\nDebug text content #2" }],
        },
        error: { message: "Debug text content #1\nDebug text content #2" },
      });
      expect((data.result as Record<string, unknown>).type).toBeUndefined();
    }
    expect(service.results.peek("thread-1", "toolu_err")?.state).toBe("failed");
  });

  it("never changes an earlier call of the same tool when a later one fails", () => {
    const service = makeMcpAppServiceState({ resultsDirectory: tmp("bind-two-calls-") });
    service.recordProviderTools("thread-1", "debug", [uiTool("debug-tool")]);
    const row = (callId: string, status: "completed" | "failed", result: unknown) =>
      event("item.completed", {
        itemType: "mcp_tool_call",
        status,
        data: {
          toolCallId: callId,
          toolName: "mcp__debug__debug-tool",
          input: {},
          result: { type: "tool_result", tool_use_id: callId, ...(result as object) },
        },
      });
    service.enrichRuntimeEvent(
      row("toolu_b", "completed", { content: [{ type: "text", text: "live" }] }),
    );
    service.modelContext.update({
      threadId: "thread-1",
      callId: "toolu_b",
      toolName: "mcp__debug__debug-tool",
      blocks: [{ type: "text", text: "Current app state info" }],
    });
    service.enrichRuntimeEvent(row("toolu_f", "failed", { content: "boom", is_error: true }));
    expect(service.results.peek("thread-1", "toolu_b")).toMatchObject({
      state: "ready",
      result: { content: [{ type: "text", text: "live" }] },
    });
    expect(service.results.peek("thread-1", "toolu_f")?.state).toBe("failed");
    expect(service.isCallPending("thread-1", "toolu_b")).toBe(false);
    expect(service.modelContext.snapshotForSend("thread-1")).toEqual(["mcp__debug__debug-tool"]);
  });

  it("binds gateway tools as first-party and never matches unknown names", () => {
    const service = makeMcpAppServiceState({ resultsDirectory: tmp("bind-gw-") });
    service.registerGateway({
      listTools: () => [uiTool("moss_widget")],
      callTool: () => {
        throw new Error("unused");
      },
    });
    const bound = service.enrichRuntimeEvent(
      event("item.completed", {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          toolCallId: "c9",
          toolName: "mcp__moss__moss_widget",
          input: {},
          result: { content: "done" },
        },
      }),
    );
    expect((bound.payload as { data: Record<string, any> }).data.app).toMatchObject({
      serverKey: "moss",
      serverLabel: "Moss",
      isFirstParty: true,
    });
    expect(parseQualifiedToolName("moss_widget_extra", ["moss"], () => false)).toBeUndefined();
    expect(parseQualifiedToolName("a_b_c", ["a", "a_b"], (server) => server === "a_b")).toEqual({
      server: "a_b",
      tool: "c",
    });
  });
});

describe("model context", () => {
  it("keeps the last write per tool, drops failed calls and snapshots on send", () => {
    const store = new McpAppModelContextStore(() => 0);
    expect(
      store.update({
        threadId: "t",
        callId: "c1",
        toolName: "a",
        blocks: [{ type: "text", text: "1" }],
      }),
    ).toEqual({
      ok: true,
    });
    store.update({
      threadId: "t",
      callId: "c2",
      toolName: "a",
      blocks: [{ type: "text", text: "2" }],
    });
    store.update({
      threadId: "t",
      callId: "c3",
      toolName: "b",
      blocks: [{ type: "text", text: "x" }],
    });
    store.dropCall("t", "c3");
    expect(store.readSnapshot("t", "a").content[0]).toMatchObject({ type: "text" });
    expect(store.snapshotForSend("t")).toEqual(["a"]);
    expect(store.readSnapshot("t", "a").content.at(-1)).toEqual({ type: "text", text: "2" });
    // Later writes stay invisible until the next send.
    store.update({
      threadId: "t",
      callId: "c2",
      toolName: "a",
      blocks: [{ type: "text", text: "3" }],
    });
    expect(store.readSnapshot("t", "a").content.at(-1)).toEqual({ type: "text", text: "2" });
    expect(store.readSnapshot("t", "missing").isError).toBe(true);
    // The model may name the tool the way its agent CLI does.
    for (const name of ["mcp__srv__a", "mcp__my_server__a", "srv__a", "srv:a", " a "]) {
      expect(store.readSnapshot("t", name).content.at(-1), name).toEqual({
        type: "text",
        text: "2",
      });
    }
    expect(store.readSnapshot("t", "mcp__srv__b").isError).toBe(true);
    expect(
      store.update({
        threadId: "t",
        callId: "c4",
        toolName: "big",
        blocks: [{ type: "text", text: "x".repeat(950_000) }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("appends the hint to user text but not to slash commands", () => {
    expect(appendWidgetContextHint("hello", ["a", "b"])).toBe(
      `hello\n\n${widgetContextHint(["a", "b"])}`,
    );
    expect(widgetContextHint(["a"])).toBe(
      "<widget_context_hint>本对话中有可交互小组件：a。要读取某个小组件的当前状态，调用 moss_read_widget_context 并传入它的 tool_name。</widget_context_hint>",
    );
    expect(appendWidgetContextHint("/compact", ["a"])).toBe("/compact");
    expect(appendWidgetContextHint("hello", [])).toBe("hello");
  });
});

describe("result store", () => {
  it("persists across instances, omits oversized results and evicts least recent", async () => {
    const dir = tmp("store-");
    const binding = { resourceUri: "ui://x", source: "toolDefinition" as const };
    const first = new McpAppResultStore(dir, { maxRecordBytes: 2_000, maxTotalBytes: 1_500 });
    await first.put({
      threadId: "t",
      callId: "a",
      binding,
      state: "ready",
      result: { content: [] },
      updatedAt: 1,
    });
    await first.put({
      threadId: "t",
      callId: "big",
      binding,
      state: "ready",
      result: { content: [{ type: "text", text: "x".repeat(5_000) }] },
      updatedAt: 2,
    });
    const reopened = new McpAppResultStore(dir);
    expect((await reopened.get("t", "a"))?.result).toEqual({ content: [] });
    expect((await reopened.get("t", "big"))?.resultOmitted).toBe("too_large");
    for (let index = 0; index < 20; index += 1) {
      await first.put({
        threadId: "t",
        callId: `n${index}`,
        binding,
        state: "pending",
        updatedAt: 3 + index,
      });
    }
    await first.flush();
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeLessThan(22);
    expect(await new McpAppResultStore(dir).get("t", "a")).toBeUndefined();
  });
});

describe("connector client", () => {
  let fixture: http.Server;
  let url: string;
  beforeAll(async () => {
    fixture = await startHttp(0);
    const address = fixture.address();
    if (!address || typeof address !== "object") throw new Error("no address");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });
  afterAll(() => new Promise<void>((resolve) => fixture.close(() => resolve())));

  const forward =
    (sessions: string[]) =>
    async (request: {
      method: "POST" | "DELETE";
      body?: unknown;
      sessionId?: string | undefined;
    }) => {
      if (request.sessionId) sessions.push(request.sessionId);
      const response = await fetch(url, {
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
        body: text
          ? ({ kind: "json", value: JSON.parse(text) } as const)
          : ({ kind: "empty" } as const),
      };
    };

  it("initializes once, keeps the session and surfaces JSON-RPC errors", async () => {
    const sessions: string[] = [];
    const client = new McpAppConnectorClient(forward(sessions), "1.0.0");
    const tools = (await client.request("tools/list", undefined)) as { tools: unknown[] };
    expect(tools.tools).toHaveLength(5);
    await client.request("ping", undefined);
    expect(new Set(sessions).size).toBe(1);
    await expect(client.request("resources/read", { uri: "ui://nope" })).rejects.toBeInstanceOf(
      McpAppRpcFailure,
    );
    await client.close();
  });

  it("opens a new session when the server forgets the old one", async () => {
    let drop = true;
    const base = forward([]);
    const client = new McpAppConnectorClient(async (request) => {
      if (drop && request.sessionId && (request.body as { method?: string })?.method === "ping") {
        drop = false;
        return { status: 404, sessionId: null, body: { kind: "json", value: { error: "gone" } } };
      }
      return base(request);
    }, "1.0.0");
    await client.request("tools/list", undefined);
    await expect(client.request("ping", undefined)).resolves.toEqual({});
  });
});
