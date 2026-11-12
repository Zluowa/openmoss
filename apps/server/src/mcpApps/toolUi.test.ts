// Unit tests for the MCP Apps tool rules, the resource parser and the Claude result helpers.
import { describe, expect, it } from "vitest";

import { claudeMcpCallResult, claudeToolResultToCallToolResult } from "./claudeBackend";
import { McpAppApprovalTokens } from "./approvalTokens";
import { parseMcpAppResourceReadResponse } from "./resourceContent";
import {
  checkStructuredContent,
  isAppOnlyRawTool,
  mcpArgsHash,
  sanitizeCallToolResult,
  stripReservedMcpAppMeta,
  toolAllowsApp,
  toolDefinitionFromMcp,
} from "./toolUi";

describe("tool definitions", () => {
  it("reads _meta.ui.resourceUri, then the legacy flat key, and only ui:// URIs", () => {
    expect(
      toolDefinitionFromMcp({ name: "a", _meta: { ui: { resourceUri: "ui://x/a" } } })?.resourceUri,
    ).toBe("ui://x/a");
    expect(
      toolDefinitionFromMcp({ name: "b", _meta: { "ui/resourceUri": "ui://x/b" } })?.resourceUri,
    ).toBe("ui://x/b");
    expect(
      toolDefinitionFromMcp({ name: "c", _meta: { ui: { resourceUri: "https://x" } } })
        ?.resourceUri,
    ).toBeUndefined();
    expect(
      toolDefinitionFromMcp({ name: "d", _meta: { "openai/outputTemplate": "ui://x/d" } })
        ?.resourceUri,
    ).toBeUndefined();
  });

  it("treats absent visibility as model + app and app-only as hidden from the model", () => {
    const open = toolDefinitionFromMcp({ name: "open", _meta: { ui: { resourceUri: "ui://x" } } })!;
    expect(open.visibility).toEqual([]);
    expect(toolAllowsApp(open)).toBe(true);
    const modelOnly = toolDefinitionFromMcp({
      name: "m",
      _meta: { ui: { visibility: ["model"] } },
    })!;
    expect(toolAllowsApp(modelOnly)).toBe(false);
    const appOnly = { name: "x", _meta: { ui: { visibility: ["app"] } } };
    expect(isAppOnlyRawTool(appOnly)).toBe(true);
    expect(isAppOnlyRawTool({ name: "y", _meta: { ui: { visibility: ["app", "model"] } } })).toBe(
      false,
    );
    expect(isAppOnlyRawTool({ name: "z" })).toBe(false);
  });

  it("reads Agent SDK and MCP annotations for read-only tools and titles", () => {
    expect(
      toolDefinitionFromMcp({ name: "a", annotations: { readOnly: true } })?.readOnlyHint,
    ).toBe(true);
    expect(
      toolDefinitionFromMcp({ name: "b", annotations: { readOnlyHint: false, title: "B" } }),
    ).toMatchObject({
      readOnlyHint: false,
      title: "B",
    });
  });
});

describe("reserved meta and results", () => {
  it("strips anthropic/ and moss/ keys and prototype-like keys", () => {
    expect(
      stripReservedMcpAppMeta({
        "anthropic/x": 1,
        "moss/y": 2,
        keep: 3,
        ["__proto__"]: 4,
        progressToken: 5,
      }),
    ).toEqual({ keep: 3, progressToken: 5 });
    expect(sanitizeCallToolResult({ content: [], _meta: { "moss/a": 1 } })).toEqual({
      content: [],
    });
  });

  it("accepts only plain-object structuredContent within the budget", () => {
    expect(checkStructuredContent("t", undefined)).toEqual({ ok: true });
    expect(checkStructuredContent("t", { a: 1 })).toEqual({ ok: true });
    expect(checkStructuredContent("t", [1])).toMatchObject({
      ok: false,
      message:
        "Tool 't' returned structuredContent of type 'array'; MCP servers exposing Apps must return an object (or omit the field)",
    });
    expect(checkStructuredContent("t", { s: "x".repeat(262_200) }).ok).toBe(false);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 70; index += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(checkStructuredContent("t", root).ok).toBe(false);
  });

  it("hashes arguments independently of key order", () => {
    expect(mcpArgsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(mcpArgsHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(mcpArgsHash({ a: 1 })).not.toBe(mcpArgsHash({ a: 2 }));
  });
});

describe("approval tokens", () => {
  it("are one-time, scoped and expire after two minutes", () => {
    let now = 0;
    const tokens = new McpAppApprovalTokens(() => now);
    const scope = { threadId: "t", server: "s", toolName: "x", argsHash: "h" };
    const token = tokens.issue(scope);
    expect(tokens.consume(token, { ...scope, toolName: "y" })).toBe(false);
    const second = tokens.issue(scope);
    expect(tokens.consume(second, scope)).toBe(true);
    expect(tokens.consume(second, scope)).toBe(false);
    const late = tokens.issue(scope);
    now += 120_001;
    expect(tokens.consume(late, scope)).toBe(false);
  });
});

describe("resource parsing", () => {
  const meta = {
    ui: {
      domain: "x.example",
      permissions: { camera: {}, geolocation: true },
      prefersBorder: false,
    },
  };

  it("decodes a base64 blob and the legacy MIME, and reads permissions", () => {
    const html = "<p>hi</p>";
    const result = parseMcpAppResourceReadResponse({
      response: {
        contents: [
          {
            uri: "ui://a",
            mimeType: "text/html+mcp",
            blob: Buffer.from(html).toString("base64"),
            _meta: meta,
          },
        ],
      },
      resourceUri: "ui://a",
    });
    expect(result).toMatchObject({
      state: "ready",
      html,
      mimeType: "text/html;profile=mcp-app",
      permissions: { camera: true, geolocation: true },
      prefersBorder: false,
      stableOrigin: false,
    });
  });

  it("draws the card border unless the widget declines it (Claude's Code tab)", () => {
    const read = (metaValue: Record<string, unknown> | undefined) =>
      parseMcpAppResourceReadResponse({
        response: {
          contents: [
            {
              uri: "ui://a",
              mimeType: "text/html;profile=mcp-app",
              text: "x",
              ...(metaValue ? { _meta: metaValue } : {}),
            },
          ],
        },
        resourceUri: "ui://a",
      });
    expect(read(undefined)).toMatchObject({ state: "ready", prefersBorder: true });
    expect(read({ ui: {} })).toMatchObject({ prefersBorder: true });
    expect(read({ ui: { prefersBorder: false } })).toMatchObject({ prefersBorder: false });
    expect(read({ "openai/widgetPrefersBorder": false })).toMatchObject({ prefersBorder: false });
  });

  it("opts into the stable origin only for eligible servers that declare ui.domain", () => {
    const response = {
      contents: [{ uri: "ui://a", mimeType: "text/html;profile=mcp-app", text: "x", _meta: meta }],
    };
    expect(
      parseMcpAppResourceReadResponse({
        response,
        resourceUri: "ui://a",
        stableOriginEligible: true,
      }),
    ).toMatchObject({ stableOrigin: true, widgetDomain: "x.example" });
    expect(
      parseMcpAppResourceReadResponse({
        response: { contents: [{ uri: "ui://a", mimeType: "text/html", text: "x" }] },
        resourceUri: "ui://a",
        stableOriginEligible: true,
      }),
    ).toMatchObject({ stableOrigin: false });
  });
});

describe("Claude Code results (recorded from 2.1.318)", () => {
  it("keeps tool_use_result structuredContent and _meta for a model-turn MCP call", () => {
    const json = '{"greeting":"Hello, Moss!","count":3}';
    expect(
      claudeToolResultToCallToolResult({
        block: { type: "tool_result", tool_use_id: "t", content: json },
        toolUseResult: {
          content: json,
          structuredContent: { greeting: "Hello, Moss!", count: 3 },
          _meta: { k: 1 },
        },
      }),
    ).toEqual({
      content: [{ type: "text", text: json }],
      structuredContent: { greeting: "Hello, Moss!", count: 3 },
      _meta: { k: 1 },
    });
  });

  it("unwraps the mcp_call control response envelope", () => {
    expect(
      claudeMcpCallResult({
        subtype: "success",
        response: { content: [{ type: "text", text: "ok" }], structuredContent: { count: 4 } },
      }),
    ).toEqual({ content: [{ type: "text", text: "ok" }], structuredContent: { count: 4 } });
    expect(
      claudeMcpCallResult({
        subtype: "success",
        response: { content: '{"a":1}', structuredContent: { a: 1 } },
      }),
    ).toEqual({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } });
  });
});
