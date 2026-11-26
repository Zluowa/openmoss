// FILE: boardRooms.ts
// Purpose: Pure-TypeScript live 白板 (kind `board`) rooms for `/ws/board-room`. Relays presence
//          and board state updates between connected sessions on the same board, and debounces
//          validated saves back to `PageTypesService` via optimistic revision checks.
// Layer: Server pages. Zero `@tldraw/*` dependencies and zero synchronous filesystem calls.

import {
  isBoardOp,
  parseBoardCanvasDocument,
  type BoardCanvasDocument,
  type BoardOp,
} from "@moss/shared/spaceItems/boardCanvas";
import { parseBoardItem } from "@moss/shared/spaceItems/itemData";

export interface BoardRoomStore {
  readonly read: (
    pageId: string,
    scope: string | null,
  ) => Promise<{ readonly data: string; readonly revision: number }>;
  /** Saves against `expectedRevision`; throws `{ code: "conflict", currentRevision }` when stale. */
  readonly save: (
    pageId: string,
    scope: string | null,
    data: string,
    expectedRevision: number,
  ) => Promise<number>;
}

export interface BoardRoomConnection {
  readonly sessionId: string;
  readonly readOnly: boolean;
  readonly send: (payload: string) => void;
  readonly close: () => void;
}

export type BoardRoomServerMessage =
  | {
      readonly type: "welcome";
      readonly pageId: string;
      readonly revision: number;
      readonly readOnly: boolean;
      readonly data: unknown;
      readonly presence: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "ops";
      readonly sessionId: string;
      readonly ops: readonly BoardOp[];
      readonly revision: number;
    }
  | {
      readonly type: "state";
      readonly sessionId: string;
      readonly revision: number;
      readonly data: unknown;
    }
  | {
      readonly type: "presence";
      readonly sessionId: string;
      readonly presence: unknown;
    }
  | {
      readonly type: "replaced";
      readonly revision: number;
      readonly data: unknown;
    }
  | {
      readonly type: "saved";
      readonly revision: number;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly currentRevision?: number;
    };

const SAVE_DELAY_MS = 600;
const IDLE_CLOSE_MS = 30_000;
const MAX_OPS_PER_MESSAGE = 200;

interface LiveBoardRoom {
  readonly pageId: string;
  readonly scope: string | null;
  revision: number;
  serialized: string;
  parsed: unknown;
  dirty: boolean;
  readonly clients: Map<string, BoardRoomConnection>;
  readonly presence: Map<string, unknown>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void> | null;
}

function normalizeBoardData(raw: string): {
  readonly serialized: string;
  readonly parsed: unknown;
} {
  if (!raw.trim()) {
    throw new Error("Board data cannot be empty");
  }
  const candidate = JSON.parse(raw) as Record<string, unknown>;
  if (
    candidate &&
    typeof candidate === "object" &&
    "snapshot" in candidate &&
    candidate.version === 2
  ) {
    const doc: BoardCanvasDocument = parseBoardCanvasDocument(candidate);
    return { serialized: JSON.stringify(doc), parsed: doc };
  }
  const item = parseBoardItem(candidate);
  return { serialized: JSON.stringify(item), parsed: item };
}

function sendJson(conn: BoardRoomConnection, message: BoardRoomServerMessage): void {
  try {
    conn.send(JSON.stringify(message));
  } catch {
    // Dropped client; cleanup happens on close.
  }
}

export class BoardRooms {
  private readonly rooms = new Map<string, LiveBoardRoom>();
  private readonly opening = new Map<string, Promise<LiveBoardRoom>>();
  private disposed = false;

  constructor(private readonly store: BoardRoomStore) {}

  roomCount(): number {
    return this.rooms.size;
  }

  async join(pageId: string, scope: string | null, conn: BoardRoomConnection): Promise<() => void> {
    const room = await this.open(pageId, scope);
    if (this.disposed) {
      conn.close();
      return () => {};
    }
    if (room.closeTimer) {
      clearTimeout(room.closeTimer);
      room.closeTimer = null;
    }
    room.clients.set(conn.sessionId, conn);
    sendJson(conn, {
      type: "welcome",
      pageId,
      revision: room.revision,
      readOnly: conn.readOnly,
      data: room.parsed,
      presence: Object.fromEntries(room.presence.entries()),
    });
    return () => this.leave(pageId, conn.sessionId);
  }

  handleMessage(pageId: string, sessionId: string, rawText: string): void {
    const room = this.rooms.get(pageId);
    const sender = room?.clients.get(sessionId);
    if (!room || !sender) return;

    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      sendJson(sender, { type: "error", code: "invalid_json", message: "Invalid JSON message." });
      return;
    }

    if (msg.type === "presence") {
      if (msg.presence === null) {
        room.presence.delete(sessionId);
      } else {
        room.presence.set(sessionId, msg.presence ?? {});
      }
      this.broadcastExcept(room, sessionId, {
        type: "presence",
        sessionId,
        presence: msg.presence ?? null,
      });
      return;
    }

    if (sender.readOnly) {
      sendJson(sender, {
        type: "error",
        code: "read_only",
        message: "Board is trashed/read-only.",
      });
      return;
    }

    if (msg.type === "ops") {
      if (
        !Array.isArray(msg.ops) ||
        msg.ops.length > MAX_OPS_PER_MESSAGE ||
        !msg.ops.every(isBoardOp)
      ) {
        sendJson(sender, { type: "error", code: "invalid_ops", message: "Invalid board ops." });
        return;
      }
      this.broadcastExcept(room, sessionId, {
        type: "ops",
        sessionId,
        ops: msg.ops,
        revision: room.revision,
      });
      return;
    }

    if (msg.type === "state" || msg.type === "note") {
      try {
        const nextRaw =
          msg.type === "note"
            ? JSON.stringify({
                ...(typeof room.parsed === "object" && room.parsed !== null ? room.parsed : {}),
                note: typeof msg.note === "string" ? msg.note.slice(0, 4_000) : "",
              })
            : typeof msg.data === "string"
              ? msg.data
              : JSON.stringify(msg.data);
        const normalized = normalizeBoardData(nextRaw);
        if (normalized.serialized === room.serialized) return;
        room.serialized = normalized.serialized;
        room.parsed = normalized.parsed;
        room.dirty = true;
        this.broadcastExcept(room, sessionId, {
          type: "state",
          sessionId,
          revision: room.revision,
          data: room.parsed,
        });
        this.scheduleSave(room);
      } catch (cause) {
        sendJson(sender, {
          type: "error",
          code: "invalid_board_state",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  /** Pushes an authoritative external save (e.g. agent tool or REST save) into any live room. */
  async replaced(pageId: string, revision: number, rawData: string): Promise<void> {
    const room = this.rooms.get(pageId);
    if (!room) return;
    try {
      const normalized = normalizeBoardData(rawData);
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
        room.saveTimer = null;
      }
      room.revision = revision;
      room.serialized = normalized.serialized;
      room.parsed = normalized.parsed;
      room.dirty = false;
      this.broadcastAll(room, { type: "replaced", revision, data: room.parsed });
    } catch {
      // Ignore malformed replacement payloads.
    }
  }

  async flush(pageId?: string): Promise<void> {
    const targets = pageId
      ? ([this.rooms.get(pageId)].filter(Boolean) as LiveBoardRoom[])
      : [...this.rooms.values()];
    for (const room of targets) {
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
        room.saveTimer = null;
      }
      await this.persist(room);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
    for (const room of this.rooms.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      if (room.closeTimer) clearTimeout(room.closeTimer);
      for (const client of room.clients.values()) client.close();
      room.clients.clear();
    }
    this.rooms.clear();
  }

  private async open(pageId: string, scope: string | null): Promise<LiveBoardRoom> {
    const existing = this.rooms.get(pageId);
    if (existing) return existing;
    const inflight = this.opening.get(pageId);
    if (inflight) return inflight;

    const task = (async () => {
      const current = await this.store.read(pageId, scope);
      const normalized = normalizeBoardData(current.data);
      const room: LiveBoardRoom = {
        pageId,
        scope,
        revision: current.revision,
        serialized: normalized.serialized,
        parsed: normalized.parsed,
        dirty: false,
        clients: new Map(),
        presence: new Map(),
        saveTimer: null,
        closeTimer: null,
        saving: null,
      };
      this.rooms.set(pageId, room);
      return room;
    })();
    this.opening.set(pageId, task);
    try {
      return await task;
    } finally {
      this.opening.delete(pageId);
    }
  }

  private leave(pageId: string, sessionId: string): void {
    const room = this.rooms.get(pageId);
    if (!room) return;
    room.clients.delete(sessionId);
    if (room.presence.delete(sessionId)) {
      this.broadcastAll(room, { type: "presence", sessionId, presence: null });
    }
    if (room.clients.size === 0 && !this.disposed) {
      room.closeTimer = setTimeout(() => {
        if (room.clients.size === 0 && !room.dirty && !room.saving) {
          this.rooms.delete(pageId);
        }
      }, IDLE_CLOSE_MS);
    }
  }

  private scheduleSave(room: LiveBoardRoom): void {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      void this.persist(room);
    }, SAVE_DELAY_MS);
  }

  private async persist(room: LiveBoardRoom): Promise<void> {
    if (room.saving) {
      await room.saving;
      if (!room.dirty) return;
    }
    if (!room.dirty) return;
    const payload = room.serialized;
    const expectedRevision = room.revision;
    const run = (async () => {
      try {
        const nextRevision = await this.store.save(
          room.pageId,
          room.scope,
          payload,
          expectedRevision,
        );
        room.revision = nextRevision;
        if (room.serialized === payload) {
          room.dirty = false;
        } else {
          this.scheduleSave(room);
        }
        this.broadcastAll(room, { type: "saved", revision: nextRevision });
      } catch (cause) {
        const conflict = cause as { readonly code?: unknown; readonly currentRevision?: unknown };
        if (conflict?.code === "conflict" && typeof conflict.currentRevision === "number") {
          const latest = await this.store.read(room.pageId, room.scope);
          const normalized = normalizeBoardData(latest.data);
          room.revision = latest.revision;
          room.serialized = normalized.serialized;
          room.parsed = normalized.parsed;
          room.dirty = false;
          this.broadcastAll(room, {
            type: "replaced",
            revision: latest.revision,
            data: room.parsed,
          });
          return;
        }
        this.broadcastAll(room, {
          type: "error",
          code: "save_failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    room.saving = run;
    try {
      await run;
    } finally {
      room.saving = null;
    }
  }

  private broadcastAll(room: LiveBoardRoom, message: BoardRoomServerMessage): void {
    for (const conn of room.clients.values()) sendJson(conn, message);
  }

  private broadcastExcept(
    room: LiveBoardRoom,
    excludeSessionId: string,
    message: BoardRoomServerMessage,
  ): void {
    for (const [id, conn] of room.clients.entries()) {
      if (id !== excludeSessionId) sendJson(conn, message);
    }
  }
}
