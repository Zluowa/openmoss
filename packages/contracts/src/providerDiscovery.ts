// FILE: providerDiscovery.ts
// Purpose: Defines provider discovery request/response contracts shared across web and server.
// Layer: Shared contracts
// Exports: provider discovery schemas and inferred types used by the WS/native API.

import { Schema } from "effect";
import {
  NonNegativeInt,
  PositiveInt,
  ProcessEnvRecord,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderOptionDescriptor } from "./model";
import { ProviderInstanceId } from "./providerInstance";

const ProviderDiscoveryKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
  "hermes",
  "devin",
  "omp",
  "kimi",
  "minimax",
  "zcode",
]);

export const ProviderSkillInterface = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  /** The skill's own icon: a file beside its SKILL.md, or a URL. */
  iconSmall: Schema.optional(TrimmedNonEmptyString),
  iconSmallUrl: Schema.optional(TrimmedNonEmptyString),
  brandColor: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillInterface = typeof ProviderSkillInterface.Type;

export const ProviderSkillDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  scope: Schema.optional(TrimmedNonEmptyString),
  interface: Schema.optional(ProviderSkillInterface),
  dependencies: Schema.optional(Schema.Unknown),
});
export type ProviderSkillDescriptor = typeof ProviderSkillDescriptor.Type;

export const ProviderSkillReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderSkillReference = typeof ProviderSkillReference.Type;

export const ProviderMentionReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderMentionReference = typeof ProviderMentionReference.Type;

export const ProviderComposerCapabilities = Schema.Struct({
  provider: ProviderDiscoveryKind,
  supportsSkillMentions: Schema.Boolean,
  supportsSkillDiscovery: Schema.Boolean,
  supportsNativeSlashCommandDiscovery: Schema.Boolean,
  supportsPluginMentions: Schema.Boolean,
  supportsPluginDiscovery: Schema.Boolean,
  supportsRuntimeModelList: Schema.Boolean,
  supportsThreadCompaction: Schema.optional(Schema.Boolean),
  supportsThreadImport: Schema.optional(Schema.Boolean),
});
export type ProviderComposerCapabilities = typeof ProviderComposerCapabilities.Type;

export const ProviderGetComposerCapabilitiesInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ProviderGetComposerCapabilitiesInput = typeof ProviderGetComposerCapabilitiesInput.Type;

export const ProviderListSkillsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
  forceReload: Schema.optional(Schema.Boolean),
  /** Management views retain disabled entries so users can enable them again. */
  includeDisabled: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.suspend(() => ProviderCatalogQuery)),
});
export type ProviderListSkillsInput = typeof ProviderListSkillsInput.Type;

export const ProviderListSkillsResult = Schema.Struct({
  skills: Schema.Array(ProviderSkillDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.suspend(() => ProviderCatalogPage)),
});
export type ProviderListSkillsResult = typeof ProviderListSkillsResult.Type;

// A preview may identify a discovered skill, but cannot supply a process,
// credential, or home-directory override to expand the server's discovery scope.
export const ProviderReadSkillInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderReadSkillInput = typeof ProviderReadSkillInput.Type;

export const ProviderReadSkillResult = Schema.Struct({ contents: Schema.String });
export type ProviderReadSkillResult = typeof ProviderReadSkillResult.Type;

// Unified cross-provider skills catalog (Moss portable skills). Descriptors use
// `scope` to carry the origin label ("moss", "codex", "claude", "cursor", ...).
export const ProviderSkillsCatalogInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillsCatalogInput = typeof ProviderSkillsCatalogInput.Type;

export const ProviderSkillsCatalogResult = Schema.Struct({
  skills: Schema.Array(ProviderSkillDescriptor),
  mossSkillsDir: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillsCatalogResult = typeof ProviderSkillsCatalogResult.Type;

export const ProviderNativeCommandDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderNativeCommandDescriptor = typeof ProviderNativeCommandDescriptor.Type;

export const ProviderListCommandsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
  enableArtifacts: Schema.optional(Schema.Boolean),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
  forceReload: Schema.optional(Schema.Boolean),
});
export type ProviderListCommandsInput = typeof ProviderListCommandsInput.Type;

// Whether the provider can publish hosted artifacts in this session: `disabled`
// means the host setting is off, `unavailable` means the provider refused it
// (plan, login, version or organization policy).
export const ProviderArtifactsState = Schema.Literals(["available", "disabled", "unavailable"]);
export type ProviderArtifactsState = typeof ProviderArtifactsState.Type;

export const ProviderListCommandsResult = Schema.Struct({
  commands: Schema.Array(ProviderNativeCommandDescriptor),
  artifacts: Schema.optional(ProviderArtifactsState),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListCommandsResult = typeof ProviderListCommandsResult.Type;

// Remote catalog discovery is deliberately separate from native install state.
// These records are metadata-only: a consumer must never treat them as an
// instruction to clone, install, or execute an untrusted resource.
export const ProviderCatalogResourceKind = Schema.Literals(["plugin", "skill", "mcp"]);
export type ProviderCatalogResourceKind = typeof ProviderCatalogResourceKind.Type;

export const ProviderCatalogSourceTier = Schema.Literals([
  "official",
  "aggregator",
  "curated",
  "discovery",
]);
export type ProviderCatalogSourceTier = typeof ProviderCatalogSourceTier.Type;

export const ProviderCatalogLicense = Schema.Struct({
  status: Schema.Literals(["known", "unknown", "missing", "not-provided"]),
  spdxId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
});
export type ProviderCatalogLicense = typeof ProviderCatalogLicense.Type;

export const ProviderCatalogActivity = Schema.Struct({
  status: Schema.Literals(["active", "stale", "archived", "unknown"]),
  lastUpdatedAt: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
});
export type ProviderCatalogActivity = typeof ProviderCatalogActivity.Type;

export const ProviderCatalogSecurity = Schema.Struct({
  status: Schema.Literals(["source-reviewed", "unreviewed", "needs-review", "blocked"]),
  riskLevel: Schema.Literals(["low", "medium", "high", "unknown"]),
  // Coarse declared/inferred capabilities only; this is not a permission
  // grant and must never be used to authorize a runtime.
  permissions: Schema.Array(TrimmedNonEmptyString),
  permissionSource: Schema.Literals(["manifest", "inferred", "unknown"]),
  signals: Schema.Array(Schema.String),
  checkedAt: Schema.String,
  // This is intentionally a hard contract, not a UI hint. Aggregated entries
  // can be browsed but cannot be executed by the discovery path.
  executionPolicy: Schema.Literal("never"),
});
export type ProviderCatalogSecurity = typeof ProviderCatalogSecurity.Type;

export const ProviderCatalogWithdrawalStatus = Schema.Literals([
  "deleted",
  "deprecated",
  "moderated",
  "withdrawn",
  "removed",
]);
export type ProviderCatalogWithdrawalStatus = typeof ProviderCatalogWithdrawalStatus.Type;

// A negative catalog decision is durable evidence, not an ordinary boolean
// field. Consumers can audit which source/version observed it and aggregation
// must never let a lower-tier active record resurrect the identity.
export const ProviderCatalogWithdrawal = Schema.Struct({
  status: ProviderCatalogWithdrawalStatus,
  sourceId: TrimmedNonEmptyString,
  sourceTier: ProviderCatalogSourceTier,
  sourceVersion: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: Schema.String,
  generation: NonNegativeInt,
  snapshot: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(Schema.String),
});
export type ProviderCatalogWithdrawal = typeof ProviderCatalogWithdrawal.Type;

// A reinstatement is deliberately explicit: an active-looking candidate is
// not enough to erase a negative authoritative decision. The same or a higher
// tier must attest to a newer generation/snapshot.
export const ProviderCatalogReinstatement = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  sourceTier: ProviderCatalogSourceTier,
  sourceVersion: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: Schema.String,
  generation: NonNegativeInt,
  snapshot: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type ProviderCatalogReinstatement = typeof ProviderCatalogReinstatement.Type;

export const ProviderCatalogFieldProvenance = Schema.Struct({
  sourceIds: Schema.Array(TrimmedNonEmptyString),
  sourceTiers: Schema.Array(ProviderCatalogSourceTier),
  sourceVersion: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: Schema.String,
  generation: NonNegativeInt,
  snapshot: TrimmedNonEmptyString,
  upstreamGeneration: NonNegativeInt,
  upstreamSnapshot: TrimmedNonEmptyString,
  localGeneration: NonNegativeInt,
  localSnapshot: TrimmedNonEmptyString,
});
export type ProviderCatalogFieldProvenance = typeof ProviderCatalogFieldProvenance.Type;

export const ProviderCatalogProvenance = Schema.Struct({
  identity: ProviderCatalogFieldProvenance,
  verified: ProviderCatalogFieldProvenance,
  featured: ProviderCatalogFieldProvenance,
  license: ProviderCatalogFieldProvenance,
  activity: ProviderCatalogFieldProvenance,
  security: ProviderCatalogFieldProvenance,
  withdrawal: Schema.NullOr(ProviderCatalogFieldProvenance),
});
export type ProviderCatalogProvenance = typeof ProviderCatalogProvenance.Type;

export const ProviderCatalogEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ProviderCatalogResourceKind,
  name: TrimmedNonEmptyString,
  displayName: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  sourceIds: Schema.Array(TrimmedNonEmptyString),
  sourceTiers: Schema.Array(ProviderCatalogSourceTier),
  sourceUrl: Schema.NullOr(Schema.String),
  homepageUrl: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  featured: Schema.Boolean,
  verified: Schema.Boolean,
  compatibility: Schema.Array(TrimmedNonEmptyString),
  qualityScore: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  license: ProviderCatalogLicense,
  activity: ProviderCatalogActivity,
  security: ProviderCatalogSecurity,
  withdrawal: Schema.NullOr(ProviderCatalogWithdrawal),
  provenance: ProviderCatalogProvenance,
  // Installation remains a separate, explicit user flow. The aggregation
  // layer never returns an executable command or auto-install action.
  installPolicy: Schema.Literal("manual-review-only"),
  metadata: Schema.Record(Schema.String, Schema.Json),
});
export type ProviderCatalogEntry = typeof ProviderCatalogEntry.Type;

export const ProviderCatalogSourceStatus = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  tier: ProviderCatalogSourceTier,
  enabled: Schema.Boolean,
  cached: Schema.Boolean,
  itemCount: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
  remoteCursor: Schema.NullOr(Schema.String),
  generation: NonNegativeInt,
  sourceVersion: Schema.NullOr(TrimmedNonEmptyString),
  snapshot: TrimmedNonEmptyString,
});
export type ProviderCatalogSourceStatus = typeof ProviderCatalogSourceStatus.Type;

export const ProviderCatalogPage = Schema.Struct({
  kind: ProviderCatalogResourceKind,
  entries: Schema.Array(ProviderCatalogEntry),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  totalKnown: NonNegativeInt,
  partial: Schema.Boolean,
  cached: Schema.Boolean,
  fetchedAt: Schema.String,
  snapshot: TrimmedNonEmptyString,
  sources: Schema.Array(ProviderCatalogSourceStatus),
});
export type ProviderCatalogPage = typeof ProviderCatalogPage.Type;

export const ProviderCatalogQuery = Schema.Struct({
  query: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  sourceIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  licenseSpdxIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  compatibility: Schema.optional(TrimmedNonEmptyString),
  minQualityScore: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  sort: Schema.optional(Schema.Literals(["featured", "quality", "updated", "name"])),
  featuredOnly: Schema.optional(Schema.Boolean),
  verifiedOnly: Schema.optional(Schema.Boolean),
  includeUnverified: Schema.optional(Schema.Boolean),
  includeStale: Schema.optional(Schema.Boolean),
});
export type ProviderCatalogQuery = typeof ProviderCatalogQuery.Type;

// Plugin discovery mirrors Codex app-server's marketplace + plugin summary surface.
export const ProviderPluginMarketplaceInterface = Schema.Struct({
  displayName: Schema.NullOr(Schema.String),
});
export type ProviderPluginMarketplaceInterface = typeof ProviderPluginMarketplaceInterface.Type;

export const ProviderPluginInstallPolicy = Schema.Literals([
  "NOT_AVAILABLE",
  "AVAILABLE",
  "INSTALLED_BY_DEFAULT",
]);
export type ProviderPluginInstallPolicy = typeof ProviderPluginInstallPolicy.Type;

export const ProviderPluginAuthPolicy = Schema.Literals(["ON_INSTALL", "ON_USE"]);
export type ProviderPluginAuthPolicy = typeof ProviderPluginAuthPolicy.Type;

export const ProviderPluginAvailability = Schema.Literals(["AVAILABLE", "DISABLED_BY_ADMIN"]);
export type ProviderPluginAvailability = typeof ProviderPluginAvailability.Type;

export const ProviderPluginSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("local"),
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("git"),
    url: TrimmedNonEmptyString,
    path: Schema.NullOr(TrimmedNonEmptyString),
    refName: Schema.NullOr(TrimmedNonEmptyString),
    sha: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("npm"),
    package: TrimmedNonEmptyString,
    version: Schema.NullOr(TrimmedNonEmptyString),
    registry: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("remote"),
  }),
]);
export type ProviderPluginSource = typeof ProviderPluginSource.Type;

export const ProviderPluginInstallPolicySource = Schema.Literals([
  "WORKSPACE_SETTING",
  "IMPLICIT_CANONICAL_APP",
]);
export type ProviderPluginInstallPolicySource = typeof ProviderPluginInstallPolicySource.Type;

export const ProviderPluginSharePrincipal = Schema.Struct({
  principalType: Schema.Literals(["user", "group", "workspace"]),
  principalId: TrimmedNonEmptyString,
  role: Schema.Literals(["reader", "editor", "owner"]),
  name: TrimmedNonEmptyString,
});
export type ProviderPluginSharePrincipal = typeof ProviderPluginSharePrincipal.Type;

export const ProviderPluginShareContext = Schema.Struct({
  remotePluginId: TrimmedNonEmptyString,
  remoteVersion: Schema.NullOr(TrimmedNonEmptyString),
  discoverability: Schema.NullOr(Schema.Literals(["LISTED", "UNLISTED", "PRIVATE"])),
  shareUrl: Schema.NullOr(TrimmedNonEmptyString),
  creatorAccountUserId: Schema.NullOr(TrimmedNonEmptyString),
  creatorName: Schema.NullOr(TrimmedNonEmptyString),
  sharePrincipals: Schema.NullOr(Schema.Array(ProviderPluginSharePrincipal)),
});
export type ProviderPluginShareContext = typeof ProviderPluginShareContext.Type;

export const ProviderPluginInterface = Schema.Struct({
  displayName: Schema.NullOr(Schema.String),
  shortDescription: Schema.NullOr(Schema.String),
  longDescription: Schema.NullOr(Schema.String),
  developerName: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(Schema.String),
  websiteUrl: Schema.NullOr(Schema.String),
  privacyPolicyUrl: Schema.NullOr(Schema.String),
  termsOfServiceUrl: Schema.NullOr(Schema.String),
  defaultPrompt: Schema.NullOr(Schema.Array(Schema.String)),
  brandColor: Schema.NullOr(Schema.String),
  composerIcon: Schema.NullOr(Schema.String),
  composerIconUrl: Schema.NullOr(Schema.String),
  logo: Schema.NullOr(Schema.String),
  logoDark: Schema.NullOr(Schema.String),
  logoUrl: Schema.NullOr(Schema.String),
  logoUrlDark: Schema.NullOr(Schema.String),
  screenshots: Schema.Array(Schema.String),
  screenshotUrls: Schema.Array(Schema.String),
});
export type ProviderPluginInterface = typeof ProviderPluginInterface.Type;

export const ProviderPluginDescriptor = Schema.Struct({
  id: TrimmedNonEmptyString,
  remotePluginId: Schema.NullOr(Schema.String),
  name: TrimmedNonEmptyString,
  version: Schema.NullOr(Schema.String),
  localVersion: Schema.NullOr(Schema.String),
  shareContext: Schema.NullOr(ProviderPluginShareContext),
  availability: ProviderPluginAvailability,
  keywords: Schema.Array(Schema.String),
  source: ProviderPluginSource,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  installPolicy: ProviderPluginInstallPolicy,
  installPolicySource: Schema.NullOr(ProviderPluginInstallPolicySource),
  authPolicy: ProviderPluginAuthPolicy,
  interface: Schema.NullOr(ProviderPluginInterface),
});
export type ProviderPluginDescriptor = typeof ProviderPluginDescriptor.Type;

export const ProviderPluginMarketplaceLoadError = Schema.Struct({
  marketplacePath: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ProviderPluginMarketplaceLoadError = typeof ProviderPluginMarketplaceLoadError.Type;

/**
 * A CLI's whole plugin listing failing (timed out, signed out) is reported as a
 * load error whose `marketplacePath` is the provider kind plus this suffix
 * ("codex-native"), not a marketplace file's path.
 */
export const PROVIDER_PLUGIN_LISTING_LOAD_ERROR_SUFFIX = "-native";

export const ProviderPluginMarketplaceDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: Schema.NullOr(TrimmedNonEmptyString),
  interface: Schema.NullOr(ProviderPluginMarketplaceInterface),
  plugins: Schema.Array(ProviderPluginDescriptor),
});
export type ProviderPluginMarketplaceDescriptor = typeof ProviderPluginMarketplaceDescriptor.Type;

export const ProviderPluginAppSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  installUrl: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
});
export type ProviderPluginAppSummary = typeof ProviderPluginAppSummary.Type;

export const ProviderPluginHookEventName = Schema.Literals([
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
]);
export type ProviderPluginHookEventName = typeof ProviderPluginHookEventName.Type;

export const ProviderPluginHookSummary = Schema.Struct({
  key: Schema.String,
  eventName: ProviderPluginHookEventName,
});
export type ProviderPluginHookSummary = typeof ProviderPluginHookSummary.Type;

export const ProviderAppTemplateUnavailableReason = Schema.Literals([
  "NOT_CONFIGURED_FOR_WORKSPACE",
  "NO_ACTIVE_WORKSPACE",
]);
export type ProviderAppTemplateUnavailableReason = typeof ProviderAppTemplateUnavailableReason.Type;

export const ProviderAppTemplateSummary = Schema.Struct({
  templateId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  canonicalConnectorId: Schema.NullOr(Schema.String),
  logoUrl: Schema.NullOr(Schema.String),
  logoUrlDark: Schema.NullOr(Schema.String),
  materializedAppIds: Schema.Array(Schema.String),
  reason: Schema.NullOr(ProviderAppTemplateUnavailableReason),
});
export type ProviderAppTemplateSummary = typeof ProviderAppTemplateSummary.Type;

export const ProviderPluginMarketplaceKind = Schema.Literals([
  "local",
  "vertical",
  "workspace-directory",
  "shared-with-me",
  "created-by-me-remote",
]);
export type ProviderPluginMarketplaceKind = typeof ProviderPluginMarketplaceKind.Type;

export const ProviderListPluginsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
  marketplaceKinds: Schema.optional(Schema.Array(ProviderPluginMarketplaceKind)),
  forceRemoteSync: Schema.optional(Schema.Boolean),
  forceReload: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.suspend(() => ProviderCatalogQuery)),
});
export type ProviderListPluginsInput = typeof ProviderListPluginsInput.Type;

export const ProviderListPluginsResult = Schema.Struct({
  marketplaces: Schema.Array(ProviderPluginMarketplaceDescriptor),
  marketplaceLoadErrors: Schema.Array(ProviderPluginMarketplaceLoadError),
  remoteSyncError: Schema.NullOr(TrimmedNonEmptyString),
  featuredPluginIds: Schema.Array(TrimmedNonEmptyString),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.suspend(() => ProviderCatalogPage)),
});
export type ProviderListPluginsResult = typeof ProviderListPluginsResult.Type;

export const ProviderReadPluginInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  marketplacePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  remoteMarketplaceName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pluginName: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
}).check(
  Schema.makeFilter(
    (input) =>
      Number(typeof input.marketplacePath === "string") +
        Number(typeof input.remoteMarketplaceName === "string") ===
        1 || "Exactly one marketplace selector is required.",
    { identifier: "ProviderPluginMarketplaceSelector" },
  ),
);
export type ProviderReadPluginInput = typeof ProviderReadPluginInput.Type;

const ProviderPluginMutationContext = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const ProviderAddMarketplaceInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  source: TrimmedNonEmptyString,
  refName: Schema.NullOr(TrimmedNonEmptyString),
  sparsePaths: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
});
export type ProviderAddMarketplaceInput = typeof ProviderAddMarketplaceInput.Type;

export const ProviderAddMarketplaceResult = Schema.Struct({
  marketplaceName: TrimmedNonEmptyString,
  installedRoot: TrimmedNonEmptyString,
  alreadyAdded: Schema.Boolean,
});
export type ProviderAddMarketplaceResult = typeof ProviderAddMarketplaceResult.Type;

export const ProviderRemoveMarketplaceInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  marketplaceName: TrimmedNonEmptyString,
});
export type ProviderRemoveMarketplaceInput = typeof ProviderRemoveMarketplaceInput.Type;

export const ProviderRemoveMarketplaceResult = Schema.Struct({
  marketplaceName: Schema.String,
  installedRoot: Schema.NullOr(Schema.String),
});
export type ProviderRemoveMarketplaceResult = typeof ProviderRemoveMarketplaceResult.Type;

export const ProviderUpgradeMarketplaceInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  marketplaceName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ProviderUpgradeMarketplaceInput = typeof ProviderUpgradeMarketplaceInput.Type;

export const ProviderMarketplaceUpgradeError = Schema.Struct({
  marketplaceName: Schema.String,
  message: Schema.String,
});
export type ProviderMarketplaceUpgradeError = typeof ProviderMarketplaceUpgradeError.Type;

export const ProviderUpgradeMarketplaceResult = Schema.Struct({
  selectedMarketplaces: Schema.Array(Schema.String),
  upgradedRoots: Schema.Array(Schema.String),
  errors: Schema.Array(ProviderMarketplaceUpgradeError),
});
export type ProviderUpgradeMarketplaceResult = typeof ProviderUpgradeMarketplaceResult.Type;

export const ProviderInstallPluginInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  marketplacePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  remoteMarketplaceName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pluginName: TrimmedNonEmptyString,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(typeof input.marketplacePath === "string") +
        Number(typeof input.remoteMarketplaceName === "string") ===
        1 || "Exactly one marketplace selector is required.",
    { identifier: "ProviderPluginMarketplaceSelector" },
  ),
);
export type ProviderInstallPluginInput = typeof ProviderInstallPluginInput.Type;

export const ProviderPluginInstallAppSummary = ProviderPluginAppSummary;
export type ProviderPluginInstallAppSummary = typeof ProviderPluginInstallAppSummary.Type;

export const ProviderInstallPluginResult = Schema.Struct({
  authPolicy: ProviderPluginAuthPolicy,
  appsNeedingAuth: Schema.Array(ProviderPluginInstallAppSummary),
});
export type ProviderInstallPluginResult = typeof ProviderInstallPluginResult.Type;

export const ProviderUninstallPluginInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  pluginId: TrimmedNonEmptyString,
});
export type ProviderUninstallPluginInput = typeof ProviderUninstallPluginInput.Type;

export const ProviderUninstallPluginResult = Schema.Struct({});
export type ProviderUninstallPluginResult = typeof ProviderUninstallPluginResult.Type;

export const ProviderSetPluginEnabledInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  pluginId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderSetPluginEnabledInput = typeof ProviderSetPluginEnabledInput.Type;

export const ProviderSetPluginEnabledResult = Schema.Struct({
  status: Schema.Literals(["ok", "okOverridden"]),
});
export type ProviderSetPluginEnabledResult = typeof ProviderSetPluginEnabledResult.Type;

export const ProviderAppBranding = Schema.Struct({
  category: Schema.NullOr(Schema.String),
  developer: Schema.NullOr(Schema.String),
  website: Schema.NullOr(Schema.String),
  privacyPolicy: Schema.NullOr(Schema.String),
  termsOfService: Schema.NullOr(Schema.String),
  isDiscoverableApp: Schema.Boolean,
});
export type ProviderAppBranding = typeof ProviderAppBranding.Type;

export const ProviderAppReview = Schema.Struct({
  status: Schema.String,
});
export type ProviderAppReview = typeof ProviderAppReview.Type;

export const ProviderAppScreenshot = Schema.Struct({
  url: Schema.NullOr(Schema.String),
  fileId: Schema.NullOr(Schema.String),
  userPrompt: Schema.String,
});
export type ProviderAppScreenshot = typeof ProviderAppScreenshot.Type;

export const ProviderAppMetadata = Schema.Struct({
  review: Schema.NullOr(ProviderAppReview),
  categories: Schema.NullOr(Schema.Array(Schema.String)),
  subCategories: Schema.NullOr(Schema.Array(Schema.String)),
  seoDescription: Schema.NullOr(Schema.String),
  screenshots: Schema.NullOr(Schema.Array(ProviderAppScreenshot)),
  developer: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(Schema.String),
  versionNotes: Schema.NullOr(Schema.String),
  firstPartyType: Schema.NullOr(Schema.String),
  firstPartyRequiresInstall: Schema.NullOr(Schema.Boolean),
  showInComposerWhenUnlinked: Schema.NullOr(Schema.Boolean),
});
export type ProviderAppMetadata = typeof ProviderAppMetadata.Type;

const ProviderStringRecord = Schema.Record(Schema.String, Schema.String);

export const ProviderAppInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  logoUrl: Schema.NullOr(Schema.String),
  logoUrlDark: Schema.NullOr(Schema.String),
  iconAssets: Schema.NullOr(ProviderStringRecord),
  iconDarkAssets: Schema.NullOr(ProviderStringRecord),
  distributionChannel: Schema.NullOr(Schema.String),
  branding: Schema.NullOr(ProviderAppBranding),
  appMetadata: Schema.NullOr(ProviderAppMetadata),
  labels: Schema.NullOr(ProviderStringRecord),
  installUrl: Schema.NullOr(Schema.String),
  isAccessible: Schema.Boolean,
  isEnabled: Schema.Boolean,
  pluginDisplayNames: Schema.Array(Schema.String),
});
export type ProviderAppInfo = typeof ProviderAppInfo.Type;

export const ProviderListAppsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  threadId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  forceRefetch: Schema.optional(Schema.Boolean),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});
export type ProviderListAppsInput = typeof ProviderListAppsInput.Type;

export const ProviderListAppsResult = Schema.Struct({
  data: Schema.Array(ProviderAppInfo),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ProviderListAppsResult = typeof ProviderListAppsResult.Type;

export const ProviderSetAppEnabledInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  appId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderSetAppEnabledInput = typeof ProviderSetAppEnabledInput.Type;

export const ProviderSetAppEnabledResult = Schema.Struct({
  status: Schema.Literals(["ok", "okOverridden"]),
});
export type ProviderSetAppEnabledResult = typeof ProviderSetAppEnabledResult.Type;

// ChatGPT connector metadata is not part of Codex app-server's native app/list
// protocol. These normalized contracts intentionally expose only fields consumed
// by the Codex Desktop Apps detail/connect surfaces; raw backend payloads and
// credentials never cross the server boundary.
export const ProviderAppConnectorAuthMode = Schema.Literals(["OAUTH", "NONE", "UNSUPPORTED"]);
export type ProviderAppConnectorAuthMode = typeof ProviderAppConnectorAuthMode.Type;

export const ProviderAppConnectorDetail = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: Schema.NullOr(Schema.String),
  authMode: ProviderAppConnectorAuthMode,
  requiresLinkParameters: Schema.Boolean,
});
export type ProviderAppConnectorDetail = typeof ProviderAppConnectorDetail.Type;

export const ProviderAppTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  disabledReason: Schema.NullOr(Schema.String),
  visibility: Schema.NullOr(Schema.String),
  accessBadges: Schema.Array(Schema.String),
});
export type ProviderAppTool = typeof ProviderAppTool.Type;

export const ProviderReadAppToolsInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  appId: TrimmedNonEmptyString,
});
export type ProviderReadAppToolsInput = typeof ProviderReadAppToolsInput.Type;

export const ProviderReadAppToolsResult = Schema.Struct({
  tools: Schema.Array(ProviderAppTool),
});
export type ProviderReadAppToolsResult = typeof ProviderReadAppToolsResult.Type;

export const ProviderReadAppConnectorInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  appId: TrimmedNonEmptyString,
});
export type ProviderReadAppConnectorInput = typeof ProviderReadAppConnectorInput.Type;

export const ProviderReadAppConnectorResult = Schema.Struct({
  connector: ProviderAppConnectorDetail,
});
export type ProviderReadAppConnectorResult = typeof ProviderReadAppConnectorResult.Type;

export const ProviderAppConnectorTermsBlurb = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
});
export type ProviderAppConnectorTermsBlurb = typeof ProviderAppConnectorTermsBlurb.Type;

export const ProviderAppConnectorPersonalizationMode = Schema.Literals([
  "UNSET",
  "PERSONALIZE_ALWAYS",
  "NO_PERSONALIZATION",
]);
export type ProviderAppConnectorPersonalizationMode =
  typeof ProviderAppConnectorPersonalizationMode.Type;

export const ProviderAppConnectorTerms = Schema.Struct({
  blurbs: Schema.Array(ProviderAppConnectorTermsBlurb),
  personalizationDefault: Schema.NullOr(ProviderAppConnectorPersonalizationMode),
  personalizationToggleBlurb: Schema.NullOr(Schema.String),
});
export type ProviderAppConnectorTerms = typeof ProviderAppConnectorTerms.Type;

export const ProviderReadAppConnectorTermsInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  appId: TrimmedNonEmptyString,
});
export type ProviderReadAppConnectorTermsInput = typeof ProviderReadAppConnectorTermsInput.Type;

export const ProviderReadAppConnectorTermsResult = Schema.Struct({
  terms: ProviderAppConnectorTerms,
});
export type ProviderReadAppConnectorTermsResult = typeof ProviderReadAppConnectorTermsResult.Type;

export const ProviderAppReauthentication = Schema.Struct({
  linkId: TrimmedNonEmptyString,
  requestedScopes: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
});
export type ProviderAppReauthentication = typeof ProviderAppReauthentication.Type;

export const ProviderStartAppConnectionInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  appId: TrimmedNonEmptyString,
  callbackUrl: TrimmedNonEmptyString,
  postAuthUrl: TrimmedNonEmptyString,
  reauthentication: Schema.NullOr(ProviderAppReauthentication),
});
export type ProviderStartAppConnectionInput = typeof ProviderStartAppConnectionInput.Type;

export const ProviderStartAppConnectionResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("connectedDirectly") }),
  Schema.Struct({
    kind: Schema.Literal("oauthStarted"),
    redirectUrl: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("browserFallback"),
    reason: Schema.Literals(["LINK_PARAMETERS_REQUIRED", "UNSUPPORTED_AUTH"]),
  }),
]);
export type ProviderStartAppConnectionResult = typeof ProviderStartAppConnectionResult.Type;

export const ProviderCompleteAppConnectionInput = Schema.Struct({
  ...ProviderPluginMutationContext.fields,
  fullRedirectUrl: TrimmedNonEmptyString,
});
export type ProviderCompleteAppConnectionInput = typeof ProviderCompleteAppConnectionInput.Type;

export const ProviderCompleteAppConnectionResult = Schema.Struct({
  appId: TrimmedNonEmptyString,
  appName: TrimmedNonEmptyString,
});
export type ProviderCompleteAppConnectionResult = typeof ProviderCompleteAppConnectionResult.Type;

export const ProviderPluginDetail = Schema.Struct({
  marketplaceName: TrimmedNonEmptyString,
  marketplacePath: Schema.NullOr(TrimmedNonEmptyString),
  summary: ProviderPluginDescriptor,
  shareUrl: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  skills: Schema.Array(ProviderSkillDescriptor),
  hooks: Schema.Array(ProviderPluginHookSummary),
  apps: Schema.Array(ProviderPluginAppSummary),
  appTemplates: Schema.Array(ProviderAppTemplateSummary),
  mcpServers: Schema.Array(TrimmedNonEmptyString),
});
export type ProviderPluginDetail = typeof ProviderPluginDetail.Type;

export const ProviderReadPluginResult = Schema.Struct({
  plugin: ProviderPluginDetail,
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderReadPluginResult = typeof ProviderReadPluginResult.Type;

export const ProviderListModelsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  // Interactive reads await revalidation; manual refresh still respects server throttling.
  refresh: Schema.optional(Schema.Literals(["if-stale", "now"])),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderListModelsInput = typeof ProviderListModelsInput.Type;

export const ProviderReasoningEffortDescriptor = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderReasoningEffortDescriptor = typeof ProviderReasoningEffortDescriptor.Type;

export const ProviderContextWindowDescriptor = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Literal(true)),
});
export type ProviderContextWindowDescriptor = typeof ProviderContextWindowDescriptor.Type;

// Some provider CLIs expose a family-level model with a matrix of concrete
// process-start variants. The web app uses this mapping to keep the friendly
// effort/context/fast controls separate from the provider's opaque model UID.
export const ProviderModelVariantDescriptor = Schema.Struct({
  model: TrimmedNonEmptyString,
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  contextWindow: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Boolean),
});
export type ProviderModelVariantDescriptor = typeof ProviderModelVariantDescriptor.Type;

export const ProviderModelDescriptor = Schema.Struct({
  slug: TrimmedNonEmptyString,
  resolvedModel: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  upstreamProviderId: Schema.optional(TrimmedNonEmptyString),
  upstreamProviderName: Schema.optional(TrimmedNonEmptyString),
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
  // Codex model/list results are normalized here so the web app can consume both
  // the legacy string array and Remodex-style reasoning objects uniformly.
  supportedReasoningEfforts: Schema.optional(Schema.Array(ProviderReasoningEffortDescriptor)),
  defaultReasoningEffort: Schema.optional(TrimmedNonEmptyString),
  supportsFastMode: Schema.optional(Schema.Boolean),
  supportsThinkingToggle: Schema.optional(Schema.Boolean),
  supportsAutoMode: Schema.optional(Schema.Boolean),
  contextWindowOptions: Schema.optional(Schema.Array(ProviderContextWindowDescriptor)),
  defaultContextWindow: Schema.optional(TrimmedNonEmptyString),
  modelVariants: Schema.optional(Schema.Array(ProviderModelVariantDescriptor)),
});
export type ProviderModelDescriptor = typeof ProviderModelDescriptor.Type;

export const ProviderListModelsResult = Schema.Struct({
  models: Schema.Array(ProviderModelDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
  // A partial or fallback catalog must not replace the last complete discovery.
  degraded: Schema.optional(Schema.Boolean),
  // A concise, redacted explanation when live discovery failed and the result
  // was populated from a static fallback.
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderListModelsResult = typeof ProviderListModelsResult.Type;

export const ProviderListAgentsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  instanceId: Schema.optional(ProviderInstanceId),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
  environment: Schema.optional(ProcessEnvRecord),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderListAgentsInput = typeof ProviderListAgentsInput.Type;

export const ProviderAgentDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAgentDescriptor = typeof ProviderAgentDescriptor.Type;

export const ProviderListAgentsResult = Schema.Struct({
  agents: Schema.Array(ProviderAgentDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListAgentsResult = typeof ProviderListAgentsResult.Type;

// ── MCP discovery ─────────────────────────────────────────────────────────
// Unlike plugins (a Codex marketplace surface), MCP servers are discovered as a
// unified cross-engine catalog: the canonical Moss `.moss/mcp/config.json` plus
// every engine's native MCP config (Codex `config.toml [mcp_servers.*]`, Claude
// `.mcp.json` / `~/.claude.json`). Deduped by name; the Moss-canonical origin
// wins so the runtime catalog mirrors the projected bridges (SY4 parity).
export const ProviderMcpTransport = Schema.Literals(["stdio", "http", "sse", "unknown"]);
export type ProviderMcpTransport = typeof ProviderMcpTransport.Type;

export const ProviderMcpServerDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: ProviderMcpTransport,
  /** Origin label: "moss" | "codex" | "claude" | "moss" | provider kinds. */
  origin: TrimmedNonEmptyString,
  /** Where the server was discovered: absolute path of the owning config file. */
  path: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  command: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  url: Schema.optional(TrimmedNonEmptyString),
  /** Redacted env var names only (values are never surfaced to the client). */
  envKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderMcpServerDescriptor = typeof ProviderMcpServerDescriptor.Type;

export const ProviderListMcpInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  forceReload: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.suspend(() => ProviderCatalogQuery)),
});
export type ProviderListMcpInput = typeof ProviderListMcpInput.Type;

export const ProviderListMcpResult = Schema.Struct({
  servers: Schema.Array(ProviderMcpServerDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.suspend(() => ProviderCatalogPage)),
});
export type ProviderListMcpResult = typeof ProviderListMcpResult.Type;
