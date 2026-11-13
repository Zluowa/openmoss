/**
 * Opens the browser pane when the agent opens a page in the server browser.
 *
 * The desktop app learns this from its own webview. Elsewhere the browser runs
 * on the server, so a chat keeps a presence-only connection to it: no frames,
 * just the agent's "show this page" requests.
 */
import type { ThreadId } from "@moss/contracts";
import { useEffect, useRef } from "react";

import { createServerBrowserStreamClient } from "~/lib/serverBrowserStream";

export function useServerBrowserReveal(input: {
  readonly threadId: ThreadId;
  readonly enabled: boolean;
  readonly showBrowserPane: () => void;
}): void {
  const showRef = useRef(input.showBrowserPane);
  showRef.current = input.showBrowserPane;
  const { threadId, enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    const client = createServerBrowserStreamClient(
      { threadId, maxWidth: 1, maxHeight: 1, presence: true },
      {
        onFrame: () => {},
        onTabs: () => {},
        onViewport: () => {},
        onControl: () => {},
        onConnectedChange: () => {},
        onUnavailable: () => {},
        onReveal: () => showRef.current(),
      },
    );
    return () => client.stop();
  }, [threadId, enabled]);
}
