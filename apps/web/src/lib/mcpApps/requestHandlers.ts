// FILE: requestHandlers.ts
// Purpose: The host side of every widget request (SPEC §5–§10): server calls through the Moss
//          server (with Moss's approval step), `ui/message`, `ui/open-link`, `ui/download-file`,
//          `ui/request-display-mode`, `ui/update-model-context` and logging. Pure of React and
//          of the sandbox so each rule is testable with mocks.
// Layer: Web MCP App host protocol
// Exports: createMcpAppRequestHandlers, stripMcpAppReservedMeta, validateMcpAppCallToolResult,
//          McpAppRequestHandlerDeps

import type {
  McpUiDownloadFileRequest,
  McpUiDownloadFileResult,
  McpUiMessageRequest,
  McpUiMessageResult,
  McpUiOpenLinkResult,
  McpUiRequestDisplayModeResult,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  MCP_APP_LOGGER_NAME_MAX,
  MCP_APP_RPC_TIMEOUT_MS,
  MCP_APP_STRUCTURED_CONTENT_MAX_CHARS,
  MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH,
  MCP_APP_TOOL_CALL_TIMEOUT_MS,
} from "./constants";
import type {
  McpAppBinding,
  McpAppDesktopBridge,
  McpAppNeedsApproval,
  McpAppResourceContents,
  McpAppRpcMethod,
  McpAppRpcRequest,
  McpAppRpcResponse,
} from "./contracts";
import { createMcpAppMessageRouter, type McpAppMessageRouterDeps } from "./messageRouting";
import { classifyMcpAppLink, type McpAppLinkPlan } from "./openLink";
import type { McpAppRequestOptions } from "./serverApi";

const RESERVED_META_PREFIXES = ["anthropic/", "moss/"] as const;
const DECLINED_TEXT = "The person declined this tool call.";

export interface McpAppDownloadItem {
  readonly fileName: string;
  readonly mimeType: string;
  readonly source:
    | { readonly kind: "embedded"; readonly text?: string; readonly base64?: string }
    | { readonly kind: "link"; readonly uri: string };
}

export interface McpAppRequestHandlerDeps {
  readonly threadId: string;
  readonly callId: string;
  readonly binding: McpAppBinding;
  readonly api: {
    readonly rpc: (
      input: McpAppRpcRequest,
      options?: McpAppRequestOptions,
    ) => Promise<McpAppRpcResponse>;
    readonly modelContext: (
      input: {
        threadId: string;
        callId: string;
        toolName: string;
        content?: unknown;
        structuredContent?: unknown;
      },
      options?: McpAppRequestOptions,
    ) => Promise<string | null>;
    readonly resourceDownload: (
      input: { threadId: string; callId: string; server: string; uri: string },
      options?: McpAppRequestOptions,
    ) => Promise<McpAppResourceContents[]>;
  };
  readonly desktop: Pick<McpAppDesktopBridge, "openExternal" | "saveDownload"> | null;
  /** Moss's approval step for one widget tool call; resolves true when allowed. */
  readonly askApproval: (request: McpAppNeedsApproval) => Promise<boolean>;
  /** The connector sign-in card; resolves true when the person signed in. */
  readonly askSignIn: () => Promise<boolean>;
  /** The open-link dialog; resolves null when cancelled or busy. */
  readonly confirmLink: (
    plan: Extract<McpAppLinkPlan, { action: "confirm" }>,
  ) => Promise<{ readonly dontAskAgain: boolean } | null>;
  readonly isLinkTrusted: (trustKey: string) => boolean;
  readonly trustLink: (trustKey: string) => void;
  readonly openInApp: (path: string) => void;
  readonly appOrigin: string | null;
  readonly confirmDownload: (items: readonly McpAppDownloadItem[]) => Promise<boolean>;
  readonly displayMode: () => "inline" | "fullscreen";
  readonly paneAvailable: () => boolean;
  readonly setDisplayMode: (
    mode: "inline" | "fullscreen",
  ) => Promise<"inline" | "fullscreen"> | "inline" | "fullscreen";
  readonly message: Omit<McpAppMessageRouterDeps, "isFirstParty" | "serverLabel">;
  readonly log?: (...parts: unknown[]) => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Copy of `meta` without host-reserved keys and prototype-like keys. */
export function stripMcpAppReservedMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(meta)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (RESERVED_META_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = value;
  }
  return result;
}

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (max, entry) => Math.max(max, jsonDepth(entry, depth + 1)),
      depth + 1,
    );
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>(
      (max, entry) => Math.max(max, jsonDepth(entry, depth + 1)),
      depth + 1,
    );
  }
  return depth;
}

/**
 * The result as the widget may see it, or null when it must not be sent (structuredContent that
 * is not a plain object, or over the size/depth budget).
 */
export function validateMcpAppCallToolResult(result: CallToolResult): CallToolResult | null {
  const { structuredContent, _meta, ...rest } = result;
  if (structuredContent !== undefined) {
    if (!isPlainRecord(structuredContent)) return null;
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(structuredContent);
    } catch {
      return null;
    }
    if (
      encoded === undefined ||
      encoded.length > MCP_APP_STRUCTURED_CONTENT_MAX_CHARS ||
      jsonDepth(structuredContent) > MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH
    ) {
      return null;
    }
  }
  const meta = stripMcpAppReservedMeta(_meta);
  return {
    ...rest,
    content: Array.isArray(rest.content) ? rest.content : [],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

/** A's sign-in signal: `{code: -32001, data: {authRequired: true, connectorId}}`. */
function isAuthError(error: { code: number; data?: unknown }): boolean {
  const data = error.data as { authRequired?: unknown } | undefined;
  return error.code === -32001 && data?.authRequired === true;
}

function sanitizeFileName(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").split(/[\\/]/u).pop() ?? "";
  const cleaned = [...raw]
    .filter((char) => char.charCodeAt(0) >= 0x20 && !'<>:"|?*'.includes(char))
    .join("")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

function nameFromUri(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    const segment = url.pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

export function toMcpAppDownloadItems(
  contents: McpUiDownloadFileRequest["params"]["contents"],
): McpAppDownloadItem[] | null {
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > 20) return null;
  const items: McpAppDownloadItem[] = [];
  for (const [index, entry] of contents.entries()) {
    const fallback = `file-${index + 1}`;
    if (entry?.type === "resource" && entry.resource && typeof entry.resource.uri === "string") {
      const resource = entry.resource as {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
      if (typeof resource.text !== "string" && typeof resource.blob !== "string") return null;
      items.push({
        fileName: sanitizeFileName(nameFromUri(resource.uri), fallback),
        mimeType: resource.mimeType ?? "application/octet-stream",
        source: {
          kind: "embedded",
          ...(typeof resource.text === "string" ? { text: resource.text } : {}),
          ...(typeof resource.blob === "string" ? { base64: resource.blob } : {}),
        },
      });
      continue;
    }
    if (entry?.type === "resource_link" && typeof entry.uri === "string") {
      items.push({
        fileName: sanitizeFileName(entry.name ?? nameFromUri(entry.uri), fallback),
        mimeType: entry.mimeType ?? "application/octet-stream",
        source: { kind: "link", uri: entry.uri },
      });
      continue;
    }
    return null;
  }
  return items;
}

function rpcError(error: { code: number; message: string; data?: unknown }): McpError {
  return new McpError(error.code, error.message, error.data);
}

export function createMcpAppRequestHandlers(deps: McpAppRequestHandlerDeps) {
  const { binding } = deps;
  const log = deps.log ?? ((...parts: unknown[]) => console.info(...parts));
  const routeMessage = createMcpAppMessageRouter({
    ...deps.message,
    isFirstParty: binding.isFirstParty,
    serverLabel: binding.serverLabel,
  });
  let displayModeRefusalLogged = false;

  async function rpcOnce(
    method: McpAppRpcMethod,
    params: Record<string, unknown>,
    approvalToken?: string,
  ): Promise<McpAppRpcResponse> {
    const timeout = method === "tools/call" ? MCP_APP_TOOL_CALL_TIMEOUT_MS : MCP_APP_RPC_TIMEOUT_MS;
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeout)
        : undefined;
    try {
      return await deps.api.rpc(
        {
          threadId: deps.threadId,
          callId: deps.callId,
          server: binding.server,
          method,
          params,
          ...(approvalToken ? { approvalToken } : {}),
        },
        { signal },
      );
    } catch {
      throw new McpError(ErrorCode.InternalError, "The host could not reach the server.");
    }
  }

  function withoutReservedMeta(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const { _meta, ...rest } = params ?? {};
    const meta = stripMcpAppReservedMeta(_meta);
    return meta && Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest;
  }

  async function proxy(method: Exclude<McpAppRpcMethod, "tools/call">, params: unknown) {
    const response = await rpcOnce(method, withoutReservedMeta(params as Record<string, unknown>));
    if ("error" in response) throw rpcError(response.error);
    if ("needsApproval" in response) {
      throw new McpError(ErrorCode.InvalidRequest, "The host refused this request.");
    }
    return response.result;
  }

  async function callTool(params: {
    name: string;
    arguments?: Record<string, unknown> | undefined;
  }): Promise<CallToolResult> {
    const request = withoutReservedMeta(params as Record<string, unknown>);
    let signedInRetry = false;
    let approvalToken: string | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await rpcOnce("tools/call", request, approvalToken);
      if ("needsApproval" in response) {
        if (approvalToken) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "The host could not confirm this tool call.",
          );
        }
        const allowed = await deps.askApproval({
          ...response.needsApproval,
          toolName: response.needsApproval.toolName || params.name,
          serverLabel: response.needsApproval.serverLabel || binding.serverLabel,
        });
        if (!allowed) return { content: [{ type: "text", text: DECLINED_TEXT }], isError: true };
        approvalToken = response.needsApproval.token;
        continue;
      }
      if ("error" in response) {
        if (!signedInRetry && isAuthError(response.error)) {
          signedInRetry = true;
          approvalToken = undefined;
          if (await deps.askSignIn()) continue;
        }
        throw rpcError(response.error);
      }
      const validated = validateMcpAppCallToolResult(response.result as CallToolResult);
      if (!validated) {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool '${params.name}' returned structuredContent that is not an object; MCP servers exposing Apps must return an object (or omit the field).`,
        );
      }
      return validated;
    }
    throw new McpError(ErrorCode.InternalError, "The host gave up on this tool call.");
  }

  async function message(
    params: McpUiMessageRequest["params"],
    userActivation: boolean,
  ): Promise<McpUiMessageResult> {
    return routeMessage(params, userActivation);
  }

  async function open(url: string): Promise<McpUiOpenLinkResult> {
    if (!deps.desktop?.openExternal) return { isError: true };
    try {
      const { opened } = await deps.desktop.openExternal(url);
      return opened ? {} : { isError: true };
    } catch {
      return { isError: true };
    }
  }

  async function openLink(
    params: { url: string },
    userActivation: boolean,
  ): Promise<McpUiOpenLinkResult> {
    const plan = classifyMcpAppLink(params?.url, deps.appOrigin);
    if (plan.action === "refuse") return { isError: true };
    if (plan.action === "in_app") {
      deps.openInApp(plan.path);
      return {};
    }
    if (plan.kind === "web" && userActivation && deps.isLinkTrusted(plan.trustKey)) {
      return open(plan.url);
    }
    const answer = await deps.confirmLink(plan);
    if (!answer) return { isError: true };
    if (answer.dontAskAgain && plan.kind === "web") deps.trustLink(plan.trustKey);
    return open(plan.url);
  }

  async function downloadFile(
    params: McpUiDownloadFileRequest["params"],
  ): Promise<McpUiDownloadFileResult> {
    const items = toMcpAppDownloadItems(params?.contents);
    const save = deps.desktop?.saveDownload;
    if (!items || !save) return { isError: true };
    if (!(await deps.confirmDownload(items))) return { isError: true };
    try {
      for (const item of items) {
        if (item.source.kind === "embedded") {
          const { saved } = await save({
            fileName: item.fileName,
            mimeType: item.mimeType,
            ...(item.source.text !== undefined ? { text: item.source.text } : {}),
            ...(item.source.base64 !== undefined ? { base64: item.source.base64 } : {}),
          });
          if (!saved) return { isError: true };
          continue;
        }
        const contents = await deps.api.resourceDownload({
          threadId: deps.threadId,
          callId: deps.callId,
          server: binding.server,
          uri: item.source.uri,
        });
        for (const content of contents) {
          const { saved } = await save({
            fileName: item.fileName,
            mimeType: content.mimeType ?? item.mimeType,
            ...(content.text !== undefined ? { text: content.text } : {}),
            ...(content.blob !== undefined ? { base64: content.blob } : {}),
          });
          if (!saved) return { isError: true };
        }
      }
    } catch {
      return { isError: true };
    }
    return {};
  }

  async function requestDisplayMode(
    params: { mode: string },
    userActivation: boolean,
  ): Promise<McpUiRequestDisplayModeResult> {
    const current = deps.displayMode();
    const mode = params?.mode;
    if (mode !== "inline" && mode !== "fullscreen") return { mode: current };
    if (mode === current) return { mode: current };
    if (mode === "fullscreen") {
      if (!deps.paneAvailable()) return { mode: current };
      if (!userActivation) {
        if (!displayModeRefusalLogged) {
          displayModeRefusalLogged = true;
          log(
            `[${binding.serverLabel}] Fullscreen request refused: ask for it from a click or key press in the app.`,
          );
        }
        return { mode: current };
      }
    }
    try {
      return { mode: await deps.setDisplayMode(mode) };
    } catch {
      return { mode: deps.displayMode() };
    }
  }

  async function updateModelContext(params: McpUiUpdateModelContextRequest["params"]) {
    const rejection = await deps.api
      .modelContext({
        threadId: deps.threadId,
        callId: deps.callId,
        toolName: binding.toolName,
        ...(params?.content !== undefined ? { content: params.content } : {}),
        ...(params?.structuredContent !== undefined
          ? { structuredContent: params.structuredContent }
          : {}),
      })
      .catch(() => "The host could not store this context.");
    if (rejection) throw new McpError(ErrorCode.InvalidParams, rejection);
    return {};
  }

  function logging(params: { level?: unknown; logger?: unknown; data?: unknown }): void {
    const logger =
      typeof params?.logger === "string" ? params.logger.slice(0, MCP_APP_LOGGER_NAME_MAX) : null;
    log(
      `[${binding.serverLabel}]${logger ? ` ${logger}` : ""}`,
      typeof params?.level === "string" ? params.level : "info",
      params?.data,
    );
  }

  return {
    callTool,
    listTools: (params: unknown) => proxy("tools/list", params),
    readResource: (params: unknown) => proxy("resources/read", params),
    listResources: (params: unknown) => proxy("resources/list", params),
    listResourceTemplates: (params: unknown) => proxy("resources/templates/list", params),
    listPrompts: (params: unknown) => proxy("prompts/list", params),
    message,
    openLink,
    downloadFile,
    requestDisplayMode,
    updateModelContext,
    logging,
  };
}

export type McpAppRequestHandlers = ReturnType<typeof createMcpAppRequestHandlers>;
