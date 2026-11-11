// FILE: openThreadTabsStore.ts
// Purpose: Persist which threads are open as tabs, in tab order. The single source of
//          truth for "open threads": the chat header strip and the editor rail both read
//          it; the active tab is never stored (it is always the thread on screen).
//          Showing a thread opens it in the current tab; only an explicit request (the
//          strip's +, a middle click, "Open in New Tab") adds a tab.
// Layer: UI state store
// Exports: useOpenThreadTabsStore

import type { ThreadId } from "@moss/contracts";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import {
  addOpenThreadTab,
  moveOpenThreadTab,
  normalizeOpenThreadTabIds,
  pruneOpenThreadTabs,
  removeOpenThreadTab,
  showThreadInOpenTabs,
} from "./openThreadTabs.logic";

interface OpenThreadTabsStoreState {
  threadIds: readonly ThreadId[];
  /**
   * The thread last shown in a tab, whose tab the next thread opened in place takes
   * over. Session-only: after a restart the first thread shown keeps its own tab.
   */
  currentThreadId: ThreadId | null;
  /** Set by {@link requestNewTab}: the next thread shown without a tab gets its own. */
  newTabRequested: boolean;
  /** Adds a tab for the thread (the explicit "open in a new tab"). */
  openThreadTab: (threadId: ThreadId) => void;
  /** Records the thread on screen, in place unless a new tab was requested. */
  showThreadInTab: (threadId: ThreadId) => void;
  /**
   * Asks for the next thread shown to open in a tab of its own, for actions that only
   * learn the thread once it is on screen (a new chat from the strip's +).
   */
  requestNewTab: () => void;
  cancelNewTabRequest: () => void;
  closeThreadTab: (threadId: ThreadId) => void;
  moveThreadTab: (threadId: ThreadId, overThreadId: ThreadId) => void;
  pruneThreadTabs: (isKept: (threadId: ThreadId) => boolean) => void;
}

const OPEN_THREAD_TABS_STORAGE_KEY = "moss:open-thread-tabs:v1";
// The editor rail's own per-project chat tabs, which this store replaced. Not migrated
// (the rail's tabs were a subset of the threads on screen); dropped on the first write.
const LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY = "moss.editor.railChatTabsByProjectId";

function createOpenThreadTabsStorage(): StateStorage {
  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      // Moving between tabs changes only session state (the current tab), which is not
      // persisted: skip rewriting an unchanged list on every switch.
      if (localStorage.getItem(name) === value) return;
      localStorage.setItem(name, value);
      localStorage.removeItem(LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
      localStorage.removeItem(LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    },
  };
}

export const useOpenThreadTabsStore = create<OpenThreadTabsStoreState>()(
  persist(
    (set, get) => ({
      threadIds: [],
      currentThreadId: null,
      newTabRequested: false,
      // Zustand persist writes even when set returns the same state. Skip set
      // entirely for unchanged tabs, especially on the layout-effect navigation path.
      openThreadTab: (threadId) => {
        const current = get().threadIds;
        const threadIds = addOpenThreadTab(current, threadId);
        if (threadIds !== current) set({ threadIds });
      },
      showThreadInTab: (threadId) => {
        const state = get();
        const threadIds = showThreadInOpenTabs({
          threadIds: state.threadIds,
          threadId,
          currentThreadId: state.currentThreadId,
          inNewTab: state.newTabRequested,
        });
        if (
          threadIds === state.threadIds &&
          state.currentThreadId === threadId &&
          !state.newTabRequested
        ) {
          return;
        }
        // The storage adapter skips the write when only the session fields changed.
        set({ threadIds, currentThreadId: threadId, newTabRequested: false });
      },
      requestNewTab: () => {
        if (!get().newTabRequested) set({ newTabRequested: true });
      },
      cancelNewTabRequest: () => {
        if (get().newTabRequested) set({ newTabRequested: false });
      },
      closeThreadTab: (threadId) => {
        const current = get().threadIds;
        const threadIds = removeOpenThreadTab(current, threadId);
        if (threadIds !== current) set({ threadIds });
      },
      moveThreadTab: (threadId, overThreadId) => {
        const current = get().threadIds;
        const threadIds = moveOpenThreadTab(current, threadId, overThreadId);
        if (threadIds !== current) set({ threadIds });
      },
      pruneThreadTabs: (isKept) => {
        const current = get().threadIds;
        const threadIds = pruneOpenThreadTabs(current, isKept);
        if (threadIds !== current) set({ threadIds });
      },
    }),
    {
      name: OPEN_THREAD_TABS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? createMemoryStorage() : createOpenThreadTabsStorage(),
      ),
      partialize: (state) => ({ threadIds: state.threadIds }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        threadIds: normalizeOpenThreadTabIds(
          (persistedState as { threadIds?: unknown } | undefined)?.threadIds,
        ),
      }),
    },
  ),
);
