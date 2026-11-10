// FILE: MossLibrarySurface.tsx
// Purpose: Codex-style full Library destination (资料库) — rail-only chrome,
// toolbar order filter·grid/list·search·新建·settings, multi-CLI file cards,
// multi-select bar, card context menu, folder drill-down, grouped 全部 tab.
// Layer: Web shell destination host

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { useMossLibraryItemsStore } from "~/mossLibraryItemsStore";
import {
  AppsIcon,
  ArrowLeftIcon,
  ChatBubblePlusIcon,
  CheckIcon,
  ChevronDownIcon,
  CustomizeIcon,
  DownloadIcon,
  EllipsisIcon,
  FilterIcon,
  FolderIcon,
  LinkIcon,
  MessageCircleIcon,
  PencilIcon,
  Rows3Icon,
  SearchIcon,
  SortIcon,
  StarIcon,
  TrashCanIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { describeLocalizedError } from "~/lib/localizedError";
import { downloadMossLibraryItem, shareMossLibraryImage } from "~/lib/mossLibraryAssetActions";
import { readMossCanvasSelectionFile, type MossCanvasBinding } from "~/lib/mossCanvasClient";
import type { MossCanvasSelection } from "~/lib/mossCanvasSelection";
import { MossCanvasWebSurface } from "./MossCanvasWebSurface";
import { Button } from "./ui/button";

import {
  MOSS_LIBRARY_NEW_ACTIONS,
  MOSS_LIBRARY_SECTIONS,
  MOSS_LIBRARY_SORT_OPTIONS,
  assignMossLibraryItemsToFolder,
  buildMossLibraryContextMenu,
  createMossLibraryFolder,
  filterMossLibraryItems,
  formatMossLibraryItemSubtitle,
  formatMossLibraryRelativeTime,
  ingestMossLibraryItemFromCliFile,
  mossLibraryEmptyHeightsForSection,
  mossLibraryFolderChildren,
  mossLibraryItemsAllFavorite,
  mossLibraryRenameKeepsExtension,
  mossLibrarySectionMatchesQuery,
  normalizeMossLibraryQuery,
  partitionMossLibraryAllSection,
  removeMossLibraryItemsById,
  renameMossLibraryItem,
  resolveMossLibrarySection,
  resolveMossLibrarySort,
  setMossLibraryItemsFavorite,
  mossLibrarySourceCliName,
  toggleMossLibrarySelectedId,
  type MossLibraryContextActionId,
  type MossLibraryItem,
  type MossLibrarySectionId,
  type MossLibrarySortId,
  type MossLibraryViewMode,
} from "./MossLibrarySurface.logic";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

export interface MossLibrarySurfaceProps {
  /** Escape / rail leave closes the destination (Codex has no overlay X). */
  readonly onClose: () => void;
  /** Optional initial items (tests / host inject). When omitted, store-backed artifacts load. */
  readonly initialItems?: readonly MossLibraryItem[];
  /** Injected "now" for relative-time tests. */
  readonly now?: number;
  /** Explicit fixture switch retained for compatibility; runtime defaults to a true empty state. */
  readonly seedDemoIfEmpty?: boolean;
  readonly onStartConversation?: (items: readonly MossLibraryItem[]) => Promise<void>;
  readonly isCurrent?: () => boolean;
  readonly threadId?: string | null;
  readonly prepareThread?: () => Promise<string | null>;
  readonly onCanvasLeaveGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}

interface LibraryContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly itemId: string;
}

/** Read a picked/dropped file as raw base64 for the server import channel. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function LibraryCardThumb({
  item,
  thumbUrl,
}: {
  readonly item: MossLibraryItem;
  readonly thumbUrl?: string | undefined;
}) {
  const resolved = item.thumbnailUrl ?? thumbUrl;
  if (item.kind === "image" && resolved) {
    return (
      <img
        src={resolved}
        alt={item.title}
        className="block h-auto w-full"
        data-moss-library-thumb
      />
    );
  }
  if (item.kind === "folder") {
    return <FolderIcon className="size-7 text-muted-foreground" aria-hidden="true" />;
  }
  return (
    <span className="rounded-md bg-background/40 px-2 py-1 text-ui-2xs uppercase tracking-wide text-muted-foreground">
      {item.kind}
    </span>
  );
}

function LibraryCardMeta({ item, now }: { readonly item: MossLibraryItem; readonly now: number }) {
  const { format, locale } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        data-moss-library-cli-badge={item.sourceCli}
        className="inline-flex items-center rounded-full bg-background/55 px-1.5 py-0.5 text-ui-2xs font-medium text-muted-foreground ring-1 ring-inset ring-border/40"
      >
        {mossLibrarySourceCliName(item.sourceCli) ?? format("library.source.other", {})}
      </span>
      <span
        data-moss-library-relative-time
        className="text-ui-2xs text-muted-foreground/80"
        title={new Date(item.updatedAt).toLocaleString(locale)}
      >
        {formatMossLibraryRelativeTime(item.updatedAt, now, format)}
      </span>
    </div>
  );
}

/** Codex card-corner check affordance: hidden until hover, solid when selected. */
function LibraryCardCheck({
  selected,
  title,
  inline = false,
}: {
  readonly selected: boolean;
  readonly title: string;
  /** List rows render the check inline instead of corner-anchored. */
  readonly inline?: boolean;
}) {
  const { format } = useTranslation();
  return (
    <span
      data-moss-library-item-checkbox
      data-state={selected ? "selected" : "unselected"}
      aria-label={format("library.card.select", { title })}
      className={cn(
        "flex size-5 items-center justify-center rounded-full shadow-sm transition-opacity",
        inline ? "pointer-events-none shrink-0" : "pointer-events-none absolute bottom-2 right-2",
        selected
          ? "bg-foreground text-background opacity-100"
          : "bg-background/90 text-transparent ring-1 ring-inset ring-border/60 opacity-0 group-hover:opacity-100",
      )}
    >
      <CheckIcon className="size-3" aria-hidden="true" />
    </span>
  );
}

interface LibraryCardTitleProps {
  readonly item: MossLibraryItem;
  readonly editing: boolean;
  readonly onCommitRename: (title: string) => void;
  readonly onCancelRename: () => void;
}

function LibraryCardTitle({
  item,
  editing,
  onCommitRename,
  onCancelRename,
}: LibraryCardTitleProps) {
  const { t } = useTranslation();
  if (!editing) {
    return <p className="truncate text-ui-sm font-medium text-foreground">{item.title}</p>;
  }
  return (
    <input
      type="text"
      defaultValue={item.title}
      autoFocus
      data-moss-library-rename-input
      aria-label={t("library.action.rename")}
      className="w-full rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-ui-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommitRename(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancelRename();
        }
      }}
      onBlur={(event) => onCommitRename(event.currentTarget.value)}
    />
  );
}

/** Shared tile look — skeleton and empty-state placeholders must be pixel-identical
 *  so the single skeleton→content swap never pops (Codex single-phase loading). */
const LIBRARY_TILE_CLASS = "mb-3 break-inside-avoid rounded-2xl bg-[#f4f4f6] dark:bg-[#2a2a2c]";

/** Content masonry columns — the skeleton grid mirrors this exactly. */
const LIBRARY_MASONRY_COLUMNS_CLASS =
  "columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6";

/** Minimum skeleton visibility so a sync store resolve cannot flash the grid. */
const LIBRARY_SKELETON_MIN_MS = 480;

function LibrarySkeletonMasonry({
  tiles,
}: {
  readonly tiles: readonly { key: string; height: number }[];
}) {
  const { t } = useTranslation();
  return (
    <div
      data-moss-library-skeleton
      data-moss-library-skeleton-view="grid"
      data-moss-library-masonry
      className={LIBRARY_MASONRY_COLUMNS_CLASS}
      aria-busy="true"
      aria-label={t("library.loading")}
    >
      {tiles.map((tile) => (
        <div key={tile.key} className={LIBRARY_TILE_CLASS} style={{ height: tile.height }} />
      ))}
    </div>
  );
}

/** Codex list-mode first-load skeleton: 名称 / 最近活动时间 column rows. */
function LibrarySkeletonList() {
  const { t } = useTranslation();
  return (
    <div
      data-moss-library-skeleton
      data-moss-library-skeleton-view="list"
      aria-busy="true"
      aria-label={t("library.loading")}
    >
      <div className="flex items-center justify-between px-3 pb-2 text-ui-xs text-muted-foreground">
        <span>{t("library.column.name")}</span>
        <span>{t("library.column.lastActivity")}</span>
      </div>
      <div className="flex flex-col" data-moss-library-skeleton-rows>
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-3 py-2.5">
            <span className="size-5 shrink-0 rounded-md bg-[#f0f0f2] dark:bg-[#2a2a2c]" />
            <span
              className="h-3 rounded-full bg-[#f0f0f2] dark:bg-[#2a2a2c]"
              style={{ width: `${34 + ((index * 13) % 30)}%` }}
            />
            <span className="ml-auto h-3 w-16 rounded-full bg-[#f0f0f2] dark:bg-[#2a2a2c]" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MossLibrarySurface({
  onClose,
  initialItems,
  now: nowProp,
  seedDemoIfEmpty = false,
  onStartConversation,
  isCurrent: ownerIsCurrent,
  threadId,
  prepareThread,
  onCanvasLeaveGuardChange,
}: MossLibrarySurfaceProps) {
  const mounted = useRef(false);
  const ownerGuard = useRef(ownerIsCurrent);
  ownerGuard.current = ownerIsCurrent;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(() => mounted.current && ownerGuard.current?.() !== false, []);
  const [sectionId, setSectionId] = useState<MossLibrarySectionId>("recommended");
  const [viewMode, setViewMode] = useState<MossLibraryViewMode>("grid");
  const [query, setQuery] = useState("");
  const [sortId, setSortId] = useState<MossLibrarySortId>("recent");
  const [filterOpen, setFilterOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [clock, setClock] = useState(() => nowProp ?? Date.now());
  const importInputRef = useRef<HTMLInputElement>(null);

  // Codex interaction state: multi-select, context menu, rename, folder drill-down.
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [contextMenu, setContextMenu] = useState<LibraryContextMenuState | null>(null);
  const [contextMenuView, setContextMenuView] = useState<"root" | "folders">("root");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [folderViewId, setFolderViewId] = useState<string | null>(null);
  const [selectionMoreOpen, setSelectionMoreOpen] = useState(false);
  const [selectionMoreView, setSelectionMoreView] = useState<"root" | "folders">("root");
  const [trashOpen, setTrashOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasSelection, setCanvasSelection] = useState<{
    selection: MossCanvasSelection;
    binding: MossCanvasBinding;
  } | null>(null);
  const canvasSelectionRef = useRef(canvasSelection);
  canvasSelectionRef.current = canvasSelection;
  const canvasInvalid = useRef(false);
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  useEffect(() => {
    setCanvasSelection(null);
  }, [threadId]);
  const [canvasSaving, setCanvasSaving] = useState(false);
  const canvasSavingRef = useRef(false);
  const canvasFlush = useRef<(() => Promise<boolean>) | null>(null);
  const registerCanvasGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      canvasFlush.current = guard;
      onCanvasLeaveGuardChange?.(
        guard
          ? async () => !canvasSavingRef.current && (await guard()) && !canvasSavingRef.current
          : null,
      );
    },
    [onCanvasLeaveGuardChange],
  );

  const isLocalMode = Boolean(initialItems);
  const storeItems = useMossLibraryItemsStore((state) => state.items);
  const trashedStoreItems = useMossLibraryItemsStore((state) => state.trashedItems);
  const thumbnails = useMossLibraryItemsStore((state) => state.thumbnails);
  const catalogSource = useMossLibraryItemsStore((state) => state.catalogSource);
  const storeHydrated = useMossLibraryItemsStore((state) => state.hydrated);
  const loadError = useMossLibraryItemsStore((state) => state.loadError);
  const refreshStore = useMossLibraryItemsStore((state) => state.refresh);
  const favoriteStoreItems = useMossLibraryItemsStore((state) => state.favoriteItems);
  const moveStoreItems = useMossLibraryItemsStore((state) => state.moveItemsToFolder);
  const renameStoreItem = useMossLibraryItemsStore((state) => state.renameItem);
  const trashStoreItems = useMossLibraryItemsStore((state) => state.trashItems);
  const restoreStoreItems = useMossLibraryItemsStore((state) => state.restoreItems);
  const deleteStoreItemsPermanently = useMossLibraryItemsStore(
    (state) => state.deleteItemsPermanently,
  );
  const createFolderOnServer = useMossLibraryItemsStore((state) => state.createFolderOnServer);
  const renameFolderOnServer = useMossLibraryItemsStore((state) => state.renameFolderOnServer);
  const deleteFolderOnServer = useMossLibraryItemsStore((state) => state.deleteFolderOnServer);
  const importFileBlobs = useMossLibraryItemsStore((state) => state.importFileBlobs);
  const ensureThumbnail = useMossLibraryItemsStore((state) => state.ensureThumbnail);
  const setStoreItems = useMossLibraryItemsStore((state) => state.setItems);

  const demoItemsVisibleRef = useRef(
    Boolean(seedDemoIfEmpty && initialItems?.some((item) => item.isDemo)),
  );
  const [items, setItems] = useState<MossLibraryItem[]>(() =>
    initialItems ? initialItems.filter((item) => seedDemoIfEmpty || !item.isDemo) : [],
  );
  const hydrated = isLocalMode || storeHydrated;
  // Single-phase loading: the skeleton holds until the catalog is hydrated AND the
  // minimum visibility window passed, then swaps to content exactly once.
  const [skeletonMinElapsed, setSkeletonMinElapsed] = useState(Boolean(initialItems));

  useEffect(() => {
    if (nowProp != null) {
      setClock(nowProp);
      return;
    }
    const id = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [nowProp]);

  useEffect(() => {
    if (initialItems) {
      const nextItems = initialItems.filter((item) => seedDemoIfEmpty || !item.isDemo);
      demoItemsVisibleRef.current = seedDemoIfEmpty && nextItems.some((item) => item.isDemo);
      setItems(nextItems);
      return;
    }
    // Store mode: the server index is the source of truth.
    void refreshStore();
  }, [refreshStore, initialItems, seedDemoIfEmpty]);

  // Stay in sync when store mutates after mount (import / server mutations).
  useEffect(() => {
    if (initialItems) return;
    if (!storeHydrated) return;
    if (seedDemoIfEmpty && storeItems.length === 0 && demoItemsVisibleRef.current) return;
    demoItemsVisibleRef.current = false;
    setItems(storeItems.filter((item) => !item.isDemo));
  }, [initialItems, seedDemoIfEmpty, storeHydrated, storeItems]);

  const section = resolveMossLibrarySection(sectionId);
  const sort = resolveMossLibrarySort(sortId);
  const normalizedQuery = normalizeMossLibraryQuery(query);
  const { t, format } = useTranslation();
  const collectionKey = `${sectionId}:${sortId}:${query}:${folderViewId ?? ""}`;
  const [pageWindow, setPageWindow] = useState({ key: "", limit: 60 });
  const renderLimit = pageWindow.key === collectionKey ? pageWindow.limit : 60;
  const now = nowProp ?? clock;

  const visibleItems = useMemo(
    () =>
      filterMossLibraryItems(items, {
        sectionId: section.id,
        query,
        sortId: sort.id,
      }),
    [items, query, section.id, sort.id],
  );

  const folderViewItem = folderViewId
    ? (items.find((item) => item.id === folderViewId && item.kind === "folder") ?? null)
    : null;

  const folderChildren = useMemo(() => {
    if (!folderViewItem) return [];
    const children = mossLibraryFolderChildren(items, folderViewItem.id);
    if (!normalizedQuery) return children;
    return children.filter((item) =>
      [item.title, item.subtitleZh, item.path ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [folderViewItem, items, normalizedQuery]);

  // Codex 全部 tab (image ref 10): 文件夹 group above, 项目 grid below.
  const allPartition = useMemo(() => {
    if (folderViewItem || section.id !== "all" || normalizedQuery) return null;
    return partitionMossLibraryAllSection(visibleItems);
  }, [folderViewItem, section.id, normalizedQuery, visibleItems]);

  const folders = useMemo(() => items.filter((item) => item.kind === "folder"), [items]);

  const tiles = useMemo(
    () =>
      mossLibraryEmptyHeightsForSection(section.id).map((height, index) => ({
        key: `${section.id}-${index}`,
        height,
      })),
    [section.id],
  );

  const showSearchEmpty =
    !folderViewItem &&
    Boolean(normalizedQuery) &&
    visibleItems.length === 0 &&
    (items.length > 0 || !mossLibrarySectionMatchesQuery(section, query));

  // Codex Library paints the whole page (header + skeleton grid) as one frame, then
  // swaps skeleton → content once. No fixed-duration two-stage timing: the swap is
  // gated on hydration plus a short minimum window so fast resolves cannot flash.
  useEffect(() => {
    if (initialItems) {
      setSkeletonMinElapsed(true);
      return;
    }
    const timer = window.setTimeout(() => setSkeletonMinElapsed(true), LIBRARY_SKELETON_MIN_MS);
    return () => window.clearTimeout(timer);
  }, [initialItems]);

  const showSkeleton = !(hydrated && skeletonMinElapsed);

  const showEmptyMasonry =
    hydrated && !showSkeleton && !folderViewItem && visibleItems.length === 0 && !showSearchEmpty;

  // Lazily resolve servable thumbnails for image cards backed by a local path.
  useEffect(() => {
    if (isLocalMode) return;
    const displayedItems = folderViewItem ? folderChildren : visibleItems;
    for (const item of displayedItems) {
      if (item.kind === "image") ensureThumbnail(item);
    }
  }, [isLocalMode, folderViewItem, folderChildren, visibleItems, ensureThumbnail]);

  // Escape layering: trash view > context menu > selection > folder drill-down > close.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (canvasOpen) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      if (selectionMoreOpen) {
        setSelectionMoreOpen(false);
        return;
      }
      if (trashOpen) {
        setTrashOpen(false);
        return;
      }
      if (selectedIds.length > 0) {
        setSelectedIds([]);
        return;
      }
      if (folderViewId) {
        setFolderViewId(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canvasOpen,
    contextMenu,
    selectionMoreOpen,
    trashOpen,
    selectedIds.length,
    folderViewId,
    onClose,
  ]);

  // Click-away dismisses the card context menu and the selection-bar more menu.
  useEffect(() => {
    if (!contextMenu && !selectionMoreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest("[data-moss-library-context-menu]") ||
        target.closest("[data-moss-library-selection-more]") ||
        target.closest("[data-moss-library-item-menu]")
      ) {
        return;
      }
      setContextMenu(null);
      setSelectionMoreOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [contextMenu, selectionMoreOpen]);

  const announce = (message: string) => {
    if (!isCurrent()) return;
    setToast(message);
    window.setTimeout(() => {
      if (isCurrent()) setToast(null);
    }, 2400);
  };

  const confirmMutation = async (work: Promise<boolean>, success: string) => {
    try {
      const ok = await work;
      if (!isCurrent()) return false;
      announce(ok ? success : t("library.notice.unconfirmed"));
      return ok;
    } catch {
      announce(t("library.notice.unconfirmed"));
      return false;
    }
  };

  const commitItems = (next: MossLibraryItem[]) => {
    setItems(next);
    if (!initialItems) {
      setStoreItems(next);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((current) => toggleMossLibrarySelectedId(current, id));
  };

  const openFolder = (item: MossLibraryItem) => {
    setFolderViewId(item.id);
    setSelectedIds([]);
    setContextMenu(null);
  };

  const handleCardClick = (item: MossLibraryItem) => {
    if (item.kind === "folder" && !folderViewItem) {
      openFolder(item);
      return;
    }
    toggleSelect(item.id);
  };

  const openContextMenuAt = (item: MossLibraryItem, x: number, y: number) => {
    setContextMenuView("root");
    setContextMenu({ x, y, itemId: item.id });
    setSelectedIds((current) => (current.includes(item.id) ? current : [item.id]));
  };

  const handleCardContextMenu = (event: MouseEvent, item: MossLibraryItem) => {
    event.preventDefault();
    openContextMenuAt(item, event.clientX, event.clientY);
  };

  const contextTargetIds: readonly string[] = contextMenu
    ? selectedIds.includes(contextMenu.itemId) && selectedIds.length > 0
      ? selectedIds
      : [contextMenu.itemId]
    : [];

  const downloadItems = async (ids: readonly string[]) => {
    let downloaded = 0;
    let skipped = 0;
    let lastError: unknown = null;
    for (const id of ids) {
      const item = items.find((entry) => entry.id === id);
      if (!item) continue;
      if (!isCurrent()) return;
      try {
        await downloadMossLibraryItem(item, isCurrent);
        if (!isCurrent()) return;
        downloaded += 1;
      } catch (error) {
        if (!isCurrent()) return;
        skipped += 1;
        lastError = error;
      }
    }
    if (downloaded > 0 && skipped === 0) {
      announce(format("library.notice.downloadStarted", { count: downloaded }));
    } else if (downloaded > 0) {
      announce(format("library.notice.downloadPartial", { count: downloaded, skipped }));
    } else {
      announce(describeLocalizedError(lastError, format, "library.notice.downloadFailed"));
    }
  };

  const startContentConversation = async (ids: readonly string[]) => {
    const selected = ids.flatMap((id) => {
      const item = items.find((entry) => entry.id === id);
      return item && item.kind !== "folder"
        ? [
            {
              ...item,
              ...(thumbnails[item.id] && !item.thumbnailUrl
                ? { thumbnailUrl: thumbnails[item.id] }
                : {}),
            },
          ]
        : [];
    });
    if (!onStartConversation || selected.length === 0) {
      announce(t("library.notice.attachFailed"));
      return;
    }
    try {
      await onStartConversation(selected);
    } catch (error) {
      announce(describeLocalizedError(error, format, "library.notice.chatOpenFailed"));
    }
  };

  const deleteItems = async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    let confirmedIds = [...ids];
    const folderIds = ids.filter((id) => items.find((item) => item.id === id)?.kind === "folder");
    const fileIds = ids.filter((id) => !folderIds.includes(id));
    if (isLocalMode) {
      commitItems(removeMossLibraryItemsById(items, ids));
    } else {
      // 回收站 two-stage: files move to trash; virtual folders delete outright.
      confirmedIds = [];
      const groups = [
        ...(fileIds.length > 0 ? [{ ids: fileIds, work: trashStoreItems(fileIds) }] : []),
        ...folderIds.map((id) => ({ ids: [id], work: deleteFolderOnServer(id) })),
      ];
      const results = await Promise.allSettled(groups.map(({ work }) => work));
      if (!isCurrent()) return;
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value) confirmedIds.push(...groups[index]!.ids);
      });
    }
    const removed = new Set(confirmedIds);
    setSelectedIds((current) => current.filter((id) => !removed.has(id)));
    if (folderViewId && removed.has(folderViewId)) setFolderViewId(null);
    if (trashOpen) setTrashOpen(false);
    if (confirmedIds.length !== ids.length) {
      announce(format("library.notice.partiallyConfirmed", { count: confirmedIds.length }));
      return;
    }
    announce(
      isLocalMode
        ? format("library.notice.deleted", { count: ids.length })
        : fileIds.length > 0
          ? t("library.notice.movedToTrash")
          : format("library.notice.deleted", { count: ids.length }),
    );
  };

  const toggleFavoriteItems = async (selected: readonly string[]) => {
    const ids = selected.filter((id) =>
      items.some((item) => item.id === id && item.kind !== "folder"),
    );
    if (ids.length === 0) {
      announce(t("library.notice.selectToFavorite"));
      return;
    }
    const nextFavorite = !mossLibraryItemsAllFavorite(items, ids);
    const favoriteNotice = format(
      nextFavorite ? "library.notice.favorited" : "library.notice.unfavorited",
      { count: ids.length },
    );
    if (isLocalMode) {
      commitItems(setMossLibraryItemsFavorite(items, ids, nextFavorite));
    } else {
      await confirmMutation(favoriteStoreItems(ids, nextFavorite), favoriteNotice);
      return;
    }
    announce(favoriteNotice);
  };

  const assignToFolder = async (selected: readonly string[], folderId: string | null) => {
    const ids = selected.filter((id) =>
      items.some((item) => item.id === id && item.kind !== "folder"),
    );
    if (ids.length === 0) {
      announce(t("library.notice.selectToFile"));
      return;
    }
    if (isLocalMode) {
      commitItems(assignMossLibraryItemsToFolder(items, ids, folderId));
    }
    const folder = folderId ? items.find((item) => item.id === folderId) : null;
    const message = folder
      ? format("library.notice.addedToFolder", { folder: folder.title })
      : t("library.notice.removedFromFolder");
    if (isLocalMode) announce(message);
    else await confirmMutation(moveStoreItems(ids, folderId), message);
  };

  /** Codex 重命名 rule: refuse extension changes before any mutation. */
  const commitRename = (item: MossLibraryItem, rawTitle: string) => {
    setEditingId(null);
    const title = rawTitle.trim();
    if (!title || title === item.title) return;
    if (item.kind !== "folder" && !mossLibraryRenameKeepsExtension(item.title, title)) {
      announce(t("library.notice.extensionLocked"));
      return;
    }
    if (isLocalMode) {
      commitItems(renameMossLibraryItem(items, item.id, title, now));
      return;
    }
    if (item.kind === "folder") {
      // Server folders live in their own table.
      void confirmMutation(renameFolderOnServer(item.id, title), t("library.notice.folderRenamed"));
      return;
    }
    void confirmMutation(renameStoreItem(item.id, title), t("library.notice.fileRenamed"));
  };

  const runContextAction = (actionId: MossLibraryContextActionId) => {
    if (!contextMenu) return;
    const ids = contextTargetIds;
    switch (actionId) {
      case "chat":
        void startContentConversation(ids);
        setContextMenu(null);
        break;
      case "favorite":
        void toggleFavoriteItems(ids);
        setContextMenu(null);
        break;
      case "download":
        void downloadItems(ids);
        setContextMenu(null);
        break;
      case "share": {
        const selected = items.filter((item) => ids.includes(item.id));
        void shareMossLibraryImage(selected, isCurrent).then(
          () => announce(t("library.notice.imageCopied")),
          (error: unknown) =>
            announce(describeLocalizedError(error, format, "library.notice.shareFailed")),
        );
        setContextMenu(null);
        break;
      }
      case "rename":
        setEditingId(contextMenu.itemId);
        setContextMenu(null);
        break;
      case "add-to-folder":
        setContextMenuView("folders");
        break;
      case "delete":
        void deleteItems(ids);
        setContextMenu(null);
        break;
    }
  };

  const runSelectionAction = (actionId: "chat" | "download" | "delete") => {
    const ids = selectedIds;
    if (ids.length === 0) return;
    if (actionId === "chat") {
      void startContentConversation(ids);
    } else if (actionId === "download") {
      void downloadItems(ids);
    } else {
      void deleteItems(ids);
    }
  };

  const runNewAction = async (actionId: (typeof MOSS_LIBRARY_NEW_ACTIONS)[number]["id"]) => {
    setNewOpen(false);
    if (actionId === "import") {
      importInputRef.current?.click();
      return;
    }
    if (actionId === "from-chatgpt") {
      // 从 ChatGPT 资料库导入：user picks the folder they batch-downloaded from
      // chatgpt.com/library; every file inside is copied into the Moss library.
      directoryInputRef.current?.click();
      return;
    }
    if (actionId === "folder") {
      if (isLocalMode) {
        const folder = createMossLibraryFolder(t("library.folder.untitled"), now);
        commitItems([folder, ...items]);
        setEditingId(folder.id);
      } else {
        try {
          const folder = await createFolderOnServer(t("library.folder.untitled"));
          if (!isCurrent()) return;
          if (!folder) {
            announce(t("library.notice.folderUnconfirmed"));
            return;
          }
          setEditingId(folder.id);
        } catch {
          announce(t("library.notice.folderCreateFailed"));
          return;
        }
      }
      if (section.id !== "all" && section.id !== "folders") setSectionId("folders");
      announce(t("library.notice.folderCreated"));
      return;
    }
    if (!threadId && !prepareThread) {
      announce(t("library.notice.openChatForCanvas"));
      return;
    }
    setCanvasSelection(null);
    canvasInvalid.current = false;
    setCanvasOpen(true);
  };

  const importFilesToLibrary = async (
    files: readonly File[],
    operationCurrent: () => boolean = isCurrent,
  ) => {
    const assertCurrent = () => {
      if (!isCurrent() || !operationCurrent())
        throw new DOMException("The library changed.", "AbortError");
    };
    assertCurrent();
    const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
    const accepted = files.filter((file) => file.size > 0 && file.size <= MAX_IMPORT_BYTES);
    const skipped = files.length - accepted.length;
    const blobs = await Promise.all(
      accepted.map(async (file) => ({
        name: file.name,
        dataBase64: await fileToBase64(file),
        ...(file.type ? { mimeType: file.type } : {}),
      })),
    );
    assertCurrent();
    const result = await importFileBlobs(blobs);
    assertCurrent();
    const total = result.imported;
    const totalSkipped = result.skipped + skipped;
    setSectionId("all");
    announce(
      totalSkipped > 0
        ? format("library.notice.importedWithSkipped", { count: total, skipped: totalSkipped })
        : format("library.notice.imported", { count: total }),
    );
    return result;
  };

  const saveCanvasSelection = async () => {
    const snapshot = canvasSelectionRef.current;
    if (!snapshot?.selection.items.length || canvasSavingRef.current) return;
    const current = () =>
      isCurrent() &&
      !canvasInvalid.current &&
      canvasSelectionRef.current === snapshot &&
      (!currentThread.current ||
        currentThread.current === snapshot.binding.expectedWorkspace.threadId);
    canvasSavingRef.current = true;
    setCanvasSaving(true);
    try {
      if (!(await canvasFlush.current?.()) || !current()) {
        throw new Error("The canvas or its selection is not confirmed yet.");
      }
      const files: File[] = [];
      for (const item of snapshot.selection.items) {
        if (!current()) throw new Error("The canvas selection changed.");
        files.push(await readMossCanvasSelectionFile(item, snapshot.binding));
      }
      if (!current()) throw new Error("The canvas selection changed.");
      const result = await importFilesToLibrary(files, current);
      if (current() && result.imported === files.length && result.skipped === 0) {
        setCanvasOpen(false);
        setCanvasSelection(null);
      }
    } catch (error) {
      announce(
        error instanceof Error && error.name === "AbortError"
          ? t("library.canvas.accountChanged")
          : t("library.canvas.saveUnconfirmed"),
      );
    } finally {
      canvasSavingRef.current = false;
      if (isCurrent()) setCanvasSaving(false);
    }
  };

  const handleFileImport = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = [...files];
    if (!isLocalMode) {
      void importFilesToLibrary(list).catch(() => announce(t("library.notice.importUnconfirmed")));
      if (importInputRef.current) importInputRef.current.value = "";
      if (directoryInputRef.current) directoryInputRef.current.value = "";
      return;
    }
    const imported = list.map((file) =>
      ingestMossLibraryItemFromCliFile({
        title: file.name,
        sourceCli: "moss",
        path: file.webkitRelativePath || file.name,
        updatedAt: file.lastModified || now,
        ...(file.type ? { mimeType: file.type } : {}),
      }),
    );
    const importedIds = new Set(imported.map((item) => item.id));
    const next = [...imported, ...items.filter((item) => !importedIds.has(item.id))];
    commitItems(next);
    setSectionId("all");
    announce(format("library.notice.imported", { count: imported.length }));
    if (importInputRef.current) importInputRef.current.value = "";
    if (directoryInputRef.current) directoryInputRef.current.value = "";
  };

  const handleDragOver = (event: DragEvent) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    setDropActive(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (event.currentTarget === event.target) setDropActive(false);
  };

  const handleDrop = (event: DragEvent) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    setDropActive(false);
    handleFileImport(event.dataTransfer.files);
  };

  const renderGridCard = (item: MossLibraryItem) => {
    const selected = selectedIds.includes(item.id);
    const isImage = item.kind === "image";
    const hasImage = isImage && Boolean(item.thumbnailUrl ?? thumbnails[item.id]);
    const isFolder = item.kind === "folder";
    const editing = editingId === item.id;
    const title = (
      <LibraryCardTitle
        item={item}
        editing={editing}
        onCommitRename={(nextTitle) => commitRename(item, nextTitle)}
        onCancelRename={() => setEditingId(null)}
      />
    );
    return (
      <article
        key={item.id}
        aria-label={item.title}
        data-moss-library-item={item.id}
        data-moss-library-item-kind={item.kind}
        data-moss-library-item-source={item.sourceCli}
        data-moss-library-item-selected={selected ? "true" : "false"}
        onClick={() => handleCardClick(item)}
        onContextMenu={(event) => handleCardContextMenu(event, item)}
        className={cn(
          "group relative mb-3 break-inside-avoid overflow-hidden rounded-2xl ring-1 ring-inset transition-shadow",
          isImage ? "bg-muted/45" : "bg-surface shadow-sm",
          selected ? "ring-2 ring-foreground/70" : "ring-border/25 hover:ring-border/50",
        )}
      >
        {isFolder ? (
          <div className="flex min-h-11 items-center gap-2 border-b border-border/30 px-3 py-2.5">
            <FolderIcon className="size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">{title}</div>
          </div>
        ) : null}
        <div
          className={cn(
            "relative flex items-center justify-center overflow-hidden",
            isImage
              ? hasImage
                ? "bg-muted/60"
                : "aspect-square bg-muted/60"
              : isFolder
                ? "aspect-[5/4]"
                : "h-28 bg-muted/40",
          )}
        >
          <LibraryCardThumb item={item} thumbUrl={thumbnails[item.id]} />
          <button
            type="button"
            aria-label={format("library.card.moreActions", { title: item.title })}
            data-moss-library-item-menu={item.id}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openContextMenuAt(item, rect.left, rect.bottom + 4);
            }}
            className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-black/30 text-white opacity-0 transition-opacity hover:bg-black/45 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <EllipsisIcon className="size-4" aria-hidden="true" />
          </button>
          <LibraryCardCheck selected={selected} title={item.title} />
        </div>
        {!isFolder && (!isImage || editing) ? (
          <div className="space-y-1.5 px-3 py-2.5">
            {title}
            {!isImage ? (
              <>
                <p className="truncate text-ui-xs text-muted-foreground">
                  {formatMossLibraryItemSubtitle(item, format)}
                </p>
                <LibraryCardMeta item={item} now={now} />
              </>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  };

  const renderListCard = (item: MossLibraryItem) => {
    const selected = selectedIds.includes(item.id);
    return (
      <article
        key={item.id}
        data-moss-library-item={item.id}
        data-moss-library-item-kind={item.kind}
        data-moss-library-item-source={item.sourceCli}
        data-moss-library-item-selected={selected ? "true" : "false"}
        onClick={() => handleCardClick(item)}
        onContextMenu={(event) => handleCardContextMenu(event, item)}
        className={cn(
          "group relative flex min-h-14 items-center gap-3 rounded-xl border px-4 py-2 transition-colors",
          selected
            ? "border-foreground/50 bg-muted/60"
            : "border-border/50 bg-card/40 hover:border-border",
        )}
      >
        <span
          className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/70"
          aria-hidden="true"
        >
          {item.kind === "image" && (item.thumbnailUrl ?? thumbnails[item.id]) ? (
            <img
              src={item.thumbnailUrl ?? thumbnails[item.id]}
              alt=""
              className="size-full object-cover"
              data-moss-library-thumb
            />
          ) : item.kind === "folder" ? (
            <FolderIcon className="size-4 text-muted-foreground" />
          ) : (
            <span className="size-3 rounded-sm bg-muted-foreground/35" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <LibraryCardTitle
            item={item}
            editing={editingId === item.id}
            onCommitRename={(title) => commitRename(item, title)}
            onCancelRename={() => setEditingId(null)}
          />
          <p className="truncate text-ui-xs text-muted-foreground">
            {formatMossLibraryItemSubtitle(item, format)}
          </p>
          <LibraryCardMeta item={item} now={now} />
        </div>
        <button
          type="button"
          aria-label={format("library.card.moreActions", { title: item.title })}
          data-moss-library-item-menu={item.id}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openContextMenuAt(item, rect.left, rect.bottom + 4);
          }}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        >
          <EllipsisIcon className="size-4" aria-hidden="true" />
        </button>
        <LibraryCardCheck selected={selected} title={item.title} inline />
      </article>
    );
  };

  const renderItemCollection = (collection: readonly MossLibraryItem[], label: string) => (
    <div className="space-y-3">
      {viewMode === "grid" ? (
        <div
          className={LIBRARY_MASONRY_COLUMNS_CLASS}
          data-moss-library-masonry
          data-moss-library-has-items="true"
          aria-label={label}
        >
          {collection.slice(0, renderLimit).map(renderGridCard)}
        </div>
      ) : (
        <div
          className="flex flex-col gap-2"
          data-moss-library-list
          data-moss-library-has-items="true"
        >
          {collection.slice(0, renderLimit).map(renderListCard)}
        </div>
      )}
      {collection.length > renderLimit ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPageWindow({ key: collectionKey, limit: renderLimit + 60 })}
        >
          {format("library.showMore", {
            shown: Math.min(renderLimit, collection.length),
            total: collection.length,
          })}
        </Button>
      ) : null}
    </div>
  );

  const contextMenuItem = contextMenu
    ? (items.find((item) => item.id === contextMenu.itemId) ?? null)
    : null;

  const contextMenuStyle = (() => {
    if (!contextMenu || typeof window === "undefined") return undefined;
    return {
      left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 232)),
      top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 320)),
    };
  })();

  const renderFolderPicker = (ids: readonly string[], onDone: () => void): ReactNode => (
    <div data-moss-library-folder-picker>
      <p className="px-3 py-1.5 text-ui-xs text-muted-foreground">
        {t("library.action.addToFolder")}
      </p>
      {folders.length === 0 ? (
        <p className="px-3 py-2 text-ui-xs text-muted-foreground">
          {t("library.folderMenu.empty")}
        </p>
      ) : (
        folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            role="menuitem"
            data-moss-library-folder-option={folder.id}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted"
            onClick={() => {
              assignToFolder(ids, folder.id);
              onDone();
            }}
          >
            <FolderIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{folder.title}</span>
          </button>
        ))
      )}
      {ids.some((id) => items.find((item) => item.id === id)?.folderId) ? (
        <button
          type="button"
          role="menuitem"
          data-moss-library-folder-remove
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-muted"
          onClick={() => {
            assignToFolder(ids, null);
            onDone();
          }}
        >
          <XIcon className="size-4" aria-hidden="true" />
          {t("library.action.removeFromFolder")}
        </button>
      ) : null}
    </div>
  );

  if (canvasOpen)
    return (
      <section
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
        data-moss-library-canvas-picker
      >
        <MossCanvasWebSurface
          threadId={threadId ?? null}
          {...(prepareThread ? { prepareThread } : {})}
          onClose={() => {
            if (!canvasSavingRef.current) setCanvasOpen(false);
          }}
          onLeaveGuardChange={registerCanvasGuard}
          onImportStateChange={(state) => {
            if (state !== "failed") return;
            canvasInvalid.current = true;
            setCanvasSelection(null);
          }}
          onSelectionChange={(selection, binding) => {
            if (
              !isCurrent() ||
              canvasInvalid.current ||
              selection.threadId !== binding.expectedWorkspace.threadId ||
              (threadId && selection.threadId !== threadId)
            )
              return;
            setCanvasSelection({ selection, binding });
          }}
        />
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-3 text-ui-sm">
          <span className="mr-auto text-muted-foreground">{t("library.canvas.hint")}</span>
          <Button
            disabled={canvasSaving || !canvasSelection?.selection.items.length}
            onClick={() => void saveCanvasSelection()}
            data-moss-library-canvas-save
          >
            {canvasSaving
              ? t("library.canvas.saving")
              : canvasSelection?.selection.items.length
                ? format("library.canvas.saveSelectedCount", {
                    count: canvasSelection.selection.items.length,
                  })
                : t("library.canvas.saveSelected")}
          </Button>
        </div>
        {toast ? (
          <div role="status" className="px-4 py-2 text-ui-sm" data-moss-library-toast>
            {toast}
          </div>
        ) : null}
      </section>
    );

  return (
    <section
      aria-label={t("library.ariaLabel")}
      data-moss-library-host
      data-canvas-surface="library"
      data-moss-library-destination="full"
      data-moss-library-view={viewMode}
      data-moss-library-sort={sort.id}
      data-moss-library-item-count={items.length}
      data-moss-library-catalog-source={catalogSource}
      data-moss-library-loading={showSkeleton ? "true" : "false"}
      data-moss-library-selection-count={selectedIds.length}
      data-moss-library-drop-active={dropActive ? "true" : "false"}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-foreground",
        // One background for loading and loaded states — the swap must not flicker.
        "bg-surface",
      )}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[1392px] flex-1 flex-col pt-8">
        <div className="shrink-0 space-y-6 px-6 pb-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <h1 className={PAGE_TITLE_CLASS_NAME}>{t("library.title")}</h1>

            <div className="flex flex-wrap items-center gap-2" data-moss-library-toolbar>
              <button
                type="button"
                aria-label={t("library.filter")}
                aria-pressed={filterOpen}
                data-moss-library-filter
                onClick={() => {
                  setFilterOpen((open) => !open);
                  setNewOpen(false);
                  setSortOpen(false);
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-colors",
                  filterOpen
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
              >
                <FilterIcon className="size-4" aria-hidden="true" />
              </button>

              <div
                className="inline-flex items-center gap-1"
                role="group"
                aria-label={t("library.view.switch")}
              >
                <button
                  type="button"
                  aria-label={t("library.view.grid")}
                  aria-pressed={viewMode === "grid"}
                  data-moss-library-view-toggle="grid"
                  onClick={() => setViewMode("grid")}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full transition-colors",
                    viewMode === "grid"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <AppsIcon className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={t("library.view.list")}
                  aria-pressed={viewMode === "list"}
                  data-moss-library-view-toggle="list"
                  onClick={() => setViewMode("list")}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full transition-colors",
                    viewMode === "list"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Rows3Icon className="size-4" aria-hidden="true" />
                </button>
              </div>

              <label className="relative min-w-[200px] flex-1 lg:max-w-xs">
                <span className="sr-only">{t("library.search")}</span>
                <SearchIcon
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("library.search")}
                  data-moss-library-search
                  className="h-8 w-full rounded-full border border-border/70 bg-card/70 pl-9 pr-3 text-ui-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
                />
              </label>

              <div className="relative">
                <button
                  type="button"
                  data-moss-library-new
                  aria-expanded={newOpen}
                  aria-haspopup="menu"
                  onClick={() => {
                    setNewOpen((open) => !open);
                    setFilterOpen(false);
                    setSortOpen(false);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3.5 text-ui-sm font-medium text-background"
                >
                  {t("library.new")}
                  <ChevronDownIcon className="size-3 opacity-70" aria-hidden="true" />
                </button>
                {newOpen ? (
                  <div
                    role="menu"
                    data-moss-library-new-menu
                    className="absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-xl border border-border/70 bg-popover p-1 shadow-lg"
                  >
                    {MOSS_LIBRARY_NEW_ACTIONS.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        role="menuitem"
                        data-moss-library-new-action={action.id}
                        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted"
                        onClick={() => void runNewAction(action.id)}
                      >
                        <span className="text-ui-sm font-medium text-foreground">
                          {t(action.labelKey)}
                        </span>
                        <span className="text-ui-xs text-muted-foreground">
                          {t(action.hintKey)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="relative">
                <button
                  type="button"
                  aria-label={t("library.sortAndSettings")}
                  aria-expanded={sortOpen}
                  data-moss-library-settings
                  onClick={() => {
                    setSortOpen((open) => !open);
                    setNewOpen(false);
                    setFilterOpen(false);
                  }}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full transition-colors",
                    sortOpen
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  <CustomizeIcon className="size-4" aria-hidden="true" />
                </button>
                {sortOpen ? (
                  <div
                    role="menu"
                    data-moss-library-sort-menu
                    className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl border border-border/70 bg-popover p-1 shadow-lg"
                  >
                    <p className="px-3 py-1.5 text-ui-xs text-muted-foreground">
                      {t("library.sort")}
                    </p>
                    {MOSS_LIBRARY_SORT_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option.id === sortId}
                        data-moss-library-sort-option={option.id}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted",
                          option.id === sortId ? "text-foreground" : "text-muted-foreground",
                        )}
                        onClick={() => {
                          setSortId(option.id);
                          setSortOpen(false);
                        }}
                      >
                        <span>{t(option.labelKey)}</span>
                        {option.id === sortId ? (
                          <SortIcon className="size-4 opacity-70" aria-hidden="true" />
                        ) : null}
                      </button>
                    ))}
                    <div className="mx-1 my-1 h-px bg-border/60" aria-hidden="true" />
                    <p className="px-3 py-1.5 text-ui-xs text-muted-foreground">
                      {t("library.manage")}
                    </p>
                    <button
                      type="button"
                      role="menuitem"
                      data-moss-library-trash-open
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-ui-sm text-foreground transition-colors hover:bg-muted"
                      onClick={() => {
                        setSortOpen(false);
                        setFolderViewId(null);
                        setSelectedIds([]);
                        setTrashOpen(true);
                      }}
                    >
                      <TrashCanIcon className="size-4 opacity-70" aria-hidden="true" />
                      {t("library.trash")}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <nav
            aria-label="Library sections"
            data-moss-library-sections
            className="flex flex-wrap gap-1.5"
          >
            {MOSS_LIBRARY_SECTIONS.map((item) => {
              const selected = item.id === sectionId;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-moss-library-section={item.id}
                  data-state={selected ? "active" : "inactive"}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => {
                    setSectionId(item.id);
                    setFolderViewId(null);
                  }}
                  className={cn(
                    "shrink-0 rounded-full px-3.5 py-1.5 text-ui-sm font-medium transition-colors",
                    selected
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  {t(item.labelKey)}
                </button>
              );
            })}
          </nav>

          {filterOpen ? (
            <div
              data-moss-library-filter-panel
              className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-ui-xs text-muted-foreground"
            >
              <FilterIcon className="size-4 shrink-0" aria-hidden="true" />
              <span>
                {format("library.filter.currentSection", { section: t(section.labelKey) })}
              </span>
              <span className="text-border">·</span>
              <span>{format("library.sort.current", { sort: t(sort.labelKey) })}</span>
              <span className="text-border">·</span>
              <span>{t("library.filter.sources")}</span>
            </div>
          ) : null}
        </div>

        {!isLocalMode && loadError && (
          <div
            role="alert"
            className="flex items-center gap-3 px-6 py-3 text-ui-sm text-destructive"
          >
            {loadError}
            <button type="button" className="underline" onClick={() => void refreshStore()}>
              {t("library.refresh")}
            </button>
          </div>
        )}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
          data-moss-library-panel={section.id}
        >
          {showSkeleton ? (
            viewMode === "list" ? (
              <LibrarySkeletonList />
            ) : (
              <LibrarySkeletonMasonry tiles={tiles} />
            )
          ) : trashOpen ? (
            <div data-moss-library-trash-view>
              <div className="mb-4 flex items-center gap-3">
                <button
                  type="button"
                  aria-label={t("library.back")}
                  data-moss-library-trash-back
                  onClick={() => setTrashOpen(false)}
                  className="flex size-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <ArrowLeftIcon className="size-4" aria-hidden="true" />
                </button>
                <TrashCanIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-ui-lg font-medium">{t("library.trash")}</h2>
                <span className="text-ui-xs text-muted-foreground">
                  {format("library.itemCount", { count: trashedStoreItems.length })}
                </span>
                {trashedStoreItems.length > 0 ? (
                  <button
                    type="button"
                    data-moss-library-trash-empty
                    className="ml-auto inline-flex h-8 items-center rounded-full border border-border/70 px-3 text-ui-sm text-red-500 transition-colors hover:bg-muted"
                    onClick={() => {
                      void confirmMutation(
                        deleteStoreItemsPermanently(trashedStoreItems.map((item) => item.id)),
                        t("library.notice.trashEmptied"),
                      );
                    }}
                  >
                    {t("library.trash.empty")}
                  </button>
                ) : null}
              </div>
              <p className="mb-4 max-w-md text-ui-sm leading-5 text-muted-foreground">
                {t("library.trash.subtitle")}
              </p>
              {trashedStoreItems.length === 0 ? (
                <div
                  className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center"
                  data-moss-library-trash-empty-state
                >
                  <TrashCanIcon className="size-8 text-muted-foreground/60" aria-hidden="true" />
                  <p className="text-ui-lg font-medium text-foreground">
                    {t("library.trash.isEmpty")}
                  </p>
                  <p className="max-w-sm text-ui-sm leading-5 text-muted-foreground">
                    {t("library.trash.emptyHint")}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2" data-moss-library-trash-list>
                  {trashedStoreItems.map((item) => (
                    <article
                      key={item.id}
                      data-moss-library-trash-item={item.id}
                      className="flex min-h-14 items-center gap-3 rounded-xl border border-border/50 bg-card/40 px-4 py-2"
                    >
                      <span
                        className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/70"
                        aria-hidden="true"
                      >
                        {item.kind === "image" && (item.thumbnailUrl ?? thumbnails[item.id]) ? (
                          <img
                            src={item.thumbnailUrl ?? thumbnails[item.id]}
                            alt=""
                            className="size-full object-cover"
                          />
                        ) : (
                          <span className="size-3 rounded-sm bg-muted-foreground/35" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui-sm font-medium text-foreground">
                          {item.title}
                        </p>
                        <p className="truncate text-ui-xs text-muted-foreground">
                          {formatMossLibraryItemSubtitle(item, format)}
                        </p>
                      </div>
                      <button
                        type="button"
                        data-moss-library-trash-restore={item.id}
                        className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-ui-sm text-foreground transition-colors hover:bg-muted"
                        onClick={() => {
                          void confirmMutation(
                            restoreStoreItems([item.id]),
                            format("library.notice.restored", { title: item.title }),
                          );
                        }}
                      >
                        {t("library.trash.restore")}
                      </button>
                      <button
                        type="button"
                        data-moss-library-trash-delete={item.id}
                        className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-ui-sm text-red-500 transition-colors hover:bg-muted"
                        onClick={() => {
                          void confirmMutation(
                            deleteStoreItemsPermanently([item.id]),
                            t("library.notice.deletedForever"),
                          );
                        }}
                      >
                        {t("library.trash.deleteForever")}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : folderViewItem ? (
            <div data-moss-library-folder-view={folderViewItem.id}>
              <div className="mb-4 flex items-center gap-3">
                <button
                  type="button"
                  aria-label={t("library.back")}
                  data-moss-library-folder-back
                  onClick={() => setFolderViewId(null)}
                  className="flex size-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <ArrowLeftIcon className="size-4" aria-hidden="true" />
                </button>
                <FolderIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-ui-lg font-medium">{folderViewItem.title}</h2>
                <span className="text-ui-xs text-muted-foreground">
                  {format("library.itemCount", { count: folderChildren.length })}
                </span>
              </div>
              {folderChildren.length > 0 ? (
                renderItemCollection(
                  folderChildren,
                  format("library.folder.contents", { title: folderViewItem.title }),
                )
              ) : (
                <div
                  className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center"
                  data-moss-library-folder-empty
                >
                  <FolderIcon className="size-8 text-muted-foreground/60" aria-hidden="true" />
                  <p className="text-ui-lg font-medium text-foreground">
                    {t("library.folder.isEmpty")}
                  </p>
                  <p className="max-w-sm text-ui-sm leading-5 text-muted-foreground">
                    {t("library.folder.emptyHint")}
                  </p>
                </div>
              )}
            </div>
          ) : showSearchEmpty ? (
            <div
              className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-center"
              data-moss-library-search-empty
            >
              <SearchIcon className="size-8 text-muted-foreground/70" aria-hidden="true" />
              <p className="text-ui-lg font-medium">
                {format("library.search.noResults", { query: query.trim() })}
              </p>
              <p className="max-w-sm text-ui-sm leading-5 text-muted-foreground">
                {t("library.search.noResultsHint")}
              </p>
            </div>
          ) : allPartition ? (
            <div className="space-y-6" data-moss-library-grouped="all">
              {allPartition.folders.length > 0 ? (
                <section data-moss-library-group="folders" aria-label={t("library.group.folders")}>
                  <h2 className="mb-3 text-ui-sm font-medium text-foreground">
                    {t("library.group.folders")}
                  </h2>
                  {renderItemCollection(allPartition.folders, t("library.group.folders"))}
                </section>
              ) : null}
              <section data-moss-library-group="projects" aria-label={t("library.group.projects")}>
                <h2 className="mb-3 text-ui-sm font-medium text-foreground">
                  {t("library.group.projects")}
                </h2>
                {allPartition.projects.length > 0 ? (
                  renderItemCollection(allPartition.projects, t("library.group.allProjects"))
                ) : (
                  <p
                    className="text-ui-xs text-muted-foreground/80"
                    data-moss-library-empty-footnote
                  >
                    {t(section.emptyHintKey)}
                  </p>
                )}
              </section>
            </div>
          ) : visibleItems.length > 0 ? (
            renderItemCollection(
              visibleItems,
              format("library.section.items", { section: t(section.labelKey) }),
            )
          ) : showEmptyMasonry && !loadError ? (
            <div
              className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-center"
              data-moss-library-list-empty
            >
              <FolderIcon className="size-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-ui-lg font-medium text-foreground">
                {format("library.section.empty", { section: t(section.labelKey) })}
              </p>
              <p className="max-w-sm text-ui-sm leading-5 text-muted-foreground">
                {t(section.emptyHintKey)}
              </p>
            </div>
          ) : null}

          {showEmptyMasonry ? (
            <div className="mt-3 flex justify-center" data-moss-library-empty-actions>
              <button
                type="button"
                data-moss-library-empty-import-chatgpt
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/70 px-3.5 text-ui-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                onClick={() => directoryInputRef.current?.click()}
              >
                {t("library.newAction.fromChatgpt")}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        data-moss-library-import-input
        onChange={(event) => handleFileImport(event.currentTarget.files)}
      />

      <input
        ref={directoryInputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        data-moss-library-import-directory-input
        {...{ webkitdirectory: "" }}
        onChange={(event) => handleFileImport(event.currentTarget.files)}
      />

      {dropActive ? (
        <div
          data-moss-library-drop-prompt
          className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-panel border-2 border-dashed border-foreground/40 bg-background/80"
        >
          <p className="text-ui-lg font-medium text-foreground">{t("library.drop.prompt")}</p>
        </div>
      ) : null}

      {contextMenu && contextMenuItem && contextMenuStyle ? (
        <div
          role="menu"
          data-moss-library-context-menu
          data-moss-library-context-menu-for={contextMenu.itemId}
          className="fixed z-40 w-56 overflow-hidden rounded-xl border border-border/70 bg-popover p-1 shadow-lg"
          style={contextMenuStyle}
        >
          {contextMenuView === "folders"
            ? renderFolderPicker(contextTargetIds, () => setContextMenu(null))
            : buildMossLibraryContextMenu({
                favorite: mossLibraryItemsAllFavorite(items, contextTargetIds),
                kind: contextMenuItem.kind,
              }).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  data-moss-library-context-action={entry.id}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted",
                    entry.danger ? "text-red-500 hover:text-red-500" : "text-foreground",
                  )}
                  onClick={() => runContextAction(entry.id)}
                >
                  {entry.id === "chat" ? (
                    <MessageCircleIcon className="size-4 opacity-70" aria-hidden="true" />
                  ) : entry.id === "favorite" ? (
                    <StarIcon className="size-4 opacity-70" aria-hidden="true" />
                  ) : entry.id === "download" ? (
                    <DownloadIcon className="size-4 opacity-70" aria-hidden="true" />
                  ) : entry.id === "share" ? (
                    <LinkIcon className="size-4 opacity-70" aria-hidden="true" />
                  ) : entry.id === "rename" ? (
                    <PencilIcon className="size-4 opacity-70" aria-hidden="true" />
                  ) : entry.id === "add-to-folder" ? (
                    <FolderIcon className="size-4 opacity-70" aria-hidden="true" />
                  ) : (
                    <TrashCanIcon className="size-4 opacity-70" aria-hidden="true" />
                  )}
                  {t(entry.labelKey)}
                </button>
              ))}
        </div>
      ) : null}

      {selectedIds.length > 0 ? (
        <div
          data-moss-library-selection-bar
          className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-popover px-3 py-1.5 shadow-lg"
        >
          <span
            className="px-1.5 text-ui-sm text-muted-foreground"
            data-moss-library-selection-count-label
          >
            {format("library.selection.count", { count: selectedIds.length })}
          </span>
          <span className="mx-1 h-4 w-px bg-border/70" aria-hidden="true" />
          <button
            type="button"
            data-moss-library-selection-action="chat"
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-ui-sm text-foreground transition-colors hover:bg-muted"
            onClick={() => runSelectionAction("chat")}
          >
            <ChatBubblePlusIcon className="size-4" aria-hidden="true" />
            {t("library.selection.chat")}
          </button>
          <button
            type="button"
            data-moss-library-selection-action="download"
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-ui-sm text-foreground transition-colors hover:bg-muted"
            onClick={() => runSelectionAction("download")}
          >
            <DownloadIcon className="size-4" aria-hidden="true" />
            {t("library.action.download")}
          </button>
          <button
            type="button"
            data-moss-library-selection-action="delete"
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-ui-sm text-red-500 transition-colors hover:bg-muted"
            onClick={() => runSelectionAction("delete")}
          >
            <TrashCanIcon className="size-4" aria-hidden="true" />
            {t("library.action.delete")}
          </button>
          <div className="relative">
            <button
              type="button"
              aria-label={t("library.selection.more")}
              aria-expanded={selectionMoreOpen}
              data-moss-library-selection-action="more"
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                setSelectionMoreView("root");
                setSelectionMoreOpen((open) => !open);
              }}
            >
              <EllipsisIcon className="size-4" aria-hidden="true" />
            </button>
            {selectionMoreOpen ? (
              <div
                role="menu"
                data-moss-library-selection-more
                className="absolute bottom-9 right-0 z-40 w-52 overflow-hidden rounded-xl border border-border/70 bg-popover p-1 shadow-lg"
              >
                {selectionMoreView === "folders" ? (
                  renderFolderPicker(selectedIds, () => setSelectionMoreOpen(false))
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      data-moss-library-selection-more-action="favorite"
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted"
                      onClick={() => {
                        toggleFavoriteItems(selectedIds);
                        setSelectionMoreOpen(false);
                      }}
                    >
                      <StarIcon className="size-4 opacity-70" aria-hidden="true" />
                      {mossLibraryItemsAllFavorite(items, selectedIds)
                        ? t("library.action.unfavorite")
                        : t("library.action.favorite")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-moss-library-selection-more-action="add-to-folder"
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted"
                      onClick={() => setSelectionMoreView("folders")}
                    >
                      <FolderIcon className="size-4 opacity-70" aria-hidden="true" />
                      {t("library.action.addToFolder")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t("library.selection.clear")}
            data-moss-library-selection-action="dismiss"
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => {
              setSelectedIds([]);
              setSelectionMoreOpen(false);
            }}
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {toast ? (
        <div
          role="status"
          data-moss-library-toast
          className={cn(
            "pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 rounded-full border border-border/70 bg-popover px-3.5 py-1.5 text-ui-xs text-foreground shadow-lg",
            selectedIds.length > 0 ? "bottom-16" : "bottom-5",
          )}
        >
          {toast}
        </div>
      ) : null}
    </section>
  );
}
