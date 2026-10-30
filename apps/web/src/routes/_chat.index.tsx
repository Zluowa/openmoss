// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, falling back to a fresh home-chat draft.
//          Also the landing for a Space that has nothing to open.
// Layer: Routing
// Depends on: the shared restore/create route surface plus the home-chat new-chat handler.

import { SpaceId, type ProjectId, type ThreadId } from "@synara/contracts";
import { createFileRoute } from "@tanstack/react-router";

import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { useProjectAgentSummariesStore } from "../components/chat/project/useProjectAgentSummaries";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { VOID_SPACE_KEY } from "../lib/spaceGrouping";
import { collectGroupProjectIds } from "../lib/groupProjects";
import { resolveSplitViewThreadIds, useSplitViewStore } from "../splitViewStore";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { parseMossSurface, type MossSurface } from "../lib/mossSurfaceState";
import type { ThreadDetailSyncFailureCode } from "../storeState";
import { resolveChatIndexRestoreRoute, type ChatIndexLandingSpace } from "./-chatIndexRoute.logic";

/**
 * Set by the Space switcher when the selected Space has nothing to open (`spaceKey`, so Void
 * survives as a string). It scopes the restore below to that Space — without it this landing
 * happily reopens the *previous* Space's thread, and the route-to-Space sync then writes that
 * Space back over the user's click.
 */
export interface ChatIndexSearch {
  readonly space?: string | undefined;
  readonly fresh?: true | undefined;
  readonly mossSurface?: MossSurface | undefined;
}

export function parseChatIndexSearch(raw: Record<string, unknown>): ChatIndexSearch {
  const mossSurface = parseMossSurface(raw);
  return {
    ...(typeof raw.space === "string" && raw.space.length > 0 ? { space: raw.space } : {}),
    ...(raw.fresh === true || raw.fresh === "true" || raw.fresh === "1"
      ? { fresh: true as const }
      : {}),
    ...(mossSurface ? { mossSurface } : {}),
  };
}

export function filterRestorableChatThreadIds(
  threadIds: readonly ThreadId[],
  failureCodeByThreadId: Readonly<Record<ThreadId, ThreadDetailSyncFailureCode>> | undefined,
): readonly ThreadId[] {
  if (
    failureCodeByThreadId === undefined ||
    !threadIds.some((threadId) => failureCodeByThreadId[threadId] === "THREAD_SNAPSHOT_NOT_FOUND")
  ) {
    return threadIds;
  }
  return threadIds.filter(
    (threadId) => failureCodeByThreadId[threadId] !== "THREAD_SNAPSHOT_NOT_FOUND",
  );
}

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const routeSearch = Route.useSearch();
  const forceFreshChat = routeSearch.fresh === true;
  const landingSpaceKey = forceFreshChat ? undefined : routeSearch.space;
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const threadDetailSyncFailureCodeById = useStore(
    (state) => state.threadDetailSyncFailureCodeById,
  );
  const restorableThreadIds = filterRestorableChatThreadIds(
    threadIds,
    threadDetailSyncFailureCodeById,
  );
  const projects = useStore((state) => state.projects);
  const summariesByProjectId = useProjectAgentSummariesStore((state) => state.summariesByProjectId);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  // A Space landing reuses the stored home-chat draft instead of minting one (same reasoning as
  // the /groups landing): a fresh draft per visit would litter the Chats container every time
  // someone clicked through their empty Spaces.
  const createFreshChat = () =>
    forceFreshChat
      ? handleNewChat({
          fresh: true,
          navigation: { replace: true, preservePreviousDraft: true },
        })
      : landingSpaceKey === undefined
        ? handleNewChat({ fresh: true })
        : handleNewChat();

  const workspacePaths = { homeDir, chatWorkspaceRoot, studioWorkspaceRoot, groupsWorkspaceRoot };
  // Home chats restore the last visited route, except group threads — those belong to the
  // /groups surface, and restoring one from "/" would silently switch the user into the Groups
  // segment. A group lastThreadRoute falls through to a fresh home-chat draft instead.
  const groupProjectIds = collectGroupProjectIds(projects, workspacePaths);
  // Only plain, still-unsent chat drafts qualify as restore targets: a non-"chat" entry point
  // isn't a home-chat draft, and `promotedTo` means the draft already became a real thread, so
  // its stale id is no longer valid (matches the filtering findGroupDraftThreadId applies).
  const draftProjectIdByThreadId = new Map<string, ProjectId>();
  for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
    if (draft.entryPoint === "chat" && draft.promotedTo === undefined) {
      draftProjectIdByThreadId.set(threadId, draft.projectId);
    }
  }

  const landingSpace: ChatIndexLandingSpace | null =
    landingSpaceKey === undefined
      ? null
      : {
          spaceId: landingSpaceKey === VOID_SPACE_KEY ? null : SpaceId.makeUnsafe(landingSpaceKey),
          projectById: new Map(projects.map((project) => [project.id, project])),
          workspacePaths,
        };

  const resolveRestoreRoute: RestoreRouteResolver = ({ availableSplitViewIds }) => {
    const lastThreadRoute = readSidebarUiState().lastThreadRoute;
    const rememberedSplitView = lastThreadRoute?.splitViewId
      ? useSplitViewStore.getState().splitViewsById[lastThreadRoute.splitViewId]
      : undefined;
    return resolveChatIndexRestoreRoute({
      lastThreadRoute,
      safeMainNavigationTarget: readSidebarUiState().safeMainNavigationTarget,
      projectById: new Map(projects.map((project) => [project.id, project])),
      availableSplitViewIds,
      threadIds: restorableThreadIds,
      sidebarThreadSummaryById,
      groupProjectIds,
      summariesByProjectId,
      draftProjectIdByThreadId,
      rememberedSplitViewThreadIds: rememberedSplitView
        ? resolveSplitViewThreadIds(rememberedSplitView)
        : undefined,
      landingSpace,
    });
  };

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  validateSearch: parseChatIndexSearch,
  component: ChatIndexRouteView,
});
