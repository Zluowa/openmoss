// FILE: SpaceItemCard.tsx
// Purpose: One 资料空间 item as a masonry card (grid view) or a row (list view). A note card
//          is its title and text, a picture card is the picture (its name on hover), other
//          cards a preview, title and kind. Where it lives and when it changed are in the list
//          view. The actions menu appears on hover.
// Layer: Space UI

import { parseSheetWorkbook, readSheetRange } from "@moss/shared/spaceItems/sheetWorkbook";
import { useQuery } from "@tanstack/react-query";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { CheckIcon, EllipsisIcon, PinFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { ensureNativeApi } from "~/nativeApi";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { LocalImagePreview } from "../LocalImagePreview";
import { PageAppThumbnail } from "../pageApps/PageAppThumbnail";
import { SidebarIconButton } from "../SidebarIconButton";
import { DashboardThumbnail } from "../spaceTypes/dashboard/DashboardPanels";
import { useSpaceItemMeta } from "../spaceTypes/dashboard/useDashboardItemMeta";
import { DesignCardPreview } from "../spaceTypes/design/DesignThumbnail";
import { SlidesCardPreview } from "../spaceTypes/slides/SlidesCardPreview";
import {
  CARD_MARKED_CLASS_NAME,
  GalleryPicture,
  NoteBlocks,
  SpaceCardButton,
  useNearViewport,
} from "./gallery/GalleryCards";
import { useGalleryImageSource, useOptionalGallery } from "./gallery/GalleryContext";
import { galleryClassOf, noteBlocks, type GalleryFolder } from "./gallery/galleryModel";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import {
  formatRelativeTime,
  markSpaceDashboardItem,
  spaceItemDisplayTitle,
  spaceMossMediaPath,
  type SpaceItem,
} from "./spaceItems";
import { SpaceInlineRename } from "./SpaceInlineRename";
import { isHtmlOutput, type SpaceKindMeta } from "./spaceKinds";

export interface SpaceItemActions {
  onOpen: (item: SpaceItem) => void;
  onContinueInChat?: ((item: SpaceItem) => void) | undefined;
  onSaveAsApp?: ((item: SpaceItem) => void) | undefined;
  onTogglePin?: ((item: SpaceItem) => void) | undefined;
  /** 重命名: the card's title turns into a field in place; called with the new name. */
  onRename?: ((item: SpaceItem, title: string) => void) | undefined;
  onTrash?: ((item: SpaceItem) => void) | undefined;
  folders?: readonly GalleryFolder[] | undefined;
  onMoveToFolder?:
    | ((items: readonly SpaceItem[], target: GalleryFolder | null) => void)
    | undefined;
}

/** Items whose name can be changed here: pages of every kind and uploaded files. */
export function canRenameSpaceItem(item: SpaceItem): boolean {
  return item.source.type === "page" || item.source.type === "library";
}

export function SpaceItemCard(
  props: SpaceItemActions & {
    item: SpaceItem;
    view: "grid" | "list";
    /** Where the item lives ("个人", a space name, or its chat). */
    place: string;
    now: number;
    /** Outlined: the item the person just came back from. */
    marked?: boolean | undefined;
    selected?: boolean | undefined;
    selectionActive?: boolean | undefined;
    onSelect?: ((item: SpaceItem, event: MouseEvent<HTMLElement>) => void) | undefined;
    onToggleSelect?: ((item: SpaceItem) => void) | undefined;
    onDragStartItem?: ((item: SpaceItem, event: DragEvent<HTMLElement>) => void) | undefined;
    onDragEndItem?: (() => void) | undefined;
    isDragging?: boolean | undefined;
  },
) {
  const { item } = props;
  const meta = useSpaceItemMeta(item);
  const Icon = meta.icon;
  const isDashboard = item.kind === "dashboard" || meta.label === "数据看板";
  const time = formatRelativeTime(item.updatedAt, props.now);
  const [renaming, setRenaming] = useState(false);
  const actions = <SpaceItemMenu {...props} onStartRename={() => setRenaming(true)} />;
  const highlighted = Boolean(props.marked || props.selected);
  const renameField = renaming ? (
    <SpaceInlineRename
      value={spaceItemDisplayTitle(item)}
      label="名称"
      onCommit={(title) => props.onRename?.(item, title)}
      onDone={() => setRenaming(false)}
      className="flex-1"
    />
  ) : null;

  useEffect(() => {
    if (item.kind === "app") {
      markSpaceDashboardItem(item.key, isDashboard);
    }
  }, [item.key, item.kind, isDashboard]);

  const imageCardRef = useRef<HTMLDivElement | null>(null);
  const galleryKind = galleryClassOf(item);
  const wantsGridImage = props.view === "grid" && galleryKind === "image";
  const nearViewport = useNearViewport(imageCardRef, wantsGridImage);
  const imageSource = useGalleryImageSource(item, { enabled: wantsGridImage && nearViewport });

  const handlePrimaryClick = (event: MouseEvent<HTMLElement>) => {
    if (props.onSelect) {
      event.stopPropagation();
      props.onSelect(item, event);
      return;
    }
    props.onOpen(item);
  };

  const handlePrimaryDoubleClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    props.onOpen(item);
  };

  const handlePrimaryKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && !renaming) {
      event.preventDefault();
      props.onOpen(item);
    }
  };

  const dragProps =
    !renaming && props.onDragStartItem
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLElement>) => props.onDragStartItem?.(item, event),
          onDragEnd: () => props.onDragEndItem?.(),
        }
      : {};

  // Positioned via CSS `top-2 left-2` and placed AFTER the card button in DOM order so
  // `[data-space-item] button` first match always refers to the card button itself.
  const selectionToggle = props.onToggleSelect ? (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      data-space-select-toggle
      aria-label={`选择 ${spaceItemDisplayTitle(item)}`}
      aria-pressed={props.selected ?? false}
      className={cn(
        "absolute top-2 left-2 z-20 flex size-5 rounded-full border p-0 transition-all duration-150",
        props.selected
          ? "border-info bg-info text-white opacity-100 shadow-xs hover:bg-info hover:text-white"
          : props.selectionActive
            ? "border-foreground/30 bg-card/90 text-transparent opacity-90 shadow-xs backdrop-blur-sm hover:border-info hover:bg-card/95"
            : "border-foreground/25 bg-card/85 text-transparent opacity-0 shadow-xs backdrop-blur-sm group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100 hover:border-info hover:bg-card/95",
      )}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggleSelect?.(item);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <CheckIcon aria-hidden className="size-3" />
    </Button>
  ) : null;

  if (props.view === "list") {
    return (
      <div
        role="row"
        className={cn(
          "group/space-item flex h-10 items-center gap-3 rounded-row px-2 transition-colors hover:bg-accent",
          props.selected && "bg-info/10 ring-1 ring-inset ring-info/45 hover:bg-info/12",
          props.isDragging && "opacity-50",
        )}
        data-space-item={item.key}
        data-selected={props.selected ? "" : undefined}
        {...dragProps}
      >
        {renameField ? (
          <span role="gridcell" className="flex min-w-0 flex-1 items-center gap-2.5">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {renameField}
          </span>
        ) : (
          <button
            type="button"
            role="gridcell"
            aria-selected={props.selected || undefined}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={handlePrimaryClick}
            onDoubleClick={handlePrimaryDoubleClick}
            onKeyDown={handlePrimaryKeyDown}
          >
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-ui">{spaceItemDisplayTitle(item)}</span>
            {item.pinned ? (
              <PinFilledIcon
                aria-label="已收藏"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
          </button>
        )}
        {props.onToggleSelect ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            data-space-select-toggle
            aria-label={`选择 ${spaceItemDisplayTitle(item)}`}
            aria-pressed={props.selected ?? false}
            className={cn(
              "flex size-4 shrink-0 rounded-full border p-0 transition-all",
              props.selected
                ? "border-info bg-info text-white opacity-100 hover:bg-info hover:text-white"
                : props.selectionActive
                  ? "border-foreground/30 text-transparent opacity-85 hover:border-info"
                  : "border-foreground/25 text-transparent opacity-0 group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100 hover:border-info",
            )}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleSelect?.(item);
            }}
          >
            <CheckIcon aria-hidden className="size-2.5" />
          </Button>
        ) : null}
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

  const imageSrc = galleryKind === "image" ? imageSource.src : null;
  if (galleryKind === "note" || galleryKind === "image") {
    // Notes show their own text and pictures their own shape: they are what they hold.
    return (
      <div
        ref={galleryKind === "image" ? imageCardRef : undefined}
        className={cn(
          "group/space-item relative transition-[opacity,transform] duration-150",
          props.isDragging && "scale-[0.98] opacity-50",
        )}
        data-space-item={item.key}
        data-selected={props.selected ? "" : undefined}
        {...dragProps}
      >
        {galleryKind === "note" ? (
          <NoteCard
            item={item}
            marked={highlighted}
            selected={props.selected === true}
            onClick={handlePrimaryClick}
            onDoubleClick={handlePrimaryDoubleClick}
            onKeyDown={handlePrimaryKeyDown}
          />
        ) : (
          <SpaceCardButton
            className={cn(
              "border-transparent bg-muted/40",
              highlighted
                ? CARD_MARKED_CLASS_NAME
                : "ring-1 ring-inset ring-foreground/[0.06] hover:ring-foreground/15",
            )}
            aria-label={`图片 ${spaceItemDisplayTitle(item)}`}
            aria-selected={props.selected || undefined}
            onClick={handlePrimaryClick}
            onDoubleClick={handlePrimaryDoubleClick}
            onKeyDown={handlePrimaryKeyDown}
          >
            <span data-space-card-preview="image" className="block">
              <GalleryPicture
                item={item}
                src={imageSrc}
                className="w-full"
                onRetrySrc={imageSource.refreshGrant}
              />
            </span>
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col bg-black/60 px-3 py-2 text-white opacity-0 transition-opacity group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100">
              <span className="truncate text-ui-sm font-medium">{spaceItemDisplayTitle(item)}</span>
            </span>
          </SpaceCardButton>
        )}
        {selectionToggle}
        <span className="absolute top-2 right-2 z-20 rounded-control bg-card/90 backdrop-blur-sm opacity-0 group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100 has-[[data-popup-open]]:opacity-100">
          {actions}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/space-item relative flex flex-col overflow-hidden rounded-panel border border-border/80 bg-card shadow-xs transition-[box-shadow,border-color,opacity,transform] hover:border-border hover:shadow-md",
        highlighted && CARD_MARKED_CLASS_NAME,
        props.isDragging && "scale-[0.98] opacity-50",
      )}
      data-space-item={item.key}
      data-selected={props.selected ? "" : undefined}
      {...dragProps}
    >
      {renameField ? (
        <div className="flex w-full flex-col overflow-hidden rounded-panel">
          <SpaceItemPreview item={item} meta={meta} isDashboard={isDashboard} />
          <span className="flex min-h-15 min-w-0 items-center gap-1.5 px-3 py-2.5">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {renameField}
          </span>
        </div>
      ) : (
        <button
          type="button"
          aria-selected={props.selected || undefined}
          className="flex w-full flex-col overflow-hidden rounded-panel bg-card text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handlePrimaryClick}
          onDoubleClick={handlePrimaryDoubleClick}
          onKeyDown={handlePrimaryKeyDown}
        >
          <SpaceItemPreview item={item} meta={meta} isDashboard={isDashboard} />
          <span className="flex min-h-15 min-w-0 flex-col justify-center gap-1 px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-1.5 pr-6">
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
            <span className="truncate text-ui-sm text-muted-foreground">{meta.label}</span>
          </span>
        </button>
      )}
      {selectionToggle}
      <span className="absolute top-2 right-2 z-20 rounded-control bg-card/90 backdrop-blur-sm opacity-0 group-hover/space-item:opacity-100 group-focus-within/space-item:opacity-100 has-[[data-popup-open]]:opacity-100">
        {actions}
      </span>
    </div>
  );
}

/** A note as a card: its title, then its own text (headings, tasks, lists, pictures). */
function NoteCard(props: {
  item: SpaceItem;
  marked: boolean;
  selected?: boolean | undefined;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onDoubleClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const markdown = useNoteMarkdown(props.item);
  const blocks = markdown === null ? null : noteBlocks(markdown, 12);
  return (
    <SpaceCardButton
      className={cn("max-h-96 gap-2 px-3.5 pt-3 pb-3", props.marked && CARD_MARKED_CLASS_NAME)}
      aria-selected={props.selected || undefined}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onKeyDown={props.onKeyDown}
    >
      <span className="flex min-w-0 items-center gap-1.5 ps-5 pe-7 group-hover/space-item:ps-5">
        <span className="min-w-0 flex-1 truncate text-ui font-medium">
          {spaceItemDisplayTitle(props.item)}
        </span>
        {props.item.pinned ? (
          <PinFilledIcon aria-label="已收藏" className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
      <span data-space-card-preview="page" className="relative block min-h-0 overflow-hidden">
        {blocks === null ? (
          <span className="flex flex-col gap-1.5" aria-hidden>
            <span className="h-2 w-full rounded-full bg-foreground/6" />
            <span className="h-2 w-4/5 rounded-full bg-foreground/6" />
          </span>
        ) : (
          <NoteBlocks blocks={blocks} />
        )}
      </span>
    </SpaceCardButton>
  );
}

/** A note's text: from the 资料空间's shared reads when there are any, else read here. */
function useNoteMarkdown(item: SpaceItem): string | null {
  const gallery = useOptionalGallery();
  const shared = gallery?.noteMarkdown(item) ?? null;
  const page = item.source.type === "page" ? item.source.page : null;
  const api = ensureNativeApi();
  const query = useQuery({
    queryKey: ["space-card-page", page?.scopeSpaceId ?? "local", page?.id, page?.revision],
    queryFn: async () =>
      page
        ? ((await api.pages.read({ scopeSpaceId: page.scopeSpaceId, pageId: page.id })).content ??
          "")
        : "",
    enabled: shared === null && page !== null && typeof api.pages?.read === "function",
    staleTime: Infinity,
    retry: false,
  });
  return shared ?? query.data ?? null;
}

function PreviewFrame(props: { kind: string; className?: string; children: ReactNode }) {
  return (
    <span
      data-space-card-preview={props.kind}
      className={cn(
        "relative flex aspect-[2/1] w-full items-center justify-center overflow-hidden rounded-t-panel border-b border-border/60 bg-[var(--color-background-elevated-secondary)]",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** Miniature 2:1 visual preview for cards in the 资料空间 gallery grid. */
function SpaceItemPreview({
  item,
  meta,
  isDashboard,
}: {
  item: SpaceItem;
  meta: SpaceKindMeta;
  isDashboard: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!failed && item.source.type === "output" && item.kind === "image") {
    const { output } = item.source;
    return (
      <PreviewFrame kind="image" className="block bg-muted/40">
        <LocalImagePreview
          src={output.path}
          cwd={output.workspaceRoot}
          alt={spaceItemDisplayTitle(item)}
          className="h-full w-full"
          imageClassName="h-full w-full object-cover"
          onPreviewError={() => setFailed(true)}
        />
      </PreviewFrame>
    );
  }
  const mediaPath =
    !failed && item.source.type === "library" && !item.source.item.path
      ? spaceMossMediaPath(item.source.item)
      : null;
  if (mediaPath && item.source.type === "library") {
    // An image or video made in a chat, read from Moss's media cache.
    const url = resolveWsHttpUrl(mediaPath);
    return (
      <PreviewFrame kind="image" className="block bg-muted/40">
        {item.source.item.kind === "video" ? (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            aria-hidden
            data-space-card-video
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={url}
            alt={spaceItemDisplayTitle(item)}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
      </PreviewFrame>
    );
  }
  if (!failed && item.source.type === "library" && item.kind === "image" && item.source.item.path) {
    const { item: entry } = item.source;
    return (
      <PreviewFrame kind="image" className="block bg-muted/40">
        <LocalImagePreview
          src={entry.previewPath ?? entry.path!}
          cwd={null}
          alt={spaceItemDisplayTitle(item)}
          className="h-full w-full"
          imageClassName="h-full w-full object-cover"
          onPreviewError={() => setFailed(true)}
        />
      </PreviewFrame>
    );
  }
  if (item.source.type === "page" && item.source.page.kind === "slides") {
    return (
      <PreviewFrame
        kind="slides"
        className="block [&>*]:h-full [&>*]:w-full [&>*]:rounded-none [&>*]:border-0"
      >
        <SlidesCardPreview page={item.source.page} />
      </PreviewFrame>
    );
  }
  if (item.source.type === "page" && item.source.page.kind === "design") {
    return (
      <PreviewFrame
        kind="design"
        className="block [&>*]:h-full [&>*]:w-full [&>*]:rounded-none [&>*]:border-0"
      >
        <DesignCardPreview page={item.source.page} />
      </PreviewFrame>
    );
  }
  if (isDashboard) {
    return (
      <PreviewFrame kind="dashboard" className="p-2">
        <DashboardThumbnail />
      </PreviewFrame>
    );
  }
  if (item.source.type === "app") {
    return <PageAppThumbnail app={item.source.app} />;
  }
  if (item.source.type === "page" && item.kind === "page") {
    return <PageCardPreview page={item.source.page} />;
  }
  if (item.source.type === "page" && item.kind === "sheet") {
    return <SheetCardPreview page={item.source.page} />;
  }
  if (item.kind === "board") {
    return <BoardCardPreview />;
  }
  const Icon = meta.icon;
  return (
    <PreviewFrame kind={item.kind}>
      <Icon aria-hidden className="size-6 text-muted-foreground/75" />
    </PreviewFrame>
  );
}

function PageCardPreview({
  page,
}: {
  page: Extract<SpaceItem["source"], { type: "page" }>["page"];
}) {
  const api = ensureNativeApi();
  const canRead = typeof api.pages?.read === "function";
  const query = useQuery({
    queryKey: ["space-card-page", page.scopeSpaceId ?? "local", page.id, page.revision],
    queryFn: async () => {
      const result = await api.pages.read({
        scopeSpaceId: page.scopeSpaceId,
        pageId: page.id,
      });
      return result.content ?? "";
    },
    enabled: canRead,
    staleTime: Infinity,
    retry: false,
  });

  const body = (query.data ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("---"));
  // The preview reads like the page: its title on top, then its first lines.
  const lines = (
    page.title && body[0]?.replace(/^#+\s*/u, "") !== page.title
      ? [`# ${page.title}`, ...body]
      : body
  ).slice(0, 4);

  return (
    <PreviewFrame kind="page" className="items-end px-4 pt-2.5 pb-0">
      <span className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-t-control border border-b-0 border-border/70 bg-background px-3 py-2 text-left shadow-xs">
        {lines.length ? (
          lines.map((line, index) => {
            const clean = line
              .replace(/^#+\s*/u, "")
              .replace(/^[-*+]\s+/u, "• ")
              .replaceAll("**", "")
              .replaceAll("`", "");
            return (
              <span
                key={index}
                className={cn(
                  "block truncate text-ui-xs leading-snug",
                  index === 0 || line.startsWith("#")
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {clean}
              </span>
            );
          })
        ) : (
          <>
            <span className="block h-2.5 w-3/5 rounded-control-xs bg-foreground/15" />
            <span className="mt-1 block h-2 w-full rounded-control-xs bg-muted-foreground/15" />
            <span className="block h-2 w-5/6 rounded-control-xs bg-muted-foreground/15" />
            <span className="block h-2 w-2/3 rounded-control-xs bg-muted-foreground/15" />
          </>
        )}
      </span>
    </PreviewFrame>
  );
}

function SheetCardPreview({
  page,
}: {
  page: Extract<SpaceItem["source"], { type: "page" }>["page"];
}) {
  const api = ensureNativeApi();
  const canRead = typeof api.pageTypes?.read === "function";
  const query = useQuery({
    queryKey: ["space-card-sheet", page.scopeSpaceId ?? "local", page.id, page.revision],
    queryFn: () =>
      api.pageTypes.read({
        scopeSpaceId: page.scopeSpaceId,
        pageId: page.id,
      }),
    enabled: canRead,
    staleTime: Infinity,
    retry: false,
  });

  let rows: string[][] = [];
  if (query.data?.data) {
    try {
      const read = readSheetRange(parseSheetWorkbook(query.data.data), undefined, "A1:D5");
      rows = read.values
        .map((row, r) =>
          row.map((value, c) =>
            value === null ? (read.formulas[r]?.[c] ? "ƒx" : "") : String(value),
          ),
        )
        .filter((row) => row.some((cell) => cell !== ""));
    } catch {
      rows = [];
    }
  }

  return (
    <PreviewFrame kind="sheet" className="p-2.5">
      <span className="block h-full w-full overflow-hidden rounded-control-xs border border-border/70 bg-background">
        {rows.length ? (
          <table className="h-full w-full table-fixed border-collapse text-left text-ui-xs">
            <tbody>
              {rows.slice(0, 4).map((row, r) => (
                <tr key={r}>
                  {row.slice(0, 4).map((cell, c) => (
                    <td
                      key={c}
                      className={cn(
                        "truncate border-r border-b border-border/60 px-1.5 py-0.5 tabular-nums last:border-r-0",
                        r === 0 && "bg-[var(--color-background-elevated-secondary)] font-medium",
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="grid h-full w-full grid-cols-4 grid-rows-4">
            {Array.from({ length: 16 }, (_, idx) => (
              <span
                key={idx}
                className={cn(
                  "border-r border-b border-border/60",
                  idx < 4 && "bg-[var(--color-background-elevated-secondary)]",
                )}
              />
            ))}
          </span>
        )}
      </span>
    </PreviewFrame>
  );
}

function BoardCardPreview() {
  return (
    <PreviewFrame kind="board" className="p-3">
      <span
        aria-hidden
        className="relative flex h-full w-full items-center justify-between overflow-hidden rounded-control border border-border/60 bg-background/95 px-3 py-2"
        style={{
          backgroundImage:
            "radial-gradient(circle, color-mix(in srgb, var(--foreground) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "10px 10px",
        }}
      >
        <span
          className="flex h-10 w-16 shrink-0 flex-col gap-1 rounded-control-xs border border-border/70 p-1.5 shadow-2xs"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--color-accent-yellow) 22%, var(--background))",
          }}
        >
          <span className="h-1.5 w-8 rounded-full bg-foreground/25" />
          <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
        </span>
        <svg viewBox="0 0 40 20" className="h-5 w-9 shrink-0 text-muted-foreground/60" aria-hidden>
          <path
            d="M2 10 C 14 2, 26 18, 36 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 2"
          />
          <path d="M33 7 L38 10 L33 13" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span
          className="flex h-11 w-16 shrink-0 flex-col gap-1 rounded-control-xs border border-border/70 p-1.5 shadow-2xs"
          style={{
            backgroundColor: "color-mix(in srgb, var(--color-accent-blue) 18%, var(--background))",
          }}
        >
          <span className="h-1.5 w-9 rounded-full bg-foreground/25" />
          <span className="h-1 w-11 rounded-full bg-muted-foreground/30" />
          <span className="h-1 w-7 rounded-full bg-muted-foreground/25" />
        </span>
      </span>
    </PreviewFrame>
  );
}

function SpaceItemMenu(props: SpaceItemActions & { item: SpaceItem; onStartRename: () => void }) {
  const { item } = props;
  const canPin =
    props.onTogglePin && (item.source.type === "page" || item.source.type === "library");
  const currentFolderKey =
    props.folders?.find((folder) => folder.items.some((entry) => entry.key === item.key))?.key ??
    null;
  const canMove =
    Boolean(props.onMoveToFolder) &&
    ((props.folders?.length ?? 0) > 0 || currentFolderKey !== null);
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={EllipsisIcon}
        label={`${spaceItemDisplayTitle(item)} 的操作`}
        size="lg"
      />
      <ComposerPickerMenuPopup align="end" className="w-52 min-w-52">
        <MenuItem onClick={() => props.onOpen(item)}>打开</MenuItem>
        {item.sourceThreadId && props.onContinueInChat ? (
          <MenuItem onClick={() => props.onContinueInChat?.(item)}>在对话中继续</MenuItem>
        ) : null}
        {isHtmlOutput(item) && props.onSaveAsApp ? (
          <MenuItem onClick={() => props.onSaveAsApp?.(item)}>保存为应用页</MenuItem>
        ) : null}
        {props.onRename && canRenameSpaceItem(item) ? (
          <MenuItem onClick={props.onStartRename}>重命名</MenuItem>
        ) : null}
        {canPin ? (
          <MenuItem onClick={() => props.onTogglePin?.(item)}>
            {item.pinned ? "取消收藏" : "收藏"}
          </MenuItem>
        ) : null}
        {canMove ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>移入资料空间</MenuGroupLabel>
              {props.folders?.map((folder) => {
                const inside = folder.key === currentFolderKey;
                return (
                  <MenuItem
                    key={folder.key}
                    disabled={inside}
                    onClick={() => props.onMoveToFolder?.([item], folder)}
                  >
                    <span className="flex-1 truncate">{folder.title}</span>
                    {inside ? <CheckIcon aria-hidden className="size-3.5" /> : null}
                  </MenuItem>
                );
              })}
              {currentFolderKey !== null ? (
                <MenuItem onClick={() => props.onMoveToFolder?.([item], null)}>
                  移出到未归入文件夹
                </MenuItem>
              ) : null}
            </MenuGroup>
          </>
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
