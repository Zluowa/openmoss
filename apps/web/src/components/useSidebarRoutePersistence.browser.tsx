// FILE: useSidebarRoutePersistence.browser.tsx
// Purpose: Browser regression for quitting before deferred route-state settlement.
// Layer: Web browser test

import { ProjectId, ThreadId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { LastThreadRoute, SafeMainNavigationTarget } from "../chatRouteRestore";
import { resolveChatIndexRestoreRoute } from "../routes/-chatIndexRoute.logic";
import { isNeutralInitialChatIndexLocation } from "./Sidebar.logic";
import { persistSidebarUiState, readSidebarUiState } from "./Sidebar.uiState";
import { useSidebarRoutePersistence } from "./useSidebarRoutePersistence";

const PROJECT_ID = ProjectId.makeUnsafe("project-kanban");
const OLD_THREAD_ID = ThreadId.makeUnsafe("thread-old");
const SETTINGS_ROUTE_PROPS: RouteProps = {
  locationKey: "settings-initial",
  pathname: "/settings",
  isOnKanban: false,
  isOnSettings: true,
  routeProjectId: null,
  routeThreadId: null,
};
const NEUTRAL_COLD_START_ROUTE_PROPS: RouteProps = {
  locationKey: "cold-start",
  pathname: "/",
  isOnKanban: false,
  isOnSettings: false,
  routeProjectId: null,
  routeThreadId: null,
};
const NON_CHAT_ROUTE_PROPS: RouteProps = {
  locationKey: "automations",
  pathname: "/automations",
  isOnKanban: false,
  isOnSettings: false,
  routeProjectId: null,
  routeThreadId: null,
};
const heldTimerHandles = new Set<ReturnType<typeof setTimeout>>();

interface RouteProps {
  readonly locationKey: string;
  readonly pathname: string;
  readonly isOnKanban: boolean;
  readonly isOnSettings: boolean;
  readonly routeProjectId: ProjectId | null;
  readonly routeThreadId: ThreadId | null;
}

function useRouteHarness(props?: RouteProps) {
  const persisted = readSidebarUiState();
  const [initialLocationKey] = useState(props?.locationKey);
  const [lastThreadRoute, setLastThreadRoute] = useState<LastThreadRoute | null>(
    persisted.lastThreadRoute,
  );
  const [safeMainNavigationTarget, setSafeMainNavigationTarget] =
    useState<SafeMainNavigationTarget | null>(persisted.safeMainNavigationTarget);
  useSidebarRoutePersistence({
    isNeutralInitialChatIndexLocation: isNeutralInitialChatIndexLocation({
      pathname: props?.pathname ?? "/settings",
      currentLocationKey: props?.locationKey,
      initialLocationKey,
    }),
    isOnKanban: props?.isOnKanban ?? false,
    isOnSettings: props?.isOnSettings ?? true,
    lastThreadRoute,
    routeProjectId: props?.routeProjectId ?? null,
    routeSplitViewId: undefined,
    routeThreadId: props?.routeThreadId ?? null,
    safeMainNavigationTarget,
    setLastThreadRoute,
    setSafeMainNavigationTarget,
  });
}

beforeEach(() => {
  window.localStorage.removeItem("moss:sidebar-ui:v1");
  persistSidebarUiState({
    chatSectionExpanded: false,
    chatThreadListExtraPages: 0,
    projectThreadListExtraPagesByCwd: {},
    dismissedThreadStatusKeyByThreadId: {},
    lastThreadRoute: { threadId: OLD_THREAD_ID },
    safeMainNavigationTarget: null,
    activityViewEnabled: false,
    activityScope: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const timerHandle of heldTimerHandles) {
    clearTimeout(timerHandle);
  }
  heldTimerHandles.clear();
  window.localStorage.removeItem("moss:sidebar-ui:v1");
});

describe("useSidebarRoutePersistence", () => {
  it("preserves project kanban through the neutral route rendered during cold startup", async () => {
    persistSidebarUiState({
      ...readSidebarUiState(),
      safeMainNavigationTarget: { kind: "kanban", projectId: PROJECT_ID },
    });

    const hook = await renderHook(useRouteHarness, {
      initialProps: NEUTRAL_COLD_START_ROUTE_PROPS,
    });
    await hook.unmount();

    const coldState = readSidebarUiState();
    expect(
      resolveChatIndexRestoreRoute({
        safeMainNavigationTarget: coldState.safeMainNavigationTarget,
        lastThreadRoute: coldState.lastThreadRoute,
        availableSplitViewIds: new Set(),
        threadIds: [OLD_THREAD_ID],
        projectById: new Map([[PROJECT_ID, { id: PROJECT_ID } as never]]),
        sidebarThreadSummaryById: { [OLD_THREAD_ID]: { projectId: PROJECT_ID } },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toEqual({ kind: "kanban", projectId: PROJECT_ID });
  });

  it("clears a stale kanban target when a non-chat route commits without a thread", async () => {
    persistSidebarUiState({
      ...readSidebarUiState(),
      safeMainNavigationTarget: { kind: "kanban", projectId: PROJECT_ID },
    });

    const hook = await renderHook(useRouteHarness, {
      initialProps: NON_CHAT_ROUTE_PROPS,
    });
    await hook.unmount();

    expect(readSidebarUiState()).toMatchObject({
      lastThreadRoute: { threadId: OLD_THREAD_ID },
      safeMainNavigationTarget: null,
    });
  });

  it("clears a stale kanban target when an already-mounted sidebar explicitly returns home", async () => {
    persistSidebarUiState({
      ...readSidebarUiState(),
      safeMainNavigationTarget: { kind: "kanban", projectId: PROJECT_ID },
    });

    const hook = await renderHook(useRouteHarness, {
      initialProps: SETTINGS_ROUTE_PROPS,
    });
    await hook.rerender({
      ...NEUTRAL_COLD_START_ROUTE_PROPS,
      locationKey: "explicit-home",
    });
    await hook.unmount();

    expect(readSidebarUiState()).toMatchObject({
      lastThreadRoute: { threadId: OLD_THREAD_ID },
      safeMainNavigationTarget: null,
    });
  });

  it("survives renderer teardown before deferred state settlement and cold-starts in project kanban", async () => {
    const hook = await renderHook(useRouteHarness, {
      initialProps: SETTINGS_ROUTE_PROPS,
    });
    const deferredCallbacks: Array<(_: void) => void> = [];
    const heldTimerHandle = setTimeout(() => undefined, 60_000);
    heldTimerHandles.add(heldTimerHandle);
    vi.spyOn(window, "setTimeout").mockImplementation((callback) => {
      deferredCallbacks.push(callback);
      return heldTimerHandle;
    });

    const projectKanbanRouteProps: RouteProps = {
      locationKey: "project-kanban",
      pathname: "/kanban/project-kanban",
      isOnKanban: true,
      isOnSettings: false,
      routeProjectId: PROJECT_ID,
      routeThreadId: null,
    };
    await hook.rerender(projectKanbanRouteProps);
    expect(deferredCallbacks).toHaveLength(1);
    await hook.unmount();

    const coldState = readSidebarUiState();
    expect(
      resolveChatIndexRestoreRoute({
        safeMainNavigationTarget: coldState.safeMainNavigationTarget,
        lastThreadRoute: coldState.lastThreadRoute,
        availableSplitViewIds: new Set(),
        threadIds: [OLD_THREAD_ID],
        projectById: new Map([[PROJECT_ID, { id: PROJECT_ID } as never]]),
        sidebarThreadSummaryById: { [OLD_THREAD_ID]: { projectId: PROJECT_ID } },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toEqual({ kind: "kanban", projectId: PROJECT_ID });
  });

  it("clears a stale kanban startup target as soon as a thread route commits", async () => {
    persistSidebarUiState({
      ...readSidebarUiState(),
      safeMainNavigationTarget: { kind: "kanban", projectId: PROJECT_ID },
    });
    const hook = await renderHook(useRouteHarness, {
      initialProps: SETTINGS_ROUTE_PROPS,
    });
    const heldTimerHandle = setTimeout(() => undefined, 60_000);
    heldTimerHandles.add(heldTimerHandle);
    vi.spyOn(window, "setTimeout").mockImplementation(() => heldTimerHandle);

    const threadRouteProps: RouteProps = {
      locationKey: "thread-live",
      pathname: "/thread-old",
      isOnKanban: false,
      isOnSettings: false,
      routeProjectId: null,
      routeThreadId: OLD_THREAD_ID,
    };
    await hook.rerender(threadRouteProps);
    await hook.unmount();

    expect(readSidebarUiState()).toMatchObject({
      lastThreadRoute: { threadId: OLD_THREAD_ID },
      safeMainNavigationTarget: null,
    });
  });
});
