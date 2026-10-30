/** Bounds callbacks before the SDK's non-awaiting receive loop can retain a promise per event. */
export function makeAcpNotificationDispatcher<A>(options: {
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly deliver: (value: A, signal: AbortSignal) => Promise<void>;
  readonly onOverflow: (error: Error) => void;
  readonly onFailure?: (error: unknown) => void;
  readonly onWaiterCountChange?: (count: number) => void;
}) {
  const abortController = new AbortController();
  let tail = Promise.resolve();
  let count = 0;
  let bytes = 0;
  let closedError: Error | undefined;
  let received = 0;
  let settled = 0;
  type DrainWaiter = {
    target: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  };
  const waiters = new Set<DrainWaiter>();
  const removeWaiter = (waiter: DrainWaiter) => {
    if (!waiters.delete(waiter)) return false;
    waiter.cleanup();
    options.onWaiterCountChange?.(waiters.size);
    return true;
  };
  const settleWaiters = () => {
    for (const waiter of waiters) {
      if (!closedError && settled < waiter.target) continue;
      if (!removeWaiter(waiter)) continue;
      if (closedError) waiter.reject(closedError);
      else waiter.resolve();
    }
  };

  const close = (error = new Error("ACP notification dispatcher closed")) => {
    closedError ??= error;
    abortController.abort(closedError);
    settleWaiters();
  };

  const dispatch = (value: A): Promise<void> => {
    if (closedError) return Promise.reject(closedError);
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (count >= options.maxCount || size > options.maxBytes - bytes) {
      const error = new Error("ACP notification backlog exceeded its memory budget");
      close(error);
      options.onOverflow(error);
      return Promise.reject(error);
    }
    count += 1;
    bytes += size;
    const sequence = ++received;
    const delivery = tail
      .then(() => {
        if (closedError) throw closedError;
        return options.deliver(value, abortController.signal);
      })
      .catch((error: unknown) => {
        if (options.onFailure) {
          close(error instanceof Error ? error : new Error(String(error)));
          options.onFailure(error);
        }
        throw error;
      })
      .finally(() => {
        count -= 1;
        bytes -= size;
        settled = sequence;
        settleWaiters();
      });
    tail = delivery.catch(() => undefined);
    return delivery;
  };

  // A response owns a finite notification prefix. Later updates must never
  // extend its wait, and interruption must remove the waiter immediately.
  const drain = (signal?: AbortSignal, target = received): Promise<void> => {
    if (closedError) return Promise.reject(closedError);
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("ACP session/update drain was aborted"));
    if (settled >= target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (removeWaiter(waiter))
          reject(signal?.reason ?? new Error("ACP session/update drain was aborted"));
      };
      const waiter = {
        target,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      options.onWaiterCountChange?.(waiters.size);
      if (signal?.aborted) onAbort();
    });
  };

  return {
    dispatch,
    drain,
    close,
    status: () => ({ count, bytes, closed: closedError !== undefined }),
  };
}
