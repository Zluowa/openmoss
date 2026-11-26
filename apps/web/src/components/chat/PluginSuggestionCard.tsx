// FILE: PluginSuggestionCard.tsx
// Purpose: Inline chat plugin suggestion card styled to Moss's restrained paper
//          design standard, reusing shared Moss UI primitives (PluginLibraryCardIconBox,
//          ConnectorIcon, SiteFavicon, Button, TextAction, Badge). Lets users
//          dismiss ("以后再说") or authorize/install ("安装") inline in the chat.
// Layer: Web chat presentation component
// Exports: PluginSuggestionCard

import {
  isSupportedProviderKind,
  type PluginSuggestionActivityPayload,
  type PluginSuggestionItem,
  type ProviderKind,
  type ThreadId,
} from "@moss/contracts";
import { findMcpConnectorPreset } from "@moss/shared/mcpConnectors";
import {
  MOSS_DEVELOPER_PLUGIN_ID,
  isMossDeveloperPluginInstalled,
} from "@moss/shared/mossDeveloperPlugin";
import { upsertDismissedPluginSuggestion } from "@moss/shared/mossGuidePlugin";
import { findMossServicePlugin, mossServicePluginInfo } from "@moss/shared/mossServicePlugins";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { ConnectorIcon } from "~/components/ConnectorIcon";
import { MossAppConnectDialog, type MossAppConnectTarget } from "~/components/MossAppConnectDialog";
import { MossLogo } from "~/components/MossLogo";
import { PluginLibraryCardIconBox } from "~/components/PluginLibraryPrimitives";
import { SiteFavicon } from "~/components/SiteFavicon";
import {
  McpConnectorConnectDialog,
  mcpConnectorPresetTarget,
  type McpConnectorTarget,
} from "~/components/settings/McpConnectorConnectDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { HitArea } from "~/components/ui/hit-area";
import { Spinner } from "~/components/ui/spinner";
import { TextAction } from "~/components/ui/text-action";
import { toastManager } from "~/components/ui/toast";
import { readableBrandColor, resolveBrandArtwork } from "~/lib/brandIcons";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PluginIcon } from "~/lib/icons";
import {
  MCP_CONNECTORS_QUERY_KEY,
  mcpConnectorsQueryOptions,
  mossServicePluginsQueryOptions,
} from "~/lib/mcpConnectorsReactQuery";
import {
  MOSS_APP_CONNECTIONS_QUERY_KEY,
  mossAppConnectionsQueryOptions,
} from "~/lib/mossAppsReactQuery";
import { nextOfficialPluginsUninstalled } from "~/lib/mossGuidePluginPresentation";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import {
  providerDiscoveryQueryKeys,
  providerPluginsQueryOptions,
} from "~/lib/providerDiscoveryReactQuery";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { resolveResourceIcon } from "~/lib/resourceIcon";
import { useTranslation } from "~/localization";
import { ensureNativeApi, isNativeApiDetached } from "~/nativeApi";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

import {
  formatPluginSuggestionMeta,
  readDismissedSuggestionIds,
  resolveProviderInstallMarketplaceSelector,
  resolveSuggestionInstallState,
  writeSuggestionDismissed,
} from "./PluginSuggestionCard.logic";

const EMPTY_SET: ReadonlySet<string> = new Set();

function resolveFallbackWorkspaceCwd(): string | null {
  try {
    const state = useWorkspacePathsStore.getState();
    return state.chatWorkspaceRoot ?? state.homeDir ?? null;
  } catch {
    return null;
  }
}

function SuggestionIcon({
  item,
  iconFailed,
  onIconError,
}: {
  readonly item: PluginSuggestionItem;
  readonly iconFailed: boolean;
  readonly onIconError: () => void;
}) {
  if (item.sourceKind === "mcp-connector") {
    const preset = item.connectorPresetId
      ? findMcpConnectorPreset(item.connectorPresetId)
      : undefined;
    return (
      <ConnectorIcon name={preset?.name ?? item.displayName} url={preset?.url} className="size-5" />
    );
  }

  if (item.sourceKind === "moss-service-plugin") {
    const servicePlugin = item.servicePluginId
      ? findMossServicePlugin(item.servicePluginId)
      : undefined;
    if (servicePlugin) {
      const info = mossServicePluginInfo(servicePlugin);
      if (info.connectorUrl) {
        return <ConnectorIcon name={info.name} url={info.connectorUrl} className="size-5" />;
      }
      const FallbackIcon = resolveResourceIcon(info.name, item.shortDescription, PluginIcon);
      return (
        <SiteFavicon
          url={info.iconHost}
          className="size-5"
          fallback={<FallbackIcon aria-hidden="true" className="size-5 text-muted-foreground" />}
        />
      );
    }
  }

  if (item.iconUrl && !iconFailed) {
    return (
      <img
        src={item.iconUrl}
        alt=""
        className="size-5 object-contain"
        loading="lazy"
        onError={onIconError}
      />
    );
  }

  const brand = resolveBrandArtwork([
    item.toolkitSlug,
    item.connectorPresetId,
    item.servicePluginId,
    item.pluginName,
    item.displayName,
  ]);
  if (brand) {
    const BrandIcon = brand.icon;
    return (
      <BrandIcon
        aria-hidden="true"
        className="size-5"
        style={{
          color: readableBrandColor(brand.color) ?? "var(--foreground)",
        }}
      />
    );
  }

  const FallbackIcon = resolveResourceIcon(item.displayName, item.shortDescription, PluginIcon);
  return <FallbackIcon aria-hidden="true" className="size-5 text-muted-foreground" />;
}

export function PluginSuggestionCard({
  payload,
  threadId,
  cwd,
  provider,
  onSendPromptTurn,
  onAccountRequired,
  textFontSizePx,
  metaFontSizePx,
}: {
  payload: PluginSuggestionActivityPayload;
  threadId?: ThreadId | undefined;
  cwd?: string | null | undefined;
  provider?: ProviderKind | undefined;
  onSendPromptTurn?: ((prompt: string) => Promise<boolean>) | undefined;
  onAccountRequired?: ((action: "login" | "account") => void) | undefined;
  textFontSizePx?: number | undefined;
  metaFontSizePx?: number | undefined;
}) {
  const { format, t } = useTranslation();
  const queryClient = useQueryClient();
  const detached = isNativeApiDetached();
  const appsAccount = useMossImagesAccountBoundary();
  const textStyle = textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined;
  const metaStyle = metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined;
  const activeProvider = provider && isSupportedProviderKind(provider) ? provider : "codex";

  const hasMossApp = payload.suggestions.some((item) => item.sourceKind === "moss-app");
  const hasConnectorOrService = payload.suggestions.some(
    (item) => item.sourceKind === "mcp-connector" || item.sourceKind === "moss-service-plugin",
  );
  const hasProviderPlugin = payload.suggestions.some(
    (item) => item.sourceKind === "moss-catalog" || item.sourceKind === "moss-bundled",
  );
  const hasOfficialDeveloperPlugin = payload.suggestions.some(
    (item) => item.pluginId === MOSS_DEVELOPER_PLUGIN_ID,
  );
  const effectiveCwd = cwd ?? resolveFallbackWorkspaceCwd();

  const [mossAppTarget, setMossAppTarget] = useState<MossAppConnectTarget | null>(null);
  const [connectorTarget, setConnectorTarget] = useState<McpConnectorTarget | null>(null);
  const [activeItemPluginId, setActiveItemPluginId] = useState<string | null>(null);
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null);
  const [locallyInstalledPluginIds, setLocallyInstalledPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [justConnectedPluginIds, setJustConnectedPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [continuingPluginId, setContinuingPluginId] = useState<string | null>(null);
  const [continuedPluginIds, setContinuedPluginIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedPluginIds, setExpandedPluginIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failedIcons, setFailedIcons] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissedPluginIds, setDismissedPluginIds] = useState<ReadonlySet<string>>(() =>
    readDismissedSuggestionIds(threadId, payload.suggestionId, payload.suggestions),
  );

  useEffect(() => {
    setDismissedPluginIds(
      readDismissedSuggestionIds(threadId, payload.suggestionId, payload.suggestions),
    );
  }, [payload.suggestionId, payload.suggestions, threadId]);

  const mossAppConnectionsQuery = useQuery(
    mossAppConnectionsQueryOptions({
      enabled: !detached && !appsAccount.transitioning && hasMossApp,
      polling: mossAppTarget !== null,
      accountKey: appsAccount.key,
    }),
  );

  const mcpConnectorsQuery = useQuery({
    ...mcpConnectorsQueryOptions(),
    enabled: !detached && hasConnectorOrService,
  });

  const servicePluginsQuery = useQuery(
    mossServicePluginsQueryOptions({
      enabled: !detached && hasConnectorOrService,
    }),
  );

  const providerPluginsQuery = useQuery({
    ...providerPluginsQueryOptions({
      provider: activeProvider,
      cwd: effectiveCwd,
      marketplaceKinds: ["local"],
      enabled: !detached && hasProviderPlugin && effectiveCwd !== null,
    }),
    retry: false,
  });

  const serverSettingsQuery = useQuery({
    ...serverSettingsQueryOptions(),
    enabled: !detached && hasOfficialDeveloperPlugin,
  });

  const installedOfficialPluginIds = useMemo(() => {
    const ids = new Set<string>();
    if (
      hasOfficialDeveloperPlugin &&
      serverSettingsQuery.data &&
      isMossDeveloperPluginInstalled(serverSettingsQuery.data)
    ) {
      ids.add(MOSS_DEVELOPER_PLUGIN_ID);
    }
    return ids;
  }, [hasOfficialDeveloperPlugin, serverSettingsQuery.data]);

  const connectedToolkitSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const connection of mossAppConnectionsQuery.data?.connections ?? []) {
      if (connection.status === "active") slugs.add(connection.toolkitSlug);
    }
    return slugs;
  }, [mossAppConnectionsQuery.data]);

  const connectedConnectorPresetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const connector of mcpConnectorsQuery.data ?? []) {
      if (connector.status === "connected" && connector.presetId) {
        ids.add(connector.presetId);
      }
    }
    return ids;
  }, [mcpConnectorsQuery.data]);

  const installedServicePluginIds = useMemo(
    () => new Set(servicePluginsQuery.data?.installed ?? []),
    [servicePluginsQuery.data],
  );

  const installedProviderPluginIds = useMemo(() => {
    const ids = new Set<string>();
    for (const marketplace of providerPluginsQuery.data?.marketplaces ?? []) {
      for (const plugin of marketplace.plugins) {
        if (plugin.installed || plugin.enabled) ids.add(plugin.id);
      }
    }
    return ids;
  }, [providerPluginsQuery.data]);

  const installContext = {
    connectedToolkitSlugs,
    connectedConnectorPresetIds,
    installedServicePluginIds,
    installedProviderPluginIds: hasProviderPlugin ? installedProviderPluginIds : EMPTY_SET,
    installedOfficialPluginIds: hasOfficialDeveloperPlugin ? installedOfficialPluginIds : EMPTY_SET,
    locallyInstalledPluginIds,
  };

  const setDismissed = (pluginId: string, dismissed: boolean) => {
    writeSuggestionDismissed(threadId, payload.suggestionId, pluginId, dismissed);
    setDismissedPluginIds((current) => {
      const next = new Set(current);
      if (dismissed) next.add(pluginId);
      else next.delete(pluginId);
      return next;
    });
    if (!detached) {
      void ensureNativeApi()
        .server.getSettings()
        .then((currentSettings) => {
          const dismissedSuggestions = upsertDismissedPluginSuggestion(
            currentSettings.officialPlugins?.dismissedSuggestions,
            pluginId,
            dismissed,
          );
          return ensureNativeApi().server.updateSettings({
            officialPlugins: { dismissedSuggestions },
          });
        })
        .catch(() => {});
    }
  };

  const toggleExpanded = (pluginId: string) => {
    setExpandedPluginIds((current) => {
      const next = new Set(current);
      if (next.has(pluginId)) next.delete(pluginId);
      else next.add(pluginId);
      return next;
    });
  };

  const markLocallyInstalled = (pluginId: string) => {
    setLocallyInstalledPluginIds((current) => {
      if (current.has(pluginId)) return current;
      const next = new Set(current);
      next.add(pluginId);
      return next;
    });
    setJustConnectedPluginIds((current) => {
      if (current.has(pluginId)) return current;
      const next = new Set(current);
      next.add(pluginId);
      return next;
    });
  };

  const handleContinueTask = async (item: PluginSuggestionItem) => {
    if (!onSendPromptTurn || continuingPluginId === item.pluginId) return;
    setContinuingPluginId(item.pluginId);
    try {
      const sent = await onSendPromptTurn(
        format("chat.pluginSuggestion.continuePrompt", { pluginName: item.displayName }),
      );
      if (sent) {
        setContinuedPluginIds((current) => {
          const next = new Set(current);
          next.add(item.pluginId);
          return next;
        });
      }
    } finally {
      setContinuingPluginId((current) => (current === item.pluginId ? null : current));
    }
  };

  const handleInstall = async (item: PluginSuggestionItem) => {
    if (detached) {
      toastManager.add({
        type: "info",
        title: t("chat.pluginSuggestion.detached"),
      });
      return;
    }

    if (item.sourceKind === "moss-app") {
      const slug = item.toolkitSlug ?? item.pluginId.replace(/@moss-apps$/, "");
      setActiveItemPluginId(item.pluginId);
      setMossAppTarget({
        slug,
        name: item.displayName,
        logoUrl: item.iconUrl,
        signIn: item.signIn ?? "managed",
      });
      return;
    }

    if (item.sourceKind === "mcp-connector") {
      const preset = item.connectorPresetId
        ? findMcpConnectorPreset(item.connectorPresetId)
        : undefined;
      if (!preset) {
        toastManager.add({
          type: "error",
          title: t("chat.pluginSuggestion.installFailed"),
        });
        return;
      }
      setActiveItemPluginId(item.pluginId);
      setConnectorTarget(mcpConnectorPresetTarget(preset));
      return;
    }

    if (item.sourceKind === "moss-service-plugin") {
      if (item.connectorPresetId) {
        const preset = findMcpConnectorPreset(item.connectorPresetId);
        if (preset) {
          setActiveItemPluginId(item.pluginId);
          setConnectorTarget(mcpConnectorPresetTarget(preset));
          return;
        }
      }
      const servicePluginId =
        item.servicePluginId ?? item.pluginId.replace(/@moss-connector-apps$/, "");
      setInstallingPluginId(item.pluginId);
      try {
        await ensureNativeApi().server.setMossServicePluginInstalled({
          pluginId: servicePluginId,
          installed: true,
        });
        markLocallyInstalled(item.pluginId);
        await queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY });
        toastManager.add({
          type: "success",
          title: format("plugins.install.success", { pluginName: item.displayName }),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("chat.pluginSuggestion.installFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setInstallingPluginId((current) => (current === item.pluginId ? null : current));
      }
      return;
    }

    if (item.pluginId === MOSS_DEVELOPER_PLUGIN_ID) {
      setInstallingPluginId(item.pluginId);
      try {
        const api = ensureNativeApi();
        const currentSettings =
          serverSettingsQuery.data ?? (await api.server.getSettings().catch(() => null));
        const uninstalled = nextOfficialPluginsUninstalled(
          currentSettings?.officialPlugins?.uninstalled,
          MOSS_DEVELOPER_PLUGIN_ID,
          true,
        );
        const nextSettings = await api.server.updateSettings({
          officialPlugins: { uninstalled },
        });
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        if (effectiveCwd) {
          const listing =
            providerPluginsQuery.data ??
            (await api.provider
              .listPlugins({
                provider: activeProvider,
                cwd: effectiveCwd,
              })
              .catch(() => null));
          const selector = listing
            ? resolveProviderInstallMarketplaceSelector(item, listing.marketplaces)
            : null;
          if (selector) {
            await api.provider
              .installPlugin({
                provider: activeProvider,
                cwd: effectiveCwd,
                pluginName: item.pluginName ?? "moss-developer",
                ...selector,
              })
              .catch(() => {});
          }
        }
        markLocallyInstalled(item.pluginId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() }),
          queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
        ]);
        toastManager.add({
          type: "success",
          title: format("plugins.install.success", { pluginName: item.displayName }),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("chat.pluginSuggestion.installFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setInstallingPluginId((current) => (current === item.pluginId ? null : current));
      }
      return;
    }

    if (!effectiveCwd) {
      toastManager.add({
        type: "error",
        title: t("plugins.toast.noWorkspaceTitle"),
        description: t("chat.pluginSuggestion.noWorkspace"),
      });
      return;
    }

    setInstallingPluginId(item.pluginId);
    try {
      const listing =
        providerPluginsQuery.data ??
        (await ensureNativeApi().provider.listPlugins({
          provider: activeProvider,
          cwd: effectiveCwd,
        }));
      const selector = resolveProviderInstallMarketplaceSelector(item, listing.marketplaces);
      if (!selector) {
        throw new Error(`No marketplace found for ${item.pluginId}`);
      }
      await ensureNativeApi().provider.installPlugin({
        provider: activeProvider,
        cwd: effectiveCwd,
        pluginName: item.pluginName ?? item.pluginId.split("@")[0] ?? item.pluginId,
        ...selector,
      });
      markLocallyInstalled(item.pluginId);
      await queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
      toastManager.add({
        type: "success",
        title: format("plugins.install.success", { pluginName: item.displayName }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("chat.pluginSuggestion.installFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstallingPluginId((current) => (current === item.pluginId ? null : current));
    }
  };

  return (
    <section
      data-testid="plugin-suggestion-card"
      data-suggestion-id={payload.suggestionId}
      aria-label={t("chat.pluginSuggestion.heading")}
      className="my-1.5 space-y-1.5"
    >
      <p
        className="flex min-w-0 items-center gap-1.5 text-ui-sm text-[var(--color-text-foreground-secondary,var(--muted-foreground))]"
        style={metaStyle}
      >
        <MossLogo className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t("chat.pluginSuggestion.heading")}</span>
      </p>

      <div className="divide-y divide-[color:var(--color-border-light,var(--border))] overflow-hidden rounded-card border border-[color:var(--color-border-light,var(--border))] bg-[var(--color-background-elevated-primary,var(--card))]">
        {payload.suggestions.map((item) => {
          const isDismissed = dismissedPluginIds.has(item.pluginId);
          const installState = resolveSuggestionInstallState(item, installContext);
          const installing = installingPluginId === item.pluginId;
          const expanded = expandedPluginIds.has(item.pluginId);
          const showContinue =
            installState !== "available" &&
            justConnectedPluginIds.has(item.pluginId) &&
            onSendPromptTurn !== undefined &&
            !continuedPluginIds.has(item.pluginId);
          const authNoteKey =
            item.requiresAuth && item.signIn === "credentials"
              ? "chat.pluginSuggestion.authCredentials"
              : item.requiresAuth
                ? "chat.pluginSuggestion.authOAuth"
                : "chat.pluginSuggestion.authNone";

          return (
            <div
              key={item.pluginId}
              data-testid={`plugin-suggestion-item-${item.pluginId}`}
              className="px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <HitArea
                  type="button"
                  aria-expanded={expanded}
                  aria-label={
                    expanded
                      ? t("chat.pluginSuggestion.previewCollapse")
                      : t("chat.pluginSuggestion.previewExpand")
                  }
                  onClick={() => toggleExpanded(item.pluginId)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left"
                >
                  <PluginLibraryCardIconBox className="size-10 bg-[var(--color-background-surface,var(--background))]">
                    <SuggestionIcon
                      item={item}
                      iconFailed={failedIcons.has(item.pluginId)}
                      onIconError={() =>
                        setFailedIcons((current) => {
                          if (current.has(item.pluginId)) return current;
                          const next = new Set(current);
                          next.add(item.pluginId);
                          return next;
                        })
                      }
                    />
                  </PluginLibraryCardIconBox>

                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div
                      className="flex items-center gap-1.5 text-ui font-medium text-[var(--color-text-foreground,var(--foreground))]"
                      style={textStyle}
                    >
                      <span className="truncate">{item.displayName}</span>
                      {expanded ? (
                        <ChevronDownIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-[var(--color-text-foreground-secondary,var(--muted-foreground))]"
                        />
                      ) : (
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-[var(--color-text-foreground-secondary,var(--muted-foreground))]"
                        />
                      )}
                    </div>
                    <div
                      className="truncate text-ui-sm text-[var(--color-text-foreground-secondary,var(--muted-foreground))]"
                      style={metaStyle}
                    >
                      {isDismissed
                        ? t("chat.pluginSuggestion.dismissed")
                        : formatPluginSuggestionMeta(
                            item,
                            t("chat.pluginSuggestion.developerPrefix"),
                          )}
                    </div>
                  </div>
                </HitArea>

                <div className="flex shrink-0 items-center gap-2">
                  {isDismissed ? (
                    <TextAction
                      type="button"
                      size="xs"
                      onClick={() => setDismissed(item.pluginId, false)}
                    >
                      {t("chat.pluginSuggestion.undo")}
                    </TextAction>
                  ) : installState !== "available" ? (
                    <>
                      <Badge variant="success" size="lg" className="gap-1 px-2 font-normal">
                        <CheckIcon aria-hidden="true" className="size-3.5" />
                        {installState === "connected"
                          ? t("chat.pluginSuggestion.connected")
                          : t("chat.pluginSuggestion.installed")}
                      </Badge>
                      {showContinue ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="px-2.5"
                          disabled={continuingPluginId === item.pluginId}
                          onClick={() => void handleContinueTask(item)}
                        >
                          {continuingPluginId === item.pluginId ? (
                            <>
                              <Spinner className="size-3.5" aria-hidden />
                              {t("chat.pluginSuggestion.continuing")}
                            </>
                          ) : (
                            t("chat.pluginSuggestion.continue")
                          )}
                        </Button>
                      ) : continuedPluginIds.has(item.pluginId) ? (
                        <span
                          className="text-ui-xs text-[var(--color-text-foreground-secondary,var(--muted-foreground))]"
                          style={metaStyle}
                        >
                          {t("chat.pluginSuggestion.continued")}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <TextAction
                        type="button"
                        size="xs"
                        disabled={installing}
                        onClick={() => setDismissed(item.pluginId, true)}
                      >
                        {t("chat.pluginSuggestion.notNow")}
                      </TextAction>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="px-3"
                        disabled={installing}
                        onClick={() => void handleInstall(item)}
                      >
                        {installing ? (
                          <>
                            <Spinner className="size-3.5" aria-hidden />
                            {t("chat.pluginSuggestion.installing")}
                          </>
                        ) : (
                          t("chat.pluginSuggestion.install")
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {expanded ? (
                <div
                  data-testid={`plugin-suggestion-preview-${item.pluginId}`}
                  className="mt-2.5 border-t border-[color:var(--color-border-light,var(--border))] pt-2.5 pl-[52px] text-ui-sm text-[var(--color-text-foreground-secondary,var(--muted-foreground))]"
                  style={metaStyle}
                >
                  <p className="text-[var(--color-text-foreground,var(--foreground))]/90">
                    {item.shortDescription}
                  </p>
                  <p className="mt-1">{t(authNoteKey)}</p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {!detached ? (
        <>
          <MossAppConnectDialog
            target={mossAppTarget}
            onOpenChange={(open) => {
              if (!open) {
                setMossAppTarget(null);
                setActiveItemPluginId(null);
                void queryClient.invalidateQueries({ queryKey: MOSS_APP_CONNECTIONS_QUERY_KEY });
              }
            }}
            onConnected={() => {
              if (activeItemPluginId) {
                markLocallyInstalled(activeItemPluginId);
                setActiveItemPluginId(null);
              }
              setMossAppTarget(null);
              void queryClient.invalidateQueries({ queryKey: MOSS_APP_CONNECTIONS_QUERY_KEY });
            }}
            {...(onAccountRequired
              ? {
                  onAccountRequired: (action) => {
                    setMossAppTarget(null);
                    setActiveItemPluginId(null);
                    onAccountRequired(action);
                  },
                }
              : {})}
          />
          <McpConnectorConnectDialog
            target={connectorTarget}
            onOpenChange={(open) => {
              if (!open) {
                setConnectorTarget(null);
                setActiveItemPluginId(null);
              }
            }}
            onConnected={(connector) => {
              setConnectorTarget(null);
              if (activeItemPluginId) {
                markLocallyInstalled(activeItemPluginId);
                setActiveItemPluginId(null);
              }
              void queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY });
              void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
              toastManager.add({
                type: "success",
                title: format("plugins.install.success", { pluginName: connector.name }),
              });
            }}
          />
        </>
      ) : null}
    </section>
  );
}
