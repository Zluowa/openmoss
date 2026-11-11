// FILE: mcpAppResource.ts
// Purpose: Shared authenticated HTTP route identities for MCP App (交互式连接器) endpoints.

export const MCP_APP_RESOURCE_READ_ROUTE_PATH = "/api/provider/mcp-app-resource/read" as const;
/** Full `CallToolResult` of the call that rendered a widget. */
export const MCP_APP_TOOL_RESULT_ROUTE_PATH = "/api/provider/mcp-app/tool-result" as const;
/** Widget JSON-RPC to the widget's own server (tools, resources, prompts). */
export const MCP_APP_RPC_ROUTE_PATH = "/api/provider/mcp-app/rpc" as const;
/** `ui/update-model-context` from a widget. */
export const MCP_APP_MODEL_CONTEXT_ROUTE_PATH = "/api/provider/mcp-app/model-context" as const;
/** Resource links a widget asks to download (`ui/download-file`). */
export const MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH =
  "/api/provider/mcp-app/resource-download" as const;
