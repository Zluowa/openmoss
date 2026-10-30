import { StrictMode, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  createFreshChat: vi.fn(),
  navigate: vi.fn(),
  refreshSnapshot: vi.fn(),
  waitForFallbackDelay: vi.fn(),
  threadStore: {
    threadsHydrated: true,
    threadIds: [] as string[],
  },
  threadStoreListeners: new Set<() => void>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => harness.navigate,
}));

vi.mock("../chatRouteRecovery", () => ({
  refreshEmptyRouteRestoreSnapshot: harness.refreshSnapshot,
  waitForEmptyRouteRestoreFallbackDelay: harness.waitForFallbackDelay,
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => undefined,
}));

vi.mock("../splitViewStore", () => ({
  useSplitViewStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ hasHydrated: true, splitViewsById: {} }),
}));

vi.mock("../store", () => ({
  EMPTY_THREAD_IDS: [],
  useStore: (selector: (state: typeof harness.threadStore) => unknown) =>
    useSyncExternalStore(
      (listener) => {
        harness.threadStoreListeners.add(listener);
        return () => harness.threadStoreListeners.delete(listener);
      },
      () => selector(harness.threadStore),
      () => selector(harness.threadStore),
    ),
}));

vi.mock("./Sidebar.uiState", () => ({
  readSidebarUiState: () => ({ lastThreadRoute: { threadId: "thread-stale" } }),
}));

vi.mock("./SplashScreen", () => ({
  SplashScreen: () => <div data-testid="splash" />,
}));

import { RestoreOrCreateChatRoute } from "./RestoreOrCreateChatRoute";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setThreadIds(threadIds: string[]) {
  harness.threadStore = { ...harness.threadStore, threadIds };
  for (const listener of harness.threadStoreListeners) listener();
}

afterEach(() => {
  harness.createFreshChat.mockReset();
  harness.navigate.mockReset();
  harness.refreshSnapshot.mockReset();
  harness.waitForFallbackDelay.mockReset();
  harness.threadStore = { threadsHydrated: true, threadIds: [] };
  harness.threadStoreListeners.clear();
});

describe("RestoreOrCreateChatRoute", () => {
  it("releases pending recovery after a repaired thread is transiently added then removed", async () => {
    const firstRecovery = deferred<boolean>();
    const successorRecovery = deferred<boolean>();
    harness.refreshSnapshot
      .mockImplementationOnce(() => firstRecovery.promise)
      .mockImplementationOnce(() => successorRecovery.promise);
    harness.waitForFallbackDelay.mockResolvedValue(undefined);
    harness.createFreshChat.mockResolvedValue({ ok: true, threadId: null });

    const screen = await render(
      <StrictMode>
        <RestoreOrCreateChatRoute
          resolveRestoreRoute={() =>
            harness.threadStore.threadIds.length > 0 ? { threadId: "thread-stale" } : null
          }
          createFreshChat={harness.createFreshChat}
        />
      </StrictMode>,
    );

    try {
      await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledTimes(1));

      setThreadIds(["thread-stale"]);
      await vi.waitFor(() => expect(harness.navigate).toHaveBeenCalled());
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      setThreadIds([]);
      await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledTimes(2));

      firstRecovery.resolve(false);
      await vi.waitFor(() => expect(harness.createFreshChat).toHaveBeenCalledTimes(1));
    } finally {
      successorRecovery.resolve(false);
      await screen.unmount();
    }
  });

  it("navigates to a persisted kanban target without minting a fresh chat", async () => {
    harness.waitForFallbackDelay.mockResolvedValue(undefined);
    harness.refreshSnapshot.mockResolvedValue(false);
    harness.createFreshChat.mockResolvedValue({ ok: true, threadId: null });
    harness.threadStore = { ...harness.threadStore, threadIds: ["thread-live"] };

    const screen = await render(
      <StrictMode>
        <RestoreOrCreateChatRoute
          resolveRestoreRoute={() => ({ kind: "kanban", projectId: "project-kanban" })}
          createFreshChat={harness.createFreshChat}
        />
      </StrictMode>,
    );

    try {
      await vi.waitFor(() =>
        expect(harness.navigate).toHaveBeenCalledWith({
          to: "/kanban/$projectId",
          params: { projectId: "project-kanban" },
          replace: true,
        }),
      );
      expect(harness.createFreshChat).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("bypasses an existing remembered thread after authentication", async () => {
    harness.waitForFallbackDelay.mockResolvedValue(undefined);
    harness.refreshSnapshot.mockResolvedValue(false);
    harness.createFreshChat.mockResolvedValue({ ok: true, threadId: null });
    harness.threadStore = { ...harness.threadStore, threadIds: ["thread-stale"] };
    const resolveRestoreRoute = vi.fn(() => ({ threadId: "thread-stale" }));

    const screen = await render(
      <StrictMode>
        <RestoreOrCreateChatRoute
          resolveRestoreRoute={resolveRestoreRoute}
          createFreshChat={harness.createFreshChat}
          forceFreshChat
        />
      </StrictMode>,
    );

    try {
      await vi.waitFor(() => expect(harness.createFreshChat).toHaveBeenCalledTimes(1));
      expect(resolveRestoreRoute).not.toHaveBeenCalled();
      expect(harness.refreshSnapshot).not.toHaveBeenCalled();
      expect(harness.navigate).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
