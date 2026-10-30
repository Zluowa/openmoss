import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@synara/contracts";

import { fetchMcpAppResource } from "./mcpAppResource";

const input = {
  threadId: ThreadId.makeUnsafe("thread-mcp-app"),
  callId: "call-mcp-app",
  server: "codex_apps",
  resourceUri: "ui://widget/demo",
  source: "appContext" as const,
  connectorId: "connector/demo",
};

const ready = {
  state: "ready" as const,
  resourceUri: input.resourceUri,
  html: "<main>demo</main>",
  sizeBytes: 17,
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
  originCallId: input.callId,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchMcpAppResource", () => {
  it("uses the resolved server URL and POST body, then decodes the result", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:58090/ws?token=startup-token" },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(ready), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMcpAppResource(input)).resolves.toEqual(ready);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "http://127.0.0.1:58090/api/provider/mcp-app-resource/read?token=startup-token",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("rejects non-OK, malformed, mismatched URI, and unverified Codex origin results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 502 })),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow("HTTP 502");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow("not valid JSON");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...ready, resourceUri: "ui://widget/other" }), {
            status: 200,
          }),
      ),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow(
      "did not match the requested resource",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...ready, originCallId: "call-other" }), { status: 200 }),
      ),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow("originating tool call");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...ready, state: "unexpected" }), { status: 200 }),
      ),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow("did not match its contract");

    const multibyteHtml = "你好😀";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...ready, html: multibyteHtml, sizeBytes: 1 }), {
            status: 200,
          }),
      ),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow("did not match its contract");

    const overByteCapHtml = "😀".repeat(2_500_001);
    expect(overByteCapHtml.length).toBeLessThan(10_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...ready,
              html: overByteCapHtml,
              sizeBytes: new TextEncoder().encode(overByteCapHtml).byteLength,
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(fetchMcpAppResource(input)).rejects.toThrow("did not match its contract");
  });

  it("forwards AbortSignal to fetch and keeps ordinary MCP results origin-free", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMcpAppResource(input, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    const ordinaryInput = { ...input, server: "docs", source: "resultMeta" as const };
    const ordinaryResult = { ...ready, resourceUri: ordinaryInput.resourceUri };
    delete (ordinaryResult as { originCallId?: string }).originCallId;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(ordinaryResult), { status: 200 })),
    );
    await expect(fetchMcpAppResource(ordinaryInput)).resolves.toEqual(ordinaryResult);

    const noContent = { state: "no_content" as const, resourceUri: ordinaryInput.resourceUri };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(noContent), { status: 200 })),
    );
    await expect(fetchMcpAppResource(ordinaryInput)).resolves.toEqual(noContent);

    const tooLarge = {
      state: "too_large" as const,
      resourceUri: ordinaryInput.resourceUri,
      sizeBytes: 10_000_001,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(tooLarge), { status: 200 })),
    );
    await expect(fetchMcpAppResource(ordinaryInput)).resolves.toEqual(tooLarge);
  });

  it("does not write storage or create DOM/iframe objects while fetching HTML", async () => {
    const setItem = vi.fn();
    const createElement = vi.fn(() => {
      throw new Error("DOM creation is outside the resource helper boundary");
    });
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:58090/ws?token=startup-token" },
      localStorage: { setItem },
    });
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...ready, credentialSentinel: "must-not-cross" }), {
            status: 200,
          }),
      ),
    );

    const result = await fetchMcpAppResource(input);

    expect(result).toEqual(ready);
    expect(setItem).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
  });
});
