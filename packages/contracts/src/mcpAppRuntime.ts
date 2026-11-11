// FILE: mcpAppRuntime.ts
// Purpose: Request/response contracts for the live MCP App (交互式连接器) endpoints a widget host
//   calls: the full tool result, widget JSON-RPC, model context and resource downloads. Bodies are
//   untrusted widget input, so every field is bounded here.
// Layer: Contracts (schemas only)
// Exports: McpAppToolResultInput/Result, McpAppRpcInput/Result, McpAppModelContextInput/Result,
//   McpAppResourceDownloadInput/Result, McpAppToolVisibility, MCP_APP_RPC_METHODS

import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

const McpAppIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const McpAppThreadId = ThreadId.check(Schema.isMaxLength(200));
const McpAppUri = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

/** `_meta.ui.visibility` audiences. Undeclared visibility is sent as an empty list. */
export const McpAppToolVisibility = Schema.Literals(["model", "app"]);
export type McpAppToolVisibility = typeof McpAppToolVisibility.Type;

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

export const McpAppToolResultInput = Schema.Struct({
  threadId: McpAppThreadId,
  callId: McpAppIdentity,
});
export type McpAppToolResultInput = typeof McpAppToolResultInput.Type;

/**
 * `ready`: the full `CallToolResult` as the server returned it (reserved `_meta` keys removed).
 * `pending`: the call is still running. `missing`: nothing stored; show the bounded projection.
 */
export const McpAppToolResultResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    input: JsonObject,
    result: JsonObject,
  }),
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("missing") }),
]);
export type McpAppToolResultResult = typeof McpAppToolResultResult.Type;

export const MCP_APP_RPC_METHODS = [
  "tools/call",
  "tools/list",
  "resources/read",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
] as const;
export const McpAppRpcMethod = Schema.Literals(MCP_APP_RPC_METHODS);
export type McpAppRpcMethod = typeof McpAppRpcMethod.Type;

export const McpAppRpcInput = Schema.Struct({
  threadId: McpAppThreadId,
  callId: McpAppIdentity,
  server: McpAppIdentity,
  method: McpAppRpcMethod,
  params: Schema.optional(JsonObject),
  /** One-time token from an earlier `needsApproval` answer, after the person allowed the call. */
  approvalToken: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type McpAppRpcInput = typeof McpAppRpcInput.Type;

export const McpAppRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export type McpAppRpcError = typeof McpAppRpcError.Type;

export const McpAppRpcNeedsApproval = Schema.Struct({
  token: TrimmedNonEmptyString,
  toolName: McpAppIdentity,
  serverLabel: McpAppIdentity,
  /** Ready-to-show line, e.g. 「{server} 的小组件想使用 {tool}」. */
  reason: Schema.String,
});
export type McpAppRpcNeedsApproval = typeof McpAppRpcNeedsApproval.Type;

export const McpAppRpcResult = Schema.Union([
  Schema.Struct({ result: Schema.Unknown }),
  Schema.Struct({ error: McpAppRpcError }),
  Schema.Struct({ needsApproval: McpAppRpcNeedsApproval }),
]);
export type McpAppRpcResult = typeof McpAppRpcResult.Type;

const McpAppContentBlock = JsonObject;

export const McpAppModelContextInput = Schema.Struct({
  threadId: McpAppThreadId,
  callId: McpAppIdentity,
  toolName: McpAppIdentity,
  content: Schema.optional(Schema.Array(McpAppContentBlock).check(Schema.isMaxLength(64))),
  structuredContent: Schema.optional(JsonObject),
});
export type McpAppModelContextInput = typeof McpAppModelContextInput.Type;

export const McpAppModelContextResult = Schema.Union([
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({}),
]);
export type McpAppModelContextResult = typeof McpAppModelContextResult.Type;

export const McpAppResourceDownloadInput = Schema.Struct({
  threadId: McpAppThreadId,
  /** Call that rendered the widget; the server must be that call's server. */
  callId: Schema.optional(McpAppIdentity),
  server: McpAppIdentity,
  uri: McpAppUri,
});
export type McpAppResourceDownloadInput = typeof McpAppResourceDownloadInput.Type;

export const McpAppResourceDownloadResult = Schema.Union([
  Schema.Struct({ contents: Schema.Array(JsonObject) }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);
export type McpAppResourceDownloadResult = typeof McpAppResourceDownloadResult.Type;
