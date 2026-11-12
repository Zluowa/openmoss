/**
 * McpAppService - Moss's interactive connectors (MCP Apps) runtime state.
 *
 * Holds what a widget host needs beyond the durable transcript: tool definitions with
 * `_meta.ui` per thread and server, the binding of each widget call to its server, full tool
 * results (runtime store, not the journal), `ui/update-model-context` state, approval tokens and
 * the Moss gateway's own UI resources. It has no dependency on provider or connector services so
 * both can call it; request-time operations live in `mcpApps/operations.ts`.
 *
 * @module mcpApps/Services/McpAppService
 */
import type { CodexMcpAppDescriptor, McpConnector, ProviderRuntimeEvent } from "@moss/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { McpAppApprovalTokens } from "../approvalTokens.ts";
import type { McpAppConnectorClient, McpAppConnectorForward } from "../connectorClient.ts";
import type { McpAppModelContextStore } from "../modelContext.ts";
import type { McpAppCallRecord, McpAppResourceCache, McpAppResultStore } from "../resultStore.ts";
import type { McpAppToolDefinition } from "../toolUi.ts";

/** Where a server named by a tool row lives, as far as Moss can tell. */
export type McpAppServerIdentity =
  | {
      readonly kind: "gateway";
      readonly server: string;
      readonly serverKey: "moss";
      readonly serverLabel: string;
    }
  | {
      readonly kind: "connector";
      readonly server: string;
      readonly serverKey: string;
      readonly serverLabel: string;
      readonly connectorId: string;
      readonly connectorUrl: string;
    }
  | {
      readonly kind: "provider";
      readonly server: string;
      readonly serverKey: string;
      readonly serverLabel: string;
    };

/** A `ui://` resource the Moss gateway serves itself. */
export interface McpAppGatewayResource {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: "text/html;profile=mcp-app";
  readonly text: () => string;
  /** Resource-level `_meta` (`ui.csp`, `ui.permissions`, `ui.prefersBorder`, ...). */
  readonly meta?: Record<string, unknown>;
}

/** What the gateway hands the runtime so widgets can reach `moss` tools. */
export interface McpAppGatewayRegistration {
  /** Served definitions, app-only tools included. */
  readonly listTools: () => ReadonlyArray<Record<string, unknown>>;
  /** Runs one gateway tool for a widget of `threadId` with the thread's own session scope. */
  readonly callTool: (input: {
    readonly threadId: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly meta?: Record<string, unknown>;
  }) => Effect.Effect<Record<string, unknown>>;
}

export interface McpAppCapturedCall {
  readonly threadId: string;
  readonly callId: string;
  readonly server?: string;
  readonly toolName?: string;
  readonly input?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly failed?: boolean;
}

export interface McpAppConnectorDirectoryEntry {
  readonly connectorId: string;
  readonly serverName: string;
  readonly name: string;
  readonly url: string;
}

export interface McpAppServiceShape {
  readonly results: McpAppResultStore;
  /** Last successful read of each CLI-own widget resource, for reads while the CLI is not running. */
  readonly resources: McpAppResourceCache;
  readonly modelContext: McpAppModelContextStore;
  readonly approvals: McpAppApprovalTokens;

  /** Adds binding fields to MCP tool rows and records widget calls. Pure for other events. */
  readonly enrichRuntimeEvent: (event: ProviderRuntimeEvent) => ProviderRuntimeEvent;
  /** A provider adapter saw the full raw result (Codex item, Agent SDK tool result). */
  readonly captureCall: (call: McpAppCapturedCall) => void;
  /** The connector proxy relayed a `tools/call`; `callIdHint` is `_meta["claudecode/toolUseId"]`. */
  readonly captureProxyCall: (input: {
    readonly threadId: string;
    /** Server name; or `connectorId`, resolved through the connector directory. */
    readonly server?: string;
    readonly connectorId?: string;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly callIdHint?: string;
    readonly result: Record<string, unknown>;
  }) => void;

  /**
   * Tool definitions a provider CLI reported for one of its servers on a thread. With `provider`,
   * the list is also kept on disk for when that CLI is not running (after a restart).
   */
  readonly recordProviderTools: (
    threadId: string,
    server: string,
    tools: ReadonlyArray<unknown>,
    provider?: string,
  ) => void;
  /** Tool definitions seen for a connector (proxy-observed or Moss's own listing). */
  readonly recordConnectorTools: (connectorId: string, tools: ReadonlyArray<unknown>) => void;
  readonly connectorTools: (connectorId: string) => ReadonlyArray<McpAppToolDefinition> | undefined;
  readonly connectorToolsFetchedAt: (connectorId: string) => number | undefined;
  readonly providerTools: (
    threadId: string,
    server: string,
  ) => ReadonlyArray<McpAppToolDefinition> | undefined;
  readonly gatewayTools: () => ReadonlyArray<McpAppToolDefinition>;

  readonly setConnectorDirectory: (entries: ReadonlyArray<McpAppConnectorDirectoryEntry>) => void;
  readonly classifyServer: (server: string) => McpAppServerIdentity;
  /** One shared upstream session per connector, opened lazily. */
  readonly connectorClient: (
    connectorId: string,
    forward: McpAppConnectorForward,
  ) => McpAppConnectorClient;

  readonly registerGateway: (registration: McpAppGatewayRegistration) => void;
  readonly gateway: () => McpAppGatewayRegistration | undefined;
  /** Adds a gateway `ui://moss/...` resource; returns its removal. */
  readonly registerGatewayResource: (resource: McpAppGatewayResource) => () => void;
  readonly gatewayResources: () => ReadonlyArray<McpAppGatewayResource>;

  /** The stored binding of one call (memory, then disk). */
  readonly callRecord: (
    threadId: string,
    callId: string,
  ) => Effect.Effect<McpAppCallRecord | undefined>;
  /** Whether a call is still running in this process. */
  readonly isCallPending: (threadId: string, callId: string) => boolean;
  /** Any binding of this thread for `server` (for resource downloads without a call id). */
  readonly threadHasServer: (threadId: string, server: string) => boolean;

  /**
   * Re-reads a connector's tool list through Moss's own client (deduplicated, at most once a
   * minute, aborted at shutdown). Never rejects.
   */
  readonly refreshConnectorTools: (
    connectorId: string,
    forward: McpAppConnectorForward,
  ) => Promise<void>;

  /** Connector rows decorated with interactive tool counts for the directory. */
  readonly decorateConnectors: (
    connectors: ReadonlyArray<McpConnector>,
  ) => ReadonlyArray<McpConnector>;
}

export class McpAppService extends ServiceMap.Service<McpAppService, McpAppServiceShape>()(
  "moss/mcpApps/Services/McpAppService",
) {}

export type { CodexMcpAppDescriptor as McpAppBindingDescriptor };
