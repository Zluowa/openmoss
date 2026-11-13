// FILE: designRoom.ts
// Purpose: The browser half of a live 设计 room: joins `/ws/design-room`, sends this window's
//          edits as design ops, keeps the server's confirmed canvas plus this window's pending
//          ops on top (so everyone converges on the server's order), and relays presence.
// Layer: 资料空间 设计 (web)
// Why: Several windows, devices and people edit one design at once. The
//      server applies ops in one order; each window shows that order with its own unconfirmed
//      edits replayed on top, and drops an edit that no longer fits (someone deleted its target).

import {
  applyDesignOpsLeniently,
  diffDesignCanvas,
  parseDesignCanvas,
  type DesignCanvas,
  type DesignOp,
} from "@moss/shared/spaceItems/designCanvas";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

export const DESIGN_ROOM_PATH = "/ws/design-room";

export interface DesignPresence {
  /** The page this person is looking at. */
  readonly page: string;
  /** Pointer on the canvas (world coordinates), or null when it left the canvas. */
  readonly cursor: { readonly x: number; readonly y: number } | null;
  /** What they have selected: artboard and note ids, or one artboard's element paths. */
  readonly boards: readonly string[];
  readonly notes: readonly string[];
  readonly element: { readonly boardId: string; readonly paths: readonly string[] } | null;
  /** The world rectangle they see, so others can follow them. */
  readonly view: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface DesignPeer {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly presence: DesignPresence | null;
  readonly readOnly: boolean;
  readonly self: boolean;
}

export type DesignRoomStatus = "connecting" | "live" | "offline";

export interface DesignRoomHandlers {
  /** The canvas this window should show changed because of the room (not this window's edit). */
  readonly onCanvas: (canvas: DesignCanvas, reason: "welcome" | "remote" | "reset") => void;
  readonly onPeers: (peers: readonly DesignPeer[]) => void;
  readonly onStatus: (status: DesignRoomStatus) => void;
  readonly onSaved: (revision: number) => void;
  readonly onRejected: (message: string) => void;
}

const PEER_COLORS = [
  "oklch(0.62 0.19 25)",
  "oklch(0.62 0.16 145)",
  "oklch(0.6 0.16 250)",
  "oklch(0.62 0.18 300)",
  "oklch(0.66 0.16 60)",
  "oklch(0.6 0.12 200)",
  "oklch(0.62 0.18 350)",
] as const;

export function peerColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]!;
}

/** One peer id per window, kept across reloads of the same tab. */
function windowPeerId(): string {
  try {
    const existing = window.sessionStorage.getItem("moss:design-peer");
    if (existing && /^[A-Za-z0-9_-]{8,64}$/u.test(existing)) return existing;
    const id = crypto.randomUUID().replace(/-/gu, "");
    window.sessionStorage.setItem("moss:design-peer", id);
    return id;
  } catch {
    return crypto.randomUUID().replace(/-/gu, "");
  }
}

export function designRoomUrl(pageId: string, scopeSpaceId: string | null, peer: string): string {
  const path = `${DESIGN_ROOM_PATH}?pageId=${encodeURIComponent(pageId)}${
    scopeSpaceId ? `&scope=${encodeURIComponent(scopeSpaceId)}` : ""
  }&peer=${encodeURIComponent(peer)}`;
  return resolveWsHttpUrl(path).replace(/^http/u, "ws");
}

interface Pending {
  readonly id: string;
  readonly ops: readonly DesignOp[];
}

/**
 * Pure state of a room replica, kept apart from the socket so it can be tested: the confirmed
 * canvas (the server's order) and this window's pending ops on top.
 */
export class DesignRoomReplica {
  confirmed: DesignCanvas;
  seq: number;
  pending: Pending[] = [];
  private next = 1;

  constructor(canvas: DesignCanvas, seq: number) {
    this.confirmed = canvas;
    this.seq = seq;
  }

  /** What this window shows: the confirmed canvas with its unconfirmed edits replayed. */
  view(): DesignCanvas {
    let canvas = this.confirmed;
    const kept: Pending[] = [];
    for (const entry of this.pending) {
      const result = applyDesignOpsLeniently(canvas, entry.ops);
      canvas = result.canvas;
      if (result.applied.length) kept.push({ id: entry.id, ops: result.applied });
    }
    this.pending = kept;
    return canvas;
  }

  /** Records this window's edit from `from` to `to`; returns the message to send (or null). */
  local(from: DesignCanvas, to: DesignCanvas): Pending | null {
    const ops = diffDesignCanvas(from, to);
    if (!ops.length) return null;
    const entry = { id: String(this.next++), ops };
    this.pending.push(entry);
    return entry;
  }

  /** Ops the server applied (anyone's, in order). Returns whether the view may have changed. */
  remote(
    seq: number,
    from: string,
    self: string,
    id: string | undefined,
    ops: readonly DesignOp[],
  ) {
    this.seq = seq;
    this.confirmed = applyDesignOpsLeniently(this.confirmed, ops).canvas;
    if (from === self && id !== undefined && this.pending[0]?.id === id) {
      this.pending.shift();
      return false;
    }
    return true;
  }

  /** The server's whole canvas (welcome, a reject, an agent's write). */
  reset(canvas: DesignCanvas, seq: number, keepPending: boolean) {
    this.confirmed = canvas;
    this.seq = seq;
    if (!keepPending) this.pending = [];
  }

  reject(id: string) {
    this.pending = this.pending.filter((entry) => entry.id !== id);
  }
}

/** A live connection to one design's room. Reconnects with a growing pause while open. */
export class DesignRoomClient {
  private socket: WebSocket | null = null;
  private replica: DesignRoomReplica | null = null;
  private shown: DesignCanvas | null = null;
  private self = "";
  private closed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presence: DesignPresence | null = null;
  private peers: DesignPeer[] = [];
  private flushes = new Map<string, (revision: number | null) => void>();
  private flushId = 0;
  readonly peer = windowPeerId();
  status: DesignRoomStatus = "connecting";
  revision: number | null = null;

  constructor(
    private readonly url: (peer: string) => string,
    private readonly identity: () => { name: string; color: string },
    private readonly handlers: DesignRoomHandlers,
  ) {
    this.connect();
  }

  private setStatus(status: DesignRoomStatus) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }

  private connect() {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url(this.peer));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      socket.send(JSON.stringify({ t: "hello", ...this.identity() }));
      if (this.presence) socket.send(JSON.stringify({ t: "presence", presence: this.presence }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.receive(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const resolve of this.flushes.values()) resolve(null);
      this.flushes.clear();
      this.setStatus("offline");
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(15_000, 500 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private publish(canvas: DesignCanvas, reason: "welcome" | "remote" | "reset") {
    if (this.shown && JSON.stringify(this.shown) === JSON.stringify(canvas)) return;
    this.shown = canvas;
    this.handlers.onCanvas(canvas, reason);
  }

  private receive(raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const doc = () => parseDesignCanvas(message.doc);
    switch (message.t) {
      case "welcome": {
        this.self = String(message.self ?? this.peer);
        const canvas = doc();
        // After a reconnect, this window's unconfirmed edits are offered again on top.
        const resend = this.replica?.pending ?? [];
        this.replica = new DesignRoomReplica(canvas, Number(message.seq) || 0);
        this.revision = typeof message.revision === "number" ? message.revision : null;
        this.updatePeers(message.peers);
        this.setStatus("live");
        for (const entry of resend) {
          this.replica.pending.push(entry);
          this.socket?.send(JSON.stringify({ t: "ops", id: entry.id, ops: entry.ops }));
        }
        this.publish(this.replica.view(), "welcome");
        return;
      }
      case "ops": {
        if (!this.replica || !Array.isArray(message.ops)) return;
        const changed = this.replica.remote(
          Number(message.seq) || 0,
          String(message.from ?? ""),
          this.self,
          typeof message.id === "string" ? message.id : undefined,
          message.ops as DesignOp[],
        );
        if (changed) this.publish(this.replica.view(), "remote");
        return;
      }
      case "reject": {
        if (!this.replica) return;
        this.replica.reject(String(message.id ?? ""));
        this.replica.reset(doc(), Number(message.seq) || 0, true);
        this.handlers.onRejected(String(message.message ?? "这个修改没有生效"));
        this.publish(this.replica.view(), "reset");
        return;
      }
      case "doc": {
        if (!this.replica) return;
        this.replica.reset(doc(), Number(message.seq) || 0, false);
        if (typeof message.revision === "number") this.revision = message.revision;
        this.publish(this.replica.view(), "reset");
        return;
      }
      case "peers":
        this.updatePeers(message.peers);
        return;
      case "presence": {
        const id = String(message.id ?? "");
        this.peers = this.peers.map((peer) =>
          peer.id === id
            ? { ...peer, presence: (message.presence ?? null) as DesignPresence }
            : peer,
        );
        this.handlers.onPeers(this.peers);
        return;
      }
      case "saved":
        if (typeof message.revision === "number") {
          this.revision = message.revision;
          this.handlers.onSaved(message.revision);
        }
        return;
      case "flushed": {
        const id = String(message.id ?? "");
        const revision = typeof message.revision === "number" ? message.revision : null;
        if (revision !== null) this.revision = revision;
        this.flushes.get(id)?.(revision);
        this.flushes.delete(id);
        return;
      }
    }
  }

  private updatePeers(raw: unknown) {
    if (!Array.isArray(raw)) return;
    const previous = new Map(this.peers.map((peer) => [peer.id, peer]));
    this.peers = raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      const id = String(value.id ?? "");
      if (!id) return [];
      return [
        {
          id,
          name: String(value.name ?? "Moss 用户"),
          color: typeof value.color === "string" && value.color ? value.color : peerColor(id),
          presence: (value.presence ?? previous.get(id)?.presence ?? null) as DesignPresence | null,
          readOnly: value.readOnly === true,
          self: id === this.self,
        },
      ];
    });
    this.handlers.onPeers(this.peers);
  }

  /** This window changed the canvas from `from` to `to`. */
  edit(from: DesignCanvas, to: DesignCanvas) {
    if (!this.replica) return false;
    const entry = this.replica.local(from, to);
    this.shown = to;
    if (entry) this.socket?.send(JSON.stringify({ t: "ops", id: entry.id, ops: entry.ops }));
    return true;
  }

  /** Shares where this person is and what they selected (at most every 50 ms). */
  setPresence(presence: DesignPresence) {
    this.presence = presence;
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (this.socket?.readyState === WebSocket.OPEN && this.presence)
        this.socket.send(JSON.stringify({ t: "presence", presence: this.presence }));
    }, 50);
  }

  /** Has the server save everything now; resolves with the saved revision (null offline). */
  flush(): Promise<number | null> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = `f${(this.flushId += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id);
        resolve(null);
      }, 10_000);
      this.flushes.set(id, (revision) => {
        clearTimeout(timer);
        resolve(revision);
      });
      socket.send(JSON.stringify({ t: "flush", id }));
    });
  }

  hasPending() {
    return (this.replica?.pending.length ?? 0) > 0;
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "closed");
  }
}
