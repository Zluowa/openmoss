import { MOSS_MCP_SERVER_NAME, type AgentGatewayMcpToolDescriptor } from "./mcpInjection.ts";

export interface CodexDynamicToolFunctionSpec {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Codex app-server deferred-tools flag. When true, Codex keeps the tool
   * registered (and recoverable during sampling) without stuffing the full
   * schema into every Responses request body. Critical for CN TTFT
   * when Moss MCP catalogs are ~100KB.
   */
  readonly deferLoading?: boolean;
}

export interface CodexDynamicToolNamespaceSpec {
  readonly type: "namespace";
  readonly name: string;
  readonly description: string;
  readonly tools: ReadonlyArray<CodexDynamicToolFunctionSpec>;
}

export type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

export type CodexDynamicToolOutputContentItem =
  | { readonly type: "inputText"; readonly text: string }
  | { readonly type: "inputImage"; readonly imageUrl: string }
  | { readonly type: "inputAudio"; readonly audioUrl: string };

export interface CodexDynamicToolCallResponse {
  readonly contentItems: ReadonlyArray<CodexDynamicToolOutputContentItem>;
  readonly success: boolean;
}

/** Mirror Codex `MAX_SERIALIZED_MCP_TOOL_BYTES` for oversized schema collapse. */
export const CODEX_MAX_SERIALIZED_DYNAMIC_TOOL_BYTES = 8_000;

const COLLAPSED_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringifyToolResult(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "Moss MCP returned a result that could not be serialized.";
  }
}

function serializedToolBytes(tool: CodexDynamicToolFunctionSpec): number {
  // Approximate the Responses-shaped function tool Codex emits. Keep this cheap
  // and deterministic.
  return Buffer.byteLength(
    JSON.stringify({
      type: "function",
      name: tool.name,
      description: tool.description,
      strict: false,
      ...(tool.deferLoading ? { defer_loading: true } : {}),
      parameters: tool.inputSchema,
    }),
    "utf8",
  );
}

/**
 * Project the canonical Moss MCP catalog into Codex app-server's native
 * dynamic-tool surface. Keeping the original names makes the same moss_* and
 * browser_* contract visible across every provider adapter.
 */
const DEFERRED_DESCRIPTION_MAX_CHARS = 64;

function truncateDeferredDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= DEFERRED_DESCRIPTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, DEFERRED_DESCRIPTION_MAX_CHARS - 1)}…`;
}

export function buildCodexAgentGatewayDynamicTools(
  tools: ReadonlyArray<AgentGatewayMcpToolDescriptor>,
  options: { readonly deferLoading?: boolean } = {},
): ReadonlyArray<CodexDynamicToolSpec> {
  const deferLoading = options.deferLoading === true;
  if (deferLoading) {
    // Managed Moss CN marks tools deferLoading. Keep every MCP tool name, but
    // send one canonical namespace wrapper containing lean function shapes:
    // full schemas remain available via MCP and can be recovered during sampling.
    return [
      {
        type: "namespace",
        name: MOSS_MCP_SERVER_NAME,
        description: "Moss Agent Gateway MCP tools",
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: truncateDeferredDescription(tool.description),
          inputSchema: COLLAPSED_INPUT_SCHEMA,
          deferLoading: true,
        })),
      },
    ];
  }

  return tools.map((tool) => {
    const base: CodexDynamicToolFunctionSpec = {
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (serializedToolBytes(base) <= CODEX_MAX_SERIALIZED_DYNAMIC_TOOL_BYTES) {
      return base;
    }
    // Non-deferred path: never drop the tool; collapse only an oversized schema.
    return {
      ...base,
      inputSchema: COLLAPSED_INPUT_SCHEMA,
    };
  });
}

/** Convert an MCP CallToolResult into app-server's dynamic-tool response. */
export function codexDynamicToolResponseFromMcpResult(
  result: unknown,
): CodexDynamicToolCallResponse {
  const record = isRecord(result) ? result : null;
  const content = record && Array.isArray(record.content) ? record.content : [];
  const contentItems = content.flatMap((item): Array<CodexDynamicToolOutputContentItem> => {
    if (!isRecord(item) || typeof item.type !== "string") return [];
    if (item.type === "text" && typeof item.text === "string") {
      return [{ type: "inputText", text: item.text }];
    }
    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      return [{ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` }];
    }
    if (
      item.type === "audio" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      return [{ type: "inputAudio", audioUrl: `data:${item.mimeType};base64,${item.data}` }];
    }
    return [];
  });
  const fallbackValue = record && "structuredContent" in record ? record.structuredContent : result;

  return {
    contentItems:
      contentItems.length > 0
        ? contentItems
        : [{ type: "inputText", text: stringifyToolResult(fallbackValue) }],
    success: record?.isError !== true,
  };
}

export function codexDynamicToolFailureResponse(cause: unknown): CodexDynamicToolCallResponse {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    contentItems: [{ type: "inputText", text: `Moss MCP tool call failed: ${detail}` }],
    success: false,
  };
}
