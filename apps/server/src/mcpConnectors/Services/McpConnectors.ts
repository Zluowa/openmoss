/**
 * McpConnectors - Connectors: remote MCP servers the user signs in to
 * from Settings. Holds their tokens, and proxies provider sessions to them
 * through the agent gateway.
 *
 * @module mcpConnectors/Services/McpConnectors
 */
import type {
  McpConnector,
  McpConnectorConnectInput,
  McpConnectorConnectResult,
  McpConnectorSetup,
  MossAppConnection,
  MossAppsConnectFieldsResult,
  MossAppsConnectResult,
  MossAppsListToolkitsInput,
  MossAppsListToolkitsResult,
  MossAppsStatus,
  MossAppToolkit,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { McpConnectorProxyResult } from "../proxy.ts";
import type { McpConnectorCallbackOutcome, McpConnectorForwardRequest } from "../runtime.ts";

export class McpConnectorError extends Data.TaggedError("McpConnectorError")<{
  /** Written for the person connecting; safe to show in the UI. */
  readonly message: string;
  /** Machine-readable reason, e.g. MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE. */
  readonly code?: string;
  readonly cause?: unknown;
}> {}

/** Moss Apps: hosted third-party apps reached through one gateway connector. */
export interface MossAppsShape {
  readonly status: () => Effect.Effect<MossAppsStatus>;
  readonly listToolkits: (
    input: MossAppsListToolkitsInput,
  ) => Effect.Effect<MossAppsListToolkitsResult, McpConnectorError>;
  readonly listConnections: () => Effect.Effect<
    ReadonlyArray<MossAppConnection>,
    McpConnectorError
  >;
  readonly connectFields: (
    toolkitSlug: string,
  ) => Effect.Effect<MossAppsConnectFieldsResult, McpConnectorError>;
  readonly connect: (
    toolkitSlug: string,
    credentials?: Readonly<Record<string, string>>,
  ) => Effect.Effect<MossAppsConnectResult, McpConnectorError>;
  readonly disconnect: (connectionId: string) => Effect.Effect<boolean, McpConnectorError>;
  /** An app from the catalog Moss already holds, for pages that name it; never fetches. */
  readonly cachedToolkit: (toolkitSlug: string) => MossAppToolkit | null;
}

export interface McpConnectorsShape {
  /** False on Stable: every user-connector method refuses and those routes answer 404. */
  readonly enabled: boolean;
  /** Whether the gateway connector routes serve anything (user connectors or Moss Apps). */
  readonly gatewayEnabled: boolean;
  readonly mossApps: MossAppsShape;
  readonly list: () => Effect.Effect<ReadonlyArray<McpConnector>, McpConnectorError>;
  readonly connect: (
    input: McpConnectorConnectInput,
  ) => Effect.Effect<McpConnectorConnectResult, McpConnectorError>;
  readonly disconnect: (connectorId: string) => Effect.Effect<boolean, McpConnectorError>;
  /** What a user's own OAuth app needs, such as its redirect URL. */
  readonly setup: () => Effect.Effect<McpConnectorSetup, McpConnectorError>;
  /** The OAuth redirect target; never fails, the outcome is rendered as a page. */
  readonly completeAuthorization: (query: {
    readonly state: string | undefined;
    readonly code: string | undefined;
    readonly error: string | undefined;
    readonly errorDescription: string | undefined;
  }) => Effect.Effect<McpConnectorCallbackOutcome>;
  /** Proxies one MCP exchange; failures come back as JSON-RPC errors. */
  readonly forward: (
    connectorId: string,
    request: McpConnectorForwardRequest,
  ) => Effect.Effect<McpConnectorProxyResult>;
}

export class McpConnectors extends ServiceMap.Service<McpConnectors, McpConnectorsShape>()(
  "moss/mcpConnectors/Services/McpConnectors",
) {}
