/**
 * Provider-facing config builders for the Moss agent gateway.
 *
 * One shared module shapes the same MCP connection (endpoint URL + per-thread
 * bearer token) into every provider's native MCP configuration format so the
 * injection rules cannot drift between adapters:
 *
 * - Codex: a shared endpoint-only TOML block plus per-thread HTTP authorization,
 *   or the legacy `bearer_token_env_var` transport for environment-based callers.
 * - Claude Agent SDK: `mcpServers` record with an HTTP entry.
 * - ACP agents (cursor/grok/droid): `mcpServers` session entries; HTTP when
 *   the agent advertises `mcpCapabilities.http`, otherwise a stdio proxy that
 *   forwards to the HTTP endpoint.
 *
 * @module agentGateway/mcpInjection
 */
import type * as Acp from "@agentclientprotocol/sdk";

import type {
  AgentGatewayMcpConnection,
  AgentGatewayStdioProxySpawn,
} from "./Services/AgentGatewayCredentials.ts";

// Wire name stays "moss" so existing user configs ([mcp_servers.moss]) keep a
// single gateway entry after the upstream merge.
export const MOSS_MCP_SERVER_NAME = "moss";
// The wire env names stay MOSS_* for compatibility with the checked-in stdio
// proxy script and existing provider environments; only the exports were renamed.
export const MOSS_AGENT_GATEWAY_TOKEN_ENV = "MOSS_AGENT_GATEWAY_TOKEN";
export const MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV = "MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN";
export const MOSS_AGENT_GATEWAY_URL_ENV = "MOSS_AGENT_GATEWAY_URL";

function authorizationHeader(connection: AgentGatewayMcpConnection): string {
  return `Bearer ${connection.bearerToken}`;
}

/**
 * Client-side ceiling on one Moss tool call. Codex and Claude default to 60s,
 * but `moss_request_secret` waits up to an hour for the user to answer its
 * card; Moss tools keep their own shorter bounds.
 */
export const MOSS_MCP_TOOL_TIMEOUT_MS = 65 * 60 * 1_000;
const MOSS_MCP_TOOL_TIMEOUT_SEC = MOSS_MCP_TOOL_TIMEOUT_MS / 1_000;

/**
 * Codex reads MCP servers from `config.toml`; the config file is shared by all
 * sessions of one Codex home, so the token is never written into it. Instead
 * the block references an env var for environment-based callers, or omits it
 * when the manager supplies authorization in per-thread protocol configuration.
 *
 * The shell_environment_policy table keeps that env var out of exec tool
 * subprocesses: codex defaults to `ignore_default_excludes = true`, so the
 * built-in *TOKEN* filter is inactive and workspace commands would otherwise
 * inherit the gateway bearer token. Appended per-table, so a user-defined
 * policy table is never duplicated (their policy then governs).
 */
export function buildCodexMcpConfigToml(
  endpointUrl: string,
  credentialTransport: "environment" | "thread" = "environment",
): string {
  return [
    `[mcp_servers.${MOSS_MCP_SERVER_NAME}]`,
    `url = ${JSON.stringify(endpointUrl)}`,
    `tool_timeout_sec = ${MOSS_MCP_TOOL_TIMEOUT_SEC}`,
    ...(credentialTransport === "environment"
      ? [`bearer_token_env_var = ${JSON.stringify(MOSS_AGENT_GATEWAY_TOKEN_ENV)}`]
      : []),
    "",
    "[shell_environment_policy]",
    `exclude = [${JSON.stringify(MOSS_AGENT_GATEWAY_TOKEN_ENV)}]`,
  ].join("\n");
}

/** Sent only over the owned app-server pipe, never written to the shared home. */
export function buildCodexMcpThreadConfig(connection: AgentGatewayMcpConnection) {
  const headers = { Authorization: authorizationHeader(connection) };
  const mcpServers: Record<
    string,
    {
      readonly url: string;
      readonly http_headers: Record<string, string>;
      readonly tool_timeout_sec?: number;
    }
  > = {
    [MOSS_MCP_SERVER_NAME]: {
      url: connection.url,
      http_headers: headers,
      tool_timeout_sec: MOSS_MCP_TOOL_TIMEOUT_SEC,
    },
  };
  // Connectors only exist in the per-thread config: Codex starts servers it
  // first sees here, and the shared config.toml must stay secret-free.
  for (const connector of connection.connectors ?? []) {
    mcpServers[connector.name] = { url: connector.url, http_headers: headers };
  }
  return { mcp_servers: mcpServers };
}

export interface ClaudeMcpHttpServerConfig {
  readonly type: "http";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly timeout?: number;
}

export interface OpenCodeMcpRemoteServerConfig {
  readonly type: "remote";
  readonly url: string;
  readonly enabled: true;
  readonly headers: Record<string, string>;
  readonly oauth: false;
}

/**
 * OpenCode's dynamic `mcp.add` endpoint is server/directory scoped rather
 * than session scoped. Callers must install this config through either a
 * provider process dedicated to the owning Moss thread or an exclusive
 * external-server/directory lock held for the full agent turn.
 */
export function buildOpenCodeMcpServer(
  connection: AgentGatewayMcpConnection,
): OpenCodeMcpRemoteServerConfig {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: authorizationHeader(connection) },
    oauth: false,
  };
}

/** Connector proxies in OpenCode's `mcp.add` shape; same scoping rules as above. */
export function buildOpenCodeConnectorMcpServers(
  connection: AgentGatewayMcpConnection,
): Array<{ readonly name: string; readonly config: OpenCodeMcpRemoteServerConfig }> {
  return (connection.connectors ?? []).map((connector) => ({
    name: connector.name,
    config: {
      type: "remote",
      url: connector.url,
      enabled: true,
      headers: { Authorization: authorizationHeader(connection) },
      oauth: false,
    },
  }));
}

export interface AgentGatewayMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type AgentGatewayMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function postAgentGatewayJsonRpc(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly fetch?: AgentGatewayMcpFetch;
}): Promise<unknown> {
  const id = globalThis.crypto.randomUUID();
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(input.connection.url, {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(input.connection),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new Error(`Moss MCP request failed with HTTP ${String(response.status)}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new Error("Moss MCP returned an invalid JSON-RPC response.");
  }
  if ("error" in payload) {
    const failure = isRecord(payload.error) ? payload.error : null;
    throw new Error(failure?.message ? String(failure.message) : "Moss MCP request failed.");
  }
  if (payload.id !== id || !("result" in payload)) {
    throw new Error("Moss MCP returned a mismatched JSON-RPC response.");
  }
  return payload.result;
}

/** Load the canonical gateway tool descriptors for native-tool providers. */
export async function listAgentGatewayMcpTools(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<AgentGatewayMcpToolDescriptor>> {
  const result = await postAgentGatewayJsonRpc({
    ...input,
    method: "tools/list",
  });
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("Moss MCP tools/list returned an invalid tool catalog.");
  }
  return result.tools.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.description !== "string" ||
      !isRecord(value.inputSchema)
    ) {
      throw new Error("Moss MCP tools/list returned an invalid tool descriptor.");
    }
    return {
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
    };
  });
}

/** Invoke the canonical gateway dispatcher through its authenticated MCP route. */
export function callAgentGatewayMcpTool(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  return postAgentGatewayJsonRpc({
    connection: input.connection,
    method: "tools/call",
    params: { name: input.name, arguments: input.arguments },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function buildClaudeMcpServers(
  connection: AgentGatewayMcpConnection,
): Record<string, ClaudeMcpHttpServerConfig> {
  const headers = { Authorization: authorizationHeader(connection) };
  const servers: Record<string, ClaudeMcpHttpServerConfig> = {
    [MOSS_MCP_SERVER_NAME]: {
      type: "http",
      url: connection.url,
      headers,
      timeout: MOSS_MCP_TOOL_TIMEOUT_MS,
    },
  };
  for (const connector of connection.connectors ?? []) {
    servers[connector.name] = { type: "http", url: connector.url, headers };
  }
  return servers;
}

export type AcpStdioProxySpawn = AgentGatewayStdioProxySpawn;

export interface AntigravityMcpPluginConfig {
  readonly mcpServers: Record<
    string,
    {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Record<string, string>;
      readonly disabled: false;
      readonly disabledTools: ReadonlyArray<string>;
    }
  >;
}

/**
 * Build the secret-free MCP fragment installed with Moss's Antigravity
 * plugin. Antigravity expands the endpoint plus a one-shot bootstrap value
 * from each `agy` process. The stdio proxy consumes that value during MCP
 * initialization and keeps the exchanged session bearer in its own memory,
 * so `run_command` descendants never inherit the bearer.
 *
 * `ELECTRON_RUN_AS_NODE` keeps the generated proxy runnable when a packaged
 * desktop uses its Electron executable as `process.execPath`; it is harmless
 * for regular Node and Bun executables.
 */
export function buildAntigravityMcpPluginConfig(
  stdioProxy: AcpStdioProxySpawn,
): AntigravityMcpPluginConfig {
  return {
    mcpServers: {
      [MOSS_MCP_SERVER_NAME]: {
        command: stdioProxy.command,
        args: [...stdioProxy.args],
        env: {
          [MOSS_AGENT_GATEWAY_URL_ENV]: `$${MOSS_AGENT_GATEWAY_URL_ENV}`,
          [MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV]: `$${MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV}`,
          ELECTRON_RUN_AS_NODE: "1",
        },
        disabled: false,
        disabledTools: [],
      },
    },
  };
}

// Structural view of an ACP initialize response so callers with untyped
// (raw JSON) responses can reuse the same transport negotiation.
export interface AcpInitializeCapabilitiesView {
  readonly agentCapabilities?: {
    readonly mcpCapabilities?: {
      readonly http?: boolean;
    };
  } | null;
}

/**
 * Build the `mcpServers` entries for an ACP `session/new` / `session/load`
 * payload. Prefers the HTTP transport when the agent advertises support and
 * falls back to the stdio->HTTP proxy script otherwise (stdio is the ACP
 * baseline every agent must accept).
 */
export function buildAcpMossMcpServers(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly initializeResult: AcpInitializeCapabilitiesView;
  readonly stdioProxy: AcpStdioProxySpawn;
  /**
   * Mint a one-shot credential only when the negotiated transport is stdio.
   * Keeping this callback lazy is important: HTTP ACP sessions use the
   * session bearer directly and must not consume a bootstrap token.
   */
  readonly issueStdioBootstrapToken: () => string | null;
}): Array<Acp.McpServer> {
  const supportsHttp = input.initializeResult.agentCapabilities?.mcpCapabilities?.http === true;
  if (supportsHttp) {
    const headers = [{ name: "Authorization", value: authorizationHeader(input.connection) }];
    return [
      { type: "http", name: MOSS_MCP_SERVER_NAME, url: input.connection.url, headers },
      // Connectors need Streamable HTTP sessions, which the stdio proxy below
      // does not carry, so stdio-only agents run without them.
      ...(input.connection.connectors ?? []).map(
        (connector): Acp.McpServer => ({
          type: "http",
          name: connector.name,
          url: connector.url,
          headers: [...headers],
        }),
      ),
    ];
  }
  const bootstrapToken = input.issueStdioBootstrapToken();
  if (bootstrapToken === null) {
    throw new Error("Moss ACP stdio MCP bootstrap credential is unavailable.");
  }
  return [
    {
      name: MOSS_MCP_SERVER_NAME,
      command: input.stdioProxy.command,
      args: [...input.stdioProxy.args],
      env: [
        { name: MOSS_AGENT_GATEWAY_URL_ENV, value: input.connection.url },
        { name: MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV, value: bootstrapToken },
        // Provider environments strip this flag; the desktop proxy still needs Node mode.
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      ],
    },
  ];
}
