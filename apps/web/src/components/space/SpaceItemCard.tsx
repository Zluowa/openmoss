// FILE: SpaceItemCard.tsx
// Purpose: One 资料空间 item as a masonry card (grid view) or a row (list view): kind glyph,
//          title, a preview when the item has one, where it lives and when it changed, plus a
//          small actions menu.
// Layer: Space UI

import { useState } from "react";

import { EllipsisIcon, PinFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { LocalImagePreview } from "../LocalImagePreview";
import { SidebarIconButton } from "../SidebarIconButton";
import { SlidesCardPreview } from "../spaceTypes/slides/SlidesCardPreview";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { formatRelativeTime, spaceItemDisplayTitle, type SpaceItem } from "./spaceItems";
import { isHtmlOutput, spaceItemMeta } from "./spaceKinds";

export interface SpaceItemActions {
  onOpen: (item: SpaceItem) => void;
  onContinueInChat?: ((item: SpaceItem) => void) | undefined;
  onSaveAsApp?: ((item: SpaceItem) => void) | undefined;
  onTogglePin?: ((item: SpaceItem) => void) | undefined;
  onTrash?: ((item: SpaceItem) => void) | undefined;
}

export function SpaceItemCard(
  props: SpaceItemActions & {
    item: SpaceItem;
    view: "grid" | "list";
    /** Where the item lives ("个人", a space name, or its chat). */
    place: string;
    now: number;
  },
) {
  const { item } = props;
  const meta = spaceItemMeta(item);
  const Icon = meta.icon;
  const time = formatRelativeTime(item.updatedAt, props.now);
  const actions = <SpaceItemMenu {...props} />;

  if (props.view === "list") {
    return (
      <div
        role="row"
        className="group/space-item flex h-10 items-center gap-3 rounded-row px-2 hover:bg-accent"
        data-space-item={item.key}
      >
        <button
          type="button"
          role="gridcell"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onOpen(item)}
        >
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-ui">{spaceItemDisplayTitle(item)}</span>
          {item.pinned ? (
            <PinFilledIcon aria-label="已收藏" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </button>
        <span
          role="gridcell"
          className="w-24 shrink-0 truncate text-ui-sm text-muted-foreground max-sm:hidden"
        >
          {meta.label}
        </span>
        <span
          role="gridcell"
          className="w-36 shrink-0 truncate text-ui-sm text-muted-foreground max-md:hidden"
        >
          {props.place}
        </span>
        <span role="gridcell" className="w-20 shrink-0 text-end text-ui-sm text-muted-foreground">
          {time}
        </span>
        <span role="gridcell" className="w-6 shrink-0">
          {actions}
        </span>
      </div>
    );
  }

  return (
    <div
      className="group/space-item relative mb-3 break-inside-avoid rounded-panel border border-border bg-card shadow-xs transition-shadow hover:shadow-md"
      data-space-item={item.key}
    >
      <button
        type="button"
        className="flex w-full flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-panel"
        onClick={() => props.onOpen(item)}
      >
        <SpaceItemPreview item={item} />
        <span className="flex min-w-0 flex-col gap-1 px-3 pt-2.5 pb-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-ui font-medium">
              {spaceItemDisplayTitle(item)}
            </span>
            {item.pinned ? (
              <PinFilledIcon
                aria-label="已收藏"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
          </span>
          <span className="truncate text-ui-sm text-muted-foreground">
            {props.place} · {time}
          </span>
        </span>
      </button>
      <span className="absolute top-2 right-2 rounded-control bg-card opacity-0 group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100 has-[[data-popup-open]]:opacity-100">
        {actions}
      </span>
    </div>
  );
}

/** A real picture of the item when there is one; nothing otherwise (no placeholder art). */
function SpaceItemPreview({ item }: { item: SpaceItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  if (item.source.type === "output" && item.kind === "image") {
    const { output } = item.source;
    return (
      <span className="block h-36 overflow-hidden rounded-t-panel border-b border-border bg-muted/40">
        <LocalImagePreview
          src={output.path}
          cwd={output.workspaceRoot}
          alt={spaceItemDisplayTitle(item)}
          className="h-36"
          imageClassName="h-36 w-full object-cover"
          onPreviewError={() => setFailed(true)}
        />
      </span>
    );
  }
  if (item.source.type === "library" && item.kind === "image" && item.source.item.path) {
    const { item: entry } = item.source;
    return (
      <span className="block h-36 overflow-hidden rounded-t-panel border-b border-border bg-muted/40">
        <LocalImagePreview
          src={entry.previewPath ?? entry.path!}
          cwd={null}
          alt={spaceItemDisplayTitle(item)}
          className="h-36"
          imageClassName="h-36 w-full object-cover"
          onPreviewError={() => setFailed(true)}
        />
      </span>
    );
  }
  if (item.source.type === "page" && item.source.page.kind === "slides") {
    return <SlidesCardPreview page={item.source.page} />;
  }
  if (item.source.type === "app" && item.source.app.thumbnail) {
    return (
      <img
        src={item.source.app.thumbnail}
        alt=""
        className="block h-36 w-full rounded-t-panel border-b border-border object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return null;
}

function SpaceItemMenu(props: SpaceItemActions & { item: SpaceItem }) {
  const { item } = props;
  const canPin =
    props.onTogglePin && (item.source.type === "page" || item.source.type === "library");
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={EllipsisIcon}
        label={`${spaceItemDisplayTitle(item)} 的操作`}
        size="lg"
      />
      <ComposerPickerMenuPopup align="end" className="w-48 min-w-48">
        <MenuItem onClick={() => props.onOpen(item)}>打开</MenuItem>
        {item.sourceThreadId && props.onContinueInChat ? (
          <MenuItem onClick={() => props.onContinueInChat?.(item)}>在对话中继续</MenuItem>
        ) : null}
        {isHtmlOutput(item) && props.onSaveAsApp ? (
          <MenuItem onClick={() => props.onSaveAsApp?.(item)}>保存为应用页</MenuItem>
        ) : null}
        {canPin ? (
          <MenuItem onClick={() => props.onTogglePin?.(item)}>
            {item.pinned ? "取消收藏" : "收藏"}
          </MenuItem>
        ) : null}
        {props.onTrash ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => props.onTrash?.(item)}>
              移到回收站
            </MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Column headers of the list view, aligned with `SpaceItemCard`'s list row. */
export function SpaceListHeader() {
  return (
    <div
      role="row"
      className={cn(
        "flex h-8 items-center gap-3 border-b border-border px-2 text-ui-sm text-muted-foreground",
      )}
    >
      <span role="columnheader" className="min-w-0 flex-1 ps-6.5">
        名称
      </span>
      <span role="columnheader" className="w-24 shrink-0 max-sm:hidden">
        类型
      </span>
      <span role="columnheader" className="w-36 shrink-0 max-md:hidden">
        位置
      </span>
      <span role="columnheader" className="w-20 shrink-0 text-end">
        更新
      </span>
      <span className="w-6 shrink-0" />
    </div>
  );
}
