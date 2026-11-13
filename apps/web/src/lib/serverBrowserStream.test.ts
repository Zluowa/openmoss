import { describe, expect, it, vi } from "vitest";

import {
  canvasPointToPage,
  createServerBrowserStreamClient,
  serverBrowserDownloadUrl,
  type ServerBrowserStreamEvents,
} from "./serverBrowserStream";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: string | ArrayBuffer) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

const events = (): ServerBrowserStreamEvents & Record<string, ReturnType<typeof vi.fn>> =>
  ({
    onFrame: vi.fn(),
    onTabs: vi.fn(),
    onViewport: vi.fn(),
    onControl: vi.fn(),
    onConnectedChange: vi.fn(),
    onUnavailable: vi.fn(),
  }) as never;

describe("canvasPointToPage", () => {
  it("maps through the letterbox into page pixels and rejects points outside the page", () => {
    // A 1280x800 page drawn in a 640x800 box: scale 0.5, 200px bars above and below.
    const box = { width: 640, height: 800 };
    const viewport = { width: 1280, height: 800 };
    expect(canvasPointToPage({ x: 320, y: 400 }, box, viewport)).toEqual({ x: 640, y: 400 });
    expect(canvasPointToPage({ x: 0, y: 200 }, box, viewport)).toEqual({ x: 0, y: 0 });
    expect(canvasPointToPage({ x: 320, y: 100 }, box, viewport)).toBeNull();
    expect(canvasPointToPage({ x: 1, y: 1 }, { width: 0, height: 0 }, viewport)).toBeNull();
  });
});

describe("createServerBrowserStreamClient", () => {
  it("acks every frame and only lets input through once this viewer holds control", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    let socket!: FakeSocket;
    const handlers = events();
    const client = createServerBrowserStreamClient(
      {
        threadId: "thread-1",
        explicitUrl: "ws://127.0.0.1:3773/?token=secret",
        maxWidth: 1280,
        maxHeight: 800,
        createSocket: (url) => {
          socket = new FakeSocket(url);
          return socket as unknown as WebSocket;
        },
      },
      handlers,
    );
    const url = new URL(socket.url);
    expect(url.pathname).toBe("/api/server-browser/ws");
    expect(url.searchParams.get("threadId")).toBe("thread-1");
    socket.open();
    expect(handlers.onConnectedChange).toHaveBeenCalledWith(true);

    // Opening a page needs no tab; other input needs control.
    expect(client.send({ type: "open", url: "example.com" })).toBe(true);
    expect(client.send({ type: "reload" })).toBe(false);

    socket.receive(
      JSON.stringify({ type: "control", canOperate: true, controller: "agent", generation: 1 }),
    );
    expect(client.send({ type: "reload" })).toBe(false);
    expect(client.send({ type: "takeControl" })).toBe(true);

    socket.receive(
      JSON.stringify({ type: "control", canOperate: true, controller: "you", generation: 2 }),
    );
    expect(client.send({ type: "reload" })).toBe(true);

    const frame = new ArrayBuffer(4);
    socket.receive(frame);
    expect(handlers.onFrame).toHaveBeenCalledWith(frame);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "ack" }));

    socket.receive(JSON.stringify({ type: "tabs", tabs: [], selectedTabId: null }));
    expect(handlers.onTabs).toHaveBeenCalledWith([], null);
    client.stop();
    vi.unstubAllGlobals();
  });

  it("stops for good when the server has no browser to offer", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    let socket!: FakeSocket;
    const handlers = events();
    createServerBrowserStreamClient(
      {
        threadId: "thread-2",
        explicitUrl: "ws://127.0.0.1:3773",
        maxWidth: 1,
        maxHeight: 1,
        createSocket: (url) => {
          socket = new FakeSocket(url);
          return socket as unknown as WebSocket;
        },
      },
      handlers,
    );
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 4404 }));
    expect(handlers.onUnavailable).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("presence, reveal and personal messages", () => {
  it("asks for presence only, routes reveal and personal messages, and builds download URLs", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    let socket!: FakeSocket;
    const handlers = { ...events(), onReveal: vi.fn(), onPersonal: vi.fn() };
    const client = createServerBrowserStreamClient(
      {
        threadId: "thread-3",
        explicitUrl: "ws://127.0.0.1:3773",
        maxWidth: 1,
        maxHeight: 1,
        presence: true,
        createSocket: (url) => {
          socket = new FakeSocket(url);
          return socket as unknown as WebSocket;
        },
      },
      handlers,
    );
    expect(new URL(socket.url).searchParams.get("presence")).toBe("true");
    socket.open();
    socket.receive(JSON.stringify({ type: "reveal", tabId: "tab-1" }));
    expect(handlers.onReveal).toHaveBeenCalledWith("tab-1");
    socket.receive(JSON.stringify({ type: "navigationBlocked", host: "169.254.169.254" }));
    expect(handlers.onPersonal).toHaveBeenCalledWith({
      type: "navigationBlocked",
      host: "169.254.169.254",
    });
    socket.receive(
      JSON.stringify({
        type: "download",
        fileName: "a.pdf",
        sizeBytes: 3,
        path: "/x?download=abc",
      }),
    );
    expect(handlers.onPersonal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "download", fileName: "a.pdf" }),
    );
    // Closing a tab needs no control of the watched one.
    expect(client.send({ type: "closeTab", tabId: "tab-1" })).toBe(true);
    client.stop();
    vi.unstubAllGlobals();

    const url = new URL(
      serverBrowserDownloadUrl(
        "/api/server-browser/download?download=abc",
        "wss://moss.example/?token=s",
      ),
    );
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/api/server-browser/download");
    expect(url.searchParams.get("download")).toBe("abc");
    // The connection's own credential rides along, as on the viewer socket.
    expect(url.searchParams.get("token")).toBe("s");
  });
});
