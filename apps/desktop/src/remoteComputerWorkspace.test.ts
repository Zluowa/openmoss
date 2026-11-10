import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openRemoteComputerWorkspace,
  remoteWorkspacePermissionAllowed,
  type RemoteComputerWorkspace,
} from "./remoteComputerWorkspace";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

type HeaderListener = (
  details: { url: string; requestHeaders: Record<string, string> },
  callback: (result: { requestHeaders: Record<string, string> }) => void,
) => void;
interface WindowDouble {
  readonly options: BrowserWindowConstructorOptions;
  readonly load: { resolve: () => void; reject: (error: Error) => void };
  readonly loadURL: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly emit: (event: string, ...args: unknown[]) => boolean;
  readonly webContents: {
    readonly id: number;
    readonly emit: (event: string, ...args: unknown[]) => boolean;
    readonly session: {
      readonly webRequest: { readonly onBeforeSendHeaders: ReturnType<typeof vi.fn> };
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setDevicePermissionHandler: ReturnType<typeof vi.fn>;
      headerListener: HeaderListener | null;
      filter: { urls: string[] } | null;
    };
    openHandler: ((details: { url: string }) => { action: string }) | undefined;
  };
}
const mocks = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  deferClosed: false,
  nextId: 100,
  openExternal: vi.fn(async () => {}),
  confirmExternalLink: vi.fn(async (_input: { name: string; url: string }) => true),
  exposeInMainWorld: vi.fn(),
  sendSync: vi.fn(() => "wss://computer.example.test/"),
}));

// Only Electron's event surfaces are simulated. The factory, header policy,
// navigation policy, ready promise and cleanup under test are production code.
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class MockBrowserWindow extends EventEmitter {
    destroyed = false;
    readonly options: BrowserWindowConstructorOptions;
    readonly load: WindowDouble["load"];
    readonly webContents;
    readonly show = vi.fn();
    readonly loadURL;
    readonly destroy = vi.fn(() => {
      if (this.destroyed) return;
      this.destroyed = true;
      if (!mocks.deferClosed) this.emit("closed");
    });
    isDestroyed = () => this.destroyed;
    constructor(options: BrowserWindowConstructorOptions) {
      super();
      this.options = options;
      let resolve!: () => void, reject!: (error: Error) => void;
      const pending = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.load = { resolve, reject };
      this.loadURL = vi.fn(() => pending);
      const session: WindowDouble["webContents"]["session"] = {
        headerListener: null,
        filter: null,
        webRequest: {
          onBeforeSendHeaders: vi.fn(
            (filter: { urls: string[] } | null, listener?: HeaderListener) => {
              session.filter = filter;
              session.headerListener = filter ? (listener ?? null) : null;
            },
          ),
        },
        clearStorageData: vi.fn(async () => {}),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
      };
      const contents = Object.assign(new EventEmitter(), {
        id: mocks.nextId++,
        session,
        openHandler: undefined as WindowDouble["webContents"]["openHandler"],
        setWindowOpenHandler: (handler: WindowDouble["webContents"]["openHandler"]): void => {
          contents.openHandler = handler;
        },
      });
      this.webContents = contents;
      mocks.windows.push(this);
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    shell: { openExternal: mocks.openExternal },
    contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
    ipcRenderer: { sendSync: mocks.sendSync },
  };
});

const origin = "https://computer.example.test:8443";
const token = "synthetic-remote-session";
const workspaceUrls = new Map<number, string>();
const workspaceKinds = new Map<number, "ssh" | "paired">();
const handles: RemoteComputerWorkspace[] = [];
function fixture(options: { signal?: AbortSignal; kind?: "ssh" | "paired" } = {}) {
  const onClosed = vi.fn();
  const handle = openRemoteComputerWorkspace(
    {
      id: "same-connection",
      name: "Fixture computer",
      origin,
      token,
      onClosed,
      kind: options.kind ?? "paired",
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      preloadPath: "C:/synthetic/build/sshWorkspacePreload.js",
      confirmExternalLink: mocks.confirmExternalLink,
      icon: "C:/synthetic/moss.ico",
      workspaceUrls,
      workspaceKinds,
    },
  );
  // Closing an unready window rejects readiness; observe immediately even in
  // tests that deliberately wait before asserting its final rejection.
  void handle.ready.catch(() => undefined);
  handles.push(handle);
  return { handle, window: mocks.windows.at(-1)!, onClosed };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.windows.length = 0;
  mocks.deferClosed = false;
  mocks.nextId = 100;
  mocks.openExternal.mockClear();
  mocks.confirmExternalLink.mockReset();
  mocks.confirmExternalLink.mockResolvedValue(true);
  workspaceUrls.clear();
  workspaceKinds.clear();
});
afterEach(async () => {
  mocks.deferClosed = false;
  for (const handle of handles.splice(0)) handle.close();
  for (const window of mocks.windows) window.emit("closed");
  await Promise.resolve();
  vi.useRealTimers();
});

type PermissionRequestHandler = (
  contents: { id: number } | null,
  permission: string,
  callback: (granted: boolean) => void,
  details: { isMainFrame?: boolean; requestingUrl?: string },
) => void;
type PermissionCheckHandler = (
  contents: { id: number } | null,
  permission: string,
  requestingOrigin: string,
  details: { isMainFrame?: boolean; requestingUrl?: string },
) => boolean;

describe("remote workspace permissions", () => {
  const request = (window: WindowDouble, permission: string, details = {}, contentsId?: number) => {
    const handler = window.webContents.session.setPermissionRequestHandler.mock
      .calls[0]![0] as PermissionRequestHandler;
    const callback = vi.fn();
    handler({ id: contentsId ?? window.webContents.id }, permission, callback, {
      isMainFrame: true,
      requestingUrl: `${origin}/`,
      ...details,
    });
    return callback.mock.calls[0]![0] as boolean;
  };

  it("installs deny-by-default handlers before the remote page loads", () => {
    const f = fixture();
    const permissionSession = f.window.webContents.session;
    expect(permissionSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(permissionSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(permissionSession.setDevicePermissionHandler).toHaveBeenCalledTimes(1);
    const installOrder = permissionSession.setPermissionRequestHandler.mock.invocationCallOrder[0]!;
    expect(installOrder).toBeLessThan(f.window.loadURL.mock.invocationCallOrder[0]!);
    const device = permissionSession.setDevicePermissionHandler.mock.calls[0]![0] as () => boolean;
    expect(device()).toBe(false);
  });

  it.each([
    "media",
    "clipboard-read",
    "geolocation",
    "notifications",
    "display-capture",
    "openExternal",
    "pointerLock",
    "midiSysex",
  ])("denies %s to remote content", (permission) => {
    const f = fixture();
    expect(request(f.window, permission)).toBe(false);
    const check = f.window.webContents.session.setPermissionCheckHandler.mock
      .calls[0]![0] as PermissionCheckHandler;
    expect(check({ id: f.window.webContents.id }, permission, origin, { isMainFrame: true })).toBe(
      false,
    );
  });

  it("keeps copy buttons working only for the workspace's own top-level origin", () => {
    const f = fixture({ kind: "ssh" });
    expect(request(f.window, "clipboard-sanitized-write")).toBe(true);
    expect(
      request(f.window, "clipboard-sanitized-write", { requestingUrl: "https://other.test/" }),
    ).toBe(false);
    expect(request(f.window, "clipboard-sanitized-write", { isMainFrame: false })).toBe(false);
    expect(request(f.window, "clipboard-sanitized-write", {}, f.window.webContents.id + 1000)).toBe(
      false,
    );
    const check = f.window.webContents.session.setPermissionCheckHandler.mock
      .calls[0]![0] as PermissionCheckHandler;
    expect(
      check({ id: f.window.webContents.id }, "clipboard-sanitized-write", origin, {
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      check({ id: f.window.webContents.id }, "clipboard-sanitized-write", "https://other.test", {
        isMainFrame: true,
      }),
    ).toBe(false);
  });

  it("rejects malformed requesting origins", () => {
    expect(
      remoteWorkspacePermissionAllowed(origin, "clipboard-sanitized-write", {}, "not a url"),
    ).toBe(false);
  });
});

describe("remote workspace external links", () => {
  it("opens nothing when the person declines", async () => {
    mocks.confirmExternalLink.mockResolvedValue(false);
    const f = fixture();
    expect(f.window.webContents.openHandler!({ url: "https://phish.example.test/" })).toEqual({
      action: "deny",
    });
    await vi.waitFor(() => expect(mocks.confirmExternalLink).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("never stacks prompts: links requested while one is open are dropped", async () => {
    let answer!: (open: boolean) => void;
    mocks.confirmExternalLink.mockImplementation(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const f = fixture();
    for (let index = 0; index < 5; index++)
      f.window.webContents.openHandler!({ url: `https://spam.example.test/${index}` });
    expect(mocks.confirmExternalLink).toHaveBeenCalledTimes(1);
    answer(true);
    await vi.waitFor(() => expect(mocks.openExternal).toHaveBeenCalledTimes(1));
    expect(mocks.openExternal).toHaveBeenCalledWith("https://spam.example.test/0");
    f.window.webContents.openHandler!({ url: "https://docs.example.test/next" });
    expect(mocks.confirmExternalLink).toHaveBeenCalledTimes(2);
  });

  it("does not open an approved link after the workspace closed", async () => {
    let answer!: (open: boolean) => void;
    mocks.confirmExternalLink.mockImplementation(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const f = fixture();
    f.window.webContents.openHandler!({ url: "https://docs.example.test/" });
    f.handle.close();
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});

describe("remote workspace Electron lifecycle", () => {
  it.each(["ssh", "paired"] as const)(
    "tells the %s window its own kind and forgets it on close",
    (kind) => {
      const f = fixture({ kind });
      expect(workspaceKinds.get(f.window.webContents.id)).toBe(kind);
      f.handle.close();
      expect(workspaceKinds.has(f.window.webContents.id)).toBe(false);
    },
  );
  it("does not construct or load a pre-cancelled workspace", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => fixture({ signal: controller.signal })).toThrow("cancelled");
    expect(mocks.windows).toHaveLength(0);
    expect(workspaceUrls.size).toBe(0);
  });

  it("immediately closes a pending load on cancel and ignores a late ready-to-show/load completion", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    expect(f.window.show).not.toHaveBeenCalled();
    controller.abort();
    expect(f.window.destroy).toHaveBeenCalledTimes(1);
    expect(f.onClosed).toHaveBeenCalledTimes(1);
    expect(f.onClosed).toHaveBeenCalledWith();
    expect(workspaceUrls.size).toBe(0);
    expect(f.window.webContents.session.headerListener).toBeNull();
    expect(f.window.webContents.session.clearStorageData).toHaveBeenCalledTimes(1);
    await expect(f.handle.ready).rejects.toThrow("cancelled");
    f.window.emit("ready-to-show");
    f.window.load.resolve();
    await Promise.resolve();
    expect(f.window.show).not.toHaveBeenCalled();
    expect(workspaceUrls.size).toBe(0);
  });

  it("destroys a painted but unfinished load immediately when cancelled", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    f.window.emit("ready-to-show");
    expect(f.window.show).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(f.window.destroy).toHaveBeenCalledTimes(1);
    await expect(f.handle.ready).rejects.toThrow("cancelled");
    expect(workspaceUrls.size).toBe(0);
  });

  it("keeps a replacement window's registry and headers when the old closed event arrives late", async () => {
    mocks.deferClosed = true;
    const old = fixture();
    old.handle.close();
    const current = fixture();
    old.window.emit("closed");
    old.window.emit("ready-to-show");
    old.window.load.resolve();
    await expect(old.handle.ready).rejects.toThrow("connection-failed");
    expect(old.window.show).not.toHaveBeenCalled();
    expect(workspaceUrls.has(old.window.webContents.id)).toBe(false);
    expect(workspaceUrls.get(current.window.webContents.id)).toBe(
      "wss://computer.example.test:8443/",
    );
    expect(old.window.webContents.session.headerListener).toBeNull();
    expect(current.window.webContents.session.headerListener).not.toBeNull();
    expect(current.onClosed).not.toHaveBeenCalled();
    current.window.emit("ready-to-show");
    current.window.load.resolve();
    await current.handle.ready;
    expect(current.window.show).toHaveBeenCalledTimes(1);
  });

  it("cleans the registry, auth hook and private session on load failure without exposing the error", async () => {
    const f = fixture();
    f.window.load.reject(new Error(`untrusted failure ${token}`));
    await expect(f.handle.ready).rejects.toThrow(/^connection-failed$/u);
    expect(f.window.destroy).toHaveBeenCalledTimes(1);
    expect(f.window.show).not.toHaveBeenCalled();
    expect(workspaceUrls.size).toBe(0);
    expect(f.window.webContents.session.webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith(
      null,
    );
    expect(f.window.webContents.session.clearStorageData).toHaveBeenCalledTimes(1);
    f.window.emit("closed");
    expect(f.onClosed).toHaveBeenCalledTimes(1);
    expect(f.onClosed).toHaveBeenCalledWith("workspace-load");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unfinished load and cleans up when its window closes before loading", async () => {
    const timedOut = fixture();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(timedOut.handle.ready).rejects.toThrow("connection-failed");
    expect(timedOut.window.destroy).toHaveBeenCalledTimes(1);
    expect(timedOut.onClosed).toHaveBeenCalledWith("workspace-load");
    const closed = fixture();
    closed.handle.close();
    await expect(closed.handle.ready).rejects.toThrow("connection-failed");
    expect(closed.onClosed).toHaveBeenCalledWith();
    expect(workspaceUrls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not relabel a deliberate close when its pending load rejects late", async () => {
    mocks.deferClosed = true;
    const f = fixture();
    f.handle.close();
    f.window.load.reject(new Error("load aborted by destroy"));
    await Promise.resolve();
    f.window.emit("closed");
    await expect(f.handle.ready).rejects.toThrow("connection-failed");
    expect(f.onClosed).toHaveBeenCalledTimes(1);
    expect(f.onClosed).toHaveBeenCalledWith();
  });

  it("injects a main-only credential into exact-origin HTTP/WebSocket headers", async () => {
    const f = fixture();
    const session = f.window.webContents.session;
    expect(session.filter).toEqual({ urls: [`${origin}/*`, "wss://computer.example.test:8443/*"] });
    const headersFor = (url: string, headers: Record<string, string> = {}) => {
      let result: Record<string, string> = {};
      session.headerListener!({ url, requestHeaders: headers }, (value) => {
        result = value.requestHeaders;
      });
      return result;
    };
    expect(
      headersFor(`${origin}/api/auth/session`, {
        authorization: "old",
        Accept: "application/json",
      }),
    ).toEqual({ Accept: "application/json", Authorization: `Bearer ${token}` });
    expect(headersFor("wss://computer.example.test:8443/ws")).toEqual({
      Authorization: `Bearer ${token}`,
    });
    for (const url of [
      "https://other.example.test/",
      "http://computer.example.test:8443/",
      "wss://computer.example.test:8444/ws",
    ])
      expect(headersFor(url)).toEqual({});
    expect([...workspaceUrls.values()].join()).not.toContain(token);
    expect(JSON.stringify(f.window.loadURL.mock.calls)).not.toContain(token);
    expect(JSON.stringify(f.window.options)).not.toContain(token);
    f.window.load.resolve();
    await f.handle.ready;
  });

  it.each(["will-navigate", "will-redirect"])(
    "blocks foreign and invalid %s destinations",
    (event) => {
      const f = fixture();
      for (const url of [
        "https://other.example.test/",
        "http://computer.example.test:8443/",
        "not a URL",
      ]) {
        const preventDefault = vi.fn();
        f.window.webContents.emit(event, { preventDefault }, url);
        expect(preventDefault).toHaveBeenCalledTimes(1);
      }
      const preventDefault = vi.fn();
      f.window.webContents.emit(event, { preventDefault }, `${origin}/settings`);
      expect(preventDefault).not.toHaveBeenCalled();
    },
  );

  it.each(["ssh", "paired"] as const)(
    "uses a unique ephemeral sandbox and narrow preload for %s",
    async (kind) => {
      const f = fixture({ kind });
      expect(f.window.options.show).toBe(false);
      expect(f.window.options.webPreferences).toMatchObject({
        preload: "C:/synthetic/build/sshWorkspacePreload.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      });
      expect(f.window.options.webPreferences?.partition).toMatch(
        new RegExp(`^moss-${kind}-same-connection-`),
      );
      expect(f.window.options.webPreferences?.partition).not.toMatch(/^persist:/u);
      const another = fixture({ kind });
      expect(another.window.options.webPreferences?.partition).not.toBe(
        f.window.options.webPreferences?.partition,
      );
      expect(f.window.loadURL).toHaveBeenCalledWith(
        kind === "paired" ? `${origin}/#/settings?section=computer&connectionTab=this` : origin,
      );
      expect(f.window.webContents.openHandler!({ url: "file:///private" })).toEqual({
        action: "deny",
      });
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(f.window.webContents.openHandler!({ url: "https://docs.example.test/" })).toEqual({
        action: "deny",
      });
      expect(mocks.confirmExternalLink).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Fixture computer", url: "https://docs.example.test/" }),
      );
      await vi.waitFor(() =>
        expect(mocks.openExternal).toHaveBeenCalledWith("https://docs.example.test/"),
      );
      f.window.load.resolve();
      await f.handle.ready;
    },
  );

  it("runs the actual preload with only a credential-free transport getter", async () => {
    await import("./sshWorkspacePreload");
    expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [name, exposed] = mocks.exposeInMainWorld.mock.calls[0]!;
    expect(name).toBe("mossRemoteWorkspace");
    // Only the transport URL and the window's kind ("ssh" or "paired"): no credential,
    // file, settings or desktop control crosses into remote content.
    expect(Object.keys(exposed)).toEqual(["getWsUrl", "getKind"]);
    expect(exposed.getWsUrl()).toBe("wss://computer.example.test/");
    expect(mocks.sendSync).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.ssh.workspaceUrl);
    exposed.getKind();
    expect(mocks.sendSync).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.ssh.workspaceKind);
  });
});
