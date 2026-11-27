// FILE: PageAppList.tsx
// Purpose: Unified 资料空间 catalog for local 应用页: uses Moss's 资料空间 visual language
//          (RouteSurface, PAGE_TITLE_CLASS_NAME, Filter menu, Grid/List segmented toggle,
//          SpaceMasonryGrid, SpaceItemCard styling, SpaceInlineRename, SpaceTrash rows).
// Layer: Web pageApps

import type { InstalledDesktopPageApp, PageApp, PageAppPublicationSummary } from "@moss/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { SidebarIconButton } from "~/components/SidebarIconButton";
import { SpaceInlineRename } from "~/components/space/SpaceInlineRename";
import { SpaceListHeader } from "~/components/space/SpaceItemCard";
import { SpaceMasonryGrid } from "~/components/space/SpaceMasonryGrid";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  AppsIcon,
  CheckIcon,
  EllipsisIcon,
  FilterIcon,
  FolderOpenIcon,
  LayoutGridIcon,
  ListBulletsIcon,
  LockIcon,
  MoreHorizontalIcon,
  PinFilledIcon,
  PopOutIcon,
  RotateCcwIcon,
  SparklesIcon,
  StarFilledIcon,
  StarIcon,
  TrashCanIcon,
  WindowAppIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

import { getDesktopPageAppsBridge, readDeclaredDesktopPermissions } from "./capabilities/desktop";
import { generateAndSavePageAppCover } from "./pageAppCover";
import { pageAppsClient } from "./pageAppsClient";
import { PageAppThumbnail } from "./PageAppThumbnail";

const VIEW_STORAGE_KEY = "moss:apps:view";

type AppFilter = "all" | "installed" | "published";
type AppSort = "updated" | "created" | "title";
type AppView = "grid" | "list";

const FILTER_LABELS: Record<AppFilter, string> = {
  all: "全部应用",
  installed: "已安装",
  published: "已分享发布",
};

const SORT_OPTIONS: ReadonlyArray<{ readonly id: AppSort; readonly label: string }> = [
  { id: "updated", label: "最近更新" },
  { id: "created", label: "最近创建" },
  { id: "title", label: "标题排序" },
];

export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function PageAppList() {
  const desktopBridge = getDesktopPageAppsBridge();
  const [apps, setApps] = useState<readonly PageApp[] | null>(null);
  const [publishedByAppId, setPublishedByAppId] = useState<
    ReadonlyMap<string, PageAppPublicationSummary>
  >(() => new Map());
  const [filter, setFilter] = useState<AppFilter>("all");
  const [sort, setSort] = useState<AppSort>("updated");
  const [view, setView] = useState<AppView>(() =>
    typeof window !== "undefined" && window.localStorage?.getItem(VIEW_STORAGE_KEY) === "list"
      ? "list"
      : "grid",
  );
  const [showTrash, setShowTrash] = useState(false);
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [installedByAppId, setInstalledByAppId] = useState<
    ReadonlyMap<string, InstalledDesktopPageApp>
  >(() => new Map());
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const [generatingCoverAppId, setGeneratingCoverAppId] = useState<string | null>(null);

  const changeView = (next: AppView) => {
    setView(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage?.setItem(VIEW_STORAGE_KEY, next);
      } catch {
        // Ignore storage restriction.
      }
    }
  };

  const load = useCallback(async () => {
    try {
      const [result, pubResult] = await Promise.all([
        pageAppsClient.list({ scopeSpaceId: null, includeTrashed: showTrash }),
        typeof pageAppsClient.listPublished === "function"
          ? pageAppsClient.listPublished({ scopeSpaceId: null }).catch(() => ({ publications: [] }))
          : Promise.resolve({ publications: [] }),
      ]);
      setApps(
        result.apps.filter((app) => (showTrash ? app.trashedAt !== null : app.trashedAt === null)),
      );
      setPublishedByAppId(new Map(pubResult.publications.map((p) => [p.appId, p])));
      setError(null);
    } catch (cause) {
      setError((cause as { message?: string }).message ?? "无法读取应用页");
    }
  }, [showTrash]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!desktopBridge) {
      setDesktopAvailable(false);
      setInstalledByAppId(new Map());
      return;
    }
    let cancelled = false;
    const syncInstalled = async () => {
      const available = await desktopBridge.isAvailable().catch(() => false);
      if (cancelled) return;
      setDesktopAvailable(available);
      if (!available) {
        setInstalledByAppId(new Map());
        return;
      }
      const installed = await desktopBridge.listInstalled().catch(() => []);
      if (!cancelled) {
        setInstalledByAppId(new Map(installed.map((item) => [item.appId, item])));
      }
    };
    void syncInstalled();
    const unsubscribe =
      typeof desktopBridge.onInstalledChanged === "function"
        ? desktopBridge.onInstalledChanged((installed) => {
            setInstalledByAppId(new Map(installed.map((item) => [item.appId, item])));
          })
        : () => undefined;
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [desktopBridge]);

  const handleDesktopAction = async (
    app: PageApp,
    installed: InstalledDesktopPageApp | undefined,
    anchor: HTMLElement | null,
  ) => {
    if (!desktopBridge) return;
    if (installed) {
      await desktopBridge
        .openInstalled({
          appId: app.id,
          installId: installed.installId,
          title: app.title,
          revision: app.revision,
          capabilities: app.capabilities,
        })
        .catch(() => undefined);
      return;
    }
    const rect = anchor?.getBoundingClientRect();
    setInstallingAppId(app.id);
    try {
      const result = await desktopBridge.installFromPage({
        appId: app.id,
        title: app.title,
        revision: app.revision,
        scopeSpaceId: app.scopeSpaceId,
        thumbnail: app.thumbnail,
        capabilities: app.capabilities,
        ...(rect
          ? {
              sourceRect: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              },
            }
          : {}),
      });
      if (result.app) {
        const record = result.app;
        setInstalledByAppId((prev) => {
          const next = new Map(prev);
          next.set(record.appId, record);
          return next;
        });
      }
    } finally {
      setInstallingAppId(null);
    }
  };

  const commitRename = async (app: PageApp, nextTitle: string) => {
    const title = nextTitle.trim();
    setRenamingAppId(null);
    if (!title || title === app.title) return;
    const base = { requestId: crypto.randomUUID(), appId: app.id, expectedRevision: app.revision };
    const updated = await pageAppsClient.mutate({ op: "rename", ...base, title });
    const installed = installedByAppId.get(app.id);
    if (desktopBridge && installed) {
      void desktopBridge
        .syncAppVersion({
          appId: app.id,
          revision: updated.app.revision,
          title: updated.app.title,
          capabilities: updated.app.capabilities,
        })
        .catch(() => undefined);
    }
    await load();
  };

  const mutate = async (app: PageApp, change: "favorite" | "trash" | "restore") => {
    const base = { requestId: crypto.randomUUID(), appId: app.id, expectedRevision: app.revision };
    const installed = installedByAppId.get(app.id);
    if (change === "favorite") {
      await pageAppsClient.mutate({ op: "favorite", ...base, favorite: !app.favorite });
    } else {
      await pageAppsClient.mutate({ op: change, ...base });
      if (change === "trash" && desktopBridge && installed) {
        void desktopBridge
          .uninstall({ appId: app.id, installId: installed.installId, skipConfirm: true })
          .catch(() => undefined);
      }
    }
    await load();
  };

  const handleGenerateCover = async (app: PageApp) => {
    if (generatingCoverAppId) return;
    setGeneratingCoverAppId(app.id);
    setError(null);
    try {
      const updated = await generateAndSavePageAppCover(app);
      setApps((prev) =>
        prev ? prev.map((item) => (item.id === updated.id ? updated : item)) : prev,
      );
    } catch (cause) {
      setError((cause as { message?: string }).message ?? "封面生成失败。");
    } finally {
      setGeneratingCoverAppId((current) => (current === app.id ? null : current));
    }
  };

  const handleResetCover = async (app: PageApp) => {
    if (generatingCoverAppId) return;
    setGeneratingCoverAppId(app.id);
    setError(null);
    try {
      const updated = await pageAppsClient.mutate({
        op: "set-thumbnail",
        requestId: crypto.randomUUID(),
        appId: app.id,
        expectedRevision: app.revision,
        thumbnail: null,
      });
      setApps((prev) =>
        prev ? prev.map((item) => (item.id === updated.app.id ? updated.app : item)) : prev,
      );
    } catch (cause) {
      setError((cause as { message?: string }).message ?? "无法重置封面。");
    } finally {
      setGeneratingCoverAppId((current) => (current === app.id ? null : current));
    }
  };

  const visibleApps = useMemo(() => {
    if (!apps) return null;
    const filtered = apps.filter((app) => {
      if (showTrash) return true;
      if (filter === "installed") return installedByAppId.has(app.id);
      if (filter === "published") return publishedByAppId.has(app.id);
      return true;
    });
    return filtered.toSorted((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      if (sort === "title") return a.title.localeCompare(b.title, "zh-Hans-CN");
      if (sort === "created") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }, [apps, filter, installedByAppId, publishedByAppId, showTrash, sort]);

  const hasActiveFilter = filter !== "all" || sort !== "updated";

  const renderCardMenuItems = (app: PageApp, installed: InstalledDesktopPageApp | undefined) => {
    const hasDesktopShortcut = Boolean(installed?.places.includes("desktop"));
    return (
      <>
        {desktopAvailable && installed ? (
          <>
            <MenuItem
              onClick={() =>
                void desktopBridge
                  ?.openInstalled({
                    appId: app.id,
                    installId: installed.installId,
                    title: app.title,
                    revision: app.revision,
                    capabilities: app.capabilities,
                  })
                  .catch(() => undefined)
              }
            >
              <PopOutIcon aria-hidden className="size-4" />
              <span>打开应用</span>
            </MenuItem>
            <MenuItem
              onClick={() =>
                void desktopBridge
                  ?.openPermissions({
                    appId: app.id,
                    installId: installed.installId,
                    title: app.title,
                    revision: app.revision,
                    permissions: readDeclaredDesktopPermissions(app.capabilities),
                  })
                  .catch(() => undefined)
              }
            >
              <LockIcon aria-hidden className="size-4" />
              <span>桌面权限…</span>
            </MenuItem>
            <MenuItem
              onClick={() =>
                void desktopBridge
                  ?.showInFolder({
                    appId: app.id,
                    installId: installed.installId,
                  })
                  .catch(() => undefined)
              }
            >
              <FolderOpenIcon aria-hidden className="size-4" />
              <span>在文件夹中显示</span>
            </MenuItem>
            {desktopBridge?.setDesktopShortcut ? (
              <MenuItem
                onClick={() =>
                  void desktopBridge
                    .setDesktopShortcut?.({
                      appId: app.id,
                      installId: installed.installId,
                      enabled: !hasDesktopShortcut,
                    })
                    .catch(() => undefined)
                }
                data-testid={`page-app-card-desktop-shortcut-${app.id}`}
              >
                <AppsIcon aria-hidden className="size-4" />
                <span>{hasDesktopShortcut ? "从桌面移除" : "添加到桌面"}</span>
              </MenuItem>
            ) : null}
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem
          disabled={generatingCoverAppId === app.id}
          onClick={() => void handleGenerateCover(app)}
          data-testid={`page-app-card-generate-cover-${app.id}`}
        >
          <SparklesIcon aria-hidden className="size-4" />
          <span>{generatingCoverAppId === app.id ? "正在生成封面…" : "AI 生成封面"}</span>
        </MenuItem>
        {app.thumbnail ? (
          <MenuItem
            disabled={generatingCoverAppId === app.id}
            onClick={() => void handleResetCover(app)}
            data-testid={`page-app-card-reset-cover-${app.id}`}
          >
            <RotateCcwIcon aria-hidden className="size-4" />
            <span>恢复实时预览</span>
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => void mutate(app, "favorite")}>
          {app.favorite ? (
            <StarFilledIcon aria-hidden className="size-4" />
          ) : (
            <StarIcon aria-hidden className="size-4" />
          )}
          <span>{app.favorite ? "取消收藏" : "收藏"}</span>
        </MenuItem>
        <MenuItem onClick={() => setRenamingAppId(app.id)}>
          <span>重命名</span>
        </MenuItem>
        <MenuSeparator />
        {desktopAvailable && installed ? (
          <MenuItem
            variant="destructive"
            onClick={() =>
              void desktopBridge
                ?.uninstall({
                  appId: app.id,
                  installId: installed.installId,
                })
                .then((result) => {
                  if (result?.uninstalled) {
                    setInstalledByAppId((prev) => {
                      const next = new Map(prev);
                      next.delete(app.id);
                      return next;
                    });
                  }
                })
                .catch(() => undefined)
            }
          >
            <TrashCanIcon aria-hidden className="size-4" />
            <span>卸载应用…</span>
          </MenuItem>
        ) : null}
        <MenuItem variant="destructive" onClick={() => void mutate(app, "trash")}>
          <TrashCanIcon aria-hidden className="size-4" />
          <span>移到回收站</span>
        </MenuItem>
      </>
    );
  };

  const renderBadges = (app: PageApp, installed: InstalledDesktopPageApp | undefined) => {
    const published = publishedByAppId.has(app.id);
    if (!app.starterId && !(desktopAvailable && installed) && !published) return null;
    return (
      <span className="flex shrink-0 items-center gap-1">
        {app.starterId ? (
          <Badge size="sm" variant="secondary" data-testid={`page-app-starter-badge-${app.id}`}>
            示例
          </Badge>
        ) : null}
        {desktopAvailable && installed ? (
          <Badge size="sm" variant="success" data-testid={`page-app-installed-badge-${app.id}`}>
            已安装
          </Badge>
        ) : null}
        {published ? (
          <Badge size="sm" variant="outline" data-testid={`page-app-published-badge-${app.id}`}>
            已分享
          </Badge>
        ) : null}
      </span>
    );
  };

  return (
    <RouteSurface>
      <RouteSurfaceHeader divider={false} />
      <div className="flex min-h-0 flex-1 flex-col" data-page-app-hub>
        <header className="flex items-center gap-1.5 px-6 pt-3 pb-4 md:px-10 md:pt-4">
          <div className="min-w-0 flex-1">
            <h1 className={cn(PAGE_TITLE_CLASS_NAME, "truncate")}>
              {showTrash ? "回收站" : "应用页"}
            </h1>
          </div>
          {!showTrash ? (
            <>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size={hasActiveFilter ? "sm" : "icon-sm"}
                      variant="ghost"
                      aria-label={
                        filter !== "all" ? `筛选：${FILTER_LABELS[filter]}` : "排序与筛选"
                      }
                      data-pressed={hasActiveFilter ? "" : undefined}
                      data-testid="page-app-filter-trigger"
                    >
                      <FilterIcon aria-hidden className="size-4" />
                      {hasActiveFilter
                        ? filter !== "all"
                          ? FILTER_LABELS[filter]
                          : "已筛选"
                        : null}
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup align="end" className="w-48 min-w-48">
                  <MenuGroup>
                    <MenuGroupLabel>排序方式</MenuGroupLabel>
                    {SORT_OPTIONS.map((entry) => (
                      <MenuItem key={entry.id} onClick={() => setSort(entry.id)}>
                        <span className="flex-1">{entry.label}</span>
                        {sort === entry.id ? <CheckIcon aria-hidden className="size-4" /> : null}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>应用状态</MenuGroupLabel>
                    {(["all", "installed", "published"] as const).map((id) => (
                      <MenuItem
                        key={id}
                        onClick={() => setFilter(id)}
                        data-testid={`page-app-filter-${id}`}
                      >
                        <span className="flex-1">{FILTER_LABELS[id]}</span>
                        {filter === id ? <CheckIcon aria-hidden className="size-4" /> : null}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                  {hasActiveFilter ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        onClick={() => {
                          setFilter("all");
                          setSort("updated");
                        }}
                      >
                        重置筛选条件
                      </MenuItem>
                    </>
                  ) : null}
                </ComposerPickerMenuPopup>
              </Menu>
              <div className="flex items-center rounded-control bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5">
                {(
                  [
                    ["grid", "网格视图", LayoutGridIcon],
                    ["list", "列表视图", ListBulletsIcon],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <IconButton
                    key={id}
                    variant="ghost"
                    size="icon-xs"
                    label={label}
                    tooltip={label}
                    aria-pressed={view === id}
                    data-testid={`page-app-view-${id}`}
                    className={cn(
                      "size-6 rounded-inline text-muted-foreground",
                      view === id
                        ? "bg-background text-foreground shadow-xs"
                        : "hover:text-foreground",
                    )}
                    onClick={() => changeView(id)}
                  >
                    <Icon aria-hidden className="size-4" />
                  </IconButton>
                ))}
              </div>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setShowTrash((value) => !value)}
            data-testid="page-app-trash-toggle"
          >
            {showTrash ? "返回" : "回收站"}
          </Button>
        </header>

        {error ? (
          <p role="alert" className="px-6 pb-2 text-ui text-destructive md:px-10">
            {error}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 md:px-10">
          {visibleApps && visibleApps.length === 0 ? (
            <p className="py-24 text-center text-ui text-muted-foreground">这里还没有内容</p>
          ) : visibleApps && showTrash ? (
            <ul className="flex flex-col gap-0.5" aria-label="回收站中的应用页">
              {visibleApps.map((app) => (
                <li
                  key={app.id}
                  data-testid={`page-app-card-${app.id}`}
                  className="flex h-10 items-center gap-3 rounded-row px-2 hover:bg-accent"
                >
                  <AppsIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-ui">{app.title}</span>
                  <span className="shrink-0 text-ui-sm text-muted-foreground">
                    {relativeTime(app.updatedAt)}更新
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => void mutate(app, "restore")}>
                    <RotateCcwIcon aria-hidden className="size-3.5" />
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          ) : visibleApps && view === "list" ? (
            <div role="grid" aria-label="应用页列表" className="flex flex-col">
              <SpaceListHeader />
              {visibleApps.map((app) => {
                const installed = installedByAppId.get(app.id);
                const renaming = renamingAppId === app.id;
                return (
                  <div
                    key={app.id}
                    role="row"
                    data-testid={`page-app-card-${app.id}`}
                    className="group/space-item flex h-10 items-center gap-3 rounded-row px-2 hover:bg-accent"
                  >
                    {renaming ? (
                      <span role="gridcell" className="flex min-w-0 flex-1 items-center gap-2.5">
                        <AppsIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <SpaceInlineRename
                          value={app.title}
                          label="名称"
                          onCommit={(title) => void commitRename(app, title)}
                          onDone={() => setRenamingAppId(null)}
                          className="flex-1"
                        />
                      </span>
                    ) : (
                      <Link
                        to="/apps/$appId"
                        params={{ appId: app.id }}
                        role="gridcell"
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <AppsIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-ui">{app.title}</span>
                        {app.favorite ? (
                          <PinFilledIcon
                            aria-label="已收藏"
                            className="size-3 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                      </Link>
                    )}
                    <span
                      role="gridcell"
                      className="flex w-24 shrink-0 items-center gap-1 max-sm:hidden"
                    >
                      {renderBadges(app, installed) ?? (
                        <span className="truncate text-ui-sm text-muted-foreground">应用</span>
                      )}
                    </span>
                    <span
                      role="gridcell"
                      className="w-36 shrink-0 truncate text-ui-sm text-muted-foreground max-md:hidden"
                    >
                      {desktopAvailable ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="h-6 rounded-control px-1.5 text-ui-sm font-normal text-foreground/80 hover:text-foreground"
                          disabled={installingAppId === app.id}
                          onClick={(event) =>
                            void handleDesktopAction(app, installed, event.currentTarget)
                          }
                          data-testid={`page-app-card-desktop-action-${app.id}`}
                        >
                          {installed ? "打开桌面应用" : "安装为应用"}
                        </Button>
                      ) : (
                        "个人"
                      )}
                    </span>
                    <span
                      role="gridcell"
                      className="w-20 shrink-0 text-end text-ui-sm text-muted-foreground"
                    >
                      {relativeTime(app.updatedAt)}
                    </span>
                    <span role="gridcell" className="w-6 shrink-0">
                      <Menu>
                        <SidebarIconButton
                          render={<MenuTrigger />}
                          icon={EllipsisIcon}
                          label={`${app.title} 的操作`}
                          size="lg"
                          {...(desktopAvailable
                            ? { "data-testid": `page-app-card-desktop-menu-trigger-${app.id}` }
                            : {})}
                        />
                        <ComposerPickerMenuPopup align="end" className="w-48 min-w-48">
                          {renderCardMenuItems(app, installed)}
                        </ComposerPickerMenuPopup>
                      </Menu>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : visibleApps ? (
            <SpaceMasonryGrid data-space-grid>
              {visibleApps.map((app) => {
                const installed = installedByAppId.get(app.id);
                const renaming = renamingAppId === app.id;
                return {
                  key: app.id,
                  node: (
                    <div
                      data-testid={`page-app-card-${app.id}`}
                      className="group/space-item relative flex flex-col overflow-hidden rounded-panel border border-border/80 bg-card shadow-xs transition-[box-shadow,border-color] hover:border-border hover:shadow-md"
                    >
                      <Link
                        to="/apps/$appId"
                        params={{ appId: app.id }}
                        className="block outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <PageAppThumbnail app={app} generating={generatingCoverAppId === app.id} />
                      </Link>
                      <div className="flex min-h-15 min-w-0 flex-col justify-center gap-1 px-3 py-2.5">
                        <div
                          className={cn(
                            "flex min-w-0 items-center gap-1.5",
                            !desktopAvailable && "pr-6",
                          )}
                        >
                          <AppsIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                          {renaming ? (
                            <SpaceInlineRename
                              value={app.title}
                              label="名称"
                              onCommit={(title) => void commitRename(app, title)}
                              onDone={() => setRenamingAppId(null)}
                              className="flex-1"
                            />
                          ) : (
                            <Link
                              to="/apps/$appId"
                              params={{ appId: app.id }}
                              className="min-w-0 flex-1 truncate text-ui font-medium text-foreground"
                            >
                              {app.title}
                            </Link>
                          )}
                          {app.favorite ? (
                            <PinFilledIcon
                              aria-label="已收藏"
                              className="size-3 shrink-0 text-muted-foreground"
                            />
                          ) : null}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-ui-xs text-muted-foreground">
                          {renderBadges(app, installed)}
                          <span className="truncate">{relativeTime(app.updatedAt)}更新</span>
                        </div>
                      </div>
                      {desktopAvailable ? (
                        <div className="flex h-9 items-center justify-between gap-2 border-t border-border/60 px-2.5">
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-7 gap-1.5 rounded-control px-2 text-ui-xs font-medium text-foreground/85 hover:bg-accent hover:text-foreground"
                            disabled={installingAppId === app.id}
                            onClick={(event) =>
                              void handleDesktopAction(app, installed, event.currentTarget)
                            }
                            data-testid={`page-app-card-desktop-action-${app.id}`}
                          >
                            {installed ? (
                              <PopOutIcon aria-hidden className="size-3.5" />
                            ) : (
                              <WindowAppIcon aria-hidden className="size-3.5" />
                            )}
                            <span>{installed ? "打开桌面应用" : "安装为应用"}</span>
                          </Button>
                          <Menu>
                            <SidebarIconButton
                              render={<MenuTrigger />}
                              icon={MoreHorizontalIcon}
                              label="更多操作"
                              size="lg"
                              data-testid={`page-app-card-desktop-menu-trigger-${app.id}`}
                            />
                            <ComposerPickerMenuPopup
                              align="end"
                              className="w-48 min-w-48"
                              data-testid={`page-app-card-desktop-menu-popup-${app.id}`}
                            >
                              {renderCardMenuItems(app, installed)}
                            </ComposerPickerMenuPopup>
                          </Menu>
                        </div>
                      ) : (
                        <span className="absolute top-2 right-2 rounded-control bg-card/90 backdrop-blur-sm opacity-0 group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100 has-[[data-popup-open]]:opacity-100">
                          <Menu>
                            <SidebarIconButton
                              render={<MenuTrigger />}
                              icon={EllipsisIcon}
                              label={`${app.title} 的操作`}
                              size="lg"
                            />
                            <ComposerPickerMenuPopup align="end" className="w-48 min-w-48">
                              {renderCardMenuItems(app, installed)}
                            </ComposerPickerMenuPopup>
                          </Menu>
                        </span>
                      )}
                    </div>
                  ),
                };
              })}
            </SpaceMasonryGrid>
          ) : null}
        </div>
      </div>
    </RouteSurface>
  );
}
