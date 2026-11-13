import { describe, expect, it, vi } from "vitest";

import { MCP_APP_RESOURCE_MAX_HTML_BYTES } from "@moss/contracts";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  BoundedMessagePortTransport,
  McpAppHostController,
  mapMossMcpResultToCallToolResult,
  normalizeMcpToolArguments,
  requestMcpAppTeardown,
  type McpAppHostOptions,
} from "./mcpAppHost";
import type { McpAppBinding, McpAppToolResultResponse } from "./mcpApps/contracts";
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
    // The full binding (A #534) — also valid against the older optional-field descriptor.
    app: {
      resourceUri: "ui://widget/demo",
      source: "appContext",
      server: "server-host-test",
      serverKey: "server-host-test",
      serverLabel: "Probe",
      toolName: "tool-host-test",
      isFirstParty: false,
      visibility: [],
    },
    ...overrides,
  } as WorkLogMcpToolResult;
}

const binding: McpAppBinding = {
  server: "server-host-test",
  serverKey: "server-host-test",
  serverLabel: "Probe",
  toolName: "tool-host-test",
  resourceUri: "ui://widget/demo",
  source: "appContext",
  isFirstParty: false,
  visibility: [],
};

function makeController(overrides: Partial<McpAppHostOptions> = {}): McpAppHostController {
  return new McpAppHostController({
    identity: { threadId: "thread-1", callId: "call-host-test", resourceUri: "ui://widget/demo" },
    projection: projection(),
    binding,
    theme: "light",
    locale: "zh-CN",
    styles: { variables: {} as never },
    message: {
      readComposer: () => "",
      writeComposer: () => undefined,
      askReplace: async () => false,
      sendNow: null,
      notifySent: () => undefined,
    },
    desktop: null,
    ...overrides,
  });
}

/** Every shell -> host message is wrapped (B #533). */
function wrap(message: unknown, userActivation = false) {
  return { type: "moss:mcp-app-message", message, userActivation };
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
        { type: "resource", resource: { uri: "ui://resource/three", text: "embedded" } },
      ],
      structuredContent: { ok: true },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("sends nothing while the call runs and an error result once it failed", () => {
    expect(mapMossMcpResultToCallToolResult(projection({ status: "inProgress" }))).toBeNull();
    const failed = mapMossMcpResultToCallToolResult(
      projection({ status: "failed", error: { message: "The tool failed." } }),
    );
    expect(failed).toEqual({
      content: [{ type: "text", text: "The tool failed." }],
      isError: true,
    });
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
    const controller = makeController();
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
      channel.port2.postMessage(wrap({ jsonrpc: "2.0", id: 7, method: "ui/ping", params: {} }));
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      await transport.send({ jsonrpc: "2.0", id: 7, result: {} });
    } finally {
      await transport.close();
      channel.port2.close();
    }
  });

  it("unwraps the user-activation envelope and remembers which request carried it", async () => {
    const channel = new MessageChannel();
    let now = 1_000;
    const transport = new BoundedMessagePortTransport(channel.port1, () => now);
    const methods: string[] = [];
    transport.oninboundrequest = (method) => methods.push(method);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    try {
      await transport.start();
      channel.port2.start();
      channel.port2.postMessage(
        wrap({ jsonrpc: "2.0", id: "a", method: "ui/request-display-mode", params: {} }, true),
      );
      channel.port2.postMessage(
        wrap({ jsonrpc: "2.0", id: "b", method: "ui/message", params: {} }),
      );
      await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 3_000 });
      expect(methods).toEqual(["ui/request-display-mode", "ui/message"]);
      expect(transport.hadUserActivation("a")).toBe(true);
      // "b" carried none, but it arrived inside the 250 ms window after "a".
      expect(transport.hadUserActivation("b")).toBe(true);
      now += 251;
      expect(transport.hadUserActivation("b")).toBe(false);
      expect(transport.hadUserActivation("a")).toBe(true);
    } finally {
      await transport.close();
      channel.port2.close();
    }
  });

  it("hands the proxy's wheel to onwheel and never to the protocol", async () => {
    const channel = new MessageChannel();
    const transport = new BoundedMessagePortTransport(channel.port1);
    const wheels: unknown[] = [];
    transport.onwheel = (delta) => wheels.push(delta);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };
    try {
      await transport.start();
      channel.port2.start();
      channel.port2.postMessage(wrap({ type: "moss:wheel", deltaX: 0, deltaY: 120 }));
      channel.port2.postMessage(wrap({ type: "moss:wheel", deltaX: 0, deltaY: 1e9 }));
      channel.port2.postMessage(wrap({ jsonrpc: "2.0", id: 1, method: "ui/ping", params: {} }));
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(wheels).toEqual([
        { deltaX: 0, deltaY: 120 },
        { deltaX: 0, deltaY: 1000 },
      ]);
      expect(closed).toBe(false);
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
    channel.port2.postMessage(wrap({ jsonrpc: "2.0", id: "host-1", result: {} }));
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
      channel.port2.postMessage(
        wrap({ jsonrpc: "2.0", id: `in-${index}`, method: "ui/ping", params: {} }),
      );
    }
    for (let index = 0; index < 16; index += 1) {
      await transport.send({ jsonrpc: "2.0", id: `out-${index}`, method: "ui/ping", params: {} });
    }
    channel.port2.postMessage(
      wrap({ jsonrpc: "2.0", id: "in-overflow", method: "ui/ping", params: {} }),
    );
    await waitForEvent();
    await expect(transport.send({ jsonrpc: "2.0", method: "ui/ping", params: {} })).rejects.toThrow(
      "rejected",
    );
    channel.port2.close();
  });

  it("sends the resource as {html, permissions} only, and never accepts it inbound", async () => {
    const channel = new MessageChannel();
    const transport = new BoundedMessagePortTransport(channel.port1);
    await transport.start();
    channel.port2.start();
    await transport.send({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "x".repeat(MCP_APP_RESOURCE_MAX_HTML_BYTES), permissions: { camera: {} } },
    });
    await expect(
      transport.send({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "x".repeat(MCP_APP_RESOURCE_MAX_HTML_BYTES + 1) },
      }),
    ).rejects.toThrow("rejected");
    await expect(
      transport.send({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "safe", sandbox: "allow-scripts" },
      }),
    ).rejects.toThrow("rejected");
    channel.port2.postMessage(
      wrap({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "safe" },
      }),
    );
    await waitForEvent();
    await expect(transport.send({ jsonrpc: "2.0", method: "ui/ping", params: {} })).rejects.toThrow(
      "rejected",
    );
    channel.port2.close();
  });
});

describe("BoundedMessagePortTransport envelope", () => {
  it("fails closed on a bare JSON-RPC message or a malformed envelope", async () => {
    for (const bad of [
      { jsonrpc: "2.0", id: 1, method: "ui/ping", params: {} },
      { type: "moss:mcp-app-message", message: { jsonrpc: "2.0", method: "ui/ping" } },
      { ...wrap({ jsonrpc: "2.0", method: "ui/ping" }), userActivation: "yes" },
      { ...wrap({ jsonrpc: "2.0", method: "ui/ping" }), extra: 1 },
    ]) {
      const channel = new MessageChannel();
      const transport = new BoundedMessagePortTransport(channel.port1);
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      await transport.start();
      channel.port2.start();
      channel.port2.postMessage(bad);
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 3_000 });
      channel.port2.close();
    }
  });
});

describe("MCP App host timers and permissions", () => {
  it("arms the initialize timeout only for third-party widgets once the result is in", async () => {
    vi.useFakeTimers();
    try {
      const controller = makeController({ projection: projection({ status: "inProgress" }) });
      const internals = controller as unknown as Record<string, unknown>;
      internals.resourceSent = true;
      const arm = (internals.armInitializeTimeout as (g: number) => void).bind(controller);
      arm(0);
      expect(internals.initializeTimer).toBeNull();
      controller.updateProjection(projection({ status: "completed", durationMs: 3 }));
      expect(internals.initializeTimer).not.toBeNull();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(controller.getSnapshot().phase).not.toBe("failed");
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("failed"));

      const firstParty = makeController({ binding: { ...binding, isFirstParty: true } });
      const firstInternals = firstParty as unknown as Record<string, unknown>;
      firstInternals.resourceSent = true;
      (firstInternals.armInitializeTimeout as (g: number) => void).call(firstParty, 0);
      expect(firstInternals.initializeTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the grant with the full approved set and never asks with frame sites", async () => {
    const requestPermissions = vi.fn(async (_id: string, permissions: Record<string, boolean>) => ({
      granted: permissions,
    }));
    const desktop = {
      register: async () => null,
      unregister: async () => true,
      requestPermissions,
    };
    const controller = makeController();
    const apply = (
      (controller as unknown as Record<string, unknown>).applyPermissionGrant as (
        ...args: unknown[]
      ) => Promise<string[]>
    ).bind(controller);
    await expect(
      apply(desktop, "sb", ["camera", "microphone"], ["camera"], false),
    ).resolves.toEqual(["camera"]);
    expect(requestPermissions).toHaveBeenLastCalledWith("sb", { camera: true });
    // A denial still replaces the grant: `{}` revokes.
    await expect(apply(desktop, "sb", ["camera"], [], false)).resolves.toEqual([]);
    expect(requestPermissions).toHaveBeenLastCalledWith("sb", {});
    requestPermissions.mockClear();
    await expect(apply(desktop, "sb", ["camera"], ["camera"], true)).resolves.toEqual([]);
    expect(requestPermissions).not.toHaveBeenCalled();
  });
});

describe("MCP App tool data delivery", () => {
  function fakeBridge() {
    const sent: Array<[string, unknown]> = [];
    return {
      sent,
      sendToolInput: vi.fn(async (params: unknown) => {
        sent.push(["tool-input", params]);
      }),
      sendToolResult: vi.fn(async (params: unknown) => {
        sent.push(["tool-result", params]);
      }),
    };
  }

  function arm(controller: McpAppHostController, bridge: ReturnType<typeof fakeBridge>) {
    const internals = controller as unknown as Record<string, unknown>;
    internals.bridge = bridge;
    internals.running = true;
    internals.initialized = true;
    return (internals.deliverToolData as (generation: number) => Promise<void>).bind(controller);
  }

  it("sends tool-input once, then the server's full result once", async () => {
    const toolResult = vi.fn(
      async (): Promise<McpAppToolResultResponse> => ({
        status: "ready",
        input: { query: "full" },
        result: {
          content: [{ type: "text", text: "full" }],
          structuredContent: { rows: [1, 2] },
          _meta: { "moss/secret": 1, "anthropic/x": 2, keep: true },
        },
      }),
    );
    const controller = makeController({ api: { toolResult } });
    const bridge = fakeBridge();
    const deliver = arm(controller, bridge);
    await deliver(0);
    await deliver(0);
    controller.updateProjection(projection({ durationMs: 5 }));
    await waitForEvent();
    expect(bridge.sent).toEqual([
      ["tool-input", { arguments: { query: "full" } }],
      [
        "tool-result",
        {
          content: [{ type: "text", text: "full" }],
          structuredContent: { rows: [1, 2] },
          _meta: { keep: true },
        },
      ],
    ]);
  });

  it("waits while the call runs instead of sending an error result first", async () => {
    vi.useFakeTimers();
    try {
      let status: McpAppToolResultResponse = { status: "pending" };
      const controller = makeController({
        projection: projection({ status: "inProgress" }),
        api: { toolResult: async () => status },
      });
      const bridge = fakeBridge();
      const deliver = arm(controller, bridge);
      await deliver(0);
      expect(bridge.sent).toEqual([["tool-input", { arguments: { query: "safe" } }]]);
      status = { status: "missing" };
      await vi.advanceTimersByTimeAsync(1_000);
      // Server lost the result and the projection still runs: still nothing.
      expect(bridge.sent).toHaveLength(1);
      controller.updateProjection(
        projection({ result: { content: [{ type: "text", text: "done" }] } }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.sent[1]).toEqual([
        "tool-result",
        { content: [{ type: "text", text: "done" }] },
      ]);
      expect(bridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(bridge.sendToolResult).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when the server keeps answering pending after the call ended", async () => {
    vi.useFakeTimers();
    try {
      const toolResult = vi.fn(
        async (): Promise<McpAppToolResultResponse> => ({ status: "pending" }),
      );
      const controller = makeController({
        projection: projection({ result: { content: [{ type: "text", text: "done" }] } }),
        api: { toolResult },
      });
      const bridge = fakeBridge();
      await arm(controller, bridge)(0);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(bridge.sent.at(-1)).toEqual([
        "tool-result",
        { content: [{ type: "text", text: "done" }] },
      ]);
      expect(toolResult.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the text fallback when the server answers that the call failed", async () => {
    const controller = makeController({
      api: { toolResult: async () => ({ status: "failed", message: "schema validation" }) },
    });
    const bridge = fakeBridge();
    await arm(controller, bridge)(0);
    expect(bridge.sendToolInput).not.toHaveBeenCalled();
    expect(bridge.sendToolResult).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("failed");
  });

  it("moves a still-starting frame to the slot of a row that remounted before initialized", () => {
    // Real-data run: the debug widget's row remounted 100 ms after its webview was created; the
    // frame stayed on the detached slot (display:none) and the widget never said initialized.
    const controller = makeController();
    const internals = controller as unknown as Record<string, unknown>;
    const follow = vi.fn(() => true);
    internals.tracker = { follow, setVisible: vi.fn() };
    internals.snapshot = { ...controller.getSnapshot(), phase: "loading" };
    internals.running = false;
    const oldSlot = {} as HTMLElement;
    const newSlot = {} as HTMLElement;
    internals.inlineContainer = oldSlot;
    controller.detachInline(oldSlot);
    controller.attachInline(newSlot);
    expect(follow).toHaveBeenCalledWith(newSlot, "inline");
    expect(controller.getInlineContainer()).toBe(newSlot);
  });

  it("shows a failed call's fallback at once, while the guest is still being torn down", () => {
    // The desktop shell's unregister may take its time (or never answer); the card must not
    // keep showing 「正在加载」 meanwhile.
    const controller = makeController({
      projection: projection({ status: "inProgress" }),
      desktop: { register: async () => null, unregister: () => new Promise(() => undefined) },
    });
    const internals = controller as unknown as Record<string, unknown>;
    internals.snapshot = { ...controller.getSnapshot(), phase: "loading" };
    internals.descriptor = {
      generation: 0,
      initId: "init-1",
      origin: "moss-mcp-sandbox://mcp-test",
      partition: "moss-mcp-mcp-test",
      sandboxId: "mcp-test",
      src: "moss-mcp-sandbox://mcp-test/ui?generation=0#init=init-1",
    };
    controller.updateProjection(
      projection({ status: "failed", error: { message: "Debug text content #1" } }),
    );
    expect(controller.getSnapshot().phase).toBe("failed");
  });

  it("shows the text fallback when a failed call left no usable result", async () => {
    const controller = makeController({
      projection: projection({ status: "failed", error: { message: "bad structuredContent" } }),
      api: { toolResult: async () => ({ status: "missing" }) },
    });
    const bridge = fakeBridge();
    await arm(controller, bridge)(0);
    expect(bridge.sendToolResult).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("failed");
  });

  it("falls back to the projection when the server has no stored result", async () => {
    const controller = makeController({
      projection: projection({ result: { content: [{ type: "text", text: "short" }] } }),
      api: { toolResult: async () => ({ status: "missing" }) },
    });
    const bridge = fakeBridge();
    await arm(controller, bridge)(0);
    expect(bridge.sent).toEqual([
      ["tool-input", { arguments: { query: "safe" } }],
      ["tool-result", { content: [{ type: "text", text: "short" }] }],
    ]);
  });

  it("does not send a result whose structuredContent is not an object, and shows the fallback", async () => {
    const controller = makeController({
      api: {
        toolResult: async () => ({
          status: "ready",
          input: {},
          result: { content: [], structuredContent: [1, 2] as never },
        }),
      },
    });
    const bridge = fakeBridge();
    const internals = controller as unknown as Record<string, unknown>;
    await arm(controller, bridge)(0);
    expect(bridge.sendToolResult).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(internals.bridge).toBeNull();
  });
});

describe("MCP App host outside the desktop app", () => {
  it("reports browser_unavailable instead of rendering a frame", async () => {
    const controller = makeController({ desktop: null });
    await controller.start({} as HTMLElement);
    expect(controller.getSnapshot().phase).toBe("browser_unavailable");
  });
});

describe("MCP App suspension (side-panel residency)", () => {
  it("tells the app, unloads it, returns to idle in a new generation, and starts again", async () => {
    const controller = makeController({ desktop: null });
    const internals = controller as unknown as Record<string, unknown>;
    const teardownResource = vi.fn(async () => ({}));
    const close = vi.fn(async () => undefined);
    internals.bridge = { teardownResource, close };
    internals.running = true;
    (internals.setSnapshot as (partial: object) => void).call(controller, { phase: "ready" });
    const generation = internals.generation as number;

    await controller.suspend();

    expect(teardownResource).toHaveBeenCalledWith({});
    expect(close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(internals.generation).toBe(generation + 1);
    // Shown again: the next start runs the app from the beginning (here: no desktop bridge).
    await controller.start({} as HTMLElement);
    expect(controller.getSnapshot().phase).toBe("browser_unavailable");
  });

  it("does nothing for an app that never started", async () => {
    const controller = makeController();
    await controller.suspend();
    expect(controller.getSnapshot().phase).toBe("idle");
  });
});

describe("MCP App graceful teardown", () => {
  it("requests resource teardown before closing the bridge path", async () => {
    const teardownResource = vi.fn(async () => ({}));
    await requestMcpAppTeardown({ teardownResource });
    expect(teardownResource).toHaveBeenCalledWith({});
  });

  it("does not block cleanup when the app never acknowledges teardown", async () => {
    const teardownResource = vi.fn(() => new Promise<Record<string, unknown>>(() => undefined));
    await expect(requestMcpAppTeardown({ teardownResource }, 1)).resolves.toBeUndefined();
  });

  it("performs graceful teardown before close, then continues through unregister failures", async () => {
    const order: string[] = [];
    const controller = makeController({
      desktop: {
        register: async () => null,
        unregister: async () => {
          order.push("unregister");
          throw new Error("already gone");
        },
      },
    });
    const internals = controller as unknown as Record<string, unknown>;
    internals.bridge = {
      teardownResource: async () => {
        order.push("teardown");
      },
      close: async () => {
        order.push("bridge-close");
      },
    };
    internals.transport = { close: async () => order.push("transport-close") };
    internals.descriptor = {
      generation: 0,
      initId: "init-1",
      origin: "moss-mcp-sandbox://mcp-test",
      partition: "moss-mcp-mcp-test",
      sandboxId: "mcp-test",
      src: "moss-mcp-sandbox://mcp-test/ui?generation=0#init=init-1",
    };
    internals.running = true;
    internals.cleanupBridge = () => order.push("listeners-cleaned");
    await controller.teardown();
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
    const controller = makeController();
    const internals = controller as unknown as Record<string, unknown>;
    internals.navigationPort = {
      removeEventListener: (_type: string, listener: EventListener) => {
        expect(listener).toBe(navigationTeardownListener);
        order.push("navigation-listener-removed");
      },
      close: () => order.push("navigation-close"),
    };
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
  });

  it("asks for device access again when the widget went away before an answer", async () => {
    const controller = makeController({ binding: { ...binding, serverKey: "perm-cancel" } });
    const internals = controller as unknown as Record<string, unknown>;
    const asked = (internals.resolvePermissions as (r: unknown) => Promise<string[]>).call(
      controller,
      {
        state: "ready",
        permissions: { clipboardWrite: {} },
        csp: { frameDomains: [] },
      },
    );
    expect(controller.getSnapshot().prompt).toEqual({
      kind: "permission",
      permissions: ["clipboardWrite"],
    });
    await controller.teardown();
    await expect(asked).resolves.toEqual([]);
    const { readMcpAppPermissionDecision } = await import("./mcpApps/preferences");
    expect(readMcpAppPermissionDecision("perm-cancel")).toBeNull();
  });

  it("answers pending prompts and dialogs with a refusal when the widget goes away", async () => {
    const controller = makeController();
    const internals = controller as unknown as Record<string, unknown>;
    const prompt = (internals.enqueuePrompt as (p: unknown) => Promise<boolean>).call(controller, {
      kind: "sign_in",
    });
    expect(controller.getSnapshot().prompt).toEqual({ kind: "sign_in" });
    const dialog = (internals.openDialog as (d: unknown) => Promise<unknown>).call(controller, {
      kind: "download",
      items: [],
    });
    // A second dialog anywhere is refused while one is open.
    const other = makeController();
    const second = await (
      (other as unknown as Record<string, unknown>).openDialog as (d: unknown) => Promise<unknown>
    ).call(other, { kind: "download", items: [] });
    expect(second).toBeNull();
    await controller.teardown();
    await expect(prompt).resolves.toBeNull();
    await expect(dialog).resolves.toBeNull();
    expect(controller.getSnapshot().dialog).toBeNull();
  });
});
