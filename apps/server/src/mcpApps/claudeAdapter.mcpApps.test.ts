// FILE: claudeAdapter.mcpApps.test.ts
// Purpose: The Claude path of interactive connectors end to end through the real ClaudeAdapter,
//   replaying what Claude Code 2.1.318 actually sent against the fixture server (recorded with
//   a fake key and a stub Messages API, see __fixtures__/claude-code-2.1.318-mcp-apps.json):
//   tool definitions with `_meta.ui` from mcpServerStatus() → binding on the MCP row → full
//   result in the store → readMcpResource → mcp_call with result_not_for_model.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import { ThreadId, type ProviderRuntimeEvent } from "@moss/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterAll } from "vitest";

import { ServerConfig } from "../config.ts";
import { makeClaudeAdapterLive } from "../provider/Layers/ClaudeAdapter.ts";
import { ClaudeAdapter } from "../provider/Services/ClaudeAdapter.ts";
import { McpAppServiceLive } from "./Layers/McpAppService.ts";
import { McpAppService } from "./Services/McpAppService.ts";

const recording = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "__fixtures__", "claude-code-2.1.318-mcp-apps.json"),
    "utf8",
  ),
) as {
  readonly init: Record<string, unknown>;
  readonly assistantToolUse: { readonly message: { readonly content: unknown[] } };
  readonly userToolResult: Record<string, unknown>;
  readonly mcpServerStatus: unknown[];
  readonly readMcpResource: { readonly contents: Array<Record<string, unknown>> };
  readonly mcpCallResultNotForModel: unknown;
};

const SESSION = "sdk-session-mcp-apps";
const TOOL_USE_ID = "toolu_fixture_0001";
const WIDGET_HTML = "<!doctype html><title>fixture</title>";

/** Minimal Agent SDK `Query` double that replays the recording. */
class ReplayQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: SDKMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private done = false;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly resourceReads: Array<{ server: string; uri: string }> = [];

  emit(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message as SDKMessage });
    else this.queue.push(message as SDKMessage);
  }

  readonly interrupt = async () => {};
  readonly stopTask = async () => {};
  readonly backgroundTasks = async () => true;
  readonly setModel = async () => {};
  readonly setPermissionMode = async () => {};
  readonly setMaxThinkingTokens = async () => {};
  readonly applyFlagSettings = async () => {};
  readonly getContextUsage = async () => {
    throw new Error("unused");
  };
  readonly supportedCommands = async () => [];
  readonly supportedModels = async () => [];
  readonly supportedAgents = async () => [];
  readonly mcpServerStatus = async () => recording.mcpServerStatus;
  readonly readMcpResource = async (server: string, uri: string) => {
    this.resourceReads.push({ server, uri });
    return {
      contents: recording.readMcpResource.contents.map((content) => ({
        ...content,
        text: WIDGET_HTML,
      })),
    };
  };
  readonly request = async (request: Record<string, unknown>) => {
    this.requests.push(request);
    return recording.mcpCallResultNotForModel;
  };
  readonly close = () => {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const stateRoot = mkdtempSync(path.join(os.tmpdir(), "moss-mcp-apps-claude-"));
afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

function makeLayer(query: ReplayQuery) {
  return makeClaudeAdapterLive({ createQuery: () => query as never }).pipe(
    Layer.provideMerge(McpAppServiceLive),
    Layer.provideMerge(ServerConfig.layerTest(stateRoot, stateRoot)),
    Layer.provideMerge(NodeServices.layer),
  );
}

const waitFor = (check: () => boolean) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

function emitTurn(query: ReplayQuery, init: Record<string, unknown>) {
  query.emit({ ...init, session_id: SESSION, uuid: "init-1" });
  return () => {
    query.emit({
      type: "stream_event",
      session_id: SESSION,
      uuid: "stream-1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: recording.assistantToolUse.message.content[0],
      },
    });
    query.emit({
      type: "assistant",
      session_id: SESSION,
      uuid: "assistant-1",
      parent_tool_use_id: null,
      message: { id: "msg-1", content: recording.assistantToolUse.message.content },
    });
    query.emit({ ...recording.userToolResult, session_id: SESSION, uuid: "user-1" });
    query.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      errors: [],
      session_id: SESSION,
      uuid: "result-1",
    });
  };
}

it.effect("binds a Claude Code MCP App row and reaches the widget's server through the SDK", () => {
  const query = new ReplayQuery();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const mcpApps = yield* McpAppService;
    const threadId = ThreadId.makeUnsafe("thread-claude-mcp-apps");
    const eventsFiber = yield* adapter.streamEvents.pipe(
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* adapter.startSession({ threadId, provider: "claudeAgent", runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "Show the fixture widget.", attachments: [] });
    const rest = emitTurn(query, recording.init);
    // init → mcpServerStatus(): the tool definitions arrive before the row streams.
    yield* waitFor(() => mcpApps.providerTools(threadId, "fixture") !== undefined);
    const definitions = mcpApps.providerTools(threadId, "fixture") ?? [];
    assert.deepEqual(
      definitions.map((definition) => [definition.name, definition.resourceUri ?? null]),
      [
        ["fixture_show_widget", "ui://fixture/widget.html"],
        ["fixture_app_increment", "ui://fixture/widget.html"],
        ["fixture_app_read", "ui://fixture/widget.html"],
        ["fixture_model_only", null],
        ["fixture_bad_structured", "ui://fixture/widget.html"],
      ],
    );
    rest();
    const events = Array.from(yield* Fiber.join(eventsFiber)) as ProviderRuntimeEvent[];
    const bound = events.map((event) => mcpApps.enrichRuntimeEvent(event));
    const completed = bound.find(
      (event) =>
        event.type === "item.completed" &&
        (event.payload as { data?: { kind?: string } }).data?.kind === "codex.mcp_tool_call",
    );
    assert.isDefined(completed, "the Claude MCP row is projected");
    const payload = completed!.payload as {
      itemType: string;
      data: {
        status: string;
        app: Record<string, unknown>;
        result?: { structuredContent?: unknown };
      };
    };
    assert.equal(payload.itemType, "mcp_tool_call");
    assert.equal(payload.data.status, "completed");
    assert.deepEqual(payload.data.app, {
      resourceUri: "ui://fixture/widget.html",
      source: "toolDefinition",
      server: "fixture",
      serverKey: "fixture",
      serverLabel: "fixture",
      toolName: "fixture_show_widget",
      isFirstParty: false,
      visibility: ["model", "app"],
    });
    assert.deepEqual(payload.data.result?.structuredContent, {
      greeting: "Hello, Moss!",
      count: 3,
      items: ["one", "two", "three"],
    });

    // Full result in the runtime store (what /tool-result serves); SDK tool_use_result kept.
    yield* Effect.promise(() => mcpApps.results.flush());
    const record = yield* mcpApps.callRecord(threadId, TOOL_USE_ID);
    assert.equal(record?.state, "ready");
    assert.deepEqual(record?.input, { name: "Moss", count: 3 });
    assert.deepEqual(
      (record?.result as { structuredContent?: unknown } | undefined)?.structuredContent,
      {
        greeting: "Hello, Moss!",
        count: 3,
        items: ["one", "two", "three"],
      },
    );

    const resource = yield* adapter.readMcpAppResource!({
      threadId,
      callId: TOOL_USE_ID,
      server: "fixture",
      resourceUri: "ui://fixture/widget.html",
      source: "toolDefinition",
    });
    assert.equal(resource.state, "ready");
    if (resource.state === "ready") {
      assert.equal(resource.html, WIDGET_HTML);
      assert.deepEqual(resource.csp.connectDomains, [
        "https://api.fixture.example",
        "https://cdn.fixture.example",
      ]);
      assert.deepEqual(resource.permissions, { clipboardWrite: true });
      assert.equal(resource.prefersBorder, true);
      assert.equal(resource.stableOrigin, false, "CLI-own servers never get a stable origin");
    }
    assert.deepEqual(query.resourceReads, [{ server: "fixture", uri: "ui://fixture/widget.html" }]);

    const result = yield* adapter.callMcpAppTool!({
      threadId,
      server: "fixture",
      toolName: "fixture_app_increment",
      arguments: { count: 3 },
    });
    assert.deepEqual(query.requests, [
      {
        subtype: "mcp_call",
        tool: "mcp__fixture__fixture_app_increment",
        arguments: { count: 3 },
        result_not_for_model: true,
      },
    ]);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "Counter is now 4." }],
      structuredContent: { count: 4 },
    });
  }).pipe(Effect.provide(makeLayer(query)));
});

it.effect("refuses widget calls with a plain error when the CLI lacks the capability", () => {
  const query = new ReplayQuery();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = ThreadId.makeUnsafe("thread-claude-old-cli");
    yield* adapter.startSession({ threadId, provider: "claudeAgent", runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
    query.emit({
      type: "system",
      subtype: "init",
      session_id: SESSION,
      uuid: "init-old",
      tools: [],
      // An older CLI says what it supports, and widget calls are not in it.
      capabilities: ["interrupt_receipt_v1"],
    });
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const failure = yield* adapter.callMcpAppTool!({
      threadId,
      server: "fixture",
      toolName: "fixture_app_read",
      arguments: {},
    }).pipe(Effect.flip);
    assert.include(String(failure.message), "mcp_call_result_not_for_model_v1");
    assert.deepEqual(query.requests, []);
  }).pipe(Effect.provide(makeLayer(query)));
});

it.effect("tries widget calls and reads before init, and refuses non-ui reads clearly", () => {
  const query = new ReplayQuery();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = ThreadId.makeUnsafe("thread-claude-resumed");
    // A resumed session that has not run a turn has sent no system/init yet.
    yield* adapter.startSession({ threadId, provider: "claudeAgent", runtimeMode: "full-access" });
    const result = yield* adapter.callMcpAppTool!({
      threadId,
      server: "fixture",
      toolName: "fixture_app_increment",
      arguments: { count: 3 },
    });
    assert.deepEqual(result.structuredContent, { count: 4 });
    const resource = yield* adapter.readMcpAppResource!({
      threadId,
      callId: TOOL_USE_ID,
      server: "fixture",
      resourceUri: "ui://fixture/widget.html",
      source: "toolDefinition",
    });
    assert.equal(resource.state, "ready");
    const refused = yield* adapter.readMcpResourceContents!({
      threadId,
      server: "fixture",
      uri: "fixture://files/report.txt",
    }).pipe(Effect.flip);
    const cause = (refused as { cause?: { code?: number; message?: string } }).cause;
    assert.equal(cause?.code, -32602);
    assert.include(String(cause?.message), "can read only ui:// resources");
    assert.deepEqual(query.resourceReads, [{ server: "fixture", uri: "ui://fixture/widget.html" }]);
  }).pipe(Effect.provide(makeLayer(query)));
});
