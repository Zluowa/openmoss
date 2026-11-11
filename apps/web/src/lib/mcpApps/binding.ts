// FILE: binding.ts
// Purpose: Read the provider-neutral widget binding (PLAN §2.1) from a work-log MCP projection.
//          Until A's binding lands, the Codex-only descriptor is mapped onto the same shape.
// Layer: Web MCP App host data
// Exports: resolveMcpAppBinding, MOSS_FIRST_PARTY_SERVER_KEY

import type { WorkLogMcpToolResult } from "../toolCallDetails";
import type { McpAppBinding, McpAppBindingSource, McpAppToolVisibility } from "./contracts";

export const MOSS_FIRST_PARTY_SERVER_KEY = "moss";

const SOURCES: ReadonlySet<string> = new Set<McpAppBindingSource>([
  "toolDefinition",
  "appContext",
  "resultMeta",
  "legacy",
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function visibilityList(value: unknown): McpAppToolVisibility[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is McpAppToolVisibility => entry === "model" || entry === "app",
  );
}

/** The binding for a tool row, or null when the row has no widget. */
export function resolveMcpAppBinding(projection: WorkLogMcpToolResult): McpAppBinding | null {
  const app = projection.app as (Record<string, unknown> & { resourceUri?: unknown }) | undefined;
  if (!app) return null;
  const resourceUri = text(app.resourceUri);
  if (!resourceUri) return null;
  const server = text(app.server) ?? projection.server;
  const connectorId = text(app.connectorId);
  const serverKey = text(app.serverKey) ?? connectorId ?? server;
  const source =
    typeof app.source === "string" && SOURCES.has(app.source)
      ? (app.source as McpAppBindingSource)
      : "legacy";
  const connectorUrl = text(app.connectorUrl);
  const toolTitle = text(app.toolTitle) ?? text(app.actionName);
  return {
    server,
    serverKey,
    serverLabel: text(app.serverLabel) ?? text(app.appName) ?? server,
    toolName: text(app.toolName) ?? projection.tool,
    ...(toolTitle ? { toolTitle } : {}),
    resourceUri,
    source,
    ...(connectorId ? { connectorId } : {}),
    ...(connectorUrl ? { connectorUrl } : {}),
    isFirstParty:
      typeof app.isFirstParty === "boolean"
        ? app.isFirstParty
        : serverKey === MOSS_FIRST_PARTY_SERVER_KEY,
    visibility: visibilityList(app.visibility),
  };
}
