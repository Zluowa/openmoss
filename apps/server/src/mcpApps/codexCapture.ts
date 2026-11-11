// FILE: codexCapture.ts
// Purpose: Keeps the full raw result of a Codex `mcpToolCall` item before the adapter compacts it
//   into the bounded durable projection, so a widget gets the whole `CallToolResult` (SPEC §3).
// Layer: Server MCP Apps runtime (pure hook called from the Codex adapter's event listener)
// Exports: captureCodexMcpToolItem

import type { ProviderEvent } from "@moss/contracts";

import type { McpAppServiceShape } from "./Services/McpAppService.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function captureCodexMcpToolItem(service: McpAppServiceShape, event: ProviderEvent): void {
  if (event.method !== "item/completed" && event.method !== "item/started") return;
  const item = asRecord(asRecord(event.payload)?.item);
  if (item?.type !== "mcpToolCall" || typeof item.id !== "string") return;
  const result = asRecord(item.result);
  const input = asRecord(item.arguments);
  service.captureCall({
    threadId: String(event.threadId),
    callId: item.id,
    ...(typeof item.server === "string" ? { server: item.server } : {}),
    ...(typeof item.tool === "string" ? { toolName: item.tool } : {}),
    ...(input ? { input } : {}),
    ...(result && Array.isArray(result.content)
      ? { result: codexResultToCallToolResult(result) }
      : {}),
    ...(item.status === "failed" ? { failed: true } : {}),
  });
}

/** Codex sends every optional member as `null`; a `CallToolResult` omits them instead. */
function codexResultToCallToolResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    content: result.content,
    ...(result.structuredContent !== null && result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(asRecord(result._meta) ? { _meta: result._meta } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}
