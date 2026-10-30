// FILE: McpAppDockPane.tsx
// Purpose: Host container for one already-running MCP App frame in RightDock.
// The App tree itself is owned by McpAppHostController and is never rendered a
// second time here.

import { useLayoutEffect, useRef } from "react";

import { attachMcpAppSidePanelHost, setMcpAppDockEntryVisibility } from "~/lib/mcpAppDockRegistry";

export function McpAppDockPane(props: { readonly entryId: string; readonly visible?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const visible = props.visible ?? true;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const detach = attachMcpAppSidePanelHost(props.entryId, host);
    return () => {
      setMcpAppDockEntryVisibility(props.entryId, false);
      detach();
    };
  }, [props.entryId]);

  useLayoutEffect(() => {
    setMcpAppDockEntryVisibility(props.entryId, visible);
  }, [props.entryId, visible]);

  return (
    <div className="relative h-full min-h-0" data-mcp-app-side-panel="true">
      <div
        ref={hostRef}
        className="h-full min-h-0 w-full"
        data-mcp-app-side-panel-frame-container="true"
      />
    </div>
  );
}

export default McpAppDockPane;
