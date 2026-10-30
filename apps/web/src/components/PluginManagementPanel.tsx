// FILE: PluginManagementPanel.tsx
// Purpose: Codex Settings › Plugins: one bordered list per tab — Plugins, Apps,
//          MCP, Skills, Marketplaces — with counts, search, enable switches and
//          the page's Browse catalog / Add actions.
// Layer: Web component

import type {
  ProviderAppInfo,
  ProviderMcpServerDescriptor,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceLoadError,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import {
  AppsIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderIcon,
  PluginIcon,
  SearchIcon,
  TerminalIcon,
} from "~/lib/icons";
import {
  resolveResourceIcon,
  SKILL_FALLBACK_ICON,
  type ResourceIconComponent,
} from "~/lib/resourceIcon";
import { settingsSkillNameKey } from "./settings/skillsSettingsModel";
import {
  Menu as DropdownMenu,
  MenuItem as DropdownMenuItem,
  MenuTrigger as DropdownMenuTrigger,
} from "./ui/menu";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  isBuiltInPluginMarketplace,
  isMossCanonicalMcp,
  mcpTransportLabel,
  originLabel,
} from "~/lib/pluginLibraryModel";
import { normalizePluginExternalUrl } from "~/lib/pluginExternalLink";
import { resolvePluginArtworkUrl } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import type {
  PluginLibraryManageSnapshot,
  PluginLibraryManageTab,
} from "~/lib/pluginLibraryHistoryState";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

export interface ManagedPlugin {
  readonly plugin: ProviderPluginDescriptor;
  readonly marketplaceName: string;
  readonly marketplacePath: string | null;
  readonly remoteMarketplaceName: string | null;
}

export interface ManagedMarketplace {
  readonly key: string;
  readonly name: string;
  readonly displayName: string;
  readonly path: string | null;
  readonly pluginCount: number;
  readonly isBuiltIn: boolean;
  readonly isConfigured: boolean;
  readonly isGit: boolean;
}

/** Skills and marketplace data for the Skills and Marketplaces tabs. */
interface PluginManagementPanelTabDataProps {
  readonly marketplaces?: ReadonlyArray<ManagedMarketplace> | undefined;
  readonly marketplaceLoadErrors?: ReadonlyArray<ProviderPluginMarketplaceLoadError> | undefined;
  readonly marketplacesLoading?: boolean | undefined;
  readonly marketplacesError?: unknown;
  readonly marketplacesRetrying?: boolean | undefined;
  readonly pendingRemoveMarketplaceName?: string | null | undefined;
  readonly pendingUpgradeMarketplaceName?: string | null | undefined;
  readonly upgradingAllMarketplaces?: boolean | undefined;
  readonly onRetryMarketplaces?: (() => void) | undefined;
  readonly onRemoveMarketplace?: ((marketplace: ManagedMarketplace) => void) | undefined;
  readonly onUpgradeMarketplace?: ((marketplace: ManagedMarketplace) => void) | undefined;
  readonly onUpgradeAllMarketplaces?: (() => void) | undefined;
  readonly onCopyMarketplacePath?: ((path: string) => void) | undefined;
  readonly skills?: ReadonlyArray<ProviderSkillDescriptor> | undefined;
  readonly disabledSkillNames?: ReadonlySet<string> | undefined;
  readonly onToggleSkill?: ((skillName: string, enabled: boolean) => void) | undefined;
}

interface ManagementRow {
  readonly key: string;
  readonly testId?: "plugin-manage-plugin-row" | "plugin-manage-skill-row" | undefined;
  readonly icon: typeof PluginIcon | ResourceIconComponent;
  readonly artwork?: string | undefined;
  readonly title: string;
  /** Codex's quiet tag after the name (a remote marketplace, "Built-in"). */
  readonly tag?: string | undefined;
  readonly subtitle: string;
  readonly badge?: string | undefined;
  readonly enabled: boolean;
  readonly onToggle?: (enabled: boolean) => void;
  readonly onOpen?: (trigger: HTMLButtonElement) => void;
  readonly canToggle: boolean;
  /** Rows without an enable switch (marketplaces) carry their own trailing control. */
  readonly trailing?: ReactNode;
}

export interface ManagedMossApp {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly logoUrl: string | null;
}

interface ManageTabItem {
  readonly id: PluginLibraryManageTab;
  readonly label: string;
  readonly count: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SubTabButton({
  id,
  label,
  count,
  active,
  onKeyDown,
  onClick,
}: {
  id: PluginLibraryManageTab;
  label: string;
  count: number;
  active: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`plugin-manage-tab-${id}`}
      id={`plugin-manage-tab-${id}`}
      role="tab"
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-selected={active}
      aria-controls="plugin-manage-tabpanel"
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-control border border-transparent px-2 text-ui-lg leading-[18px] font-[445] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "bg-[color-mix(in_srgb,var(--color-text-foreground)_5%,transparent)] text-foreground hover:bg-[color-mix(in_srgb,var(--color-text-foreground)_10%,transparent)]"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span className="ml-0.5 text-muted-foreground">{count}</span>
    </button>
  );
}

function ManagementArtwork({ row }: { readonly row: ManagementRow }) {
  const [failed, setFailed] = useState(false);
  const Icon = row.icon;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-card ring-1 ring-border/70 ring-inset">
      {row.artwork && !failed ? (
        <img
          src={row.artwork}
          alt={row.title}
          className="size-full rounded-sm object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon className="size-5 text-muted-foreground" />
      )}
    </span>
  );
}

/**
 * Codex manage row: a 64px line in the tab's bordered list — artwork, name with
 * an optional tag over a one-line summary, then the enable switch and a chevron
 * when the row opens its detail.
 */
function Row({ row }: { row: ManagementRow }) {
  const { format, t } = useTranslation();
  const moreActionsLabel = t("plugins.manage.moreActions");
  const content = (
    <>
      <ManagementArtwork row={row} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ui-lg leading-5 font-medium text-foreground">
            {row.title}
          </span>
          {row.tag ? (
            <span className="shrink-0 truncate text-ui leading-5 text-muted-foreground">
              {row.tag}
            </span>
          ) : null}
        </p>
        {row.subtitle ? (
          <p className="truncate text-ui leading-5 text-muted-foreground">{row.subtitle}</p>
        ) : null}
      </div>
    </>
  );
  return (
    <div
      data-testid={row.testId}
      className="group flex min-h-16 w-full items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/[0.03] plugin-library-motion"
    >
      {row.onOpen ? (
        <button
          type="button"
          aria-label={row.title}
          data-plugin-library-focus-key={`manage:${row.key}:primary`}
          onClick={(event) => row.onOpen?.(event.currentTarget)}
          className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {row.trailing ?? (
          <Switch
            className="min-h-6"
            checked={row.enabled}
            disabled={!row.canToggle}
            onCheckedChange={(checked) => row.onToggle?.(Boolean(checked))}
            aria-label={format("plugins.manage.toggleAria", { name: row.title })}
          />
        )}
        {row.onOpen ? (
          <button
            type="button"
            aria-label={moreActionsLabel}
            title={moreActionsLabel}
            data-plugin-library-focus-key={`manage:${row.key}:overflow`}
            onClick={(event) => row.onOpen?.(event.currentTarget)}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The bordered, hairline-divided list every manage tab renders into. */
function ManageList({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70"
      data-testid="plugin-manage-list"
    >
      {children}
    </div>
  );
}

function MarketplaceRowMenu({
  marketplace,
  onCopyPath,
}: {
  readonly marketplace: ManagedMarketplace;
  readonly onCopyPath?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const path = marketplace.path;
  if (!path || !onCopyPath) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("plugins.manage.moreActions")}
            data-testid="plugin-manage-marketplace-actions"
          >
            <EllipsisIcon className="size-4" />
          </Button>
        }
      />
      <ComposerPickerMenuPopup align="end" className="w-44 min-w-44">
        <DropdownMenuItem onClick={() => onCopyPath(path)}>
          <CopyIcon className="size-4" />
          {t("plugins.detail.label.path")}
        </DropdownMenuItem>
      </ComposerPickerMenuPopup>
    </DropdownMenu>
  );
}

function pluginArtwork(
  plugin: ProviderPluginDescriptor,
  artworkCwd: string | undefined,
): string | undefined {
  const rawArtwork =
    plugin.interface?.logoUrl?.trim() ||
    plugin.interface?.logo?.trim() ||
    plugin.interface?.composerIconUrl?.trim() ||
    plugin.interface?.logoUrlDark?.trim() ||
    plugin.interface?.logoDark?.trim() ||
    undefined;
  return rawArtwork ? resolvePluginArtworkUrl({ src: rawArtwork, cwd: artworkCwd }) : undefined;
}

function CenterState({
  title,
  description,
  retrying,
  onRetry,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly retrying?: boolean | undefined;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <div>
        <p className="text-ui-lg font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mt-1 text-ui-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          {t("plugins.action.retry")}
        </Button>
      ) : null}
    </div>
  );
}

function AppRow({
  app,
  pending,
  onSetEnabled,
  onOpenUrl,
  onOpenTools,
  artworkCwd,
}: {
  readonly app: ProviderAppInfo;
  readonly pending: boolean;
  readonly onSetEnabled: (app: ProviderAppInfo, enabled: boolean) => void;
  readonly onOpenUrl: (url: string) => Promise<boolean>;
  readonly onOpenTools?: ((app: ProviderAppInfo) => void) | undefined;
  readonly artworkCwd?: string | undefined;
}) {
  const { format, t } = useTranslation();
  const inFlight = useRef<Promise<boolean> | null>(null);
  const safeInstallUrl = normalizePluginExternalUrl(app.installUrl);
  const rawLogo = app.logoUrl ?? app.logoUrlDark;
  const logo = rawLogo ? resolvePluginArtworkUrl({ src: rawLogo, cwd: artworkCwd }) : null;
  const open = () => {
    if (!safeInstallUrl || inFlight.current) return;
    const request = onOpenUrl(safeInstallUrl).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = request;
  };
  return (
    <div
      data-testid="plugin-manage-app-row"
      className="group flex items-center justify-between gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-[var(--sidebar-accent)]"
      onClick={() => onOpenTools?.(app)}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={format("plugins.manage.openAppTools", { name: app.name })}
        onClick={(event) => {
          event.stopPropagation();
          onOpenTools?.(app);
        }}
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 text-muted-foreground">
          {logo ? (
            <img src={logo} alt="" className="size-5 object-contain" />
          ) : (
            <AppsIcon className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-foreground">{app.name}</span>
          <span className="block truncate text-ui-sm text-muted-foreground">
            {app.description ?? t("plugins.manage.noDescription")}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {safeInstallUrl ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("plugins.manage.manageOnChatGPT")}
            title={t("plugins.manage.manageOnChatGPT")}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        ) : null}
        <Switch
          checked={app.isEnabled}
          disabled={pending}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={(checked) => onSetEnabled(app, Boolean(checked))}
          aria-label={
            app.isEnabled ? t("plugins.manage.disableApp") : t("plugins.manage.enableApp")
          }
          title={app.isEnabled ? t("plugins.manage.disableApp") : t("plugins.manage.enableApp")}
        />
      </div>
    </div>
  );
}

export interface PluginManagementPanelProps extends PluginManagementPanelTabDataProps {
  /** Shown as a settings page (no top bar above it), with the settings pages' top margin. */
  readonly settingsPage?: boolean | undefined;
  readonly viewState?: PluginLibraryManageSnapshot | undefined;
  readonly onViewStateChange?: ((state: PluginLibraryManageSnapshot) => void) | undefined;
  readonly plugins: ReadonlyArray<ManagedPlugin>;
  readonly apps: ReadonlyArray<ProviderAppInfo>;
  readonly appsLoading: boolean;
  readonly appsError: unknown;
  readonly appsRetrying?: boolean | undefined;
  readonly updatingAppId?: string | null | undefined;
  readonly onRetryApps?: (() => void) | undefined;
  readonly onSetAppEnabled?: ((app: ProviderAppInfo, enabled: boolean) => void) | undefined;
  readonly onOpenAppUrl?: ((url: string) => Promise<boolean>) | undefined;
  readonly onOpenAppTools?: ((app: ProviderAppInfo) => void) | undefined;
  readonly mcpServers: ReadonlyArray<ProviderMcpServerDescriptor>;
  readonly onTogglePlugin: (entry: ManagedPlugin, enabled: boolean) => void;
  readonly onToggleMcp: (server: ProviderMcpServerDescriptor, enabled: boolean) => void;
  readonly onOpenPlugin?: ((entry: ManagedPlugin, trigger: HTMLButtonElement) => void) | undefined;
  readonly onOpenSkill?: ((skill: ProviderSkillDescriptor) => void) | undefined;
  /** Apps connected through Moss Apps; they share the Apps tab with the CLI's own. */
  readonly mossApps?: ReadonlyArray<ManagedMossApp> | undefined;
  readonly onOpenMossApp?: ((slug: string) => void) | undefined;
  readonly onDisconnectMossApp?: ((slug: string) => void) | undefined;
  readonly artworkCwd?: string | undefined;
  /** Codex's "Browse catalog" and "Add" controls, aligned with the page title. */
  readonly headerActions?: ReactNode;
}

const ALWAYS_SHOWN_MANAGE_TABS: ReadonlySet<PluginLibraryManageTab> = new Set([
  "plugins",
  "apps",
  "mcps",
]);

const MANAGE_TABS: readonly PluginLibraryManageTab[] = [
  "plugins",
  "apps",
  "mcps",
  "skills",
  "marketplaces",
];

function normalizeManageTab(value: unknown): PluginLibraryManageTab {
  return MANAGE_TABS.find((tab) => tab === value) ?? "plugins";
}

export function PluginManagementPanel(props: PluginManagementPanelProps) {
  const { format, t } = useTranslation();
  const [uncontrolledTab, setUncontrolledTab] = useState<PluginLibraryManageTab>("plugins");
  const [uncontrolledQuery, setUncontrolledQuery] = useState("");
  const onViewStateChange = props.onViewStateChange;
  const viewStateScrollTop = props.viewState?.scrollTop ?? 0;
  const viewStateFocusAnchor = props.viewState?.focusAnchor ?? null;
  const requestedTab = normalizeManageTab(props.viewState?.initialTab ?? uncontrolledTab);
  const query = props.viewState?.search ?? uncontrolledQuery;
  const updateViewState = useCallback(
    (next: { readonly tab?: PluginLibraryManageTab; readonly query?: string }) => {
      const nextTab = next.tab ?? requestedTab;
      const nextQuery = next.query ?? query;
      setUncontrolledTab(nextTab);
      setUncontrolledQuery(nextQuery);
      onViewStateChange?.({
        initialTab: nextTab,
        search: nextQuery,
        scrollTop: viewStateScrollTop,
        focusAnchor: viewStateFocusAnchor,
      });
    },
    [onViewStateChange, query, requestedTab, viewStateFocusAnchor, viewStateScrollTop],
  );
  const accessibleApps = useMemo(() => props.apps.filter((app) => app.isAccessible), [props.apps]);
  const mossAppRows: ManagementRow[] = (props.mossApps ?? []).map((app) => {
    const row: ManagementRow = {
      key: `moss-app::${app.slug}`,
      icon: AppsIcon,
      artwork: app.logoUrl ?? undefined,
      title: app.name,
      subtitle: app.description,
      enabled: true,
      canToggle: Boolean(props.onDisconnectMossApp),
      // An app is on while it is connected; switching it off disconnects it.
      onToggle: (next: boolean) => {
        if (!next) props.onDisconnectMossApp?.(app.slug);
      },
    };
    const onOpenMossApp = props.onOpenMossApp;
    return onOpenMossApp ? Object.assign(row, { onOpen: () => onOpenMossApp(app.slug) }) : row;
  });
  const pluginRows: ManagementRow[] = props.plugins.map((entry) => {
    const marketplaceKey =
      entry.marketplacePath ?? `remote:${entry.remoteMarketplaceName ?? entry.marketplaceName}`;
    return {
      key: `${marketplaceKey}::${entry.plugin.name}`,
      testId: "plugin-manage-plugin-row",
      icon: PluginIcon,
      artwork: pluginArtwork(entry.plugin, props.artworkCwd),
      title: entry.plugin.interface?.displayName ?? entry.plugin.name,
      // Codex tags a row with its remote lane ("created-by-me-remote"); its own
      // catalog ("openai-curated-remote") goes untagged.
      tag:
        entry.remoteMarketplaceName && !isBuiltInPluginMarketplace(entry.remoteMarketplaceName)
          ? entry.remoteMarketplaceName
          : undefined,
      subtitle:
        entry.plugin.interface?.shortDescription ?? entry.plugin.interface?.longDescription ?? "",
      enabled: entry.plugin.enabled,
      canToggle: true,
      ...(props.onOpenPlugin
        ? { onOpen: (trigger: HTMLButtonElement) => props.onOpenPlugin?.(entry, trigger) }
        : {}),
      onToggle: (next: boolean) => props.onTogglePlugin(entry, next),
    };
  });
  const mcpRows: ManagementRow[] = props.mcpServers.map((server) => {
    const canToggle = isMossCanonicalMcp(server);
    return {
      key: `mcp::${server.origin}::${server.name}`,
      icon: TerminalIcon,
      title: server.name,
      subtitle: server.command ?? server.url ?? mcpTransportLabel(server.transport),
      badge: originLabel(server.origin),
      enabled: server.enabled,
      canToggle,
      ...(canToggle ? { onToggle: (next: boolean) => props.onToggleMcp(server, next) } : {}),
    };
  });
  const disabledSkillNames = props.disabledSkillNames;
  const onOpenSkill = props.onOpenSkill;
  const skillRows: ManagementRow[] = (props.skills ?? []).map((skill) => {
    const title = skill.interface?.displayName ?? skill.name;
    const subtitle = skill.interface?.shortDescription ?? skill.description ?? "";
    const row: ManagementRow = {
      key: `skill::${skill.path}`,
      testId: "plugin-manage-skill-row",
      icon: resolveResourceIcon(title, subtitle, SKILL_FALLBACK_ICON),
      title,
      subtitle,
      enabled: !disabledSkillNames?.has(settingsSkillNameKey(skill.name)),
      canToggle: Boolean(props.onToggleSkill),
      onToggle: (next: boolean) => props.onToggleSkill?.(skill.name, next),
    };
    return onOpenSkill ? Object.assign(row, { onOpen: () => onOpenSkill(skill) }) : row;
  });
  const marketplaceRows: ManagementRow[] = (props.marketplaces ?? []).map((marketplace) => ({
    key: `marketplace::${marketplace.key}`,
    icon: FolderIcon,
    title: marketplace.displayName,
    tag: marketplace.isBuiltIn ? t("plugins.manage.builtIn") : undefined,
    subtitle: [
      format("plugins.manage.pluginCount", { count: marketplace.pluginCount }),
      marketplace.path,
    ]
      .filter(Boolean)
      .join(" · "),
    enabled: true,
    canToggle: false,
    trailing: (
      <MarketplaceRowMenu marketplace={marketplace} onCopyPath={props.onCopyMarketplacePath} />
    ),
  }));
  // Plugins, Apps and MCP always show (with their counts); Skills and
  // Marketplaces join them once they have rows.
  const tabItems = useMemo<ManageTabItem[]>(() => {
    const items: ManageTabItem[] = [
      { id: "plugins", label: t("plugins.manage.tab.plugins"), count: pluginRows.length },
      {
        id: "apps",
        label: t("plugins.manage.tab.apps"),
        count: accessibleApps.length + mossAppRows.length,
      },
      { id: "mcps", label: t("plugins.manage.tab.mcps"), count: mcpRows.length },
      { id: "skills", label: t("plugins.manage.tab.skills"), count: skillRows.length },
      {
        id: "marketplaces",
        label: t("plugins.manage.tab.marketplace"),
        count: marketplaceRows.length,
      },
    ];
    return items.filter((item) => ALWAYS_SHOWN_MANAGE_TABS.has(item.id) || item.count > 0);
  }, [
    accessibleApps.length,
    marketplaceRows.length,
    mcpRows.length,
    mossAppRows.length,
    pluginRows.length,
    skillRows.length,
    t,
  ]);
  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, id: PluginLibraryManageTab) => {
      const currentIndex = tabItems.findIndex((item) => item.id === id);
      if (currentIndex < 0) return;
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabItems.length;
      if (event.key === "ArrowLeft")
        nextIndex = (currentIndex - 1 + tabItems.length) % tabItems.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabItems.length - 1;
      if (nextIndex === null || tabItems.length === 0) return;
      event.preventDefault();
      const nextTab = tabItems[nextIndex];
      if (!nextTab) return;
      updateViewState({ tab: nextTab.id });
      window.requestAnimationFrame(() => {
        document.getElementById(`plugin-manage-tab-${nextTab.id}`)?.focus();
      });
    },
    [tabItems, updateViewState],
  );
  // A restored tab that has no rows (and so no tab) shows the first shown tab
  // instead, unless its own data is still loading — Codex resolves the visible
  // tab the same way on every render.
  const requestedTabLoading =
    (requestedTab === "apps" && Boolean(props.appsLoading)) ||
    (requestedTab !== "apps" && requestedTab !== "mcps" && Boolean(props.marketplacesLoading));
  const tab =
    requestedTabLoading || tabItems.some((item) => item.id === requestedTab)
      ? requestedTab
      : (tabItems[0]?.id ?? "plugins");
  useEffect(() => {
    if (tab !== requestedTab) updateViewState({ tab });
  }, [requestedTab, tab, updateViewState]);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (...values: Array<string | null | undefined>) =>
    normalizedQuery.length === 0 ||
    values.some((value) => value?.toLowerCase().includes(normalizedQuery));
  const rows = (
    tab === "plugins"
      ? pluginRows
      : tab === "skills"
        ? skillRows
        : tab === "marketplaces"
          ? marketplaceRows
          : mcpRows
  ).filter((row) => matches(row.title, row.subtitle, row.badge, row.tag));
  const visibleApps = accessibleApps.filter((app) =>
    matches(app.name, app.description, ...app.pluginDisplayNames),
  );
  const visibleMossApps = mossAppRows.filter((row) => matches(row.title, row.subtitle));

  let content;
  if (tab === "apps") {
    content =
      props.appsLoading && accessibleApps.length === 0 && mossAppRows.length === 0 ? (
        <CenterState title={t("plugins.manage.loadingApps")} />
      ) : props.appsError && accessibleApps.length === 0 && mossAppRows.length === 0 ? (
        <CenterState
          title={t("plugins.manage.appsUnavailable")}
          description={errorMessage(props.appsError)}
          retrying={props.appsRetrying}
          onRetry={props.onRetryApps}
        />
      ) : visibleApps.length === 0 && visibleMossApps.length === 0 ? (
        <CenterState title={t("plugins.manage.appsEmpty")} />
      ) : (
        <div className="flex flex-col gap-2">
          {props.appsError ? (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 rounded-lg bg-destructive/5 p-3"
            >
              <div className="min-w-0">
                <p className="text-ui-lg font-medium text-foreground">
                  {t("plugins.manage.appsUnavailable")}
                </p>
                <p className="mt-1 break-words text-ui-sm text-muted-foreground">
                  {errorMessage(props.appsError)}
                </p>
              </div>
              {props.onRetryApps ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.appsRetrying}
                  onClick={props.onRetryApps}
                >
                  {t("plugins.action.retry")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ManageList>
            {visibleApps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                pending={props.updatingAppId === app.id}
                onSetEnabled={(target, enabled) => props.onSetAppEnabled?.(target, enabled)}
                onOpenUrl={props.onOpenAppUrl ?? (async () => false)}
                onOpenTools={props.onOpenAppTools}
                artworkCwd={props.artworkCwd}
              />
            ))}
            {visibleMossApps.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ManageList>
        </div>
      );
  } else {
    content =
      rows.length === 0 ? (
        <CenterState title={t("plugins.manage.empty")} />
      ) : (
        <ManageList>
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </ManageList>
      );
  }

  return (
    <div className="min-h-full w-full">
      {/* Codex: a 768px column with 20px gutters inside it, so the page is 728px wide. */}
      <div
        data-testid="plugin-manage-content"
        className={cn(
          "mx-auto flex w-full max-w-3xl flex-col px-5 pb-8",
          props.settingsPage ? "pt-8" : "pt-5",
        )}
      >
        <header className="flex flex-wrap items-start justify-between gap-4 pb-8">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className={PAGE_TITLE_CLASS_NAME}>{t("plugins.hero.plugins")}</h1>
            <p className="text-ui-lg leading-5 text-muted-foreground">
              {t("plugins.manage.subtitle")}
            </p>
          </div>
          {props.headerActions ? (
            // The settings drag strip overlaps this row; keep its buttons clickable.
            <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
              {props.headerActions}
            </div>
          ) : null}
        </header>
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="tablist"
              aria-label={t("plugins.manage.tabsAria")}
              aria-orientation="horizontal"
              className="inline-flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto overflow-y-hidden"
            >
              {tabItems.map((item) => (
                <SubTabButton
                  key={item.id}
                  {...item}
                  active={tab === item.id}
                  onKeyDown={(event) => handleTabKeyDown(event, item.id)}
                  onClick={() => updateViewState({ tab: item.id })}
                />
              ))}
            </div>
            <div className="flex h-8 w-56 min-w-0 items-center gap-2 rounded-lg bg-[var(--color-background-control)] pr-[9px] pl-[11px] text-ui-lg leading-[18px] shadow-none ring-1 ring-border ring-inset">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <label className="sr-only" htmlFor="plugins-page-manage-search">
                {t("plugins.search.plugins")}
              </label>
              <input
                id="plugins-page-manage-search"
                type="text"
                value={query}
                onChange={(event) => updateViewState({ query: event.currentTarget.value })}
                placeholder={t("plugins.search.plugins")}
                className="h-full min-w-0 flex-1 bg-transparent text-ui-lg leading-[18px] font-[445] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div
            id="plugin-manage-tabpanel"
            role="tabpanel"
            aria-labelledby={`plugin-manage-tab-${tab}`}
          >
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
