// FILE: proxyObserver.ts
// Purpose: What the connector proxy does for interactive connectors on each relayed exchange:
//   remember the connector's `tools/list` (with `_meta.ui`), keep widget-only tools
//   (`visibility: ["app"]`) out of the provider's list, and keep each `tools/call` result whole for
//   its widget, keyed by `_meta["claudecode/toolUseId"]` when the client sends one.
// Layer: Server MCP Apps runtime (pure, called from the connector HTTP route)
// Exports: observeConnectorExchange

import type { McpConnectorProxyResult } from "../mcpConnectors/proxy.ts";
import type { McpAppServiceShape } from "./Services/McpAppService.ts";
import { isAppOnlyRawTool } from "./toolUi.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function observeConnectorExchange(input: {
  readonly service: McpAppServiceShape;
  readonly connectorId: string;
  readonly threadId: string | undefined;
  readonly requestBody: unknown;
  readonly result: McpConnectorProxyResult;
}): McpConnectorProxyResult {
  const request = asRecord(input.requestBody);
  if (!request || input.result.body.kind !== "json") return input.result;
  const response = asRecord(input.result.body.value);
  const result = asRecord(response?.result);
  if (!response || !result || response.id !== request.id) return input.result;
  if (request.method === "tools/list" && Array.isArray(result.tools)) {
    // A paginated list records only its first page; Moss's own listing fills the rest.
    if (asRecord(request.params)?.cursor === undefined) {
      input.service.recordConnectorTools(input.connectorId, result.tools);
    }
    const offered = result.tools.filter((tool) => !isAppOnlyRawTool(tool));
    if (offered.length === result.tools.length) return input.result;
    return {
      ...input.result,
      body: { kind: "json", value: { ...response, result: { ...result, tools: offered } } },
    };
  }
  if (request.method === "tools/call" && input.threadId !== undefined) {
    const params = asRecord(request.params);
    const name = typeof params?.name === "string" ? params.name : undefined;
    if (name && Array.isArray(result.content)) {
      const hint = asRecord(params?._meta)?.["claudecode/toolUseId"];
      input.service.captureProxyCall({
        threadId: input.threadId,
        connectorId: input.connectorId,
        toolName: name,
        arguments: asRecord(params?.arguments) ?? {},
        ...(typeof hint === "string" ? { callIdHint: hint } : {}),
        result,
      });
    }
  }
  return input.result;
}
