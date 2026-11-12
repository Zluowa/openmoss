// FILE: providerFallback.test.ts
// Purpose: CLI-own servers (Claude, Codex) when their session is not running: the last good
//   widget resource is served from the runtime store (and survives a server restart), a live
//   read refreshes it, and the agent CLI's own refusals reach the widget as clear JSON-RPC errors.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpAppResourceReadInput, McpAppResourceReadResult } from "@moss/contracts";
import { ThreadId } from "@moss/contracts";
import { Effect, Layer, Option } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderAdapterRequestError } from "../provider/Errors";
import { ProviderService, type ProviderServiceShape } from "../provider/Services/ProviderService";
import { McpAppRpcFailure } from "./connectorClient";
import { makeMcpAppServiceState } from "./Layers/McpAppService";
import { readMcpAppResourceOperation, readMcpAppToolResult, runMcpAppRpc } from "./operations";
import { McpAppService } from "./Services/McpAppService";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const THREAD = "thread-provider-fallback";
const input: McpAppResourceReadInput = {
  threadId: ThreadId.makeUnsafe(THREAD),
  callId: "toolu_1",
  server: "fixture",
  resourceUri: "ui://fixture/widget.html",
  source: "toolDefinition",
};
const ready = (html: string): McpAppResourceReadResult => ({
  state: "ready",
  resourceUri: input.resourceUri,
  html,
  sizeBytes: Buffer.byteLength(html),
  mimeType: "text/html;profile=mcp-app",
  csp: {
    baseUriDomains: [],
    connectDomains: [],
    frameDomains: [],
    includeDefaultDomains: false,
    isTrusted: true,
    resourceDomains: [],
  },
  prefersBorder: true,
  isCollapsible: true,
  widgetDomain: null,
  permissions: { clipboardWrite: true },
  stableOrigin: false,
});

function makeHome() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-ic-fallback-"));
  roots.push(root);
  return path.join(root, "results");
}

function provider(state: {
  live: boolean;
  reads: number;
  read: () => Effect.Effect<McpAppResourceReadResult, ProviderAdapterRequestError>;
}) {
  return {
    listSessions: () =>
      Effect.succeed(state.live ? [{ threadId: THREAD, status: "ready" } as never] : []),
    readMcpAppResource: () => {
      state.reads += 1;
      return state.read();
    },
    listMcpAppTools: () => Effect.succeed([{ server: "fixture", tools: [] }]),
    readMcpResourceContents: () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "mcp_read_resource",
          detail: "refused",
          cause: new McpAppRpcFailure(
            -32602,
            "This host can read only ui:// resources from this server.",
          ),
        }),
      ),
  } as unknown as ProviderServiceShape;
}

const shell = {
  getThreadShellById: () =>
    Effect.succeed(Option.some({ modelSelection: { provider: "claudeAgent" }, session: null })),
};

function run<A, E>(
  effect: Effect.Effect<A, E, McpAppService | ProviderService>,
  service: ReturnType<typeof makeMcpAppServiceState>,
  providerService: ProviderServiceShape,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(McpAppService, service),
          Layer.succeed(ProviderService, providerService),
          Layer.succeed(ProjectionSnapshotQuery, shell as never),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  );
}

describe("CLI-own widget resources without a live session", () => {
  it("keeps the last good read, serves it while the CLI is not running, and survives a restart", async () => {
    const results = makeHome();
    const first = makeMcpAppServiceState({ resultsDirectory: results });
    const state: Parameters<typeof provider>[0] = {
      live: true,
      reads: 0,
      read: () => Effect.succeed(ready("<p>v1</p>")),
    };
    expect(await run(readMcpAppResourceOperation(input), first, provider(state))).toMatchObject({
      html: "<p>v1</p>",
      stableOrigin: false,
    });
    await first.stop();

    // A new server process with the same home, the provider session not started.
    const second = makeMcpAppServiceState({ resultsDirectory: results });
    state.live = false;
    expect(await run(readMcpAppResourceOperation(input), second, provider(state))).toMatchObject({
      html: "<p>v1</p>",
      permissions: { clipboardWrite: true },
    });
    expect(state.reads).toBe(1);

    // Live again: read fresh and refresh the copy; a failing live read falls back to it.
    state.live = true;
    state.read = () => Effect.succeed(ready("<p>v2</p>"));
    expect(
      (await run(readMcpAppResourceOperation(input), second, provider(state))) as { html: string },
    ).toMatchObject({
      html: "<p>v2</p>",
    });
    await second.resources.flush();
    state.read = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "mcp_read_resource",
          detail: "down",
        }),
      );
    expect(await run(readMcpAppResourceOperation(input), second, provider(state))).toMatchObject({
      html: "<p>v2</p>",
    });
    await second.stop();
  });

  it("asks the provider (which starts or resumes the session) when nothing is stored", async () => {
    const service = makeMcpAppServiceState({ resultsDirectory: makeHome() });
    const state = {
      live: false,
      reads: 0,
      read: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "mcp_read_resource",
            detail: "down",
          }),
        ),
    };
    await expect(
      run(readMcpAppResourceOperation(input), service, provider(state)),
    ).rejects.toBeDefined();
    expect(state.reads).toBe(1);
    await service.stop();
  });
});

describe("agent CLI refusals reach the widget as JSON-RPC errors", () => {
  it("maps the CLI's own refusal and an unavailable list method", async () => {
    const service = makeMcpAppServiceState({ resultsDirectory: makeHome() });
    await service.results.put({
      threadId: THREAD,
      callId: "toolu_1",
      binding: {
        resourceUri: input.resourceUri,
        source: "toolDefinition",
        server: "fixture",
        serverKey: "fixture",
        serverLabel: "fixture",
        toolName: "fixture_show_widget",
        isFirstParty: false,
        visibility: [],
      },
      state: "ready",
      updatedAt: 1,
    });
    const state = { live: true, reads: 0, read: () => Effect.succeed(ready("x")) };
    const rpc = (method: "resources/read" | "resources/list" | "prompts/list", params = {}) =>
      run(
        runMcpAppRpc({
          threadId: input.threadId,
          callId: "toolu_1",
          server: "fixture",
          method,
          params,
        }),
        service,
        provider(state),
      );
    expect(await rpc("resources/read", { uri: "fixture://files/report.txt" })).toEqual({
      error: { code: -32602, message: "This host can read only ui:// resources from this server." },
    });
    expect(await rpc("resources/list")).toEqual({
      error: {
        code: -32601,
        message:
          "Method not found: resources/list is not available for this server, because its agent CLI gives a host no way to reach it.",
      },
    });
    expect((await rpc("prompts/list")) as { error: { code: number } }).toMatchObject({
      error: { code: -32601 },
    });
    await service.stop();
  });
});

describe("CLI-own tool lists without a live session", () => {
  const binding = {
    resourceUri: input.resourceUri,
    source: "toolDefinition" as const,
    server: "fixture",
    serverKey: "fixture",
    serverLabel: "fixture",
    toolName: "fixture_show_widget",
    isFirstParty: false,
    visibility: [],
  };
  const fullList = [
    {
      name: "fixture_show_widget",
      _meta: { ui: { resourceUri: input.resourceUri, visibility: ["model", "app"] } },
    },
    {
      name: "fixture_app_read",
      annotations: { readOnly: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    { name: "fixture_model_only", _meta: { ui: { visibility: ["model"] } } },
  ];
  // What a resumed CLI lists from its discovery cache: model-visible tools only.
  const discoveryCacheList = fullList.filter((tool) => tool.name !== "fixture_app_read");

  function toolsProvider(state: {
    live: boolean;
    listings: number;
    list: ReadonlyArray<Record<string, unknown>>;
    calls: string[];
  }) {
    return {
      listSessions: () =>
        Effect.succeed(state.live ? [{ threadId: THREAD, status: "ready" } as never] : []),
      listMcpAppTools: () => {
        state.listings += 1;
        // Listing resumes the session (the recovery path).
        state.live = true;
        return Effect.succeed([{ server: "fixture", tools: state.list }]);
      },
      callMcpAppTool: (call: { toolName: string }) => {
        state.calls.push(call.toolName);
        return Effect.succeed({
          content: [{ type: "text", text: "3" }],
          structuredContent: { count: 3 },
        });
      },
    } as unknown as ProviderServiceShape;
  }

  const callRead = (
    service: ReturnType<typeof makeMcpAppServiceState>,
    providerService: ProviderServiceShape,
  ) =>
    run(
      runMcpAppRpc({
        threadId: input.threadId,
        callId: "toolu_1",
        server: "fixture",
        method: "tools/call",
        params: { name: "fixture_app_read", arguments: {} },
      }),
      service,
      providerService,
    );

  it("keeps the last listing for a restart, and a discovery-cache listing does not replace it", async () => {
    const results = makeHome();
    const first = makeMcpAppServiceState({ resultsDirectory: results });
    await first.results.put({
      threadId: THREAD,
      callId: "toolu_1",
      binding,
      state: "ready",
      updatedAt: 1,
    });
    // The adapter's live listing after init.
    first.recordProviderTools(THREAD, "fixture", fullList, "claudeAgent");
    await first.stop();

    const second = makeMcpAppServiceState({ resultsDirectory: results });
    const state = { live: false, listings: 0, list: discoveryCacheList, calls: [] as string[] };
    expect(await callRead(second, toolsProvider(state))).toEqual({
      result: { content: [{ type: "text", text: "3" }], structuredContent: { count: 3 } },
    });
    expect(state.listings).toBe(0);
    expect(state.calls).toEqual(["fixture_app_read"]);

    // Live now, memory dropped: the fresh listing lacks the widget-only tool, the stored one wins.
    const third = makeMcpAppServiceState({ resultsDirectory: results });
    state.live = true;
    expect(await callRead(third, toolsProvider(state))).toMatchObject({ result: {} });
    expect(state.listings).toBeGreaterThan(0);
    await second.stop();
    await third.stop();
  });

  it("resumes the session to list when nothing is known, before refusing", async () => {
    const service = makeMcpAppServiceState({ resultsDirectory: makeHome() });
    await service.results.put({
      threadId: THREAD,
      callId: "toolu_1",
      binding,
      state: "ready",
      updatedAt: 1,
    });
    const state = { live: false, listings: 0, list: fullList, calls: [] as string[] };
    expect(await callRead(service, toolsProvider(state))).toMatchObject({ result: {} });
    expect(state.listings).toBe(1);
    await service.stop();
  });
});

describe("tool result of a failed call", () => {
  it("answers failed for a failed call and for structuredContent a widget must not get", async () => {
    const service = makeMcpAppServiceState({ resultsDirectory: makeHome() });
    const binding = {
      resourceUri: input.resourceUri,
      source: "toolDefinition" as const,
      server: "fixture",
      toolName: "fixture_bad_structured",
    };
    await service.results.put({
      threadId: THREAD,
      callId: "failed-1",
      binding,
      state: "failed",
      error: "The tool returned a malformed result.",
      updatedAt: 1,
    });
    await service.results.put({
      threadId: THREAD,
      callId: "array-1",
      binding,
      state: "ready",
      result: { content: [], structuredContent: [1, 2, 3] },
      updatedAt: 1,
    });
    const read = (callId: string) =>
      run(
        readMcpAppToolResult({ threadId: input.threadId, callId }),
        service,
        {} as ProviderServiceShape,
      );
    expect(await read("failed-1")).toEqual({
      status: "failed",
      message: "The tool returned a malformed result.",
    });
    expect(await read("array-1")).toEqual({
      status: "failed",
      message:
        "Tool 'fixture_bad_structured' returned structuredContent of type 'array'; MCP servers exposing Apps must return an object (or omit the field)",
    });
    await service.stop();
  });
});
