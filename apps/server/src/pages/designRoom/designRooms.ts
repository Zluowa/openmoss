// FILE: designRooms.ts
// Purpose: Live 设计 rooms. Every window, paired device and person with a design open joins one
//          room per design; the room applies their edits as ordered design ops, tells everyone
//          else, carries presence (name, cursor, selection, view) and saves the design back to
//          its item revision a moment after it changes.
// Layer: Server pages. Plain TypeScript; the route adapts sockets and the typed-item service.
// Why: A design canvas is one shared document that several people and Moss edit at once. The
//      same pattern as the 白板 room (load, merge, save 600 ms later, agents flush first), with
//      a protocol made of the design's own ops instead of tldraw records.
//
// Protocol (JSON text frames):
//   client → server  {t:"hello", name, color}
//                    {t:"ops", id, ops}          ops: DesignOp[] against the room's latest state
//                    {t:"presence", presence}    ≤ 4 KB, relayed to the others
//                    {t:"flush", id}             save now; answers {t:"flushed", id, revision}
//   server → client  {t:"welcome", self, seq, revision, doc, peers, readOnly}
//                    {t:"ops", seq, from, id?, ops}   everyone's ops in the order applied
//                    {t:"reject", id, message, seq, doc}
//                    {t:"doc", seq, revision, doc}    replaced from outside (an agent's write)
//                    {t:"peers", peers} · {t:"presence", id, presence} · {t:"saved", revision}

import {
  applyDesignOps,
  DESIGN_LIMITS,
  parseDesignCanvas,
  type DesignCanvas,
  type DesignOp,
} from "@moss/shared/spaceItems/designCanvas";

export interface DesignRoomStore {
  readonly read: (
    pageId: string,
    scope: string | null,
  ) => Promise<{ data: string; revision: number }>;
  /** Saves against `expectedRevision`; throws `{ code: "conflict", currentRevision }` when stale. */
  readonly save: (
    pageId: string,
    scope: string | null,
    data: string,
    expectedRevision: number,
  ) => Promise<number>;
}

export interface DesignRoomSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const SAVE_DELAY_MS = 600;
/** A room stays open this long after the last person leaves, so a quick reload reuses it. */
const IDLE_CLOSE_MS = 30_000;
const MAX_PRESENCE_BYTES = 4_096;
const MAX_PEERS = 50;
/** Per window: op messages and presence updates allowed in any one second. */
const OPS_PER_SECOND = 30;
const PRESENCE_PER_SECOND = 40;
const NAME = /^[^<>]{1,40}$/u;
const COLOR = /^[#(),.%\s\w-]{1,40}$/u;

interface Peer {
  readonly id: string;
  readonly socket: DesignRoomSocket;
  readonly readOnly: boolean;
  name: string;
  color: string;
  presence: unknown;
  /** Recent message times for the rate limits. */
  readonly recent: { ops: number[]; presence: number[] };
}

/** Sliding one-second window; true when one more message fits. */
function admit(times: number[], limit: number, now = Date.now()): boolean {
  while (times.length && now - times[0]! >= 1_000) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

interface LiveRoom {
  readonly pageId: string;
  readonly scope: string | null;
  canvas: DesignCanvas;
  seq: number;
  revision: number;
  /** The design text the room last saved or loaded, so an unchanged room never saves. */
  saved: string;
  readonly peers: Map<string, Peer>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void> | null;
}

const peerView = (peer: Peer) => ({
  id: peer.id,
  name: peer.name,
  color: peer.color,
  presence: peer.presence,
  readOnly: peer.readOnly,
});

function send(peer: Peer, message: unknown) {
  if (peer.socket.readyState !== 1) return;
  try {
    peer.socket.send(JSON.stringify(message));
  } catch {
    // The socket is closing; its close handler removes the peer.
  }
}

export class DesignRooms {
  private readonly rooms = new Map<string, LiveRoom>();
  private readonly opening = new Map<string, Promise<LiveRoom>>();

  constructor(private readonly store: DesignRoomStore) {}

  private async open(pageId: string, scope: string | null): Promise<LiveRoom> {
    const live = this.rooms.get(pageId);
    if (live) return live;
    const pending = this.opening.get(pageId);
    if (pending) return pending;
    const opening = (async () => {
      const current = await this.store.read(pageId, scope);
      const canvas = parseDesignCanvas(current.data);
      const room: LiveRoom = {
        pageId,
        scope,
        canvas,
        seq: 0,
        revision: current.revision,
        saved: JSON.stringify(canvas),
        peers: new Map(),
        saveTimer: null,
        closeTimer: null,
        saving: null,
      };
      this.rooms.set(pageId, room);
      return room;
    })().finally(() => this.opening.delete(pageId));
    this.opening.set(pageId, opening);
    return opening;
  }

  private broadcast(room: LiveRoom, message: unknown, except?: string) {
    for (const peer of room.peers.values()) if (peer.id !== except) send(peer, message);
  }

  private broadcastPeers(room: LiveRoom) {
    this.broadcast(room, { t: "peers", peers: [...room.peers.values()].map(peerView) });
  }

  private schedule(room: LiveRoom) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => void this.flush(room.pageId).catch(() => {}), SAVE_DELAY_MS);
  }

  /** Saves what the room holds now, if it changed. Safe to call any time. */
  async flush(pageId: string): Promise<number | null> {
    const room = this.rooms.get(pageId);
    if (!room) return null;
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    if (room.saving) await room.saving.catch(() => {});
    const data = JSON.stringify(room.canvas);
    if (data === room.saved) return room.revision;
    room.saving = (async () => {
      try {
        room.revision = await this.store.save(pageId, room.scope, data, room.revision);
      } catch (error) {
        const current = (error as { currentRevision?: number }).currentRevision;
        if ((error as { code?: string }).code !== "conflict" || typeof current !== "number")
          throw error;
        // A write outside the room landed first (a restore, an older window). The room is what
        // the people in it see, so it saves on top; that write stays in the item's history.
        room.revision = await this.store.save(pageId, room.scope, data, current);
      }
      room.saved = data;
      this.broadcast(room, { t: "saved", revision: room.revision });
    })().finally(() => {
      room.saving = null;
    });
    try {
      await room.saving;
    } catch {
      this.schedule(room);
      return null;
    }
    return room.revision;
  }

  /** An agent saved a new revision outside the room: everyone in it sees it at once. */
  replaced(pageId: string, data: string, revision: number) {
    const room = this.rooms.get(pageId);
    if (!room) return;
    try {
      room.canvas = parseDesignCanvas(data);
    } catch {
      return;
    }
    room.revision = revision;
    room.saved = JSON.stringify(room.canvas);
    room.seq += 1;
    this.broadcast(room, { t: "doc", seq: room.seq, revision, doc: room.canvas });
  }

  isOpen(pageId: string) {
    return this.rooms.has(pageId);
  }

  async join(
    pageId: string,
    scope: string | null,
    peerId: string,
    socket: DesignRoomSocket,
    readOnly: boolean,
  ) {
    const room = await this.open(pageId, scope);
    if (room.closeTimer) {
      clearTimeout(room.closeTimer);
      room.closeTimer = null;
    }
    if (room.peers.size >= MAX_PEERS && !room.peers.has(peerId)) {
      socket.close(1013, "room is full");
      return { receive: () => {}, leave: () => {} };
    }
    room.peers.get(peerId)?.socket.close(4000, "replaced by a newer connection");
    const peer: Peer = {
      id: peerId,
      socket,
      readOnly,
      name: "Moss 用户",
      color: "",
      presence: null,
      recent: { ops: [], presence: [] },
    };
    room.peers.set(peerId, peer);
    send(peer, {
      t: "welcome",
      self: peerId,
      seq: room.seq,
      revision: room.revision,
      doc: room.canvas,
      peers: [...room.peers.values()].map(peerView),
      readOnly,
    });
    this.broadcastPeers(room);
    return {
      receive: (message: string) => void this.receive(room, peer, message),
      leave: () => this.leave(room, peer),
    };
  }

  private async receive(room: LiveRoom, peer: Peer, raw: string) {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.t) {
      case "hello": {
        const name =
          typeof message.name === "string" ? message.name.replace(/\p{Cc}/gu, "").trim() : "";
        if (NAME.test(name)) peer.name = name;
        if (typeof message.color === "string" && COLOR.test(message.color))
          peer.color = message.color;
        this.broadcastPeers(room);
        return;
      }
      case "presence": {
        const size = JSON.stringify(message.presence ?? null).length;
        if (size > MAX_PRESENCE_BYTES || !admit(peer.recent.presence, PRESENCE_PER_SECOND)) return;
        peer.presence = message.presence ?? null;
        this.broadcast(room, { t: "presence", id: peer.id, presence: peer.presence }, peer.id);
        return;
      }
      case "ops": {
        const id = typeof message.id === "string" ? message.id.slice(0, 64) : "";
        const reject = (reason: string) =>
          send(peer, { t: "reject", id, message: reason, seq: room.seq, doc: room.canvas });
        if (peer.readOnly) return reject("这份设计现在只能查看");
        if (!admit(peer.recent.ops, OPS_PER_SECOND)) return reject("改动太快了，请稍后再试");
        if (!Array.isArray(message.ops) || message.ops.length === 0 || message.ops.length > 500)
          return reject("ops must be a non-empty array of at most 500");
        const ops = message.ops as DesignOp[];
        let next: DesignCanvas;
        try {
          next = applyDesignOps(room.canvas, ops);
          if (JSON.stringify(next).length > DESIGN_LIMITS.bytes)
            return reject("这份设计超过 2 MB，改动没有保存");
        } catch (error) {
          return reject(error instanceof Error ? error.message : String(error));
        }
        room.canvas = next;
        room.seq += 1;
        this.broadcast(room, { t: "ops", seq: room.seq, from: peer.id, id, ops });
        this.schedule(room);
        return;
      }
      case "flush": {
        const id = typeof message.id === "string" ? message.id.slice(0, 64) : "";
        const revision = await this.flush(room.pageId).catch(() => null);
        send(peer, { t: "flushed", id, revision });
        return;
      }
    }
  }

  private leave(room: LiveRoom, peer: Peer) {
    if (room.peers.get(peer.id) !== peer) return;
    room.peers.delete(peer.id);
    this.broadcastPeers(room);
    if (room.peers.size > 0) return;
    void this.flush(room.pageId).catch(() => {});
    room.closeTimer = setTimeout(() => this.close(room.pageId), IDLE_CLOSE_MS);
  }

  private close(pageId: string) {
    const room = this.rooms.get(pageId);
    if (!room || room.peers.size > 0) return;
    void this.flush(pageId)
      .catch(() => null)
      .finally(() => {
        if (room.peers.size === 0 && this.rooms.get(pageId) === room) this.rooms.delete(pageId);
      });
  }

  async closeAll() {
    await Promise.all([...this.rooms.keys()].map((pageId) => this.flush(pageId).catch(() => {})));
    for (const room of this.rooms.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      if (room.closeTimer) clearTimeout(room.closeTimer);
      for (const peer of room.peers.values()) peer.socket.close(1001, "server stopping");
    }
    this.rooms.clear();
  }
}

let shared: DesignRooms | null = null;

/** One registry per server process: the room route and the agent design tools share it. */
export function designRooms(): DesignRooms | null {
  return shared;
}

export function installDesignRooms(store: DesignRoomStore): DesignRooms {
  shared ??= new DesignRooms(store);
  return shared;
}

/** Tests only: forget the process registry. */
export function resetDesignRoomsForTests() {
  shared = null;
}
