import { addWsTransportStateListener } from "../wsTransportEvents";
import { transportNoticeHoldMs } from "./transportLink";

/** What the composer tells the user about its link to Moss; the component words it. */
export type ComposerTransportNoticeKind =
  | "connecting"
  | "reconnecting"
  | "incompatible"
  | "disconnected";

/** Delay outage notices, but clear them immediately on recovery. Only owns UI timers. */
export function subscribeComposerTransportStatus(
  listener: (notice: ComposerTransportNoticeKind | null) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notice: ComposerTransportNoticeKind | null = null;
  let visible = false;
  // Closed/connecting transitions are one continuous outage, not fresh blips.
  let outageStartedAt: number | null = null;
  // Until a connection has existed, Moss is still connecting, not reconnecting.
  let established = false;
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const unsubscribe = addWsTransportStateListener(
    (state) => {
      if (state === "open" || state === "closed") established = true;
      notice =
        state === "open"
          ? null
          : state === "incompatible"
            ? "incompatible"
            : state === "disposed"
              ? "disconnected"
              : established
                ? "reconnecting"
                : "connecting";
      if (notice === null) {
        cancelTimer();
        if (visible) listener(null);
        visible = false;
        outageStartedAt = null;
      } else if (visible) {
        listener(notice);
      } else {
        // Rearm rather than keep the old timer: an incompatible server must not sit out
        // the longer hold that a restart in progress already started.
        const now = Date.now();
        outageStartedAt ??= now;
        cancelTimer();
        timer = setTimeout(
          () => {
            timer = undefined;
            visible = true;
            listener(notice);
          },
          Math.max(0, outageStartedAt + transportNoticeHoldMs(notice) - now),
        );
      }
    },
    { replayCurrent: true },
  );
  return () => {
    unsubscribe();
    cancelTimer();
  };
}
