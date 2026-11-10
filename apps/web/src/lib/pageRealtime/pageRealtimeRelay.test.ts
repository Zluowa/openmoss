import type { PagesRealtimeTokenResult } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageRealtimeRelay, type PageRealtimeSocket } from "./pageRealtimeRelay";

class FakeSocket implements PageRealtimeSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  sent: unknown[] = [];
  closed: number | null = null;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {}
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closed = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  message(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

const ticket = (token: string): PagesRealtimeTokenResult =>
  ({
    pageId: "page-1",
    token,
    expiresAt: "2026-11-04T00:01:00.000Z",
    mode: "edit",
    generation: "gen-1",
    revision: 3,
    wsPath: "/ws/pages-realtime",
  }) as PagesRealtimeTokenResult;

function setup(requestToken = vi.fn(async () => ticket(`t${requestToken.mock.calls.length}`))) {
  const sockets: FakeSocket[] = [];
  const links: string[] = [];
  const frames: unknown[] = [];
  const relay = new PageRealtimeRelay({
    target: { pageId: "page-1" as never, scopeSpaceId: null },
    requestToken,
    onTicket: async () => {},
    onFrame: (frame) => frames.push(frame),
    onLink: (link) => links.push(link),
    socketUrl: (path) => `ws://127.0.0.1:6040${path}?token=legacy`,
    createSocket: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
  });
  return { relay, sockets, links, frames, requestToken };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PageRealtimeRelay", () => {
  it("opens the room with a ticket and the page subprotocol, keeping the legacy credential", async () => {
    const { relay, sockets, links } = setup();
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    const url = new URL(sockets[0]!.url);
    expect(url.pathname).toBe("/ws/pages-realtime");
    expect(url.searchParams.get("ticket")).toBe("t1");
    expect(url.searchParams.get("token")).toBe("legacy");
    expect(url.searchParams.get("pageId")).toBe("page-1");
    expect(sockets[0]!.protocol).toBe("moss-page-room.page-1");
    expect(sockets[0]!.binaryType).toBe("arraybuffer");
    sockets[0]!.open();
    expect(links).toEqual(["connecting", "online"]);
    relay.stop();
  });

  it("relays frames both ways only while open", async () => {
    const { relay, sockets, frames } = setup();
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    relay.send(new Uint8Array([1, 2]));
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    relay.send(new Uint8Array([1, 2]));
    expect(new Uint8Array(sockets[0]!.sent[0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
    const buffer = new Uint8Array([9]).buffer;
    sockets[0]!.message(buffer);
    sockets[0]!.message('{"type":"saved"}');
    expect(frames).toEqual([buffer, '{"type":"saved"}']);
    relay.stop();
  });

  it("goes offline on a drop and reconnects with a fresh ticket", async () => {
    const { relay, sockets, links, requestToken } = setup();
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(links.at(-1)).toBe("offline");
    await vi.advanceTimersByTimeAsync(600);
    expect(requestToken).toHaveBeenCalledTimes(2);
    // A retry does not flip the page back to "connecting".
    expect(links.at(-1)).toBe("offline");
    sockets[1]!.open();
    expect(links.at(-1)).toBe("online");
    expect(new URL(sockets[1]!.url).searchParams.get("ticket")).toBe("t2");
    relay.stop();
  });

  it("reports offline when the ticket request hangs because the server is gone", async () => {
    const hanging = vi.fn(() => new Promise<PagesRealtimeTokenResult>(() => {}));
    const { relay, links } = setup(hanging);
    relay.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(links).toEqual(["connecting", "offline"]);
    await vi.advanceTimersByTimeAsync(600);
    expect(hanging).toHaveBeenCalledTimes(2);
    relay.stop();
  });

  it("stops retrying after the room rejects this window", async () => {
    const { relay, sockets, links, requestToken } = setup();
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.message('{"type":"rejected","reason":"页面已移到回收站。"}');
    sockets[0]!.drop(4403);
    expect(links.at(-1)).toBe("rejected");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestToken).toHaveBeenCalledTimes(1);
    relay.stop();
  });
});
