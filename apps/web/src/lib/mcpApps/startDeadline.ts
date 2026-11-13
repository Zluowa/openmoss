// FILE: startDeadline.ts
// Purpose: The deadline a widget has to say `initialized`. Like Claude's host it only counts time
//          the page was visible: a hidden or throttled window does not use it up, and a timer
//          that fires long after it was due (the page was frozen meanwhile) does not count the
//          gap. A slow widget that is still loading is not failed early (see the constants).
// Layer: Web MCP App host lifecycle
// Exports: createVisibleDeadline, MCP_APP_DEADLINE_LATE_SLACK_MS

/** A timer that fires more than this late was held back by a frozen page; the gap does not count. */
export const MCP_APP_DEADLINE_LATE_SLACK_MS = 5_000;

export interface VisibleDeadlineVisibility {
  readonly isVisible: () => boolean;
  /** Calls `listener` on every visibility change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

function documentVisibility(): VisibleDeadlineVisibility {
  if (typeof document === "undefined") {
    return { isVisible: () => true, subscribe: () => () => undefined };
  }
  return {
    isVisible: () => document.visibilityState !== "hidden",
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/**
 * Calls `onExpire` once `ms` of visible time has passed. `cancel` stops it. Time while the page is
 * hidden is not counted, and neither is the part of a late timer beyond the slack.
 */
export function createVisibleDeadline(input: {
  readonly ms: number;
  readonly onExpire: () => void;
  readonly visibility?: VisibleDeadlineVisibility;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}): { cancel(): void } {
  const visibility = input.visibility ?? documentVisibility();
  const now = input.now ?? (() => Date.now());
  const setTimer = input.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let remaining = Math.max(0, input.ms);
  let timer: unknown = null;
  let runningSince: number | null = null;
  let done = false;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (runningSince !== null) {
      remaining = Math.max(0, remaining - (now() - runningSince));
      runningSince = null;
    }
  };
  const start = () => {
    if (done || timer !== null || !visibility.isVisible()) return;
    const armedAt = now();
    const due = remaining;
    runningSince = armedAt;
    timer = setTimer(() => {
      timer = null;
      runningSince = null;
      const late = now() - armedAt - due;
      if (late > MCP_APP_DEADLINE_LATE_SLACK_MS) {
        // The page was frozen while the timer waited: give the widget its time again.
        remaining = due;
        start();
        return;
      }
      remaining = 0;
      done = true;
      unsubscribe();
      input.onExpire();
    }, due);
  };
  const unsubscribe = visibility.subscribe(() => {
    if (done) return;
    if (visibility.isVisible()) start();
    else stop();
  });
  start();
  return {
    cancel() {
      done = true;
      stop();
      unsubscribe();
    },
  };
}
