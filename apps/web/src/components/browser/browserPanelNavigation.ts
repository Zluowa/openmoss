// FILE: browserPanelNavigation.ts
// Purpose: Opens a page in a chat's browser panel the way every entry point should:
//   an HTML file the agent wrote, a local dev server, a link. Reuses the tab already
//   showing it, fills a blank tab, otherwise opens a new one.
// Layer: BrowserPanel helpers

import type { NativeApi, ThreadBrowserState, ThreadId } from "@moss/contracts";
import { localFileUrlFromPath, normalizeBrowserUrlInput } from "@moss/shared/browserSession";
import { isSupportedLocalHtmlPath } from "@moss/shared/localPreviewFiles";
import { joinWorkspaceRelativePath, isLocalAbsolutePath } from "@moss/shared/path";
import { create } from "zustand";

import { useBrowserStateStore } from "../../browserStateStore";
import { planBrowserOpen } from "./browserPanelChrome.logic";

/** `file:///…` for an HTML file given workspace-relative or absolute, or null. */
export function browserUrlForLocalHtmlFile(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!isSupportedLocalHtmlPath(path) && !/\.xhtml$/i.test(path)) return null;
  const absolute = isLocalAbsolutePath(path)
    ? path
    : workspaceRoot
      ? joinWorkspaceRelativePath(workspaceRoot, path)
      : null;
  return absolute ? localFileUrlFromPath(absolute) : null;
}

/**
 * Shows `url` in the thread's browser and resolves the state after. The caller makes
 * the panel visible; this only decides the tab.
 */
export async function openUrlInThreadBrowser(input: {
  readonly api: NativeApi;
  readonly threadId: ThreadId;
  readonly url: string;
}): Promise<ThreadBrowserState> {
  const { api, threadId } = input;
  const url = normalizeBrowserUrlInput(input.url);
  const opened = await api.browser.open({ threadId });
  useBrowserStateStore.getState().upsertThreadState(opened);
  const plan = planBrowserOpen({ tabs: opened.tabs, activeTabId: opened.activeTabId, url });
  let state: ThreadBrowserState;
  switch (plan.kind) {
    case "select": {
      state = await api.browser.selectTab({ threadId, tabId: plan.tabId });
      if (plan.reload) state = await api.browser.reload({ threadId, tabId: plan.tabId });
      break;
    }
    case "navigate":
      state = await api.browser.navigate({ threadId, tabId: plan.tabId, url });
      break;
    case "newTab":
      state = await api.browser.newTab({ threadId, url, activate: true });
      break;
  }
  useBrowserStateStore.getState().upsertThreadState(state);
  return state;
}

// ---------------------------------------------------------------------------
// Per-tab viewport preset, shared by the "…" menu (which sets it) and the panel
// (which lays the page out at it). Session-only, like a browser's device toolbar.

interface BrowserViewportStore {
  readonly presetByTabKey: Readonly<Record<string, string | undefined>>;
  readonly setPreset: (threadId: ThreadId, tabId: string, presetId: string | null) => void;
}

export function browserViewportTabKey(threadId: ThreadId, tabId: string): string {
  return `${threadId}\u0000${tabId}`;
}

export const useBrowserViewportStore = create<BrowserViewportStore>((set) => ({
  presetByTabKey: {},
  setPreset: (threadId, tabId, presetId) =>
    set((store) => {
      const key = browserViewportTabKey(threadId, tabId);
      const next = { ...store.presetByTabKey };
      if (presetId) next[key] = presetId;
      else delete next[key];
      return { presetByTabKey: next };
    }),
}));
