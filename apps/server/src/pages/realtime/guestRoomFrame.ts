import { parsePageRichContent } from "@moss/shared/pageRichContent";
import * as Y from "yjs";
import { PAGE_YJS_ROOT, readPageDoc } from "./pageYjsContent";

export const GUEST_FRAME_LIMIT = 256 * 1024;
export const GUEST_ROOM_STATE_LIMIT = 8 * 1024 * 1024;
const maxStructs = 8192;
const maxClockSpan = 256 * 1024;

export class InvalidGuestFrame extends Error {}
const invalid = () => new InvalidGuestFrame("Invalid guest Page update");

/** Decode v1 deltas before applying them to a disposable clone. An unintegrated
 * struct/delete must never become a deferred write outside this authorization. */
export function prepareGuestFrame(baseline: Uint8Array, update: Uint8Array) {
  if (
    !update.length ||
    update.length > GUEST_FRAME_LIMIT ||
    baseline.length > GUEST_ROOM_STATE_LIMIT
  )
    throw invalid();
  const scratch = new Y.Doc();
  try {
    const decoded = Y.decodeUpdate(update);
    if (decoded.structs.length > maxStructs || decoded.ds.clients.size > 128) throw invalid();
    let span = 0;
    const clients = new Set(decoded.ds.clients.keys());
    for (const struct of decoded.structs) {
      if (!Number.isSafeInteger(struct.id.clock + struct.length) || struct.length <= 0)
        throw invalid();
      clients.add(struct.id.client);
      span += struct.length;
    }
    if (
      clients.size > 128 ||
      [...clients].some((id) => !Number.isInteger(id) || id < 0 || id > 0xffff_ffff)
    )
      throw invalid();
    let ranges = 0;
    for (const deletions of decoded.ds.clients.values()) {
      ranges += deletions.length;
      for (const deletion of deletions) {
        if (!Number.isSafeInteger(deletion.clock + deletion.len) || deletion.len <= 0)
          throw invalid();
        span += deletion.len;
      }
    }
    if (ranges > maxStructs || span > maxClockSpan) throw invalid();
    Y.applyUpdate(scratch, baseline);
    const previous = JSON.stringify(readPageDoc(scratch));
    if (scratch.store.pendingStructs || scratch.store.pendingDs) throw invalid();
    const applied: Uint8Array[] = [];
    scratch.on("update", (delta: Uint8Array) => applied.push(delta));
    Y.applyUpdate(scratch, update);
    if (
      scratch.store.pendingStructs ||
      scratch.store.pendingDs ||
      scratch.getSubdocs().size ||
      scratch.share.size !== 1 ||
      !scratch.share.has(PAGE_YJS_ROOT)
    )
      throw invalid();
    const rich = parsePageRichContent(JSON.stringify(readPageDoc(scratch)));
    const state = Y.encodeStateAsUpdate(scratch);
    if (state.length > GUEST_ROOM_STATE_LIMIT) throw invalid();
    // Keep only the integrated, re-encoded delta; no opaque trailing bytes from the input.
    const delta =
      applied.length === 0 ? null : applied.length === 1 ? applied[0]! : Y.mergeUpdates(applied);
    if (delta && delta.length > GUEST_FRAME_LIMIT) throw invalid();
    return { previous, rich, state, delta };
  } catch {
    throw invalid();
  } finally {
    scratch.destroy();
  }
}
