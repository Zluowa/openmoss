// FILE: boardRooms.ts
// Purpose: Pure-TypeScript live 白板 (kind `board`) rooms for `/ws/board-room`. Relays peer
//          identity, rich presence, incremental record-level deltas, AI working claims, shared
//          workshop countdown timers, emoji sticker votes, and board state updates across
//          connected sessions on the same board, debouncing validated saves back to
//          `PageTypesService` via optimistic revision checks.
// Layer: Server pages. Zero `@tldraw/*` dependencies and zero synchronous filesystem calls.

import {
  BOARD_LIMITS,
  isBoardOp,
  parseBoardCanvasDocument,
  type BoardCanvasDocument,
  type BoardCanvasRecord,
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
  readonly name?: string;
  readonly color?: string;
  readonly send: (payload: string) => void;
  readonly close: () => void;
}

export interface BoardRoomPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoardRoomRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface BoardRoomPresence {
  readonly cursor?: BoardRoomPoint | null;
  readonly selected?: readonly string[];
  readonly view?: BoardRoomRect;
  readonly tool?: string;
  readonly [key: string]: unknown;
}

export interface BoardRoomPeer {
  readonly sessionId: string;
  readonly name: string;
  readonly color: string;
  readonly readOnly: boolean;
  readonly presence: unknown;
}

export interface BoardRoomClaim {
  readonly id: string;
  readonly sessionId: string;
  readonly area: BoardRoomRect;
  readonly word: string;
  readonly authorName?: string;
  readonly color?: string;
  readonly updatedAt: number;
}

export interface BoardRoomTimer {
  readonly durationMs: number;
  readonly remainingMs: number;
  readonly running: boolean;
  readonly endsAt: number | null;
  readonly label?: string;
  readonly updatedBy?: string;
  readonly updatedAt?: number;
}

export interface BoardRoomSticker {
  readonly id: string;
  readonly emoji: string;
  readonly x: number;
  readonly y: number;
  readonly targetId?: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly createdAt?: number;
}

export type BoardRoomServerMessage =
  | {
      readonly type: "welcome";
      readonly pageId: string;
      readonly sessionId: string;
      readonly revision: number;
      readonly readOnly: boolean;
      readonly data: unknown;
      readonly presence: Readonly<Record<string, unknown>>;
      readonly peers: readonly BoardRoomPeer[];
      readonly claims: readonly BoardRoomClaim[];
      readonly timer: BoardRoomTimer | null;
      readonly stickers: readonly BoardRoomSticker[];
      readonly records?: Readonly<Record<string, BoardCanvasRecord>>;
    }
  | {
      readonly type: "peers";
      readonly peers: readonly BoardRoomPeer[];
    }
  | {
      readonly type: "ops";
      readonly sessionId: string;
      readonly ops: readonly BoardOp[];
      readonly revision: number;
    }
  | {
      readonly type: "records";
      readonly sessionId: string;
      readonly revision: number;
      readonly added: Readonly<Record<string, BoardCanvasRecord>>;
      readonly updated: Readonly<Record<string, BoardCanvasRecord>>;
      readonly removed: readonly string[];
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
      readonly type: "claim";
      readonly sessionId: string;
      readonly claimId: string;
      readonly claim: BoardRoomClaim | null;
    }
  | {
      readonly type: "timer";
      readonly sessionId: string;
      readonly timer: BoardRoomTimer | null;
    }
  | {
      readonly type: "sticker";
      readonly sessionId: string;
      readonly action: "add" | "remove" | "clear";
      readonly sticker?: BoardRoomSticker;
      readonly stickerId?: string;
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
const MAX_RECORDS_PER_MESSAGE = 500;
const MAX_PRESENCE_BYTES = 8_192;
const MAX_CLAIMS_PER_SESSION = 8;
const MAX_CLAIMS_PER_ROOM = 64;
const MAX_STICKERS_PER_ROOM = 500;
const MAX_TIMER_DURATION_MS = 24 * 60 * 60 * 1_000;

const SAFE_NAME = /^[^<>]{1,40}$/u;
const SAFE_COLOR = /^[#(),.%\s\w-]{1,40}$/u;
const SAFE_ID = /^[^\s<>]{1,128}$/u;
const SAFE_RECORD_ID = /^[^\s<>]{1,256}$/u;
const PEER_PALETTE = [
  "#2b72d6",
  "#d97757",
  "#2f9e44",
  "#7c5cd6",
  "#e03131",
  "#0c8599",
  "#e8590c",
  "#c2255c",
] as const;

interface LivePeer {
  readonly sessionId: string;
  readonly readOnly: boolean;
  name: string;
  color: string;
  presence: unknown;
}

interface LiveBoardRoom {
  readonly pageId: string;
  readonly scope: string | null;
  revision: number;
  serialized: string;
  parsed: unknown;
  dirty: boolean;
  readonly clients: Map<string, BoardRoomConnection>;
  readonly peers: Map<string, LivePeer>;
  readonly presence: Map<string, unknown>;
  readonly claims: Map<string, BoardRoomClaim>;
  timer: BoardRoomTimer | null;
  readonly stickers: Map<string, BoardRoomSticker>;
  /** Ephemeral merged record cache for isolated BoardItem rooms whose snapshot lives outside PageTypesService. */
  readonly liveRecords: Map<string, BoardCanvasRecord>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void> | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoardCanvasDocument(value: unknown): value is BoardCanvasDocument {
  return (
    isPlainRecord(value) &&
    value.version === 2 &&
    isPlainRecord(value.snapshot) &&
    isPlainRecord(value.snapshot.store)
  );
}

function pickPeerColor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return PEER_PALETTE[hash % PEER_PALETTE.length]!;
}

function sanitizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\p{Cc}/gu, "").trim();
  return SAFE_NAME.test(cleaned) ? cleaned : null;
}

function sanitizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return SAFE_COLOR.test(cleaned) ? cleaned : null;
}

function peerView(peer: LivePeer): BoardRoomPeer {
  return {
    sessionId: peer.sessionId,
    name: peer.name,
    color: peer.color,
    readOnly: peer.readOnly,
    presence: peer.presence,
  };
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

function parseRecordMap(value: unknown, label: string): Record<string, BoardCanvasRecord> {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_RECORDS_PER_MESSAGE) {
    throw new Error(`Invalid ${label}: too many records`);
  }
  const result: Record<string, BoardCanvasRecord> = {};
  for (const [key, raw] of entries) {
    if (!isPlainRecord(raw) || typeof raw.typeName !== "string" || !raw.typeName.trim()) {
      throw new Error(`Invalid ${label}: record ${key} is malformed`);
    }
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : key;
    if (!SAFE_RECORD_ID.test(id)) {
      throw new Error(`Invalid ${label}: invalid record id`);
    }
    result[id] = { ...raw, id } as BoardCanvasRecord;
  }
  return result;
}

function parseRemovedIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECORDS_PER_MESSAGE) {
    throw new Error("Invalid removed list");
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !SAFE_RECORD_ID.test(entry)) {
      throw new Error("Invalid removed record id");
    }
    ids.push(entry);
  }
  return ids;
}

function parseClaim(value: unknown, sessionId: string, peer: LivePeer): BoardRoomClaim | null {
  if (!isPlainRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!SAFE_ID.test(id)) return null;
  if (!isPlainRecord(value.area)) return null;
  const { x, y, w, h } = value.area;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(w) ||
    !isFiniteNumber(h) ||
    w < 0 ||
    h < 0
  ) {
    return null;
  }
  const rawWord = typeof value.word === "string" ? value.word.replace(/\p{Cc}/gu, "").trim() : "";
  const word = rawWord.slice(0, 80) || "正在处理";
  const authorName = sanitizeName(value.authorName) ?? peer.name;
  const color = sanitizeColor(value.color) ?? peer.color;
  return {
    id,
    sessionId,
    area: { x, y, w, h },
    word,
    authorName,
    color,
    updatedAt: Date.now(),
  };
}

function parseTimer(value: unknown, sessionId: string): BoardRoomTimer | null {
  if (!isPlainRecord(value)) return null;
  const { durationMs, remainingMs, running, endsAt, label } = value;
  if (
    !isFiniteNumber(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_TIMER_DURATION_MS ||
    !isFiniteNumber(remainingMs) ||
    remainingMs < 0 ||
    remainingMs > MAX_TIMER_DURATION_MS ||
    typeof running !== "boolean"
  ) {
    return null;
  }
  let normalizedEndsAt: number | null;
  if (endsAt === null || endsAt === undefined) {
    normalizedEndsAt = running ? Date.now() + remainingMs : null;
  } else if (isFiniteNumber(endsAt)) {
    normalizedEndsAt = endsAt;
  } else {
    return null;
  }
  const cleanLabel =
    typeof label === "string"
      ? label
          .replace(/\p{Cc}/gu, "")
          .replace(/[<>]/gu, "")
          .trim()
          .slice(0, 60)
      : undefined;
  return {
    durationMs: Math.round(durationMs),
    remainingMs: Math.round(remainingMs),
    running,
    endsAt: normalizedEndsAt !== null ? Math.round(normalizedEndsAt) : null,
    ...(cleanLabel ? { label: cleanLabel } : {}),
    updatedBy: sessionId,
    updatedAt: Date.now(),
  };
}

function parseSticker(
  value: unknown,
  fallbackAuthorId: string,
  fallbackAuthorName: string,
): BoardRoomSticker | null {
  if (!isPlainRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const emoji =
    typeof value.emoji === "string"
      ? value.emoji
          .replace(/\p{Cc}/gu, "")
          .replace(/[<>]/gu, "")
          .trim()
      : "";
  if (!SAFE_ID.test(id) || !emoji || emoji.length > 16) return null;
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  const targetId =
    typeof value.targetId === "string" && SAFE_RECORD_ID.test(value.targetId.trim())
      ? value.targetId.trim()
      : undefined;
  const authorId =
    typeof value.authorId === "string" && SAFE_ID.test(value.authorId.trim())
      ? value.authorId.trim()
      : fallbackAuthorId;
  const authorName = sanitizeName(value.authorName) ?? fallbackAuthorName;
  const createdAt = isFiniteNumber(value.createdAt) ? value.createdAt : Date.now();
  return {
    id,
    emoji,
    x: value.x,
    y: value.y,
    ...(targetId ? { targetId } : {}),
    authorId,
    authorName,
    createdAt,
  };
}

function readStickersFromDocument(doc: BoardCanvasDocument): BoardRoomSticker[] {
  const documentRecord = doc.snapshot.store["document:document"];
  const meta = documentRecord && isPlainRecord(documentRecord.meta) ? documentRecord.meta : null;
  const rawList = meta?.mossStickers;
  if (!Array.isArray(rawList)) return [];
  const stickers: BoardRoomSticker[] = [];
  for (const item of rawList.slice(0, MAX_STICKERS_PER_ROOM)) {
    const parsed = parseSticker(item, "unknown", "协作者");
    if (parsed) stickers.push(parsed);
  }
  return stickers;
}

function syncStickersIntoDocument(room: LiveBoardRoom): void {
  if (!isBoardCanvasDocument(room.parsed)) return;
  const store = { ...room.parsed.snapshot.store };
  const existingDoc = store["document:document"] ?? {
    id: "document:document",
    typeName: "document",
  };
  const existingMeta = isPlainRecord(existingDoc.meta) ? existingDoc.meta : {};
  const nextMeta: Record<string, unknown> = {
    ...existingMeta,
    mossStickers: [...room.stickers.values()],
  };
  store["document:document"] = {
    ...existingDoc,
    id: "document:document",
    typeName: "document",
    meta: nextMeta,
  };
  const nextDoc = parseBoardCanvasDocument({
    version: 2,
    snapshot: {
      ...room.parsed.snapshot,
      store,
    },
  });
  const nextSerialized = JSON.stringify(nextDoc);
  if (nextSerialized === room.serialized) return;
  room.parsed = nextDoc;
  room.serialized = nextSerialized;
  room.dirty = true;
}

function validatePresencePayload(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!isPlainRecord(value)) return { ok: false };
  try {
    if (JSON.stringify(value).length > MAX_PRESENCE_BYTES) return { ok: false };
  } catch {
    return { ok: false };
  }
  if (value.cursor !== undefined && value.cursor !== null) {
    if (
      !isPlainRecord(value.cursor) ||
      !isFiniteNumber(value.cursor.x) ||
      !isFiniteNumber(value.cursor.y)
    ) {
      return { ok: false };
    }
  }
  if (value.selected !== undefined) {
    if (
      !Array.isArray(value.selected) ||
      value.selected.length > 200 ||
      !value.selected.every((id) => typeof id === "string" && id.length <= 256)
    ) {
      return { ok: false };
    }
  }
  if (value.view !== undefined) {
    if (
      !isPlainRecord(value.view) ||
      !isFiniteNumber(value.view.x) ||
      !isFiniteNumber(value.view.y) ||
      !isFiniteNumber(value.view.w) ||
      !isFiniteNumber(value.view.h)
    ) {
      return { ok: false };
    }
  }
  if (value.tool !== undefined && (typeof value.tool !== "string" || value.tool.length > 64)) {
    return { ok: false };
  }
  return { ok: true, value };
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
    const peer: LivePeer = {
      sessionId: conn.sessionId,
      readOnly: conn.readOnly,
      name: sanitizeName(conn.name) ?? "协作者",
      color: sanitizeColor(conn.color) ?? pickPeerColor(conn.sessionId),
      presence: room.presence.get(conn.sessionId) ?? null,
    };
    room.clients.set(conn.sessionId, conn);
    room.peers.set(conn.sessionId, peer);
    const peersSnapshot = [...room.peers.values()].map(peerView);
    sendJson(conn, {
      type: "welcome",
      pageId,
      sessionId: conn.sessionId,
      revision: room.revision,
      readOnly: conn.readOnly,
      data: room.parsed,
      presence: Object.fromEntries(room.presence.entries()),
      peers: peersSnapshot,
      claims: [...room.claims.values()],
      timer: room.timer,
      stickers: [...room.stickers.values()],
      ...(room.liveRecords.size > 0
        ? { records: Object.fromEntries(room.liveRecords.entries()) }
        : {}),
    });
    this.broadcastExcept(room, conn.sessionId, {
      type: "peers",
      peers: peersSnapshot,
    });
    return () => this.leave(pageId, conn.sessionId);
  }

  handleMessage(pageId: string, sessionId: string, rawText: string): void {
    const room = this.rooms.get(pageId);
    const sender = room?.clients.get(sessionId);
    const peer = room?.peers.get(sessionId);
    if (!room || !sender || !peer) return;

    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      sendJson(sender, { type: "error", code: "invalid_json", message: "Invalid JSON message." });
      return;
    }

    if (msg.type === "hello") {
      const nextName = sanitizeName(msg.name);
      const nextColor = sanitizeColor(msg.color);
      if (nextName) peer.name = nextName;
      if (nextColor) peer.color = nextColor;
      this.broadcastAll(room, {
        type: "peers",
        peers: [...room.peers.values()].map(peerView),
      });
      return;
    }

    if (msg.type === "presence") {
      const validated = validatePresencePayload(msg.presence);
      if (!validated.ok) {
        sendJson(sender, {
          type: "error",
          code: "invalid_presence",
          message: "Invalid presence payload.",
        });
        return;
      }
      if (validated.value === null) {
        room.presence.delete(sessionId);
        peer.presence = null;
      } else {
        room.presence.set(sessionId, validated.value);
        peer.presence = validated.value;
      }
      this.broadcastExcept(room, sessionId, {
        type: "presence",
        sessionId,
        presence: validated.value,
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

    if (msg.type === "records") {
      this.handleRecordsMessage(room, sender, sessionId, msg);
      return;
    }

    if (msg.type === "claim") {
      this.handleClaimMessage(room, sender, peer, msg);
      return;
    }

    if (msg.type === "timer") {
      this.handleTimerMessage(room, sender, sessionId, msg);
      return;
    }

    if (msg.type === "sticker") {
      this.handleStickerMessage(room, sender, peer, msg);
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
      room.liveRecords.clear();
      if (isBoardCanvasDocument(room.parsed)) {
        const persistedStickers = readStickersFromDocument(room.parsed);
        if (persistedStickers.length > 0) {
          room.stickers.clear();
          for (const sticker of persistedStickers) room.stickers.set(sticker.id, sticker);
        }
      }
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
      room.peers.clear();
      room.claims.clear();
    }
    this.rooms.clear();
  }

  private handleRecordsMessage(
    room: LiveBoardRoom,
    sender: BoardRoomConnection,
    sessionId: string,
    msg: Record<string, unknown>,
  ): void {
    try {
      const added = parseRecordMap(msg.added, "added");
      const updated = parseRecordMap(msg.updated, "updated");
      const removed = parseRemovedIds(msg.removed);
      const totalChanges = Object.keys(added).length + Object.keys(updated).length + removed.length;
      if (totalChanges === 0) return;
      if (totalChanges > MAX_RECORDS_PER_MESSAGE) {
        throw new Error(`At most ${MAX_RECORDS_PER_MESSAGE} record changes per message`);
      }

      if (isBoardCanvasDocument(room.parsed)) {
        const nextStore: Record<string, BoardCanvasRecord> = { ...room.parsed.snapshot.store };
        for (const [id, record] of Object.entries(added)) {
          nextStore[id] = record;
        }
        for (const [id, record] of Object.entries(updated)) {
          nextStore[id] = record;
        }
        for (const id of removed) {
          if (id === "document:document") continue;
          delete nextStore[id];
        }
        const mergedDoc = parseBoardCanvasDocument({
          version: 2,
          snapshot: {
            ...room.parsed.snapshot,
            store: nextStore,
          },
        });
        const nextSerialized = JSON.stringify(mergedDoc);
        if (nextSerialized === room.serialized) return;
        room.parsed = mergedDoc;
        room.serialized = nextSerialized;
        room.dirty = true;
        this.broadcastExcept(room, sessionId, {
          type: "records",
          sessionId,
          revision: room.revision,
          added,
          updated,
          removed,
        });
        this.scheduleSave(room);
        return;
      }

      // Isolated BoardItem room: snapshots persist through canvas storage, while the room merges
      // and relays incremental records in real time across live collaborators.
      let shapeCount = 0;
      for (const rec of room.liveRecords.values()) {
        if (rec.typeName === "shape") shapeCount += 1;
      }
      for (const [id, record] of Object.entries(added)) {
        const prev = room.liveRecords.get(id);
        if (record.typeName === "shape" && prev?.typeName !== "shape") shapeCount += 1;
        if (shapeCount > BOARD_LIMITS.shapes) {
          throw new Error(`A board holds at most ${BOARD_LIMITS.shapes} shapes`);
        }
        room.liveRecords.set(id, record);
      }
      for (const [id, record] of Object.entries(updated)) {
        const prev = room.liveRecords.get(id);
        if (record.typeName === "shape" && prev?.typeName !== "shape") shapeCount += 1;
        if (shapeCount > BOARD_LIMITS.shapes) {
          throw new Error(`A board holds at most ${BOARD_LIMITS.shapes} shapes`);
        }
        room.liveRecords.set(id, record);
      }
      for (const id of removed) {
        if (id === "document:document") continue;
        room.liveRecords.delete(id);
      }
      this.broadcastExcept(room, sessionId, {
        type: "records",
        sessionId,
        revision: room.revision,
        added,
        updated,
        removed,
      });
    } catch (cause) {
      sendJson(sender, {
        type: "error",
        code: "invalid_records",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private handleClaimMessage(
    room: LiveBoardRoom,
    sender: BoardRoomConnection,
    peer: LivePeer,
    msg: Record<string, unknown>,
  ): void {
    const sessionId = peer.sessionId;
    if (msg.claim === null) {
      const claimId = typeof msg.claimId === "string" ? msg.claimId.trim() : "";
      if (claimId) {
        const key = `${sessionId}:${claimId}`;
        if (room.claims.delete(key)) {
          this.broadcastExcept(room, sessionId, {
            type: "claim",
            sessionId,
            claimId,
            claim: null,
          });
        }
        return;
      }
      for (const [key, existing] of room.claims.entries()) {
        if (existing.sessionId !== sessionId) continue;
        room.claims.delete(key);
        this.broadcastExcept(room, sessionId, {
          type: "claim",
          sessionId,
          claimId: existing.id,
          claim: null,
        });
      }
      return;
    }

    const parsed = parseClaim(msg.claim, sessionId, peer);
    if (!parsed) {
      sendJson(sender, {
        type: "error",
        code: "invalid_claim",
        message: "Invalid board claim payload.",
      });
      return;
    }
    const key = `${sessionId}:${parsed.id}`;
    if (!room.claims.has(key)) {
      let ownCount = 0;
      for (const existing of room.claims.values()) {
        if (existing.sessionId === sessionId) ownCount += 1;
      }
      if (ownCount >= MAX_CLAIMS_PER_SESSION || room.claims.size >= MAX_CLAIMS_PER_ROOM) {
        sendJson(sender, {
          type: "error",
          code: "too_many_claims",
          message: "Too many active AI claims on this board.",
        });
        return;
      }
    }
    room.claims.set(key, parsed);
    this.broadcastExcept(room, sessionId, {
      type: "claim",
      sessionId,
      claimId: parsed.id,
      claim: parsed,
    });
  }

  private handleTimerMessage(
    room: LiveBoardRoom,
    sender: BoardRoomConnection,
    sessionId: string,
    msg: Record<string, unknown>,
  ): void {
    if (msg.timer === null) {
      room.timer = null;
      this.broadcastAll(room, { type: "timer", sessionId, timer: null });
      return;
    }
    const parsed = parseTimer(msg.timer, sessionId);
    if (!parsed) {
      sendJson(sender, {
        type: "error",
        code: "invalid_timer",
        message: "Invalid workshop timer payload.",
      });
      return;
    }
    room.timer = parsed;
    this.broadcastAll(room, { type: "timer", sessionId, timer: parsed });
  }

  private handleStickerMessage(
    room: LiveBoardRoom,
    sender: BoardRoomConnection,
    peer: LivePeer,
    msg: Record<string, unknown>,
  ): void {
    const action =
      msg.action === "remove" || msg.action === "clear" || msg.action === "add"
        ? msg.action
        : msg.sticker === null
          ? "remove"
          : "add";

    if (action === "clear") {
      if (room.stickers.size === 0) return;
      room.stickers.clear();
      syncStickersIntoDocument(room);
      this.broadcastAll(room, { type: "sticker", sessionId: peer.sessionId, action: "clear" });
      if (room.dirty) this.scheduleSave(room);
      return;
    }

    if (action === "remove") {
      const stickerId = typeof msg.stickerId === "string" ? msg.stickerId.trim() : "";
      if (!SAFE_ID.test(stickerId)) {
        sendJson(sender, {
          type: "error",
          code: "invalid_sticker",
          message: "Invalid sticker id.",
        });
        return;
      }
      if (!room.stickers.delete(stickerId)) return;
      syncStickersIntoDocument(room);
      this.broadcastAll(room, {
        type: "sticker",
        sessionId: peer.sessionId,
        action: "remove",
        stickerId,
      });
      if (room.dirty) this.scheduleSave(room);
      return;
    }

    const parsed = parseSticker(msg.sticker, peer.sessionId, peer.name);
    if (!parsed) {
      sendJson(sender, {
        type: "error",
        code: "invalid_sticker",
        message: "Invalid sticker payload.",
      });
      return;
    }
    if (!room.stickers.has(parsed.id) && room.stickers.size >= MAX_STICKERS_PER_ROOM) {
      sendJson(sender, {
        type: "error",
        code: "too_many_stickers",
        message: "Board sticker limit reached.",
      });
      return;
    }
    room.stickers.set(parsed.id, parsed);
    syncStickersIntoDocument(room);
    this.broadcastAll(room, {
      type: "sticker",
      sessionId: peer.sessionId,
      action: "add",
      sticker: parsed,
    });
    if (room.dirty) this.scheduleSave(room);
  }

  private async open(pageId: string, scope: string | null): Promise<LiveBoardRoom> {
    const existing = this.rooms.get(pageId);
    if (existing) return existing;
    const inflight = this.opening.get(pageId);
    if (inflight) return inflight;

    const task = (async () => {
      const current = await this.store.read(pageId, scope);
      const normalized = normalizeBoardData(current.data);
      const stickers = new Map<string, BoardRoomSticker>();
      if (isBoardCanvasDocument(normalized.parsed)) {
        for (const sticker of readStickersFromDocument(normalized.parsed)) {
          stickers.set(sticker.id, sticker);
        }
      }
      const room: LiveBoardRoom = {
        pageId,
        scope,
        revision: current.revision,
        serialized: normalized.serialized,
        parsed: normalized.parsed,
        dirty: false,
        clients: new Map(),
        peers: new Map(),
        presence: new Map(),
        claims: new Map(),
        timer: null,
        stickers,
        liveRecords: new Map(),
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
    const removedPeer = room.peers.delete(sessionId);
    for (const [key, existing] of room.claims.entries()) {
      if (existing.sessionId !== sessionId) continue;
      room.claims.delete(key);
      this.broadcastAll(room, {
        type: "claim",
        sessionId,
        claimId: existing.id,
        claim: null,
      });
    }
    if (removedPeer) {
      this.broadcastAll(room, {
        type: "peers",
        peers: [...room.peers.values()].map(peerView),
      });
    }
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
