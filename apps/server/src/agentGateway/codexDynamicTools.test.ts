import { describe, expect, it } from "vitest";

import {
  buildCodexAgentGatewayDynamicTools,
  CODEX_MAX_SERIALIZED_DYNAMIC_TOOL_BYTES,
  codexDynamicToolFailureResponse,
  codexDynamicToolResponseFromMcpResult,
} from "./codexDynamicTools.ts";

describe("Codex Agent Gateway dynamic tools", () => {
  it.each([{}, { deferLoading: false }])(
    "preserves non-deferred Moss MCP tools with %j",
    (options) => {
      expect(
        buildCodexAgentGatewayDynamicTools(
          [
            {
              name: "moss_list_sidebar_sections",
              description: "List authoritative Moss sidebar sections.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
          options,
        ),
      ).toEqual([
        {
          type: "function",
          name: "moss_list_sidebar_sections",
          description: "List authoritative Moss sidebar sections.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ]);
    },
  );

  it("uses one canonical namespace wrapper for deferred tools without dropping names", () => {
    const tools = buildCodexAgentGatewayDynamicTools(
      [
        {
          name: "moss_context",
          description: "Read Moss context.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "browser_snapshot",
          description: "Snapshot the page.",
          inputSchema: { type: "object", properties: { tabId: { type: "string" } } },
        },
      ],
      { deferLoading: true },
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "namespace",
      name: "moss",
      description: "Moss Agent Gateway MCP tools",
    });
    if (tools[0]?.type !== "namespace") throw new Error("expected namespace wrapper");
    expect(tools[0].tools.map((tool) => tool.name)).toEqual(["moss_context", "browser_snapshot"]);
    expect(tools[0].tools.every((tool) => tool.deferLoading === true)).toBe(true);
    expect(tools[0].tools.map((tool) => tool.inputSchema)).toEqual([
      { type: "object", properties: {}, additionalProperties: true },
      { type: "object", properties: {}, additionalProperties: true },
    ]);
  });

  it("collapses oversized input schemas but keeps the tool entry", () => {
    const fatSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field_${index}`,
          { type: "string", description: "x".repeat(40) },
        ]),
      ),
      additionalProperties: false,
    };
    const [wrapper] = buildCodexAgentGatewayDynamicTools(
      [
        {
          name: "browser_drag",
          description: "Drag an element. ".concat("details ".repeat(100)),
          inputSchema: fatSchema,
        },
      ],
      { deferLoading: true },
    );
    expect(wrapper?.type).toBe("namespace");
    if (wrapper?.type !== "namespace") throw new Error("expected namespace wrapper");
    const [tool] = wrapper.tools;
    if (tool === undefined) throw new Error("expected projected dynamic tool");
    expect(tool.name).toBe("browser_drag");
    expect(tool.deferLoading).toBe(true);
    expect(tool.description.length).toBeLessThanOrEqual(64);
    expect(tool.description).toHaveLength(64);
    expect(tool.description.endsWith("…")).toBe(true);
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
    const serialized = Buffer.byteLength(
      JSON.stringify({
        type: "function",
        name: tool.name,
        description: tool.description,
        strict: false,
        defer_loading: true,
        parameters: tool.inputSchema,
      }),
      "utf8",
    );
    expect(serialized).toBeLessThanOrEqual(CODEX_MAX_SERIALIZED_DYNAMIC_TOOL_BYTES);
  });

  it("converts MCP text and binary content into app-server output items", () => {
    expect(
      codexDynamicToolResponseFromMcpResult({
        content: [
          { type: "text", text: "created" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
        ],
      }),
    ).toEqual({
      contentItems: [
        { type: "inputText", text: "created" },
        { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
        { type: "inputAudio", audioUrl: "data:audio/wav;base64,YXVkaW8=" },
      ],
      success: true,
    });
  });

  it("preserves MCP failures and structured fallback output", () => {
    expect(
      codexDynamicToolResponseFromMcpResult({
        isError: true,
        structuredContent: { code: "caller_turn_inactive" },
      }),
    ).toEqual({
      contentItems: [{ type: "inputText", text: '{"code":"caller_turn_inactive"}' }],
      success: false,
    });
    expect(codexDynamicToolFailureResponse(new Error("offline"))).toEqual({
      contentItems: [{ type: "inputText", text: "Moss MCP tool call failed: offline" }],
      success: false,
    });
  });
});
