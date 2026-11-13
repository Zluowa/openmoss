import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

// Connectors: remote MCP servers the user signs in to from Settings.
// Moss keeps their OAuth tokens and proxies provider sessions to them.

export const McpConnectorId = TrimmedNonEmptyString;
export type McpConnectorId = typeof McpConnectorId.Type;

/**
 * "oauth" servers carry Moss-held tokens; "api-key" servers carry a key or
 * token the user pasted (sent in the URL query or as a bearer header);
 * "none" servers answer anonymously.
 */
export const McpConnectorAuthKind = Schema.Literals(["oauth", "api-key", "none"]);
export type McpConnectorAuthKind = typeof McpConnectorAuthKind.Type;

/**
 * "needs-auth": the refresh token or API key stopped working; reconnecting
 * signs in again.
 */
export const McpConnectorStatus = Schema.Literals(["connected", "needs-auth"]);
export type McpConnectorStatus = typeof McpConnectorStatus.Type;

/** One tool of a connector as the directory shows it (交互式连接器). */
export const McpConnectorToolSummary = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** The tool definition declares a `ui://` widget resource. */
  hasUi: Schema.Boolean,
  /** `_meta.ui.visibility`; empty when undeclared (model and app may both call it). */
  visibility: Schema.Array(Schema.Literals(["model", "app"])).check(Schema.isMaxLength(2)),
});
export type McpConnectorToolSummary = typeof McpConnectorToolSummary.Type;

export const McpConnector = Schema.Struct({
  connectorId: McpConnectorId,
  /** Catalog key, or null for a custom URL. */
  presetId: Schema.NullOr(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  /** Upstream address without any API key, so it is safe to show. */
  url: TrimmedNonEmptyString,
  /** MCP server name provider sessions see, e.g. `supabase_connector`. */
  serverName: TrimmedNonEmptyString,
  authKind: McpConnectorAuthKind,
  /** Non-secret setup hint so reconnect can display the current redirect URL. */
  usesOwnOAuthApp: Schema.optional(Schema.Boolean),
  status: McpConnectorStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /**
   * Tools with a widget, from the last tool list Moss read. Absent until Moss has listed the
   * connector's tools (it lists them in the background after connecting).
   */
  interactiveToolCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  tools: Schema.optional(Schema.Array(McpConnectorToolSummary).check(Schema.isMaxLength(500))),
});
export type McpConnector = typeof McpConnector.Type;

/**
 * Exactly one of `presetId` or `url`; `name` only labels a custom URL.
 * `clientId`/`clientSecret` are the user's own OAuth app, for servers that do
 * not register clients themselves (Slack, Google). `apiKey` is the key or
 * token for servers that take one instead of OAuth (Amap, McDonald's China);
 * a reconnect without it keeps the saved key.
 */
export const McpConnectorConnectInput = Schema.Struct({
  presetId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  clientSecret: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  apiKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpConnectorConnectInput = typeof McpConnectorConnectInput.Type;

/** Connect failed because the server needs the user's own OAuth app. */
export const MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE = "mcp-connector-client-required";

/** Connect failed because the server needs an API key and none was given or saved. */
export const MCP_CONNECTOR_API_KEY_REQUIRED_ERROR_CODE = "mcp-connector-api-key-required";

/** Where an OAuth app must send the user back, for its redirect URL setting. */
export const McpConnectorSetup = Schema.Struct({
  redirectUrl: TrimmedNonEmptyString,
});
export type McpConnectorSetup = typeof McpConnectorSetup.Type;

/**
 * `authorizationUrl` is set when the user must sign in: open it in the
 * browser; the connector appears in the list once the callback completes.
 * `connector` is set when the server needed no sign-in and is connected.
 */
export const McpConnectorConnectResult = Schema.Struct({
  authorizationUrl: Schema.NullOr(TrimmedNonEmptyString),
  connector: Schema.NullOr(McpConnector),
});
export type McpConnectorConnectResult = typeof McpConnectorConnectResult.Type;

export const McpConnectorDisconnectInput = Schema.Struct({
  connectorId: McpConnectorId,
});
export type McpConnectorDisconnectInput = typeof McpConnectorDisconnectInput.Type;

export const McpConnectorDisconnectResult = Schema.Struct({
  disconnected: Schema.Boolean,
});
export type McpConnectorDisconnectResult = typeof McpConnectorDisconnectResult.Type;

/**
 * One tool a connected server offers agents, as its `tools/list` names it.
 * Long descriptions are cut to what a list can show.
 */
export const McpConnectorTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type McpConnectorTool = typeof McpConnectorTool.Type;

export const McpConnectorListToolsInput = Schema.Struct({
  connectorId: McpConnectorId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpConnectorListToolsInput = typeof McpConnectorListToolsInput.Type;

/** `truncated` is set when the server offers more tools than Moss lists. */
export const McpConnectorListToolsResult = Schema.Struct({
  tools: Schema.Array(McpConnectorTool),
  truncated: Schema.Boolean,
});
export type McpConnectorListToolsResult = typeof McpConnectorListToolsResult.Type;

/**
 * Moss service plugins (one per mainland China service: its connector plus a
 * Moss-written skill). `installed` lists every installed plugin id: those
 * whose connector is connected, and the skill-only ones the user installed.
 * `skills` lists the skill files Moss keeps on disk for them right now, so a
 * chat can attach a plugin's skill to any CLI by its real path.
 */
export const MossServicePluginSkillFile = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type MossServicePluginSkillFile = typeof MossServicePluginSkillFile.Type;

export const MossServicePluginsState = Schema.Struct({
  installed: Schema.Array(TrimmedNonEmptyString),
  skills: Schema.Array(MossServicePluginSkillFile),
});
export type MossServicePluginsState = typeof MossServicePluginsState.Type;

/** Installs or removes a skill-only service plugin; plugins with an MCP install by connecting. */
export const MossServicePluginSetInstalledInput = Schema.Struct({
  pluginId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  installed: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MossServicePluginSetInstalledInput = typeof MossServicePluginSetInstalledInput.Type;
