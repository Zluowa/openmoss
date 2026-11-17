import { describe, expect, it } from "vitest";

import { makeActivity } from "./storeTestFixtures";
import { deriveWorkLogEntries } from "./workLog";
import { isWebMcpCallToolName, webMcpCallOriginFromDetail } from "./lib/webMcpToolPresentation";

// Every page-declared WebMCP call row names the site the tool came from. Codex
// reports the call's arguments as data; Claude reports `ToolName: {json}`.
const ORIGIN = "http://127.0.0.1:5173";
const ARGS = {
  origin: ORIGIN,
  discoveryId: "22222222-2222-4222-8222-222222222222",
  toolId: "w3",
  arguments: { steps: [{ ref: "Project name", action: "setValue", args: ["Atlas"] }] },
};

const entryFor = (payload: NonNullable<Parameters<typeof makeActivity>[0]["payload"]>) =>
  deriveWorkLogEntries(
    [
      makeActivity({
        id: `row-${JSON.stringify(payload).length}`,
        createdAt: "2026-11-18T00:00:01.000Z",
        kind: "tool.completed",
        summary: "MCP tool call",
        payload,
      }),
    ],
    undefined,
  )[0]!;

describe("WebMCP call rows", () => {
  it("names the site for Codex's MCP call shape (data.arguments)", () => {
    const entry = entryFor({
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      status: "completed",
      data: {
        kind: "codex.mcp_tool_call",
        version: 1,
        callId: "c-webmcp",
        server: "moss",
        tool: "browser_webmcp_call",
        status: "completed",
        arguments: ARGS,
        result: { content: [] },
        truncation: { truncated: false, deferredBinary: false },
      },
    });
    expect(entry.toolTitle).toBe("Call page WebMCP tool");
    expect(entry.preview).toBe(ORIGIN);
  });

  it("names the site for Claude's detail string and structured input", () => {
    const entry = entryFor({
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      status: "completed",
      detail: `mcp__moss__browser_webmcp_call: ${JSON.stringify(ARGS)}`,
      data: { toolCallId: "c-claude", toolName: "mcp__moss__browser_webmcp_call", input: ARGS },
    });
    expect(entry.toolName).toBe("mcp__moss__browser_webmcp_call");
    expect(entry.toolTitle).toBe("Call page WebMCP tool");
    expect(entry.preview).toBe(ORIGIN);
  });

  it("names the site from Claude's detail alone, even when it was clamped", () => {
    const clamped = `mcp__moss__browser_webmcp_call: ${JSON.stringify(ARGS).slice(0, 60)}`;
    const entry = entryFor({
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      status: "completed",
      detail: clamped,
      data: { toolCallId: "c-claude-2", toolName: "mcp__moss__browser_webmcp_call" },
    });
    expect(entry.preview).toBe(ORIGIN);
  });

  it("shows nothing it cannot read as a web origin", () => {
    expect(
      webMcpCallOriginFromDetail(
        'mcp__moss__browser_webmcp_call: {"origin":"javascript:alert(1)"}',
      ),
    ).toBeNull();
    expect(
      webMcpCallOriginFromDetail(`mcp__other__browser_webmcp_call: ${JSON.stringify(ARGS)}`),
    ).toBeNull();
    expect(isWebMcpCallToolName("mcp__moss_fs__browser_webmcp_call")).toBe(false);
    expect(isWebMcpCallToolName("moss_browser_webmcp_call")).toBe(true);
  });
});
