// FILE: PluginLibrary.tsx
// Purpose: Codex-parity Plugins / MCP / Skills browser surfaced from the provider
//          discovery + Moss unified-source APIs. Owns the three tabs, the source
//          filter chips, the Installed strip + Manage gear, the card grids, the
//          resource detail modal, and the "+" create menu (canonical Moss write).
// Layer: Route-level screen
// Exports: PluginLibrary

import {
  PROVIDER_DISPLAY_NAMES,
  isSupportedProviderKind,
  type ProviderAddMarketplaceInput,
  type ProviderAddMarketplaceResult,
  type MossAppConnection,
  type MossAppToolkit,
  type ProviderAppInfo,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderListAppsResult,
  type ProviderListMcpResult,
  type ProviderReadPluginResult,
  type SupportedProviderKind,
  type ProviderListPluginsResult,
  type ProviderMcpServerDescriptor,
  type ProviderPluginDescriptor,
  type ProviderPluginMarketplaceKind,
  type ProviderSkillDescriptor,
  type ServerSettings,
} from "@synara/contracts";
import {
  codexAccountInstanceId,
  inferLegacyProviderKindFromModelSelection,
} from "@synara/shared/providerInstances";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import React, {
  type ReactNode,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "~/store";
import {
  type BrandArtwork,
  KNOWN_BRAND_ARTWORK,
  normalizeBrandKey,
  readableBrandColor,
} from "~/lib/brandIcons";
import { isMossProtectedSourceInstanceId } from "~/components/chat/providerAccountSources";
import {
  MossCustomizeInstalledRowsContext,
  type MossInstalledPluginRow,
} from "~/components/MossCustomizeSecondarySidebar";
import { DEFAULT_PROVIDER_ORDER } from "~/providerOrdering";
import { useAppSettings } from "~/appSettings";
import {
  buildPluginSearchFields,
  buildSkillSearchFields,
  normalizeProviderDiscoveryText,
  providerPluginSourceLabel,
  rankProviderDiscoveryItems,
  resolveProviderDiscoveryCwd,
} from "~/lib/providerDiscovery";
import {
  LIBRARY_BUCKETS,
  type LibraryBucket,
  type LibraryTab,
  canInstallPluginToHarness,
  filterPluginDirectorySections,
  CODEX_DIRECTORY_CATEGORY_ORDER,
  installedPluginDirectoryEntries,
  isBrowsablePluginDirectorySection,
  isBuiltInPluginMarketplace,
  isCodexManagedPlugin,
  isPluginBundledSkill,
  isPluginInstalledForDirectory,
  isProviderPluginListingLoadError,
  mcpTransportLabel,
  originLabel,
  providerPluginDirectoryEntries,
  resolvePluginLibraryProviderInstanceId,
  resolvePluginPrimaryAction,
  sectionCodexPluginDirectory,
  skillBucket,
  skillScopeGroup,
  withRemotePluginDirectory,
  type CodexPluginDirectorySection,
  type ProviderPluginDirectoryEntry,
} from "~/lib/pluginLibraryModel";
import {
  pluginLibraryErrorMessage,
  resolvePluginLibraryQueryState,
} from "~/lib/pluginLibraryQueryState";
import type { PluginMarketplaceAddParams } from "~/lib/pluginMarketplaceModel";
import {
  isMarketplaceAddSettled,
  isPluginEnabledSettled,
  isPluginInstallSettled,
  isPluginUninstallSettled,
  readPrimaryPluginCatalog,
  runPluginMutationWithAuthoritativeRead,
  type PluginCatalogSnapshot,
} from "~/lib/pluginMutationSettlement";
import { MCP_FALLBACK_ICON, resolveResourceIcon, SKILL_FALLBACK_ICON } from "~/lib/resourceIcon";
import { resolvePluginArtworkUrl } from "~/lib/localImageUrls";
import { localizeAntigravityRuntimeMessage } from "~/lib/antigravityRuntimeMessages";
import { createFirstProjectSelector } from "~/storeSelectors";
import {
  providerComposerCapabilitiesQueryOptions,
  providerDiscoveryQueryKeys,
  providerSkillsQueryOptions,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";
import {
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { settingsSkillNameKey } from "./settings/skillsSettingsModel";
import { ensureNativeApi } from "~/nativeApi";
import { useFocusedChatContext } from "~/focusedChatContext";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CirclePersonIcon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  MessageCircleIcon,
  PluginIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { RouteInsetSurface } from "./RouteInsetSurface";
import { SettingsPageFrame } from "./settings/SettingsPageFrame";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";
import { Button } from "./ui/button";
import {
  Menu as DropdownMenu,
  MenuItem as DropdownMenuItem,
  MenuTrigger as DropdownMenuTrigger,
} from "./ui/menu";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Badge } from "./ui/badge";
import {
  PluginResourceDetailDialog,
  PluginResourceDetailPage,
  type ResourceDetail,
} from "./PluginResourceDetailDialog";
import {
  PluginManagementPanel,
  type ManagedMarketplace,
  type ManagedPlugin,
} from "./PluginManagementPanel";
import { PluginMarketplaceDialog } from "./PluginMarketplaceDialog";
import { AppToolsDialog } from "./AppToolsDialog";
import {
  AppConnectDialog,
  type AppConnectionOpened,
  type AppConnectTarget,
} from "./AppConnectDialog";
import { PluginRequiredAppsDialog } from "./PluginRequiredAppsDialog";
import {
  enrichRequiredPluginApps,
  reconcileRequiredPluginApps,
  retainedPluginAuthSessionId,
  resolvePluginAuthOnboarding,
  type PluginRequiredApp,
} from "./pluginAuthOnboarding";
import {
  PluginLibraryAddMenu,
  PluginLibraryCardIconBox,
  PluginLibraryExpandRow,
  PluginLibraryHeader,
  PluginLibraryHeaderActions,
  PluginLibraryPageHeader,
  PluginLibraryPillTabs,
  PluginLibraryRow,
  PluginLibrarySearchInput,
  PluginLibrarySectionHeader,
  PluginLibraryTwoColumnGrid,
  type PluginLibraryBrowseTab,
} from "./PluginLibraryPrimitives";
import { MossDetectedResourcesSection } from "./MossDetectedResourcesSection";
import { MossAppConnectDialog, type MossAppConnectTarget } from "./MossAppConnectDialog";
import {
  MOSS_APP_CONNECTIONS_QUERY_KEY,
  mossAppCatalogQueryOptions,
  mossAppConnectionsQueryOptions,
  mossAppsStatusQueryOptions,
} from "~/lib/mossAppsReactQuery";
import {
  activeMossAppConnection,
  isMossAppPlugin,
  mossAppDirectoryEntries,
  mossAppPluginDetail,
  mossAppPluginId,
  mossAppSlugFromPluginId,
} from "~/lib/mossAppsPlugins";
import { PluginLibraryImportDialog } from "./PluginLibraryImportDialog";
import {
  resolvePluginDetailRouteViewState,
  resolvePluginLibraryRoute,
} from "~/lib/pluginLibraryRouteModel";
import {
  PLUGIN_LIBRARY_SETTINGS_PATH,
  readPluginLibraryEntrySnapshot,
  readPluginLibraryFocusAnchor,
  readPluginLibraryManageSnapshot,
  shouldReturnToPreviousPluginLibraryHistoryEntry,
  type PluginLibraryEntrySnapshot,
  type PluginLibraryFocusAnchor,
  type PluginLibraryManageSnapshot,
} from "~/lib/pluginLibraryHistoryState";
import {
  canUninstallResource,
  canInstallPluginResource,
  canToggleMcpResource,
  canTogglePluginResource,
  CREATOR_META,
  type CreatorKind,
  usePluginResourceActions,
} from "~/lib/usePluginResourceActions";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { toastManager } from "./ui/toast";
import { useTranslation, type TranslationKey } from "~/localization";
import {
  createSingleFlightPluginExternalOpener,
  openPluginExternalUrl,
} from "~/lib/pluginExternalLink";
import { usePluginAuthCallbackRecovery } from "./usePluginAuthCallbackRecovery";
import "./PluginLibrary.css";

// ---------------------------------------------------------------------------
// Plugin discovery query options. These Moss-era discovery reads (apps, MCP,
// per-marketplace-kind plugin lists, plugin detail) lived in
// ~/lib/providerDiscoveryReactQuery before the upstream merge; upstream
// trimmed that module, so the Plugin Library keeps its own copies. The RPC
// contracts are unchanged (see packages/contracts providerDiscovery).
// ---------------------------------------------------------------------------

const PLUGIN_LIBRARY_EMPTY_PLUGINS_RESULT: ProviderListPluginsResult = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  remoteSyncError: null,
  featuredPluginIds: [],
  source: "empty",
  cached: false,
};

const PLUGIN_LIBRARY_EMPTY_MCP_RESULT: ProviderListMcpResult = {
  servers: [],
  source: "empty",
  cached: false,
};

const pluginLibraryDiscoveryQueryKeys = {
  pluginsForProvider: (provider: ProviderKind) =>
    ["provider-discovery", "plugins", provider] as const,
  plugins: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    cwd: string | null,
    threadId: string | null,
    marketplaceKinds: readonly ProviderPluginMarketplaceKind[] | null,
    forceRemoteSync: boolean,
    forceReload: boolean,
  ) =>
    [
      ...pluginLibraryDiscoveryQueryKeys.pluginsForProvider(provider),
      instanceId,
      cwd,
      threadId,
      marketplaceKinds,
      forceRemoteSync,
      forceReload,
    ] as const,
  appsForProvider: (provider: ProviderKind) => ["provider-discovery", "apps", provider] as const,
  apps: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    cwd: string | null,
    threadId: string | null,
  ) =>
    [
      ...pluginLibraryDiscoveryQueryKeys.appsForProvider(provider),
      instanceId,
      cwd,
      threadId,
    ] as const,
  mcp: (provider: ProviderKind, cwd: string | null) =>
    ["provider-discovery", "mcp", provider, cwd] as const,
  plugin: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    marketplacePath: string | null,
    remoteMarketplaceName: string | null,
    pluginName: string,
    cwd: string | null,
    threadId: string | null,
  ) =>
    [
      "provider-discovery",
      "plugin",
      provider,
      instanceId,
      marketplacePath,
      remoteMarketplaceName,
      pluginName,
      cwd,
      threadId,
    ] as const,
};

function requireSupportedProvider(provider: ProviderKind): SupportedProviderKind {
  if (!isSupportedProviderKind(provider)) {
    throw new Error(`Provider ${provider} is no longer supported.`);
  }
  return provider;
}

async function loadAllProviderApps(
  loadPage: (cursor: string | null) => Promise<ProviderListAppsResult>,
): Promise<readonly ProviderAppInfo[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const apps: ProviderAppInfo[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const result = await loadPage(cursor);
        apps.push(...result.data);
        cursor = result.nextCursor;
        if (cursor !== null) {
          if (visitedCursors.has(cursor)) {
            throw new Error("app/list returned a repeated cursor.");
          }
          visitedCursors.add(cursor);
        }
      } while (cursor !== null);
      return apps;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("app/list failed.");
}

function providerPluginsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  cwd: string | null;
  threadId?: string | null;
  /** Omitted, Codex returns its default listing (the whole remote directory). */
  marketplaceKinds?: readonly ProviderPluginMarketplaceKind[];
  forceRemoteSync?: boolean;
  forceReload?: boolean;
  enabled?: boolean;
  staleTime?: number;
}) {
  const marketplaceKinds = input.marketplaceKinds ?? null;
  const forceRemoteSync = input.forceRemoteSync === true;
  const forceReload = input.forceReload === true;
  return queryOptions({
    queryKey: pluginLibraryDiscoveryQueryKeys.plugins(
      input.provider,
      input.instanceId ?? null,
      input.cwd,
      input.threadId ?? null,
      marketplaceKinds,
      forceRemoteSync,
      forceReload,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listPlugins({
        provider: requireSupportedProvider(input.provider),
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(marketplaceKinds ? { marketplaceKinds: [...marketplaceKinds] } : {}),
        ...(forceRemoteSync ? { forceRemoteSync: true } : {}),
        ...(forceReload ? { forceReload: true } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: input.staleTime ?? 30_000,
    placeholderData: (previous) => previous ?? PLUGIN_LIBRARY_EMPTY_PLUGINS_RESULT,
  });
}

function providerAppsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  cwd: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: pluginLibraryDiscoveryQueryKeys.apps(
      input.provider,
      input.instanceId ?? null,
      input.cwd,
      input.threadId ?? null,
    ),
    queryFn: async (): Promise<readonly ProviderAppInfo[]> => {
      const api = ensureNativeApi();
      return loadAllProviderApps((cursor) =>
        api.provider.listApps({
          provider: requireSupportedProvider(input.provider),
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          cursor,
          limit: 1_000,
          forceRefetch: false,
        }),
      );
    },
    enabled: input.enabled ?? true,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

function providerMcpQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: pluginLibraryDiscoveryQueryKeys.mcp(input.provider, input.cwd),
    queryFn: async (): Promise<ProviderListMcpResult> => {
      const api = ensureNativeApi();
      return api.provider.listMcp({
        provider: requireSupportedProvider(input.provider),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? PLUGIN_LIBRARY_EMPTY_MCP_RESULT,
  });
}

function providerReadPluginQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  marketplacePath?: string | null;
  remoteMarketplaceName?: string | null;
  pluginName: string;
  cwd?: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  const marketplacePath = input.marketplacePath?.trim() || null;
  const remoteMarketplaceName = input.remoteMarketplaceName?.trim() || null;
  const hasExactlyOneSelector =
    Number(marketplacePath !== null) + Number(remoteMarketplaceName !== null) === 1;
  return queryOptions({
    queryKey: pluginLibraryDiscoveryQueryKeys.plugin(
      input.provider,
      input.instanceId ?? null,
      marketplacePath,
      remoteMarketplaceName,
      input.pluginName,
      input.cwd ?? null,
      input.threadId ?? null,
    ),
    queryFn: async (): Promise<ProviderReadPluginResult> => {
      if (!hasExactlyOneSelector) {
        throw new Error("Exactly one plugin marketplace selector is required.");
      }
      const api = ensureNativeApi();
      return api.provider.readPlugin({
        provider: requireSupportedProvider(input.provider),
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(marketplacePath ? { marketplacePath } : {}),
        ...(remoteMarketplaceName ? { remoteMarketplaceName } : {}),
        pluginName: input.pluginName,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
    },
    enabled: (input.enabled ?? true) && hasExactlyOneSelector,
    staleTime: 60_000,
  });
}

// ── Types ──────────────────────────────────────────────────────────────────

type ProviderCapabilities = { plugins: boolean; skills: boolean };

const MOSS_LOCAL_PLUGIN_REMOTE_AUTH_WARNING =
  "OpenAI remote plugins require a personal ChatGPT session. Moss built-in plugins remain available.";
type PluginEntry = ProviderPluginDirectoryEntry;
type PluginAuthSetup = {
  readonly sessionId: number;
  readonly resource: Extract<ResourceDetail, { kind: "plugin" }>;
  readonly apps: readonly PluginRequiredApp[];
  readonly mode: "single" | "multiple";
};

let pluginAuthSessionSequence = 0;

function createPluginAuthSetup(input: Omit<PluginAuthSetup, "sessionId">): PluginAuthSetup {
  pluginAuthSessionSequence += 1;
  return { ...input, sessionId: pluginAuthSessionSequence };
}

export function usePluginAppConnectionFailureToast(): (cause: unknown) => void {
  const { t } = useTranslation();
  return useCallback(
    (cause: unknown) => {
      toastManager.add({
        type: "error",
        title: t("plugins.installModal.appConnectionCompleteFailed"),
        description: cause instanceof Error ? cause.message : String(cause),
      });
    },
    [t],
  );
}

// ── Constants ──────────────────────────────────────────────────────────────

// Codex skills browse groups every skill into one of two scope tabs: Personal
// (user-owned skills) and System (everything provided by an engine, repo, or
// admin). See Helios shot 14.
type SkillScopeGroup = ReturnType<typeof skillScopeGroup>;

// The primary lane is Codex's local catalog: the curated, bundled and runtime
// marketplaces plus every marketplace the user added (~80ms). Codex's default
// listing instead pulls the whole remote directory (~9.5k plugins, 6s cached,
// ~54s refetched), and "local" + "vertical" narrows to the curated vertical.
const NO_MOSS_APP_TOOLKITS: readonly MossAppToolkit[] = [];
const NO_MOSS_APP_CONNECTIONS: readonly MossAppConnection[] = [];

const PRIMARY_PLUGIN_MARKETPLACE_KINDS = [
  "local",
] as const satisfies readonly ProviderPluginMarketplaceKind[];
const WORKSPACE_PLUGIN_MARKETPLACE_KINDS = [
  "workspace-directory",
] as const satisfies readonly ProviderPluginMarketplaceKind[];
const SHARED_PLUGIN_MARKETPLACE_KINDS = [
  "shared-with-me",
] as const satisfies readonly ProviderPluginMarketplaceKind[];
const CREATED_PLUGIN_MARKETPLACE_KINDS = [
  "created-by-me-remote",
] as const satisfies readonly ProviderPluginMarketplaceKind[];
/** Codex keeps its directory for six hours; mutations re-read it sooner. */
const PLUGIN_DIRECTORY_STALE_TIME_MS = 6 * 60 * 60_000;

function readPluginLibraryDomFocusAnchor(trigger?: HTMLElement): PluginLibraryFocusAnchor | null {
  const element =
    trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focusKey = element?.dataset.pluginLibraryFocusKey;
  if (focusKey) return { kind: "key", value: focusKey };
  return element?.id ? { kind: "id", value: element.id } : null;
}

function restorePluginLibraryFocusAnchor(anchor: PluginLibraryFocusAnchor): boolean {
  const target =
    anchor.kind === "id"
      ? document.getElementById(anchor.value)
      : [...document.querySelectorAll<HTMLElement>("[data-plugin-library-focus-key]")].find(
          (candidate) => candidate.dataset.pluginLibraryFocusKey === anchor.value,
        );
  if (!(target instanceof HTMLElement)) return false;
  target.focus();
  return true;
}

function pluginLibraryFocusAnchorIdentity(anchor: PluginLibraryFocusAnchor): string {
  return `${anchor.kind}:${anchor.value}`;
}

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * The local lane and the remote directory lanes can list the same plugin; the
 * first (local, authoritative for mutations) occurrence wins so a plugin shows
 * once and lands in the tab its own marketplace belongs to.
 */
function uniquePluginEntries(entries: readonly PluginEntry[]): PluginEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.plugin.id)) return false;
    seen.add(entry.plugin.id);
    return true;
  });
}

function pluginEntryKey(
  entry: Pick<PluginEntry, "marketplacePath" | "remoteMarketplaceName" | "plugin">,
): string {
  const marketplace = entry.marketplacePath ?? `remote:${entry.remoteMarketplaceName ?? "unknown"}`;
  return `${marketplace}::${entry.plugin.name}`;
}

function pluginSearchResultId(sectionId: string, entry: PluginEntry): string {
  return `plugin-result-${encodeURIComponent(`${sectionId}::${pluginEntryKey(entry)}`)}`;
}

function mcpSearchResultId(server: ProviderMcpServerDescriptor): string {
  return `mcp-result-${encodeURIComponent(`${server.origin}::${server.name}`)}`;
}

function skillSearchResultId(skill: ProviderSkillDescriptor): string {
  return `skill-result-${encodeURIComponent(skill.path)}`;
}

function pluginResourceKey(resource: {
  readonly marketplacePath: string | null;
  readonly remoteMarketplaceName: string | null;
  readonly plugin: Pick<ProviderPluginDescriptor, "name">;
}): string {
  const marketplace =
    resource.marketplacePath ?? `remote:${resource.remoteMarketplaceName ?? "unknown"}`;
  return `${marketplace}::${resource.plugin.name}`;
}

function sectionTitle(value: string, fallback: string): string {
  const n = value.trim();
  return n.length === 0 ? fallback : n;
}

function managedMarketplaces(result: ProviderListPluginsResult | undefined): ManagedMarketplace[] {
  return (result?.marketplaces ?? []).map((marketplace) => ({
    key: `${marketplace.name}:${marketplace.path ?? "remote"}`,
    name: marketplace.name,
    displayName: marketplace.interface?.displayName ?? marketplace.name,
    path: marketplace.path,
    pluginCount: marketplace.plugins.length,
    isBuiltIn: isBuiltInPluginMarketplace(marketplace.name),
    // listPlugins does not expose configuration or source provenance. Keep
    // destructive/upgrade actions closed until the native contract does.
    isConfigured: false,
    isGit: false,
  }));
}

function resolvePluginAccent(plugin: ProviderPluginDescriptor): string | undefined {
  return plugin.interface?.brandColor?.trim() || undefined;
}

function resolvePluginLogo(plugin: ProviderPluginDescriptor): string | undefined {
  return (
    plugin.interface?.logoUrl?.trim() ||
    plugin.interface?.logo?.trim() ||
    plugin.interface?.logoUrlDark?.trim() ||
    plugin.interface?.logoDark?.trim() ||
    undefined
  );
}

function resolvePluginBrand(plugin: ProviderPluginDescriptor): BrandArtwork | undefined {
  const candidates = [
    plugin.interface?.composerIcon,
    plugin.interface?.displayName,
    plugin.name,
  ].map(normalizeBrandKey);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const knownBrand = KNOWN_BRAND_ARTWORK[candidate];
    if (knownBrand) return knownBrand;
  }

  return undefined;
}

// ── Icon glyphs ────────────────────────────────────────────────────────────
// Codex Desktop renders every card icon inside a 40×40 bordered, transparent
// box with a muted glyph (see the restored `InstalledSkillCard`). Plugins keep
// their own brand logo/color when the marketplace provides one.

/** The Codex card icon box: `h-10 w-10 rounded-lg border bg-transparent`. */
function PluginGlyph({
  plugin,
  installed = false,
  artworkCwd,
}: {
  plugin: ProviderPluginDescriptor;
  installed?: boolean;
  artworkCwd?: string | undefined;
}) {
  const accent = resolvePluginAccent(plugin);
  const rawLogo = resolvePluginLogo(plugin);
  const logo = rawLogo ? resolvePluginArtworkUrl({ src: rawLogo, cwd: artworkCwd }) : undefined;
  const brand = resolvePluginBrand(plugin);
  const [logoFailed, setLogoFailed] = useState(false);

  const wrapArtwork = (artwork: ReactNode) =>
    installed ? (
      <span
        className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border-[0.5px] border-border bg-background shadow-lg"
        style={accent ? { boxShadow: `0 0 0 0.5px ${accent}25` } : undefined}
      >
        {artwork}
      </span>
    ) : (
      <PluginLibraryCardIconBox
        style={accent ? { boxShadow: `0 0 0 0.5px ${accent}25` } : undefined}
      >
        {artwork}
      </PluginLibraryCardIconBox>
    );

  if (logo && !logoFailed) {
    return wrapArtwork(
      <img
        src={logo}
        alt=""
        className="size-full rounded-[2px] object-contain"
        loading="lazy"
        onError={() => setLogoFailed(true)}
      />,
    );
  }

  if (brand) {
    const BrandIcon = brand.icon;
    return wrapArtwork(
      <BrandIcon
        aria-hidden="true"
        className="size-5"
        style={{ color: readableBrandColor(brand.color) ?? "var(--foreground)" }}
      />,
    );
  }

  // No marketplace artwork: fall back to Codex's keyword-matched glyph.
  const Icon = resolveResourceIcon(
    plugin.interface?.displayName ?? plugin.name,
    plugin.interface?.shortDescription ?? plugin.interface?.longDescription,
    PluginIcon,
  );
  return wrapArtwork(<Icon aria-hidden="true" className="size-5 text-muted-foreground" />);
}

function SkillGlyph({
  skill,
  artworkCwd,
}: {
  skill: ProviderSkillDescriptor;
  artworkCwd?: string | undefined;
}) {
  // Codex shows a skill's own icon (a file in its folder, or a URL) when it has one.
  const icon = skill.interface?.iconSmallUrl ?? skill.interface?.iconSmall;
  const [iconFailed, setIconFailed] = useState(false);
  if (icon && !iconFailed) {
    return (
      <PluginLibraryCardIconBox>
        <img
          src={resolvePluginArtworkUrl({ src: icon, cwd: artworkCwd })}
          alt=""
          className="size-full rounded-[2px] object-contain"
          loading="lazy"
          onError={() => setIconFailed(true)}
        />
      </PluginLibraryCardIconBox>
    );
  }
  const Icon = resolveResourceIcon(
    skill.interface?.displayName ?? skill.name,
    skill.interface?.shortDescription ?? skill.description,
    SKILL_FALLBACK_ICON,
  );
  return (
    <PluginLibraryCardIconBox>
      <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
    </PluginLibraryCardIconBox>
  );
}

function McpGlyph({ server }: { server: ProviderMcpServerDescriptor }) {
  const Icon = resolveResourceIcon(server.name, server.command ?? server.url, MCP_FALLBACK_ICON);
  return (
    <PluginLibraryCardIconBox>
      <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
    </PluginLibraryCardIconBox>
  );
}

// ── UI controls ────────────────────────────────────────────────────────────

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/60 bg-background/40 px-5 py-6 text-center">
      <div className="max-w-sm space-y-1">
        <p className="text-ui-lg font-medium text-foreground">{title}</p>
        <p className="text-ui-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function PluginBrowseEmptyState() {
  const { t } = useTranslation();

  return (
    <div role="status" aria-live="polite" className="text-base text-token-text-secondary">
      {t("skills.appsPage.empty.plugins")}
    </div>
  );
}

function QueryErrorPanel({
  title,
  error,
  retrying,
  onRetry,
}: {
  title: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const description = pluginLibraryErrorMessage(error) ?? t("plugins.error.description");

  return (
    <div
      role="alert"
      className="flex min-h-40 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 px-5 py-6 text-center"
    >
      <div className="flex max-w-sm flex-col items-center gap-3">
        <CircleAlertIcon className="size-5 text-destructive" />
        <div className="space-y-1">
          <p className="text-ui-lg font-medium text-foreground">{title}</p>
          <p className="text-ui-sm text-muted-foreground">{description}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          aria-busy={retrying || undefined}
          onClick={onRetry}
        >
          <RefreshCwIcon className={cn("size-3.5", retrying && "animate-spin")} />
          {t("plugins.action.retry")}
        </Button>
      </div>
    </div>
  );
}

function InlineWarning({
  children,
  title,
}: {
  children: ReactNode;
  /** The underlying causes, for anyone who hovers to diagnose. */
  title?: string | undefined;
}) {
  return (
    <div
      title={title}
      className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/6 px-3 py-2.5 text-ui-sm text-muted-foreground"
    >
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}

function InstalledStatus({ installed }: { installed: boolean }) {
  if (!installed) return null;
  return (
    <span className="inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground/70">
      <CheckIcon className="size-4" />
    </span>
  );
}

// ── Grid items ─────────────────────────────────────────────────────────────
// Faithful Codex Desktop card: a bordered 112px-min card in a
// `grid gap-2 md:grid-cols-2 xl:grid-cols-3`, with an icon box + title + 2-line
// description up top and a meta/action row pinned to the bottom.

/** Codex card grid — `grid gap-2 md:grid-cols-2 xl:grid-cols-3`. */
function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function ResourceCard({
  glyph,
  title,
  description,
  badge,
  meta,
  action,
  overflow,
  onOpen,
  domId,
  active = false,
}: {
  glyph: ReactNode;
  title: string;
  description: string;
  badge?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  overflow?: ReactNode;
  onOpen: () => void;
  domId?: string;
  active?: boolean;
}) {
  return (
    <article
      id={domId}
      data-search-result-active={active || undefined}
      className={cn(
        "group flex min-h-[112px] flex-col justify-between rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-foreground/25 focus-within:border-foreground/25 plugin-library-motion",
        active && "border-foreground/25 ring-1 ring-foreground/20",
      )}
    >
      <button
        type="button"
        aria-label={title}
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {glyph}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-ui-lg font-medium text-foreground">{title}</span>
            {badge}
          </div>
          <p
            className="mt-1 line-clamp-2 text-ui-lg text-muted-foreground"
            data-translation-skip="true"
          >
            {description}
          </p>
        </div>
      </button>
      <div className="mt-3 flex min-w-0 items-center justify-between gap-2 text-ui-lg text-muted-foreground">
        <span className="min-w-0 truncate">{meta}</span>
        <div className="flex shrink-0 items-center gap-1">
          {overflow}
          {action}
        </div>
      </div>
    </article>
  );
}

/** Menu item shown in the hover-revealed card overflow, matching Codex. */
interface CardMenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
}

/**
 * Codex-style card overflow: a "..." trigger hidden until the card is hovered or
 * focused (`invisible opacity-0 group-hover:visible group-hover:opacity-100`).
 * Clicks stop propagation so they never trigger the card's open-detail handler.
 */
function CardOverflowMenu({ items }: { items: ReadonlyArray<CardMenuItem> }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={t("plugins.action.moreActions")}>
              <EllipsisIcon className="size-4" />
            </Button>
          }
        />
        <ComposerPickerMenuPopup align="end" className="w-44 min-w-44">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.key}
              onClick={item.onSelect}
              className={cn(item.danger && "text-destructive focus:text-destructive")}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ))}
        </ComposerPickerMenuPopup>
      </DropdownMenu>
    </div>
  );
}

/** Codex section: `flex flex-col gap-4` with a muted `opacity-75` header. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="pr-0.5 pl-2 text-ui-lg font-medium text-foreground opacity-75">{title}</div>
      {children}
    </section>
  );
}

/** Source badge shown next to a card title (scope/origin/marketplace). */
function SourceBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="shrink-0 text-ui-2xs font-medium">
      {label}
    </Badge>
  );
}

/**
 * Faithful Codex plugin row: a BORDERLESS row (`border-none`, hover surface),
 * icon box + name + single-line description, with a "Try in chat" button and a
 * hover-revealed overflow — unlike the bordered skill cards.
 */
function PluginRowAction({
  plugin,
  onEnable,
  onInstall,
  canEnable,
  installing,
}: {
  plugin: ProviderPluginDescriptor;
  onEnable: () => void;
  onInstall: () => void;
  canEnable: boolean;
  installing: boolean;
}) {
  const { t } = useTranslation();
  const canInstall = canInstallPluginToHarness(plugin);
  const action = resolvePluginPrimaryAction(plugin, {
    canTryInChat: true,
    canInstall,
    canEnable,
    pending: installing,
  });
  const label =
    action.action === "try"
      ? t("plugins.action.tryInChat")
      : action.action === "enable"
        ? t("plugins.action.enableInCodex")
        : installing
          ? t("plugins.action.installing")
          : t("settings.providers.docs.install");

  if (action.action === "try") return null;

  // Codex directory rows use a quiet trailing "+" affordance for install /
  // enable (shot 13); installed rows expose only the hover overflow "...".
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      disabled={action.disabled}
      aria-label={label}
      title={label}
      aria-busy={installing || undefined}
      data-testid="plugin-row-install-action"
      onClick={(e) => {
        e.stopPropagation();
        if (action.action === "enable") onEnable();
        else onInstall();
      }}
    >
      <PlusIcon className="size-[18px]" />
    </Button>
  );
}

// ── Directory section labels ───────────────────────────────────────────────

type Translate = (key: TranslationKey) => string;

const PLUGIN_CATEGORY_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  productivity: "plugins.category.productivity",
  "small business": "plugins.category.smallBusiness",
  coding: "plugins.category.coding",
  research: "plugins.category.research",
  design: "plugins.category.design",
  lifestyle: "plugins.category.lifestyle",
  "developer tools": "plugins.category.developerTools",
  engineering: "plugins.category.engineering",
  "education & research": "plugins.category.educationResearch",
  communication: "plugins.category.communication",
  creativity: "plugins.category.creativity",
  healthcare: "plugins.category.healthcare",
  finance: "plugins.category.finance",
  travel: "plugins.category.travel",
  entertainment: "plugins.category.entertainment",
  "business & operations": "plugins.category.businessOperations",
  "data & analytics": "plugins.category.dataAnalytics",
  "scientific research": "plugins.category.scientificResearch",
  security: "plugins.category.security",
  other: "plugins.category.other",
};

/** Marketplace categories arrive in English; known ones read in the UI language. */
function localizePluginCategory(category: string | null, t: Translate): string {
  const key = PLUGIN_CATEGORY_LABEL_KEYS[(category ?? "other").trim().toLowerCase()];
  return key ? t(key) : (category ?? t("plugins.category.other"));
}

function pluginSectionLabel(
  section: Pick<CodexPluginDirectorySection<unknown>, "kind" | "title">,
  t: Translate,
): string {
  switch (section.kind) {
    case "created":
      return t("plugins.section.createdByYou");
    case "shared":
      return t("plugins.section.sharedWithYou");
    case "official":
      return t("plugins.section.mossOfficial");
    case "apps":
      return t("plugins.section.mossApps");
    case "featured":
      return t("plugins.category.popular");
    case "marketplace":
      return section.title ?? t("plugins.unknown");
    case "category":
      return localizePluginCategory(section.title, t);
  }
}

/** Codex's page breadcrumb ("Plugins › Productivity") in the 46px top bar. */
function PluginLibraryBreadcrumb({
  rootLabel,
  title,
  onBack,
}: {
  rootLabel: string;
  title: string;
  onBack: () => void;
}) {
  return (
    <nav aria-label={rootLabel} className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={onBack}
        className="no-drag flex h-7 items-center rounded-control px-2 text-ui-lg leading-[18px] font-[445] text-muted-foreground transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {rootLabel}
      </button>
      <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/50" />
      <span
        aria-current="page"
        className="no-drag flex h-7 min-w-0 items-center truncate px-1 text-ui-lg leading-[18px] font-[445] text-foreground"
      >
        {title}
      </span>
    </nav>
  );
}

/** Codex marks where a Personal plugin comes from with a small origin glyph. */
function PluginOriginBadge({ entry }: { entry: PluginEntry }) {
  const { format, t } = useTranslation();
  if (entry.bucket !== "personal") return null;
  const label = entry.createdByYou
    ? t("plugins.origin.createdByYou")
    : format("plugins.origin.fromMarketplace", {
        name: entry.marketplaceDisplayName ?? entry.marketplaceName,
      });
  const Icon = entry.createdByYou || entry.sharedWithYou ? CirclePersonIcon : FolderIcon;
  return (
    <span title={label} aria-label={label} role="img" className="flex shrink-0">
      <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface PluginLibraryProps {
  /** Optional shell-owned browse tab, used by the Customize destination sidebar. */
  readonly browseTab?: Extract<LibraryTab, "plugins" | "skills">;
  readonly onBrowseTabChange?: (tab: Extract<LibraryTab, "plugins" | "skills">) => void;
  /** Reports the authoritative installed rows to a shell-owned secondary rail. */
  readonly onInstalledRowsChange?: (rows: readonly MossInstalledPluginRow[]) => void;
  /** Avoid rendering a second browse-tab control when the shell owns it. */
  readonly hideBrowseTabs?: boolean;
  /** Hub/folder-scoped discovery root; defaults to the active project/server cwd. */
  readonly cwd?: string | null;
  /** Renders without page chrome when embedded in a host section (e.g. a group panel). */
  readonly embedded?: boolean;
}

export function PluginLibrary({
  browseTab,
  onBrowseTabChange,
  onInstalledRowsChange,
  hideBrowseTabs = false,
  cwd: cwdProp,
  embedded = false,
}: PluginLibraryProps = {}) {
  const { format, t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeHistoryState = useLocation({ select: (location) => location.state });
  const routeFocusAnchor = useMemo(
    () => readPluginLibraryFocusAnchor(routeHistoryState),
    [routeHistoryState],
  );
  const routeEntrySnapshot = useMemo(
    () => readPluginLibraryEntrySnapshot(routeHistoryState),
    [routeHistoryState],
  );
  const routeManageSnapshot = useMemo(
    () => readPluginLibraryManageSnapshot(routeHistoryState),
    [routeHistoryState],
  );
  const returnToPreviousHistoryEntry = useMemo(
    () => shouldReturnToPreviousPluginLibraryHistoryEntry(routeHistoryState),
    [routeHistoryState],
  );
  const routeState = resolvePluginLibraryRoute(pathname);
  const showManagement = routeState?.mode === "manage";
  const showSettingsManagement = routeState?.settings === true;
  const routePluginId = routeState?.pluginId ?? null;
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const firstProject = useStore(useMemo(() => createFirstProjectSelector(), []));
  const { activeProject: focusedProject, activeThread, focusedThreadId } = useFocusedChatContext();
  const activeProject = focusedProject ?? firstProject ?? null;

  const inferredPreferredProvider =
    (activeThread
      ? inferLegacyProviderKindFromModelSelection(activeThread.modelSelection)
      : undefined) ??
    (activeProject?.defaultModelSelection
      ? inferLegacyProviderKindFromModelSelection(activeProject.defaultModelSelection)
      : undefined) ??
    "codex";
  const preferredProvider = isSupportedProviderKind(inferredPreferredProvider)
    ? inferredPreferredProvider
    : "codex";

  const initialEntrySnapshot =
    routeEntrySnapshot?.sourcePath === pathname ? routeEntrySnapshot : null;
  const [selectedProvider, setSelectedProvider] = useState<SupportedProviderKind>(
    isSupportedProviderKind(initialEntrySnapshot?.initialHostId)
      ? initialEntrySnapshot.initialHostId
      : preferredProvider,
  );
  const [selectedTab, setSelectedTab] = useState<LibraryTab>(
    browseTab ?? initialEntrySnapshot?.initialTab ?? "plugins",
  );
  useEffect(() => {
    if (browseTab !== undefined && browseTab !== selectedTab) {
      setSelectedTab(browseTab);
    }
  }, [browseTab, selectedTab]);
  const [activeBucket, setActiveBucket] = useState<LibraryBucket>(
    initialEntrySnapshot?.activeBucket ?? "moss",
  );
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    initialEntrySnapshot?.selectedSectionId ?? null,
  );
  const [skillScope, setSkillScope] = useState<SkillScopeGroup>("personal");
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [importPluginsAndSkillsOpen, setImportPluginsAndSkillsOpen] = useState(false);
  const [importKind, setImportKind] = useState<"plugin" | "skill" | "mcp">("plugin");
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const [pluginAuthSetup, setPluginAuthSetup] = useState<PluginAuthSetup | null>(null);
  const [retainedPluginAuthSession, setRetainedPluginAuthSession] = useState<number | null>(null);
  const [connectingAuthAppId, setConnectingAuthAppId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<ResourceDetail | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const uninstallingRef = useRef(false);
  const installingPluginKeysRef = useRef(new Set<string>());
  const updatingPluginKeysRef = useRef(new Set<string>());
  const [installingPluginKeys, setInstallingPluginKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pluginSearch, setPluginSearch] = useState(initialEntrySnapshot?.search.plugins ?? "");
  const [mcpSearch, setMcpSearch] = useState(initialEntrySnapshot?.search.mcp ?? "");
  const [skillSearch, setSkillSearch] = useState(initialEntrySnapshot?.search.skills ?? "");
  const [manageViewState, setManageViewState] = useState<PluginLibraryManageSnapshot>(
    () =>
      routeManageSnapshot ?? {
        initialTab: "plugins",
        search: initialEntrySnapshot?.search.plugins ?? "",
        scrollTop: 0,
        focusAnchor: null,
      },
  );
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const [updatingAppId, setUpdatingAppId] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [connectTarget, setConnectTarget] = useState<AppConnectTarget | null>(null);
  const [pendingRemoveMarketplaceName, setPendingRemoveMarketplaceName] = useState<string | null>(
    null,
  );
  const [pendingUpgradeMarketplaceName, setPendingUpgradeMarketplaceName] = useState<string | null>(
    null,
  );
  const [upgradingAllMarketplaces, setUpgradingAllMarketplaces] = useState(false);
  const restoredFocusAnchorRef = useRef<string | null>(null);
  const hydratedPathRef = useRef(pathname);
  const browseScrollRef = useRef<HTMLDivElement>(null);
  const manageScrollRef = useRef<HTMLDivElement>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const openAppExternalUrl = useMemo(
    () => createSingleFlightPluginExternalOpener(openPluginExternalUrl),
    [],
  );
  const deferredPluginSearch = useDeferredValue(pluginSearch);
  const deferredMcpSearch = useDeferredValue(mcpSearch);
  const deferredSkillSearch = useDeferredValue(skillSearch);
  const providerThreadId = focusedThreadId;
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const { settings } = useAppSettings();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const mossInstanceId = codexAccountInstanceId("moss");
  const mossInstance = serverSettingsQuery.data?.providerInstances[mossInstanceId];
  const selectedProviderInstanceId = resolvePluginLibraryProviderInstanceId({
    selectedProvider,
    activeThread,
    standaloneMossInstanceId:
      !activeThread &&
      // firstProject supplies a cwd when no project is focused; it must not
      // replace the managed account of the global Moss plugin destination.
      !focusedProject &&
      activeBucket === "moss" &&
      mossInstance?.driver === "codex" &&
      mossInstance.enabled !== false &&
      mossInstance.config !== null &&
      typeof mossInstance.config === "object" &&
      "managed" in mossInstance.config &&
      mossInstance.config.managed === true
        ? mossInstanceId
        : null,
    fallbackModelSelection:
      activeProject?.defaultModelSelection ??
      serverSettingsQuery.data?.textGenerationModelSelection ??
      null,
  });
  const codexCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "codex",
      selectedProvider === "codex" ? selectedProviderInstanceId : null,
    ),
  );
  const claudeCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedProviderInstanceId : null,
    ),
  );
  const cursorCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "cursor",
      selectedProvider === "cursor" ? selectedProviderInstanceId : null,
    ),
  );
  const geminiCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "gemini",
      selectedProvider === "gemini" ? selectedProviderInstanceId : null,
    ),
  );
  const antigravityCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "antigravity",
      selectedProvider === "antigravity" ? selectedProviderInstanceId : null,
    ),
  );
  const grokCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "grok",
      selectedProvider === "grok" ? selectedProviderInstanceId : null,
    ),
  );
  const devinCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "devin",
      selectedProvider === "devin" ? selectedProviderInstanceId : null,
    ),
  );
  const openCodeCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "opencode",
      selectedProvider === "opencode" ? selectedProviderInstanceId : null,
    ),
  );
  const piCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(
      "pi",
      selectedProvider === "pi" ? selectedProviderInstanceId : null,
    ),
  );
  const selectedCapabilitiesQuery = {
    codex: codexCapabilitiesQuery,
    claudeAgent: claudeCapabilitiesQuery,
    cursor: cursorCapabilitiesQuery,
    gemini: geminiCapabilitiesQuery,
    antigravity: antigravityCapabilitiesQuery,
    grok: grokCapabilitiesQuery,
    devin: devinCapabilitiesQuery,
    opencode: openCodeCapabilitiesQuery,
    pi: piCapabilitiesQuery,
    hermes: undefined,
    omp: undefined,
    kimi: undefined,
    minimax: undefined,
    zcode: undefined,
  }[selectedProvider];
  const awaitingSelectedCapabilities =
    selectedCapabilitiesQuery !== undefined && selectedCapabilitiesQuery.data === undefined;
  const providerCapabilities = useMemo<Record<SupportedProviderKind, ProviderCapabilities>>(
    () => ({
      codex: {
        plugins: supportsPluginDiscovery(codexCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(codexCapabilitiesQuery.data),
      },
      claudeAgent: {
        plugins: supportsPluginDiscovery(claudeCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(claudeCapabilitiesQuery.data),
      },
      cursor: {
        plugins: supportsPluginDiscovery(cursorCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(cursorCapabilitiesQuery.data),
      },
      gemini: {
        plugins: supportsPluginDiscovery(geminiCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(geminiCapabilitiesQuery.data),
      },
      antigravity: {
        plugins: supportsPluginDiscovery(antigravityCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(antigravityCapabilitiesQuery.data),
      },
      grok: {
        plugins: supportsPluginDiscovery(grokCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(grokCapabilitiesQuery.data),
      },
      devin: {
        plugins: supportsPluginDiscovery(devinCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(devinCapabilitiesQuery.data),
      },
      opencode: {
        plugins: supportsPluginDiscovery(openCodeCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(openCodeCapabilitiesQuery.data),
      },
      pi: {
        plugins: supportsPluginDiscovery(piCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(piCapabilitiesQuery.data),
      },
      hermes: { plugins: false, skills: false },
      omp: { plugins: false, skills: false },
      kimi: { plugins: false, skills: false },
      minimax: { plugins: false, skills: false },
      zcode: { plugins: false, skills: false },
    }),
    [
      claudeCapabilitiesQuery.data,
      codexCapabilitiesQuery.data,
      cursorCapabilitiesQuery.data,
      geminiCapabilitiesQuery.data,
      antigravityCapabilitiesQuery.data,
      grokCapabilitiesQuery.data,
      devinCapabilitiesQuery.data,
      openCodeCapabilitiesQuery.data,
      piCapabilitiesQuery.data,
    ],
  );

  // Auto-fallback: switch provider when the current plugins/skills tab is
  // unsupported. MCP is a provider-neutral catalog so it never forces a switch.
  useEffect(() => {
    if (selectedTab === "mcp") return;
    // Pending or failed discovery says nothing about the selected host's
    // capabilities. Preserve its account rather than switching on missing data.
    if (awaitingSelectedCapabilities && !settings.disabledProviders.includes(selectedProvider))
      return;
    const supportsTab =
      !settings.disabledProviders.includes(selectedProvider) &&
      (selectedTab === "plugins"
        ? providerCapabilities[selectedProvider].plugins
        : providerCapabilities[selectedProvider].skills);
    if (supportsTab) return;
    const fallbackOrder = (
      selectedTab === "plugins"
        ? DEFAULT_PROVIDER_ORDER
        : [preferredProvider, ...DEFAULT_PROVIDER_ORDER.filter((p) => p !== preferredProvider)]
    ).filter((provider) => !settings.disabledProviders.includes(provider));
    const fallback =
      fallbackOrder.find((provider) =>
        selectedTab === "plugins"
          ? providerCapabilities[provider].plugins
          : providerCapabilities[provider].skills,
      ) ?? null;
    if (fallback) setSelectedProvider(fallback);
  }, [
    awaitingSelectedCapabilities,
    preferredProvider,
    providerCapabilities,
    selectedProvider,
    selectedTab,
    settings.disabledProviders,
  ]);

  // Reset to the default (Moss) bucket whenever the tab changes.
  useEffect(() => {
    if (
      routeEntrySnapshot?.sourcePath === pathname &&
      routeEntrySnapshot.initialTab === selectedTab
    ) {
      return;
    }
    setActiveBucket("moss");
    setSelectedSectionId(null);
  }, [pathname, routeEntrySnapshot, selectedTab]);

  const discoveryCwd = embedded
    ? (cwdProp?.trim() ?? "") || null
    : resolveProviderDiscoveryCwd({
        activeThreadWorktreePath: activeThread?.worktreePath ?? null,
        activeProjectCwd: activeProject?.cwd ?? null,
        serverCwd: serverConfigQuery.data?.cwd ?? null,
      });

  useEffect(() => {
    setRetainedPluginAuthSession(null);
  }, [discoveryCwd, providerThreadId, selectedProvider, selectedProviderInstanceId]);

  const providerLabel = PROVIDER_DISPLAY_NAMES[selectedProvider];
  const canListPlugins =
    !settings.disabledProviders.includes(selectedProvider) &&
    providerCapabilities[selectedProvider].plugins;
  const canListSkills =
    !settings.disabledProviders.includes(selectedProvider) &&
    providerCapabilities[selectedProvider].skills;

  const canListOptionalPluginDirectories =
    canListPlugins &&
    !(selectedProvider === "codex" && isMossProtectedSourceInstanceId(selectedProviderInstanceId));

  const primaryPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      marketplaceKinds: PRIMARY_PLUGIN_MARKETPLACE_KINDS,
      forceRemoteSync: canListOptionalPluginDirectories,
      forceReload: true,
      enabled: canListPlugins,
    }),
  );
  const workspacePluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      marketplaceKinds: WORKSPACE_PLUGIN_MARKETPLACE_KINDS,
      enabled: canListOptionalPluginDirectories,
    }),
  );
  const sharedPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      marketplaceKinds: SHARED_PLUGIN_MARKETPLACE_KINDS,
      enabled: canListOptionalPluginDirectories,
    }),
  );
  const createdPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      marketplaceKinds: CREATED_PLUGIN_MARKETPLACE_KINDS,
      enabled: canListOptionalPluginDirectories,
    }),
  );
  // Codex desktop's own directory: plugin/list without kinds, the whole remote
  // catalog in its categories (plus what each account installed from it).
  const directoryLaneEnabled = canListOptionalPluginDirectories && selectedProvider === "codex";
  const directoryPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      staleTime: PLUGIN_DIRECTORY_STALE_TIME_MS,
      enabled: directoryLaneEnabled,
    }),
  );

  const appsQuery = useQuery(
    providerAppsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      enabled:
        (showManagement ||
          pluginAuthSetup !== null ||
          connectTarget !== null ||
          installingPluginKeys.size > 0) &&
        canListPlugins,
    }),
  );

  // Apps are plugins, as in Codex: once the server has an app backend, the
  // Moss Apps catalog joins the directory as one more marketplace.
  const mossAppsStatusQuery = useQuery(mossAppsStatusQueryOptions());
  const mossAppsReady = mossAppsStatusQuery.data?.availability === "ready";
  const mossAppCatalogQuery = useQuery(mossAppCatalogQueryOptions({ enabled: mossAppsReady }));
  const mossAppConnectionsQuery = useQuery(
    mossAppConnectionsQueryOptions({ enabled: mossAppsReady, polling: false }),
  );
  const mossAppToolkits = mossAppCatalogQuery.data?.toolkits ?? NO_MOSS_APP_TOOLKITS;
  const mossAppConnections = mossAppConnectionsQuery.data?.connections ?? NO_MOSS_APP_CONNECTIONS;
  const [mossAppConnectTarget, setMossAppConnectTarget] = useState<MossAppConnectTarget | null>(
    null,
  );
  const pluginDetailQuery = useQuery(
    providerReadPluginQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      marketplacePath: detail?.kind === "plugin" ? detail.marketplacePath : null,
      remoteMarketplaceName: detail?.kind === "plugin" ? detail.remoteMarketplaceName : null,
      pluginName: detail?.kind === "plugin" ? detail.plugin.name : "__none__",
      cwd: discoveryCwd,
      threadId: providerThreadId,
      enabled:
        detailOpen &&
        detail?.kind === "plugin" &&
        !isMossAppPlugin(detail.plugin) &&
        canListPlugins,
    }),
  );
  const mossAppDetail = useMemo(() => {
    if (detail?.kind !== "plugin") return null;
    const slug = mossAppSlugFromPluginId(detail.plugin.id);
    const toolkit = slug ? mossAppToolkits.find((candidate) => candidate.slug === slug) : undefined;
    return toolkit
      ? mossAppPluginDetail(toolkit, activeMossAppConnection(mossAppConnections, toolkit.slug))
      : null;
  }, [detail, mossAppConnections, mossAppToolkits]);
  const activePluginDetail = mossAppDetail ?? pluginDetailQuery.data?.plugin;
  const activePluginDetailLoading = mossAppDetail ? false : pluginDetailQuery.isFetching;
  // A connect or disconnect settles outside this page; keep its install state live.
  useEffect(() => {
    if (!mossAppDetail || detail?.kind !== "plugin") return;
    if (mossAppDetail.summary.installed === detail.plugin.installed) return;
    setDetail({ ...detail, plugin: mossAppDetail.summary });
  }, [detail, mossAppDetail]);

  const mcpQuery = useQuery(
    providerMcpQueryOptions({
      provider: selectedProvider,
      cwd: discoveryCwd,
      threadId: providerThreadId,
    }),
  );

  const skillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      enabled: canListSkills && discoveryCwd !== null,
      includeDisabled: true,
    }),
  );

  const mcpServers = useMemo(() => mcpQuery.data?.servers ?? [], [mcpQuery.data?.servers]);

  const disabledSkillNames = useMemo(
    () =>
      new Set(
        (serverSettingsQuery.data?.skills.disabled ?? []).map((name) => settingsSkillNameKey(name)),
      ),
    [serverSettingsQuery.data?.skills.disabled],
  );
  const discoveredSkills = useMemo(
    () =>
      (skillsQuery.data?.skills ?? []).map((skill) => ({
        ...skill,
        enabled: skill.enabled && !disabledSkillNames.has(settingsSkillNameKey(skill.name)),
      })),
    [skillsQuery.data?.skills, disabledSkillNames],
  );

  // React Query intentionally retains the last successful payload when a
  // refetch fails. Optional directory shards are not authoritative, so using
  // that retained payload after an error would silently present stale remote
  // rows as current. Keep primary truth usable, but fail closed per optional
  // shard and surface the degraded state below.
  const workspacePluginsData = workspacePluginsQuery.isError
    ? undefined
    : workspacePluginsQuery.data;
  const sharedPluginsData = sharedPluginsQuery.isError ? undefined : sharedPluginsQuery.data;
  const createdPluginsData = createdPluginsQuery.isError ? undefined : createdPluginsQuery.data;
  const directoryPluginsData = directoryPluginsQuery.isError
    ? undefined
    : directoryPluginsQuery.data;

  const nativePluginEntries = useMemo<PluginEntry[]>(
    () =>
      uniquePluginEntries(
        withRemotePluginDirectory(
          [
            ...providerPluginDirectoryEntries({
              result: primaryPluginsQuery.data,
              provenance: "local-or-vertical",
            }),
            ...providerPluginDirectoryEntries({
              result: workspacePluginsData,
              provenance: "workspace-directory",
            }),
            ...providerPluginDirectoryEntries({
              result: sharedPluginsData,
              provenance: "shared-with-me",
            }),
            ...providerPluginDirectoryEntries({
              result: createdPluginsData,
              provenance: "created-by-me-remote",
            }),
          ],
          providerPluginDirectoryEntries({
            result: directoryPluginsData,
            provenance: "remote-directory",
          }),
        ),
      ),
    [
      createdPluginsData,
      directoryPluginsData,
      primaryPluginsQuery.data,
      sharedPluginsData,
      workspacePluginsData,
    ],
  );
  const pluginEntries = useMemo<PluginEntry[]>(
    () => [
      ...nativePluginEntries,
      ...mossAppDirectoryEntries({
        toolkits: mossAppToolkits,
        connections: mossAppConnections,
      }),
    ],
    [mossAppConnections, mossAppToolkits, nativePluginEntries],
  );
  const pluginFeaturedIds = useMemo(
    () => [
      ...new Set([
        ...(directoryPluginsData?.featuredPluginIds ?? []),
        ...(primaryPluginsQuery.data?.featuredPluginIds ?? []),
        ...(workspacePluginsData?.featuredPluginIds ?? []),
        ...(sharedPluginsData?.featuredPluginIds ?? []),
        ...(createdPluginsData?.featuredPluginIds ?? []),
      ]),
    ],
    [
      createdPluginsData?.featuredPluginIds,
      directoryPluginsData?.featuredPluginIds,
      primaryPluginsQuery.data?.featuredPluginIds,
      sharedPluginsData?.featuredPluginIds,
      workspacePluginsData?.featuredPluginIds,
    ],
  );
  // Optional directory shards can be slow or unavailable for an account. They
  // must not hold the authoritative local catalog in a skeleton state.
  const pluginsLoading = primaryPluginsQuery.isLoading || primaryPluginsQuery.isPlaceholderData;
  const pluginsFetching =
    primaryPluginsQuery.isFetching ||
    workspacePluginsQuery.isFetching ||
    sharedPluginsQuery.isFetching ||
    createdPluginsQuery.isFetching ||
    directoryPluginsQuery.isFetching;
  // Only the local/vertical shard is authoritative for native plugin
  // mutations. Optional directory shards commonly require separate auth; a
  // failure there must not replace a usable primary catalog with a fatal page.
  const pluginsError = primaryPluginsQuery.error;
  const pluginLoadErrors = [
    ...(primaryPluginsQuery.data?.marketplaceLoadErrors ?? []),
    ...(workspacePluginsData?.marketplaceLoadErrors ?? []),
    ...(sharedPluginsData?.marketplaceLoadErrors ?? []),
    ...(createdPluginsData?.marketplaceLoadErrors ?? []),
  ];
  // A marketplace file that failed to load is named with its path; a CLI's
  // whole listing failing (timed out, signed out) is an unavailable source.
  const pluginMarketplaceLoadErrors = pluginLoadErrors.filter(
    (error) => !isProviderPluginListingLoadError(error),
  );
  const pluginRemoteSyncCauses = [
    primaryPluginsQuery.data?.remoteSyncError,
    workspacePluginsData?.remoteSyncError,
    sharedPluginsData?.remoteSyncError,
    createdPluginsData?.remoteSyncError,
    pluginLibraryErrorMessage(workspacePluginsQuery.error),
    pluginLibraryErrorMessage(sharedPluginsQuery.error),
    pluginLibraryErrorMessage(createdPluginsQuery.error),
    pluginLibraryErrorMessage(directoryPluginsQuery.error),
    pluginLibraryErrorMessage(mossAppCatalogQuery.error),
    ...[...pluginLoadErrors, ...(directoryPluginsData?.marketplaceLoadErrors ?? [])]
      .filter(isProviderPluginListingLoadError)
      .map((error) => error.message),
  ].filter((message): message is string => Boolean(message));
  // A source failing (a CLI still starting, a lane needing its own sign-in) is
  // named in words; the adapter's raw cause stays in the warning's tooltip.
  const pluginRemoteSyncErrors = pluginRemoteSyncCauses.map((message) =>
    message === MOSS_LOCAL_PLUGIN_REMOTE_AUTH_WARNING
      ? t("plugins.warning.openAiRemoteAuth")
      : t("plugins.warning.sourcesUnavailable"),
  );
  const pluginRemoteSyncDetails = [...new Set(pluginRemoteSyncCauses)].join("\n");
  const reReadPlugins = (): Promise<PluginCatalogSnapshot> =>
    readPrimaryPluginCatalog({
      invalidate: () =>
        queryClient.invalidateQueries({
          queryKey: pluginLibraryDiscoveryQueryKeys.pluginsForProvider(selectedProvider),
          refetchType: "none",
        }),
      readPrimary: async () => {
        const result = await primaryPluginsQuery.refetch();
        if (result.isError) throw result.error;
        if (!result.data) throw new Error("plugin/list did not return authoritative state.");
        return result.data;
      },
      refreshOptional: [
        ...(canListOptionalPluginDirectories
          ? [
              () => workspacePluginsQuery.refetch(),
              () => sharedPluginsQuery.refetch(),
              () => createdPluginsQuery.refetch(),
              ...(directoryLaneEnabled ? [() => directoryPluginsQuery.refetch()] : []),
            ]
          : []),
        // Moss Apps is one more source: Refresh re-reads it with the CLI's lanes.
        ...(mossAppsReady
          ? [() => mossAppCatalogQuery.refetch(), () => mossAppConnectionsQuery.refetch()]
          : []),
      ],
    });
  const refetchApps = appsQuery.refetch;
  const reReadApps = useCallback(async (): Promise<readonly ProviderAppInfo[]> => {
    await queryClient.invalidateQueries({
      queryKey: pluginLibraryDiscoveryQueryKeys.appsForProvider(selectedProvider),
      refetchType: "none",
    });
    const result = await refetchApps();
    if (result.isError) throw result.error;
    if (!result.data) throw new Error("app/list did not return authoritative state.");
    return result.data;
  }, [queryClient, refetchApps, selectedProvider]);

  const installedPluginEntries = useMemo(
    () =>
      installedPluginDirectoryEntries(pluginEntries).filter(
        (entry) => !isCodexManagedPlugin(entry),
      ),
    [pluginEntries],
  );
  const connectedMossApps = useMemo(
    () =>
      mossAppToolkits.flatMap((toolkit) =>
        activeMossAppConnection(mossAppConnections, toolkit.slug)
          ? [
              {
                slug: toolkit.slug,
                name: toolkit.name,
                description: toolkit.description,
                logoUrl: toolkit.logoUrl,
              },
            ]
          : [],
      ),
    [mossAppConnections, mossAppToolkits],
  );
  const mossAppResource = (slug: string): Extract<ResourceDetail, { kind: "plugin" }> | null => {
    const entry = pluginEntries.find((candidate) => candidate.plugin.id === mossAppPluginId(slug));
    return entry
      ? {
          kind: "plugin",
          plugin: entry.plugin,
          marketplaceName: entry.marketplaceName,
          marketplacePath: entry.marketplacePath,
          remoteMarketplaceName: entry.remoteMarketplaceName,
        }
      : null;
  };
  const managedApps = useMemo(
    () => (appsQuery.data ?? []).filter((app) => app.isAccessible),
    [appsQuery.data],
  );
  const selectedApp = useMemo(
    () =>
      selectedAppId === null
        ? null
        : ((appsQuery.data ?? []).find((app) => app.id === selectedAppId) ?? null),
    [appsQuery.data, selectedAppId],
  );
  const appConnectorContext = useMemo(
    () => ({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      ...(discoveryCwd ? { cwd: discoveryCwd } : {}),
      ...(providerThreadId ? { threadId: providerThreadId } : {}),
    }),
    [discoveryCwd, providerThreadId, selectedProvider, selectedProviderInstanceId],
  );
  const loadAppTools = useCallback(
    async (app: ProviderAppInfo) =>
      (await ensureNativeApi().provider.readAppTools({ ...appConnectorContext, appId: app.id }))
        .tools,
    [appConnectorContext],
  );
  const readAppConnector = useCallback(
    async (app: AppConnectTarget) =>
      (
        await ensureNativeApi().provider.readAppConnector({
          ...appConnectorContext,
          appId: app.id,
        })
      ).connector,
    [appConnectorContext],
  );
  const readAppConnectorTerms = useCallback(
    async (app: AppConnectTarget) =>
      (
        await ensureNativeApi().provider.readAppConnectorTerms({
          ...appConnectorContext,
          appId: app.id,
        })
      ).terms,
    [appConnectorContext],
  );
  const startAppConnection = useCallback(
    async (input: {
      readonly callbackUrl: string;
      readonly postAuthUrl: string;
      readonly reauthentication: null;
    }) => {
      if (!connectTarget) throw new Error("Expected an app connection target.");
      return ensureNativeApi().provider.startAppConnection({
        ...appConnectorContext,
        appId: connectTarget.id,
        ...input,
      });
    },
    [appConnectorContext, connectTarget],
  );
  const reconcilePluginAuthSetup = useCallback((apps: readonly ProviderAppInfo[]) => {
    setRetainedPluginAuthSession(null);
    setPluginAuthSetup((current) => {
      if (!current) return null;
      const nextApps = reconcileRequiredPluginApps(current.apps, apps);
      if (nextApps.every((app) => app.status === "connected")) return null;
      return { ...current, apps: nextApps };
    });
  }, []);
  const handleAppConnected = useCallback(async () => {
    const apps = await reReadApps();
    reconcilePluginAuthSetup(apps);
  }, [reReadApps, reconcilePluginAuthSetup]);

  const handlePluginAppConnectionFailed = useCallback((appId: string) => {
    setRetainedPluginAuthSession(null);
    setPluginAuthSetup((current) =>
      current?.mode === "multiple"
        ? {
            ...current,
            apps: current.apps.map((app) =>
              app.id === appId && app.status === "opened"
                ? { ...app, status: "pending" as const }
                : app,
            ),
          }
        : null,
    );
  }, []);

  const handleAppConnectDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) return;
    setConnectTarget(null);
    setConnectingAuthAppId(null);
    setPluginAuthSetup((current) =>
      current?.mode === "multiple"
        ? {
            ...current,
            apps: current.apps.map((app) =>
              app.status === "launching" ? { ...app, status: "pending" as const } : app,
            ),
          }
        : null,
    );
  }, []);

  const connectorOAuthBridge =
    typeof window === "undefined"
      ? undefined
      : ((
          window as Window & {
            moss?: {
              connectorOAuth?: NonNullable<typeof window.desktopBridge>["connectorOAuth"];
            };
          }
        ).moss?.connectorOAuth ?? window.desktopBridge?.connectorOAuth);
  const pluginAuthAttemptSession = pluginAuthSetup?.sessionId ?? retainedPluginAuthSession;
  const pluginAuthAttemptScope =
    pluginAuthAttemptSession !== null
      ? JSON.stringify([selectedProvider, discoveryCwd, providerThreadId, pluginAuthAttemptSession])
      : null;
  const completeAppConnection = useCallback(
    async (fullRedirectUrl: string) => {
      await ensureNativeApi().provider.completeAppConnection({
        ...appConnectorContext,
        fullRedirectUrl,
      });
    },
    [appConnectorContext],
  );
  const handlePluginAppConnectionFailure = usePluginAppConnectionFailureToast();
  const registerOpenedPluginAppConnection = usePluginAuthCallbackRecovery({
    bridge: connectorOAuthBridge,
    attemptScope: pluginAuthAttemptScope,
    completeAppConnection,
    reReadApps,
    onAppsRead: reconcilePluginAuthSetup,
    onAppConnectionFailed: handlePluginAppConnectionFailed,
    onFailure: handlePluginAppConnectionFailure,
  });
  const handleAppConnectionOpened = useCallback(
    (connection: AppConnectionOpened) => {
      if (pluginAuthSetup) {
        const retainedSession = retainedPluginAuthSessionId({
          mode: pluginAuthSetup.mode,
          sessionId: pluginAuthSetup.sessionId,
          redirectUrl: connection.redirectUrl,
        });
        if (retainedSession !== null) setRetainedPluginAuthSession(retainedSession);
      }
      setPluginAuthSetup((current) =>
        current
          ? {
              ...current,
              apps: current.apps.map((app) =>
                app.id === connection.appId ? { ...app, status: "opened" as const } : app,
              ),
            }
          : null,
      );
      registerOpenedPluginAppConnection(connection);
    },
    [pluginAuthSetup, registerOpenedPluginAppConnection],
  );
  const managedMarketplacesList = useMemo<ManagedMarketplace[]>(
    () =>
      managedMarketplaces(primaryPluginsQuery.data).filter((marketplace) => !marketplace.isBuiltIn),
    [primaryPluginsQuery.data],
  );
  const routePluginEntry = useMemo(
    () =>
      routePluginId === null
        ? null
        : (pluginEntries.find((candidate) => candidate.plugin.id === routePluginId) ?? null),
    [pluginEntries, routePluginId],
  );
  const routePluginViewState = resolvePluginDetailRouteViewState({
    pluginId: routePluginId,
    isLoading:
      pluginsLoading ||
      (routePluginId !== null &&
        mossAppSlugFromPluginId(routePluginId) !== null &&
        (mossAppsStatusQuery.isPending || mossAppCatalogQuery.isPending)),
    error: pluginsError,
    found: routePluginEntry !== null,
  });

  // ── Source buckets (Moss / By your workspace / Personal) ────────────────
  // Which buckets actually contain items on the current tab, so empty buckets
  // aren't offered (Codex hides directory tabs with no plugins).
  const availableBuckets = useMemo<ReadonlySet<LibraryBucket>>(() => {
    const set = new Set<LibraryBucket>();
    if (selectedTab === "plugins") {
      for (const entry of pluginEntries) {
        set.add(entry.bucket);
      }
    } else if (selectedTab === "skills") {
      for (const skill of discoveredSkills) set.add(skillBucket(skill));
    }
    return set;
  }, [selectedTab, pluginEntries, discoveredSkills]);

  // Snap to a populated bucket if the active one is empty (keeps the view useful
  // while still defaulting to Moss). Codex lands on Public: until the lanes that
  // fill it have answered, an empty Public only means "still loading".
  // The skills query seeds an empty placeholder; until its first answer that is
  // "loading", not "no skills".
  const skillsLoading = skillsQuery.isLoading || skillsQuery.isPlaceholderData;
  const bucketsSettled =
    selectedTab === "plugins"
      ? !pluginsLoading && !(directoryLaneEnabled && directoryPluginsQuery.isPlaceholderData)
      : !skillsLoading;
  useEffect(() => {
    if (!bucketsSettled) return;
    if (availableBuckets.size > 0 && !availableBuckets.has(activeBucket)) {
      const next = LIBRARY_BUCKETS.find((bucket) => availableBuckets.has(bucket.id));
      if (next) setActiveBucket(next.id);
    }
  }, [availableBuckets, activeBucket, bucketsSettled]);

  // ── Filtered lists ─────────────────────────────────────────────────────
  const filteredPluginEntries = useMemo(() => {
    // What Codex ships and manages itself (its bundles, default installs) is not
    // a directory item there; its pages stay reachable by id.
    const bySource = pluginEntries.filter(
      (entry) => entry.bucket === activeBucket && !isCodexManagedPlugin(entry),
    );
    const q = normalizeProviderDiscoveryText(deferredPluginSearch);
    if (!q) return bySource;
    return rankProviderDiscoveryItems(bySource, q, (entry) =>
      buildPluginSearchFields(entry.plugin),
    );
  }, [deferredPluginSearch, pluginEntries, activeBucket]);

  const filteredMcpServers = useMemo(() => {
    const q = normalizeProviderDiscoveryText(deferredMcpSearch);
    if (!q) return mcpServers;
    const needle = q.toLowerCase();
    return mcpServers.filter(
      (server) =>
        server.name.toLowerCase().includes(needle) ||
        (server.command ?? "").toLowerCase().includes(needle) ||
        (server.url ?? "").toLowerCase().includes(needle),
    );
  }, [deferredMcpSearch, mcpServers]);

  // Codex's Skills page lists standalone skills; a plugin's own skills live on
  // that plugin's page.
  const standaloneSkills = useMemo(
    () => discoveredSkills.filter((skill) => !isPluginBundledSkill(skill)),
    [discoveredSkills],
  );
  const filteredSkills = useMemo(() => {
    const q = normalizeProviderDiscoveryText(deferredSkillSearch);
    if (!q) return standaloneSkills;
    return rankProviderDiscoveryItems(standaloneSkills, q, buildSkillSearchFields);
  }, [deferredSkillSearch, standaloneSkills]);
  // Settings › Plugins › Skills manages the user's own skills; system skills
  // are not theirs to switch off.
  const manageableSkills = useMemo(
    () => standaloneSkills.filter((skill) => skillScopeGroup(skill) === "personal"),
    [standaloneSkills],
  );

  // Codex skills browse (Helios shot 14): a "Personal / System" scope tab pair
  // filters the lower list; the Installed grid above always shows every
  // discovered skill. Skills use their own scope grouping instead of the
  // plugin source buckets.
  const scopedSkills = useMemo(
    () => filteredSkills.filter((skill) => skillScopeGroup(skill) === skillScope),
    [filteredSkills, skillScope],
  );

  const pluginDirectorySections = useMemo(
    () =>
      sectionCodexPluginDirectory({
        entries: filteredPluginEntries,
        featuredPluginIds: pluginFeaturedIds,
        categoryOrder: CODEX_DIRECTORY_CATEGORY_ORDER,
        layout: activeBucket === "personal" ? "marketplaces" : "categories",
      }),
    [activeBucket, filteredPluginEntries, pluginFeaturedIds],
  );

  const visiblePluginDirectorySections = useMemo(
    () => filterPluginDirectorySections(pluginDirectorySections, selectedSectionId),
    [pluginDirectorySections, selectedSectionId],
  );
  // A selected section is Codex's category page ("Popular", "Productivity"):
  // the page title becomes the category and the top bar gains a breadcrumb.
  const selectedPluginSection =
    selectedTab === "plugins" && selectedSectionId !== null
      ? (visiblePluginDirectorySections[0] ?? null)
      : null;

  const pluginSearchResults = useMemo(
    () =>
      visiblePluginDirectorySections.flatMap((section) =>
        section.entries.map((entry) => ({
          id: pluginSearchResultId(section.id, entry),
          entry,
        })),
      ),
    [visiblePluginDirectorySections],
  );
  const mcpSearchResults = useMemo(
    () => filteredMcpServers.map((server) => ({ id: mcpSearchResultId(server), server })),
    [filteredMcpServers],
  );
  const skillSearchResults = useMemo(
    () => filteredSkills.map((skill) => ({ id: skillSearchResultId(skill), skill })),
    [filteredSkills],
  );

  useEffect(() => {
    if (
      selectedSectionId !== null &&
      !pluginDirectorySections.some((section) => section.id === selectedSectionId)
    ) {
      setSelectedSectionId(null);
    }
  }, [pluginDirectorySections, selectedSectionId]);

  // ── Detail + create handlers ───────────────────────────────────────────
  const captureCurrentEntrySnapshot = useCallback(
    (focusAnchor?: PluginLibraryFocusAnchor | null): PluginLibraryEntrySnapshot => {
      const scrollContainer =
        routePluginId !== null
          ? detailScrollRef.current
          : showManagement
            ? manageScrollRef.current
            : browseScrollRef.current;
      return {
        sourcePath: pathname,
        initialHostId: selectedProvider,
        initialTab: selectedTab,
        activeBucket,
        selectedSectionId,
        search: {
          plugins: pluginSearch,
          mcp: mcpSearch,
          skills: skillSearch,
        },
        scrollTop: scrollContainer?.scrollTop ?? 0,
        focusAnchor: focusAnchor ?? readPluginLibraryDomFocusAnchor(),
      };
    },
    [
      activeBucket,
      mcpSearch,
      pathname,
      pluginSearch,
      routePluginId,
      selectedProvider,
      selectedSectionId,
      selectedTab,
      showManagement,
      skillSearch,
    ],
  );

  const replaceCurrentPluginLibraryHistoryState = useCallback(
    (input: {
      readonly entrySnapshot?: PluginLibraryEntrySnapshot | undefined;
      readonly focusAnchor?: PluginLibraryFocusAnchor | null | undefined;
      readonly manageSnapshot?: PluginLibraryManageSnapshot | undefined;
    }) => {
      const currentLocation = router.history.location;
      router.history.replace(currentLocation.href, {
        ...currentLocation.state,
        ...(input.entrySnapshot ? { pluginLibraryEntrySnapshot: input.entrySnapshot } : {}),
        ...(input.manageSnapshot ? { pluginLibraryManageSnapshot: input.manageSnapshot } : {}),
        pluginLibraryFocusAnchor: input.focusAnchor ?? null,
      });
      router.history.flush();
    },
    [router],
  );

  const persistCurrentPluginLibrarySurface = useCallback(
    (
      focusAnchor?: PluginLibraryFocusAnchor | null,
      manageSnapshotOverride?: PluginLibraryManageSnapshot,
    ): PluginLibraryEntrySnapshot => {
      const resolvedFocusAnchor = focusAnchor ?? readPluginLibraryDomFocusAnchor();
      const entrySnapshot = captureCurrentEntrySnapshot(resolvedFocusAnchor);
      const nextManageSnapshot =
        showManagement && routePluginId === null
          ? {
              ...(manageSnapshotOverride ?? manageViewState),
              scrollTop:
                manageScrollRef.current?.scrollTop ??
                manageSnapshotOverride?.scrollTop ??
                manageViewState.scrollTop,
              focusAnchor: resolvedFocusAnchor,
            }
          : undefined;
      replaceCurrentPluginLibraryHistoryState({
        entrySnapshot,
        focusAnchor: resolvedFocusAnchor,
        ...(nextManageSnapshot ? { manageSnapshot: nextManageSnapshot } : {}),
      });
      return entrySnapshot;
    },
    [
      captureCurrentEntrySnapshot,
      manageViewState,
      replaceCurrentPluginLibraryHistoryState,
      routePluginId,
      showManagement,
    ],
  );

  const handleManageViewStateChange = useCallback(
    (nextState: PluginLibraryManageSnapshot) => {
      const nextSnapshot = {
        ...nextState,
        scrollTop: manageScrollRef.current?.scrollTop ?? nextState.scrollTop,
      };
      setManageViewState(nextSnapshot);
      replaceCurrentPluginLibraryHistoryState({
        manageSnapshot: nextSnapshot,
        focusAnchor: nextSnapshot.focusAnchor,
      });
    },
    [replaceCurrentPluginLibraryHistoryState],
  );

  const openSettingsManagement = useCallback(
    (focusAnchor?: PluginLibraryFocusAnchor | null) => {
      const resolvedFocusAnchor = focusAnchor ?? readPluginLibraryDomFocusAnchor();
      const entrySnapshot = persistCurrentPluginLibrarySurface(resolvedFocusAnchor);
      const nextManageSnapshot: PluginLibraryManageSnapshot = {
        initialTab: "plugins",
        search: pluginSearch,
        scrollTop: 0,
        focusAnchor: null,
      };
      setManageViewState(nextManageSnapshot);
      void navigate({
        to: PLUGIN_LIBRARY_SETTINGS_PATH,
        state: (previous) => ({
          ...previous,
          pluginLibraryEntrySnapshot: entrySnapshot,
          pluginLibraryManageSnapshot: nextManageSnapshot,
          pluginLibraryFocusAnchor: null,
          pluginLibraryReturnToPreviousHistoryEntry: true,
        }),
      });
    },
    [navigate, persistCurrentPluginLibrarySurface, pluginSearch],
  );

  const returnFromPluginDetail = useCallback(() => {
    persistCurrentPluginLibrarySurface(routeFocusAnchor);
    if (returnToPreviousHistoryEntry && router.history.canGoBack()) {
      router.history.flush();
      router.history.back();
      return;
    }
    void navigate({ to: showManagement ? "/skills/manage" : "/skills" });
  }, [
    navigate,
    persistCurrentPluginLibrarySurface,
    returnToPreviousHistoryEntry,
    routeFocusAnchor,
    router,
    showManagement,
  ]);

  const exitPluginSettingsManagement = useCallback(() => {
    persistCurrentPluginLibrarySurface(routeFocusAnchor);
    if (showSettingsManagement && returnToPreviousHistoryEntry && router.history.canGoBack()) {
      router.history.flush();
      router.history.back();
      return;
    }
    void navigate({ to: "/skills" });
  }, [
    navigate,
    persistCurrentPluginLibrarySurface,
    returnToPreviousHistoryEntry,
    routeFocusAnchor,
    router,
    showSettingsManagement,
  ]);

  const openDetail = (next: ResourceDetail, trigger?: HTMLElement) => {
    setDetail(next);
    setDetailOpen(true);
    if (next.kind !== "plugin") return;
    const focusAnchor = readPluginLibraryDomFocusAnchor(trigger);
    const entrySnapshot = persistCurrentPluginLibrarySurface(focusAnchor);
    const state = (previous: typeof router.history.location.state) => ({
      ...previous,
      pluginLibraryEntrySnapshot: entrySnapshot,
      pluginLibraryFocusAnchor: null,
      pluginLibraryReturnToPreviousHistoryEntry: true,
    });
    if (showManagement) {
      void navigate({
        to: "/skills/manage/plugins/$pluginId",
        params: { pluginId: next.plugin.id },
        state,
      });
      return;
    }
    void navigate({
      to: "/skills/plugins/$pluginId",
      params: { pluginId: next.plugin.id },
      state,
    });
  };

  useEffect(() => {
    if (hydratedPathRef.current === pathname) return;
    hydratedPathRef.current = pathname;
    if (routeEntrySnapshot?.sourcePath === pathname) {
      if (isSupportedProviderKind(routeEntrySnapshot.initialHostId)) {
        setSelectedProvider(routeEntrySnapshot.initialHostId);
      }
      setSelectedTab(routeEntrySnapshot.initialTab);
      setActiveBucket(routeEntrySnapshot.activeBucket);
      setSelectedSectionId(routeEntrySnapshot.selectedSectionId);
      setPluginSearch(routeEntrySnapshot.search.plugins);
      setMcpSearch(routeEntrySnapshot.search.mcp);
      setSkillSearch(routeEntrySnapshot.search.skills);
    }
    if (showManagement && routePluginId === null && routeManageSnapshot) {
      setManageViewState(routeManageSnapshot);
    }
  }, [pathname, routeEntrySnapshot, routeManageSnapshot, routePluginId, showManagement]);

  useEffect(() => {
    const entrySnapshot = routeEntrySnapshot?.sourcePath === pathname ? routeEntrySnapshot : null;
    const scrollContainer =
      routePluginId !== null
        ? detailScrollRef.current
        : showManagement
          ? manageScrollRef.current
          : browseScrollRef.current;
    const scrollTop =
      showManagement && routePluginId === null
        ? (routeManageSnapshot?.scrollTop ?? 0)
        : (entrySnapshot?.scrollTop ?? 0);
    if (!scrollContainer || scrollTop === 0) return;
    let cancelled = false;
    let frame = 0;
    let attempts = 0;
    const cancelForUserInput = () => {
      cancelled = true;
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
    const restoreWhenScrollable = () => {
      if (cancelled) return;
      attempts += 1;
      const maximumScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      );
      if (maximumScrollTop > 0) {
        scrollContainer.scrollTop = Math.min(scrollTop, maximumScrollTop);
        if (scrollContainer.scrollTop === scrollTop) return;
      }
      if (attempts < 4) frame = window.requestAnimationFrame(restoreWhenScrollable);
    };
    scrollContainer.addEventListener("wheel", cancelForUserInput, { passive: true });
    scrollContainer.addEventListener("touchstart", cancelForUserInput, { passive: true });
    scrollContainer.addEventListener("pointerdown", cancelForUserInput, { passive: true });
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(restoreWhenScrollable);
    });
    return () => {
      cancelled = true;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      scrollContainer.removeEventListener("wheel", cancelForUserInput);
      scrollContainer.removeEventListener("touchstart", cancelForUserInput);
      scrollContainer.removeEventListener("pointerdown", cancelForUserInput);
    };
  }, [
    detailOpen,
    pathname,
    pluginEntries.length,
    routeEntrySnapshot,
    routeManageSnapshot,
    routePluginId,
    showManagement,
  ]);

  useEffect(() => {
    if (routePluginId === null) {
      if (detail?.kind === "plugin") {
        setDetail(null);
        setDetailOpen(false);
      }
      return;
    }
    const entry = routePluginEntry;
    if (!entry) return;
    setDetail((current) => {
      if (
        current?.kind === "plugin" &&
        current.plugin.id === entry.plugin.id &&
        current.plugin === entry.plugin
      ) {
        return current;
      }
      return {
        kind: "plugin",
        plugin: entry.plugin,
        marketplaceName: entry.marketplaceName,
        marketplacePath: entry.marketplacePath,
        remoteMarketplaceName: entry.remoteMarketplaceName,
      };
    });
    setDetailOpen(true);
  }, [detail?.kind, routePluginEntry, routePluginId]);

  useEffect(() => {
    restoredFocusAnchorRef.current = null;
  }, [pathname]);

  useEffect(() => {
    if (routeFocusAnchor === null) return;
    const identity = pluginLibraryFocusAnchorIdentity(routeFocusAnchor);
    if (restoredFocusAnchorRef.current === identity) return;
    const frame = window.requestAnimationFrame(() => {
      if (restorePluginLibraryFocusAnchor(routeFocusAnchor)) {
        restoredFocusAnchorRef.current = identity;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailOpen, pluginEntries.length, routeFocusAnchor, routePluginId]);

  useEffect(() => {
    if (!showSettingsManagement && routePluginId === null) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        // An open dialog or menu owns Escape; a toast (a non-modal dialog) does not.
        document.querySelector(
          '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      if (routePluginId !== null) {
        returnFromPluginDetail();
      } else {
        exitPluginSettingsManagement();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [exitPluginSettingsManagement, returnFromPluginDetail, routePluginId, showSettingsManagement]);

  const resourceActions = usePluginResourceActions({
    activeProjectId: activeProject?.id ?? null,
    provider: selectedProvider,
    instanceId: selectedProviderInstanceId,
    cwd: discoveryCwd,
  });

  const loadSkillContent = useCallback(
    async (skill: ProviderSkillDescriptor) => {
      if (!discoveryCwd) throw new Error("No workspace available for skill discovery");
      return ensureNativeApi().provider.readSkill({
        provider: selectedProvider,
        ...(selectedProviderInstanceId ? { instanceId: selectedProviderInstanceId } : {}),
        cwd: discoveryCwd,
        name: skill.name,
        path: skill.path,
      });
    },
    [discoveryCwd, selectedProvider, selectedProviderInstanceId],
  );

  // Codex gates "Create skill"/"Create plugin" on a `skill-creator`/`plugin-creator`
  // skill being present, then opens a thread with it attached (canCreate* = path != null).
  const skillCreatorSkill = useMemo(
    () =>
      discoveredSkills.find(
        (skill) => skill.enabled && skill.name === CREATOR_META.skill.skillName,
      ) ?? null,
    [discoveredSkills],
  );
  const pluginCreatorSkill = useMemo(
    () =>
      discoveredSkills.find(
        (skill) => skill.enabled && skill.name === CREATOR_META.plugin.skillName,
      ) ??
      discoveredSkills.find(
        (skill) => skill.enabled && skill.name === "moss-plugin-creator:plugin-creator",
      ) ??
      null,
    [discoveredSkills],
  );

  const openImport = (kind: "plugin" | "skill" | "mcp") => {
    setImportKind(kind);
    setImportPluginsAndSkillsOpen(true);
  };
  const headerLabels = {
    browseAria: t("plugins.browseAria"),
    plugins: t("plugins.tabs.plugins"),
    skills: t("plugins.tabs.skills"),
    manage: t("plugins.action.manage"),
    refresh: t("plugins.action.refresh"),
    create: t("plugins.action.add"),
    createPlugin: t("plugins.action.createPlugin"),
    importPluginsAndSkills: t("plugins.action.importPluginsAndSkills"),
    uploadPluginArchive: t("plugins.action.uploadPluginArchive"),
    addCustomMcpServer: t("plugins.action.addCustomMcpServer"),
    addMcpServer: t("plugins.action.addMcpServer"),
    createSkill: t("plugins.action.createSkill"),
    recordSkill: t("plugins.action.recordSkill"),
    addMarketplace: t("plugins.action.addMarketplace"),
    requestPlugin: t("plugins.action.requestPlugin"),
  };

  const handleCreate = (kind: CreatorKind) => {
    const creator = kind === "skill" ? skillCreatorSkill : pluginCreatorSkill;
    if (!creator) return;
    void resourceActions
      .createViaCreator(
        kind,
        { name: creator.name, path: creator.path },
        kind === "plugin" ? { prompt: t("plugins.create.creatorPrompt") } : undefined,
      )
      .then((started) => {
        if (!started) {
          toastManager.add({
            type: "error",
            title: t("plugins.toast.noWorkspaceTitle"),
            description: t("plugins.toast.noWorkspaceDescription"),
          });
        }
      });
  };
  const headerCreateCallbacks = {
    onCreatePlugin: pluginCreatorSkill ? () => handleCreate("plugin") : undefined,
    onAddMarketplace: () => setAddMarketplaceOpen(true),
    onUploadPluginArchive: () => openImport("plugin"),
    onAddCustomMcpServer: () => openImport("mcp"),
    onCreateSkill: skillCreatorSkill ? () => handleCreate("skill") : undefined,
  };

  const handleTryInChat = (resource: ResourceDetail, promptOverride?: string) => {
    const prompt =
      promptOverride ??
      (resource.kind === "plugin" && isMossAppPlugin(resource.plugin)
        ? format("apps.tryPrompt", { name: resourceActions.resourceName(resource) })
        : undefined);
    void resourceActions.tryInChat(resource, prompt).then((started) => {
      if (!started) {
        toastManager.add({
          type: "error",
          title: t("plugins.toast.noWorkspaceTitle"),
          description: t("plugins.toast.noWorkspaceDescription"),
        });
      }
    });
  };

  const showPluginInstallSuccess = (
    resource: Extract<ResourceDetail, { kind: "plugin" }>,
    resourceName: string,
  ) => {
    toastManager.add({
      type: "success",
      title: format("plugins.install.success", { pluginName: resourceName }),
      actionProps: {
        children: t("plugins.install.tryInChatToast"),
        onClick: () => handleTryInChat(resource),
      },
    });
  };

  const openRequiredAppConnection = (app: PluginRequiredApp) => {
    if (connectTarget !== null || connectingAuthAppId !== null || app.status !== "pending") return;
    setPluginAuthSetup((current) =>
      current
        ? {
            ...current,
            apps: current.apps.map((candidate) =>
              candidate.id === app.id ? { ...candidate, status: "launching" as const } : candidate,
            ),
          }
        : null,
    );
    setConnectingAuthAppId(app.id);
    setConnectTarget(app);
  };

  const openMossAppConnect = (plugin: ProviderPluginDescriptor) => {
    const slug = mossAppSlugFromPluginId(plugin.id);
    if (!slug) return;
    setMossAppConnectTarget({
      slug,
      name: plugin.interface?.displayName ?? plugin.name,
      logoUrl: plugin.interface?.logoUrl ?? null,
      signIn: mossAppToolkits.find((toolkit) => toolkit.slug === slug)?.signIn ?? "managed",
    });
  };

  /** Uninstalling an app plugin disconnects its account; nothing is removed from a CLI. */
  const disconnectMossApp = async (
    plugin: ProviderPluginDescriptor,
  ): Promise<{ readonly removed: boolean }> => {
    const slug = mossAppSlugFromPluginId(plugin.id);
    const connection = slug ? activeMossAppConnection(mossAppConnections, slug) : null;
    if (!connection) return { removed: false };
    const result = await ensureNativeApi().server.disconnectMossApp({
      connectionId: connection.connectionId,
    });
    await queryClient.invalidateQueries({ queryKey: MOSS_APP_CONNECTIONS_QUERY_KEY });
    return { removed: result.disconnected };
  };

  const handleInstallPlugin = (resource: ResourceDetail) => {
    if (resource.kind !== "plugin") return;
    if (isMossAppPlugin(resource.plugin)) {
      openMossAppConnect(resource.plugin);
      return;
    }
    setRetainedPluginAuthSession(null);
    if (!discoveryCwd) {
      toastManager.add({
        type: "error",
        title: t("plugins.toast.noWorkspaceTitle"),
        description: t("plugins.toast.noWorkspaceInstallDescription"),
      });
      return;
    }
    const key = pluginResourceKey(resource);
    if (installingPluginKeysRef.current.has(key)) return;
    installingPluginKeysRef.current.add(key);
    setInstallingPluginKeys(new Set(installingPluginKeysRef.current));
    void runPluginMutationWithAuthoritativeRead({
      mutate: () => resourceActions.installPlugin(resource),
      reRead: reReadPlugins,
      isSettled: (snapshot, result) =>
        result !== null && isPluginInstallSettled(snapshot, resource.plugin.id),
      failureMessage: t("plugins.toast.installNotSettled"),
    })
      .then(async (result) => {
        if (!result) {
          toastManager.add({
            type: "error",
            title: t("plugins.toast.noWorkspaceTitle"),
            description: t("plugins.toast.noWorkspaceInstallDescription"),
          });
          return;
        }
        const resourceName = resourceActions.resourceName(resource);
        if (result.authPolicy === "ON_INSTALL" && result.appsNeedingAuth.length > 0) {
          let authoritativeApps: readonly ProviderAppInfo[] = [];
          try {
            authoritativeApps = await reReadApps();
          } catch {
            toastManager.add({
              type: "warning",
              title: t("plugins.toast.appRefreshAfterInstallFailedTitle"),
              description: t("plugins.toast.appRefreshAfterInstallFailedDescription"),
            });
          }
          const requiredApps = enrichRequiredPluginApps(result.appsNeedingAuth, authoritativeApps);
          const resolution = resolvePluginAuthOnboarding(result.authPolicy, requiredApps);
          if (resolution.kind === "single") {
            const launchingApps = requiredApps.map((app) =>
              app.id === resolution.app.id
                ? Object.assign({}, app, { status: "launching" as const })
                : app,
            );
            setPluginAuthSetup(
              createPluginAuthSetup({ resource, apps: launchingApps, mode: "single" }),
            );
            setConnectingAuthAppId(resolution.app.id);
            setConnectTarget(resolution.app);
            return;
          }
          if (resolution.kind === "multiple") {
            setPluginAuthSetup(
              createPluginAuthSetup({ resource, apps: resolution.apps, mode: "multiple" }),
            );
            return;
          }
        }
        showPluginInstallSuccess(resource, resourceName);
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("plugins.toast.installFailedTitle"),
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        installingPluginKeysRef.current.delete(key);
        setInstallingPluginKeys(new Set(installingPluginKeysRef.current));
      });
  };

  const updatePluginEnabled = (entry: ManagedPlugin, enabled: boolean): Promise<boolean> => {
    if (isMossAppPlugin(entry.plugin)) {
      if (enabled) openMossAppConnect(entry.plugin);
      else setConfirmUninstall({ kind: "plugin", ...entry });
      return Promise.resolve(false);
    }
    if (!discoveryCwd) {
      toastManager.add({ type: "error", title: t("plugins.toast.pluginUpdateUnavailable") });
      return Promise.resolve(false);
    }
    const key = entry.plugin.id;
    if (updatingPluginKeysRef.current.has(key)) return Promise.resolve(false);
    updatingPluginKeysRef.current.add(key);
    return runPluginMutationWithAuthoritativeRead({
      mutate: () =>
        resourceActions.setResourceEnabled({ kind: "plugin", plugin: entry.plugin }, enabled),
      reRead: reReadPlugins,
      isSettled: (snapshot, result) =>
        result?.updated === true && isPluginEnabledSettled(snapshot, entry.plugin.id, enabled),
      failureMessage: t("plugins.toast.pluginUpdateNotSettled"),
    })
      .then((result) => {
        if (!result?.updated) {
          toastManager.add({ type: "error", title: t("plugins.toast.pluginUpdateUnavailable") });
          return false;
        }
        const name = entry.plugin.interface?.displayName ?? entry.plugin.name;
        toastManager.add({
          type: "success",
          title: format(enabled ? "plugins.toast.enabled" : "plugins.toast.disabled", { name }),
        });
        return true;
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("plugins.toast.pluginUpdateFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        updatingPluginKeysRef.current.delete(key);
      });
  };

  const handleTogglePlugin = (entry: ManagedPlugin, enabled: boolean) => {
    void updatePluginEnabled(entry, enabled);
  };

  const updateMcpEnabled = (
    server: ProviderMcpServerDescriptor,
    enabled: boolean,
  ): Promise<boolean> =>
    resourceActions
      .setResourceEnabled({ kind: "mcp", server }, enabled)
      .then((result) => {
        if (!result?.updated) {
          toastManager.add({ type: "error", title: t("plugins.toast.mcpUpdateUnavailable") });
          return false;
        }
        toastManager.add({
          type: "success",
          title: format(enabled ? "plugins.toast.enabled" : "plugins.toast.disabled", {
            name: server.name,
          }),
        });
        void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
        return true;
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("plugins.toast.mcpUpdateFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      });

  const handleToggleMcp = (server: ProviderMcpServerDescriptor, enabled: boolean) => {
    void updateMcpEnabled(server, enabled);
  };

  const handleCopyPath = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toastManager.add({ type: "success", title: format("plugins.toast.copied", { label }) }),
      () => toastManager.add({ type: "error", title: t("plugins.toast.copyFailed") }),
    );
  };

  const handleUninstallConfirmed = () => {
    const resource = confirmUninstall;
    if (!resource || uninstallingRef.current) return;
    uninstallingRef.current = true;
    setUninstalling(true);
    const mossApp = resource.kind === "plugin" && isMossAppPlugin(resource.plugin);
    const mutation =
      resource.kind === "plugin" && mossApp
        ? disconnectMossApp(resource.plugin)
        : resource.kind === "plugin"
          ? runPluginMutationWithAuthoritativeRead({
              mutate: () => resourceActions.uninstall(resource),
              reRead: reReadPlugins,
              isSettled: (snapshot, result) =>
                result?.removed === true && isPluginUninstallSettled(snapshot, resource.plugin.id),
              failureMessage: t("plugins.toast.uninstallNotSettled"),
            })
          : resourceActions.uninstall(resource);
    void mutation
      .then((result) => {
        if (result?.removed) {
          toastManager.add({
            type: "success",
            title: format(mossApp ? "apps.toast.disconnected" : "plugins.toast.uninstalled", {
              name: resourceActions.resourceName(resource),
            }),
          });
          setConfirmUninstall(null);
          setDetailOpen(false);
          if (resource.kind === "plugin") {
            setDetail(null);
            returnFromPluginDetail();
          }
        } else {
          toastManager.add({ type: "error", title: t("plugins.toast.nothingToUninstall") });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("plugins.toast.uninstallFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        uninstallingRef.current = false;
        setUninstalling(false);
      });
  };

  const canTryResource = (resource: ResourceDetail): boolean => {
    if (resource.kind === "plugin") {
      return isPluginInstalledForDirectory(resource.plugin) && resource.plugin.enabled;
    }
    if (resource.kind === "skill") {
      return resource.skill.enabled;
    }
    return resource.server.enabled;
  };

  const canToggleDetailResource = (resource: ResourceDetail): boolean => {
    if (resource.kind === "skill") return true;
    if (resource.kind === "plugin") return canTogglePluginResource(resource.plugin);
    return canToggleMcpResource(resource.server);
  };

  const handleToggleDetailEnabled = (resource: ResourceDetail, enabled: boolean) => {
    if (resource.kind === "skill") {
      setSkillEnabled(resource.skill.name, enabled);
      setDetailOpen(false);
      return;
    }
    if (resource.kind === "plugin") {
      void updatePluginEnabled(
        {
          plugin: resource.plugin,
          marketplaceName: resource.marketplaceName,
          marketplacePath: resource.marketplacePath,
          remoteMarketplaceName: resource.remoteMarketplaceName,
        },
        enabled,
      ).then((updated) => {
        if (!updated) return;
        setDetail((current) =>
          current?.kind === "plugin" && current.plugin.name === resource.plugin.name
            ? { ...current, plugin: { ...current.plugin, enabled } }
            : current,
        );
      });
      return;
    }
    void updateMcpEnabled(resource.server, enabled).then((updated) => {
      if (!updated) return;
      setDetail((current) =>
        current?.kind === "mcp" && current.server.name === resource.server.name
          ? { ...current, server: { ...current.server, enabled } }
          : current,
      );
    });
  };

  // Codex card overflow items: Try it now / Copy path / Uninstall (Moss-canonical
  // only). Non-canonical skills instead offer Disable via the detail toggle.
  const buildCardMenuItems = (resource: ResourceDetail, path: string): CardMenuItem[] => {
    const items: CardMenuItem[] = [];
    if (canTryResource(resource)) {
      items.push({
        key: "try",
        label: t("plugins.action.tryItNow"),
        icon: <MessageCircleIcon className="size-4" />,
        onSelect: () => handleTryInChat(resource),
      });
    }
    items.push({
      key: "copy",
      label: t("plugins.action.copyPath"),
      icon: <CopyIcon className="size-4" />,
      onSelect: () => handleCopyPath(t("plugins.detail.label.path"), path),
    });
    if (canUninstallResource(resource)) {
      items.push({
        key: "uninstall",
        label: t("plugins.action.uninstall"),
        icon: <Trash2 className="size-4" />,
        danger: true,
        onSelect: () => setConfirmUninstall(resource),
      });
    }
    return items;
  };

  const handleRefreshSkills = () => {
    void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
  };

  const refetchPlugins = () => {
    void reReadPlugins();
  };

  const handleLibraryRefresh = useCallback(() => {
    if (showManagement || selectedTab === "plugins") {
      refetchPlugins();
      return;
    }
    if (selectedTab === "mcp") {
      void mcpQuery.refetch();
      return;
    }
    handleRefreshSkills();
  }, [handleRefreshSkills, mcpQuery, refetchPlugins, selectedTab, showManagement]);

  const handleAddMarketplace = async (
    params: PluginMarketplaceAddParams,
  ): Promise<ProviderAddMarketplaceResult> => {
    const input: ProviderAddMarketplaceInput = {
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      ...(discoveryCwd ? { cwd: discoveryCwd } : {}),
      ...(providerThreadId ? { threadId: providerThreadId } : {}),
      source: params.source,
      refName: params.refName,
      sparsePaths: params.sparsePaths ? [...params.sparsePaths] : null,
    };
    const result = await runPluginMutationWithAuthoritativeRead({
      mutate: () => ensureNativeApi().provider.addMarketplace(input),
      reRead: reReadPlugins,
      isSettled: (snapshot, nativeResult) =>
        isMarketplaceAddSettled(snapshot, nativeResult.marketplaceName, nativeResult.installedRoot),
      failureMessage: t("plugins.marketplace.notSettled"),
    });
    toastManager.add({
      type: "success",
      title: result.alreadyAdded
        ? format("plugins.marketplace.alreadyAdded", { name: result.marketplaceName })
        : format("plugins.marketplace.added", { name: result.marketplaceName }),
    });
    return result;
  };

  const handleSetAppEnabled = (app: ProviderAppInfo, enabled: boolean) => {
    if (updatingAppId !== null) return;
    setUpdatingAppId(app.id);
    void runPluginMutationWithAuthoritativeRead({
      mutate: () =>
        ensureNativeApi().provider.setAppEnabled({
          provider: selectedProvider,
          instanceId: selectedProviderInstanceId,
          ...(discoveryCwd ? { cwd: discoveryCwd } : {}),
          ...(providerThreadId ? { threadId: providerThreadId } : {}),
          appId: app.id,
          enabled,
        }),
      reRead: reReadApps,
      isSettled: (apps) =>
        apps.some(
          (candidate) =>
            candidate.id === app.id && candidate.isAccessible && candidate.isEnabled === enabled,
        ),
      failureMessage: `${app.name} app state did not settle.`,
    })
      .then(() => {
        toastManager.add({
          type: "success",
          title: `${app.name} app ${enabled ? "enabled" : "disabled"}`,
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to update app",
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setUpdatingAppId(null));
  };

  const handleRemoveMarketplace = (marketplace: ManagedMarketplace) => {
    if (pendingRemoveMarketplaceName !== null) return;
    setPendingRemoveMarketplaceName(marketplace.name);
    void runPluginMutationWithAuthoritativeRead({
      mutate: () =>
        ensureNativeApi().provider.removeMarketplace({
          provider: selectedProvider,
          instanceId: selectedProviderInstanceId,
          ...(discoveryCwd ? { cwd: discoveryCwd } : {}),
          ...(providerThreadId ? { threadId: providerThreadId } : {}),
          marketplaceName: marketplace.name,
        }),
      reRead: reReadPlugins,
      isSettled: (snapshot, result) =>
        result.marketplaceName === marketplace.name &&
        snapshot.successfulReads > 0 &&
        snapshot.marketplaces.every((candidate) => candidate.name !== marketplace.name),
      failureMessage: `${marketplace.displayName} marketplace removal did not settle.`,
    })
      .then(() => {
        toastManager.add({
          type: "success",
          title: `Removed ${marketplace.displayName}`,
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: `Could not remove ${marketplace.displayName}`,
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setPendingRemoveMarketplaceName(null));
  };

  const handleUpgradeMarketplace = (marketplace: ManagedMarketplace) => {
    if (pendingUpgradeMarketplaceName !== null || upgradingAllMarketplaces) return;
    setPendingUpgradeMarketplaceName(marketplace.name);
    void runPluginMutationWithAuthoritativeRead({
      mutate: () =>
        ensureNativeApi().provider.upgradeMarketplace({
          provider: selectedProvider,
          instanceId: selectedProviderInstanceId,
          ...(discoveryCwd ? { cwd: discoveryCwd } : {}),
          ...(providerThreadId ? { threadId: providerThreadId } : {}),
          marketplaceName: marketplace.name,
        }),
      reRead: reReadPlugins,
      isSettled: (snapshot, result) =>
        snapshot.successfulReads > 0 &&
        result.selectedMarketplaces.includes(marketplace.name) &&
        !result.errors.some((error) => error.marketplaceName === marketplace.name) &&
        snapshot.marketplaces.some((candidate) => candidate.name === marketplace.name),
      failureMessage: `${marketplace.displayName} marketplace upgrade did not settle.`,
    })
      .then(() => {
        toastManager.add({ type: "success", title: `Upgraded ${marketplace.displayName}` });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: `Could not upgrade ${marketplace.displayName}`,
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setPendingUpgradeMarketplaceName(null));
  };

  const handleUpgradeAllMarketplaces = () => {
    if (upgradingAllMarketplaces || pendingUpgradeMarketplaceName !== null) return;
    setUpgradingAllMarketplaces(true);
    void runPluginMutationWithAuthoritativeRead({
      mutate: () =>
        ensureNativeApi().provider.upgradeMarketplace({
          provider: selectedProvider,
          instanceId: selectedProviderInstanceId,
          ...(discoveryCwd ? { cwd: discoveryCwd } : {}),
          ...(providerThreadId ? { threadId: providerThreadId } : {}),
          marketplaceName: null,
        }),
      reRead: reReadPlugins,
      isSettled: (snapshot, result) =>
        snapshot.successfulReads > 0 &&
        result.errors.length === 0 &&
        result.selectedMarketplaces.every((name) =>
          snapshot.marketplaces.some((candidate) => candidate.name === name),
        ),
      failureMessage: "Marketplace upgrades did not settle.",
    })
      .then(() => toastManager.add({ type: "success", title: "Marketplaces upgraded" }))
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not upgrade marketplaces",
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setUpgradingAllMarketplaces(false));
  };

  const setSkillEnabled = (skillName: string, enabled: boolean) => {
    const latestSettings = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    const currentDisabled = latestSettings?.skills.disabled ?? [...disabledSkillNames];
    const key = settingsSkillNameKey(skillName);
    const next = new Set(currentDisabled.map((name) => settingsSkillNameKey(name)));
    if (enabled) next.delete(key);
    else next.add(key);
    const disabled = [...next].toSorted();
    if (latestSettings) {
      queryClient.setQueryData(serverQueryKeys.settings(), {
        ...latestSettings,
        skills: { disabled },
      });
    }
    void ensureNativeApi()
      .server.updateSettings({ skills: { disabled } })
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  };

  const searchValue =
    selectedTab === "plugins" ? pluginSearch : selectedTab === "mcp" ? mcpSearch : skillSearch;
  const onSearchChange = (value: string) => {
    if (selectedTab === "plugins") setPluginSearch(value);
    else if (selectedTab === "mcp") setMcpSearch(value);
    else setSkillSearch(value);
  };
  const searchResultIds =
    selectedTab === "plugins"
      ? pluginSearchResults.map((result) => result.id)
      : selectedTab === "mcp"
        ? mcpSearchResults.map((result) => result.id)
        : skillSearchResults.map((result) => result.id);
  const activateSearchResult = (id: string) => {
    if (selectedTab === "plugins") {
      const result = pluginSearchResults.find((candidate) => candidate.id === id);
      if (result) {
        openDetail({
          kind: "plugin",
          plugin: result.entry.plugin,
          marketplaceName: result.entry.marketplaceName,
          marketplacePath: result.entry.marketplacePath,
          remoteMarketplaceName: result.entry.remoteMarketplaceName,
        });
      }
      return;
    }
    if (selectedTab === "mcp") {
      const result = mcpSearchResults.find((candidate) => candidate.id === id);
      if (result) openDetail({ kind: "mcp", server: result.server });
      return;
    }
    const result = skillSearchResults.find((candidate) => candidate.id === id);
    if (result) openDetail({ kind: "skill", skill: result.skill });
  };

  useEffect(() => {
    if (activeSearchResultId === null) return;
    document.getElementById(activeSearchResultId)?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultId]);

  // The Customize rail lists installed plugins on both the Plugins and Skills
  // pages, as Codex's sidebar does; only the MCP view lists its servers.
  const installedItems =
    selectedTab !== "mcp"
      ? installedPluginEntries.map((entry) => {
          const label = entry.plugin.interface?.displayName ?? entry.plugin.name;
          return {
            key: pluginEntryKey(entry),
            label,
            glyph: (
              <PluginGlyph plugin={entry.plugin} installed artworkCwd={discoveryCwd ?? undefined} />
            ),
            onOpen: (trigger: HTMLButtonElement) =>
              openDetail(
                {
                  kind: "plugin",
                  plugin: entry.plugin,
                  marketplaceName: entry.marketplaceName,
                  marketplacePath: entry.marketplacePath,
                  remoteMarketplaceName: entry.remoteMarketplaceName,
                },
                trigger,
              ),
          };
        })
      : mcpServers.map((server) => ({
          key: server.name,
          label: server.name,
          glyph: <McpGlyph server={server} />,
          onOpen: () => openDetail({ kind: "mcp", server }),
        }));
  const installedRowsSignature = `${selectedTab}\u0002${installedItems
    .map((item) => `${item.key}\u0000${item.label}`)
    .join("\u0001")}`;
  const reportedInstalledRowsSignatureRef = useRef<string | null>(null);
  // A plugin page or manage view below the Customize shell reports to its rail too.
  const shellInstalledRowsChange = useContext(MossCustomizeInstalledRowsContext);
  const reportInstalledRows = onInstalledRowsChange ?? shellInstalledRowsChange;
  useEffect(() => {
    if (
      !reportInstalledRows ||
      reportedInstalledRowsSignatureRef.current === installedRowsSignature
    ) {
      return;
    }
    reportedInstalledRowsSignatureRef.current = installedRowsSignature;
    reportInstalledRows(
      installedItems.map((item) => ({
        id: item.key,
        name: item.label,
        glyph: item.glyph,
        onOpen: item.onOpen,
      })),
    );
  }, [installedItems, installedRowsSignature, reportInstalledRows]);
  const pluginAuthRawLogo = pluginAuthSetup
    ? resolvePluginLogo(pluginAuthSetup.resource.plugin)
    : undefined;
  const pluginAuthLogoUrl = pluginAuthRawLogo
    ? resolvePluginArtworkUrl({
        src: pluginAuthRawLogo,
        cwd: discoveryCwd ?? undefined,
      })
    : null;

  // ── Render ───────────────────────────────────────────────────────────────

  // Settings › Plugins is a settings page: the settings frame, not the library's surface.
  const PageSurface = showSettingsManagement ? SettingsPageFrame : RouteInsetSurface;
  return (
    <PageSurface>
      <div className="flex h-full flex-col">
        {detailOpen && detail?.kind === "plugin" ? (
          <PluginResourceDetailPage
            detail={detail}
            scrollContainerRef={detailScrollRef}
            onBack={() => {
              setDetailOpen(false);
              setDetail(null);
              returnFromPluginDetail();
            }}
            canToggle={canToggleDetailResource(detail)}
            onToggleEnabled={(enabled) => {
              handleToggleDetailEnabled(detail, enabled);
            }}
            onTryInChat={
              canTryResource(detail) ? (prompt) => handleTryInChat(detail, prompt) : undefined
            }
            onInstall={
              canInstallPluginResource(detail) ? () => handleInstallPlugin(detail) : undefined
            }
            onUninstall={
              canUninstallResource(detail) ? () => setConfirmUninstall(detail) : undefined
            }
            onManage={() => {
              setDetailOpen(false);
              setDetail(null);
              openSettingsManagement({ kind: "key", value: "detail:more-actions" });
            }}
            pluginDetail={activePluginDetail}
            pluginDetailLoading={activePluginDetailLoading}
            artworkCwd={discoveryCwd ?? undefined}
            loadSkillContent={loadSkillContent}
          />
        ) : (
          <>
            {/* ── Top nav ───────────────────────────────────────────────────── */}
            {embedded || showSettingsManagement ? null : (
              <div
                className={cn(
                  "drag-region flex h-[46px] shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6",
                  desktopTopBarTrafficLightGutterClassName,
                  desktopTopBarWindowControlsGutterClassName,
                )}
              >
                <PluginLibraryHeader
                  mode={showManagement ? "manage" : "browse"}
                  leading={
                    <>
                      <SidebarHeaderNavigationControls />
                      {selectedPluginSection && !showManagement ? (
                        <PluginLibraryBreadcrumb
                          rootLabel={t("plugins.tabs.plugins")}
                          title={pluginSectionLabel(selectedPluginSection, t)}
                          onBack={() => setSelectedSectionId(null)}
                        />
                      ) : null}
                    </>
                  }
                  selectedTab={
                    (selectedTab === "skills"
                      ? "skills"
                      : "plugins") satisfies PluginLibraryBrowseTab
                  }
                  labels={headerLabels}
                  hideBrowseTabs={hideBrowseTabs}
                  refreshing={pluginsFetching || mcpQuery.isFetching || skillsQuery.isFetching}
                  onTabChange={(tab) => {
                    setSelectedTab(tab);
                    onBrowseTabChange?.(tab);
                    if (showManagement) void navigate({ to: "/skills" });
                  }}
                  onManage={() => {
                    openSettingsManagement();
                  }}
                  onExitManage={() => {
                    exitPluginSettingsManagement();
                  }}
                  onRefresh={handleLibraryRefresh}
                  createTriggerRef={importTriggerRef}
                  {...headerCreateCallbacks}
                  hideActions
                />
              </div>
            )}

            {/* ── Scrollable body ───────────────────────────────────────────── */}
            {routePluginId !== null ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <div className="mx-auto w-full max-w-3xl">
                  {routePluginViewState === "loading" || routePluginViewState === "detail" ? (
                    <RowSkeletons count={6} label={t("plugins.loading.plugins")} />
                  ) : routePluginViewState === "error" ? (
                    <QueryErrorPanel
                      title={t("plugins.manage.loadFailed")}
                      error={pluginsError}
                      retrying={pluginsFetching}
                      onRetry={refetchPlugins}
                    />
                  ) : (
                    <div data-testid="plugin-library-route-not-found">
                      <EmptyPanel
                        title={t("plugins.empty.pluginNotFoundTitle")}
                        description={t("plugins.empty.pluginNotFoundDescription")}
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : showManagement ? (
              <div
                ref={manageScrollRef}
                data-testid="plugin-manage-scroll-container"
                className="min-h-0 flex-1 overflow-y-auto"
                onScroll={(event) => {
                  const nextManageSnapshot = {
                    ...manageViewState,
                    scrollTop: event.currentTarget.scrollTop,
                  };
                  setManageViewState(nextManageSnapshot);
                  replaceCurrentPluginLibraryHistoryState({
                    manageSnapshot: nextManageSnapshot,
                    focusAnchor: nextManageSnapshot.focusAnchor,
                  });
                }}
              >
                {pluginRemoteSyncErrors.length > 0 ? (
                  <div className="mx-auto w-full max-w-3xl px-5 pt-5">
                    <InlineWarning title={pluginRemoteSyncDetails}>
                      {[...new Set(pluginRemoteSyncErrors)].join(" • ")}
                    </InlineWarning>
                  </div>
                ) : null}
                <PluginManagementPanel
                  settingsPage={showSettingsManagement}
                  viewState={manageViewState}
                  onViewStateChange={handleManageViewStateChange}
                  artworkCwd={discoveryCwd ?? undefined}
                  headerActions={
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8 rounded-lg px-3 text-ui-lg sm:h-8"
                        data-testid="plugin-manage-browse-catalog"
                        onClick={exitPluginSettingsManagement}
                      >
                        {t("plugins.manage.browseCatalog")}
                      </Button>
                      <PluginLibraryAddMenu
                        mode="manage"
                        selectedTab="plugins"
                        labels={headerLabels}
                        triggerRef={importTriggerRef}
                        {...headerCreateCallbacks}
                      />
                    </>
                  }
                  onOpenSkill={(skill) => openDetail({ kind: "skill", skill })}
                  mossApps={connectedMossApps}
                  onOpenMossApp={(slug) => {
                    const resource = mossAppResource(slug);
                    if (resource) openDetail(resource);
                  }}
                  onDisconnectMossApp={(slug) => {
                    const resource = mossAppResource(slug);
                    if (resource) setConfirmUninstall(resource);
                  }}
                  plugins={installedPluginEntries.map<ManagedPlugin>((entry) => ({
                    plugin: entry.plugin,
                    marketplaceName: entry.marketplaceName,
                    marketplacePath: entry.marketplacePath,
                    remoteMarketplaceName: entry.remoteMarketplaceName,
                  }))}
                  apps={managedApps}
                  appsLoading={appsQuery.isLoading}
                  appsError={appsQuery.error}
                  appsRetrying={appsQuery.isFetching}
                  updatingAppId={updatingAppId}
                  onRetryApps={() => {
                    void reReadApps();
                  }}
                  onSetAppEnabled={handleSetAppEnabled}
                  onOpenAppUrl={openAppExternalUrl}
                  onOpenAppTools={(app) => setSelectedAppId(app.id)}
                  marketplaces={managedMarketplacesList}
                  marketplaceLoadErrors={pluginMarketplaceLoadErrors}
                  marketplacesLoading={pluginsLoading}
                  marketplacesError={pluginsError}
                  marketplacesRetrying={pluginsFetching}
                  pendingRemoveMarketplaceName={pendingRemoveMarketplaceName}
                  pendingUpgradeMarketplaceName={pendingUpgradeMarketplaceName}
                  upgradingAllMarketplaces={upgradingAllMarketplaces}
                  onRetryMarketplaces={refetchPlugins}
                  onRemoveMarketplace={handleRemoveMarketplace}
                  onUpgradeMarketplace={handleUpgradeMarketplace}
                  onUpgradeAllMarketplaces={handleUpgradeAllMarketplaces}
                  onCopyMarketplacePath={(path) =>
                    handleCopyPath(t("plugins.detail.label.path"), path)
                  }
                  mcpServers={mcpServers}
                  skills={manageableSkills}
                  disabledSkillNames={disabledSkillNames}
                  onTogglePlugin={handleTogglePlugin}
                  onToggleMcp={handleToggleMcp}
                  onToggleSkill={setSkillEnabled}
                  onOpenPlugin={(entry, trigger) =>
                    openDetail(
                      {
                        kind: "plugin",
                        plugin: entry.plugin,
                        marketplaceName: entry.marketplaceName,
                        marketplacePath: entry.marketplacePath,
                        remoteMarketplaceName: entry.remoteMarketplaceName,
                      },
                      trigger,
                    )
                  }
                />
              </div>
            ) : (
              <div
                ref={browseScrollRef}
                data-testid="plugin-library-scroll-container"
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
              >
                <div className="flex min-h-full w-full flex-col">
                  <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-6 pt-8 pb-12">
                    <div className="flex min-h-0 flex-1 flex-col gap-6">
                      <div className="flex flex-col gap-5">
                        <PluginLibraryPageHeader
                          title={
                            selectedPluginSection
                              ? pluginSectionLabel(selectedPluginSection, t)
                              : selectedTab === "plugins"
                                ? t("plugins.hero.plugins")
                                : selectedTab === "mcp"
                                  ? t("plugins.hero.mcpServers")
                                  : t("plugins.hero.skills")
                          }
                          subtitle={
                            selectedPluginSection
                              ? format(
                                  selectedPluginSection.kind === "apps"
                                    ? "plugins.section.appsCount"
                                    : "plugins.category.count",
                                  { count: selectedPluginSection.entries.length },
                                )
                              : selectedTab === "plugins"
                                ? t("plugins.subtitle.plugins")
                                : selectedTab === "mcp"
                                  ? t("plugins.subtitle.mcpServers")
                                  : t("plugins.subtitle.skills")
                          }
                          actions={
                            <PluginLibraryHeaderActions
                              mode="browse"
                              selectedTab={
                                (selectedTab === "skills"
                                  ? "skills"
                                  : "plugins") satisfies PluginLibraryBrowseTab
                              }
                              labels={headerLabels}
                              refreshing={
                                pluginsFetching || mcpQuery.isFetching || skillsQuery.isFetching
                              }
                              search={
                                <PluginLibrarySearchInput
                                  value={searchValue}
                                  onChange={onSearchChange}
                                  placeholder={
                                    selectedTab === "plugins"
                                      ? t("plugins.search.plugins")
                                      : selectedTab === "mcp"
                                        ? t("plugins.search.mcpServers")
                                        : t("plugins.search.skills")
                                  }
                                  resultIds={searchResultIds}
                                  className="w-60 min-w-0 max-sm:w-44"
                                  onActivateResult={activateSearchResult}
                                  onActiveResultChange={setActiveSearchResultId}
                                />
                              }
                              onManage={() => openSettingsManagement()}
                              onRefresh={handleLibraryRefresh}
                              createTriggerRef={importTriggerRef}
                              {...headerCreateCallbacks}
                            />
                          }
                        />

                        {/* Codex directory tabs: Public · Workspace · Personal, each
                            shown only when it has plugins. A category page drops
                            them; its breadcrumb leads back to the directory. */}
                        {selectedTab === "plugins" && !selectedPluginSection ? (
                          <PluginLibraryPillTabs
                            ariaLabel={t("plugins.directoryAria")}
                            testId="plugin-directory-tabs"
                            tabs={LIBRARY_BUCKETS.filter((bucket) =>
                              availableBuckets.has(bucket.id),
                            ).map((bucket) => ({
                              id: bucket.id,
                              label:
                                bucket.id === "moss"
                                  ? t("plugins.source.moss")
                                  : bucket.id === "workspace"
                                    ? t("plugins.source.workspace")
                                    : t("plugins.source.personal"),
                            }))}
                            selected={activeBucket}
                            onSelect={(bucket) => {
                              setActiveBucket(bucket);
                              setSelectedSectionId(null);
                            }}
                          />
                        ) : null}
                      </div>

                      {/* Warnings */}
                      {!discoveryCwd && selectedTab === "skills" ? (
                        <InlineWarning>{t("plugins.sourceWarning.skills")}</InlineWarning>
                      ) : null}
                      {selectedTab === "plugins" && pluginRemoteSyncErrors.length > 0 ? (
                        <InlineWarning title={pluginRemoteSyncDetails}>
                          {[...new Set(pluginRemoteSyncErrors)].join(" • ")}
                        </InlineWarning>
                      ) : null}
                      {selectedTab === "plugins" && pluginMarketplaceLoadErrors.length > 0 ? (
                        <InlineWarning>
                          {pluginMarketplaceLoadErrors
                            .map(
                              (err) =>
                                `${sectionTitle(err.marketplacePath, t("plugins.unknown"))}: ${err.message}`,
                            )
                            .join(" • ")}
                        </InlineWarning>
                      ) : null}

                      {/* Grid content */}
                      <div
                        id="plugins-page-results"
                        role="tabpanel"
                        aria-labelledby={`plugins-tab-${selectedTab === "skills" ? "skills" : "plugins"}`}
                        tabIndex={-1}
                        className="flex flex-col gap-8"
                      >
                        {selectedTab !== "mcp" && selectedCapabilitiesQuery?.isPending ? (
                          <RowSkeletons
                            count={6}
                            label={t(
                              selectedTab === "plugins"
                                ? "plugins.loading.plugins"
                                : "plugins.loading.skills",
                            )}
                          />
                        ) : selectedTab !== "mcp" &&
                          awaitingSelectedCapabilities &&
                          selectedCapabilitiesQuery?.error ? (
                          <QueryErrorPanel
                            title={t(
                              selectedTab === "plugins"
                                ? "plugins.error.pluginsTitle"
                                : "plugins.error.skillsTitle",
                            )}
                            error={selectedCapabilitiesQuery.error}
                            retrying={selectedCapabilitiesQuery.isFetching}
                            onRetry={() => {
                              void selectedCapabilitiesQuery.refetch();
                            }}
                          />
                        ) : selectedTab === "plugins" ? (
                          <PluginsGrid
                            artworkCwd={discoveryCwd ?? undefined}
                            canListPlugins={canListPlugins}
                            providerLabel={providerLabel}
                            isLoading={pluginsLoading}
                            error={pluginsError}
                            queryItemCount={pluginEntries.length}
                            retrying={pluginsFetching}
                            onRetry={refetchPlugins}
                            sections={visiblePluginDirectorySections}
                            hasAny={filteredPluginEntries.length > 0}
                            activeSearchResultId={activeSearchResultId}
                            onOpen={(entry, trigger) =>
                              openDetail(
                                {
                                  kind: "plugin",
                                  plugin: entry.plugin,
                                  marketplaceName: entry.marketplaceName,
                                  marketplacePath: entry.marketplacePath,
                                  remoteMarketplaceName: entry.remoteMarketplaceName,
                                },
                                trigger,
                              )
                            }
                            onEnable={(entry) => handleTogglePlugin(entry, true)}
                            onInstall={(entry) =>
                              handleInstallPlugin({
                                kind: "plugin",
                                plugin: entry.plugin,
                                marketplaceName: entry.marketplaceName,
                                marketplacePath: entry.marketplacePath,
                                remoteMarketplaceName: entry.remoteMarketplaceName,
                              })
                            }
                            installingPluginKeys={installingPluginKeys}
                            categoryPage={selectedPluginSection !== null}
                            capSections={
                              selectedPluginSection === null &&
                              normalizeProviderDiscoveryText(deferredPluginSearch).length === 0
                            }
                            onSelectSection={(sectionId) => {
                              setSelectedSectionId(sectionId);
                              browseScrollRef.current?.scrollTo({ top: 0 });
                            }}
                            menuItemsFor={(entry) =>
                              buildCardMenuItems(
                                {
                                  kind: "plugin",
                                  plugin: entry.plugin,
                                  marketplaceName: entry.marketplaceName,
                                  marketplacePath: entry.marketplacePath,
                                  remoteMarketplaceName: entry.remoteMarketplaceName,
                                },
                                providerPluginSourceLabel(entry.plugin.source),
                              )
                            }
                          />
                        ) : selectedTab === "mcp" ? (
                          <McpGrid
                            isLoading={mcpQuery.isLoading}
                            error={mcpQuery.error}
                            queryItemCount={mcpServers.length}
                            retrying={mcpQuery.isFetching}
                            onRetry={() => {
                              void mcpQuery.refetch();
                            }}
                            servers={filteredMcpServers}
                            activeSearchResultId={activeSearchResultId}
                            onOpen={(server) => openDetail({ kind: "mcp", server })}
                            menuItemsFor={(server) =>
                              buildCardMenuItems(
                                { kind: "mcp", server },
                                server.path ?? server.name,
                              )
                            }
                          />
                        ) : (
                          <div className="flex flex-col gap-8">
                            <MossDetectedResourcesSection cwd={discoveryCwd} search={searchValue} />
                            <SkillsGrid
                              canListSkills={canListSkills}
                              providerLabel={providerLabel}
                              isLoading={skillsLoading}
                              error={skillsQuery.error}
                              queryItemCount={discoveredSkills.length}
                              retrying={skillsQuery.isFetching}
                              onRetry={() => {
                                void skillsQuery.refetch();
                              }}
                              installedSkills={filteredSkills}
                              skills={scopedSkills}
                              artworkCwd={discoveryCwd ?? undefined}
                              skillScope={skillScope}
                              onSkillScopeChange={setSkillScope}
                              activeSearchResultId={activeSearchResultId}
                              disabledSkillNames={disabledSkillNames}
                              onOpen={(skill) => openDetail({ kind: "skill", skill })}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <MossAppConnectDialog
        target={mossAppConnectTarget}
        onOpenChange={(open) => {
          if (!open) setMossAppConnectTarget(null);
        }}
      />

      <PluginMarketplaceDialog
        open={addMarketplaceOpen}
        onOpenChange={setAddMarketplaceOpen}
        onAdd={handleAddMarketplace}
      />

      <PluginLibraryImportDialog
        open={importPluginsAndSkillsOpen}
        initialKind={importKind}
        cwd={discoveryCwd}
        returnFocusRef={importTriggerRef}
        onOpenChange={setImportPluginsAndSkillsOpen}
        onImported={() => {
          void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
        }}
      />

      <AppToolsDialog
        app={selectedApp}
        open={selectedApp !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedAppId(null);
        }}
        loadTools={loadAppTools}
        updatingAppId={updatingAppId}
        onSetAppEnabled={handleSetAppEnabled}
        onOpenAppUrl={openAppExternalUrl}
        onTryNow={(app) => {
          void resourceActions.tryAppInChat(app).then((started) => {
            if (!started) {
              toastManager.add({
                type: "error",
                title: t("plugins.toast.noWorkspaceTitle"),
                description: t("plugins.toast.noWorkspaceDescription"),
              });
            }
          });
        }}
      />

      <AppConnectDialog
        app={connectTarget}
        open={connectTarget !== null}
        onOpenChange={handleAppConnectDialogOpenChange}
        readConnector={readAppConnector}
        readTerms={readAppConnectorTerms}
        startConnection={startAppConnection}
        onOpenAppUrl={openAppExternalUrl}
        onConnected={handleAppConnected}
        onConnectionOpened={handleAppConnectionOpened}
      />

      <PluginRequiredAppsDialog
        open={pluginAuthSetup?.mode === "multiple" && connectTarget === null}
        pluginName={pluginAuthSetup ? resourceActions.resourceName(pluginAuthSetup.resource) : ""}
        pluginLogoUrl={pluginAuthLogoUrl}
        apps={pluginAuthSetup?.apps ?? []}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setRetainedPluginAuthSession(null);
            setPluginAuthSetup(null);
          }
        }}
        onConnect={openRequiredAppConnection}
        onViewDetails={() => {
          if (!pluginAuthSetup) return;
          const resource = pluginAuthSetup.resource;
          setRetainedPluginAuthSession(null);
          setPluginAuthSetup(null);
          openDetail(resource);
        }}
        onTryNow={() => {
          if (!pluginAuthSetup) return;
          const resource = pluginAuthSetup.resource;
          setRetainedPluginAuthSession(null);
          setPluginAuthSetup(null);
          handleTryInChat(resource);
        }}
      />

      <PluginResourceDetailDialog
        detail={detail}
        loadSkillContent={loadSkillContent}
        open={detailOpen && detail?.kind !== "plugin"}
        onOpenChange={setDetailOpen}
        canToggle={detail ? canToggleDetailResource(detail) : false}
        onToggleEnabled={
          detail
            ? (enabled) => {
                handleToggleDetailEnabled(detail, enabled);
              }
            : undefined
        }
        onTryInChat={detail && canTryResource(detail) ? () => handleTryInChat(detail) : undefined}
        onInstall={
          detail && canInstallPluginResource(detail) ? () => handleInstallPlugin(detail) : undefined
        }
        onUninstall={
          detail && canUninstallResource(detail) ? () => setConfirmUninstall(detail) : undefined
        }
        pluginDetail={detail?.kind === "plugin" ? activePluginDetail : undefined}
        pluginDetailLoading={activePluginDetailLoading}
      />

      <AlertDialog
        open={confirmUninstall !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmUninstall(null);
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {format("plugins.confirmUninstall.title", {
                name: confirmUninstall ? resourceActions.resourceName(confirmUninstall) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("plugins.confirmUninstall.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmUninstall(null)}>
              {t("plugins.action.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={uninstalling}
              onClick={handleUninstallConfirmed}
            >
              {uninstalling ? t("plugins.action.uninstalling") : t("plugins.action.uninstall")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageSurface>
  );
}

// ── Grids (kept below the orchestrator to keep the file scannable) ───────────

export function PluginsGrid({
  artworkCwd,
  canListPlugins,
  providerLabel,
  isLoading,
  error,
  queryItemCount,
  retrying,
  onRetry,
  sections,
  hasAny,
  activeSearchResultId,
  onOpen,
  onEnable,
  onInstall,
  installingPluginKeys,
  menuItemsFor,
  onSelectSection,
  capSections = false,
  categoryPage = false,
}: {
  artworkCwd?: string | undefined;
  canListPlugins: boolean;
  providerLabel: string;
  isLoading: boolean;
  error: unknown;
  queryItemCount: number;
  retrying: boolean;
  onRetry: () => void;
  sections: ReadonlyArray<CodexPluginDirectorySection<PluginEntry>>;
  hasAny: boolean;
  activeSearchResultId: string | null;
  onOpen: (entry: PluginEntry, trigger: HTMLButtonElement) => void;
  onEnable: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
  installingPluginKeys: ReadonlySet<string>;
  menuItemsFor: (entry: PluginEntry) => CardMenuItem[];
  onSelectSection?: ((sectionId: string) => void) | undefined;
  /** Directory overview: category sections preview six plugins and link to their page. */
  capSections?: boolean;
  /** A category page already titles itself; its one section drops the heading. */
  categoryPage?: boolean;
}) {
  const { format, t } = useTranslation();
  if (!canListPlugins) {
    return (
      <EmptyPanel
        title={format("plugins.empty.pluginsUnavailableTitle", { provider: providerLabel })}
        description={t("plugins.empty.pluginsUnavailableDescription")}
      />
    );
  }
  const queryState = resolvePluginLibraryQueryState({
    isLoading,
    error,
    itemCount: queryItemCount,
  });
  if (queryState === "loading") {
    return <RowSkeletons count={6} label={t("plugins.loading.plugins")} />;
  }
  if (queryState === "error") {
    return (
      <QueryErrorPanel
        title={t("plugins.error.pluginsTitle")}
        error={error}
        retrying={retrying}
        onRetry={onRetry}
      />
    );
  }
  if (!hasAny) {
    return <PluginBrowseEmptyState />;
  }
  return (
    <>
      {sections.map((section) => (
        <PluginDirectorySection
          key={section.id}
          artworkCwd={artworkCwd}
          section={section}
          activeSearchResultId={activeSearchResultId}
          onOpen={onOpen}
          onEnable={onEnable}
          onInstall={onInstall}
          installingPluginKeys={installingPluginKeys}
          menuItemsFor={menuItemsFor}
          onSelectSection={capSections ? onSelectSection : undefined}
          capped={capSections}
          showTitle={!categoryPage}
        />
      ))}
    </>
  );
}

/** Codex previews six plugins (three rows of two) per category on the directory. */
const DIRECTORY_SECTION_PREVIEW_COUNT = 6;
/** A category page renders this many more each time its end scrolls into view. */
const CATEGORY_PAGE_BATCH_SIZE = 60;

/** Codex's "Loading plugins…" row at the end of a category page that has more. */
function LoadMorePluginsRow({ onVisible }: { readonly onVisible: () => void }) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) onVisibleRef.current();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={rowRef}
      role="status"
      data-testid="plugin-category-load-more"
      className="flex items-center justify-center gap-2 py-4 text-ui text-muted-foreground"
    >
      <Spinner className="size-3.5" />
      {t("plugins.loading.plugins")}
    </div>
  );
}

function PluginDirectorySection({
  artworkCwd,
  section,
  activeSearchResultId,
  onOpen,
  onEnable,
  onInstall,
  installingPluginKeys,
  menuItemsFor,
  onSelectSection,
  capped,
  showTitle,
}: {
  artworkCwd?: string | undefined;
  section: CodexPluginDirectorySection<PluginEntry>;
  activeSearchResultId: string | null;
  onOpen: (entry: PluginEntry, trigger: HTMLButtonElement) => void;
  onEnable: (entry: PluginEntry) => void;
  onInstall: (entry: PluginEntry) => void;
  installingPluginKeys: ReadonlySet<string>;
  menuItemsFor: (entry: PluginEntry) => CardMenuItem[];
  onSelectSection?: ((sectionId: string) => void) | undefined;
  capped: boolean;
  showTitle: boolean;
}) {
  const { locale, t } = useTranslation();
  const [pageLimit, setPageLimit] = useState(CATEGORY_PAGE_BATCH_SIZE);
  if (section.title === null) return null;
  const browsable = isBrowsablePluginDirectorySection(section);
  const entries =
    capped && browsable
      ? section.entries.slice(0, DIRECTORY_SECTION_PREVIEW_COUNT)
      : section.entries.slice(0, pageLimit);
  const hasMore = !capped && section.entries.length > entries.length;
  return (
    <section className="flex flex-col gap-3" id={section.id}>
      {showTitle ? (
        <PluginLibrarySectionHeader
          title={pluginSectionLabel(section, t)}
          onOpen={browsable && onSelectSection ? () => onSelectSection(section.id) : undefined}
          testId={`plugin-directory-section-${section.id}`}
        />
      ) : null}
      <PluginLibraryTwoColumnGrid>
        {entries.map((entry) => {
          const resultId = pluginSearchResultId(section.id, entry);
          const installed = isPluginInstalledForDirectory(entry.plugin);
          return (
            <PluginLibraryRow
              key={pluginEntryKey(entry)}
              domId={resultId}
              focusKey={resultId}
              active={activeSearchResultId === resultId}
              glyph={<PluginGlyph plugin={entry.plugin} artworkCwd={artworkCwd} />}
              title={entry.plugin.interface?.displayName ?? entry.plugin.name}
              titleAccessory={<PluginOriginBadge entry={entry} />}
              description={localizeAntigravityRuntimeMessage(
                entry.plugin.interface?.shortDescription ??
                  entry.plugin.interface?.longDescription ??
                  providerPluginSourceLabel(entry.plugin.source),
                locale,
              )}
              action={
                <PluginRowAction
                  plugin={entry.plugin}
                  onEnable={() => onEnable(entry)}
                  onInstall={() => onInstall(entry)}
                  canEnable={canTogglePluginResource(entry.plugin)}
                  installing={installingPluginKeys.has(pluginEntryKey(entry))}
                />
              }
              // Codex: "+" before install, the "…" menu once installed — never both.
              overflow={installed ? <CardOverflowMenu items={menuItemsFor(entry)} /> : null}
              onOpen={(trigger) => onOpen(entry, trigger)}
            />
          );
        })}
      </PluginLibraryTwoColumnGrid>
      {hasMore ? (
        <LoadMorePluginsRow
          onVisible={() => setPageLimit((limit) => limit + CATEGORY_PAGE_BATCH_SIZE)}
        />
      ) : null}
    </section>
  );
}

/** Row-shaped skeletons for the borderless plugin list. */
function RowSkeletons({ count, label }: { count: number; label?: string }) {
  return (
    <PluginLibraryTwoColumnGrid>
      {label ? (
        <span role="status" className="sr-only">
          {label}
        </span>
      ) : null}
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex min-h-[68px] items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-[10px]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-1/3 rounded" />
            <Skeleton className="h-3 w-2/3 rounded" />
          </div>
        </div>
      ))}
    </PluginLibraryTwoColumnGrid>
  );
}

function McpGrid({
  isLoading,
  error,
  queryItemCount,
  retrying,
  onRetry,
  servers,
  activeSearchResultId,
  onOpen,
  menuItemsFor,
}: {
  isLoading: boolean;
  error: unknown;
  queryItemCount: number;
  retrying: boolean;
  onRetry: () => void;
  servers: ReadonlyArray<ProviderMcpServerDescriptor>;
  activeSearchResultId: string | null;
  onOpen: (server: ProviderMcpServerDescriptor) => void;
  menuItemsFor: (server: ProviderMcpServerDescriptor) => CardMenuItem[];
}) {
  const { t } = useTranslation();
  const queryState = resolvePluginLibraryQueryState({
    isLoading,
    error,
    itemCount: queryItemCount,
  });
  if (queryState === "loading") {
    return <CardSkeletons count={4} label={t("plugins.loading.mcpServers")} />;
  }
  if (queryState === "error") {
    return (
      <QueryErrorPanel
        title={t("plugins.error.mcpServersTitle")}
        error={error}
        retrying={retrying}
        onRetry={onRetry}
      />
    );
  }
  if (servers.length === 0) {
    return (
      <EmptyPanel
        title={t("plugins.empty.noMcpServersTitle")}
        description={t("plugins.empty.noMcpServersDescription")}
      />
    );
  }
  return (
    <Section title={t("plugins.section.mcpServers")}>
      <CardGrid>
        {servers.map((server) => (
          <ResourceCard
            key={`${server.origin}::${server.name}`}
            domId={mcpSearchResultId(server)}
            active={activeSearchResultId === mcpSearchResultId(server)}
            glyph={<McpGlyph server={server} />}
            title={server.name}
            description={server.command ?? server.url ?? mcpTransportLabel(server.transport)}
            badge={<SourceBadge label={originLabel(server.origin)} />}
            meta={mcpTransportLabel(server.transport)}
            overflow={<CardOverflowMenu items={menuItemsFor(server)} />}
            onOpen={() => onOpen(server)}
          />
        ))}
      </CardGrid>
    </Section>
  );
}

function SkillsGrid({
  canListSkills,
  providerLabel,
  isLoading,
  error,
  queryItemCount,
  retrying,
  onRetry,
  installedSkills,
  skills,
  skillScope,
  onSkillScopeChange,
  activeSearchResultId,
  disabledSkillNames,
  onOpen,
  artworkCwd,
}: {
  canListSkills: boolean;
  providerLabel: string;
  isLoading: boolean;
  error: unknown;
  queryItemCount: number;
  retrying: boolean;
  onRetry: () => void;
  installedSkills: ReadonlyArray<ProviderSkillDescriptor>;
  skills: ReadonlyArray<ProviderSkillDescriptor>;
  skillScope: SkillScopeGroup;
  onSkillScopeChange: (scope: SkillScopeGroup) => void;
  activeSearchResultId: string | null;
  disabledSkillNames: ReadonlySet<string>;
  onOpen: (skill: ProviderSkillDescriptor) => void;
  artworkCwd?: string | undefined;
}) {
  const { format, t } = useTranslation();
  if (!canListSkills) {
    return (
      <EmptyPanel
        title={format("plugins.empty.skillsUnavailableTitle", { provider: providerLabel })}
        description={t("plugins.empty.skillsUnavailableDescription")}
      />
    );
  }
  const queryState = resolvePluginLibraryQueryState({
    isLoading,
    error,
    itemCount: queryItemCount,
  });
  if (queryState === "loading") {
    return <CardSkeletons count={6} label={t("plugins.loading.skills")} />;
  }
  if (queryState === "error") {
    return (
      <QueryErrorPanel
        title={t("plugins.error.skillsTitle")}
        error={error}
        retrying={retrying}
        onRetry={onRetry}
      />
    );
  }
  if (installedSkills.length === 0) {
    return (
      <EmptyPanel
        title={t("plugins.empty.noSkillsTitle")}
        description={t("plugins.empty.noSkillsDescription")}
      />
    );
  }
  const renderSkillRow = (skill: ProviderSkillDescriptor) => {
    const enabled = !disabledSkillNames.has(settingsSkillNameKey(skill.name));
    return (
      <PluginLibraryRow
        key={skill.path}
        domId={skillSearchResultId(skill)}
        active={activeSearchResultId === skillSearchResultId(skill)}
        glyph={<SkillGlyph skill={skill} artworkCwd={artworkCwd} />}
        title={skill.interface?.displayName ?? skill.name}
        description={
          skill.interface?.shortDescription ?? skill.description ?? t("plugins.empty.noDescription")
        }
        dimmed={!enabled}
        action={<InstalledStatus installed={enabled} />}
        onOpen={() => onOpen(skill)}
      />
    );
  };
  const scopeTabs: ReadonlyArray<{ id: SkillScopeGroup; label: string }> = [
    { id: "personal", label: t("plugins.source.personal") },
    { id: "system", label: t("plugins.scope.system") },
  ];
  return (
    <>
      {/* Codex skills browse: every installed skill under a hairline heading,
          then Personal · System scope pills over the matching list. Both lists
          preview a few rows and expand in place. */}
      <section className="flex flex-col gap-3" data-testid="skills-installed-grid">
        <PluginLibrarySectionHeader title={t("plugins.action.installed")} divided />
        <CappedSkillGrid skills={installedSkills} renderRow={renderSkillRow} resetKey="installed" />
      </section>
      <section className="flex flex-col gap-3">
        <PluginLibraryPillTabs
          ariaLabel={t("plugins.sourceAria")}
          testId="skills-scope-tabs"
          tabs={scopeTabs}
          selected={skillScope}
          onSelect={onSkillScopeChange}
        />
        {skills.length > 0 ? (
          <div data-testid="skills-scoped-grid">
            <CappedSkillGrid skills={skills} renderRow={renderSkillRow} resetKey={skillScope} />
          </div>
        ) : (
          <p className="text-ui-lg leading-5 text-muted-foreground">
            {t("plugins.empty.noSkillsInScope")}
          </p>
        )}
      </section>
    </>
  );
}

/** Codex shows four rows of skills before its "See …, and N more" expander. */
/** Codex previews six skills (three rows of two) per list. */
const SKILL_LIST_PREVIEW_COUNT = 6;

function CappedSkillGrid({
  skills,
  renderRow,
  resetKey,
}: {
  skills: ReadonlyArray<ProviderSkillDescriptor>;
  renderRow: (skill: ProviderSkillDescriptor) => ReactNode;
  resetKey: string;
}) {
  const { format, t } = useTranslation();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expanded = expandedKey === resetKey;
  const hidden = skills.slice(SKILL_LIST_PREVIEW_COUNT);
  const visible = expanded ? skills : skills.slice(0, SKILL_LIST_PREVIEW_COUNT);
  const hiddenNames = hidden
    .slice(0, 2)
    .map((skill) => skill.interface?.displayName ?? skill.name)
    .join(", ");
  return (
    <div className="flex flex-col">
      <PluginLibraryTwoColumnGrid>{visible.map(renderRow)}</PluginLibraryTwoColumnGrid>
      {hidden.length > 0 ? (
        <PluginLibraryExpandRow
          expanded={expanded}
          collapsedLabel={
            hidden.length > 2
              ? format("plugins.section.seeMoreCount", {
                  names: hiddenNames,
                  count: hidden.length - 2,
                })
              : format("plugins.section.seeMore", { names: hiddenNames })
          }
          expandedLabel={t("plugins.section.showLess")}
          onToggle={() => setExpandedKey(expanded ? null : resetKey)}
        />
      ) : null}
    </div>
  );
}

/** Loading skeletons shaped like the 112px cards, in the same responsive grid. */
function CardSkeletons({ count, label }: { count: number; label?: string }) {
  return (
    <CardGrid>
      {label ? (
        <span role="status" className="sr-only">
          {label}
        </span>
      ) : null}
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-[112px] w-full rounded-lg" />
      ))}
    </CardGrid>
  );
}
