// FILE: mossAppsPresentation.ts
// Purpose: Names Moss Apps tool calls by what they do. The connector serves the hosted app
//   backend's own meta-tools, whose names carry the backend's brand.
// Layer: Shared provider presentation policy (server tool titles + web rows and approvals)

/** The MCP server name agents see for Moss Apps. */
export const MOSS_APPS_SERVER_NAME = "moss_apps";
export const MOSS_APPS_DISPLAY_NAME = "Moss Apps";

const MOSS_APPS_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  COMPOSIO_SEARCH_TOOLS: "Find app actions",
  COMPOSIO_GET_TOOL_SCHEMAS: "Read app action details",
  COMPOSIO_MULTI_EXECUTE_TOOL: "Run app actions",
  COMPOSIO_MANAGE_CONNECTIONS: "Check app connections",
  COMPOSIO_REMOTE_WORKBENCH: "Use the app workbench",
  COMPOSIO_REMOTE_BASH_TOOL: "Run an app workbench command",
};

/** Every action label, for copy that has to be localized ahead of time. */
export const MOSS_APPS_TOOL_ACTION_LABELS: ReadonlyArray<string> =
  Object.values(MOSS_APPS_TOOL_ACTIONS);

export function isMossAppsServer(server: string | null | undefined): boolean {
  return server?.trim().toLowerCase() === MOSS_APPS_SERVER_NAME;
}

/** "Run app actions" for a known meta-tool; an unknown one is spelled out without the brand. */
export function mossAppsToolAction(tool: string): string {
  const name = tool.trim();
  const known = MOSS_APPS_TOOL_ACTIONS[name.toUpperCase()];
  if (known) return known;
  const words = name
    .replace(/^COMPOSIO_/iu, "")
    .split(/[_\-\s]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const phrase = words.join(" ");
  return phrase ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : "Use an app";
}

/** The tool row heading, "Moss Apps: Run app actions". */
export function mossAppsToolTitle(tool: string): string {
  return `${MOSS_APPS_DISPLAY_NAME}: ${mossAppsToolAction(tool)}`;
}
