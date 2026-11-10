import { parsePageRichContent } from "@moss/shared/pageRichContent";
import * as Y from "yjs";
import { copyOrdinaryByteView } from "../realtime/ordinaryByteView";
import {
  GUEST_FRAME_LIMIT,
  GUEST_ROOM_STATE_LIMIT,
  prepareGuestFrame,
} from "../realtime/guestRoomFrame";
import { applyPlateValue, readPageDoc, seedPageDoc } from "../realtime/pageYjsContent";

export type ProjectionFailure =
  | "unavailable"
  | "conflict"
  | "unsupported"
  | "invalid"
  | "rate-limited";
export class GuestProjectionError extends Error {
  constructor(readonly code: ProjectionFailure) {
    super(code);
  }
}

export const safeSeedLimit = GUEST_FRAME_LIMIT;
const markKeys = ["bold", "italic", "underline", "strikethrough", "code"] as const;

/** Only the published editor subset is serializable. Unknown structure cannot be
 * silently removed when a guest later writes the projected document back. */
export function visibleParagraphs(richContent: string) {
  if (
    typeof richContent !== "string" ||
    richContent.length > safeSeedLimit ||
    Buffer.byteLength(richContent) > safeSeedLimit
  )
    throw new GuestProjectionError("unsupported");
  try {
    const nodes = parsePageRichContent(richContent).nodes;
    if (!nodes.length || nodes.length > 512) throw new Error();
    return nodes.map((node) => {
      if (
        node.type !== "p" ||
        !Array.isArray(node.children) ||
        !node.children.length ||
        Object.keys(node).some((key) => key !== "type" && key !== "children")
      )
        throw new Error();
      const children = node.children.map((leaf) => {
        if (
          typeof leaf.text !== "string" ||
          Object.keys(leaf).some(
            (key) => key !== "text" && !markKeys.includes(key as (typeof markKeys)[number]),
          )
        )
          throw new Error();
        const text: Record<string, unknown> = { text: leaf.text };
        for (const mark of markKeys) {
          if (leaf[mark] === undefined) continue;
          if (typeof leaf[mark] !== "boolean") throw new Error();
          text[mark] = leaf[mark];
        }
        return text;
      });
      return { type: "p", children };
    });
  } catch {
    throw new GuestProjectionError("unsupported");
  }
}

export function safeSeed(richContent: string) {
  const visible = visibleParagraphs(richContent);
  const fresh = new Y.Doc();
  try {
    seedPageDoc(fresh, visible);
    const seed = Y.encodeStateAsUpdate(fresh);
    if (seed.length > safeSeedLimit) throw new GuestProjectionError("unsupported");
    return { seed, content: JSON.stringify(visible) };
  } finally {
    fresh.destroy();
  }
}

/** This state stays on the owner. Never return this buffer to the remote caller. */
export function checkedOwnerBase(state: unknown, publicContent: string) {
  const bytes = copyOrdinaryByteView(state, GUEST_ROOM_STATE_LIMIT, 1);
  if (!bytes) throw new GuestProjectionError("unavailable");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    if (
      doc.store.pendingStructs ||
      doc.store.pendingDs ||
      JSON.stringify(visibleParagraphs(JSON.stringify(readPageDoc(doc)))) !== publicContent
    )
      throw new Error();
    return bytes;
  } catch {
    throw new GuestProjectionError("conflict");
  } finally {
    doc.destroy();
  }
}

/** Interpret guest IDs only against the fresh guest seed. Translate the resulting
 * visible Slate edit onto the unchanged owner baseline and retain only new local ops. */
export function mappedOwnerDelta(
  seed: Uint8Array,
  request: Uint8Array,
  exactOwnerBase: Uint8Array,
) {
  try {
    const candidate = prepareGuestFrame(seed, request);
    const target = visibleParagraphs(candidate.rich.richContent);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, exactOwnerBase);
      if (doc.share.size !== 1 || doc.getSubdocs().size)
        throw new GuestProjectionError("unsupported");
      const updates: Uint8Array[] = [];
      doc.on("update", (value: Uint8Array) => updates.push(value));
      applyPlateValue(doc, target, null);
      const mapped = updates.length ? Y.mergeUpdates(updates) : null;
      if (mapped && mapped.length > GUEST_FRAME_LIMIT)
        throw new GuestProjectionError("unsupported");
      return mapped;
    } finally {
      doc.destroy();
    }
  } catch (cause) {
    if (cause instanceof GuestProjectionError) throw cause;
    throw new GuestProjectionError("invalid");
  }
}
