// FILE: useBrowserDockIntegration.tsx
// Purpose: What a chat surface needs to host the browser panel in its dock: one call
//   that shows any page (an HTML file, a dev server, a link) in the panel. The panel
//   draws its own header (tabs, servers, "…", expand, close).
// Layer: BrowserPanel integration hook

import type { ThreadId } from "@moss/contracts";

import { isElectron } from "~/env";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";

import { toastManager } from "../ui/toast";
import { browserUrlForLocalHtmlFile, openUrlInThreadBrowser } from "./browserPanelNavigation";

/** Pages show in the browser panel only in the desktop app, where it exists. */
export function browserPanelAvailable(): boolean {
  return isElectron && readNativeApi() !== null;
}

// File references can carry a `:line[:col]` suffix; a page opens whole.
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export function useBrowserDockIntegration(input: {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  /** Shows the browser pane in the dock (hydrating it at once). */
  readonly showBrowserPane: () => void;
  /** Opens a local page's file as source in the file pane. */
  readonly openSource: (absolutePath: string) => void;
}) {
  const { t } = useTranslation();
  const { threadId, workspaceRoot } = input;
  const available = browserPanelAvailable();

  /** Shows `url` in the browser panel; false when this surface has no browser panel. */
  const openUrl = (url: string): boolean => {
    const api = readNativeApi();
    if (!api || !available) return false;
    input.showBrowserPane();
    void openUrlInThreadBrowser({ api, threadId, url }).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: t("browser.menu.actionFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    });
    return true;
  };

  /** Opens an HTML page (workspace-relative or absolute) in the browser panel. */
  const openHtmlFile = (path: string): boolean => {
    const url = browserUrlForLocalHtmlFile(
      path.trim().replace(FILE_POSITION_SUFFIX_PATTERN, ""),
      workspaceRoot,
    );
    return url ? openUrl(url) : false;
  };

  return {
    openUrl,
    openHtmlFile,
    openSourceFile: input.openSource,
  };
}
