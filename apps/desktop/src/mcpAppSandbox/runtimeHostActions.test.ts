import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setUserAgent: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    on: vi.fn(),
    removeListener: vi.fn(),
    getUserAgent: vi.fn(() => "Mozilla/5.0"),
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/downloads" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: electronMocks.ipcMain,
  session: { fromPartition: electronMocks.fromPartition },
  shell: { openExternal: vi.fn() },
}));

import type { McpAppSandboxDescriptor } from "@moss/contracts";

import { McpAppSandboxRuntime } from "./runtime";

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  callId: "call-host-1",
  containerDimensions: { height: 240, width: 640 },
  csp: {
    baseUriDomains: [],
    connectDomains: ["https://api.example.test"],
    frameDomains: [] as string[],
    includeDefaultDomains: false,
    isTrusted: true,
    resourceDomains: ["https://cdn.example.test"],
  },
  generation: 0,
  isCollapsible: true,
  prefersBorder: true,
  resourceUri: "ui://widget/host",
  server: "server-host",
  theme: "light",
  threadId: "thread-host-1",
  ...overrides,
});

function owner(id: number) {
  return {
    webContents: { id, once: vi.fn(), isDestroyed: () => false, postMessage: vi.fn() },
  } as never;
}

let nextGuestId = 100;

function guest(url: string) {
  const value = new EventEmitter() as EventEmitter & Record<string, unknown>;
  value.id = nextGuestId++;
  value.getURL = () => url;
  value.isDestroyed = () => false;
  value.postMessage = vi.fn();
  value.setWindowOpenHandler = vi.fn();
  value.setWebRTCIPHandlingPolicy = vi.fn();
  value.close = vi.fn();
  value.session = electronMocks.partitionSession;
  return value as unknown as EventEmitter & { id: number };
}

function mount(runtime: McpAppSandboxRuntime, descriptor: McpAppSandboxDescriptor) {
  runtime.handleWillAttachWebview(
    1,
    { preventDefault: vi.fn() },
    {},
    { partition: descriptor.partition, src: descriptor.src },
    "/mcpSandboxPreload.js",
  );
  const candidate = guest(descriptor.src);
  runtime.handleDidAttachWebview(1, candidate as never);
  return candidate;
}

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown,
) => void;
type CheckHandler = (
  webContents: unknown,
  permission: string,
  origin: string,
  details: unknown,
) => boolean;

function lastHandler<T>(mock: ReturnType<typeof vi.fn>): T {
  return mock.mock.calls.at(-1)?.[0] as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.fromPartition.mockReturnValue(electronMocks.partitionSession);
});

describe("MCP App sandbox network policy", () => {
  it("enforces the effective lists for requests that reach the network", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(1, baseInput());
    if (!descriptor) throw new Error("registration failed");
    const candidate = mount(runtime, descriptor);
    const handler = electronMocks.partitionSession.webRequest.onBeforeRequest.mock.calls.at(
      -1,
    )?.[1] as (
      details: { url: string; resourceType: string; webContentsId: number },
      callback: (response: { cancel: boolean }) => void,
    ) => void;
    const allowed = (url: string, resourceType: string, webContentsId = candidate.id) => {
      let cancel = true;
      handler({ url, resourceType, webContentsId }, (response) => {
        cancel = response.cancel;
      });
      return !cancel;
    };
    expect(allowed(descriptor.src.split("#", 1)[0]!, "mainFrame")).toBe(true);
    expect(allowed("https://api.example.test/data", "fetch")).toBe(true);
    expect(allowed("https://cdn.example.test/data", "fetch")).toBe(false);
    expect(allowed("https://cdn.example.test/app.js", "script")).toBe(true);
    expect(allowed("https://api.example.test/app.js", "script")).toBe(false);
    expect(allowed("moss-mcp-sandbox://assets/fonts/inter-latin.woff2", "font")).toBe(true);
    expect(allowed(descriptor.src, "xhr")).toBe(false);
    expect(allowed("https://evil.example.test/", "subFrame")).toBe(false);
    expect(allowed("https://api.example.test/data", "fetch", 999)).toBe(false);
  });
});

describe("MCP App sandbox device permissions", () => {
  it("grants only what was declared and approved for the partition", () => {
    const decisions: string[] = [];
    const runtime = new McpAppSandboxRuntime({
      onPermissionDecision: (event) =>
        decisions.push(
          `${event.kind}:${event.permission}:${event.mediaTypes.join("+")}:${String(event.granted)}`,
        ),
    });
    runtime.attachOwner(owner(1));
    runtime.attachOwner(owner(2));
    const descriptor = runtime.register(
      1,
      baseInput({ permissions: { camera: {}, geolocation: true } }),
    );
    if (!descriptor) throw new Error("registration failed");
    const candidate = mount(runtime, descriptor);
    const requestHandler = lastHandler<RequestHandler>(
      electronMocks.partitionSession.setPermissionRequestHandler,
    );
    const checkHandler = lastHandler<CheckHandler>(
      electronMocks.partitionSession.setPermissionCheckHandler,
    );
    const request = (
      permission: string,
      mediaTypes?: string[],
      webContents: unknown = candidate,
    ) => {
      let granted: boolean | null = null;
      requestHandler(webContents, permission, (value) => (granted = value), { mediaTypes });
      return granted;
    };

    expect(request("media", ["video"])).toBe(false);
    expect(checkHandler(candidate, "media", "null", { mediaType: "video" })).toBe(false);

    // Another owner, an unknown sandbox and malformed input grant nothing.
    expect(runtime.requestPermissions(2, descriptor.sandboxId, { camera: true })).toEqual({
      granted: {},
    });
    expect(
      runtime.requestPermissions(1, "0123456789abcdef0123456789abcdef", { camera: true }),
    ).toEqual({ granted: {} });
    expect(runtime.requestPermissions(1, descriptor.sandboxId, { usb: true })).toEqual({
      granted: {},
    });
    expect(runtime.requestPermissions(1, 42, { camera: true })).toEqual({ granted: {} });

    expect(
      runtime.requestPermissions(1, descriptor.sandboxId, { camera: true, microphone: true }),
    ).toEqual({ granted: { camera: true } });
    expect(request("media", ["video"])).toBe(true);
    expect(request("media", ["video", "audio"])).toBe(false);
    expect(request("geolocation")).toBe(false);
    expect(request("notifications")).toBe(false);
    expect(request("media", ["video"], guest("other"))).toBe(false);
    expect(checkHandler(candidate, "media", "null", { mediaType: "video" })).toBe(true);
    expect(checkHandler(candidate, "media", "null", { mediaType: "audio" })).toBe(false);

    // Exactly the approved set: a later, different grant replaces the first.
    expect(runtime.requestPermissions(1, descriptor.sandboxId, { geolocation: true })).toEqual({
      granted: { geolocation: true },
    });
    expect(request("media", ["video"])).toBe(false);
    expect(request("geolocation")).toBe(true);
    expect(decisions).toContain("request:media:video:true");
    expect(electronMocks.partitionSession.setDevicePermissionHandler).toHaveBeenCalled();
    expect(electronMocks.partitionSession.setDisplayMediaRequestHandler).toHaveBeenCalled();
  });

  it("withholds device permissions from a widget that frames other sites", () => {
    const runtime = new McpAppSandboxRuntime();
    runtime.attachOwner(owner(1));
    const descriptor = runtime.register(
      1,
      baseInput({
        permissions: { camera: {} },
        csp: { ...baseInput().csp, frameDomains: ["https://maps.example.com"] },
      }),
    );
    if (!descriptor) throw new Error("registration failed");
    const candidate = mount(runtime, descriptor);
    expect(runtime.requestPermissions(1, descriptor.sandboxId, { camera: true })).toEqual({
      granted: {},
    });
    const requestHandler = lastHandler<RequestHandler>(
      electronMocks.partitionSession.setPermissionRequestHandler,
    );
    let granted: boolean | null = null;
    requestHandler(candidate, "media", (value) => (granted = value), { mediaTypes: ["video"] });
    expect(granted).toBe(false);
  });
});

describe("MCP App host actions", () => {
  it("opens only allowed external schemes, and only for a trusted owner", async () => {
    const opened: string[] = [];
    const runtime = new McpAppSandboxRuntime({
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    runtime.attachOwner(owner(1));
    expect(await runtime.openExternal(1, "https://example.com/a")).toEqual({ opened: true });
    expect(await runtime.openExternal(1, "mailto:a@example.com")).toEqual({ opened: true });
    expect(await runtime.openExternal(1, "javascript:alert(1)")).toEqual({ opened: false });
    expect(await runtime.openExternal(1, "file:///C:/x.exe")).toEqual({ opened: false });
    expect(await runtime.openExternal(7, "https://example.com/b")).toEqual({ opened: false });
    expect(opened).toEqual(["https://example.com/a", "mailto:a@example.com"]);

    const failing = new McpAppSandboxRuntime({
      openExternal: async () => {
        throw new Error("no handler");
      },
    });
    failing.attachOwner(owner(1));
    expect(await failing.openExternal(1, "tel:+1")).toEqual({ opened: false });
  });

  it("saves a download through the save dialog with a sanitised default name", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-mcp-download-"));
    try {
      const dialogCalls: string[] = [];
      let answer: { canceled: boolean; filePath?: string } = {
        canceled: false,
        filePath: join(directory, "saved.txt"),
      };
      const runtime = new McpAppSandboxRuntime({
        downloadsPath: () => directory,
        showSaveDialog: async (_window, options) => {
          dialogCalls.push(String(options.defaultPath));
          return answer as never;
        },
      });
      runtime.attachOwner(owner(1));
      const text = { fileName: "../../report.txt", mimeType: "text/plain", text: "你好" };
      expect(await runtime.saveDownload(1, text)).toEqual({ saved: true });
      expect(dialogCalls).toEqual([join(directory, "report.txt")]);
      expect(readFileSync(join(directory, "saved.txt"), "utf8")).toBe("你好");

      const binary = { fileName: "a.bin", mimeType: "application/octet-stream", base64: "AAEC" };
      expect(await runtime.saveDownload(1, binary)).toEqual({ saved: true });
      expect([...readFileSync(join(directory, "saved.txt"))]).toEqual([0, 1, 2]);

      answer = { canceled: true };
      const plain = { fileName: "a.txt", mimeType: "text/plain", text: "x" };
      expect(await runtime.saveDownload(1, plain)).toEqual({ saved: false });
      for (const invalid of [
        { fileName: "a.txt", mimeType: "text/plain" },
        { fileName: "a.txt", mimeType: "text/plain", text: "x", base64: "AA==" },
        { fileName: "a.txt", mimeType: "text/plain", base64: "not base64!" },
        { fileName: "", mimeType: "text/plain", text: "x" },
        { fileName: "a.txt", mimeType: "text/plain", text: "x", extra: 1 },
      ]) {
        expect(await runtime.saveDownload(1, invalid)).toEqual({ saved: false });
      }
      expect(await runtime.saveDownload(9, plain)).toEqual({ saved: false });
      expect(dialogCalls).toHaveLength(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
