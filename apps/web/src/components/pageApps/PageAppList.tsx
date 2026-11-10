// FILE: PageAppList.tsx
// Purpose: Cards for the local 应用页: open, favorite, rename, trash/restore.
// The 资料空间 home can list the same items by kind through pageAppsClient.
// Layer: Web pageApps

import type { PageApp } from "@moss/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { PencilIcon, RotateCcwIcon, StarFilledIcon, StarIcon, TrashCanIcon } from "~/lib/icons";

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
  const [apps, setApps] = useState<readonly PageApp[] | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <header className="flex h-12 shrink-0 items-center gap-2 px-5">
        <h1 className="flex-1 text-ui-lg font-medium">
          {showTrash ? "回收站中的应用页" : "应用页"}
        </h1>
        <Button variant="ghost" size="sm" onClick={() => setShowTrash((value) => !value)}>
          {showTrash ? "返回" : "回收站"}
        </Button>
      </header>
      {error ? <p className="px-5 text-ui text-destructive">{error}</p> : null}
      {apps && apps.length === 0 ? (
        <p className="px-5 text-ui text-[var(--color-text-foreground-secondary)]">
          {showTrash
            ? "回收站是空的。移到回收站的应用页保留 30 天。"
            : "还没有应用页。让助手做一个可以运行的页面，它会出现在这里。"}
        </p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 px-5 pb-6">
        {apps?.map((app) => (
          <li
            key={app.id}
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
                <div className="truncate text-ui font-medium">{app.title}</div>
                <div className="truncate text-ui-sm text-[var(--color-text-foreground-tertiary)]">
                  {relativeTime(app.updatedAt)}更新
                </div>
              </div>
              {showTrash ? (
                <Button
                  variant="chrome"
                  size="icon-xs"
                  aria-label="恢复"
                  title="恢复"
                  onClick={() => void mutate(app, "restore")}
                >
                  <RotateCcwIcon />
                </Button>
              ) : (
                <>
                  <Button
                    variant="chrome"
                    size="icon-xs"
                    aria-label={app.favorite ? "取消收藏" : "收藏"}
                    title={app.favorite ? "取消收藏" : "收藏"}
                    onClick={() => void mutate(app, "favorite")}
                  >
                    {app.favorite ? <StarFilledIcon /> : <StarIcon />}
                  </Button>
                  <Button
                    variant="chrome"
                    size="icon-xs"
                    aria-label="重命名"
                    title="重命名"
                    onClick={() => void mutate(app, "rename")}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="chrome"
                    size="icon-xs"
                    aria-label="移到回收站"
                    title="移到回收站"
                    onClick={() => void mutate(app, "trash")}
                  >
                    <TrashCanIcon />
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
