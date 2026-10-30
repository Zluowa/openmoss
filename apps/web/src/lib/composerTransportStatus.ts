import { addWsTransportStateListener } from "../wsTransportEvents";

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
      } else if (visible) {
        listener(notice);
      } else if (timer === undefined) {
        // Closed/connecting transitions are one continuous outage, not fresh blips.
        timer = setTimeout(() => {
          timer = undefined;
          visible = true;
          listener(notice);
        }, 1500);
      }
    },
    { replayCurrent: true },
  );
  return () => {
    unsubscribe();
    cancelTimer();
  };
}
