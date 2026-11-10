// FILE: useBrowserTurnFollowUp.ts
// Purpose: What the browser panel does when an agent turn finishes changing files:
//   "Auto-open files Moss writes" shows the first HTML page the turn created or edited,
//   and "Auto-verify changes" reloads the pages from this project already open (local
//   pages under the project folder and local dev servers), so the panel always shows the
//   result of the change.
// Layer: BrowserPanel integration hook

import type { BrowserTabState, ThreadId } from "@moss/contracts";
import { localFilePathFromUrl } from "@moss/shared/browserSession";
import { isWorkspaceRootWithin } from "@moss/shared/threadWorkspace";
import { useEffect, useRef } from "react";

import { readNativeApi } from "~/nativeApi";
import type { TurnDiffSummary } from "~/types";

import { useBrowserStateStore } from "../../browserStateStore";
import { turnPageFiles } from "../chat/TurnPageCards";
import { browserUrlForLocalHtmlFile } from "./browserPanelNavigation";

const LOCAL_SERVER_HOST_PATTERN = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/** Whether an open tab shows this project's work: a page under its folder or a dev server. */
export function browserTabShowsProjectWork(
  tab: Pick<BrowserTabState, "url" | "lastCommittedUrl">,
  workspaceRoot: string | null,
): boolean {
  const url = tab.lastCommittedUrl ?? tab.url;
  const filePath = localFilePathFromUrl(url);
  if (filePath) return workspaceRoot !== null && isWorkspaceRootWithin(filePath, workspaceRoot);
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      LOCAL_SERVER_HOST_PATTERN.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function useBrowserTurnFollowUp(input: {
  readonly threadId: ThreadId | null;
  readonly workspaceRoot: string | null;
  readonly turnDiffSummaries: readonly TurnDiffSummary[];
  /** False where this chat has no browser panel (web build, a side chat in a dock). */
  readonly enabled: boolean;
  readonly autoOpenPages: boolean;
  readonly autoVerify: boolean;
  /** Shows a page in the browser panel and brings the panel up. */
  readonly openPage: (url: string) => void;
}): void {
  // Turns already finished when the chat was opened are history, not news.
  const seenRef = useRef<{ threadId: ThreadId | null; turnIds: Set<string> } | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const current = inputRef.current;
    const turnIds = current.turnDiffSummaries.map((summary) => String(summary.turnId));
    if (!seenRef.current || seenRef.current.threadId !== current.threadId) {
      seenRef.current = { threadId: current.threadId, turnIds: new Set(turnIds) };
      return;
    }
    const seen = seenRef.current.turnIds;
    const finished = current.turnDiffSummaries.filter(
      (summary) => !seen.has(String(summary.turnId)),
    );
    for (const id of turnIds) seen.add(id);
    const threadId = current.threadId;
    if (!current.enabled || !threadId || finished.length === 0) return;
    const changedFiles = finished.flatMap((summary) => summary.files);
    if (changedFiles.length === 0) return;

    let openedUrl: string | null = null;
    if (current.autoOpenPages) {
      const page = turnPageFiles(changedFiles)[0];
      openedUrl = page ? browserUrlForLocalHtmlFile(page.path, current.workspaceRoot) : null;
      if (openedUrl) current.openPage(openedUrl);
    }
    if (!current.autoVerify) return;
    const api = readNativeApi();
    const state = useBrowserStateStore.getState().threadStatesByThreadId[threadId];
    if (!api || !state) return;
    for (const tab of state.tabs) {
      if (tab.status !== "live" && tab.id !== state.activeTabId) continue;
      if (openedUrl !== null && (tab.lastCommittedUrl ?? tab.url) === openedUrl) continue;
      if (!browserTabShowsProjectWork(tab, current.workspaceRoot)) continue;
      void api.browser.reload({ threadId, tabId: tab.id }).catch(() => undefined);
    }
  }, [input.threadId, input.turnDiffSummaries]);
}
