import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  refreshSnapshot: vi.fn(),
  waitForFallbackDelay: vi.fn(),
  search: {},
  threadId: "chat",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
      select({ threadId: harness.threadId }),
    useSearch: () => harness.search,
  }),
  useNavigate: () => harness.navigate,
}));

vi.mock("../../chatRouteRecovery", () => ({
  refreshEmptyRouteRestoreSnapshot: harness.refreshSnapshot,
  waitForEmptyRouteRestoreFallbackDelay: harness.waitForFallbackDelay,
}));

vi.mock("../ChatView", () => ({ default: () => null }));

import { useComposerDraftStore } from "../../composerDraftStore";
import { Route } from "../../routes/_chat.$threadId";
import { useSplitViewStore } from "../../splitViewStore";
import { useStore } from "../../store";

const ChatThreadRouteView = Route.options.component!;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function holdZeroDelayTimers() {
  const timerHost: Pick<Window, "setTimeout" | "clearTimeout"> = window;
  const setTimeout = timerHost.setTimeout.bind(timerHost);
  const clearTimeout = timerHost.clearTimeout.bind(timerHost);
  const callbacks = new Map<number, () => void>();
  let nextId = 1_000_000_000;
  const setTimer = vi
    .spyOn(timerHost, "setTimeout")
    .mockImplementation((handler, delay, ...args) => {
      if (delay !== 0 || typeof handler !== "function") {
        return setTimeout(handler, delay, ...args);
      }
      const id = nextId++;
      callbacks.set(id, () => handler(...args));
      return id;
    });
  const clearTimer = vi.spyOn(timerHost, "clearTimeout").mockImplementation((id) => {
    if (id !== undefined && callbacks.delete(id)) return;
    clearTimeout(id);
  });
  return {
    callbacks,
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    restore() {
      callbacks.clear();
      setTimer.mockRestore();
      clearTimer.mockRestore();
    },
  };
}

beforeEach(() => {
  harness.threadId = "chat";
  useStore.setState({
    threadsHydrated: true,
    threadIds: [],
    threadShellById: {},
    threadDetailSyncById: {},
    threadDetailSyncFailureCodeById: {},
  });
  useComposerDraftStore.setState({ draftThreadsByThreadId: {} });
  useSplitViewStore.setState({ hasHydrated: true, splitViewsById: {} });
});

afterEach(() => {
  harness.navigate.mockReset();
  harness.refreshSnapshot.mockReset();
  harness.waitForFallbackDelay.mockReset();
});

describe("missing chat thread route recovery", () => {
  it("ignores a previous thread's completion while the new thread is recovering", async () => {
    const previousSnapshot = deferred<boolean>();
    const currentSnapshot = deferred<boolean>();
    const previousDelay = deferred<void>();
    const currentDelay = deferred<void>();
    harness.refreshSnapshot
      .mockReturnValueOnce(previousSnapshot.promise)
      .mockReturnValueOnce(previousSnapshot.promise)
      .mockReturnValue(currentSnapshot.promise);
    harness.waitForFallbackDelay
      .mockReturnValueOnce(previousDelay.promise)
      .mockReturnValueOnce(previousDelay.promise)
      .mockReturnValue(currentDelay.promise);
    const screen = await render(
      <StrictMode>
        <ChatThreadRouteView />
      </StrictMode>,
    );
    try {
      await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledTimes(2), {
        timeout: 15_000,
      });
      harness.threadId = "next";
      await screen.rerender(
        <StrictMode>
          <ChatThreadRouteView />
        </StrictMode>,
      );
      await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledTimes(3));
      previousSnapshot.resolve(false);
      previousDelay.resolve();
      await Promise.all([previousSnapshot.promise, previousDelay.promise]);
      // Allow the obsolete completion to render if it incorrectly bypasses the run guard.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(harness.navigate).not.toHaveBeenCalled();
      currentSnapshot.resolve(false);
      currentDelay.resolve();
      await vi.waitFor(() =>
        expect(harness.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true }),
      );
    } finally {
      previousSnapshot.resolve(false);
      previousDelay.resolve();
      currentSnapshot.resolve(false);
      currentDelay.resolve();
      await screen.unmount();
    }
  });

  it.each(["empty", "failed"] as const)(
    "does not let a deferred route reset overwrite completed %s recovery",
    async (outcome) => {
      const snapshot = deferred<boolean>();
      const delay = deferred<void>();
      harness.refreshSnapshot.mockReturnValue(snapshot.promise);
      harness.waitForFallbackDelay.mockReturnValue(delay.promise);
      const timers = holdZeroDelayTimers();
      let screen: Awaited<ReturnType<typeof render>> | undefined;
      try {
        screen = await render(
          <StrictMode>
            <ChatThreadRouteView />
          </StrictMode>,
        );
        await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledTimes(2), {
          timeout: 15_000,
        });
        expect(harness.navigate).not.toHaveBeenCalled();
        if (outcome === "failed") snapshot.reject(new Error("Snapshot refresh failed"));
        else snapshot.resolve(false);
        delay.resolve();
        await Promise.all([snapshot.promise.catch(() => false), delay.promise]);
        await Promise.resolve();
        // Recovery completion has cancelled both pending marks. Replay the surviving
        // mount reset before React commits, as a delayed timer can do under load.
        expect(timers.callbacks.size).toBe(1);
        timers.flush();
        await vi.waitFor(() =>
          expect(harness.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true }),
        );
      } finally {
        timers.restore();
        snapshot.resolve(false);
        delay.resolve();
        await screen?.unmount();
      }
    },
  );

  it.each(["empty", "failed"] as const)(
    "falls back after StrictMode effect replay when snapshot recovery is %s",
    async (outcome) => {
      const snapshot = deferred<boolean>();
      const delay = deferred<void>();
      harness.refreshSnapshot.mockReturnValue(snapshot.promise);
      harness.waitForFallbackDelay.mockReturnValue(delay.promise);

      const screen = await render(
        <StrictMode>
          <ChatThreadRouteView />
        </StrictMode>,
      );

      try {
        // Both setups must run before recovery settles to reproduce the development mount.
        await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledTimes(2), {
          timeout: 15_000,
        });
        expect(harness.navigate).not.toHaveBeenCalled();

        if (outcome === "failed") {
          snapshot.reject(new Error("Snapshot refresh failed"));
        } else {
          snapshot.resolve(false);
        }
        await snapshot.promise.catch(() => false);
        expect(harness.navigate).not.toHaveBeenCalled();

        delay.resolve();
        await vi.waitFor(() =>
          expect(harness.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true }),
        );
      } finally {
        snapshot.resolve(false);
        delay.resolve();
        await screen.unmount();
      }
    },
  );
});
