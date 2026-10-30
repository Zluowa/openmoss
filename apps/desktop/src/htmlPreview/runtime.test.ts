import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, Session, WebContents } from "electron";

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  fetch: vi.fn(),
}));
vi.mock("electron", () => ({
  session: { fromPartition: electron.fromPartition },
  ipcMain: electron.ipcMain,
  net: { fetch: electron.fetch },
}));
vi.mock("../observability/sentry", () => ({
  registerSentryIpcHandler: (ipc: typeof electron.ipcMain, ...args: unknown[]) =>
    ipc.handle(...args),
}));
import { HTML_PREVIEW_ATTACH_TIMEOUT_MS, HtmlPreviewRuntime } from "./runtime";

function partition() {
  return {
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  };
}
function owner(id: number) {
  const emitter = Object.assign(new EventEmitter(), { id });
  return { window: { webContents: emitter } as unknown as BrowserWindow, emitter };
}
function guest(source: string, targetSession: Session) {
  return Object.assign(new EventEmitter(), {
    session: targetSession,
    getURL: () => source,
    isDestroyed: () => false,
    close: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  electron.fromPartition.mockImplementation(() => partition());
});
afterEach(() => vi.useRealTimers());

describe("HTML preview host authority", () => {
  it("admits only the registering owner once and replaces hostile web preferences", async () => {
    const runtime = new HtmlPreviewRuntime();
    const first = owner(1);
    runtime.attachOwner(first.window);
    const descriptor = await runtime.register(1, { html: "<script>1</script>" });
    const params = { partition: descriptor.partition, src: descriptor.src };
    const denied = { preventDefault: vi.fn() };
    expect(runtime.handleWillAttachWebview(2, denied, {}, params)).toBe(true);
    expect(denied.preventDefault).toHaveBeenCalledOnce();
    const wrongSource = { preventDefault: vi.fn() };
    runtime.handleWillAttachWebview(1, wrongSource, {}, { ...params, src: "file:///secret.html" });
    expect(wrongSource.preventDefault).toHaveBeenCalledOnce();
    const accepted = { preventDefault: vi.fn() };
    const preferences = { preload: "/hostile.js", nodeIntegration: true, webSecurity: false };
    runtime.handleWillAttachWebview(1, accepted, preferences, params);
    expect(accepted.preventDefault).not.toHaveBeenCalled();
    expect(preferences).not.toHaveProperty("preload");
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegrationInWorker: false,
    });
    const replay = { preventDefault: vi.fn() };
    runtime.handleWillAttachWebview(1, replay, {}, params);
    expect(replay.preventDefault).toHaveBeenCalledOnce();
    first.emitter.emit("destroyed");
  });

  it("binds the actual guest session, blocks unsafe navigation and revokes on owner destruction", async () => {
    const runtime = new HtmlPreviewRuntime();
    const first = owner(1);
    runtime.attachOwner(first.window);
    const descriptor = await runtime.register(1, { html: "example" });
    const targetSession = electron.fromPartition.mock.results[0]!.value;
    runtime.handleWillAttachWebview(1, { preventDefault: vi.fn() }, {}, descriptor);
    const embedded = guest("", targetSession);
    expect(runtime.handleDidAttachWebview(1, embedded as unknown as WebContents)).toBe(true);
    const navigate = { preventDefault: vi.fn() };
    embedded.emit("will-navigate", navigate, "file:///secret.html");
    expect(navigate.preventDefault).toHaveBeenCalledOnce();
    const anchor = { preventDefault: vi.fn() };
    embedded.emit("will-navigate", anchor, `${descriptor.src}#section`);
    expect(anchor.preventDefault).not.toHaveBeenCalled();
    expect(embedded.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" });
    expect(targetSession.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    const permission = vi.fn();
    targetSession.setPermissionRequestHandler.mock.calls[0][0](null, "media", permission);
    expect(permission).toHaveBeenCalledWith(false);
    first.emitter.emit("destroyed");
    expect(embedded.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(targetSession.protocol.unhandle).toHaveBeenCalledWith("moss-local-preview");
    expect(targetSession.clearStorageData).toHaveBeenCalledOnce();
    expect(targetSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(runtime.unregister(1, { id: descriptor.id })).toBe(false);
    await expect(runtime.register(1, { html: "late" })).rejects.toThrow("no longer");
  });

  it("does not expire a successfully attached preview after the registration lease", async () => {
    const runtime = new HtmlPreviewRuntime();
    const first = owner(1);
    runtime.attachOwner(first.window);
    const descriptor = await runtime.register(1, { html: "example" });
    const targetSession = electron.fromPartition.mock.results[0]!.value;
    runtime.handleWillAttachWebview(1, { preventDefault: vi.fn() }, {}, descriptor);
    const embedded = guest(descriptor.src, targetSession);
    expect(runtime.handleDidAttachWebview(1, embedded as unknown as WebContents)).toBe(true);
    await vi.advanceTimersByTimeAsync(HTML_PREVIEW_ATTACH_TIMEOUT_MS * 2);
    expect(embedded.close).not.toHaveBeenCalled();
    expect(runtime.unregister(1, { id: descriptor.id })).toBe(true);
    first.emitter.emit("destroyed");
  });

  it("does not consume another preview when a foreign guest or owner is presented", async () => {
    const runtime = new HtmlPreviewRuntime();
    const first = owner(1);
    runtime.attachOwner(first.window);
    const descriptor = await runtime.register(1, { html: "example" });
    expect(
      runtime.handleDidAttachWebview(1, guest("", {} as Session) as unknown as WebContents),
    ).toBe(false);
    expect(runtime.unregister(2, { id: descriptor.id })).toBe(false);
    expect(runtime.unregister(1, { id: descriptor.id })).toBe(true);
    expect(runtime.unregister(1, { id: descriptor.id })).toBe(false);
  });

  it("expires unattached registrations and prevents guests bypassing admission", async () => {
    const runtime = new HtmlPreviewRuntime();
    runtime.attachOwner(owner(1).window);
    const descriptor = await runtime.register(1, { html: "example" });
    const unadmitted = guest(descriptor.src, electron.fromPartition.mock.results[0]!.value);
    expect(runtime.handleDidAttachWebview(1, unadmitted as unknown as WebContents)).toBe(true);
    expect(unadmitted.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HTML_PREVIEW_ATTACH_TIMEOUT_MS);
    expect(runtime.unregister(1, { id: descriptor.id })).toBe(false);
  });

  it("enforces the per-owner limit after asynchronous concurrent registration", async () => {
    const runtime = new HtmlPreviewRuntime();
    const first = owner(1);
    runtime.attachOwner(first.window);
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => runtime.register(1, { html: "example" })),
    );
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    first.emitter.emit("destroyed");
  });

  it("rejects IPC from subframes even when they share the owner WebContents", async () => {
    const runtime = new HtmlPreviewRuntime();
    runtime.attachOwner(owner(1).window);
    runtime.registerIpcHandlers();
    const handler = electron.ipcMain.handle.mock.calls.find(
      ([channel]) => channel === "desktop:html-preview-register",
    )![1];
    expect(() =>
      handler({ sender: { id: 1, mainFrame: {} }, senderFrame: {} }, { html: "bad" }),
    ).toThrow("main application frame");
  });
});
