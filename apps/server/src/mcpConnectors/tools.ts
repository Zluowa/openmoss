/**
 * Lists what a connected MCP server offers, for the people managing connectors, and calls one
 * tool for Moss's own features (issue sources read Linear and Jira through their connectors).
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
  readonly signal?: AbortSignal | undefined;
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
function resultOf(answer: McpConnectorProxyResult, fallback: string): Record<string, unknown> {
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

/** One MCP session: initialize, the caller's requests, then close the session if it has one. */
async function withMcpConnectorSession<T>(
  input: {
    readonly forward: McpConnectorToolsForward;
    readonly displayName: string;
    readonly clientVersion: string;
    readonly signal?: AbortSignal | undefined;
  },
  fallback: string,
  run: (request: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const { forward, signal } = input;
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
    ...(signal ? { signal } : {}),
  });
  const initialized = resultOf(opened, fallback);
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
      ...(signal ? { signal } : {}),
    });
    return await run(async (body) =>
      resultOf(
        await forward({
          method: "POST",
          body: { jsonrpc: "2.0", ...body },
          ...session,
          ...(signal ? { signal } : {}),
        }),
        fallback,
      ),
    );
  } finally {
    // Close the session, if the server keeps one and the caller has not already cancelled.
    if (sessionId && !signal?.aborted) {
      void forward({ method: "DELETE", ...session }).catch(() => undefined);
    }
  }
}

/** What one `tools/call` answered: its text blocks joined, and any structured content. */
export interface McpConnectorToolCallResult {
  /** The server marked the call as failed; `text` is its own explanation. */
  readonly isError: boolean;
  readonly text: string;
  readonly structured: unknown;
}

/** The JSON a tool answered with: its structured content, else its text parsed as JSON. */
export function mcpToolCallJson(result: McpConnectorToolCallResult): unknown {
  if (result.structured !== null && result.structured !== undefined) return result.structured;
  const text = result.text.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function callMcpConnectorTool(input: {
  readonly forward: McpConnectorToolsForward;
  readonly displayName: string;
  readonly clientVersion: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly signal?: AbortSignal | undefined;
}): Promise<McpConnectorToolCallResult> {
  return withMcpConnectorSession(
    input,
    `${input.displayName} did not answer the request.`,
    async (request) => {
      const result = await request({
        id: 1,
        method: "tools/call",
        params: { name: input.name, arguments: input.arguments },
      });
      const text = (Array.isArray(result.content) ? result.content : [])
        .flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n");
      return {
        isError: result.isError === true,
        text,
        structured: isRecord(result.structuredContent) ? result.structuredContent : null,
      };
    },
  );
}

export async function listMcpConnectorTools(input: {
  readonly forward: McpConnectorToolsForward;
  readonly displayName: string;
  readonly clientVersion: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<McpConnectorListToolsResult> {
  return withMcpConnectorSession(
    input,
    `${input.displayName} did not answer with its tools.`,
    async (request) => {
      const { entries, truncated } = await collectToolEntries(request);
      const tools: McpConnectorTool[] = [];
      for (const entry of entries) {
        const tool = toMcpConnectorTool(entry);
        if (tool) tools.push(tool);
      }
      return { tools, truncated };
    },
  );
}

/** What one tool takes: the property names of its input schema, and which are required. */
export interface McpConnectorToolInput {
  readonly properties: ReadonlyArray<string>;
  readonly required: ReadonlyArray<string>;
}

/**
 * Each listed tool's input shape, by name, for Moss features that call tools themselves and must
 * match a server whose parameter names are not documented (or changed between versions).
 */
export async function listMcpConnectorToolInputs(input: {
  readonly forward: McpConnectorToolsForward;
  readonly displayName: string;
  readonly clientVersion: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyMap<string, McpConnectorToolInput>> {
  return withMcpConnectorSession(
    input,
    `${input.displayName} did not answer with its tools.`,
    async (request) => {
      const inputs = new Map<string, McpConnectorToolInput>();
      for (const entry of (await collectToolEntries(request)).entries) {
        const tool = toMcpConnectorTool(entry);
        if (!tool || !isRecord(entry)) continue;
        const schema = isRecord(entry.inputSchema) ? entry.inputSchema : {};
        inputs.set(tool.name, {
          properties: isRecord(schema.properties) ? Object.keys(schema.properties) : [],
          required: Array.isArray(schema.required)
            ? schema.required.filter((name): name is string => typeof name === "string")
            : [],
        });
      }
      return inputs;
    },
  );
}

/** Every `tools/list` entry, page by page, each name once, up to the catalog cap. */
async function collectToolEntries(
  request: (body: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<{ entries: unknown[]; truncated: boolean }> {
  const entries: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; page <= MCP_CONNECTOR_TOOLS_MAX_PAGES; page += 1) {
    const listed = await request({
      id: page,
      method: "tools/list",
      ...(cursor ? { params: { cursor } } : {}),
    });
    for (const entry of Array.isArray(listed.tools) ? listed.tools : []) {
      const tool = toMcpConnectorTool(entry);
      if (!tool || seen.has(tool.name)) continue;
      if (entries.length >= MCP_CONNECTOR_TOOLS_MAX_COUNT) return { entries, truncated: true };
      seen.add(tool.name);
      entries.push(entry);
    }
    cursor =
      typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}
