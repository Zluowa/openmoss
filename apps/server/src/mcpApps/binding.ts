// FILE: binding.ts
// Purpose: Provider-neutral widget binding for MCP tool rows (PLAN §2.1). Finds the server and tool
//   a row names, decides from the tool definition whether it gets a widget, and gives the row the
//   bounded `codex.mcp_tool_call` projection with a complete `app` descriptor, so the web host can
//   render it whatever provider ran the call.
// Layer: Server MCP Apps runtime (pure)
// Exports: parseQualifiedToolName, buildMcpAppBinding, enrichMcpToolRow, McpAppRowContext

import {
  MCP_APP_DEFAULT_CALL_FAILED_MESSAGE,
  type CodexMcpAppDescriptor,
  type ProviderRuntimeEvent,
} from "@moss/contracts";

import { projectCodexMcpToolCall } from "../provider/Layers/CodexAdapter.ts";
import type { McpAppServerIdentity } from "./Services/McpAppService.ts";
import {
  claudeBlockToMcp,
  normalizeClaudeServerName,
  type McpAppToolDefinition,
} from "./toolUi.ts";

export { claudeBlockToMcp, normalizeClaudeServerName };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Splits a provider's qualified tool name against the servers Moss knows for the thread.
 * Accepts `mcp__<server>__<tool>` (Claude), `<server>__<tool>`, `<server>_<tool>` (OpenCode) and
 * `<server>.<tool>` / `<server>/<tool>`. The longest matching server wins; `knownTool` must
 * confirm the remainder so ordinary tools are never mistaken for MCP ones.
 */
export function parseQualifiedToolName(
  rawName: string,
  servers: ReadonlyArray<string>,
  knownTool: (server: string, tool: string) => boolean,
): { readonly server: string; readonly tool: string } | undefined {
  const candidates: Array<{ server: string; tool: string }> = [];
  const stripped = rawName.startsWith("mcp__") ? rawName.slice("mcp__".length) : rawName;
  for (const server of servers) {
    for (const name of new Set([server, normalizeClaudeServerName(server)])) {
      for (const separator of ["__", "_", ".", "/"]) {
        const prefix = `${name}${separator}`;
        if (stripped.startsWith(prefix) && stripped.length > prefix.length) {
          candidates.push({ server, tool: stripped.slice(prefix.length) });
        }
      }
    }
  }
  candidates.sort((left, right) => right.server.length - left.server.length);
  return candidates.find((candidate) => knownTool(candidate.server, candidate.tool));
}

/** Completes a descriptor with the binding fields of PLAN §2.1. */
export function buildMcpAppBinding(input: {
  readonly base: Pick<CodexMcpAppDescriptor, "resourceUri" | "source"> &
    Partial<CodexMcpAppDescriptor>;
  readonly identity: McpAppServerIdentity;
  readonly toolName: string;
  readonly definition?: McpAppToolDefinition | undefined;
}): CodexMcpAppDescriptor {
  const { base, identity, definition } = input;
  // Codex's own apps all sit behind `codex_apps`; keep each app on its own origin.
  const serverKey =
    identity.kind === "provider" && identity.server === "codex_apps" && base.connectorId
      ? `codex_apps/${base.connectorId}`.slice(0, 200)
      : identity.serverKey;
  return {
    ...base,
    server: identity.server,
    serverKey,
    serverLabel: identity.serverLabel,
    toolName: input.toolName,
    ...(definition?.title ? { toolTitle: definition.title } : {}),
    ...(identity.kind === "connector"
      ? { connectorId: identity.connectorId, connectorUrl: identity.connectorUrl }
      : {}),
    isFirstParty: identity.kind === "gateway",
    visibility: [...(definition?.visibility ?? [])],
  };
}

export interface McpAppRowContext {
  readonly classify: (server: string) => McpAppServerIdentity;
  readonly serversForThread: (threadId: string) => ReadonlyArray<string>;
  readonly definition: (
    threadId: string,
    server: string,
    tool: string,
  ) => McpAppToolDefinition | undefined;
  /** Exact raw result captured for this call (adapter or proxy), when there is one. */
  readonly captured: (
    threadId: string,
    callId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) =>
    | { readonly input?: Record<string, unknown>; readonly result?: Record<string, unknown> }
    | undefined;
}

export interface McpAppRowBinding {
  readonly event: ProviderRuntimeEvent;
  readonly threadId: string;
  readonly callId: string;
  readonly binding: CodexMcpAppDescriptor;
  readonly state: "pending" | "ready" | "failed";
  readonly input: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  /** The failure the row reports, for a failed call. */
  readonly error?: string;
}

type ItemLifecycle = "item.started" | "item.updated" | "item.completed";

/** The durable projection's own cap (`CodexMcpToolCallProjection`, 12 000 JSON chars). */
const MCP_PROJECTION_MAX_JSON_CHARS = 12_000;

const PROJECTION_KEYS = [
  "kind",
  "version",
  "callId",
  "server",
  "tool",
  "status",
  "durationMs",
  "arguments",
  "result",
  "error",
  "truncation",
  "app",
  "webMcpCalls",
  "webMcpFallbackHostname",
] as const;

function projectionChars(data: Record<string, unknown>): number {
  const projected: Record<string, unknown> = {};
  for (const key of PROJECTION_KEYS) if (data[key] !== undefined) projected[key] = data[key];
  try {
    return JSON.stringify(projected).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The full binding when it fits the projection cap, else the binding without its optional
 * display fields, else undefined (the row keeps what it had).
 */
function fittingBinding(
  data: Record<string, unknown>,
  binding: CodexMcpAppDescriptor,
): CodexMcpAppDescriptor | undefined {
  if (projectionChars({ ...data, app: binding }) <= MCP_PROJECTION_MAX_JSON_CHARS) return binding;
  const {
    toolTitle: _title,
    connectorUrl: _url,
    linkId: _link,
    actionName: _action,
    ...minimal
  } = binding;
  if (projectionChars({ ...data, app: minimal }) <= MCP_PROJECTION_MAX_JSON_CHARS) return minimal;
  return undefined;
}

function isItemLifecycle(type: string): type is ItemLifecycle {
  return type === "item.started" || type === "item.updated" || type === "item.completed";
}

function errorMessageFromRaw(data: Record<string, unknown>): string {
  const result = asRecord(data.result);
  const content = result?.content;
  if (typeof content === "string" && content.trim()) return content.trim().slice(0, 2_000);
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => asRecord(entry))
      .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
      .map((entry) => entry!.text as string)
      .join("\n")
      .trim();
    if (text) return text.slice(0, 2_000);
  }
  const state = asRecord(data.state);
  const stateError = nonEmpty(state?.error, 2_000);
  return stateError ?? MCP_APP_DEFAULT_CALL_FAILED_MESSAGE;
}

/**
 * Binds one tool row. Codex rows already carry the projection; other providers' rows get it here
 * when the tool definition declares a widget. Returns undefined for rows without a widget.
 */
export function bindMcpToolRow(
  event: ProviderRuntimeEvent,
  context: McpAppRowContext,
): McpAppRowBinding | undefined {
  if (!isItemLifecycle(event.type)) return undefined;
  const payload = asRecord((event as { payload?: unknown }).payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) return undefined;
  const threadId = String(event.threadId);
  const lifecycle = event.type;

  // Codex: the adapter projected the native item already.
  if (data.kind === "codex.mcp_tool_call") {
    const server = nonEmpty(data.server);
    const tool = nonEmpty(data.tool);
    const callId = nonEmpty(data.callId);
    if (!server || !tool || !callId) return undefined;
    const identity = context.classify(server);
    const definition = context.definition(threadId, server, tool);
    const existing = asRecord(data.app) as CodexMcpAppDescriptor | undefined;
    const base: CodexMcpAppDescriptor | undefined =
      existing ??
      (definition?.resourceUri
        ? { resourceUri: definition.resourceUri, source: "toolDefinition" }
        : undefined);
    if (!base) return undefined;
    const binding = fittingBinding(
      data,
      buildMcpAppBinding({ base, identity, toolName: tool, definition }),
    );
    if (!binding) return undefined;
    const status = data.status;
    const state = status === "failed" ? "failed" : status === "completed" ? "ready" : "pending";
    const args = asRecord(data.arguments) ?? {};
    const captured = context.captured(threadId, callId, server, tool, args);
    return {
      event: {
        ...event,
        payload: { ...payload, data: { ...data, app: binding } },
      } as ProviderRuntimeEvent,
      threadId,
      callId,
      binding,
      state,
      ...(state === "failed"
        ? {
            error:
              nonEmpty(asRecord(data.error)?.message, 2_000) ?? MCP_APP_DEFAULT_CALL_FAILED_MESSAGE,
          }
        : {}),
      input: captured?.input ?? args,
      ...(captured?.result ? { result: captured.result } : {}),
    };
  }

  const rawToolName = nonEmpty(data.toolName) ?? nonEmpty(data.tool);
  const callId =
    nonEmpty(data.toolCallId) ??
    nonEmpty(data.callId) ??
    nonEmpty((event as { itemId?: unknown }).itemId);
  if (!rawToolName || !callId) return undefined;
  const parsed = parseQualifiedToolName(
    rawToolName,
    context.serversForThread(threadId),
    (server, tool) => context.definition(threadId, server, tool) !== undefined,
  );
  if (!parsed) return undefined;
  const definition = context.definition(threadId, parsed.server, parsed.tool);
  if (!definition?.resourceUri) return undefined;
  const identity = context.classify(parsed.server);
  const input = asRecord(data.input) ?? {};
  const failed = payload.status === "failed";
  const completed = lifecycle === "item.completed" || payload.status === "completed";
  const captured = context.captured(threadId, callId, parsed.server, parsed.tool, input);
  const status = failed ? "failed" : completed ? "completed" : "inProgress";
  const result =
    status === "completed" ? (captured?.result ?? rebuildResultFromRow(data)) : undefined;
  const projection = projectCodexMcpToolCall(
    {
      type: "mcpToolCall",
      id: callId,
      server: parsed.server,
      tool: parsed.tool,
      status,
      arguments: input,
      mcpAppUi: { resourceUri: definition.resourceUri },
      result: result ?? null,
      error: failed ? { message: errorMessageFromRaw(data) } : null,
    },
    lifecycle,
  );
  if (!projection) return undefined;
  const binding = fittingBinding(
    projection as unknown as Record<string, unknown>,
    buildMcpAppBinding({
      base: projection.app ?? { resourceUri: definition.resourceUri, source: "toolDefinition" },
      identity,
      toolName: parsed.tool,
      definition,
    }),
  );
  if (!binding) return undefined;
  return {
    event: {
      ...event,
      payload: {
        ...payload,
        itemType: "mcp_tool_call",
        data: { ...data, ...projection, app: binding },
      },
    } as ProviderRuntimeEvent,
    threadId,
    callId,
    binding,
    state: failed ? "failed" : completed ? "ready" : "pending",
    ...(failed ? { error: errorMessageFromRaw(data) } : {}),
    input: captured?.input ?? input,
    ...(result ? { result } : {}),
  };
}

/**
 * A `CallToolResult` rebuilt from a provider's own row when nothing exact was captured: an MCP
 * shaped `result`, else a tool_result block's content, else OpenCode's `state.output`.
 */
export function rebuildResultFromRow(data: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(data.result);
  if (result && Array.isArray(result.content) && result.type !== "tool_result") return result;
  const content = result?.content;
  if (typeof content === "string") return { content: [{ type: "text", text: content }] };
  if (Array.isArray(content)) return { content: content.map(claudeBlockToMcp) };
  const output = asRecord(data.state)?.output;
  if (typeof output === "string") return { content: [{ type: "text", text: output }] };
  return { content: [] };
}
