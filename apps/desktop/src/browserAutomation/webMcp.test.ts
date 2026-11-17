// Ported from the August WebMCP host tests (35b3236ed..502b73f34), fitted to the
// BetterWright host: origin binding, consequential hints and per-guest frames.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const cdp = vi.hoisted(() => ({
  /** What the page's bridge answers to Runtime.callFunctionOn, as `{ value }`. */
  callFunctionOn: vi.fn(),
  evaluateInContext: vi.fn(),
  observePage: vi.fn(),
  ensureCdpAttached: vi.fn(),
  abortReason: (signal: AbortSignal) =>
    signal.reason instanceof Error ? signal.reason : new Error("Browser operation cancelled."),
  throwIfAborted: vi.fn((signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason;
  }),
}));

vi.mock("./cdpRuntime", () => cdp);

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { discoverWebMcpTools, invokeWebMcpTool, webMcpToolIsConsequential } from "./webMcp";

const TAB_ID = "11111111-1111-4111-8111-111111111111";
const debuggerEvents = new EventEmitter();
const webContentsEvents = new EventEmitter();
// Throttling is observed per guest: a page tool call must keep frames running
// on this guest for its duration and restore the guest's own setting after.
const throttling = { value: true, history: [] as boolean[] };
// Runtime.callFunctionOn goes to the bridge mock above; everything else succeeds.
const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
  if (method !== "Runtime.callFunctionOn") return {};
  const answer = (await cdp.callFunctionOn(runtime, params?.objectId, params?.functionDeclaration, {
    arguments: (params?.arguments as Array<{ value: unknown }> | undefined)?.map(
      (argument) => argument.value,
    ),
    userGesture: params?.userGesture,
  })) as { value?: unknown };
  return { result: { value: answer?.value } };
});
const guestUrl = { value: "https://shop.example/cart" };
const runtime = {
  tabId: TAB_ID,
  webContents: Object.assign(webContentsEvents, {
    isDestroyed: () => false,
    getURL: () => guestUrl.value,
    getBackgroundThrottling: () => throttling.value,
    setBackgroundThrottling: (value: boolean) => {
      throttling.value = value;
      throttling.history.push(value);
    },
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => true,
      sendCommand,
    }),
  }),
} as unknown as BrowserAutomationVisibleRuntime;

const bridgeTool = (input: {
  readonly index: number;
  readonly name: string;
  readonly description: string;
  readonly readOnlyHint?: boolean;
  readonly consequentialHint?: boolean;
}) => ({
  index: input.index,
  name: input.name,
  description: input.description,
  signature: "a".repeat(64),
  inputSchema: { type: "object", properties: {} },
  origin: "https://shop.example",
  annotations: {
    readOnlyHint: input.readOnlyHint ?? false,
    consequentialHint: input.consequentialHint ?? input.readOnlyHint !== true,
    untrustedContentHint: true,
  },
});

describe("WebMCP browser bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    throttling.value = true;
    throttling.history = [];
    guestUrl.value = "https://shop.example/cart";
    debuggerEvents.removeAllListeners();
    webContentsEvents.removeAllListeners();
    cdp.observePage.mockResolvedValue({ url: "https://shop.example", title: "Shop" });
    cdp.evaluateInContext.mockResolvedValue({ objectId: "bridge-object" });
  });

  it("ranks a compact discovery by the current user goal", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [
          bridgeTool({ index: 0, name: "search", description: "Search products." }),
          bridgeTool({
            index: 1,
            name: "checkout",
            description: "Complete checkout for the current cart.",
          }),
        ],
      },
    });

    const discovery = await discoverWebMcpTools(
      runtime,
      { query: "complete checkout", limit: 1 },
      7,
      new AbortController().signal,
    );

    expect(discovery.output).toMatchObject({
      available: true,
      contentTrust: "untrusted-web-page",
      totalToolCount: 2,
      truncated: true,
      tools: [{ toolId: "w1", name: "checkout" }],
    });
    expect(discovery.handle?.humanControlEpoch).toBe(7);
    expect(discovery.handle?.entries.get("w1" as never)?.index).toBe(1);
  });

  it("returns at most eight tools by default", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: Array.from({ length: 10 }, (_, index) =>
          bridgeTool({
            index,
            name: `tool_${index}`,
            description: `Page tool ${index}.`,
          }),
        ),
      },
    });

    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    expect(discovery.output.tools).toHaveLength(8);
    expect(discovery.output.truncated).toBe(true);
  });

  it("reserves model-context room for the discovery envelope", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: Array.from({ length: 2 }, (_, index) => ({
          ...bridgeTool({
            index,
            name: `large_tool_${index}`,
            description: `Large page tool ${index}.`,
          }),
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "s".repeat(12_000) },
            },
          },
        })),
      },
    });

    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    expect(discovery.output.tools).toHaveLength(1);
    expect(discovery.output.truncated).toBe(true);
  });

  it("invokes only the exact tool definition from the discovery", async () => {
    cdp.callFunctionOn
      .mockResolvedValueOnce({
        value: {
          available: true,
          implementation: "native",
          skippedToolCount: 0,
          tools: [bridgeTool({ index: 0, name: "checkout", description: "Complete checkout." })],
        },
      })
      .mockResolvedValueOnce({ value: { status: "completed", result: { orderId: "order-1" } } });
    const signal = new AbortController().signal;
    const discovery = await discoverWebMcpTools(runtime, { limit: 12 }, 1, signal);
    const handle = discovery.handle!;

    await expect(
      invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          origin: "https://shop.example",
          arguments: { acceptTerms: true },
        },
        handle,
        signal,
      ),
    ).resolves.toMatchObject({
      status: "completed",
      result: { orderId: "order-1" },
      entry: { name: "checkout", origin: "https://shop.example", consequential: true },
    });
    expect(cdp.callFunctionOn).toHaveBeenLastCalledWith(
      runtime,
      "bridge-object",
      expect.stringContaining("this.invoke"),
      expect.objectContaining({
        arguments: [
          0,
          expect.any(String),
          JSON.stringify({ acceptTerms: true }),
          expect.any(String),
        ],
        // A consequential call (the person approved it) acts with user activation.
        userGesture: true,
      }),
    );
  });

  it("rejects a page tool that changed after discovery", async () => {
    cdp.callFunctionOn
      .mockResolvedValueOnce({
        value: {
          available: true,
          implementation: "native",
          skippedToolCount: 0,
          tools: [bridgeTool({ index: 0, name: "checkout", description: "Checkout." })],
        },
      })
      .mockResolvedValueOnce({ value: { status: "stale" } });
    const signal = new AbortController().signal;
    const discovery = await discoverWebMcpTools(runtime, {}, 1, signal);
    const handle = discovery.handle!;

    await expect(
      invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          origin: "https://shop.example",
          arguments: {},
        },
        handle,
        signal,
      ),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserWebMcpDiscoveryStale" },
    });
  });

  it("refuses a call that names a different site than the discovered tool's", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [bridgeTool({ index: 0, name: "transfer", description: "Move money." })],
      },
    });
    const signal = new AbortController().signal;
    const handle = (await discoverWebMcpTools(runtime, {}, 1, signal)).handle!;
    cdp.callFunctionOn.mockClear();

    await expect(
      invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          origin: "https://bank.example",
          arguments: {},
        },
        handle,
        signal,
      ),
    ).rejects.toMatchObject({ browserError: { code: "BrowserWebMcpDiscoveryStale" } });
    expect(cdp.callFunctionOn).not.toHaveBeenCalled();
  });

  it("reports which tools must ask: only read-only, non-consequential tools skip approval", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [
          bridgeTool({ index: 0, name: "snapshot", description: "Read.", readOnlyHint: true }),
          bridgeTool({ index: 1, name: "act", description: "Change.", readOnlyHint: false }),
          bridgeTool({
            index: 2,
            name: "odd",
            description: "Says both.",
            readOnlyHint: true,
            consequentialHint: true,
          }),
        ],
      },
    });
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);
    expect(discovery.output.tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["snapshot", { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true }],
      ["act", { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true }],
      ["odd", { readOnlyHint: true, consequentialHint: true, untrustedContentHint: true }],
    ]);
    expect(webMcpToolIsConsequential({ readOnlyHint: false, consequentialHint: false })).toBe(true);
  });

  it.each([
    ["completes", () => Promise.resolve({ value: { status: "completed", result: null } })],
    [
      "fails in the page",
      () => Promise.resolve({ value: { status: "failed", error: { name: "E", message: "m" } } }),
    ],
    ["is cancelled", () => Promise.reject(new Error("Browser operation cancelled."))],
  ] as const)(
    "keeps the guest's frames running only while the call runs, and restores it when it %s",
    async (_label, outcome) => {
      cdp.callFunctionOn.mockResolvedValueOnce({
        value: {
          available: true,
          implementation: "compatibility",
          skippedToolCount: 0,
          tools: [bridgeTool({ index: 0, name: "act", description: "Change." })],
        },
      });
      const signal = new AbortController().signal;
      const handle = (await discoverWebMcpTools(runtime, {}, 1, signal)).handle!;
      let throttledDuringCall: boolean | undefined;
      cdp.callFunctionOn.mockImplementationOnce(() => {
        throttledDuringCall = throttling.value;
        return outcome();
      });

      await invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          origin: "https://shop.example",
          arguments: {},
        },
        handle,
        signal,
      ).catch(() => undefined);

      expect(throttledDuringCall).toBe(false);
      expect(throttling.value).toBe(true);
      expect(throttling.history).toEqual([false, true]);
    },
  );

  it("leaves a guest that is not throttled as it is", async () => {
    throttling.value = false;
    cdp.callFunctionOn
      .mockResolvedValueOnce({
        value: {
          available: true,
          implementation: "compatibility",
          skippedToolCount: 0,
          tools: [bridgeTool({ index: 0, name: "act", description: "Change." })],
        },
      })
      .mockResolvedValueOnce({ value: { status: "completed", result: null } });
    const signal = new AbortController().signal;
    const handle = (await discoverWebMcpTools(runtime, {}, 1, signal)).handle!;
    await invokeWebMcpTool(
      runtime,
      {
        discoveryId: handle.discoveryId,
        toolId: "w1" as never,
        origin: "https://shop.example",
        arguments: {},
      },
      handle,
      signal,
    );
    expect(throttling.history).toEqual([]);
  });

  it("releases the retained bridge object exactly once", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [bridgeTool({ index: 0, name: "search", description: "Search." })],
      },
    });
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    await discovery.handle!.release();
    await discovery.handle!.release();

    const releases = vi
      .mocked(runtime.webContents.debugger.sendCommand)
      .mock.calls.filter(([method]) => method === "Runtime.releaseObject");
    expect(releases).toHaveLength(1);
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });

  it("invalidates and releases a discovery on spontaneous main-frame navigation", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: {
        available: true,
        implementation: "compatibility",
        skippedToolCount: 0,
        tools: [bridgeTool({ index: 0, name: "search", description: "Search." })],
      },
    });
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);
    const invalidated = vi.fn();
    discovery.handle!.onInvalidated(invalidated);

    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "main-frame", url: "https://shop.example/next" },
    });
    await discovery.handle!.release();

    expect(invalidated).toHaveBeenCalledOnce();
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });

  it("releases the bridge object when discovery is unavailable", async () => {
    cdp.callFunctionOn.mockResolvedValue({
      value: { available: false, implementation: "unavailable", tools: [] },
    });

    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);

    expect(discovery.handle).toBeNull();
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });

  // Review of #655: what the bridge returns is the page's word.
  const listed = (tools: unknown[]) => ({
    value: { available: true, implementation: "compatibility", skippedToolCount: 0, tools },
  });

  it("names the site from the guest's own address and ignores the page's claim", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce(
      listed([
        {
          ...bridgeTool({ index: 0, name: "pay", description: "Pay." }),
          origin: "https://bank.example",
        },
      ]),
    );
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);
    expect(discovery.output.tools[0]?.origin).toBe("https://shop.example");
    expect(discovery.handle?.entries.get("w1" as never)?.origin).toBe("https://shop.example");
  });

  it("refuses a call once the guest shows another site than at discovery", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce(
      listed([bridgeTool({ index: 0, name: "pay", description: "Pay." })]),
    );
    const signal = new AbortController().signal;
    const handle = (await discoverWebMcpTools(runtime, {}, 1, signal)).handle!;
    guestUrl.value = "https://evil.example/";
    cdp.callFunctionOn.mockClear();
    await expect(
      invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          origin: "https://shop.example",
          arguments: {},
        },
        handle,
        signal,
      ),
    ).rejects.toMatchObject({ browserError: { code: "BrowserWebMcpDiscoveryStale" } });
    expect(cdp.callFunctionOn).not.toHaveBeenCalled();
  });

  it("offers no page tools on a page that is not http(s)", async () => {
    guestUrl.value = "file:///C:/Users/me/page.html";
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);
    expect(discovery.output.available).toBe(false);
    expect(cdp.callFunctionOn).not.toHaveBeenCalled();
  });

  it("applies the limits again on the host, whatever the page's bridge did", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce(
      listed([
        bridgeTool({ index: 0, name: "ok", description: "Fine\u0000 tool\u2028 text." }),
        bridgeTool({ index: 1, name: "bad name with spaces", description: "x" }),
        bridgeTool({ index: 2, name: "huge", description: "d".repeat(5_000) }),
        {
          ...bridgeTool({ index: 3, name: "big_schema", description: "Big schema." }),
          inputSchema: { type: "object", description: "s".repeat(20_000) },
        },
      ]),
    );
    const discovery = await discoverWebMcpTools(runtime, {}, 1, new AbortController().signal);
    expect(discovery.output.tools.map((tool) => [tool.name, tool.description])).toEqual([
      ["ok", "Fine tool text."],
    ]);
    expect(discovery.output.skippedToolCount).toBe(3);
  });

  it("fails a result over 64 KiB and cleans a page error's text, on the host", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce(
      listed([bridgeTool({ index: 0, name: "dump", description: "Dump.", readOnlyHint: true })]),
    );
    const signal = new AbortController().signal;
    const handle = (await discoverWebMcpTools(runtime, {}, 1, signal)).handle!;
    const call = () =>
      invokeWebMcpTool(
        runtime,
        {
          discoveryId: handle.discoveryId,
          toolId: "w1" as never,
          origin: "https://shop.example",
          arguments: {},
        },
        handle,
        signal,
      );
    cdp.callFunctionOn.mockResolvedValueOnce({
      value: { status: "completed", result: { text: "x".repeat(70_000) } },
    });
    await expect(call()).resolves.toMatchObject({
      status: "failed",
      error: { name: "WebMcpResultTooLarge" },
    });
    cdp.callFunctionOn.mockResolvedValueOnce({
      value: { status: "failed", error: { name: "E\u0007vil", message: "line\nbreak" } },
    });
    await expect(call()).resolves.toMatchObject({
      status: "failed",
      error: { name: "E vil", message: "line break" },
    });
  });

  it("gives no user activation to listing or to a read-only call", async () => {
    cdp.callFunctionOn.mockResolvedValueOnce(
      listed([bridgeTool({ index: 0, name: "read", description: "Read.", readOnlyHint: true })]),
    );
    const signal = new AbortController().signal;
    const handle = (await discoverWebMcpTools(runtime, {}, 1, signal)).handle!;
    expect(cdp.callFunctionOn).toHaveBeenLastCalledWith(
      runtime,
      "bridge-object",
      expect.stringContaining("this.list()"),
      expect.objectContaining({ userGesture: false }),
    );
    cdp.callFunctionOn.mockResolvedValueOnce({ value: { status: "completed", result: null } });
    await invokeWebMcpTool(
      runtime,
      {
        discoveryId: handle.discoveryId,
        toolId: "w1" as never,
        origin: "https://shop.example",
        arguments: {},
      },
      handle,
      signal,
    );
    expect(cdp.callFunctionOn).toHaveBeenLastCalledWith(
      runtime,
      "bridge-object",
      expect.stringContaining("this.invoke"),
      expect.objectContaining({ userGesture: false }),
    );
  });

  it("stops waiting for a page whose tool list never arrives, and releases the bridge", async () => {
    cdp.callFunctionOn.mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const listing = discoverWebMcpTools(runtime, {}, 1, controller.signal);
    setTimeout(() => controller.abort(new Error("deadline")), 20);
    await expect(listing).rejects.toThrow("deadline");
    expect(runtime.webContents.debugger.sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
      objectId: "bridge-object",
    });
  });
});
