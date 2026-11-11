// FILE: connectorClient.ts
// Purpose: Moss's own MCP client session to one connector, over the connector runtime's
//   authenticated `forward` (stored credentials, token refresh, region gates). Used for widget
//   resource reads, widget tool calls and the tool list with `_meta.ui`, so widgets work for every
//   provider and after restarts without a live provider session.
// Layer: Server MCP Apps runtime (promise-based)
// Exports: McpAppConnectorClient, McpAppRpcFailure, MCP_APP_CLIENT_CAPABILITIES

import type { McpConnectorProxyResult } from "../mcpConnectors/proxy.ts";

export const MCP_APP_CLIENT_PROTOCOL_VERSION = "2025-06-18";
/** Declares MCP Apps support, as Claude Code does; servers may hide UI metadata otherwise. */
export const MCP_APP_CLIENT_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
} as const;

export type McpAppConnectorForward = (request: {
  readonly method: "POST" | "DELETE";
  readonly body?: unknown;
  readonly sessionId?: string | undefined;
  readonly protocolVersion?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}) => Promise<McpConnectorProxyResult>;

/** A JSON-RPC error from the server, or a transport failure Moss reports as one. */
export class McpAppRpcFailure extends Error {
  override readonly name = "McpAppRpcFailure";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Connector runtime answers that mean "sign in again" (it never forwards HTTP 401). */
export function isConnectorAuthFailure(message: string): boolean {
  return /needs to be reconnected|could not refresh access/iu.test(message);
}

export class McpAppConnectorClient {
  private sessionId: string | undefined;
  private protocolVersion: string = MCP_APP_CLIENT_PROTOCOL_VERSION;
  private initializing: Promise<void> | null = null;
  private nextId = 1;

  constructor(
    private readonly forward: McpAppConnectorForward,
    private readonly clientVersion: string,
  ) {}

  async request(
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureInitialized(signal);
    try {
      return await this.send(method, params, signal);
    } catch (error) {
      // An upstream that dropped our session answers 404; open a new one once.
      if (error instanceof McpAppRpcFailure && error.data === "session-expired") {
        this.sessionId = undefined;
        this.initializing = null;
        await this.ensureInitialized(signal);
        return this.send(method, params, signal);
      }
      throw error;
    }
  }

  /** Ends the upstream session, if one was opened. Never throws. */
  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    this.initializing = null;
    if (!sessionId) return;
    await this.forward({
      method: "DELETE",
      sessionId,
      protocolVersion: this.protocolVersion,
    }).catch(() => undefined);
  }

  private ensureInitialized(signal?: AbortSignal): Promise<void> {
    this.initializing ??= (async () => {
      const id = this.nextId++;
      const answer = await this.forward({
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: MCP_APP_CLIENT_PROTOCOL_VERSION,
            capabilities: MCP_APP_CLIENT_CAPABILITIES,
            clientInfo: { name: "Moss", version: this.clientVersion },
          },
        },
        signal,
      });
      const result = this.readResult(answer, id);
      const negotiated = asRecord(result)?.protocolVersion;
      if (typeof negotiated === "string" && negotiated.length <= 32) {
        this.protocolVersion = negotiated;
      }
      this.sessionId = answer.sessionId ?? undefined;
      await this.forward({
        method: "POST",
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId: this.sessionId,
        protocolVersion: this.protocolVersion,
        signal,
      }).catch(() => undefined);
    })().catch((error: unknown) => {
      this.initializing = null;
      throw error;
    });
    return this.initializing;
  }

  private async send(
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const answer = await this.forward({
      method: "POST",
      body: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
      sessionId: this.sessionId,
      protocolVersion: this.protocolVersion,
      signal,
    });
    if (answer.status === 404 && this.sessionId) {
      throw new McpAppRpcFailure(-32001, "The server ended Moss's session.", "session-expired");
    }
    return this.readResult(answer, id);
  }

  private readResult(answer: McpConnectorProxyResult, id: number): unknown {
    if (answer.body.kind !== "json") {
      throw new McpAppRpcFailure(
        -32603,
        answer.body.kind === "text"
          ? `The server answered HTTP ${answer.status} without a JSON-RPC body.`
          : `The server answered HTTP ${answer.status} with no body.`,
      );
    }
    const messages = Array.isArray(answer.body.value) ? answer.body.value : [answer.body.value];
    const message =
      messages.map(asRecord).find((entry) => entry?.id === id) ?? asRecord(messages[0]);
    const error = asRecord(message?.error);
    if (error) {
      const text = typeof error.message === "string" ? error.message : "The server refused.";
      throw new McpAppRpcFailure(
        typeof error.code === "number" ? error.code : -32603,
        text,
        isConnectorAuthFailure(text) ? { authRequired: true } : error.data,
      );
    }
    if (!message || !("result" in message)) {
      throw new McpAppRpcFailure(-32603, "The server sent no JSON-RPC result.");
    }
    return message.result;
  }
}
