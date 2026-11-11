// FILE: contracts.ts
// Purpose: Local mirrors of the interactive-connector interfaces the web host codes against
//          (PLAN §2.1 binding, §2.2 server HTTP, §2.3 desktop bridge) while workers A and B land
//          them. Replace with @moss/contracts after A and B merge.
// Layer: Web MCP App host contracts
// Exports: McpAppBinding, server request/response types, desktop bridge extension types

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpAppResourceCsp,
  McpAppSandboxDescriptor,
  McpAppSandboxRegisterInput,
} from "@moss/contracts";

// ── PLAN §2.1 — work-log binding (replace with @moss/contracts after A merges) ──

export type McpAppBindingSource = "toolDefinition" | "appContext" | "resultMeta" | "legacy";
export type McpAppToolVisibility = "model" | "app";

export interface McpAppBinding {
  /** Provider's server name as the tool call names it. */
  readonly server: string;
  /** Stable key for origin and preferences: connector id | "moss" | CLI server name. */
  readonly serverKey: string;
  /** Display name: connector title, else the server name. */
  readonly serverLabel: string;
  readonly toolName: string;
  readonly toolTitle?: string | undefined;
  readonly resourceUri: string;
  readonly source: McpAppBindingSource;
  readonly connectorId?: string | undefined;
  readonly connectorUrl?: string | undefined;
  readonly isFirstParty: boolean;
  readonly visibility: readonly McpAppToolVisibility[];
}

// ── PLAN §2.2 — server HTTP (replace with @moss/contracts after A merges) ──

export const MCP_APP_TOOL_RESULT_ROUTE_PATH = "/api/provider/mcp-app/tool-result";
export const MCP_APP_RPC_ROUTE_PATH = "/api/provider/mcp-app/rpc";
export const MCP_APP_MODEL_CONTEXT_ROUTE_PATH = "/api/provider/mcp-app/model-context";
export const MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH = "/api/provider/mcp-app/resource-download";

export type McpAppPermissionName = "camera" | "microphone" | "geolocation" | "clipboardWrite";
/** The ext-apps shape the widget sees (`{camera: {}}`), used for resource-ready and capabilities. */
export type McpAppPermissions = Partial<Record<McpAppPermissionName, Record<string, never>>>;
/** B's desktop shape (`{camera: true}`), used for register and requestPermissions. */
export type McpAppSandboxPermissions = Partial<Record<McpAppPermissionName, boolean>>;

export interface McpAppResourceReadRequest {
  readonly threadId: string;
  readonly callId: string;
  readonly server: string;
  readonly resourceUri: string;
  readonly source: McpAppBindingSource;
  readonly connectorId?: string;
  readonly toolName?: string;
}

export type McpAppResourceRead =
  | {
      readonly state: "ready";
      readonly resourceUri: string;
      readonly html: string;
      readonly csp: McpAppResourceCsp;
      readonly permissions: McpAppPermissions;
      readonly prefersBorder: boolean | undefined;
      readonly domain: string | null;
      readonly stableOrigin: boolean;
      readonly isCollapsible: boolean;
    }
  | { readonly state: "no_content"; readonly resourceUri: string }
  | { readonly state: "too_large"; readonly resourceUri: string };

export type McpAppToolResultResponse =
  | {
      readonly status: "ready";
      readonly input: Record<string, unknown>;
      readonly result: CallToolResult;
    }
  | { readonly status: "pending" }
  | { readonly status: "missing" };

export type McpAppRpcMethod =
  | "tools/call"
  | "tools/list"
  | "resources/read"
  | "resources/list"
  | "resources/templates/list"
  | "prompts/list";

export interface McpAppRpcRequest {
  readonly threadId: string;
  readonly callId: string;
  readonly server: string;
  readonly method: McpAppRpcMethod;
  readonly params: Record<string, unknown>;
  readonly approvalToken?: string;
}

export interface McpAppRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface McpAppNeedsApproval {
  readonly token: string;
  readonly toolName: string;
  readonly serverLabel: string;
  readonly reason?: string;
}

export type McpAppRpcResponse =
  | { readonly result: Record<string, unknown> }
  | { readonly error: McpAppRpcError }
  | { readonly needsApproval: McpAppNeedsApproval };

export interface McpAppModelContextRequest {
  readonly threadId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}

export type McpAppModelContextResponse =
  | Record<string, never>
  | { readonly error: { readonly message: string } };

export interface McpAppResourceDownloadRequest {
  readonly threadId: string;
  /** The call that rendered the widget (A checks the server matches it). Always sent. */
  readonly callId: string;
  readonly server: string;
  readonly uri: string;
}

export interface McpAppResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

// ── PLAN §2.3 — desktop bridge (replace with @moss/contracts after B merges) ──

export type McpAppSandboxRegisterInputV2 = McpAppSandboxRegisterInput & {
  readonly serverKey: string;
  readonly stableOrigin: boolean;
  readonly connectorUrl?: string;
  /** What the resource declared; main grants nothing until requestPermissions. */
  readonly permissions?: McpAppSandboxPermissions;
};

export interface McpAppDesktopBridge {
  readonly register: (
    input: McpAppSandboxRegisterInputV2,
  ) => Promise<McpAppSandboxDescriptor | null>;
  readonly unregister: (input: {
    readonly sandboxId: string;
    readonly initId: string;
    readonly generation: number;
  }) => Promise<boolean>;
  readonly openExternal?: (url: string) => Promise<{ readonly opened: boolean }>;
  readonly saveDownload?: (input: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly text?: string;
    readonly base64?: string;
  }) => Promise<{ readonly saved: boolean }>;
  /**
   * Replaces the partition's grant with exactly `permissions` (`{}` revokes) and answers what is
   * now granted. Main grants nothing to a widget that declares frame sites.
   */
  readonly requestPermissions?: (
    sandboxId: string,
    permissions: McpAppSandboxPermissions,
  ) => Promise<{ readonly granted: McpAppSandboxPermissions }>;
}

/** Every shell -> host message on the bridge port (B: `MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE`). */
export const MCP_APP_PORT_MESSAGE_TYPE = "moss:mcp-app-message" as const;
export interface McpAppSandboxBridgeEnvelope {
  readonly type: typeof MCP_APP_PORT_MESSAGE_TYPE;
  readonly message: Readonly<Record<string, unknown>>;
  /** True when the widget's message was sent with an active user activation. */
  readonly userActivation: boolean;
}

/** Mirror of B's `decodeMcpAppSandboxBridgeEnvelope`: exact keys, object message, boolean flag. */
export function decodeMcpAppSandboxBridgeEnvelope(
  value: unknown,
): McpAppSandboxBridgeEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "message,type,userActivation") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== MCP_APP_PORT_MESSAGE_TYPE) return null;
  const message = candidate.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  if (typeof candidate.userActivation !== "boolean") return null;
  return {
    type: MCP_APP_PORT_MESSAGE_TYPE,
    message: message as Readonly<Record<string, unknown>>,
    userActivation: candidate.userActivation,
  };
}

export function readMcpAppDesktopBridge(): McpAppDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { desktopBridge?: { mcpApps?: unknown } }).desktopBridge?.mcpApps;
  return bridge ? (bridge as McpAppDesktopBridge) : null;
}
