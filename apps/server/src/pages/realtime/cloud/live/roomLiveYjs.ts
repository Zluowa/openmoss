import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as awareness from "y-protocols/awareness";
import {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  type PageRealtimeRoom,
  type RoomConnection,
} from "../../PageRealtimeRoom";
import { reject } from "../control/roomControlProtocol";
import type { LiveMode } from "./roomLiveAdmission";

export type LiveKind = "sync" | "awareness";
type Emit = (kind: LiveKind, bytes: Uint8Array) => void;
type Apply = () => void;
export interface LiveRoomAdapter {
  readonly awarenessId: number;
  open(emit: Emit, remoteId: number, mode: LiveMode, stop: () => void): void;
  stage(kind: LiveKind, bytes: Uint8Array): Apply;
  close(): void;
}
const MAX_STATE = 2 * 1024 * 1024;
export const MAX_LIVE_BYTES = 64 * 1024;
function yFrame(write: (e: encoding.Encoder) => void, type = MESSAGE_SYNC): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}
function parse(kind: LiveKind, bytes: Uint8Array, remoteId: number) {
  if (!bytes.length || bytes.length > MAX_LIVE_BYTES) return reject();
  const d = decoding.createDecoder(bytes);
  if (decoding.readVarUint(d) !== (kind === "sync" ? MESSAGE_SYNC : MESSAGE_AWARENESS))
    return reject();
  const sub = kind === "sync" ? decoding.readVarUint(d) : -1,
    data = decoding.readVarUint8Array(d);
  if (decoding.hasContent(d) || !data.length) return reject();
  if (kind === "sync") {
    if (sub === sync.messageYjsSyncStep1) {
      const vector = Y.decodeStateVector(data);
      if (vector.size > 2048 || data.length > 20_480) return reject();
      for (const [id, clock] of vector)
        if (id > 0xffff_ffff || !Number.isSafeInteger(clock) || clock < 0) return reject();
    } else if (sub !== sync.messageYjsSyncStep2 && sub !== sync.messageYjsUpdate) return reject();
  } else {
    const a = decoding.createDecoder(data);
    if (
      data.length > 4096 ||
      decoding.readVarUint(a) !== 1 ||
      decoding.readVarUint(a) !== remoteId ||
      !Number.isSafeInteger(decoding.readVarUint(a))
    )
      return reject();
    const state = JSON.parse(decoding.readVarString(a));
    if (
      decoding.hasContent(a) ||
      (state !== null && (typeof state !== "object" || Array.isArray(state)))
    )
      return reject();
  }
  return { sub, data };
}
// Validate a bounded update on a detached replica before consuming replay state.
// A delta with unresolved dependencies requires a fresh sync, not a deferred write
// after its sender's authorization has expired.
function stageDelta(doc: Y.Doc, data: Uint8Array) {
  const update = Y.decodeUpdate(data);
  if (update.structs.length > 8192 || update.ds.clients.size > 512) return reject();
  let span = 0;
  for (const s of update.structs) span += s.length;
  for (const ranges of update.ds.clients.values()) for (const r of ranges) span += r.len;
  if (!Number.isSafeInteger(span) || span > 2 * 1024 * 1024) return reject();
  const baseline = Y.encodeStateAsUpdate(doc);
  if (baseline.length > MAX_STATE) return reject();
  const scratch = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(scratch, baseline);
    Y.applyUpdate(scratch, data);
    if (
      scratch.store.pendingStructs ||
      scratch.store.pendingDs ||
      scratch.getSubdocs().size ||
      Y.encodeStateAsUpdate(scratch).length > MAX_STATE
    )
      return reject();
  } finally {
    scratch.destroy();
  }
}
function removeRemote(state: awareness.Awareness, remote: number | undefined) {
  if (remote !== undefined && state.getStates().has(remote))
    awareness.removeAwarenessStates(state, [remote], null);
}
export function peerYjsAdapter(
  doc: Y.Doc,
  state: awareness.Awareness,
  localMode: LiveMode,
): LiveRoomAdapter {
  if (state.doc !== doc) return reject();
  const origin = Object.freeze({});
  let emit: Emit | undefined, remote: number | undefined;
  const onUpdate = (delta: Uint8Array, source: unknown) => {
    if (source !== origin && localMode === "edit")
      emit?.(
        "sync",
        yFrame((e) => sync.writeUpdate(e, delta)),
      );
  };
  const sendPresence = () =>
    emit?.(
      "awareness",
      yFrame(
        (e) =>
          encoding.writeVarUint8Array(e, awareness.encodeAwarenessUpdate(state, [state.clientID])),
        MESSAGE_AWARENESS,
      ),
    );
  const onPresence = (
    change: { added: number[]; updated: number[]; removed: number[] },
    source: unknown,
  ) => {
    if (
      source !== origin &&
      [...change.added, ...change.updated, ...change.removed].includes(state.clientID)
    )
      sendPresence();
  };
  return {
    awarenessId: state.clientID,
    open(send, id) {
      if (emit) return reject();
      emit = send;
      remote = id;
      doc.on("update", onUpdate);
      state.on("update", onPresence);
      emit(
        "sync",
        yFrame((e) => sync.writeSyncStep1(e, doc)),
      );
      if (state.getLocalState() !== null) sendPresence();
    },
    stage(kind, bytes) {
      if (!emit || remote === undefined) return reject();
      const { sub, data } = parse(kind, bytes, remote);
      if (kind === "awareness") return () => awareness.applyAwarenessUpdate(state, data, origin);
      if (sub === sync.messageYjsSyncStep1)
        return () => {
          if (localMode === "edit")
            emit?.(
              "sync",
              yFrame((e) => sync.writeSyncStep2(e, doc, data)),
            );
        };
      stageDelta(doc, data);
      return () => Y.applyUpdate(doc, data, origin);
    },
    close() {
      doc.off("update", onUpdate);
      state.off("update", onPresence);
      emit = undefined;
      removeRemote(state, remote);
      remote = undefined;
    },
  };
}
/** A distinct authenticated RoomConnection drives the real local room. Its
 * original persistence/compaction emits saved only at the actual durable cut. */
export function ownerYjsAdapter(room: PageRealtimeRoom, generation: string): LiveRoomAdapter {
  let connection: RoomConnection | undefined, remote: number | undefined;
  const current = () => {
    if (room.isClosing || room.generation !== generation || !room.seeded) return reject();
  };
  return {
    awarenessId: room.awareness.clientID,
    open(emit, id, mode, stop) {
      current();
      if (connection) return reject();
      remote = id;
      connection = {
        mode,
        close: () => stop(),
        send(message) {
          if (typeof message === "string") {
            const control = JSON.parse(message);
            if (
              control.type === "reset" ||
              control.type === "rejected" ||
              control.type === "need-seed"
            )
              stop();
            return; // No cloud persistence acknowledgement is synthesized from room controls.
          }
          const d = decoding.createDecoder(message),
            type = decoding.readVarUint(d);
          if (type === MESSAGE_SYNC) {
            emit("sync", message);
            return;
          }
          if (type === MESSAGE_AWARENESS) {
            // Only this endpoint's own awareness ID may be attributed to its signing key.
            const raw = decoding.readVarUint8Array(d),
              inner = decoding.createDecoder(raw),
              n = decoding.readVarUint(inner);
            if (n > 512) return;
            for (let i = 0; i < n; i++) {
              const id = decoding.readVarUint(inner);
              decoding.readVarUint(inner);
              decoding.readVarString(inner);
              if (id === room.awareness.clientID) {
                emit(
                  "awareness",
                  yFrame(
                    (e) =>
                      encoding.writeVarUint8Array(
                        e,
                        awareness.encodeAwarenessUpdate(room.awareness, [id]),
                      ),
                    MESSAGE_AWARENESS,
                  ),
                );
                return;
              }
            }
          }
        },
      };
      room.connect(connection);
    },
    stage(kind, bytes) {
      current();
      if (!connection || remote === undefined) return reject();
      const { sub, data } = parse(kind, bytes, remote);
      if (kind === "sync" && sub !== sync.messageYjsSyncStep1) {
        if (connection.mode !== "edit") return reject();
        stageDelta(room.doc, data);
      }
      const c = connection;
      return () => {
        current();
        if (!room.receive(c, bytes)) return reject();
      };
    },
    close() {
      const c = connection;
      connection = undefined;
      if (c) room.disconnect(c);
      removeRemote(room.awareness, remote);
      remote = undefined;
    },
  };
}
