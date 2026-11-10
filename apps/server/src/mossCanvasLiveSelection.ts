// FILE: mossCanvasLiveSelection.ts
// Purpose: What the person has selected on a conversation's Moss Canvas right
//          now, so the agent can read it (moss_canvas_read) the way it reads the
//          browser panel's selected element.
// Layer: Server state (memory only; selection is live UI state, not document data)
//
// The Canvas runs in the desktop window. It reports every selection change to
// the window, which forwards the latest one here. Nothing is written to disk:
// a selection belongs to the open window and is dropped when it closes, the
// thread changes, or it goes stale.

const MAX_THREADS = 256;
const MAX_IMAGES = 16;
const MAX_CONTENT = 32;
const MAX_TEXT_PER_ITEM = 500;
const MAX_TEXT_TOTAL = 8_000;
/** A selection nobody refreshed for this long is no longer what the person sees. */
export const MOSS_CANVAS_SELECTION_TTL_MS = 30 * 60 * 1000;

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHAPE_ID = /^shape:[A-Za-z0-9_.:-]{1,194}$/u;
const IMAGE_ASSET = /^moss-canvas-asset:[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif)$/u;
const CONTENT_KIND = /^[a-z][a-z0-9-]{0,39}$/u;

export interface MossCanvasLiveSelectionImage {
  readonly shapeId: string;
  readonly assetId: string;
  readonly title: string;
}

export interface MossCanvasLiveSelectionContent {
  readonly shapeId: string;
  readonly kind: string;
  readonly text?: string;
}

export interface MossCanvasLiveSelection {
  readonly sequence: number;
  readonly images: readonly MossCanvasLiveSelectionImage[];
  readonly content: readonly MossCanvasLiveSelectionContent[];
  readonly updatedAt: string;
}

interface Entry extends MossCanvasLiveSelection {
  readonly documentEpoch: number;
  readonly updatedAtMs: number;
}

const selections = new Map<string, Entry>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Validate the window's report. Anything malformed is refused as a whole. */
export function parseMossCanvasLiveSelection(value: unknown): {
  readonly documentEpoch: number;
  readonly sequence: number;
  readonly images: MossCanvasLiveSelectionImage[];
  readonly content: MossCanvasLiveSelectionContent[];
} | null {
  const data = record(value);
  if (
    !data ||
    !Number.isSafeInteger(data.documentEpoch) ||
    (data.documentEpoch as number) < 1 ||
    !Number.isSafeInteger(data.sequence) ||
    (data.sequence as number) < 0 ||
    !Array.isArray(data.images) ||
    data.images.length > MAX_IMAGES ||
    !Array.isArray(data.content) ||
    data.content.length > MAX_CONTENT
  )
    return null;
  const images: MossCanvasLiveSelectionImage[] = [];
  for (const raw of data.images) {
    const item = record(raw);
    if (
      !item ||
      typeof item.shapeId !== "string" ||
      !SHAPE_ID.test(item.shapeId) ||
      typeof item.assetId !== "string" ||
      !IMAGE_ASSET.test(item.assetId) ||
      typeof item.title !== "string" ||
      item.title.length > 200
    )
      return null;
    images.push({ shapeId: item.shapeId, assetId: item.assetId, title: item.title });
  }
  const content: MossCanvasLiveSelectionContent[] = [];
  let total = 0;
  for (const raw of data.content) {
    const item = record(raw);
    if (
      !item ||
      typeof item.shapeId !== "string" ||
      !SHAPE_ID.test(item.shapeId) ||
      typeof item.kind !== "string" ||
      !CONTENT_KIND.test(item.kind) ||
      (item.text !== undefined &&
        (typeof item.text !== "string" || item.text.length > MAX_TEXT_PER_ITEM))
    )
      return null;
    total += typeof item.text === "string" ? item.text.length : 0;
    if (total > MAX_TEXT_TOTAL) return null;
    content.push(
      typeof item.text === "string" && item.text
        ? { shapeId: item.shapeId, kind: item.kind, text: item.text }
        : { shapeId: item.shapeId, kind: item.kind },
    );
  }
  return {
    documentEpoch: data.documentEpoch as number,
    sequence: data.sequence as number,
    images,
    content,
  };
}

/**
 * Keep the newest report for a thread. A report from an older document or an
 * older sequence of the same document never replaces a newer one.
 */
export function recordMossCanvasLiveSelection(
  threadId: string,
  value: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (!THREAD_ID.test(threadId)) return false;
  const parsed = parseMossCanvasLiveSelection(value);
  if (!parsed) return false;
  const previous = selections.get(threadId);
  if (
    previous &&
    nowMs - previous.updatedAtMs < MOSS_CANVAS_SELECTION_TTL_MS &&
    (parsed.documentEpoch < previous.documentEpoch ||
      (parsed.documentEpoch === previous.documentEpoch && parsed.sequence < previous.sequence))
  )
    return false;
  selections.delete(threadId);
  selections.set(threadId, {
    ...parsed,
    updatedAtMs: nowMs,
    updatedAt: new Date(nowMs).toISOString(),
  });
  while (selections.size > MAX_THREADS) {
    const oldest = selections.keys().next().value;
    if (oldest === undefined) break;
    selections.delete(oldest);
  }
  return true;
}

/** The window closed its Canvas: there is no live selection any more. */
export function clearMossCanvasLiveSelection(threadId: string): void {
  selections.delete(threadId);
}

/** What the person has selected now, or null when nothing is selected or it went stale. */
export function readMossCanvasLiveSelection(
  threadId: string,
  nowMs: number = Date.now(),
): MossCanvasLiveSelection | null {
  const entry = selections.get(threadId);
  if (!entry) return null;
  if (nowMs - entry.updatedAtMs >= MOSS_CANVAS_SELECTION_TTL_MS) {
    selections.delete(threadId);
    return null;
  }
  if (!entry.images.length && !entry.content.length) return null;
  return {
    sequence: entry.sequence,
    images: entry.images,
    content: entry.content,
    updatedAt: entry.updatedAt,
  };
}

/** Test seam. */
export function resetMossCanvasLiveSelections(): void {
  selections.clear();
}
