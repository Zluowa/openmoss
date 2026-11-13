/**
 * Lists what a connected MCP server offers, for the people managing connectors.
 *
 * Runs one short MCP session through the same forwarder agent calls use
 * (`initialize`, `notifications/initialized`, `tools/list` page by page, then
 * the session is closed), so sign-in, token refresh and address checks are
 * exactly the ones a tool call gets.
 *
 * @module mcpConnectors/tools
 */
import type { McpConnectorListToolsResult, McpConnectorTool } from "@moss/contracts";

import { MCP_CONNECTOR_PROTOCOL_VERSION, type McpConnectorProxyResult } from "./proxy.ts";

/** A catalog a person reads on a phone: more than this is a sign to stop asking. */
export const MCP_CONNECTOR_TOOLS_MAX_COUNT = 200;
const MCP_CONNECTOR_TOOLS_MAX_PAGES = 10;
const MCP_CONNECTOR_TOOL_NAME_MAX_LENGTH = 128;
const MCP_CONNECTOR_TOOL_DESCRIPTION_MAX_LENGTH = 400;

export interface McpConnectorToolsExchange {
  readonly method: "POST" | "DELETE";
  readonly body?: unknown;
  readonly sessionId?: string | undefined;
  readonly protocolVersion?: string | undefined;
}

export type McpConnectorToolsForward = (
  request: McpConnectorToolsExchange,
) => Promise<McpConnectorProxyResult>;

/** The server answered, but not with a tool list; `message` is safe to show. */
export class McpConnectorToolsFailure extends Error {
  override readonly name = "McpConnectorToolsFailure";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clipped(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

/** One `tools/list` entry in the contract's shape, or null when it has no usable name. */
export function toMcpConnectorTool(entry: unknown): McpConnectorTool | null {
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name || name.length > MCP_CONNECTOR_TOOL_NAME_MAX_LENGTH) return null;
  const annotations = isRecord(entry.annotations) ? entry.annotations : undefined;
  const title = clipped(entry.title ?? annotations?.title, MCP_CONNECTOR_TOOL_NAME_MAX_LENGTH);
  const description = clipped(entry.description, MCP_CONNECTOR_TOOL_DESCRIPTION_MAX_LENGTH);
  return {
    name,
    ...(title && title !== name ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

/** The JSON-RPC result of one exchange, or a failure in the server's own words. */
function resultOf(answer: McpConnectorProxyResult, displayName: string): Record<string, unknown> {
  const fallback = `${displayName} did not answer with its tools.`;
  if (answer.body.kind !== "json" || !isRecord(answer.body.value)) {
    throw new McpConnectorToolsFailure(fallback);
  }
  const { error, result } = answer.body.value;
  if (isRecord(error)) {
    throw new McpConnectorToolsFailure(clipped(error.message, 300) ?? fallback);
  }
  if (answer.status < 200 || answer.status >= 300 || !isRecord(result)) {
    throw new McpConnectorToolsFailure(fallback);
  }
  return result;
}

export async function listMcpConnectorTools(input: {
  readonly forward: McpConnectorToolsForward;
  readonly displayName: string;
  readonly clientVersion: string;
}): Promise<McpConnectorListToolsResult> {
  const { forward, displayName } = input;
  const opened = await forward({
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: MCP_CONNECTOR_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Moss", version: input.clientVersion },
      },
    },
  });
  const initialized = resultOf(opened, displayName);
  const sessionId = opened.sessionId ?? undefined;
  const protocolVersion =
    typeof initialized.protocolVersion === "string"
      ? initialized.protocolVersion
      : MCP_CONNECTOR_PROTOCOL_VERSION;
  const session = { sessionId, protocolVersion };
  try {
    await forward({
      method: "POST",
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      ...session,
    });
    const tools: McpConnectorTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= MCP_CONNECTOR_TOOLS_MAX_PAGES; page += 1) {
      const listed = resultOf(
        await forward({
          method: "POST",
          body: {
            jsonrpc: "2.0",
            id: page,
            method: "tools/list",
            ...(cursor ? { params: { cursor } } : {}),
          },
          ...session,
        }),
        displayName,
      );
      for (const entry of Array.isArray(listed.tools) ? listed.tools : []) {
        const tool = toMcpConnectorTool(entry);
        if (!tool || seen.has(tool.name)) continue;
        if (tools.length >= MCP_CONNECTOR_TOOLS_MAX_COUNT) return { tools, truncated: true };
        seen.add(tool.name);
        tools.push(tool);
      }
      cursor =
        typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
      if (!cursor) return { tools, truncated: false };
    }
    return { tools, truncated: true };
  } finally {
    // Close the session the listing opened, if the server keeps one.
    if (sessionId) void forward({ method: "DELETE", ...session }).catch(() => undefined);
  }
}
