import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  },
  partitionSession: {
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setUserAgent: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    on: vi.fn(),
    removeListener: vi.fn(),
    getUserAgent: vi.fn(() => "Mozilla/5.0"),
  },
}));

vi.mock("electron", () => ({
  ipcMain: electronMocks.ipcMain,
  session: { fromPartition: electronMocks.fromPartition },
}));

import {
  MCP_APP_SANDBOX_PENDING_TTL_MS,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_SCHEME,
  type McpAppSandboxDescriptor,
} from "@synara/contracts";
import { McpAppSandboxRuntime } from "./runtime";
import { mcpAppSandboxContentUrl } from "./policy";

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  callId: "call-runtime-1",
  containerDimensions: { height: 240, width: 640 },
  csp: {
    baseUriDomains: [],
    connectDomains: ["https://api.example.test"],
    frameDomains: [],
    includeDefaultDomains: false,
    isTrusted: true,
    resourceDomains: ["https://cdn.example.test"],
  },
  generation: 0,
  isCollapsible: true,
  prefersBorder: true,
  resourceUri: "ui://widget/runtime",
  server: "server-runtime",
  theme: "light",
  threadId: "thread-runtime-1",
  ...overrides,
});

function owner(id: number) {
  return {
    webContents: {
      id,
      once: vi.fn(),
      isDestroyed: () => false,
      postMessage: vi.fn(),
    },
  } as never;
}

type GuestMock = EventEmitter & {
  id: number;
  getURL: () => string;
  isDestroyed: () => boolean;
  postMessage: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  session: typeof electronMocks.partitionSession;
};

let nextGuestId = 1;

function guest(url: string, guestSession = electronMocks.partitionSession): GuestMock {
  const emitter = new EventEmitter();
  const value = emitter as GuestMock;
  value.id = nextGuestId++;
  value.getURL = () => url;
  value.isDestroyed = () => false;
  value.postMessage = vi.fn();
  value.setWindowOpenHandler = vi.fn();
  value.close = vi.fn();
  value.session = guestSession;
  return value;
}

function attach(
  runtime: McpAppSandboxRuntime,
  ownerId: number,
  descriptor: McpAppSandboxDescriptor,
) {
  const event = { preventDefault: vi.fn() };
  const webPreferences: Record<string, unknown> = {
    nodeIntegration: true,
    preload: "/malicious-preload.js",
  };
  const claimed = runtime.handleWillAttachWebview(
    ownerId,
    event,
    webPreferences,
    { partition: descriptor.partition, src: descriptor.src },
    "/mcpSandboxPreload.js",
  );
  return { event, webPreferences, claimed };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextGuestId = 1;
  electronMocks.fromPartition.mockReturnValue(electronMocks.partitionSession);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP App sandbox runtime authority lifecycle", () => {
  it("keeps same-source different-card guests independent while same-card retry replaces only itself", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    runtime.attachOwner(owner(2));
    const first = runtime.register(1, baseInput());
    const secondCard = runtime.register(1, baseInput({ callId: "call-runtime-2" }));
    expect(first).not.toBeNull();
    expect(secondCard).not.toBeNull();
    expect(secondCard?.partition).toBe(first?.partition);
    expect(runtime.registry.pendingCount).toBe(2);

    const retry = runtime.register(1, baseInput({ generation: 1 }));
    expect(retry?.partition).toBe(first?.partition);
    expect(retry?.initId).not.toBe(first?.initId);
    expect(runtime.registry.pendingCount).toBe(2);

    const otherOwner = runtime.register(2, baseInput());
    expect(otherOwner?.partition).toBe(first?.partition);
    expect(runtime.registry.pendingCount).toBe(3);
    expect(electronMocks.partitionSession.protocol.handle).toHaveBeenCalledOnce();
  });

  it("does not unhandle a shared partition until its final authority is gone", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const first = runtime.register(1, baseInput());
    const second = runtime.register(1, baseInput({ callId: "call-runtime-2" }));
    if (!first || !second) throw new Error("runtime registration failed");
    expect(
      runtime.unregister(1, {
        sandboxId: first.sandboxId,
        initId: first.initId,
        generation: first.generation,
      }),
    ).toBe(true);
    expect(electronMocks.partitionSession.protocol.unhandle).not.toHaveBeenCalled();
    expect(
      runtime.unregister(1, {
        sandboxId: second.sandboxId,
        initId: second.initId,
        generation: second.generation,
      }),
    ).toBe(true);
    expect(electronMocks.partitionSession.protocol.unhandle).toHaveBeenCalledOnce();
  });

  it("times out a consumed attachment that never reaches did-attach", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    const result = attach(runtime, 1, descriptor);
    expect(result.claimed).toBe(true);
    expect(result.event.preventDefault).not.toHaveBeenCalled();
    expect(result.webPreferences.nodeIntegration).toBe(false);
    expect(result.webPreferences.session).toBe(electronMocks.partitionSession);
    expect(result.webPreferences.partition).toBeUndefined();
    expect(runtime.registry.hasPartition(descriptor.partition)).toBe(true);
    vi.advanceTimersByTime(MCP_APP_SANDBOX_PENDING_TTL_MS);
    expect(runtime.registry.hasPartition(descriptor.partition)).toBe(false);
    expect(electronMocks.partitionSession.protocol.unhandle).toHaveBeenCalledOnce();
  });

  it("expires an unconsumed registration and releases its partition route", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    expect(runtime.registry.pendingCount).toBe(1);
    vi.advanceTimersByTime(MCP_APP_SANDBOX_PENDING_TTL_MS);
    expect(runtime.registry.pendingCount).toBe(0);
    expect(
      (runtime as unknown as { registeredPartitions: Map<string, unknown> }).registeredPartitions
        .size,
    ).toBe(0);
    expect(electronMocks.partitionSession.protocol.unhandle).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous empty did-attach association instead of guessing", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const first = runtime.register(1, baseInput());
    const second = runtime.register(1, baseInput({ callId: "call-runtime-2" }));
    if (!first || !second) throw new Error("runtime registration failed");
    attach(runtime, 1, first);
    attach(runtime, 1, second);
    const candidate = guest("");
    expect(runtime.handleDidAttachWebview(1, candidate as never)).toBe(true);
    expect(candidate.postMessage).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(MCP_APP_SANDBOX_PENDING_TTL_MS);
    expect(runtime.registry.hasPartition(first.partition)).toBe(false);
  });

  it("leaves ordinary non-MCP guests untouched and claims only MCP signals", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const ordinarySession = { ...electronMocks.partitionSession };
    const ordinaryUrl = guest("https://example.test/annotation", ordinarySession);
    const ordinaryEmpty = guest("", ordinarySession);
    expect(runtime.handleDidAttachWebview(1, ordinaryUrl as never)).toBe(false);
    expect(runtime.handleDidAttachWebview(1, ordinaryEmpty as never)).toBe(false);
    expect(ordinaryUrl.close).not.toHaveBeenCalled();
    expect(ordinaryEmpty.close).not.toHaveBeenCalled();

    const rejectedMcp = guest(`${MCP_APP_SANDBOX_SCHEME}://unknown/ui`, ordinarySession);
    expect(runtime.handleDidAttachWebview(1, rejectedMcp as never)).toBe(true);
    expect(rejectedMcp.close).toHaveBeenCalledOnce();
  });

  it("cleans an active guest on main-frame load failure", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(descriptor.src);
    runtime.handleDidAttachWebview(1, candidate as never);
    candidate.emit("did-fail-load", {}, -3, "fixture", descriptor.src, true);
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(runtime.registry.hasPartition(descriptor.partition)).toBe(false);
    expect(electronMocks.partitionSession.protocol.unhandle).toHaveBeenCalledOnce();
  });

  it("cleans an active guest on main-frame in-page authority mutation", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(descriptor.src);
    runtime.handleDidAttachWebview(1, candidate as never);
    candidate.emit(
      "did-navigate-in-page",
      {},
      descriptor.src.replace("#init=", "#init=mutated-"),
      true,
    );
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(runtime.registry.hasPartition(descriptor.partition)).toBe(false);
  });

  it("does not tear down the main guest for a subframe load failure or exact same-document URL", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(descriptor.src);
    runtime.handleDidAttachWebview(1, candidate as never);
    candidate.emit("did-fail-load", {}, -3, "subframe", "https://api.example.test/frame", false);
    candidate.emit("did-navigate-in-page", {}, descriptor.src, true);
    expect(candidate.close).not.toHaveBeenCalled();
    expect(runtime.registry.hasPartition(descriptor.partition)).toBe(true);
  });

  it("forwards one guest bridge and rejects duplicate or stale transferred ports", () => {
    const runtime = new McpAppSandboxRuntime();
    const trustedOwner = owner(1);
    runtime.attachOwner(trustedOwner);
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(descriptor.src);
    runtime.handleDidAttachWebview(1, candidate as never);
    const closeA = vi.fn();
    const closeB = vi.fn();
    const event = {
      sender: candidate as never,
      ports: [{ close: closeA }, { close: closeB }, { close: vi.fn() }],
    } as never;
    const handleGuestPortMessage = (
      runtime as unknown as {
        handleGuestPortMessage: (event: unknown, payload: unknown) => void;
      }
    ).handleGuestPortMessage;
    handleGuestPortMessage.call(runtime, event, {
      type: "init",
      origin: descriptor.origin,
      initId: descriptor.initId,
      portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
    });
    expect(
      (trustedOwner as { webContents: { postMessage: ReturnType<typeof vi.fn> } }).webContents
        .postMessage,
    ).toHaveBeenCalledOnce();
    const duplicateClose = vi.fn();
    handleGuestPortMessage.call(
      runtime,
      {
        sender: candidate as never,
        ports: [{ close: duplicateClose }, { close: duplicateClose }, { close: duplicateClose }],
      },
      {
        type: "init",
        origin: descriptor.origin,
        initId: descriptor.initId,
        portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
      },
    );
    expect(duplicateClose).toHaveBeenCalledTimes(3);
  });

  it("requires the ordered bridge/navigation port names and admits only the exact inner route", () => {
    const runtime = new McpAppSandboxRuntime();
    const trustedOwner = owner(1);
    runtime.attachOwner(trustedOwner);
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(descriptor.src);
    runtime.handleDidAttachWebview(1, candidate as never);
    const close = vi.fn();
    const handleGuestPortMessage = (
      runtime as unknown as {
        handleGuestPortMessage: (event: unknown, payload: unknown) => void;
      }
    ).handleGuestPortMessage;
    handleGuestPortMessage.call(
      runtime,
      { sender: candidate as never, ports: [{ close }, { close }, { close }] },
      {
        type: "init",
        origin: descriptor.origin,
        initId: descriptor.initId,
        portNames: ["mcp-app-navigation", "mcp-app-host"],
      },
    );
    expect(close).toHaveBeenCalledTimes(3);

    const navigationDetails = {
      url: mcpAppSandboxContentUrl(descriptor),
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    candidate.emit("will-frame-navigate", navigationDetails);
    expect(navigationDetails.preventDefault).not.toHaveBeenCalled();
    const foreignDetails = {
      url: `${descriptor.origin}/content?generation=0&init=stale`,
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    candidate.emit("will-frame-navigate", foreignDetails);
    expect(foreignDetails.preventDefault).toHaveBeenCalledOnce();
  });

  it("rejects a complete stale guest envelope after a same-card retry", () => {
    const runtime = new McpAppSandboxRuntime();
    const trustedOwner = owner(1);
    runtime.attachOwner(trustedOwner);
    const first = runtime.register(1, baseInput());
    if (!first) throw new Error("first registration failed");
    attach(runtime, 1, first);
    const staleGuest = guest(first.src);
    runtime.handleDidAttachWebview(1, staleGuest as never);
    const retried = runtime.register(1, baseInput({ generation: 1 }));
    if (!retried) throw new Error("retry registration failed");
    attach(runtime, 1, retried);
    const currentGuest = guest(retried.src);
    runtime.handleDidAttachWebview(1, currentGuest as never);
    const staleCloseA = vi.fn();
    const staleCloseB = vi.fn();
    const handleGuestPortMessage = (
      runtime as unknown as {
        handleGuestPortMessage: (event: unknown, payload: unknown) => void;
      }
    ).handleGuestPortMessage;
    handleGuestPortMessage.call(
      runtime,
      {
        sender: staleGuest as never,
        ports: [{ close: staleCloseA }, { close: staleCloseB }, { close: vi.fn() }],
      },
      {
        type: "init",
        origin: first.origin,
        initId: first.initId,
        portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
      },
    );
    expect(staleCloseA).toHaveBeenCalledOnce();
    expect(staleCloseB).toHaveBeenCalledOnce();
    expect(
      (trustedOwner as { webContents: { postMessage: ReturnType<typeof vi.fn> } }).webContents
        .postMessage,
    ).not.toHaveBeenCalled();
  });

  it("cleans an active guest when its preload reports an error", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(descriptor.src);
    runtime.handleDidAttachWebview(1, candidate as never);
    candidate.emit("preload-error", {}, "/mcpSandboxPreload.js", new Error("fixture"));
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(runtime.registry.hasPartition(descriptor.partition)).toBe(false);
    expect(electronMocks.partitionSession.protocol.unhandle).toHaveBeenCalledOnce();
  });

  it("rejects a custom-scheme guest from a different partition session", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("runtime registration failed");
    attach(runtime, 1, descriptor);
    const candidate = guest(`${MCP_APP_SANDBOX_SCHEME}://wrong-session/ui`, {
      ...electronMocks.partitionSession,
    });
    candidate.session = { ...electronMocks.partitionSession };
    runtime.handleDidAttachWebview(1, candidate as never);
    expect(candidate.close).toHaveBeenCalledOnce();
  });

  it("bounds live partition handlers but allows more than 128 sequential sources", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const live: McpAppSandboxDescriptor[] = [];

    for (let index = 0; index < 128; index += 1) {
      const descriptor = runtime.register(
        1,
        baseInput({
          callId: `call-live-${index}`,
          resourceUri: `ui://widget/live-${index}`,
          threadId: `thread-live-${index}`,
        }),
      );
      if (!descriptor) throw new Error(`live registration ${index} failed`);
      live.push(descriptor);
    }
    expect(electronMocks.partitionSession.protocol.handle).toHaveBeenCalledTimes(128);

    const rejected = runtime.register(
      1,
      baseInput({
        callId: "call-live-rejected",
        resourceUri: "ui://widget/live-rejected",
        threadId: "thread-live-rejected",
      }),
    );
    expect(rejected).toBeNull();
    expect(runtime.registry.pendingCount).toBe(128);

    const first = live[0];
    if (!first) throw new Error("missing first live descriptor");
    expect(
      runtime.unregister(1, {
        sandboxId: first.sandboxId,
        initId: first.initId,
        generation: first.generation,
      }),
    ).toBe(true);
    const replacement = runtime.register(
      1,
      baseInput({
        callId: "call-live-replacement",
        resourceUri: "ui://widget/live-replacement",
        threadId: "thread-live-replacement",
      }),
    );
    expect(replacement).not.toBeNull();
    expect(electronMocks.partitionSession.protocol.handle).toHaveBeenCalledTimes(129);
  });
});
