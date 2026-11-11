// FILE: toolUi.ts
// Purpose: Pure MCP Apps (交互式连接器) rules shared by every provider back-end: which tool
//   definitions carry a widget, who may call a tool, the host refusal texts, reserved `_meta`
//   stripping and `structuredContent` validation.
// Layer: Server MCP Apps runtime (pure)
// Exports: McpAppToolDefinition, toolDefinitionFromMcp, toolUiResourceUri, toolAllowsApp,
//   isAppOnlyTool, mcpAppRefusal*, stripReservedMcpAppMeta, checkStructuredContent, mcpArgsHash

import { createHash } from "node:crypto";

import type { McpAppToolVisibility } from "@moss/contracts";

export const MCP_APP_RESOURCE_URI_MAX_CHARS = 2_000;
export const MCP_APP_NAME_MAX_CHARS = 200;
/** SPEC-protocol (a): structuredContent budget. */
export const MCP_APP_STRUCTURED_CONTENT_MAX_CHARS = 262_144;
export const MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH = 64;
/** Widget `tools/call` deadline (SPEC §6). */
export const MCP_APP_WIDGET_TOOL_CALL_TIMEOUT_MS = 240_000;

/** One tool as a widget host needs it. `raw` is the server's definition minus reserved meta. */
export interface McpAppToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly resourceUri?: string;
  /** Declared audiences; empty when the tool declared none. */
  readonly visibility: ReadonlyArray<McpAppToolVisibility>;
  readonly visibilityDeclared: boolean;
  readonly readOnlyHint?: boolean;
  /** Tool-level `_meta.ui.csp` / `permissions` were declared (ignored, logged once). */
  readonly declaresToolLevelSandbox: boolean;
  readonly raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MCP_APP_NAME_MAX_CHARS || /[\0\r\n]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function uiResourceUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("ui://") ||
    trimmed.length > MCP_APP_RESOURCE_URI_MAX_CHARS ||
    /[\0\r\n\s]/u.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * The MCP Apps rule (ext-apps `getToolUiResourceUri`): `_meta.ui.resourceUri`, else the legacy
 * flat `_meta["ui/resourceUri"]`, a `ui://` string. `openai/outputTemplate` is not honoured here;
 * Codex's result-side fallbacks live in the Codex projection.
 */
export function toolUiResourceUri(meta: unknown): string | undefined {
  const record = asRecord(meta);
  if (!record) return undefined;
  return uiResourceUri(asRecord(record.ui)?.resourceUri) ?? uiResourceUri(record["ui/resourceUri"]);
}

/** `_meta.ui.visibility`; `null` counts as absent. Unknown entries are dropped. */
export function toolUiVisibility(meta: unknown): {
  readonly visibility: ReadonlyArray<McpAppToolVisibility>;
  readonly declared: boolean;
} {
  const ui = asRecord(asRecord(meta)?.ui);
  const raw = ui?.visibility;
  if (raw === undefined || raw === null) return { visibility: [], declared: false };
  if (!Array.isArray(raw)) return { visibility: [], declared: true };
  const visibility: McpAppToolVisibility[] = [];
  for (const entry of raw) {
    if ((entry === "model" || entry === "app") && !visibility.includes(entry)) {
      visibility.push(entry);
    }
  }
  return { visibility, declared: true };
}

/** Normalises one `tools/list` entry (MCP, Codex `Tool`, or Agent SDK status tool). */
export function toolDefinitionFromMcp(rawTool: unknown): McpAppToolDefinition | undefined {
  const record = asRecord(rawTool);
  const name = boundedName(record?.name);
  if (!record || !name) return undefined;
  const meta = asRecord(record._meta);
  const ui = asRecord(meta?.ui);
  const annotations = asRecord(record.annotations);
  const title = boundedName(record.title) ?? boundedName(annotations?.title);
  const resourceUri = toolUiResourceUri(meta);
  const { visibility, declared } = toolUiVisibility(meta);
  const readOnly = annotations?.readOnlyHint ?? annotations?.readOnly;
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    visibility,
    visibilityDeclared: declared,
    ...(typeof readOnly === "boolean" ? { readOnlyHint: readOnly } : {}),
    declaresToolLevelSandbox: ui?.csp !== undefined || ui?.permissions !== undefined,
    raw: { ...record, ...(meta ? { _meta: stripReservedMcpAppMeta(meta) } : {}) },
  };
}

/** Absent visibility or a list containing "app": a widget may call the tool. */
export function toolAllowsApp(definition: McpAppToolDefinition): boolean {
  return !definition.visibilityDeclared || definition.visibility.includes("app");
}

/** Declared for widgets only: hidden from the model where Moss serves the tool list. */
export function isAppOnlyTool(definition: McpAppToolDefinition): boolean {
  return definition.visibilityDeclared && !definition.visibility.includes("model");
}

/** Raw `tools/list` entry variant of {@link isAppOnlyTool}, for filtering pass-through lists. */
export function isAppOnlyRawTool(rawTool: unknown): boolean {
  const meta = asRecord(asRecord(rawTool)?._meta);
  const { visibility, declared } = toolUiVisibility(meta);
  return declared && !visibility.includes("model");
}

export const MCP_APP_JSON_RPC_INVALID_REQUEST = -32600;
export const MCP_APP_JSON_RPC_INTERNAL_ERROR = -32603;

/** Host refusal: the tool is not in this server's current list (SPEC-protocol §1.2). */
export function mcpAppRefusalUnknownTool(toolName: string): string {
  return `The host refused this app's call to the tool "${toolName}" and did not send it, because the host has no tool of that name from this server that apps may call. The name may be wrong, the tool may be unlisted or blocked for this account, the server may have added it after the host last listed its tools, or the host may not have loaded this server's tools.`;
}

/** Host refusal: the tool's visibility does not list "app" (SPEC-protocol §1.2). */
export function mcpAppRefusalNotAppVisible(toolName: string): string {
  return `The host refused this app's call to the tool "${toolName}" and did not send it, because the tool's _meta.ui.visibility does not list "app". To let apps call this tool, make its _meta.ui.visibility a list that includes "app".`;
}

const RESERVED_META_PREFIXES = ["anthropic/", "moss/"];
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Removes host-reserved `_meta` keys (`anthropic/…`, `moss/…`) and prototype-like keys. */
export function stripReservedMcpAppMeta(meta: unknown): Record<string, unknown> | undefined {
  const record = asRecord(meta);
  if (!record) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    if (RESERVED_META_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    kept[key] = value;
  }
  return kept;
}

/** A `CallToolResult` with its `_meta` cleaned; other members pass through untouched. */
export function sanitizeCallToolResult(result: Record<string, unknown>): Record<string, unknown> {
  if (!("_meta" in result)) return result;
  const meta = stripReservedMcpAppMeta(result._meta);
  const { _meta: _dropped, ...rest } = result;
  return meta && Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest;
}

function jsonDepthWithin(value: unknown, maxDepth: number, depth = 0): boolean {
  if (depth > maxDepth) return false;
  if (Array.isArray(value))
    return value.every((entry) => jsonDepthWithin(entry, maxDepth, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value).every((entry) => jsonDepthWithin(entry, maxDepth, depth + 1));
  }
  return true;
}

export type StructuredContentCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * `structuredContent` must be a plain object (or absent), within 262 144 JSON chars and depth 64.
 * A failing result is never handed to a widget (SPEC §3).
 */
export function checkStructuredContent(toolName: string, value: unknown): StructuredContentCheck {
  if (value === undefined) return { ok: true };
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : (typeof value as string);
  if (kind !== "object") {
    return {
      ok: false,
      message: `Tool '${toolName}' returned structuredContent of type '${kind}'; MCP servers exposing Apps must return an object (or omit the field)`,
    };
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    return {
      ok: false,
      message: `Tool '${toolName}' returned structuredContent that is not JSON.`,
    };
  }
  if (json.length > MCP_APP_STRUCTURED_CONTENT_MAX_CHARS) {
    return {
      ok: false,
      message: `Tool '${toolName}' returned structuredContent of ${json.length} characters; the host limit is ${MCP_APP_STRUCTURED_CONTENT_MAX_CHARS}.`,
    };
  }
  if (!jsonDepthWithin(value, MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH)) {
    return {
      ok: false,
      message: `Tool '${toolName}' returned structuredContent nested deeper than ${MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH} levels.`,
    };
  }
  return { ok: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Key-order-independent hash of tool arguments, for approvals and result matching. */
export function mcpArgsHash(args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(args ?? {}))
    .digest("hex");
}

/** Agent SDK server normalisation: anything outside [a-zA-Z0-9_-] becomes `_`. */
export function normalizeClaudeServerName(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

/** Agent SDK tool_result content block → MCP content block. */
export function claudeBlockToMcp(block: unknown): Record<string, unknown> {
  const record = asRecord(block) ?? {};
  if (record.type === "image") {
    const source = asRecord(record.source);
    if (source?.type === "base64" && typeof source.data === "string") {
      return {
        type: "image",
        data: source.data,
        mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
      };
    }
  }
  if (record.type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  return record;
}
