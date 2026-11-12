// FILE: claudeAdapterMcpApps.ts
// Purpose: The Claude adapter's interactive-connector methods, kept out of the 9 000-line adapter:
//   refresh tool definitions after `init`, capture full MCP results at tool_result time, and the
//   four adapter methods (resource read, tool list, widget tool call, widget resource read).
// Layer: Provider adapter helper (Effect)
// Exports: makeClaudeMcpAppMethods

import type { McpAppResourceReadResult, ThreadId } from "@moss/contracts";
import { Effect } from "effect";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderMcpAppServerTools,
} from "../provider/Services/ProviderAdapter.ts";
import {
  callClaudeMcpTool,
  claudeToolResultToCallToolResult,
  listClaudeMcpAppTools,
  readClaudeMcpResource,
  type ClaudeMcpAppQuery,
} from "./claudeBackend.ts";
import { parseMcpAppResourceReadResponse } from "./resourceContent.ts";
import type { McpAppServiceShape } from "./Services/McpAppService.ts";

const PROVIDER = "claudeAgent";
/** `init` is re-sent every turn; refresh the server list at most this often. */
const TOOL_REFRESH_MIN_INTERVAL_MS = 30_000;

interface ClaudeMcpAppContext {
  readonly session: { readonly threadId: ThreadId };
  readonly query: ClaudeMcpAppQuery;
  readonly cliCapabilities?: ReadonlySet<string>;
}

function requestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export function makeClaudeMcpAppMethods<Context extends ClaudeMcpAppContext>(input: {
  readonly requireSession: (threadId: ThreadId) => Effect.Effect<Context, ProviderAdapterError>;
  readonly mcpApps: McpAppServiceShape | undefined;
}) {
  const lastRefresh = new WeakMap<object, number>();
  const { mcpApps } = input;

  const record = (threadId: ThreadId, servers: ReadonlyArray<ProviderMcpAppServerTools>) => {
    for (const server of servers) {
      mcpApps?.recordProviderTools(threadId, server.server, server.tools, PROVIDER);
    }
  };

  /** After `init`: learn which tools declare widgets, so rows can be bound as they stream. */
  const refreshToolDefinitions = (context: Context): void => {
    if (!mcpApps || !context.cliCapabilities?.has("mcp_tool_ui_meta_v1")) return;
    const previous = lastRefresh.get(context) ?? 0;
    if (Date.now() - previous < TOOL_REFRESH_MIN_INTERVAL_MS) return;
    lastRefresh.set(context, Date.now());
    void listClaudeMcpAppTools({ query: context.query, capabilities: context.cliCapabilities })
      .then((servers) => record(context.session.threadId, servers))
      .catch(() => lastRefresh.delete(context));
  };

  /** A model-turn result of an MCP tool, kept whole for its widget (SPEC §3). */
  const captureToolResult = (
    context: Context,
    tool: {
      readonly itemId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    },
    toolResult: {
      readonly block: Record<string, unknown>;
      readonly structuredResult: unknown;
      readonly isError: boolean;
    },
  ): void => {
    if (!mcpApps || !tool.toolName.startsWith("mcp__")) return;
    mcpApps.captureCall({
      threadId: context.session.threadId,
      callId: tool.itemId,
      input: tool.input,
      result: claudeToolResultToCallToolResult({
        block: toolResult.block,
        toolUseResult: toolResult.structuredResult,
      }),
      ...(toolResult.isError ? { failed: true } : {}),
    });
  };

  const listMcpAppTools: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["listMcpAppTools"]
  > = (request) =>
    Effect.gen(function* () {
      const context = yield* input.requireSession(request.threadId);
      const servers = yield* Effect.tryPromise({
        try: () =>
          listClaudeMcpAppTools({
            query: context.query,
            capabilities: context.cliCapabilities,
            ...(request.server !== undefined ? { server: request.server } : {}),
          }),
        catch: (cause) => requestError("mcp_status", cause),
      });
      record(request.threadId, servers);
      return servers;
    });

  const readMcpResourceContents: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["readMcpResourceContents"]
  > = (request) =>
    Effect.gen(function* () {
      const context = yield* input.requireSession(request.threadId);
      return yield* Effect.tryPromise({
        try: () =>
          readClaudeMcpResource({
            query: context.query,
            capabilities: context.cliCapabilities,
            server: request.server,
            uri: request.uri,
          }),
        catch: (cause) => requestError("mcp_read_resource", cause),
      });
    });

  const readMcpAppResource: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["readMcpAppResource"]
  > = (request) =>
    readMcpResourceContents({
      threadId: request.threadId,
      server: request.server,
      uri: request.resourceUri,
    }).pipe(
      Effect.flatMap((response) =>
        Effect.try({
          try: (): McpAppResourceReadResult =>
            parseMcpAppResourceReadResponse({ response, resourceUri: request.resourceUri }),
          catch: (cause) => requestError("mcp_read_resource", cause),
        }),
      ),
    );

  const callMcpAppTool: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["callMcpAppTool"]
  > = (request) =>
    Effect.gen(function* () {
      const context = yield* input.requireSession(request.threadId);
      return yield* Effect.tryPromise({
        try: () =>
          callClaudeMcpTool({
            query: context.query,
            capabilities: context.cliCapabilities,
            server: request.server,
            toolName: request.toolName,
            arguments: request.arguments,
          }),
        catch: (cause) => requestError("mcp_call", cause),
      });
    });

  return {
    refreshToolDefinitions,
    captureToolResult,
    listMcpAppTools,
    readMcpResourceContents,
    readMcpAppResource,
    callMcpAppTool,
  };
}
