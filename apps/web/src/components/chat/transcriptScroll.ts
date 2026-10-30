import type { LegendListRef } from "@legendapp/list/react";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";

/**
 * LegendList expects a fraction of viewport height. The follow window is the
 * wider of the 24px floor and 10% of the viewport: settle-time growth (the
 * completed message's footer row and work folding, ~40px+) must not drop the
 * pin of a reader who never scrolled away.
 */
export function transcriptFollowThreshold(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  return Math.max(AUTO_SCROLL_BOTTOM_THRESHOLD_PX / viewportHeight, 0.1);
}

export type TranscriptScrollTarget = Pick<LegendListRef, "scrollToEnd">;
export type TranscriptScrollCancellationTarget = Pick<
  LegendListRef,
  "getScrollableNode" | "scrollToOffset"
>;

/** Stop an in-flight native smooth scroll without changing the visible offset. */
export function stopTranscriptScrollAtCurrentOffset(
  target: TranscriptScrollCancellationTarget,
): Promise<void> {
  const scrollNode = target.getScrollableNode();
  const offset = scrollNode.scrollTop;
  // Cancel the browser's native smooth animation immediately. The LegendList
  // call below then clears its imperative-scroll bookkeeping at the same spot.
  scrollNode.scrollTo({ top: offset, behavior: "auto" });
  return target.scrollToOffset({
    offset,
    animated: false,
  });
}

/** How long the just-sent message takes to glide up to its anchored position. */
export const ANCHOR_SLIDE_DURATION_MS = 320;
/**
 * Maximum animation time one painted frame may consume. When the renderer is
 * starved, advancing by the full wall-clock gap would skip every intermediate
 * position and turn the glide into a visible teleport. Capping only the
 * painted-frame clock keeps normal 60 Hz timing unchanged while stretching a
 * low-frame-rate glide across enough visible frames to remain a glide.
 */
export const ANCHOR_SLIDE_MAX_FRAME_ADVANCE_MS = 112;

export function advanceAnchorSlideElapsedMs(input: {
  readonly elapsedMs: number;
  readonly frameDeltaMs: number;
  readonly durationMs?: number;
  readonly maxFrameAdvanceMs?: number;
}): number {
  const durationMs = Math.max(0, input.durationMs ?? ANCHOR_SLIDE_DURATION_MS);
  const maxFrameAdvanceMs = Math.max(
    0,
    input.maxFrameAdvanceMs ?? ANCHOR_SLIDE_MAX_FRAME_ADVANCE_MS,
  );
  const frameDeltaMs = Math.min(Math.max(0, input.frameDeltaMs), maxFrameAdvanceMs);
  return Math.min(durationMs, Math.max(0, input.elapsedMs) + frameDeltaMs);
}

/**
 * Where the anchored message sits, measured from the viewport top, this far into
 * its slide. The animation is expressed in the message's own visible offset —
 * not in scrollTop — because that is the thing the reader watches move, and it
 * stays correct while the transcript's scroll geometry changes underneath it
 * (the list reserving end space, rows above settling from estimated to measured
 * heights). The caller converts the offset back into a scroll position against
 * freshly measured layout each frame.
 *
 * Cubic ease-out: quick departure, soft arrival, and — unlike an exponential
 * approach — it lands exactly at `toPx` at a known time instead of trailing off
 * asymptotically.
 */
export function anchorSlideOffsetPx(input: {
  readonly fromPx: number;
  readonly toPx: number;
  readonly elapsedMs: number;
  readonly durationMs?: number;
}): number {
  const durationMs = input.durationMs ?? ANCHOR_SLIDE_DURATION_MS;
  if (!(durationMs > 0) || input.elapsedMs >= durationMs) {
    return input.toPx;
  }
  const progress = Math.max(0, input.elapsedMs) / durationMs;
  const eased = 1 - (1 - progress) ** 3;
  return input.fromPx + (input.toPx - input.fromPx) * eased;
}

/**
 * A smooth virtual-list jump can finish using estimated row sizes, before the
 * newly mounted tail rows have reported their real height. Re-issuing the jump
 * without animation after that first request settles uses those measurements
 * and lands on the actual end. The current-target guard prevents a completed
 * request from moving a replacement list after a thread switch or user scroll.
 */
export async function scrollTranscriptToSettledEnd(input: {
  readonly target: TranscriptScrollTarget;
  readonly isCurrent: () => boolean;
  readonly animated?: boolean;
  readonly beforeFinalScroll?: () => void;
}): Promise<boolean> {
  await input.target.scrollToEnd({ animated: input.animated ?? true });
  if (!input.isCurrent()) {
    return false;
  }

  input.beforeFinalScroll?.();
  await input.target.scrollToEnd({ animated: false });
  return input.isCurrent();
}
