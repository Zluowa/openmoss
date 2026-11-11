// FILE: guardedRequests.ts
// Purpose: Track the browser session's requests sent while a run's guard proxy
//          is installed, so the worker serving that proxy outlives them.
// Layer: Desktop browser automation host
// Exports: GuardedRequestTracker, GuardedRequestSet
// Why: A BetterWright run routes the whole shared session — every tab, not
//      only the agent's — through its worker's SOCKS guard. Releasing the
//      proxy affects only new connections, but the worker exiting cuts every
//      connection still flowing through it, so a request any tab started
//      during the run would fail. The session's own request events tell which
//      requests those are, from any tab, with no CDP attachment.

import type { Session } from "electron";

/** Bounds bookkeeping when a page fires requests faster than they finish. */
const MAX_TRACKED_REQUESTS = 4_096;

export interface GuardedRequestSet {
  /** Requests recorded during the lease that are still in flight. */
  readonly size: number;
  /**
   * Resolves once every recorded request has finished, `maxMs` passes, or the
   * signal aborts. Never rejects: callers close the worker after it.
   */
  drained(maxMs: number, signal?: AbortSignal): Promise<void>;
}

interface Drain {
  readonly ids: Set<number>;
  readonly settle: () => void;
}

export class GuardedRequestTracker {
  private recording: Set<number> | undefined;
  private readonly releasedSets = new Set<Set<number>>();
  private readonly drains = new Set<Drain>();
  private listening = false;

  constructor(private readonly browserSession: Session) {}

  /** Start recording requests; idempotent while a lease is installed. */
  begin(): void {
    this.recording ??= new Set();
    this.listen();
  }

  /** Stop recording and hand back what is still in flight. */
  end(): GuardedRequestSet {
    const ids = this.recording ?? new Set<number>();
    this.recording = undefined;
    if (ids.size > 0) this.releasedSets.add(ids);
    this.unlistenWhenIdle();
    return {
      get size() {
        return ids.size;
      },
      drained: (maxMs, signal) => this.drain(ids, maxMs, signal),
    };
  }

  private drain(ids: Set<number>, maxMs: number, signal?: AbortSignal): Promise<void> {
    if (ids.size === 0 || signal?.aborted) return this.forget(ids);
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.drains.delete(drain);
        void this.forget(ids).then(resolve);
      };
      const drain: Drain = { ids, settle: finish };
      const timer = setTimeout(finish, Math.max(0, maxMs));
      signal?.addEventListener("abort", finish, { once: true });
      this.drains.add(drain);
    });
  }

  private forget(ids: Set<number>): Promise<void> {
    this.releasedSets.delete(ids);
    this.unlistenWhenIdle();
    return Promise.resolve();
  }

  private readonly onSent = (details: { readonly id: number }) => {
    const recording = this.recording;
    if (!recording || recording.size >= MAX_TRACKED_REQUESTS) return;
    recording.add(details.id);
  };

  private readonly onFinished = (details: { readonly id: number }) => {
    this.recording?.delete(details.id);
    for (const ids of this.releasedSets) {
      ids.delete(details.id);
      if (ids.size === 0) this.releasedSets.delete(ids);
    }
    // Settling deletes from the set; a Set iterator tolerates that.
    for (const drain of this.drains) {
      if (drain.ids.size === 0) drain.settle();
    }
    this.unlistenWhenIdle();
  };

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    // Notification-only events: unlike onBeforeRequest they never hold a
    // request for a main-process round trip.
    this.browserSession.webRequest.onSendHeaders(this.onSent);
    this.browserSession.webRequest.onCompleted(this.onFinished);
    this.browserSession.webRequest.onErrorOccurred(this.onFinished);
  }

  private unlistenWhenIdle(): void {
    if (!this.listening || this.recording || this.releasedSets.size > 0) return;
    this.listening = false;
    this.browserSession.webRequest.onSendHeaders(null);
    this.browserSession.webRequest.onCompleted(null);
    this.browserSession.webRequest.onErrorOccurred(null);
  }
}
