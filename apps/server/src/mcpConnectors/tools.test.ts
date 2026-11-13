import { describe, expect, it } from "vitest";

import type { McpConnectorProxyResult } from "./proxy.ts";
import {
  listMcpConnectorTools,
  MCP_CONNECTOR_TOOLS_MAX_COUNT,
  McpConnectorToolsFailure,
  type McpConnectorToolsExchange,
  toMcpConnectorTool,
} from "./tools.ts";

const json = (value: unknown, sessionId: string | null = null): McpConnectorProxyResult => ({
  status: 200,
  sessionId,
  body: { kind: "json", value },
});
const accepted: McpConnectorProxyResult = { status: 202, sessionId: null, body: { kind: "empty" } };

/** A server that answers `initialize` and serves `pages` of tools by cursor. */
function server(pages: ReadonlyArray<ReadonlyArray<unknown>>, sessionId: string | null = null) {
  const sent: McpConnectorToolsExchange[] = [];
  const forward = async (request: McpConnectorToolsExchange): Promise<McpConnectorProxyResult> => {
    sent.push(request);
    if (request.method === "DELETE") return accepted;
    const body = request.body as { id?: number; method: string; params?: { cursor?: string } };
    if (body.method === "initialize") {
      return json(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } },
        sessionId,
      );
    }
    if (body.method !== "tools/list") return accepted;
    const index = body.params?.cursor ? Number(body.params.cursor) : 0;
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: pages[index] ?? [],
        ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
      },
    });
  };
  return { sent, forward };
}

const list = (forward: (request: McpConnectorToolsExchange) => Promise<McpConnectorProxyResult>) =>
  listMcpConnectorTools({ forward, displayName: "Tides", clientVersion: "1.0.0" });

describe("toMcpConnectorTool", () => {
  it("keeps a name, a distinct title and a one-line description", () => {
    expect(
      toMcpConnectorTool({
        name: " next_high_tide ",
        annotations: { title: "Next high tide" },
        description: "When the next\n  high tide is.",
        inputSchema: { type: "object" },
      }),
    ).toEqual({
      name: "next_high_tide",
      title: "Next high tide",
      description: "When the next high tide is.",
    });
    expect(toMcpConnectorTool({ name: "moon", title: "moon", description: "  " })).toEqual({
      name: "moon",
    });
  });

  it("cuts a long description and drops an entry without a usable name", () => {
    const tool = toMcpConnectorTool({ name: "long", description: "word ".repeat(200) });
    expect(tool?.description).toHaveLength(400);
    expect(tool?.description?.endsWith("…")).toBe(true);
    expect(toMcpConnectorTool({ name: "" })).toBeNull();
    expect(toMcpConnectorTool({ name: "x".repeat(200) })).toBeNull();
    expect(toMcpConnectorTool("next_high_tide")).toBeNull();
  });
});

describe("listMcpConnectorTools", () => {
  it("follows the cursor across pages and lists each tool once", async () => {
    const upstream = server([
      [{ name: "a" }, { name: "b" }],
      [{ name: "b" }, { name: "c" }],
    ]);

    await expect(list(upstream.forward)).resolves.toEqual({
      tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
      truncated: false,
    });
    // No session was opened, so there is none to close.
    expect(upstream.sent.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
  });

  it("closes the session it opened, even when the listing fails", async () => {
    const upstream = server([], "session-9");
    const failing = async (request: McpConnectorToolsExchange) => {
      const answer = await upstream.forward(request);
      return (request.body as { method?: string } | undefined)?.method === "tools/list"
        ? json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "No tools here." } })
        : answer;
    };

    await expect(list(failing)).rejects.toThrow(new McpConnectorToolsFailure("No tools here."));
    expect(upstream.sent.at(-1)).toMatchObject({ method: "DELETE", sessionId: "session-9" });
  });

  it("stops at the cap and says the list is cut", async () => {
    const many = Array.from({ length: MCP_CONNECTOR_TOOLS_MAX_COUNT + 5 }, (_, index) => ({
      name: `tool_${index}`,
    }));
    const result = await list(server([many]).forward);
    expect(result.tools).toHaveLength(MCP_CONNECTOR_TOOLS_MAX_COUNT);
    expect(result.truncated).toBe(true);
  });

  it("refuses an answer that is not MCP", async () => {
    const page: McpConnectorProxyResult = {
      status: 200,
      sessionId: null,
      body: { kind: "text", value: "<html>", contentType: "text/html" },
    };
    await expect(list(async () => page)).rejects.toThrow("Tides did not answer with its tools.");
  });
});
