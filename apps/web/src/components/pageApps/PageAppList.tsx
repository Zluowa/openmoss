// FILE: PageAppList.tsx
// Purpose: Cards for the local 应用页: open, install/open as desktop app,
// favorite, rename, trash/restore.
// The 资料空间 home can list the same items by kind through pageAppsClient.
// Layer: Web pageApps

import type { InstalledDesktopPageApp, PageApp } from "@moss/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import {
  FolderOpenIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PopOutIcon,
  RotateCcwIcon,
  StarFilledIcon,
  StarIcon,
  TrashCanIcon,
} from "~/lib/icons";

import { getDesktopPageAppsBridge, readDeclaredDesktopPermissions } from "./capabilities/desktop";
import { pageAppsClient } from "./pageAppsClient";
import { PageAppThumbnail } from "./PageAppThumbnail";

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
  const [showTrash, setShowTrash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [installedByAppId, setInstalledByAppId] = useState<
    ReadonlyMap<string, InstalledDesktopPageApp>
  >(() => new Map());
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await pageAppsClient.list({ scopeSpaceId: null, includeTrashed: showTrash });
      setApps(
        result.apps.filter((app) => (showTrash ? app.trashedAt !== null : app.trashedAt === null)),
      );
      setError(null);
    } catch (cause) {
      setError((cause as { message?: string }).message ?? "无法读取应用页。");
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

  const mutate = async (app: PageApp, change: "favorite" | "trash" | "restore" | "rename") => {
    const base = { requestId: crypto.randomUUID(), appId: app.id, expectedRevision: app.revision };
    if (change === "rename") {
      const title = window.prompt("重命名应用页", app.title)?.trim();
      if (!title || title === app.title) return;
      await pageAppsClient.mutate({ op: "rename", ...base, title });
    } else if (change === "favorite") {
      await pageAppsClient.mutate({ op: "favorite", ...base, favorite: !app.favorite });
    } else {
      await pageAppsClient.mutate({ op: change, ...base });
    }
    await load();
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The shared route header: it keeps clear of the title-bar controls, drags the window
          and leaves room for the window's buttons, as every rail page's header does (R-9). */}
      <RouteSurfaceHeader divider={false}>
        <h1 className="min-w-0 flex-1 truncate text-ui-lg font-medium">
          {showTrash ? "回收站中的应用页" : "应用页"}
        </h1>
        <Button variant="ghost" size="sm" onClick={() => setShowTrash((value) => !value)}>
          {showTrash ? "返回" : "回收站"}
        </Button>
      </RouteSurfaceHeader>
      {error ? <p className="px-5 text-ui text-destructive">{error}</p> : null}
      {apps && apps.length === 0 ? (
        <p className="px-5 text-ui text-[var(--color-text-foreground-secondary)]">
          {showTrash
            ? "回收站是空的。移到回收站的应用页保留 30 天。"
            : "还没有应用页。让助手做一个可以运行的页面，它会出现在这里。"}
        </p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 px-5 pb-6">
        {apps?.map((app) => {
          const installed = installedByAppId.get(app.id);
          return (
            <li
              key={app.id}
              data-testid={`page-app-card-${app.id}`}
              className="group flex flex-col overflow-hidden rounded-panel border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary-opaque)]"
            >
              <Link
                to="/apps/$appId"
                params={{ appId: app.id }}
                className="block"
                disabled={showTrash}
              >
                <PageAppThumbnail app={app} />
              </Link>
              <div className="flex items-start gap-1 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-ui font-medium">{app.title}</span>
                    {desktopAvailable && !showTrash && installed ? (
                      <Badge variant="success" data-testid={`page-app-installed-badge-${app.id}`}>
                        已安装
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-ui-sm text-[var(--color-text-foreground-tertiary)]">
                    {relativeTime(app.updatedAt)}更新
                  </div>
                </div>
                {showTrash ? (
                  <IconButton
                    variant="chrome"
                    size="icon-xs"
                    label="恢复"
                    onClick={() => void mutate(app, "restore")}
                  >
                    <RotateCcwIcon />
                  </IconButton>
                ) : (
                  <>
                    <IconButton
                      variant="chrome"
                      size="icon-xs"
                      label={app.favorite ? "取消收藏" : "收藏"}
                      onClick={() => void mutate(app, "favorite")}
                    >
                      {app.favorite ? <StarFilledIcon /> : <StarIcon />}
                    </IconButton>
                    <IconButton
                      variant="chrome"
                      size="icon-xs"
                      label="重命名"
                      onClick={() => void mutate(app, "rename")}
                    >
                      <PencilIcon />
                    </IconButton>
                    <IconButton
                      variant="chrome"
                      size="icon-xs"
                      label="移到回收站"
                      onClick={() => void mutate(app, "trash")}
                    >
                      <TrashCanIcon />
                    </IconButton>
                  </>
                )}
              </div>
              {desktopAvailable && !showTrash ? (
                <div className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border-light)] px-3 py-2">
                  <Button
                    variant={installed ? "secondary" : "outline"}
                    size="xs"
                    className="h-7 rounded-control px-2.5 text-ui-sm font-medium"
                    disabled={installingAppId === app.id}
                    onClick={(event) =>
                      void handleDesktopAction(app, installed, event.currentTarget)
                    }
                    data-testid={`page-app-card-desktop-action-${app.id}`}
                  >
                    {installed ? "打开桌面应用" : "安装为应用"}
                  </Button>
                  {installed ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <IconButton
                            variant="chrome"
                            size="icon-xs"
                            label="更多操作"
                            data-testid={`page-app-card-desktop-menu-trigger-${app.id}`}
                          >
                            <MoreHorizontalIcon />
                          </IconButton>
                        }
                      />
                      <ComposerPickerMenuPopup
                        align="end"
                        className="w-48 min-w-48"
                        data-testid={`page-app-card-desktop-menu-popup-${app.id}`}
                      >
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
                        <MenuSeparator />
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
                      </ComposerPickerMenuPopup>
                    </Menu>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
