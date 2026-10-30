import { describe, expect, it, vi } from "vitest";

import { MCP_APP_RESOURCE_MAX_HTML_BYTES, MCP_APP_SANDBOX_INNER_SANDBOX } from "@synara/contracts";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  BoundedMessagePortTransport,
  McpAppHostController,
  mapMossMcpResultToCallToolResult,
  normalizeMcpToolArguments,
  requestMcpAppTeardown,
} from "./mcpAppHost";
import type { WorkLogMcpToolResult } from "./toolCallDetails";

function projection(overrides: Record<string, unknown> = {}): WorkLogMcpToolResult {
  return {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: "call-host-test",
    server: "server-host-test",
    tool: "tool-host-test",
    status: "completed",
    arguments: { query: "safe" },
    truncation: { truncated: false, deferredBinary: false },
    ...overrides,
  } as WorkLogMcpToolResult;
}

function waitForEvent(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const navigationTeardownListener = () => undefined;

describe("MCP App host result projection", () => {
  it("keeps only standard content and never leaks Moss-only fields", () => {
    const secret = "mcp-attachment-secret";
    const result = mapMossMcpResultToCallToolResult(
      projection({
        result: {
          content: [
            { type: "text", text: "hello" },
            { type: "resource_link", uri: "ui://resource/one", name: "One" },
            { type: "resource_link", uri: "ui://resource/two" },
            { type: "embedded_resource", uri: "ui://resource/three", text: "embedded" },
            { type: "embedded_resource", text: secret },
            {
              type: "local_artifact",
              state: "available",
              mediaKind: "image",
              attachmentId: secret,
              name: "secret.png",
              mimeType: "image/png",
              sizeBytes: 10,
              sha256: "a".repeat(64),
            },
            { type: "unknown", json: secret, originalType: "future" },
          ],
          structuredContent: { ok: true },
        },
      }),
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "hello" },
        { type: "resource_link", uri: "ui://resource/one", name: "One" },
        {
          type: "resource",
          resource: { uri: "ui://resource/three", text: "embedded" },
        },
      ],
      structuredContent: { ok: true },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("uses an error result for failed or unavailable tool output", () => {
    const failed = mapMossMcpResultToCallToolResult(
      projection({
        status: "failed",
        error: { message: "provider secret must stay private" },
      }),
    );
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "Tool execution was not successful." }]);
    expect(JSON.stringify(failed)).not.toContain("provider secret");

    const partial = mapMossMcpResultToCallToolResult(projection({ status: "inProgress" }));
    expect(partial.isError).toBe(true);
    expect(partial.content).toEqual([{ type: "text", text: "Tool execution was not successful." }]);
  });

  it("requires a bounded plain record for app arguments", () => {
    expect(normalizeMcpToolArguments({ ok: true })).toEqual({ ok: true });
    expect(normalizeMcpToolArguments(Object.create(null))).toEqual({});
    expect(normalizeMcpToolArguments(new Date())).toBeNull();
    expect(normalizeMcpToolArguments({ value: "x".repeat(4_001) })).toBeNull();
    expect(
      normalizeMcpToolArguments(
        Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index])),
      ),
    ).toBeNull();
  });

  it("gates inner navigation commands on the current host snapshot", () => {
    const controller = new McpAppHostController({
      identity: { threadId: "thread-1", callId: "call-1", resourceUri: "ui://widget/demo" },
      projection: projection({
        app: { resourceUri: "ui://widget/demo", source: "appContext" },
      }),
      theme: "light",
    });
    const port = {
      postMessage: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      start: vi.fn(),
    } as unknown as MessagePort;
    const internals = controller as unknown as Record<string, unknown>;
    internals.navigationPort = port;
    internals.running = true;
    (internals.setSnapshot as (partial: unknown) => void).call(controller, {
      canGoBack: true,
      canGoForward: false,
    });
    controller.navigate(-1);
    controller.navigate(1);
    expect(port.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      type: "navigate",
      delta: -1,
    });
    expect(port.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

describe("BoundedMessagePortTransport", () => {
  it("tracks inbound requests separately so their responses are legal", async () => {
    const channel = new MessageChannel();
    const transport = new BoundedMessagePortTransport(channel.port1);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    try {
      await transport.start();
      await transport.start();
      channel.port2.start();
      channel.port2.postMessage({ jsonrpc: "2.0", id: 7, method: "ui/ping", params: {} });
      // A timer turn does not guarantee MessagePort delivery under CI load.
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      await transport.send({ jsonrpc: "2.0", id: 7, result: {} });
    } finally {
      await transport.close();
      channel.port2.close();
    }
  });

  it("releases an outbound request only when its response arrives", async () => {
    const channel = new MessageChannel();
    const transport = new BoundedMessagePortTransport(channel.port1);
    await transport.start();
    channel.port2.start();
    await transport.send({ jsonrpc: "2.0", id: "host-1", method: "ui/ping", params: {} });
    channel.port2.postMessage({ jsonrpc: "2.0", id: "host-1", result: {} });
    await waitForEvent();
    await transport.send({ jsonrpc: "2.0", id: "host-1", method: "ui/ping", params: {} });
    await transport.close();
    channel.port2.close();
  });

  it("fails closed at the combined 32-request limit", async () => {
    const channel = new MessageChannel();
    const transport = new BoundedMessagePortTransport(channel.port1);
    await transport.start();
    channel.port2.start();
    for (let index = 0; index < 16; index += 1) {
      channel.port2.postMessage({
        jsonrpc: "2.0",
        id: `in-${index}`,
        method: "ui/ping",
        params: {},
      });
    }
    for (let index = 0; index < 16; index += 1) {
      await transport.send({ jsonrpc: "2.0", id: `out-${index}`, method: "ui/ping", params: {} });
    }
    channel.port2.postMessage({ jsonrpc: "2.0", id: "in-overflow", method: "ui/ping", params: {} });
    await waitForEvent();
    await expect(transport.send({ jsonrpc: "2.0", method: "ui/ping", params: {} })).rejects.toThrow(
      "rejected",
    );
    channel.port2.close();
  });

  it("accepts only the exact host resource-ready sandbox and keeps its larger cap directional", async () => {
    const channel = new MessageChannel();
    const transport = new BoundedMessagePortTransport(channel.port1);
    await transport.start();
    channel.port2.start();
    await transport.send({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: {
        html: "x".repeat(MCP_APP_RESOURCE_MAX_HTML_BYTES),
        sandbox: MCP_APP_SANDBOX_INNER_SANDBOX,
      },
    });
    await expect(
      transport.send({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: {
          html: "x".repeat(MCP_APP_RESOURCE_MAX_HTML_BYTES + 1),
          sandbox: MCP_APP_SANDBOX_INNER_SANDBOX,
        },
      }),
    ).rejects.toThrow("rejected");
    const incoming = {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "safe", sandbox: MCP_APP_SANDBOX_INNER_SANDBOX },
    };
    channel.port2.postMessage(incoming);
    await waitForEvent();
    await expect(transport.send({ jsonrpc: "2.0", method: "ui/ping", params: {} })).rejects.toThrow(
      "rejected",
    );
    channel.port2.close();
  });
});

describe("MCP App graceful teardown", () => {
  it("requests resource teardown before closing the bridge path", async () => {
    const order: string[] = [];
    await requestMcpAppTeardown({
      teardownResource: async () => {
        order.push("teardown");
        await Promise.resolve();
        order.push("teardown-complete");
        return {};
      },
    });
    order.push("close");
    expect(order).toEqual(["teardown", "teardown-complete", "close"]);
  });

  it("does not block cleanup when the app never acknowledges teardown", async () => {
    const start = Date.now();
    await requestMcpAppTeardown({ teardownResource: () => new Promise<never>(() => undefined) }, 5);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("performs graceful teardown before close, then continues through unregister failures", async () => {
    const order: string[] = [];
    const controller = new McpAppHostController({
      identity: { threadId: "thread-1", callId: "call-1", resourceUri: "ui://widget/demo" },
      projection: projection({
        app: { resourceUri: "ui://widget/demo", source: "appContext" },
      }),
      theme: "light",
    });
    const bridge = {
      teardownResource: async () => {
        order.push("teardown");
      },
      close: async () => {
        order.push("bridge-close");
      },
    };
    const transport = { close: async () => order.push("transport-close") };
    const descriptor = {
      generation: 0,
      initId: "init-1",
      origin: "moss-mcp-sandbox://mcp-test",
      partition: "moss-mcp-mcp-test",
      sandboxId: "mcp-test",
      src: "moss-mcp-sandbox://mcp-test/ui?generation=0#init=init-1",
    };
    const internals = controller as unknown as Record<string, unknown>;
    internals.bridge = bridge;
    internals.transport = transport;
    internals.descriptor = descriptor;
    internals.running = true;
    internals.cleanupBridge = () => order.push("listeners-cleaned");
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          mcpApps: {
            unregister: async () => {
              order.push("unregister");
              throw new Error("already gone");
            },
          },
        },
      },
    });
    try {
      await controller.teardown();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
    expect(order).toEqual([
      "listeners-cleaned",
      "teardown",
      "bridge-close",
      "transport-close",
      "unregister",
    ]);
  });

  it("isolates and closes the navigation channel before graceful teardown yields", async () => {
    const order: string[] = [];
    const controller = new McpAppHostController({
      identity: { threadId: "thread-1", callId: "call-1", resourceUri: "ui://widget/demo" },
      projection: projection({
        app: { resourceUri: "ui://widget/demo", source: "appContext" },
      }),
      theme: "light",
    });
    const navigationPort = {
      removeEventListener: (_type: string, listener: EventListener) => {
        expect(listener).toBe(navigationTeardownListener);
        order.push("navigation-listener-removed");
      },
      close: () => order.push("navigation-close"),
    };
    const internals = controller as unknown as Record<string, unknown>;
    internals.navigationPort = navigationPort;
    internals.navigationPortListener = navigationTeardownListener;
    internals.bridge = {
      teardownResource: async () => {
        order.push("teardown-start");
        await Promise.resolve();
        order.push("teardown-complete");
      },
      close: async () => order.push("bridge-close"),
    };
    internals.running = true;

    await controller.teardown();

    expect(order.slice(0, 3)).toEqual([
      "navigation-listener-removed",
      "navigation-close",
      "teardown-start",
    ]);
    expect(internals.navigationPort as unknown).toBeNull();
    expect(internals.navigationPortListener as unknown).toBeNull();
  });

  it("removes only its captured webview when a shared container gets a replacement", async () => {
    let children: unknown[] = [];
    const container = {
      replaceChildren: (...next: unknown[]) => {
        children = next;
      },
    };
    const oldWebview = {
      remove: () => {
        children = children.filter((child) => child !== oldWebview);
      },
    };
    const replacement = {};
    children = [oldWebview];
    const controller = new McpAppHostController({
      identity: { threadId: "thread-1", callId: "call-1", resourceUri: "ui://widget/demo" },
      projection: projection({
        app: { resourceUri: "ui://widget/demo", source: "appContext" },
      }),
      theme: "light",
    });
    const internals = controller as unknown as Record<string, unknown>;
    internals.currentContainer = container as unknown as HTMLElement;
    internals.webview = oldWebview as unknown as HTMLElement;
    internals.running = true;
    internals.bridge = {
      teardownResource: () => {
        container.replaceChildren(replacement);
        return Promise.resolve();
      },
      close: async () => undefined,
    };
    await controller.teardown();
    expect(children).not.toContain(oldWebview);
    expect(children).toContain(replacement);
  });

  it("uses recorded MCP app HTML when the live resource read has no content", async () => {
    const html = "<!doctype html><title>Linear</title><p>Parity</p>";
    const container = {
      closest: () => container,
    } as unknown as HTMLElement;
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => null,
        documentElement: {
          getAttribute: () => "light",
          classList: { contains: () => false },
        },
      },
    });
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ state: "no_content", resourceUri: "ui://linear/issue" }),
      }) as unknown as Response) as typeof fetch;
    const controller = new McpAppHostController({
      identity: { threadId: "thread-1", callId: "mcp-app-1", resourceUri: "ui://linear/issue" },
      projection: projection({
        server: "linear",
        tool: "issue",
        app: { resourceUri: "ui://linear/issue", source: "appContext", appName: "Linear" },
        result: {
          content: [
            {
              type: "embedded_resource",
              uri: "ui://linear/issue",
              mimeType: "text/html;profile=mcp-app",
              text: html,
            },
          ],
        },
      }),
      theme: "light",
    });
    try {
      await controller.start(container);
      expect(controller.getSnapshot().phase).toBe("ready");
      expect(controller.getSnapshot().browserHtml).toBe(html);
    } finally {
      await controller.teardown();
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
      globalThis.fetch = originalFetch;
    }
  });

  it("renders recorded MCP app HTML in a browser iframe when the desktop bridge is absent", async () => {
    const html = "<!doctype html><title>Linear</title><p>Parity</p>";
    const container = {
      closest: () => container,
    } as unknown as HTMLElement;
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => null,
        documentElement: {
          getAttribute: () => "light",
          classList: { contains: () => false },
        },
      },
    });
    globalThis.fetch = (() => Promise.reject(new Error("no live session"))) as typeof fetch;
    const controller = new McpAppHostController({
      identity: { threadId: "thread-1", callId: "mcp-app-1", resourceUri: "ui://linear/issue" },
      projection: projection({
        server: "linear",
        tool: "issue",
        app: { resourceUri: "ui://linear/issue", source: "appContext", appName: "Linear" },
        result: {
          content: [
            {
              type: "embedded_resource",
              uri: "ui://linear/issue",
              mimeType: "text/html;profile=mcp-app",
              text: html,
            },
          ],
        },
      }),
      theme: "light",
    });
    try {
      await controller.start(container);
      expect(controller.getSnapshot().phase).toBe("ready");
      expect(controller.getSnapshot().browserHtml).toBe(html);
    } finally {
      await controller.teardown();
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
      globalThis.fetch = originalFetch;
    }
  });
});
