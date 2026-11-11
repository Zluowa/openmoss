// FILE: claudeBackend.ts
// Purpose: Interactive connectors on Claude Code (Agent SDK 0.3.318): tool definitions from
//   `mcpServerStatus()` (`mcp_tool_ui_meta_v1`), widget resources through `readMcpResource`
//   (`mcp_read_resource_v1`) and widget tool calls through the `mcp_call` control request with
//   `result_not_for_model: true` (`mcp_call_result_not_for_model_v1`). Every call is
//   feature-detected from `system/init.capabilities`; a CLI without one gets a plain error.
// Layer: Server MCP Apps runtime (promise-based, no SDK import)
// Exports: CLAUDE_MCP_APP_CAPABILITIES, ClaudeMcpAppQuery, listClaudeMcpAppTools,
//   readClaudeMcpResource, callClaudeMcpTool, claudeToolResultToCallToolResult

import type { ProviderMcpAppServerTools } from "../provider/Services/ProviderAdapter.ts";
import { claudeBlockToMcp, normalizeClaudeServerName } from "./toolUi.ts";

export const CLAUDE_MCP_APP_CAPABILITIES = {
  toolUiMeta: "mcp_tool_ui_meta_v1",
  readResource: "mcp_read_resource_v1",
  callResultNotForModel: "mcp_call_result_not_for_model_v1",
} as const;

/** The members of the SDK `Query` this module uses; `request` is the SDK's control channel. */
export interface ClaudeMcpAppQuery {
  readonly mcpServerStatus?: () => Promise<ReadonlyArray<unknown>>;
  readonly readMcpResource?: (serverName: string, uri: string) => Promise<unknown>;
  readonly request?: (request: Record<string, unknown>) => Promise<unknown>;
}

/** A Claude Code build that lacks what a widget asked for. */
export class ClaudeMcpAppUnsupportedError extends Error {
  override readonly name = "ClaudeMcpAppUnsupportedError";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireCapability(
  capabilities: ReadonlySet<string> | undefined,
  capability: string,
  what: string,
): void {
  if (!capabilities?.has(capability)) {
    throw new ClaudeMcpAppUnsupportedError(
      `This agent CLI version cannot ${what} (it does not advertise ${capability}). Update the CLI to use interactive connectors here.`,
    );
  }
}

/** `mcpServerStatus()` as provider-neutral tool lists (connected servers only). */
export async function listClaudeMcpAppTools(input: {
  readonly query: ClaudeMcpAppQuery;
  readonly capabilities: ReadonlySet<string> | undefined;
  readonly server?: string;
}): Promise<ReadonlyArray<ProviderMcpAppServerTools>> {
  requireCapability(
    input.capabilities,
    CLAUDE_MCP_APP_CAPABILITIES.toolUiMeta,
    "list widget tools",
  );
  if (typeof input.query.mcpServerStatus !== "function") {
    throw new ClaudeMcpAppUnsupportedError("This agent session cannot report its servers.");
  }
  const statuses = await input.query.mcpServerStatus();
  return statuses.flatMap((entry) => {
    const status = asRecord(entry);
    const name = typeof status?.name === "string" ? status.name : undefined;
    if (!status || !name || status.status !== "connected") return [];
    if (input.server !== undefined && input.server !== name) return [];
    const tools = Array.isArray(status.tools)
      ? status.tools.flatMap((tool) => (asRecord(tool) ? [asRecord(tool)!] : []))
      : [];
    return [{ server: name, tools }];
  });
}

/** `readMcpResource(server, uri)`; the reply is `{contents}` with each item's own `_meta`. */
export async function readClaudeMcpResource(input: {
  readonly query: ClaudeMcpAppQuery;
  readonly capabilities: ReadonlySet<string> | undefined;
  readonly server: string;
  readonly uri: string;
}): Promise<Record<string, unknown>> {
  requireCapability(
    input.capabilities,
    CLAUDE_MCP_APP_CAPABILITIES.readResource,
    "read widget resources",
  );
  if (typeof input.query.readMcpResource !== "function") {
    throw new ClaudeMcpAppUnsupportedError("This agent session cannot read resources.");
  }
  const response = asRecord(await input.query.readMcpResource(input.server, input.uri));
  if (!response || !Array.isArray(response.contents)) {
    throw new Error("The agent CLI returned a malformed resource.");
  }
  return { contents: response.contents };
}

/**
 * Widget `tools/call` through the CLI's own MCP client (`mcp_call`, no model turn). The control
 * channel does no permission check, so Moss's own approval runs before this.
 */
export async function callClaudeMcpTool(input: {
  readonly query: ClaudeMcpAppQuery;
  readonly capabilities: ReadonlySet<string> | undefined;
  readonly server: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  requireCapability(
    input.capabilities,
    CLAUDE_MCP_APP_CAPABILITIES.callResultNotForModel,
    "run widget tool calls",
  );
  if (typeof input.query.request !== "function") {
    throw new ClaudeMcpAppUnsupportedError("This agent session has no control channel.");
  }
  const answer = await input.query.request({
    subtype: "mcp_call",
    tool: `mcp__${normalizeClaudeServerName(input.server)}__${input.toolName}`,
    arguments: input.arguments,
    result_not_for_model: true,
  });
  return claudeMcpCallResult(answer);
}

/**
 * The `mcp_call` control response as a `CallToolResult`. The SDK's private `request` resolves to
 * the control response envelope; its `response` member carries the call's own result.
 */
export function claudeMcpCallResult(answer: unknown): Record<string, unknown> {
  const envelope = asRecord(answer);
  const response = asRecord(envelope?.response) ?? envelope;
  const candidates = [response, asRecord(response?.result), asRecord(response?.toolResult)];
  for (const candidate of candidates) {
    if (candidate && Array.isArray(candidate.content)) return candidate;
  }
  // Without `result_not_for_model` the CLI hands back the model's view: `content` is the text it
  // sent the model (the JSON of structuredContent when there is one).
  if (response && typeof response.content === "string") {
    return {
      content: [{ type: "text", text: response.content }],
      ...(asRecord(response.structuredContent)
        ? { structuredContent: response.structuredContent }
        : {}),
      ...(asRecord(response._meta) ? { _meta: response._meta } : {}),
      ...(response.isError === true ? { isError: true } : {}),
    };
  }
  const legacy = response?.toolResult ?? response?.result;
  if (typeof legacy === "string") return { content: [{ type: "text", text: legacy }] };
  throw new Error("The agent CLI returned a malformed tool result.");
}

/**
 * A model-turn MCP result as the Agent SDK reports it, back in `CallToolResult` shape: the SDK
 * `tool_use_result` when it is MCP-shaped (or carries `structuredContent`), else the tool_result
 * block's content.
 */
export function claudeToolResultToCallToolResult(input: {
  readonly block: Record<string, unknown>;
  readonly toolUseResult: unknown;
}): Record<string, unknown> {
  const structured = asRecord(input.toolUseResult);
  const blockContent = input.block.content;
  const content =
    typeof blockContent === "string"
      ? [{ type: "text", text: blockContent }]
      : Array.isArray(blockContent)
        ? blockContent.map(claudeBlockToMcp)
        : [];
  if (structured && Array.isArray(structured.content)) {
    return {
      ...structured,
      ...(input.block.is_error === true ? { isError: true } : {}),
    };
  }
  return {
    content,
    ...(structured && asRecord(structured.structuredContent)
      ? { structuredContent: structured.structuredContent }
      : {}),
    ...(structured && asRecord(structured._meta) ? { _meta: structured._meta } : {}),
    ...(input.block.is_error === true ? { isError: true } : {}),
  };
}
