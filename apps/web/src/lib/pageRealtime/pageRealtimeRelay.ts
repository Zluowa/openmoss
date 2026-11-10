// FILE: pageRealtimeRelay.ts
// Purpose: The Moss page's half of live co-editing: fetches a room ticket, keeps one WebSocket to
//          the Page's room open (reconnecting with backoff) and relays frames to the editor.
// Layer: Web page realtime (collab)
// Why: The editor runs in an iframe whose CSP only reaches loopback sockets, and the parent owns
//      identity and authorization. So the parent holds the socket and forwards bytes it never
//      parses; the editor's Yjs replica does the protocol. A second device reaches the same room
//      through the server it is paired with, because the socket URL is built like the RPC one.

import {
  PAGES_REALTIME_SUBPROTOCOL_PREFIX,
  type PagesRealtimeTokenInput,
  type PagesRealtimeTokenResult,
} from "@moss/contracts";

import { makeSocketUrl } from "../../wsTransport";

export type PageRealtimeLink = "connecting" | "online" | "offline" | "rejected";
export type PageRealtimeFrame = ArrayBuffer | string;

export interface PageRealtimeSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface PageRealtimeRelayOptions {
  readonly target: PagesRealtimeTokenInput;
  readonly requestToken: (input: PagesRealtimeTokenInput) => Promise<PagesRealtimeTokenResult>;
  /** Called with each ticket before its socket opens, so the editor can load the matching
   * document generation first. Resolve once the editor is ready for frames. */
  readonly onTicket: (ticket: PagesRealtimeTokenResult) => Promise<void> | void;
  readonly onFrame: (frame: PageRealtimeFrame) => void;
  readonly onLink: (link: PageRealtimeLink, reason?: string) => void;
  readonly createSocket?: (url: string, protocol: string) => PageRealtimeSocket;
  readonly socketUrl?: (wsPath: string) => string;
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
/** A ticket request rides the RPC socket, which waits rather than fails while the server is gone. */
const TICKET_TIMEOUT_MS = 10_000;
/** Close codes the room uses for decisions a retry cannot change. */
const FINAL_CLOSE = new Set([4403, 4409]);

export class PageRealtimeRelay {
  private socket: PageRealtimeSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private generation = 0;

  constructor(private readonly options: PageRealtimeRelayOptions) {}

  start = () => {
    this.stopped = false;
    void this.connect();
  };

  /** Reconnects now, for example after the user asks to retry or the room was rebuilt. */
  restart = () => {
    this.closeSocket();
    this.attempt = 0;
    clearTimeout(this.timer);
    if (!this.stopped) void this.connect();
  };

  stop = () => {
    this.stopped = true;
    clearTimeout(this.timer);
    this.closeSocket();
  };

  send = (frame: PageRealtimeFrame | Uint8Array) => {
    const data = frame instanceof Uint8Array ? (frame.slice().buffer as ArrayBuffer) : frame;
    // Dropping is safe: the editor only sends while it believes it is online, and its next sync
    // handshake resends whatever fell into the gap before it heard the socket close.
    if (this.socket && this.socket.readyState === 1) this.socket.send(data);
  };

  private closeSocket() {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onclose = socket.onmessage = socket.onerror = null;
      try {
        socket.close(1000, "closed");
      } catch {
        /* Already closed. */
      }
    }
  }

  private async connect() {
    const generation = ++this.generation;
    // Retries keep the offline state, so the page says offline instead of flickering.
    if (this.attempt === 0) this.options.onLink("connecting");
    let ticket: PagesRealtimeTokenResult;
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      ticket = await Promise.race([
        this.options.requestToken(this.options.target),
        new Promise<never>((_, reject) => {
          timeout = (this.options.setTimer ?? setTimeout)(
            () => reject(new Error("timeout")),
            TICKET_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (generation !== this.generation || this.stopped) return;
      await this.options.onTicket(ticket);
    } catch (cause) {
      if (generation !== this.generation || this.stopped) return;
      const message = cause instanceof Error ? cause.message : "";
      if (/forbidden|not-found|not found|unavailable/iu.test(message) && this.attempt > 2) {
        this.options.onLink("rejected", message.slice(0, 200));
        return;
      }
      this.options.onLink("offline");
      this.retry();
      return;
    }
    if (generation !== this.generation || this.stopped) return;
    const base = (this.options.socketUrl ?? ((path) => makeSocketUrl(null, path)))(ticket.wsPath);
    const url = new URL(base);
    url.searchParams.set("pageId", ticket.pageId);
    url.searchParams.set("ticket", ticket.token);
    const protocol = `${PAGES_REALTIME_SUBPROTOCOL_PREFIX}${ticket.pageId}`;
    const socket: PageRealtimeSocket = (
      this.options.createSocket ??
      ((target, name) => new WebSocket(target, name) as unknown as PageRealtimeSocket)
    )(url.toString(), protocol);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let rejected: string | null = null;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.attempt = 0;
      this.options.onLink("online");
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      const data = event.data as unknown;
      if (typeof data === "string") {
        if (data.includes('"rejected"')) {
          try {
            const value = JSON.parse(data) as { type?: string; reason?: string };
            if (value.type === "rejected") rejected = String(value.reason ?? "").slice(0, 200);
          } catch {
            /* Pass malformed text through to the editor, which ignores it. */
          }
        }
        this.options.onFrame(data);
      } else if (data instanceof ArrayBuffer) this.options.onFrame(data);
    };
    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.socket = null;
      if (rejected !== null && FINAL_CLOSE.has(event.code)) {
        this.options.onLink("rejected", rejected);
        return;
      }
      this.options.onLink("offline");
      this.retry();
    };
    socket.onerror = () => {
      /* onclose follows and decides. */
    };
  }

  private retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = (this.options.setTimer ?? setTimeout)(() => void this.connect(), delay);
  }
}
