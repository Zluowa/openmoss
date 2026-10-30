// FILE: useSidebarRoutePersistence.ts
// Purpose: Durably records the active main route before deferred sidebar state settles.
// Layer: Web route-persistence hook

import type { ProjectId, ThreadId } from "@synara/contracts";
import { useEffect, type Dispatch, type SetStateAction } from "react";

import type { LastThreadRoute, SafeMainNavigationTarget } from "../chatRouteRestore";
import { resolveSidebarRoutePersistence } from "./Sidebar.logic";
import { persistSidebarRouteState } from "./Sidebar.uiState";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

export function useSidebarRoutePersistence(input: {
  readonly isNeutralInitialChatIndexLocation: boolean;
  readonly isOnKanban: boolean;
  readonly isOnSettings: boolean;
  readonly lastThreadRoute: LastThreadRoute | null;
  readonly routeProjectId: ProjectId | null;
  readonly routeSplitViewId: string | undefined;
  readonly routeThreadId: ThreadId | null;
  readonly safeMainNavigationTarget: SafeMainNavigationTarget | null;
  readonly setLastThreadRoute: StateSetter<LastThreadRoute | null>;
  readonly setSafeMainNavigationTarget: StateSetter<SafeMainNavigationTarget | null>;
}): void {
  useEffect(() => {
    const nextRoutePersistence = resolveSidebarRoutePersistence({
      currentLastThreadRoute: input.lastThreadRoute,
      currentSafeMainNavigationTarget: input.safeMainNavigationTarget,
      isNeutralInitialChatIndexLocation: input.isNeutralInitialChatIndexLocation,
      isOnSettings: input.isOnSettings,
      isOnKanban: input.isOnKanban,
      routeProjectId: input.routeProjectId,
      routeThreadId: input.routeThreadId,
      routeSplitViewId: input.routeSplitViewId,
    });
    if (!nextRoutePersistence) {
      return;
    }
    const nextLastThreadRoute = nextRoutePersistence.lastThreadRoute;
    const nextSafeMainNavigationTarget = nextRoutePersistence.safeMainNavigationTarget;

    // localStorage is synchronous. Commit the route before yielding to the timer so native
    // Cmd+Q cannot tear down the renderer while only the previous thread route is durable.
    persistSidebarRouteState({
      lastThreadRoute: nextLastThreadRoute,
      safeMainNavigationTarget: nextSafeMainNavigationTarget,
    });

    const settle = window.setTimeout(() => {
      input.setLastThreadRoute((current) => {
        if (current === null) {
          return nextLastThreadRoute;
        }
        if (nextLastThreadRoute === null) {
          return nextLastThreadRoute;
        }
        if (current.threadId !== nextLastThreadRoute.threadId) {
          return nextLastThreadRoute;
        }
        if (current.splitViewId === nextLastThreadRoute.splitViewId) {
          return current;
        }
        return nextLastThreadRoute;
      });
      input.setSafeMainNavigationTarget((current) => {
        if (current === null) {
          return nextSafeMainNavigationTarget;
        }
        if (nextSafeMainNavigationTarget === null) {
          return nextSafeMainNavigationTarget;
        }
        if (current.kind !== nextSafeMainNavigationTarget.kind) {
          return nextSafeMainNavigationTarget;
        }
        if (current.projectId === nextSafeMainNavigationTarget.projectId) {
          return current;
        }
        return nextSafeMainNavigationTarget;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    input.isNeutralInitialChatIndexLocation,
    input.isOnKanban,
    input.isOnSettings,
    input.lastThreadRoute,
    input.routeProjectId,
    input.routeSplitViewId,
    input.routeThreadId,
    input.safeMainNavigationTarget,
    input.setLastThreadRoute,
    input.setSafeMainNavigationTarget,
  ]);
}
