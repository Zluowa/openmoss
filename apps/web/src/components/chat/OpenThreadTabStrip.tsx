// FILE: OpenThreadTabStrip.tsx
// Purpose: Browser-style tabs for the open threads, shown in the chat header in place of
//          the thread title. Owns what is specific to threads: which tabs exist, the close
//          queue, the optimistic selection, renaming the active thread, the tab's context
//          menu (the sidebar's thread menu plus the tab's own close actions), and pulling a
//          tab down onto the chat to split it.
// Layer: Chat header UI
// Depends on: open-thread tab hooks/store, the shared SurfaceContentTabs, and the sidebar's
//             thread context menu.

import type { ProjectId, ProviderKind, ResolvedKeybindingsConfig, ThreadId } from "@moss/contracts";
import { useEffect, useId, useState, type ReactNode, type RefObject } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  runInNewThreadTab,
  useActivateThreadTab,
  useOpenThreadTabs,
  useReadRouteThreadId,
  useRecordOpenThreadTab,
} from "~/hooks/useOpenThreadTabs";
import { useOptimisticTabSelection } from "~/hooks/useOptimisticTabSelection";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveShortcutCommand } from "~/keybindings";
import { PlusSignIcon, TerminalIcon } from "~/lib/icons";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { showThreadContextMenu } from "~/lib/threadContextMenu";
import { readNativeApi } from "~/nativeApi";
import {
  closeOpenThreadTab,
  closeOpenThreadTabs,
  createOpenThreadTabCloseQueue,
  type OpenThreadTab,
  type OpenThreadTabCloseScope,
  replaceLastTabWithFreshChat,
  resolveDraggedOpenThreadTab,
  resolveOpenThreadTabsInCloseScope,
  withActiveDraftOpenThreadTab,
} from "~/openThreadTabs.logic";
import { useOpenThreadTabsStore } from "~/openThreadTabsStore";

import {
  cancelThreadTabDrag,
  clearThreadTabDrag,
  dropThreadTabDrag,
  moveThreadTabDrag,
} from "../chat-drop-overlay/chatPaneDropTargets";
import { ThreadTabDragOverlay } from "../chat-drop-overlay/ThreadTabDragOverlay";
import { ProviderIcon } from "../ProviderIcon";
import { getNextVisibleSidebarThreadId } from "../Sidebar.logic";
import { ThreadRunningSpinner } from "../ThreadRunningSpinner";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chatHeaderControls";
import { SurfaceContentTabs } from "./SurfaceContentTabs";

const CLOSE_TABS_MENU_ID_PREFIX = "close-tabs:";
const CLOSE_TABS_MENU_ROWS: readonly { scope: OpenThreadTabCloseScope; label: string }[] = [
  { scope: "left", label: "Close Tabs to the Left" },
  { scope: "right", label: "Close Tabs to the Right" },
  { scope: "others", label: "Close Other Tabs" },
];

function OpenThreadTabIcon(props: { tab: OpenThreadTab }) {
  const { tab } = props;
  // A running thread spins in place of its glyph, like its sidebar row.
  if (tab.isRunning) {
    return (
      <span role="img" aria-label="Working" className="inline-flex">
        <ThreadRunningSpinner className="size-4" />
      </span>
    );
  }
  if (tab.isTerminal) {
    return <TerminalIcon className="size-4 text-[var(--color-text-accent)]" />;
  }
  return <ProviderIcon provider={tab.provider} className="size-4" />;
}

export function OpenThreadTabStrip(props: {
  activeThreadId: ThreadId;
  keybindings: ResolvedKeybindingsConfig;
  closeActiveTabRef?: RefObject<(() => boolean) | null>;
  onRenameActiveThread: () => void;
  /** The header's title and agent for the thread on screen, shown while no strip is. */
  activeThreadTitle: string;
  activeProvider: ProviderKind;
  /**
   * Creates a thread in the active workspace, rendered as the strip's trailing `+` right
   * after the last tab. Null hides it: a thread with no workspace to inherit has no control.
   * Resolves with the thread it opened, which gets a tab of its own.
   */
  onNewThread: (() => Promise<ThreadId | null>) | null;
}) {
  const { activeThreadId, keybindings } = props;
  useRecordOpenThreadTab(activeThreadId);
  const openTabs = useOpenThreadTabs({ activeThreadId });
  const storedThreadIds = useOpenThreadTabsStore((state) => state.threadIds);
  const activeDraftProjectId = useComposerDraftStore(
    (state) => state.draftThreadsByThreadId[activeThreadId]?.projectId ?? null,
  );
  const tabs = withActiveDraftOpenThreadTab({
    tabs: openTabs,
    threadIds: storedThreadIds,
    activeThreadId,
    activeDraft: activeDraftProjectId ? { projectId: activeDraftProjectId } : null,
    title: props.activeThreadTitle,
    provider: props.activeProvider,
  });
  const closeThreadTab = useOpenThreadTabsStore((state) => state.closeThreadTab);
  const pruneThreadTabs = useOpenThreadTabsStore((state) => state.pruneThreadTabs);
  const moveThreadTab = useOpenThreadTabsStore((state) => state.moveThreadTab);
  const activateThreadTab = useActivateThreadTab();
  const { handleNewThread, projects } = useHandleNewThread();
  const readRouteThreadId = useReadRouteThreadId();
  const [enqueueClose] = useState(createOpenThreadTabCloseQueue);
  const dragOwnerId = useId();
  // The clicked tab paints as active at once, like a selected sidebar row; the
  // thread itself (a whole chat to render) follows once that frame is on screen.
  const {
    shownKey: shownThreadId,
    select: selectTab,
    cancel: cancelTabSelection,
  } = useOptimisticTabSelection({
    activeKey: activeThreadId,
    hasTab: (threadId) => tabs.some((tab) => tab.threadId === threadId),
    activate: activateThreadTab,
  });

  // Previous/next tab, wrapping at either end like a browser. Steps from the tab painted
  // as active, so a quick run of presses walks the strip before each thread renders.
  const onKeyDown = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: { terminalFocus: isTerminalFocused() },
    });
    if (command !== "threadTab.next" && command !== "threadTab.previous") return;
    event.preventDefault();
    event.stopPropagation();
    const nextThreadId = getNextVisibleSidebarThreadId({
      visibleThreadIds: tabs.map((tab) => tab.threadId),
      activeThreadId: shownThreadId,
      direction: command === "threadTab.previous" ? "backward" : "forward",
    });
    if (nextThreadId && nextThreadId !== shownThreadId) selectTab(nextThreadId);
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const closeTab = (threadId: ThreadId, projectId: ProjectId) => {
    cancelTabSelection();
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return closeOpenThreadTab({
        // The tabs as clicked, minus any an earlier queued close has since dropped.
        tabs: tabs.filter((tab) => openThreadIds.includes(tab.threadId)),
        closedThreadId: threadId,
        activeThreadId: readRouteThreadId(),
        closeTab: closeThreadTab,
        openTab: activateThreadTab,
        replaceLastTab: replaceLastTabWithFreshChat(() => {
          const project = projects.find((candidate) => candidate.id === projectId);
          // An unsent draft hidden from the strip is still open: go back to it with its
          // text instead of minting a fresh chat that would discard it.
          const openDraft = useComposerDraftStore
            .getState()
            .getDraftThreadByProjectId(projectId, "chat");
          const reuseOpenDraft =
            openDraft !== null &&
            useOpenThreadTabsStore.getState().threadIds.includes(openDraft.threadId);
          return handleNewThread(projectId, {
            fresh: !reuseOpenDraft,
            ...(reuseOpenDraft ? { resumeUnsentDraft: true } : {}),
            // Home and Hubs use their container workspace; ordinary projects keep
            // their chosen local/worktree default through handleNewThread.
            ...(project && project.kind !== "project"
              ? { envMode: "local" as const, branch: null, worktreePath: null }
              : {}),
          });
        }),
        readRouteThreadId,
      });
    }).then((result) => {
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Unable to close the tab",
          description: result.error,
        });
      }
    });
  };

  // Cmd/Ctrl+W reaches the strip through useChatKeyboardShortcuts. Close the tab the user is
  // currently seeing, exactly as its X would; false leaves the native close role untouched.
  const closeActiveTab = useStableCallback(() => {
    const tab = tabs.find((candidate) => candidate.threadId === shownThreadId);
    if (!tab) return false;
    closeTab(tab.threadId, tab.projectId);
    return true;
  });
  useEffect(() => {
    const ref = props.closeActiveTabRef;
    if (!ref) return;
    ref.current = closeActiveTab;
    return () => {
      if (ref.current === closeActiveTab) ref.current = null;
    };
  }, [props.closeActiveTabRef, closeActiveTab]);

  const closeTabsInScope = (anchorThreadId: ThreadId, scope: OpenThreadTabCloseScope) => {
    cancelTabSelection();
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return closeOpenThreadTabs({
        closedThreadIds: resolveOpenThreadTabsInCloseScope(
          // The tabs as right-clicked, minus any an earlier queued close has since dropped.
          tabs.filter((tab) => openThreadIds.includes(tab.threadId)),
          anchorThreadId,
          scope,
        ),
        keptThreadId: anchorThreadId,
        activeThreadId: readRouteThreadId(),
        closeTabs: (threadIds) => pruneThreadTabs((threadId) => !threadIds.includes(threadId)),
        openTab: activateThreadTab,
        readRouteThreadId,
      });
    });
  };

  const openTabContextMenu = (tab: OpenThreadTab, position: { x: number; y: number }) => {
    // Plain rows in a group of their own, like a browser's tab menu. Only the scopes that
    // have tabs in them are listed: none on a lone tab, and no left (or right) row on the
    // first (or last) tab.
    const closeItems = CLOSE_TABS_MENU_ROWS.filter(
      (row) => resolveOpenThreadTabsInCloseScope(tabs, tab.threadId, row.scope).length > 0,
    ).map((row, index) => ({
      id: `${CLOSE_TABS_MENU_ID_PREFIX}${row.scope}`,
      label: row.label,
      separatorBefore: index === 0,
    }));
    const onCloseAction = (itemId: string) => {
      const row = CLOSE_TABS_MENU_ROWS.find(
        (candidate) => itemId === `${CLOSE_TABS_MENU_ID_PREFIX}${candidate.scope}`,
      );
      if (row) closeTabsInScope(tab.threadId, row.scope);
    };
    if (
      showThreadContextMenu(tab.threadId, position, {
        extraItems: closeItems,
        onExtraAction: onCloseAction,
      })
    ) {
      return;
    }
    // A phone's closed sidebar sheet cannot show thread actions; keep the tab's close rows available.
    const api = readNativeApi();
    if (!api || closeItems.length === 0) return;
    void api.contextMenu.show(closeItems, position).then((itemId) => {
      if (itemId) onCloseAction(itemId);
    });
  };

  // Pulled below the strip, a tab splits the chat it heads, exactly as a dropped sidebar
  // thread does; the chat's drop-zone overlay previews the side and performs the split.
  const dragTabOut = (threadId: ThreadId, point: { x: number; y: number }) => {
    const payload = resolveDraggedOpenThreadTab({
      tabs,
      draggedThreadId: threadId,
      activeThreadId,
    });
    const tab = tabs.find((candidate) => candidate.threadId === threadId);
    if (!payload || !tab) return;
    const icon: ReactNode = <OpenThreadTabIcon tab={tab} />;
    moveThreadTabDrag({ ownerId: dragOwnerId, payload, ghost: { title: tab.title, icon }, point });
  };

  const newThreadButton = props.onNewThread ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="chrome"
            size="icon-xs"
            aria-label="New thread in this workspace"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            onClick={() => {
              const onNewThread = props.onNewThread;
              if (onNewThread) void runInNewThreadTab(onNewThread);
            }}
          />
        }
      >
        <PlusSignIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">New thread in this workspace</TooltipPopup>
    </Tooltip>
  ) : null;

  // One tab is no strip: the header shows the thread's title, as a single chat always
  // did, and the + stays beside it to open a second tab. A draft on screen (which has no
  // tab until its first send) reads the same way when it is the only thread open.
  const loneTab = tabs.length === 1 && tabs[0]!.threadId === activeThreadId ? tabs[0]! : null;
  if (loneTab || tabs.length === 0) {
    return (
      <div className="flex min-w-0 items-center gap-2" data-open-thread-title="">
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          {loneTab ? (
            <OpenThreadTabIcon tab={loneTab} />
          ) : (
            <ProviderIcon provider={props.activeProvider} className="size-4" />
          )}
        </span>
        <h2
          className="max-w-[clamp(12rem,42vw,36rem)] truncate font-system-ui text-ui font-normal text-foreground [-webkit-app-region:no-drag]"
          title={loneTab?.title ?? props.activeThreadTitle}
          onDoubleClick={props.onRenameActiveThread}
          onContextMenu={
            loneTab
              ? (event) => {
                  event.preventDefault();
                  openTabContextMenu(loneTab, { x: event.clientX, y: event.clientY });
                }
              : undefined
          }
        >
          {loneTab?.title ?? props.activeThreadTitle}
        </h2>
        {newThreadButton}
      </div>
    );
  }

  return (
    <>
      <SurfaceContentTabs
        ariaLabel="Open threads"
        activeKey={shownThreadId}
        selectionAria="current"
        onMove={moveThreadTab}
        dragOut={{
          canDragOut: (threadId) =>
            resolveDraggedOpenThreadTab({ tabs, draggedThreadId: threadId, activeThreadId }) !==
            null,
          onMove: dragTabOut,
          onReturn: clearThreadTabDrag,
          onDrop: () => {
            dropThreadTabDrag();
          },
          onCancel: cancelThreadTabDrag,
        }}
        tabs={tabs.map((tab) => {
          const active = tab.threadId === shownThreadId;
          return {
            key: tab.threadId,
            title: tab.title,
            icon: <OpenThreadTabIcon tab={tab} />,
            onSelect: () => {
              if (!active) selectTab(tab.threadId);
            },
            onClose: () => closeTab(tab.threadId, tab.projectId),
            onTitleDoubleClick:
              tab.threadId === activeThreadId ? props.onRenameActiveThread : undefined,
            onContextMenu: (position) => openTabContextMenu(tab, position),
          };
        })}
        trailing={newThreadButton}
      />
      <ThreadTabDragOverlay ownerId={dragOwnerId} />
    </>
  );
}
