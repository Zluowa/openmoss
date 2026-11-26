import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const PLUGIN_SUGGESTION_ACTIVITY_KIND = "plugin.suggested";
export const PLUGIN_SEARCH_TOOL_NAME = "moss_search_plugins";
export const PLUGIN_SUGGEST_TOOL_NAME = "moss_suggest_plugins";
export const PLUGIN_SUGGESTION_MAX_ITEMS = 3;

export const PluginSuggestionSourceKind = Schema.Literals([
  "moss-app",
  "moss-service-plugin",
  "mcp-connector",
  "moss-catalog",
  "moss-bundled",
]);
export type PluginSuggestionSourceKind = typeof PluginSuggestionSourceKind.Type;

export const PluginSuggestionSignIn = Schema.Literals(["managed", "credentials", "setup"]);
export type PluginSuggestionSignIn = typeof PluginSuggestionSignIn.Type;

export const PluginSuggestionItem = Schema.Struct({
  pluginId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  sourceKind: PluginSuggestionSourceKind,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  developerName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  shortDescription: TrimmedNonEmptyString.check(Schema.isMaxLength(320)),
  iconUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  toolkitSlug: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  signIn: Schema.optionalKey(PluginSuggestionSignIn),
  connectorPresetId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  servicePluginId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  marketplaceName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  pluginName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  requiresAuth: Schema.Boolean,
});
export type PluginSuggestionItem = typeof PluginSuggestionItem.Type;

export const PluginSuggestionActivityPayload = Schema.Struct({
  suggestionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  suggestions: Schema.Array(PluginSuggestionItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PLUGIN_SUGGESTION_MAX_ITEMS),
  ),
});
export type PluginSuggestionActivityPayload = typeof PluginSuggestionActivityPayload.Type;

export const decodePluginSuggestionPayload = Schema.decodeUnknownOption(
  PluginSuggestionActivityPayload,
);
