import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  MCP_APP_RESOURCE_MAX_HTML_BYTES,
  McpAppResourceReadInput,
  McpAppResourceReadResult,
} from "./mcpAppResource";

const decodeInput = Schema.decodeUnknownSync(McpAppResourceReadInput);
const decodeResult = Schema.decodeUnknownSync(McpAppResourceReadResult);

const input = {
  threadId: "thread-mcp-app",
  callId: "call-mcp-app",
  server: "codex_apps",
  resourceUri: "ui://widget/demo",
  source: "appContext",
  connectorId: "connector/demo",
} as const;

describe("MCP App resource contracts", () => {
  it("accepts bounded input and ready/no-content/too-large states", () => {
    expect(decodeInput(input)).toEqual(input);
    expect(
      decodeResult({
        state: "ready",
        resourceUri: input.resourceUri,
        html: "<main>ok</main>",
        sizeBytes: 15,
        mimeType: "text/html;profile=mcp-app",
        csp: {
          baseUriDomains: [],
          connectDomains: ["https://api.example.test"],
          frameDomains: [],
          includeDefaultDomains: false,
          isTrusted: true,
          resourceDomains: ["https://cdn.example.test"],
        },
        heightHint: 240,
        minFrameHeight: 200,
        prefersBorder: false,
        isCollapsible: true,
        widgetDomain: null,
        originCallId: input.callId,
        secret: "must-not-cross",
      }),
    ).toMatchObject({
      state: "ready",
      resourceUri: input.resourceUri,
      mimeType: "text/html;profile=mcp-app",
      originCallId: input.callId,
    });
    expect(decodeResult({ state: "no_content", resourceUri: input.resourceUri })).toEqual({
      state: "no_content",
      resourceUri: input.resourceUri,
    });
    expect(
      decodeResult({
        state: "too_large",
        resourceUri: input.resourceUri,
        sizeBytes: MCP_APP_RESOURCE_MAX_HTML_BYTES + 1,
      }),
    ).toEqual({
      state: "too_large",
      resourceUri: input.resourceUri,
      sizeBytes: MCP_APP_RESOURCE_MAX_HTML_BYTES + 1,
    });
  });

  it("rejects invalid ids, MIME/state, HTML/domains, and numeric metadata", () => {
    expect(() => decodeInput({ ...input, resourceUri: "   " })).toThrow();
    expect(() => decodeInput({ ...input, callId: "c".repeat(201) })).toThrow();
    expect(() => decodeInput({ ...input, source: "unknown" })).toThrow();

    const ready = {
      state: "ready" as const,
      resourceUri: input.resourceUri,
      html: "<main>ok</main>",
      sizeBytes: 15,
      mimeType: "text/html" as const,
      csp: {
        baseUriDomains: [],
        connectDomains: [],
        frameDomains: [],
        includeDefaultDomains: false,
        isTrusted: false,
        resourceDomains: [],
      },
      prefersBorder: false,
      isCollapsible: true,
      widgetDomain: null,
    };
    expect(() => decodeResult({ ...ready, mimeType: "text/plain" })).toThrow();
    expect(() => decodeResult({ ...ready, state: "failed" })).toThrow();
    expect(() => decodeResult({ ...ready, sizeBytes: 14 })).toThrow();
    expect(() =>
      decodeResult({ ...ready, html: "x".repeat(MCP_APP_RESOURCE_MAX_HTML_BYTES + 1) }),
    ).toThrow();
    expect(() => decodeResult({ ...ready, sizeBytes: -1 })).toThrow();
    expect(() => decodeResult({ ...ready, heightHint: 0 })).toThrow();
    expect(() => decodeResult({ ...ready, minFrameHeight: -1 })).toThrow();
    expect(() =>
      decodeResult({ ...ready, csp: { ...ready.csp, connectDomains: ["x".repeat(2_001)] } }),
    ).toThrow();
    expect(() =>
      decodeResult({
        ...ready,
        csp: {
          ...ready.csp,
          connectDomains: Array.from({ length: 33 }, () => "https://example.test"),
        },
      }),
    ).toThrow();
  });

  it("measures ready HTML by UTF-8 bytes and rejects byte-cap overflow", () => {
    const multibyteHtml = "你好😀";
    const multibyteSize = new TextEncoder().encode(multibyteHtml).byteLength;
    expect(
      decodeResult({
        state: "ready",
        resourceUri: input.resourceUri,
        html: multibyteHtml,
        sizeBytes: multibyteSize,
        mimeType: "text/html",
        csp: {
          baseUriDomains: [],
          connectDomains: [],
          frameDomains: [],
          includeDefaultDomains: false,
          isTrusted: false,
          resourceDomains: [],
        },
        prefersBorder: false,
        isCollapsible: true,
        widgetDomain: null,
      }),
    ).toMatchObject({ html: multibyteHtml, sizeBytes: multibyteSize });
    expect(() =>
      decodeResult({
        state: "ready",
        resourceUri: input.resourceUri,
        html: multibyteHtml,
        sizeBytes: multibyteSize - 1,
        mimeType: "text/html",
        csp: {
          baseUriDomains: [],
          connectDomains: [],
          frameDomains: [],
          includeDefaultDomains: false,
          isTrusted: false,
          resourceDomains: [],
        },
        prefersBorder: false,
        isCollapsible: true,
        widgetDomain: null,
      }),
    ).toThrow();

    const overByteCapHtml = "😀".repeat(Math.ceil((MCP_APP_RESOURCE_MAX_HTML_BYTES + 1) / 4));
    expect(overByteCapHtml.length).toBeLessThan(MCP_APP_RESOURCE_MAX_HTML_BYTES);
    expect(() =>
      decodeResult({
        state: "ready",
        resourceUri: input.resourceUri,
        html: overByteCapHtml,
        sizeBytes: new TextEncoder().encode(overByteCapHtml).byteLength,
        mimeType: "text/html",
        csp: {
          baseUriDomains: [],
          connectDomains: [],
          frameDomains: [],
          includeDefaultDomains: false,
          isTrusted: false,
          resourceDomains: [],
        },
        prefersBorder: false,
        isCollapsible: true,
        widgetDomain: null,
      }),
    ).toThrow();
  });
});
