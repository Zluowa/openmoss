// FILE: SpaceTrash.tsx
// Purpose: 回收站 of the 资料空间: deleted pages, 资料空间 and files, each restorable until it
//          is deleted for good 30 days after it was trashed; per-item permanent delete and
//          清空回收站.
// Layer: Space UI

import { useEffect, useState } from "react";
import { SPACE_TRASH_RETENTION_DAYS } from "@moss/contracts";

import { cn } from "~/lib/utils";
import {
  PAGE_TITLE_CLASS_NAME,
  TAB_IDLE_SURFACE_CLASS_NAME,
  TAB_SELECTED_SURFACE_CLASS_NAME,
} from "~/surfaceStyles";

import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { itemsForSection, trashDaysLeft, type SpaceItem } from "./spaceItems";
import { spaceItemMeta } from "./spaceKinds";

type TrashTab = "pages" | "spaces" | "files";

const TABS: ReadonlyArray<{ id: TrashTab; label: string }> = [
  { id: "pages", label: "页面" },
  { id: "spaces", label: "资料空间" },
  { id: "files", label: "文件" },
];

export function trashTabOf(item: SpaceItem): TrashTab {
  if (item.source.type === "output" || item.source.type === "library") return "files";
  if (item.source.type === "page") {
    const { page } = item.source;
    if (page.spaceId !== null && page.id === page.rootPageId) return "spaces";
  }
  return "pages";
}

export function SpaceTrash(props: {
  items: readonly SpaceItem[];
  busy: boolean;
  error: string | null;
  onRestore: (item: SpaceItem) => void;
  /** False when this kind of item cannot be deleted for good from here. */
  canPurge: (item: SpaceItem) => boolean;
  onPurge: (items: readonly SpaceItem[]) => Promise<void>;
}) {
  const [tab, setTab] = useState<TrashTab>("pages");
  const [confirm, setConfirm] = useState<readonly SpaceItem[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const trashed = itemsForSection(
    props.items,
    { type: "trash" },
    { tab: "mine", kind: "any", query: "" },
  );
  const visible = trashed.filter((item) => trashTabOf(item) === tab);
  const purgeable = trashed.filter(props.canPurge);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-space-trash>
      <header className="flex flex-col gap-3 px-6 pt-6 pb-3 md:px-10 md:pt-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className={PAGE_TITLE_CLASS_NAME}>回收站</h1>
            <p className="mt-1 text-ui-sm text-muted-foreground">
              删除的条目会在这里保留 {SPACE_TRASH_RETENTION_DAYS}{" "}
              天，之后永久删除。恢复后会回到原来的位置。
            </p>
          </div>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={props.busy || purgeable.length === 0}
            onClick={() => setConfirm(purgeable)}
          >
            清空回收站
          </Button>
        </div>
        <div role="tablist" aria-label="回收站分区" className="flex items-center gap-1">
          {TABS.map((entry) => {
            const count = trashed.filter((item) => trashTabOf(item) === entry.id).length;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={cn(
                  "h-7 rounded-control px-2.5 text-ui",
                  tab === entry.id ? TAB_SELECTED_SURFACE_CLASS_NAME : TAB_IDLE_SURFACE_CLASS_NAME,
                )}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {count ? <span className="ms-1 text-muted-foreground">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </header>
      {props.error ? (
        <p role="alert" className="px-6 pb-2 text-ui text-destructive md:px-10">
          {props.error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 md:px-10">
        {visible.length === 0 ? (
          <p className="py-24 text-center text-ui text-muted-foreground">
            {tab === "spaces"
              ? "回收站中没有资料空间"
              : tab === "files"
                ? "回收站中没有文件"
                : "回收站中没有页面"}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="回收站中的条目">
            {visible.map((item) => {
              const meta = spaceItemMeta(item);
              const Icon = meta.icon;
              const days = trashDaysLeft(item.trashedAt!, now, SPACE_TRASH_RETENTION_DAYS);
              return (
                <li
                  key={item.key}
                  className="flex h-10 items-center gap-3 rounded-row px-2 hover:bg-accent"
                  data-space-trash-item={item.key}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-ui">{item.title}</span>
                  <span className="shrink-0 text-ui-sm text-muted-foreground">
                    {days === 0 ? "今天永久删除" : `${days} 天后永久删除`}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => props.onRestore(item)}
                  >
                    恢复
                  </Button>
                  {props.canPurge(item) ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive"
                      disabled={props.busy}
                      onClick={() => setConfirm([item])}
                    >
                      永久删除
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && !props.busy && setConfirm(null)}
      >
        <DialogPopup>
          <DialogTitle>要永久删除吗？</DialogTitle>
          <p className="mt-3 text-ui text-muted-foreground">
            {confirm?.length === 1
              ? `“${confirm[0]!.title}”会被永久删除，无法恢复。对话里的原文件不受影响。`
              : `回收站中的 ${confirm?.length ?? 0} 个条目会被永久删除，无法恢复。对话里的原文件不受影响。`}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={props.busy}
              onClick={() => {
                const targets = confirm ?? [];
                void props.onPurge(targets).then(() => setConfirm(null));
              }}
            >
              永久删除
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
