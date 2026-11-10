// FILE: PageRealtimeRoom.ts
// Purpose: One live Page: its Yjs document, who is connected, and how edits become durable.
// Layer: Pages realtime (collab). Plain TypeScript; the Effect layer adapts storage and Pages.
// Why: Every browser window, paired device and agent edits one CRDT document, so concurrent edits
//      merge instead of failing a revision check. Raw updates are appended as they arrive (crash
//      safety); compaction writes the merged tree back to `pages_versions`, so history, search
//      and agents keep reading ordinary Page revisions.
//
// Wire format (one WebSocket per window and page):
//   binary  [varUint type][payload]  0 = y-protocols sync, 1 = awareness, 3 = awareness query
//   text    JSON control messages, see `RoomControl` and `ClientControl`.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { ThreadId, type PageVersionContributor } from "@moss/contracts";

import { unrecordedContributor } from "../pageVersionContributors";
import { prepareGuestFrame } from "./guestRoomFrame";
import { batchContributors, localContributor, RoomContributors } from "./pageRoomContributors";
import { mergePlateEdit, normalizePlateValue, readPageDoc, seedPageDoc } from "./pageYjsContent";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

export type RoomMode = "edit" | "view";

/** Server → client. */
export type RoomControl =
  | { readonly type: "saved"; readonly stateVector: string }
  | { readonly type: "revision"; readonly revision: number }
  | { readonly type: "need-seed" }
  | { readonly type: "reset"; readonly reason: string; readonly generation: string | null }
  | { readonly type: "rejected"; readonly reason: string };

/** Client → server. */
export type ClientControl = { readonly type: "seed"; readonly richContent: string };

export interface RoomConnection {
  readonly mode: RoomMode;
  readonly send: (message: Uint8Array | string) => void;
  readonly close: (code: number, reason: string) => void;
}

/** What the Page currently holds, as the source the room's state was built from. */
export interface RoomPageState {
  readonly revision: number;
  readonly richContent: string | null;
  readonly content: string;
  readonly trashed: boolean;
}

export interface StoredRoomState {
  readonly generation: string;
  /** The document as of `compactedRevision`. */
  readonly state: Uint8Array;
  readonly compactedRevision: number;
  /** `sourceKey` of the Page at `compactedRevision`. */
  readonly compactedKey: string;
  readonly compactedThroughSequence: number;
  readonly lastSequence: number;
  /** Updates received after the compaction, oldest first. */
  readonly updates: readonly Uint8Array[];
  readonly unpublishedContributors: readonly PageVersionContributor[];
}

export interface RoomCheckpoint {
  readonly generation: string;
  readonly state: Uint8Array;
  readonly revision: number;
  readonly key: string;
  readonly throughSequence: number;
}
export interface RoomStore {
  readonly load: () => Promise<StoredRoomState | null>;
  readonly append: (
    generation: string,
    update: Uint8Array,
    sources: readonly PageVersionContributor[],
  ) => Promise<number>;
  readonly compacted: (input: RoomCheckpoint) => Promise<void>;
  /** The document state compacted at `revision`, when it is still kept. */
  readonly snapshot: (generation: string, revision: number) => Promise<Uint8Array | null>;
  readonly clear: () => Promise<void>;
}

export type RoomWriter =
  | { readonly kind: "local-user" }
  | { readonly kind: "agent"; readonly threadId: string };

/** One immutable publication attempt. No live doc or mutable pending list escapes. */
export interface RoomPublishCut {
  readonly generation: string;
  readonly expectedRevision: number;
  readonly baseContentKey: string;
  readonly richContent: string;
  readonly state: Uint8Array;
  readonly throughSequence: number;
  readonly writer: RoomWriter;
  readonly contributors: readonly PageVersionContributor[];
  readonly contributorClock: number;
  readonly checkpointOnly: boolean;
}
export interface RoomPages {
  readonly read: () => Promise<RoomPageState>;
  /** Publish the Page version + room checkpoint/prune atomically; null means CAS conflict. */
  readonly publish: (cut: RoomPublishCut) => Promise<RoomPageState | null>;
}
export interface FrozenGuestRoom {
  readonly generation: string;
  readonly revision: number;
  readonly pageKey: string;
  readonly sequence: number;
  readonly compactedThrough: number;
  readonly pendingUpdate: Uint8Array | null;
  readonly baselineState: Uint8Array;
  readonly pendingSources: readonly PageVersionContributor[];
  readonly previousSources: readonly PageVersionContributor[];
}
export type GuestRoomCandidate = FrozenGuestRoom & ReturnType<typeof prepareGuestFrame>;
export interface GuestRoomCommit {
  readonly revision: number;
  readonly throughSequence: number;
}
export interface GuestRoomPublication {
  readonly frame: ReturnType<typeof prepareGuestFrame>;
  readonly stored: GuestRoomCommit;
}
export interface PublishedRoomSeed {
  readonly generation: string;
  readonly revision: number;
  readonly key: string;
  readonly state: Uint8Array;
  readonly throughSequence: number;
}
export class PageRoomCloseFailure extends Error {
  constructor(
    readonly hasVolatileUpdates: boolean,
    cause: unknown,
  ) {
    super(
      hasVolatileUpdates
        ? "Page room has updates that were not stored"
        : "Page room journal was stored but publication failed",
      { cause },
    );
  }
}

export interface RoomOptions {
  readonly pageId: string;
  readonly store: RoomStore;
  readonly pages: RoomPages;
  readonly newGeneration: () => string;
  readonly onError?: (message: string, cause: unknown) => void;
  readonly timers?: {
    readonly persistMs?: number;
    readonly compactIdleMs?: number;
    readonly compactMaxMs?: number;
    readonly agentPresenceMs?: number;
  };
}

/** Identifies what a Page held, so the room can tell a title change from an outside edit. */
export function sourceKey(page: Pick<RoomPageState, "richContent" | "content">): string {
  return page.richContent ?? `markdown:${page.content}`;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const outsidePage = Symbol("outside Page revision");
const serverWriter = Symbol("authorized room writer");
const committedGuest = Symbol("already stored guest update");

interface AgentPresence {
  readonly id: string;
  readonly name: string;
  readonly until: number;
}

export class PageRealtimeRoom {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly connections = new Map<RoomConnection, Set<number>>();
  generation: string | null = null;
  private revision = 0;
  private lastSequence = 0;
  private compactedThroughSequence = 0;
  private compactedKey = "";
  private compactedRich = "";
  private pageBaseState: Uint8Array | undefined;
  private resetting = false;
  private pending: { update: Uint8Array; source?: PageVersionContributor | undefined }[] = [];
  private readonly contributors = new RoomContributors();
  private appendInFlight = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private compactTimer: ReturnType<typeof setTimeout> | undefined;
  private dirtySince: number | null = null;
  private lastWriter: RoomWriter = { kind: "local-user" };
  private queue: Promise<unknown> = Promise.resolve();
  private agents = new Map<string, AgentPresence>();
  private agentTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closing = false;
  private awarenessStopped = false;
  private closeAttempt: Promise<void> | undefined;
  private guestHold:
    | { bytes: number; frames: { connection: RoomConnection; frame: Uint8Array }[] }
    | undefined;
  private readonly persistMs: number;
  private readonly compactIdleMs: number;
  private readonly compactMaxMs: number;
  private readonly agentPresenceMs: number;

  constructor(private readonly options: RoomOptions) {
    this.persistMs = options.timers?.persistMs ?? 250;
    this.compactIdleMs = options.timers?.compactIdleMs ?? 4_000;
    this.compactMaxMs = options.timers?.compactMaxMs ?? 45_000;
    this.agentPresenceMs = options.timers?.agentPresenceMs ?? 5_000;
    // The server's own awareness entry carries agent presence only.
    this.awareness.setLocalState(null);
    this.doc.on("update", this.onUpdate);
    this.awareness.on("update", this.onAwareness);
  }

  get seeded(): boolean {
    return this.generation !== null;
  }
  get isClosing(): boolean {
    return this.closing || this.closed;
  }
  get currentRevision(): number {
    return this.revision;
  }

  /** A guest-triggered first open can only hydrate the transactionally verified
   * published checkpoint. It must never run owner recovery/compaction or read a tail. */
  openPublished(seed: PublishedRoomSeed): Promise<void> {
    return this.serial(async () => {
      if (this.isClosing) throw new Error("Page room unavailable");
      Y.applyUpdate(this.doc, seed.state, this);
      if (this.doc.store.pendingStructs || this.doc.store.pendingDs)
        throw new Error("Incomplete published room state");
      this.generation = seed.generation;
      this.revision = seed.revision;
      this.lastSequence = this.compactedThroughSequence = seed.throughSequence;
      this.compactedKey = seed.key;
      this.compactedRich = JSON.stringify(readPageDoc(this.doc));
      this.pageBaseState = seed.state;
    }, false).catch((cause) => {
      this.destroyRoom();
      throw cause;
    });
  }

  /** Loads stored state, folds in any edit made to the Page while the room was closed, or
   * seeds from the Page. A Markdown-only Page waits for its first editor to send a seed. */
  open(): Promise<void> {
    return this.serial(async () => {
      const page = await this.options.pages.read();
      const stored = await this.options.store.load();
      const key = sourceKey(page);
      if (stored) {
        Y.applyUpdate(this.doc, stored.state, this);
        // The baseline is the published state, before replaying the durable journal.
        this.compactedRich = JSON.stringify(readPageDoc(this.doc));
        this.pageBaseState = stored.state;
        this.lastSequence = stored.lastSequence;
        this.compactedThroughSequence = stored.compactedThroughSequence;
        for (const source of stored.unpublishedContributors) this.recordSource(source);
        for (const update of stored.updates) Y.applyUpdate(this.doc, update, this);
        this.generation = stored.generation;
        this.revision = stored.compactedRevision;
        this.compactedKey = stored.compactedKey;
        if (key !== stored.compactedKey) {
          if (page.richContent === null) {
            await this.options.store.clear();
            this.resetDocument();
          } else {
            // Someone wrote the Page outside the room (an older client, a restore). Their edit
            // was made against the compacted state; replay it so later live edits survive.
            this.rebaseOnPage(page.richContent);
            this.compactedKey = key;
          }
        }
        this.revision = Math.max(this.revision, page.revision);
        if (
          !page.trashed &&
          this.generation &&
          (stored.updates.length > 0 || key !== stored.compactedKey)
        )
          await this.compactNow(true);
      }
      if (!this.generation && page.richContent !== null) {
        this.generation = this.options.newGeneration();
        seedPageDoc(this.doc, JSON.parse(page.richContent) as unknown[], this);
        this.revision = page.revision;
        this.compactedKey = key;
        this.compactedRich = JSON.stringify(readPageDoc(this.doc));
        this.pageBaseState = Y.encodeStateAsUpdate(this.doc);
        await this.options.store.compacted({
          generation: this.generation,
          state: this.pageBaseState,
          revision: page.revision,
          key,
          throughSequence: 0,
        });
      }
      if (!this.generation) {
        this.revision = page.revision;
        this.compactedKey = key;
      }
    }).catch((cause) => {
      // No peer is admitted until ready succeeds. Durable source/journal remain available
      // for a later open; release the failed attempt's doc, awareness and timers now.
      this.destroyRoom();
      throw cause;
    });
  }

  private resetDocument() {
    this.doc.off("update", this.onUpdate);
    this.doc.destroy();
    (this as { doc: Y.Doc }).doc = new Y.Doc();
    this.doc.on("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.destroy();
    (this as { awareness: awarenessProtocol.Awareness }).awareness =
      new awarenessProtocol.Awareness(this.doc);
    this.awarenessStopped = false;
    this.awareness.setLocalState(null);
    this.awareness.on("update", this.onAwareness);
    this.generation = null;
    this.lastSequence = 0;
    this.compactedThroughSequence = 0;
    this.compactedRich = "";
    this.pageBaseState = undefined;
    this.pending = [];
    this.contributors.published(this.contributors.cut().clock);
    this.dirtySince = null;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    clearTimeout(this.compactTimer);
    if (this.closing) this.stopAdmission();
  }

  connect(connection: RoomConnection): void {
    if (this.isClosing) {
      connection.close(1013, "room closed");
      return;
    }
    this.connections.set(connection, new Set());
    if (!this.seeded) {
      if (connection.mode === "edit") this.control(connection, { type: "need-seed" });
      return;
    }
    this.greet(connection);
  }

  private greet(connection: RoomConnection) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    connection.send(encoding.toUint8Array(encoder));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) connection.send(this.awarenessMessage(states));
    this.control(connection, { type: "revision", revision: this.revision });
    // Everything in the document is stored; a reconnecting editor clears its pending flag.
    if (!this.pending.length && !this.appendInFlight) {
      this.control(connection, {
        type: "saved",
        stateVector: toBase64(Y.encodeStateVector(this.doc)),
      });
    }
  }

  disconnect(connection: RoomConnection): void {
    const clients = this.connections.get(connection);
    this.connections.delete(connection);
    if (clients?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...clients], null);
  }

  /** Feeds one inbound frame. Returns false for a frame that breaks the protocol. */
  receive(connection: RoomConnection, message: Uint8Array | string): boolean {
    if (this.isClosing || this.resetting || !this.connections.has(connection)) return false;
    if (typeof message === "string") return this.receiveControl(connection, message);
    if (!this.seeded) return true;
    try {
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        if (connection.mode === "view") {
          // A viewer may ask for state but its own updates are dropped.
          if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return true;
          syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        } else {
          // Step1 only reads. For an update/step2, reserve the source budget before
          // y-protocols mutates the document. The actual Y.Doc event records acceptance.
          if (decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) {
            if (this.guestHold) {
              // Keep the exact validated baseline stable while committing. Only writes
              // wait; the owner still receives presence and can request the current state.
              const hold = this.guestHold;
              if (hold.frames.length >= 64 || hold.bytes + message.byteLength > 2 * 1024 * 1024) {
                this.control(connection, {
                  type: "rejected",
                  reason: "页面正在保存，请重新连接以同步更改。",
                });
                return false;
              }
              hold.frames.push({ connection, frame: new Uint8Array(message) });
              hold.bytes += message.byteLength;
              return true;
            }
            try {
              this.contributors.check(localContributor);
            } catch {
              this.control(connection, {
                type: "rejected",
                reason: "当前版本的编辑来源已满，请在保存后重试。",
              });
              return false;
            }
          }
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, connection);
        }
        if (encoding.length(encoder) > 1) connection.send(encoding.toUint8Array(encoder));
        return true;
      }
      if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          connection,
        );
        return true;
      }
      if (type === MESSAGE_QUERY_AWARENESS) {
        connection.send(this.awarenessMessage([...this.awareness.getStates().keys()]));
        return true;
      }
      return false;
    } catch (cause) {
      this.options.onError?.("page realtime frame rejected", cause);
      return false;
    }
  }

  private receiveControl(connection: RoomConnection, text: string): boolean {
    let value: ClientControl;
    try {
      value = JSON.parse(text) as ClientControl;
    } catch {
      return false;
    }
    if (value?.type !== "seed" || typeof value.richContent !== "string") return false;
    if (connection.mode !== "edit") return false;
    void this.serial(async () => {
      if (this.seeded || this.isClosing) return;
      let nodes: unknown;
      try {
        nodes = JSON.parse(value.richContent);
      } catch {
        nodes = null;
      }
      if (!Array.isArray(nodes)) {
        this.control(connection, { type: "rejected", reason: "页面初始内容格式无效。" });
        return;
      }
      const page = await this.options.pages.read();
      this.generation = this.options.newGeneration();
      seedPageDoc(this.doc, nodes, this);
      this.revision = page.revision;
      // The seed is the editor's reading of the Markdown source; nothing changed yet.
      this.compactedKey = sourceKey(page);
      this.compactedRich = JSON.stringify(readPageDoc(this.doc));
      this.pageBaseState = Y.encodeStateAsUpdate(this.doc);
      await this.options.store.compacted({
        generation: this.generation,
        state: this.pageBaseState,
        revision: page.revision,
        key: this.compactedKey,
        throughSequence: 0,
      });
      for (const peer of this.connections.keys()) {
        this.control(peer, { type: "reset", reason: "seeded", generation: this.generation });
      }
    });
    return true;
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    // Guest publication sends its frame only after the SQL commit and all local
    // bookkeeping are complete. It must not append the already durable delta again.
    if (origin === committedGuest) return;
    // Account for this update before broadcasting: a synchronous peer may immediately
    // send its own edit or disconnect. Loading and outside-rebase deltas never add an actor.
    if (origin !== this) {
      const source = this.sourceFor(origin);
      if (source) this.recordSource(source);
      this.pending.push({ update, source });
      this.dirtySince ??= Date.now();
      if (!this.isClosing) {
        this.schedulePersist();
        this.scheduleCompaction();
      }
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const connection of this.connections.keys()) {
      if (connection !== origin) connection.send(message);
    }
  };

  private recordSource(source: PageVersionContributor) {
    this.contributors.accept(source);
    if (source.kind === "agent" || source.kind === "local-user") this.lastWriter = source;
  }

  applyGuestFrame(
    generation: string,
    update: Uint8Array,
    signal: AbortSignal,
    commit: (candidate: GuestRoomCandidate) => Promise<GuestRoomCommit>,
  ): Promise<{ revision: number; applied: boolean }> {
    return this.applyMappedGuestFrame(generation, signal, async (base) => {
      const frame = prepareGuestFrame(base.baselineState, update);
      const stored = await commit({ ...base, ...frame });
      return { frame, stored };
    });
  }

  applyMappedGuestFrame(
    generation: string,
    signal: AbortSignal,
    commit: (base: FrozenGuestRoom) => Promise<GuestRoomPublication>,
  ): Promise<{ revision: number; applied: boolean }> {
    return this.serial(async () => {
      if (signal.aborted || this.isClosing || generation !== this.generation)
        throw new Error("Page room unavailable");
      const hold = { bytes: 0, frames: [] as { connection: RoomConnection; frame: Uint8Array }[] };
      this.guestHold = hold;
      try {
        const baselineState = Y.encodeStateAsUpdate(this.doc);
        const sources = this.contributors.cut();
        const base = {
          baselineState,
          generation,
          revision: this.revision,
          pageKey: this.compactedKey,
          sequence: this.lastSequence,
          compactedThrough: this.compactedThroughSequence,
          pendingUpdate: this.pending.length
            ? Y.mergeUpdates(this.pending.map((entry) => entry.update))
            : null,
          pendingSources: batchContributors(this.pending),
          previousSources: sources.sources,
        };
        const { frame, stored } = await commit(base);
        if (!frame.delta) return { revision: stored.revision, applied: false };
        // From here the transaction is durable, even if the caller stopped waiting.
        Y.applyUpdate(this.doc, frame.delta, committedGuest);
        this.revision = stored.revision;
        this.lastSequence = this.compactedThroughSequence = stored.throughSequence;
        this.compactedKey = this.compactedRich = frame.rich.richContent;
        this.pageBaseState = frame.state;
        this.pending = [];
        this.contributors.published(sources.clock);
        this.dirtySince = null;
        clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
        clearTimeout(this.compactTimer);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, frame.delta);
        const message = encoding.toUint8Array(encoder);
        const vector = toBase64(Y.encodeStateVector(this.doc));
        for (const connection of this.connections.keys()) {
          try {
            connection.send(message);
            this.control(connection, { type: "revision", revision: stored.revision });
            this.control(connection, { type: "saved", stateVector: vector });
          } catch (cause) {
            this.options.onError?.("Page peer missed a committed guest update", cause);
          }
        }
        return { revision: stored.revision, applied: true };
      } finally {
        this.guestHold = undefined;
        for (const { connection, frame } of hold.frames) {
          try {
            if (this.connections.has(connection) && !this.receive(connection, frame))
              connection.close(1003, "unsupported frame");
          } catch (cause) {
            this.options.onError?.("Page peer could not resume its queued update", cause);
          }
        }
      }
    }, false);
  }

  private sourceFor(origin: unknown): PageVersionContributor | undefined {
    if (origin === outsidePage) return undefined;
    if (this.connections.has(origin as RoomConnection)) return localContributor;
    if (origin && typeof origin === "object" && serverWriter in origin)
      return origin[serverWriter] as PageVersionContributor;
    return unrecordedContributor;
  }

  private onAwareness = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const changed = [...change.added, ...change.updated, ...change.removed];
    if (origin && this.connections.has(origin as RoomConnection)) {
      const owned = this.connections.get(origin as RoomConnection)!;
      for (const id of change.added) owned.add(id);
      for (const id of change.removed) owned.delete(id);
    }
    if (!changed.length) return;
    const message = this.awarenessMessage(changed);
    for (const connection of this.connections.keys()) connection.send(message);
  };

  private awarenessMessage(clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    );
    return encoding.toUint8Array(encoder);
  }

  private control(connection: RoomConnection, message: RoomControl) {
    connection.send(JSON.stringify(message));
  }

  private broadcast(message: RoomControl) {
    for (const connection of this.connections.keys()) this.control(connection, message);
  }

  private schedulePersist() {
    if (this.isClosing || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, this.persistMs);
  }

  /** Appends buffered updates. Each saved acknowledgement names the state the server holds. */
  persist(): Promise<void> {
    return this.serial(() =>
      this.persistPendingNow()
        .then(() => undefined)
        .catch((cause) => {
          this.options.onError?.("page realtime update was not stored", cause);
          this.schedulePersist();
        }),
    );
  }

  private scheduleCompaction() {
    if (this.isClosing) return;
    clearTimeout(this.compactTimer);
    const overdue = this.dirtySince !== null && Date.now() - this.dirtySince >= this.compactMaxMs;
    this.compactTimer = setTimeout(
      () =>
        void this.compact().catch((cause) =>
          this.options.onError?.("Page room compaction failed", cause),
        ),
      overdue ? 0 : this.compactIdleMs,
    );
  }

  /** Writes the merged tree as a Page revision when it differs from the last one. */
  compact(): Promise<RoomPageState | null> {
    return this.serial(() => this.compactNow());
  }

  /** Capture state/body/writer synchronously with the pending prefix. Changes arriving during
   * append or publish are left for another cut, never read back into this one.
   */
  private async captureCut(): Promise<RoomPublishCut> {
    const richContent = JSON.stringify(readPageDoc(this.doc));
    const contributors = this.contributors.cut();
    const frozen = {
      generation: this.generation!,
      expectedRevision: this.revision,
      baseContentKey: this.compactedKey,
      state: Y.encodeStateAsUpdate(this.doc),
      richContent,
      writer: { ...this.lastWriter },
      contributors: contributors.sources,
      contributorClock: contributors.clock,
      checkpointOnly: richContent === this.compactedRich && !contributors.sources.length,
    };
    const throughSequence = await this.persistPendingNow();
    return { ...frozen, throughSequence };
  }

  private async compactNow(forceCheckpoint = false): Promise<RoomPageState | null> {
    clearTimeout(this.compactTimer);
    if (!this.generation) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cut = await this.captureCut();
      if (
        !forceCheckpoint &&
        cut.checkpointOnly &&
        cut.throughSequence === this.compactedThroughSequence
      )
        return null;
      const saved = await this.options.pages.publish(cut);
      if (saved) {
        this.revision = saved.revision;
        this.compactedRich = cut.richContent;
        this.compactedKey = sourceKey(saved);
        this.pageBaseState = cut.state;
        this.compactedThroughSequence = cut.throughSequence;
        this.contributors.published(cut.contributorClock);
        if (!this.pending.length) this.dirtySince = null;
        if (!cut.checkpointOnly) this.broadcast({ type: "revision", revision: saved.revision });
        return cut.checkpointOnly ? null : saved;
      }
      // The rejected cut was neither published nor pruned. Build a new cut rather than
      // replacing an old cut's state/author with newer live bytes.
      const page = await this.options.pages.read();
      if (page.trashed) throw new Error("Page was trashed during room publication");
      if (sourceKey(page) !== this.compactedKey) {
        if (page.richContent === null) {
          await this.resetForMarkdown();
          return null;
        }
        this.rebaseOnPage(page.richContent);
        this.compactedKey = sourceKey(page);
        forceCheckpoint = true;
      }
      this.revision = page.revision;
    }
    throw new Error("Page realtime compaction kept conflicting.");
  }

  private async persistPendingNow() {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.pending.length || !this.generation) return this.lastSequence;
    const batch = this.pending;
    // receive() can apply another update while append awaits IO. A saved frontier
    // must describe this batch's cut, never the newer live document after the await.
    const stateVector = toBase64(Y.encodeStateVector(this.doc));
    this.pending = [];
    this.appendInFlight = true;
    try {
      this.lastSequence = await this.options.store.append(
        this.generation,
        Y.mergeUpdates(batch.map((entry) => entry.update)),
        batchContributors(batch),
      );
    } catch (cause) {
      this.pending = batch.concat(this.pending);
      throw cause;
    } finally {
      this.appendInFlight = false;
    }
    this.broadcast({ type: "saved", stateVector });
    return this.lastSequence;
  }

  private async resetForMarkdown() {
    this.resetting = true;
    try {
      await this.options.store.clear();
      this.resetDocument();
      this.broadcast({ type: "reset", reason: "markdown", generation: null });
      for (const connection of this.connections.keys()) connection.close(4409, "page reset");
      this.connections.clear();
    } finally {
      this.resetting = false;
    }
  }

  private rebaseOnPage(richContent: string) {
    if (!this.pageBaseState) throw new Error("Page room has no published baseline");
    const target = JSON.parse(richContent) as unknown[];
    // Diff the outside write against the last Page, never against the newer live doc:
    // the latter would interpret live-only edits as deletions requested by the writer.
    mergePlateEdit({
      doc: this.doc,
      base: this.pageBaseState,
      target,
      origin: outsidePage,
      onTargetState: (state) => {
        this.pageBaseState = state;
      },
    });
    this.compactedRich = JSON.stringify(normalizePlateValue(target));
  }

  /** A Page write from outside any editor (an agent tool, a version restore, an old window).
   * `baseRevision` is the revision the writer read; its edit is replayed against that state so
   * live edits made since are kept. Compacts at once and returns the published revision. */
  applyWrite(input: {
    readonly richContent: string;
    readonly baseRevision: number;
    readonly writer: RoomWriter;
    readonly agentName?: string;
  }): Promise<RoomPageState | null> {
    return this.serial(async () => {
      if (this.isClosing) throw new Error("Page room is closing");
      if (!this.generation) return null;
      if (input.writer.kind === "agent") this.showAgent(input.writer.threadId, input.agentName);
      const base =
        (await this.options.store.snapshot(this.generation, input.baseRevision)) ??
        Y.encodeStateAsUpdate(this.doc);
      const source =
        input.writer.kind === "agent"
          ? { kind: "agent" as const, threadId: ThreadId.makeUnsafe(input.writer.threadId) }
          : localContributor;
      this.contributors.check(source);
      mergePlateEdit({
        doc: this.doc,
        base,
        target: JSON.parse(input.richContent) as unknown[],
        origin: { [serverWriter]: source },
      });
      return this.compactNow();
    });
  }

  /** Tells the room that a write it did not make already landed (for example a version restore)
   * so the live document follows it. */
  followPage(page: RoomPageState): Promise<void> {
    return this.serial(async () => {
      if (this.isClosing) throw new Error("Page room is closing");
      if (!this.generation || page.revision <= this.revision) return;
      if (page.richContent === null) {
        await this.resetForMarkdown();
        return;
      }
      if (sourceKey(page) !== this.compactedKey) {
        this.rebaseOnPage(page.richContent);
        this.compactedKey = sourceKey(page);
        this.revision = page.revision;
        this.broadcast({ type: "revision", revision: page.revision });
        // If independent live changes survived, only a new Page version may name their
        // combined state. Otherwise validate this existing Page revision before pruning.
        await this.compactNow(true);
        return;
      }
      this.revision = page.revision;
      this.broadcast({ type: "revision", revision: page.revision });
    });
  }

  /** Shows an agent in presence for a few seconds, for example while it drafts this page. */
  showAgent(threadId: string, name = "智能体") {
    if (this.isClosing) return;
    this.agents.set(threadId, { id: threadId, name, until: Date.now() + this.agentPresenceMs });
    this.publishAgents();
  }

  private publishAgents() {
    clearTimeout(this.agentTimer);
    const now = Date.now();
    for (const [id, agent] of this.agents) if (agent.until <= now) this.agents.delete(id);
    const agents = [...this.agents.values()].map(({ id, name }) => ({ id, name }));
    this.awareness.setLocalState(agents.length ? { moss: { kind: "agents", agents } } : null);
    if (agents.length) {
      const next = Math.min(...[...this.agents.values()].map((agent) => agent.until)) - now;
      this.agentTimer = setTimeout(() => this.publishAgents(), Math.max(50, next));
    }
  }

  /** Disconnects a viewer who lost access, or everyone when the Page went to the trash. */
  reject(reason: string, filter: (connection: RoomConnection) => boolean = () => true): void {
    for (const connection of [...this.connections.keys()]) {
      if (!filter(connection)) continue;
      this.control(connection, { type: "rejected", reason });
      connection.close(4403, "rejected");
      this.disconnect(connection);
    }
  }

  private stopAdmission() {
    this.closing = true;
    clearTimeout(this.persistTimer);
    clearTimeout(this.compactTimer);
    clearTimeout(this.agentTimer);
    for (const connection of this.connections.keys()) connection.close(1001, "room closing");
    this.connections.clear();
    if (!this.awarenessStopped) {
      this.awarenessStopped = true;
      this.awareness.destroy();
    }
  }
  private destroyRoom() {
    this.stopAdmission();
    if (!this.closed) {
      this.closed = true;
      this.doc.destroy();
    }
  }

  /** A failed volatile prefix must remain in memory for an explicit retry. If its journal
   * is already durable, the next room can replay it even when Page publication failed.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeAttempt) return this.closeAttempt;
    this.stopAdmission();
    this.closeAttempt = this.serial(async () => {
      if (this.closed) return;
      try {
        await this.compactNow();
      } catch (cause) {
        const volatile = this.pending.length > 0;
        if (!volatile) this.destroyRoom();
        throw new PageRoomCloseFailure(volatile, cause);
      }
      this.destroyRoom();
    }).finally(() => {
      this.closeAttempt = undefined;
    });
    return this.closeAttempt;
  }

  private serial<A>(task: () => Promise<A>, logFailure = true): Promise<A> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((cause) => {
      if (logFailure) this.options.onError?.("page realtime task failed", cause);
    });
    return run;
  }
}
