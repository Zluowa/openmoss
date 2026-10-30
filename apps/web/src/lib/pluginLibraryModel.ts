// FILE: pluginLibraryModel.ts
// Purpose: Pure helpers for the Plugins/MCP/Skills library — source (origin)
//          classification and labels shared by the browser grids, the source
//          filter chips, the management panel, and the detail dialog. Codex
//          Desktop shows three fixed source buckets (By OpenAI / By your
//          workspace / Personal); Moss is multi-engine, so sources are derived
//          from the actual origin/scope of each discovered resource.
// Layer: Web lib (pure, no React)
// Exports: LibraryTab, resource source helpers, origin/scope label maps.

import type {
  ModelSelection,
  ProviderListPluginsResult,
  ProviderMcpServerDescriptor,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceLoadError,
  ProviderInstanceId,
  ProviderKind,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import {
  PROVIDER_PLUGIN_LISTING_LOAD_ERROR_SUFFIX,
  isSupportedProviderKind,
} from "@synara/contracts";
import { MOSS_APPS_MARKETPLACE_NAME } from "./mossAppsPlugins";
import {
  inferLegacyProviderKindFromModelSelection,
  resolveModelSelectionInstanceId,
} from "@synara/shared/providerInstances";

export type LibraryTab = "plugins" | "mcp" | "skills";

/**
 * Resolves the provider account that owns the library request. A thread session
 * is authoritative when it is already bound; the model selection is the cold-
 * start fallback. Returning the selected provider kind for an unrelated
 * provider keeps the server's default-instance resolution intact.
 */
export function resolvePluginLibraryProviderInstanceId(input: {
  readonly selectedProvider: ProviderKind;
  readonly activeThread?: {
    readonly modelSelection:
      | Pick<ModelSelection, "provider" | "instanceId" | "model">
      | null
      | undefined;
    readonly session?: {
      readonly providerName?: ProviderKind | null;
      readonly providerInstanceId?: ProviderInstanceId;
    } | null;
  } | null;
  readonly fallbackModelSelection?: Pick<
    ModelSelection,
    "provider" | "instanceId" | "model"
  > | null;
  /** Enabled managed Moss host for the standalone Moss bucket only. */
  readonly standaloneMossInstanceId?: ProviderInstanceId | null;
}): ProviderInstanceId {
  const candidates = [
    input.activeThread
      ? {
          provider: input.activeThread.session?.providerName,
          instanceId: input.activeThread.session?.providerInstanceId,
        }
      : null,
    input.activeThread?.modelSelection
      ? {
          provider: inferLegacyProviderKindFromModelSelection(input.activeThread.modelSelection),
          instanceId: resolveModelSelectionInstanceId(input.activeThread.modelSelection),
        }
      : null,
    !input.activeThread && input.standaloneMossInstanceId
      ? { provider: "codex", instanceId: input.standaloneMossInstanceId }
      : null,
    input.fallbackModelSelection
      ? {
          provider: inferLegacyProviderKindFromModelSelection(input.fallbackModelSelection),
          instanceId: resolveModelSelectionInstanceId(input.fallbackModelSelection),
        }
      : null,
  ];
  const matching = candidates.find(
    (candidate) =>
      candidate?.provider === input.selectedProvider && candidate.instanceId !== undefined,
  );
  return matching?.instanceId ?? (input.selectedProvider as ProviderInstanceId);
}

export interface LibrarySource {
  /** Stable key used for the active-filter comparison. */
  readonly key: string;
  /** Human label rendered on the filter chip. */
  readonly label: string;
}

// Origin/scope → display label. Covers Moss-canonical, Moss-portable, every
// engine origin, and the generic workspace/project bucket. Unknown origins fall
// back to a title-cased form so nothing is silently dropped.
const ORIGIN_LABELS: Record<string, string> = {
  moss: "Moss",
  project: "Workspace",
  workspace: "Workspace",
  repo: "Workspace",
  codex: "Codex",
  claude: "Claude",
  claudeAgent: "Claude",
  cursor: "Cursor",
  gemini: "Gemini",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
  agents: "Agents",
  admin: "System",
  personal: "Personal",
};

export function originLabel(origin: string | undefined | null): string {
  const key = (origin ?? "").trim();
  if (key.length === 0) return "Other";
  return ORIGIN_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function skillSource(skill: ProviderSkillDescriptor): LibrarySource {
  const scope = skill.scope?.trim() || "other";
  return { key: `skill:${scope}`, label: originLabel(scope) };
}

// Codex's plugin directory has three exclusive source tabs (By OpenAI / By your
// workspace / Personal). Keep Moss's internal bucket id and rebrand only the
// vendor label while preserving the current desktop directory structure.
export type LibraryBucket = "moss" | "workspace" | "personal";

export const LIBRARY_BUCKETS: ReadonlyArray<{ id: LibraryBucket; label: string }> = [
  { id: "moss", label: "Moss" },
  { id: "workspace", label: "By your workspace" },
  { id: "personal", label: "Personal" },
];

const DEFAULT_FEATURED_PLUGIN_IDS = [
  "computer-use@openai-curated",
  "browser@openai-curated",
  "chrome@openai-curated",
  "chrome-internal@openai-curated",
  "spreadsheets@openai-primary-runtime",
  "presentations@openai-primary-runtime",
];

export interface CodexPluginDirectoryEntry {
  readonly plugin: ProviderPluginDescriptor;
  readonly isFeatured?: boolean;
  readonly createdByYou?: boolean;
  readonly sharedWithYou?: boolean;
  readonly marketplaceName?: string;
  /** The marketplace's own display name; Personal sections are titled by it. */
  readonly marketplaceDisplayName?: string;
}

/**
 * Vendor marketplaces (Codex's curated/bundled catalogs and Moss's own bundle)
 * form the Public directory; every other local marketplace was added by the
 * user and belongs to Personal, which is how Codex splits its directory tabs.
 */
export function isBuiltInPluginMarketplace(name: string): boolean {
  return /^(openai|codex|moss)-[a-z0-9-]+$/.test(name.trim().toLowerCase());
}

export type PluginDirectoryProvenance =
  | "local-or-vertical"
  /** plugin/list without kinds: Codex desktop's own directory, the remote catalog. */
  | "remote-directory"
  | "workspace-directory"
  | "shared-with-me"
  | "created-by-me-remote"
  /** Apps from the hosted Moss Apps catalog, listed as plugins. */
  | "moss-apps";

/**
 * Codex desktop's directory order (26.1016, observed against a signed-in
 * account): the remote catalog's categories, Productivity first, Other last.
 */
export const CODEX_DIRECTORY_CATEGORY_ORDER: readonly string[] = [
  "Productivity",
  "Communication",
  "Creativity",
  "Developer Tools",
  "Healthcare",
  "Finance",
  "Travel",
  "Entertainment",
  "Education & Research",
  "Business & Operations",
  "Data & Analytics",
  "Scientific Research",
  "Security",
  "Other",
];

/**
 * Codex desktop's directory is plugin/list without kinds: the remote catalog
 * ("openai-curated-remote", ~9.5k plugins in its categories) beside the bundled
 * marketplaces. Once it has arrived it stands in for the local copy of that
 * catalog ("openai-curated", ~120 plugins) and its order leads, as in Codex;
 * until then the local lanes carry the page.
 */
export function withRemotePluginDirectory<
  TEntry extends Pick<ProviderPluginDirectoryEntry, "marketplaceName" | "marketplacePath">,
>(local: readonly TEntry[], directory: readonly TEntry[]): TEntry[] {
  const remoteCatalogs = new Set(
    directory
      .filter((entry) => entry.marketplacePath === null)
      .map((entry) => entry.marketplaceName),
  );
  if (remoteCatalogs.size === 0) return [...local];
  return [
    ...directory.filter((entry) => remoteCatalogs.has(entry.marketplaceName)),
    ...local.filter((entry) => !remoteCatalogs.has(`${entry.marketplaceName}-remote`)),
    ...directory.filter((entry) => !remoteCatalogs.has(entry.marketplaceName)),
  ];
}

export interface ProviderPluginDirectoryEntry extends CodexPluginDirectoryEntry {
  readonly marketplaceName: string;
  readonly marketplacePath: string | null;
  readonly remoteMarketplaceName: string | null;
  readonly bucket: LibraryBucket;
  readonly provenance: PluginDirectoryProvenance;
  readonly isFeatured: boolean;
  readonly createdByYou: boolean;
  readonly sharedWithYou: boolean;
}

/**
 * Materializes one frozen Codex plugin-list lane without inferring relationship
 * provenance from marketplace names or local paths. Remote relationship lanes
 * intentionally carry a null filesystem path and address details by name.
 */
export function providerPluginDirectoryEntries(input: {
  readonly result: ProviderListPluginsResult | undefined;
  readonly provenance: PluginDirectoryProvenance;
}): ProviderPluginDirectoryEntry[] {
  const featuredIds = new Set(input.result?.featuredPluginIds ?? []);
  return (input.result?.marketplaces ?? []).flatMap((marketplace) => {
    const remoteMarketplaceName = marketplace.path === null ? marketplace.name : null;
    const bucket: LibraryBucket =
      input.provenance === "workspace-directory"
        ? "workspace"
        : input.provenance === "shared-with-me" || input.provenance === "created-by-me-remote"
          ? "personal"
          : pluginBucket({
              marketplaceName: marketplace.name,
              marketplacePath: marketplace.path,
            });
    return marketplace.plugins.map((plugin) => ({
      marketplaceName: marketplace.name,
      marketplaceDisplayName: marketplace.interface?.displayName?.trim() || marketplace.name,
      marketplacePath: marketplace.path,
      remoteMarketplaceName,
      bucket,
      provenance: input.provenance,
      plugin,
      isFeatured: featuredIds.has(plugin.id),
      createdByYou: input.provenance === "created-by-me-remote",
      sharedWithYou: input.provenance === "shared-with-me",
    }));
  });
}

/**
 * Category-like sections ("Popular ›", "Productivity ›") open their own
 * category page; relationship and marketplace sections are plain headings.
 */
export type CodexPluginDirectorySectionKind =
  | "created"
  | "shared"
  /** Moss's own presets, shipped with Moss: image and video generation, Plugin Creator, … */
  | "official"
  /** Moss Apps: the hosted app catalog, in full. */
  | "apps"
  | "featured"
  | "category"
  | "marketplace";

export interface CodexPluginDirectorySection<TEntry> {
  readonly id: string;
  readonly kind: CodexPluginDirectorySectionKind;
  readonly title: string | null;
  readonly entries: TEntry[];
}

export function isBrowsablePluginDirectorySection(section: {
  readonly kind: CodexPluginDirectorySectionKind;
}): boolean {
  return (
    section.kind === "official" ||
    section.kind === "apps" ||
    section.kind === "featured" ||
    section.kind === "category"
  );
}

/** Marketplaces Moss ships itself ("moss-bundled", …); Moss Apps has its own section. */
export function isMossOfficialMarketplace(name: string | undefined): boolean {
  const normalized = (name ?? "").trim().toLowerCase();
  return normalized.startsWith("moss-") && normalized !== MOSS_APPS_MARKETPLACE_NAME;
}

/**
 * Whether a load error is a CLI's whole plugin listing failing ("codex-native":
 * timed out, signed out) rather than one marketplace file failing to load.
 */
export function isProviderPluginListingLoadError(
  error: Pick<ProviderPluginMarketplaceLoadError, "marketplacePath">,
): boolean {
  const path = error.marketplacePath;
  return (
    path.endsWith(PROVIDER_PLUGIN_LISTING_LOAD_ERROR_SUFFIX) &&
    isSupportedProviderKind(path.slice(0, -PROVIDER_PLUGIN_LISTING_LOAD_ERROR_SUFFIX.length))
  );
}

export interface ManageTabCount {
  readonly id: string;
  readonly count: number;
}

function lowerTrimmed(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

/** Codex's own bundles: always installed, never listed among the user's plugins. */
const CODEX_SHIPPED_PLUGIN_MARKETPLACES = new Set(["openai-bundled", "openai-primary-runtime"]);

/**
 * Codex's installed lists (the Customize rail, Settings › Plugins) leave out
 * what Codex ships and manages itself: its bundled marketplaces' plugins and
 * remote plugins installed by default for every account.
 */
export function isCodexManagedPlugin(entry: {
  readonly marketplaceName?: string | undefined;
  readonly plugin: Pick<ProviderPluginDescriptor, "installPolicy" | "source">;
}): boolean {
  return (
    CODEX_SHIPPED_PLUGIN_MARKETPLACES.has(entry.marketplaceName ?? "") ||
    (entry.plugin.source.type === "remote" && entry.plugin.installPolicy === "INSTALLED_BY_DEFAULT")
  );
}

export function isPluginInstalledForDirectory(
  plugin: Pick<ProviderPluginDescriptor, "enabled" | "installPolicy" | "installed">,
): boolean {
  return plugin.installed || plugin.enabled || plugin.installPolicy === "INSTALLED_BY_DEFAULT";
}

export function canInstallPluginToHarness(
  plugin: Pick<ProviderPluginDescriptor, "enabled" | "installPolicy" | "installed">,
): boolean {
  return !isPluginInstalledForDirectory(plugin) && plugin.installPolicy === "AVAILABLE";
}

export interface PluginPrimaryAction {
  readonly action: "try" | "enable" | "install";
  readonly disabled: boolean;
}

/**
 * Resolves the directory/detail primary action from installation state and the
 * mutation capabilities owned by the caller. In particular, an installed but
 * disabled plugin is an Enable action; it must not fall through to Install or
 * inherit Install's disabled state.
 */
export function resolvePluginPrimaryAction(
  plugin: Pick<ProviderPluginDescriptor, "enabled" | "installPolicy" | "installed">,
  input: {
    readonly canTryInChat: boolean;
    readonly canInstall: boolean;
    readonly canEnable: boolean;
    readonly pending?: boolean;
  },
): PluginPrimaryAction {
  const pending = input.pending ?? false;
  if (!isPluginInstalledForDirectory(plugin)) {
    return { action: "install", disabled: pending || !input.canInstall };
  }
  if (!plugin.enabled) {
    return { action: "enable", disabled: pending || !input.canEnable };
  }
  return { action: "try", disabled: pending || !input.canTryInChat };
}

/**
 * Codex treats plugin/list order as presentation data. Keep that provider order
 * for the installed icon rail instead of alphabetizing it in the renderer.
 */
export function installedPluginDirectoryEntries<TEntry extends CodexPluginDirectoryEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  return entries.filter((entry) => isPluginInstalledForDirectory(entry.plugin));
}

/**
 * Codex features plugins by their remote catalog id ("teams@openai-curated-remote")
 * while the local catalog lists the same plugin as "teams@openai-curated".
 */
function featuredPluginKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/-remote$/, "");
}

function selectFeaturedPlugins<TEntry extends CodexPluginDirectoryEntry>(
  entries: readonly TEntry[],
  featuredPluginIds: readonly string[],
): TEntry[] {
  const byId = new Map<string, TEntry>();
  for (const entry of entries) {
    byId.set(entry.plugin.id, entry);
    const key = featuredPluginKey(entry.plugin.id);
    if (!byId.has(key)) byId.set(key, entry);
  }
  const selected: TEntry[] = [];
  const seen = new Set<string>();

  const orderedFeaturedIds =
    featuredPluginIds.length > 0 ? featuredPluginIds : DEFAULT_FEATURED_PLUGIN_IDS;
  for (const id of uniqueValues(orderedFeaturedIds)) {
    const entry = byId.get(id) ?? byId.get(featuredPluginKey(id));
    if (!entry || seen.has(entry.plugin.id)) continue;
    selected.push(entry);
    seen.add(entry.plugin.id);
  }

  for (const entry of entries) {
    if (!entry.isFeatured || seen.has(entry.plugin.id)) continue;
    selected.push(entry);
    seen.add(entry.plugin.id);
  }

  return selected;
}

function groupEntries<TEntry>(
  entries: readonly TEntry[],
  keyOf: (entry: TEntry) => string,
): Map<string, TEntry[]> {
  const groups = new Map<string, TEntry[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

function sectionSlug(value: string): string {
  return lowerTrimmed(value).replaceAll(/\s+/g, "-");
}

/**
 * Codex directory sections. Public and Workspace read as a store — Popular,
 * then one section per category, each opening its own page — while Personal
 * lists what the user made or added: Created by you, Shared with you, then one
 * section per marketplace the user added.
 */
export function sectionCodexPluginDirectory<TEntry extends CodexPluginDirectoryEntry>(input: {
  readonly entries: readonly TEntry[];
  readonly featuredPluginIds?: readonly string[];
  readonly categoryOrder?: readonly string[];
  readonly layout?: "categories" | "marketplaces";
}): CodexPluginDirectorySection<TEntry>[] {
  const createdByYou = input.entries.filter((entry) => entry.createdByYou);
  const sharedWithYou = input.entries.filter((entry) => entry.sharedWithYou);
  const relationshipSections: CodexPluginDirectorySection<TEntry>[] = [
    ...(createdByYou.length > 0
      ? [
          {
            id: "plugins-created-by-you",
            kind: "created" as const,
            title: "Created by you",
            entries: createdByYou,
          },
        ]
      : []),
    ...(sharedWithYou.length > 0
      ? [
          {
            id: "plugins-shared-with-you",
            kind: "shared" as const,
            title: "Shared with you",
            entries: sharedWithYou,
          },
        ]
      : []),
  ];

  if (input.layout === "marketplaces") {
    const local = input.entries.filter((entry) => !entry.createdByYou && !entry.sharedWithYou);
    const byMarketplace = groupEntries(local, (entry) => entry.marketplaceName ?? "");
    const marketplaceSections = [...byMarketplace.entries()].map(([name, entries]) => ({
      id: `plugins-marketplace-${sectionSlug(name || "other")}`,
      kind: "marketplace" as const,
      title: entries[0]?.marketplaceDisplayName ?? name,
      entries,
    }));
    return [...relationshipSections, ...marketplaceSections];
  }

  // Moss's own presets, then its full app catalog, lead the directory; the
  // CLI's catalog follows in its own sections.
  const official = input.entries.filter((entry) =>
    isMossOfficialMarketplace(entry.marketplaceName),
  );
  const apps = input.entries.filter(
    (entry) => entry.marketplaceName === MOSS_APPS_MARKETPLACE_NAME,
  );
  const catalog = input.entries.filter(
    (entry) =>
      !isMossOfficialMarketplace(entry.marketplaceName) &&
      entry.marketplaceName !== MOSS_APPS_MARKETPLACE_NAME,
  );
  const mossSections: CodexPluginDirectorySection<TEntry>[] = [
    ...(official.length > 0
      ? [
          {
            id: "plugins-moss-official",
            kind: "official" as const,
            title: "Moss",
            entries: official,
          },
        ]
      : []),
    ...(apps.length > 0
      ? [{ id: "plugins-moss-apps", kind: "apps" as const, title: "Moss Apps", entries: apps }]
      : []),
  ];
  const featured = selectFeaturedPlugins(catalog, input.featuredPluginIds ?? []);
  const byCategory = groupEntries(catalog, (entry) => entry.plugin.interface?.category ?? "Other");

  const categoryOrder = input.categoryOrder ?? [...byCategory.keys()];
  const categoryRank = new Map(
    categoryOrder.map((category, index) => [lowerTrimmed(category), index]),
  );
  const categorySections = [...byCategory.entries()]
    .toSorted(([leftCategory], [rightCategory]) => {
      const leftRank = categoryRank.get(lowerTrimmed(leftCategory)) ?? categoryOrder.length;
      const rightRank = categoryRank.get(lowerTrimmed(rightCategory)) ?? categoryOrder.length;
      return leftRank === rightRank
        ? leftCategory.localeCompare(rightCategory)
        : leftRank - rightRank;
    })
    .map(([category, entries]) => ({
      id: `plugins-${sectionSlug(category)}`,
      kind: "category" as const,
      title: category,
      entries,
    }));

  return [
    ...relationshipSections,
    ...mossSections,
    ...(featured.length > 0
      ? [
          {
            id: "plugins-featured",
            kind: "featured" as const,
            title: "Featured",
            entries: featured,
          },
        ]
      : []),
    ...categorySections,
  ];
}

/**
 * Narrows the directory to one category page without rebuilding or reordering
 * sections. A null selection is the directory overview.
 */
export function filterPluginDirectorySections<TSection extends { readonly id: string }>(
  sections: ReadonlyArray<TSection>,
  selectedSectionId: string | null,
): TSection[] {
  if (selectedSectionId === null) return [...sections];
  return sections.filter((section) => section.id === selectedSectionId);
}

/** Current Codex Manage always exposes MCPs, even at zero; other tabs are useful
 * only when they have rows. The generic keeps the caller's tab metadata intact. */
export function filterVisibleManageTabs<TTab extends ManageTabCount>(
  tabs: readonly TTab[],
): TTab[] {
  return tabs.filter((tab) => tab.id === "mcps" || tab.count > 0);
}

export function pluginBucket(input: {
  readonly marketplaceName: string;
  readonly marketplacePath: string | null;
}): LibraryBucket {
  // Local lanes split the way Codex's tabs do: vendor marketplaces are Public
  // (Moss's `moss` bucket); a marketplace the user added — a folder, a Git
  // repo, their own `personal` catalog — is Personal. Workspace comes only from
  // the workspace-directory lane, never from a marketplace's name.
  return isBuiltInPluginMarketplace(input.marketplaceName) ? "moss" : "personal";
}

/**
 * Codex lists a plugin's skills on that plugin's page, never among installed
 * skills: a namespaced name ("plugin:skill") or a path inside a materialized
 * plugin tree marks a skill as bundled.
 */
export function isPluginBundledSkill(
  skill: Pick<ProviderSkillDescriptor, "name" | "path">,
): boolean {
  if (skill.name.includes(":")) return true;
  const normalized = skill.path.replaceAll("\\", "/");
  return /\/plugins\/cache\/|\/\.tmp\/(?:plugins\/plugins|bundled-marketplaces)\/|\/codex-runtimes\/[^/]+\/plugins\//i.test(
    normalized,
  );
}

/** Codex's skill scope tabs: System holds system/admin skills, Personal the rest. */
export function skillScopeGroup(
  skill: Pick<ProviderSkillDescriptor, "scope">,
): "personal" | "system" {
  const scope = (skill.scope ?? "").trim().toLowerCase();
  return scope === "system" || scope === "admin" ? "system" : "personal";
}

export function skillBucket(skill: ProviderSkillDescriptor): LibraryBucket {
  const scope = (skill.scope ?? "").toLowerCase();
  if (scope === "moss") return "moss";
  if (scope === "project" || scope === "repo" || scope === "workspace") return "workspace";
  return "personal";
}

export function mcpSource(server: ProviderMcpServerDescriptor): LibrarySource {
  return { key: `mcp:${server.origin}`, label: originLabel(server.origin) };
}

// Plugins carry a marketplace, not an engine origin. A local `~/.agents/plugins`
// marketplace is "Personal"; anything else is labeled by its marketplace name.
export function pluginSource(input: {
  readonly marketplaceName: string;
  readonly marketplacePath: string | null;
}): LibrarySource {
  if (input.marketplacePath?.includes("/.agents/plugins/")) {
    return { key: "plugin:personal", label: "Personal" };
  }
  const name = input.marketplaceName.trim();
  return {
    key: `plugin:${input.marketplacePath ?? `remote:${name}`}`,
    label: name.length > 0 ? name : "Marketplace",
  };
}

// Collects the distinct sources present in a list, preserving first-seen order so
// the chip row is stable across renders. Deduped by key.
export function collectSources(sources: ReadonlyArray<LibrarySource>): LibrarySource[] {
  const seen = new Map<string, LibrarySource>();
  for (const source of sources) {
    if (!seen.has(source.key)) seen.set(source.key, source);
  }
  return [...seen.values()];
}

/**
 * True when a resource is Moss-canonical (lives under `.moss/`) and can therefore
 * be uninstalled by deleting the canonical artifact. Provider-native copies are
 * never deleted from here — the UI disables them instead.
 */
export function isMossCanonicalSkill(skill: ProviderSkillDescriptor): boolean {
  return skill.scope === "moss" || skill.path.includes("/.moss/skills/");
}
export function isMossCanonicalMcp(server: ProviderMcpServerDescriptor): boolean {
  return server.origin === "moss";
}
export function isMossCanonicalPluginPath(sourcePath: string): boolean {
  const normalized = sourcePath.replaceAll("\\", "/");
  return /(^|\/)\.moss\/plugins\/[^/]+(?:\/|$)/.test(normalized);
}

export function mossCanonicalPluginManifestPath(
  plugin: Pick<ProviderPluginDescriptor, "source">,
): string | null {
  return plugin.source.type === "local" && isMossCanonicalPluginPath(plugin.source.path)
    ? plugin.source.path
    : null;
}

export function pluginMutationOwner(
  plugin: Pick<ProviderPluginDescriptor, "enabled" | "installPolicy" | "installed" | "source">,
): "moss" | "native" | null {
  if (mossCanonicalPluginManifestPath(plugin)) return "moss";
  return isPluginInstalledForDirectory(plugin) ? "native" : null;
}

export function mcpTransportLabel(transport: ProviderMcpServerDescriptor["transport"]): string {
  switch (transport) {
    case "stdio":
      return "stdio";
    case "http":
      return "HTTP";
    case "sse":
      return "SSE";
    default:
      return "MCP";
  }
}
