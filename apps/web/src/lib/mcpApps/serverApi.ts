// FILE: serverApi.ts
// Purpose: The web host's calls to the Moss server for interactive connectors (PLAN §2.2):
//          resource read, full tool result, widget RPC, model context, resource download.
//          Responses are checked by shape here; nothing is logged or persisted.
// Layer: Web MCP App host transport
// Exports: readMcpAppResource, fetchMcpAppToolResult, callMcpAppRpc, postMcpAppModelContext,
//          downloadMcpAppResource, McpAppServerError

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAppResourceCsp } from "@moss/contracts";
import { MCP_APP_RESOURCE_READ_ROUTE_PATH } from "@moss/shared/mcpAppResource";

import { resolveWsHttpUrl } from "../wsHttpUrl";
import {
  MCP_APP_MODEL_CONTEXT_ROUTE_PATH,
  MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH,
  MCP_APP_RPC_ROUTE_PATH,
  MCP_APP_TOOL_RESULT_ROUTE_PATH,
  type McpAppModelContextRequest,
  type McpAppPermissionName,
  type McpAppPermissions,
  type McpAppResourceContents,
  type McpAppResourceDownloadRequest,
  type McpAppResourceRead,
  type McpAppResourceReadRequest,
  type McpAppRpcRequest,
  type McpAppRpcResponse,
  type McpAppToolResultResponse,
} from "./contracts";

/** A transport or contract failure; its message is for logs and widgets, never for people. */
export class McpAppServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpAppServerError";
  }
}

export interface McpAppRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postJson(
  path: string,
  body: unknown,
  options: McpAppRequestOptions,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(resolveWsHttpUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new McpAppServerError("The Moss server could not be reached.");
  }
  if (!response.ok) {
    throw new McpAppServerError(
      `The Moss server answered HTTP ${response.status}.`,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new McpAppServerError("The Moss server answered with invalid JSON.");
  }
  if (!isRecord(parsed)) throw new McpAppServerError("The Moss server answered an unknown shape.");
  return parsed;
}

const EMPTY_CSP: McpAppResourceCsp = {
  baseUriDomains: [],
  connectDomains: [],
  frameDomains: [],
  includeDefaultDomains: false,
  isTrusted: false,
  resourceDomains: [],
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readCsp(value: unknown): McpAppResourceCsp {
  if (!isRecord(value)) return EMPTY_CSP;
  return {
    baseUriDomains: stringList(value.baseUriDomains),
    connectDomains: stringList(value.connectDomains),
    frameDomains: stringList(value.frameDomains),
    includeDefaultDomains: value.includeDefaultDomains === true,
    isTrusted: value.isTrusted === true,
    resourceDomains: stringList(value.resourceDomains),
  };
}

const PERMISSION_NAMES: readonly McpAppPermissionName[] = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
];

export function readMcpAppPermissions(value: unknown): McpAppPermissions {
  if (!isRecord(value)) return {};
  const permissions: McpAppPermissions = {};
  for (const name of PERMISSION_NAMES) {
    if (value[name] !== undefined && value[name] !== false && value[name] !== null) {
      permissions[name] = {};
    }
  }
  return permissions;
}

/** `POST /api/provider/mcp-app-resource/read`, tolerant of the pre- and post-A response shape. */
export async function readMcpAppResource(
  input: McpAppResourceReadRequest,
  options: McpAppRequestOptions = {},
): Promise<McpAppResourceRead> {
  const body = await postJson(MCP_APP_RESOURCE_READ_ROUTE_PATH, input, options);
  if (body.resourceUri !== input.resourceUri) {
    throw new McpAppServerError("The resource answer named a different resource.");
  }
  if (body.state === "no_content") return { state: "no_content", resourceUri: input.resourceUri };
  if (body.state === "too_large") return { state: "too_large", resourceUri: input.resourceUri };
  if (body.state !== "ready" || typeof body.html !== "string") {
    throw new McpAppServerError("The resource answer had an unknown state.");
  }
  const domain =
    typeof body.domain === "string"
      ? body.domain
      : typeof body.widgetDomain === "string"
        ? body.widgetDomain
        : null;
  return {
    state: "ready",
    resourceUri: input.resourceUri,
    html: body.html,
    csp: readCsp(body.csp),
    permissions: readMcpAppPermissions(body.permissions),
    prefersBorder: typeof body.prefersBorder === "boolean" ? body.prefersBorder : undefined,
    domain,
    stableOrigin: body.stableOrigin === true,
    isCollapsible: body.isCollapsible !== false,
  };
}

/** `POST /api/provider/mcp-app/tool-result`. */
export async function fetchMcpAppToolResult(
  input: { readonly threadId: string; readonly callId: string },
  options: McpAppRequestOptions = {},
): Promise<McpAppToolResultResponse> {
  const body = await postJson(MCP_APP_TOOL_RESULT_ROUTE_PATH, input, options);
  if (body.status === "pending") return { status: "pending" };
  if (body.status === "missing") return { status: "missing" };
  if (body.status === "failed") {
    return {
      status: "failed",
      ...(typeof body.message === "string" ? { message: body.message } : {}),
    };
  }
  if (body.status === "ready" && isRecord(body.result) && Array.isArray(body.result.content)) {
    return {
      status: "ready",
      input: isRecord(body.input) ? body.input : {},
      result: body.result as CallToolResult,
    };
  }
  throw new McpAppServerError("The tool result answer had an unknown status.");
}

/** `POST /api/provider/mcp-app/rpc`. */
export async function callMcpAppRpc(
  input: McpAppRpcRequest,
  options: McpAppRequestOptions = {},
): Promise<McpAppRpcResponse> {
  const body = await postJson(MCP_APP_RPC_ROUTE_PATH, input, options);
  if (isRecord(body.needsApproval) && typeof body.needsApproval.token === "string") {
    const approval = body.needsApproval;
    return {
      needsApproval: {
        token: approval.token as string,
        toolName: typeof approval.toolName === "string" ? approval.toolName : "",
        serverLabel: typeof approval.serverLabel === "string" ? approval.serverLabel : "",
        ...(typeof approval.reason === "string" ? { reason: approval.reason } : {}),
      },
    };
  }
  if (isRecord(body.error)) {
    return {
      error: {
        code: typeof body.error.code === "number" ? body.error.code : -32603,
        message: typeof body.error.message === "string" ? body.error.message : "Request failed.",
        ...(body.error.data !== undefined ? { data: body.error.data } : {}),
      },
    };
  }
  if (isRecord(body.result)) return { result: body.result };
  throw new McpAppServerError("The widget request answer had an unknown shape.");
}

/** `POST /api/provider/mcp-app/model-context`; resolves the error message, or null when accepted. */
export async function postMcpAppModelContext(
  input: McpAppModelContextRequest,
  options: McpAppRequestOptions = {},
): Promise<string | null> {
  const body = await postJson(MCP_APP_MODEL_CONTEXT_ROUTE_PATH, input, options);
  if (isRecord(body.error)) {
    return typeof body.error.message === "string" ? body.error.message : "Rejected.";
  }
  return null;
}

/** `POST /api/provider/mcp-app/resource-download`. */
export async function downloadMcpAppResource(
  input: McpAppResourceDownloadRequest,
  options: McpAppRequestOptions = {},
): Promise<McpAppResourceContents[]> {
  const body = await postJson(MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH, input, options);
  if (!Array.isArray(body.contents)) {
    throw new McpAppServerError("The download answer had no contents.");
  }
  return body.contents.flatMap((entry): McpAppResourceContents[] => {
    if (!isRecord(entry) || typeof entry.uri !== "string") return [];
    return [
      {
        uri: entry.uri,
        ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
        ...(typeof entry.text === "string" ? { text: entry.text } : {}),
        ...(typeof entry.blob === "string" ? { blob: entry.blob } : {}),
      },
    ];
  });
}
