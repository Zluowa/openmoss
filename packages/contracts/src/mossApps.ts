import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

// Moss Apps: third-party apps (GitHub, Gmail, Slack, ...) each Moss user signs
// in to once. The catalog, sign-in and tool execution are backed by a hosted
// app-integration provider; every CLI reaches the connected apps through one
// Moss-owned MCP connector, so no CLI is configured per app.

// The catalog prefixes a slug that would start with a digit with "_" ("_1password").
const ToolkitSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^_?[a-z0-9][a-z0-9_-]*$/u),
);

/** Why Moss Apps can or cannot be used on this server. */
export const MossAppsAvailability = Schema.Literals([
  "ready",
  /** No app-integration key is configured for this server. */
  "unconfigured",
]);
export type MossAppsAvailability = typeof MossAppsAvailability.Type;

export const MossAppsStatus = Schema.Struct({
  availability: MossAppsAvailability,
  /** True while connected apps are offered to new agent sessions. */
  agentAccess: Schema.Boolean,
});
export type MossAppsStatus = typeof MossAppsStatus.Type;

/** How someone signs in to an app. */
export const MossAppSignIn = Schema.Literals([
  /** Nothing to sign in to: the app works once it is added. */
  "none",
  /** Moss opens the app's own sign-in page; the backend holds the OAuth app. */
  "managed",
  /** The user enters their own key, token or login for the app. */
  "credentials",
  /** The app needs its own OAuth app set up for this workspace before anyone can sign in. */
  "setup",
]);
export type MossAppSignIn = typeof MossAppSignIn.Type;

export const MossAppToolkit = Schema.Struct({
  slug: ToolkitSlug,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.String.check(Schema.isMaxLength(2_000)),
  logoUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  categories: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(80))).check(
    Schema.isMaxLength(16),
  ),
  toolsCount: NonNegativeInt,
  signIn: MossAppSignIn,
});
export type MossAppToolkit = typeof MossAppToolkit.Type;

const CredentialFieldName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9_]+$/u),
);

/** One value a user enters to connect an app with their own credentials. */
export const MossAppCredentialField = Schema.Struct({
  name: CredentialFieldName,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.String.check(Schema.isMaxLength(1_000)),
  required: Schema.Boolean,
  /** Entered masked; Moss never shows it again. */
  secret: Schema.Boolean,
});
export type MossAppCredentialField = typeof MossAppCredentialField.Type;

export const MossAppCredentialScheme = Schema.Literals(["API_KEY", "BEARER_TOKEN", "BASIC"]);
export type MossAppCredentialScheme = typeof MossAppCredentialScheme.Type;

export const MossAppConnectionStatus = Schema.Literals([
  "active",
  "pending",
  "failed",
  "expired",
  "inactive",
]);
export type MossAppConnectionStatus = typeof MossAppConnectionStatus.Type;

export const MossAppConnection = Schema.Struct({
  connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  toolkitSlug: ToolkitSlug,
  status: MossAppConnectionStatus,
  createdAt: IsoDateTime,
});
export type MossAppConnection = typeof MossAppConnection.Type;

export const MossAppsListToolkitsInput = Schema.Struct({
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  category: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  limit: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(100))),
  /**
   * The whole catalog in one answer (cursor and limit ignored): the plugin
   * directory lists every app under its category and searches them locally.
   */
  all: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MossAppsListToolkitsInput = typeof MossAppsListToolkitsInput.Type;

export const MossAppsListToolkitsResult = Schema.Struct({
  toolkits: Schema.Array(MossAppToolkit),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  totalItems: NonNegativeInt,
});
export type MossAppsListToolkitsResult = typeof MossAppsListToolkitsResult.Type;

export const MossAppsListConnectionsResult = Schema.Struct({
  connections: Schema.Array(MossAppConnection),
});
export type MossAppsListConnectionsResult = typeof MossAppsListConnectionsResult.Type;

export const MossAppsConnectFieldsInput = Schema.Struct({
  toolkitSlug: ToolkitSlug,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MossAppsConnectFieldsInput = typeof MossAppsConnectFieldsInput.Type;

/** What a user enters to connect an app that signs in with their own credentials. */
export const MossAppsConnectFieldsResult = Schema.Struct({
  scheme: MossAppCredentialScheme,
  fields: Schema.Array(MossAppCredentialField).check(Schema.isMaxLength(20)),
  /** The app's own guide to finding these values, when the backend knows it. */
  helpUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
});
export type MossAppsConnectFieldsResult = typeof MossAppsConnectFieldsResult.Type;

export const MossAppsConnectInput = Schema.Struct({
  toolkitSlug: ToolkitSlug,
  /** The values for an app the user signs in to with their own credentials. */
  credentials: Schema.optional(
    Schema.Record(CredentialFieldName, Schema.String.check(Schema.isMaxLength(8_192))),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MossAppsConnectInput = typeof MossAppsConnectInput.Type;

/**
 * `signInUrl` is set when the user must sign in: open it in the browser and
 * poll `listConnections` until the pending connection turns active.
 */
export const MossAppsConnectResult = Schema.Struct({
  signInUrl: Schema.NullOr(TrimmedNonEmptyString),
  connection: MossAppConnection,
});
export type MossAppsConnectResult = typeof MossAppsConnectResult.Type;

export const MossAppsDisconnectInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MossAppsDisconnectInput = typeof MossAppsDisconnectInput.Type;

export const MossAppsDisconnectResult = Schema.Struct({
  disconnected: Schema.Boolean,
});
export type MossAppsDisconnectResult = typeof MossAppsDisconnectResult.Type;
