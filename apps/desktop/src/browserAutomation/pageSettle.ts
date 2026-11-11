// FILE: pageSettle.ts
// Purpose: Bounded waits for the page effects an agent action started.
// Layer: Desktop browser automation host
// Exports: settlePageSince, SCRIPT_SETTLE_MAX_MS, NAVIGATION_SETTLE_MAX_MS, PageSettleResult
//
// A script that clicks "Save" usually returns before the page has finished
// what the click started. Two things go wrong if the host moves on at once:
// the agent reads the page as it was before the effect, and — because a
// BetterWright run routes the session through its own guard proxy, which
// shuts down with the worker — requests still in flight are cut off. Settling
// waits, within a budget, for a main-frame navigation the action started to
// load and for requests begun since the action's mark to finish. Polling or
// streaming the page already had is not waited for.

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { abortReason, throwIfAborted } from "./cdpRuntime";
import { BrowserAutomationHostError } from "./hostErrors";
import type { BrowserNavigationMark, getBrowserNavigationTracker } from "./navigationTracker";

type NavigationTracker = Awaited<ReturnType<typeof getBrowserNavigationTracker>>;

/** Upper bound for settling after a script; most actions settle far sooner. */
export const SCRIPT_SETTLE_MAX_MS = 2_000;
/** Upper bound for letting a freshly loaded page finish its first requests. */
export const NAVIGATION_SETTLE_MAX_MS = 1_500;
/** Chromium reports a request a few milliseconds after the handler sent it. */
const REQUEST_START_GRACE_MS = 50;
const POLL_INTERVAL_MS = 25;

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export interface PageSettleResult {
  /** A main-frame navigation started after the mark. */
  readonly navigated: boolean;
}

/**
 * Never fails for a page that does not settle in time: the action already
 * happened, and reporting it as failed would invite a duplicate. Only
 * cancellation propagates.
 */
export async function settlePageSince(
  runtime: BrowserAutomationVisibleRuntime,
  tracker: NavigationTracker,
  mark: BrowserNavigationMark,
  budgetMs: number,
  signal: AbortSignal,
): Promise<PageSettleResult> {
  const deadline = performance.now() + Math.max(0, budgetMs);
  const remaining = () => Math.max(0, deadline - performance.now());
  if (remaining() > 0) await delay(Math.min(REQUEST_START_GRACE_MS, remaining()), signal);
  const navigated = tracker.hasNavigationStartedSince(mark);
  if (navigated && remaining() > 0) {
    try {
      await tracker.wait(runtime, "load", remaining(), signal, mark);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (!(error instanceof BrowserAutomationHostError)) throw error;
    }
  }
  while (remaining() > 0 && tracker.pendingRequestsSince(mark) > 0) {
    await delay(Math.min(POLL_INTERVAL_MS, remaining()), signal);
  }
  return { navigated };
}
