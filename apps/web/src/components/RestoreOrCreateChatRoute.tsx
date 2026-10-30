// FILE: RestoreOrCreateChatRoute.tsx
// Purpose: Shared cold-start machinery for chat index routes — guards against briefly-empty
//          bootstrap snapshots, then defers to a caller-supplied resolver to pick the thread
//          route to restore, falling back to creating a fresh draft. Used by the home-chat index
//          route and the Groups index route so both get identical empty-snapshot recovery.
// Layer: Routing
// Depends on: sidebar UI persistence plus caller-supplied restore/fresh-chat policy.

import { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { SplashScreen } from "./SplashScreen";
import {
  type EmptyRouteRestoreRecoveryState,
  type LastThreadRoute,
  type SafeMainNavigationTarget,
  shouldHoldRememberedRouteFallback,
  shouldStartRememberedRouteRecovery,
} from "../chatRouteRestore";
import { readSidebarUiState } from "./Sidebar.uiState";
import {
  refreshEmptyRouteRestoreSnapshot,
  waitForEmptyRouteRestoreFallbackDelay,
} from "../chatRouteRecovery";
import type { StartContainerChatResult } from "../lib/startContainerChat";
import { readNativeApi } from "../nativeApi";
import { useSplitViewStore } from "../splitViewStore";
import { EMPTY_THREAD_IDS, useStore } from "../store";

export type RestoreRouteResolverInput = {
  // Split views currently known to the client. Callers that support split-view restore should
  // filter their resolved route's `splitViewId` against this set.
  readonly availableSplitViewIds: ReadonlySet<string>;
};

type RestorableRouteTarget = LastThreadRoute | SafeMainNavigationTarget;

// Resolves which thread route (if any) this surface should restore to. Returning `null` defers
// to `createFreshChat` (e.g. because there is a draft to reopen instead of an existing thread).
export type RestoreRouteResolver = (
  input: RestoreRouteResolverInput,
) => RestorableRouteTarget | null;

export function RestoreOrCreateChatRoute({
  resolveRestoreRoute,
  createFreshChat,
  forceFreshChat = false,
}: {
  // Surface-specific policy for picking the thread route to restore (e.g. the last-visited route
  // for home chats, the latest group thread or draft for Groups). The remembered-route recovery
  // below still keys off the total thread count, which is shared across surfaces.
  readonly resolveRestoreRoute: RestoreRouteResolver;
  readonly createFreshChat: () => Promise<StartContainerChatResult>;
  /** Login completion bypasses persisted route recovery exactly once. */
  readonly forceFreshChat?: boolean | undefined;
}) {
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const splitViewsHydrated = useSplitViewStore((state) => state.hasHydrated);
  const splitViewsById = useSplitViewStore((state) => state.splitViewsById);
  const splitViewIds = Object.keys(splitViewsById).filter(
    (splitViewId) => splitViewsById[splitViewId],
  );
  const [attempt, setAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emptyRestoreRecoveryState, setEmptyRestoreRecoveryState] =
    useState<EmptyRouteRestoreRecoveryState>("idle");
  const mountedRef = useRef(true);
  // One fresh-chat creation at a time per mount: a dep change mid-create re-runs the effect,
  // and without this guard the superseded run and the new run could both mint a draft.
  const createFreshChatInFlightRef = useRef(false);

  useEffect(() => {
    // React StrictMode probes effects with a setup -> cleanup -> setup cycle.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!(threadIds.length > 0 && emptyRestoreRecoveryState !== "idle")) {
      return;
    }
    // Timeout-0 keeps the state write asynchronous (compiler-eligible); the
    // recovery machine only gates async restore flows.
    const timeoutId = window.setTimeout(() => {
      setEmptyRestoreRecoveryState("idle");
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [emptyRestoreRecoveryState, threadIds.length]);

  useEffect(() => {
    if (!threadsHydrated || !splitViewsHydrated) {
      return;
    }

    let cancelled = false;

    void (async () => {
      // Yield one microtask so every state write below happens asynchronously
      // (no wasted pre-paint render; keeps the component compiler-eligible).
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      setErrorMessage(null);
      const lastThreadRoute = forceFreshChat ? null : readSidebarUiState().lastThreadRoute;
      if (
        shouldStartRememberedRouteRecovery({
          lastThreadRoute,
          availableThreadCount: threadIds.length,
          recoveryState: emptyRestoreRecoveryState,
        })
      ) {
        setEmptyRestoreRecoveryState("pending");
        await Promise.all([
          refreshEmptyRouteRestoreSnapshot(readNativeApi()).catch(() => false),
          waitForEmptyRouteRestoreFallbackDelay(),
        ]);
        if (mountedRef.current) {
          // Snapshot repair may briefly expose a thread, reset this state to idle, then retract
          // it and start another recovery before this one settles. Any completed bounded refresh
          // can release a recovery that is still pending; coupling completion to the original run
          // would leave the successor permanently stuck on the splash screen.
          setEmptyRestoreRecoveryState((state) => (state === "pending" ? "done" : state));
        }
        return;
      }

      if (
        shouldHoldRememberedRouteFallback({
          lastThreadRoute,
          availableThreadCount: threadIds.length,
          recoveryState: emptyRestoreRecoveryState,
        })
      ) {
        return;
      }

      const restorableRoute = forceFreshChat
        ? null
        : resolveRestoreRoute({
            availableSplitViewIds: new Set(splitViewIds),
          });
      if (restorableRoute) {
        if (cancelled) {
          return;
        }
        if ("kind" in restorableRoute) {
          if (restorableRoute.kind === "kanban") {
            await navigate(
              restorableRoute.projectId
                ? {
                    to: "/kanban/$projectId",
                    params: { projectId: restorableRoute.projectId },
                    replace: true,
                  }
                : {
                    to: "/kanban",
                    replace: true,
                  },
            );
          }
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(restorableRoute.threadId) },
          replace: true,
          search: () => ({
            splitViewId: restorableRoute.splitViewId,
          }),
        });
        return;
      }

      if (cancelled || createFreshChatInFlightRef.current) {
        return;
      }
      createFreshChatInFlightRef.current = true;
      // .finally instead of try/finally: React Compiler does not yet support
      // try/finally and would skip optimizing this whole component.
      const result: StartContainerChatResult = await createFreshChat().finally(() => {
        createFreshChatInFlightRef.current = false;
      });
      if (cancelled || result.ok) {
        return;
      }
      setErrorMessage(result.error);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    createFreshChat,
    emptyRestoreRecoveryState,
    forceFreshChat,
    navigate,
    resolveRestoreRoute,
    splitViewIds,
    splitViewsHydrated,
    threadIds.length,
    threadsHydrated,
  ]);

  return (
    <SplashScreen
      errorMessage={errorMessage}
      onRetry={errorMessage ? () => setAttempt((value) => value + 1) : null}
    />
  );
}
