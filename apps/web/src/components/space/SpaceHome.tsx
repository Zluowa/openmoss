// FILE: SpaceHome.tsx
// Purpose: The 资料空间's item views: 全部 (folder cards, then notes, pictures and the rest; 新建
//          tiles and 快速开始 while the space is young), one item family (页面, 幻灯片…), one
//          资料空间, a folder, a tag or a 合集 — as a grid, a list or a canvas. One header row:
//          the title, the filter (an icon until a filter is on) and the view.
// Layer: Space UI

import type { PageTypedItem, SpaceId, SpaceTemplateKind } from "@moss/contracts";
import {
  BUILT_IN_TEMPLATES,
  type SpaceTemplateDefinition,
} from "@moss/shared/spaceItems/templates";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  AddPlusIcon,
  CheckIcon,
  DataDashboardIcon,
  FilterIcon,
  FolderIcon,
  LayoutGridIcon,
  ListBulletsIcon,
  PageTextIcon,
  PaletteIcon,
  SlidesIcon,
  SparklesIcon,
  TableIcon,
  TrashCanIcon,
  WhiteboardIcon,
  XIcon,
  type LucideIcon,
} from "~/lib/icons";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { createSpaceItem } from "../spaceTypes/spaceItemTypes";
import {
  dispatchSpaceTemplateLaunch,
  getTemplateLaunchMetadata,
  type SpaceTemplateLaunchMetadata,
} from "../spaceTypes/templates/TemplatePickerDialog";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { GalleryCanvas } from "./gallery/GalleryCanvas";
import { SpaceFolderCard } from "./gallery/GalleryCards";
import { useOptionalGallery } from "./gallery/GalleryContext";
import {
  galleryClassOf,
  sortForGallery,
  type CanvasGroup,
  type GalleryFolder,
} from "./gallery/galleryModel";
import type { SpaceCreateAction } from "./SpaceCreateMenu";
import {
  clearActiveSpaceDragKeys,
  setActiveSpaceDragKeys,
  SPACE_ITEMS_DRAG_MIME,
} from "./spaceDragState";
import { SpaceMasonryGrid } from "./SpaceMasonryGrid";
import {
  clampMasonryTargetWidth,
  computeMasonryMetrics,
  DEFAULT_MASONRY_TARGET_WIDTH,
  MAX_MASONRY_TARGET_WIDTH,
  MIN_MASONRY_TARGET_WIDTH,
  readStoredMasonryTargetWidth,
  writeStoredMasonryTargetWidth,
} from "./spaceMasonryLayout";
import { SpaceItemCard, SpaceListHeader, type SpaceItemActions } from "./SpaceItemCard";
import {
  getSpaceDashboardRegistryVersion,
  getSyncedSpaceHomeKind,
  itemsForSection,
  pageItem,
  setSyncedSpaceHomeKind,
  SPACE_KIND_FILTERS,
  subscribeSpaceDashboardRegistry,
  subscribeSyncedSpaceHomeKind,
  type SpaceItem,
  type SpaceKindFilter,
  type SpaceOwnerFilter,
  type SpaceSection,
  type SpaceSortOrder,
} from "./spaceItems";
import { spaceKindMeta } from "./spaceKinds";

const VIEW_STORAGE_KEY = "moss:space:view";
/** Below this many items the home still offers 新建 and 快速开始. */
const YOUNG_SPACE_ITEMS = 6;
/** Progressive render batch size so large 资料空间 collections stay responsive. */
const INITIAL_PAGE_SIZE = 48;
const PAGE_STEP = 48;

const OWNER_FILTERS: ReadonlyArray<{ id: SpaceOwnerFilter; label: string }> = [
  { id: "any", label: "全部来源" },
  { id: "mine", label: "由我新建" },
  { id: "agent", label: "对话协作生成" },
];

const SORT_OPTIONS: ReadonlyArray<{ id: SpaceSortOrder; label: string }> = [
  { id: "updated", label: "最近更新" },
  { id: "created", label: "最近创建" },
  { id: "title", label: "标题排序" },
];

interface CreationTile {
  readonly action: SpaceCreateAction;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly hue: string;
  readonly beta?: boolean;
}

const CREATION_TILES: ReadonlyArray<CreationTile> = [
  {
    action: "page",
    label: "文档",
    icon: PageTextIcon,
    hue: "var(--color-accent-blue)",
  },
  {
    action: "slides",
    label: "幻灯片",
    icon: SlidesIcon,
    hue: "var(--color-accent-yellow)",
  },
  {
    action: "sheet",
    label: "电子表格",
    icon: TableIcon,
    hue: "var(--color-accent-green)",
    beta: true,
  },
  {
    action: "design",
    label: "设计",
    icon: PaletteIcon,
    hue: "var(--color-accent-purple)",
  },
  {
    action: "dashboard",
    label: "数据看板",
    icon: DataDashboardIcon,
    hue: "var(--color-accent-red)",
  },
  {
    action: "board",
    label: "画布",
    icon: spaceKindMeta("board").icon,
    hue: "color-mix(in srgb, var(--color-accent-red) 58%, var(--color-accent-yellow))",
    beta: true,
  },
];

function pickQuickStartTemplates(): readonly SpaceTemplateDefinition[] {
  const findByIdOrKind = (preferredId: string, kind: SpaceTemplateKind) =>
    BUILT_IN_TEMPLATES.find((entry) => entry.id === preferredId) ??
    BUILT_IN_TEMPLATES.find((entry) => entry.kind === kind);
  return [
    findByIdOrKind("builtin:meeting-notes", "page"),
    findByIdOrKind("builtin:weekly-report-deck", "slides"),
    findByIdOrKind("builtin:budget-sheet", "sheet"),
  ].filter((entry): entry is SpaceTemplateDefinition => entry !== undefined);
}

const QUICK_START_TEMPLATES = pickQuickStartTemplates();

type SpaceView = "grid" | "list" | "canvas";

function readStoredView(): SpaceView {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return stored === "list" || stored === "canvas" ? stored : "grid";
  } catch {
    return "grid";
  }
}

function filterEmptyCreateAction(
  kind: SpaceKindFilter,
  fallback: SpaceCreateAction,
): SpaceCreateAction {
  switch (kind) {
    case "page":
    case "slides":
    case "sheet":
    case "design":
    case "dashboard":
    case "board":
    case "app":
    case "image":
      return kind;
    default:
      return fallback;
  }
}

export function SpaceHome(
  props: SpaceItemActions & {
    section: Exclude<SpaceSection, { type: "trash" }>;
    title: string;
    headerAction?: ReactNode;
    description: string;
    items: readonly SpaceItem[];
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    onCreate: (action: SpaceCreateAction) => void;
    /** Where an item lives, for its card. */
    placeOf: (item: SpaceItem) => string;
    /** The create action the empty state offers for this view. */
    emptyCreate: SpaceCreateAction;
    scopeSpaceId?: SpaceId | null;
    onLaunchTemplate?: (payload: {
      item: PageTypedItem;
      launch: SpaceTemplateLaunchMetadata;
    }) => void;
    onBrowseTemplates?: () => void;
    /** Folders shown above the items on the 全部 home: 资料空间 and 资料库 folders. */
    folders?: readonly GalleryFolder[];
    onOpenFolder?: (folder: GalleryFolder) => void;
    onTrashMany?: ((items: readonly SpaceItem[]) => void) | undefined;
    /** The card to outline: the folder or item the person just came back from. */
    marked?: string | null;
  },
) {
  const dark = useTheme().resolvedTheme === "dark";
  const kind = useSyncExternalStore(subscribeSyncedSpaceHomeKind, getSyncedSpaceHomeKind);
  useSyncExternalStore(subscribeSpaceDashboardRegistry, getSpaceDashboardRegistryVersion);
  const [owner, setOwner] = useState<SpaceOwnerFilter>("any");
  const [sort, setSort] = useState<SpaceSortOrder>("updated");
  const gallery = useOptionalGallery();
  const [storedView, setView] = useState<SpaceView>(readStoredView);
  // The canvas needs the shared note reads; without them (a card shown on its own) it is a grid.
  const view: SpaceView = storedView === "canvas" && gallery === null ? "grid" : storedView;
  const [launchingTemplateId, setLaunchingTemplateId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [visibleCount, setVisibleCount] = useState(INITIAL_PAGE_SIZE);
  const [targetColumnWidth, setTargetColumnWidth] = useState<number>(readStoredMasonryTargetWidth);
  const [zoomNotice, setZoomNotice] = useState<{ columns: number; scalePct: number } | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [draggingKeys, setDraggingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const anchorKeyRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const zoomTimerRef = useRef<number | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const changeView = (next: SpaceView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // A remembered view is a convenience; the toggle still works without storage.
    }
  };

  const launchStarterTemplate = async (template: SpaceTemplateDefinition) => {
    const api = ensureNativeApi();
    if (typeof api.pageTypes?.create !== "function") {
      props.onCreate("template");
      return;
    }
    setLaunchingTemplateId(template.id);
    setLaunchError(null);
    try {
      const item = await createSpaceItem(api, {
        scopeSpaceId: props.scopeSpaceId ?? null,
        kind: template.kind,
        title: template.title,
        templateId: template.id,
        spaceId: props.section.type === "space" ? props.section.spaceId : null,
      });
      const launch = getTemplateLaunchMetadata(template, { autoRun: true });
      dispatchSpaceTemplateLaunch({ item, launch });
      if (props.onLaunchTemplate) {
        props.onLaunchTemplate({ item, launch });
      } else {
        props.onOpen(pageItem(item.page));
      }
    } catch (cause) {
      setLaunchError(cause instanceof Error ? cause.message : "无法从该模板创建，请稍后再试。");
    } finally {
      setLaunchingTemplateId(null);
    }
  };

  const isAll = props.section.type === "all";
  const effectiveKind = isAll ? kind : "any";
  const visible = itemsForSection(props.items, props.section, {
    tab: "all",
    kind: effectiveKind,
    query: "",
    owner,
    sort,
    tagsOf: gallery?.tagsOf,
  });
  const kindLabel = SPACE_KIND_FILTERS.find((entry) => entry.id === kind)?.label ?? "全部类型";
  const hasActiveFilter = (isAll && kind !== "any") || owner !== "any" || sort !== "updated";
  const showHomeStarters = isAll && kind === "any";
  // 新建 and 快速开始 help a 资料空间 get started; once it holds a few things they step aside
  // (创建 in the sidebar keeps every kind and template). The canvas is the whole wall.
  const young = props.items.filter((item) => item.trashedAt === null).length < YOUNG_SPACE_ITEMS;
  const showStarterRows = showHomeStarters && young && view !== "canvas";
  const effectiveTitle =
    isAll && kind !== "any"
      ? (SPACE_KIND_FILTERS.find((e) => e.id === kind)?.label ?? props.title)
      : props.title;
  const folders = props.folders ?? gallery?.tree.folders ?? [];
  const showFolders = showHomeStarters && folders.length > 0 && props.onOpenFolder;
  // On the home, foldered items live in their folder cards; the grid lists the rest.
  const folderedKeys = new Set(
    showFolders ? folders.flatMap((folder) => folder.items.map((item) => item.key)) : [],
  );
  const gridItems = showFolders ? visible.filter((item) => !folderedKeys.has(item.key)) : visible;
  const currentSectionKey = sectionKey(props.section);
  useEffect(() => {
    setVisibleCount(INITIAL_PAGE_SIZE);
    setSelectedKeys(new Set());
    anchorKeyRef.current = null;
  }, [props.section.type, currentSectionKey, effectiveKind, owner, sort, view]);
  const pagedTotalCount = view === "grid" ? gridItems.length : view === "list" ? visible.length : 0;
  const pagedGridItems = view === "grid" ? gridItems.slice(0, visibleCount) : gridItems;
  const pagedListItems = view === "list" ? visible.slice(0, visibleCount) : visible;
  const orderedInteractiveItems = view === "list" ? pagedListItems : pagedGridItems;
  const remainingCount = Math.max(0, pagedTotalCount - visibleCount);
  const hasMore = remainingCount > 0;
  useEffect(() => {
    if (!hasMore || typeof IntersectionObserver === "undefined") return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => current + PAGE_STEP);
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  const itemByKey = useMemo(
    () => new Map(props.items.map((item) => [item.key, item] as const)),
    [props.items],
  );
  const folderByKey = useMemo(
    () => new Map(folders.map((folder) => [folder.key, folder] as const)),
    [folders],
  );
  const selectedFileItems = useMemo(
    () =>
      [...selectedKeys]
        .map((key) => itemByKey.get(key))
        .filter((entry): entry is SpaceItem => entry !== undefined && entry.trashedAt === null),
    [selectedKeys, itemByKey],
  );
  const selectedFolder = useMemo(() => {
    if (selectedKeys.size !== 1) return null;
    const [onlyKey] = [...selectedKeys];
    return onlyKey ? (folderByKey.get(onlyKey) ?? null) : null;
  }, [selectedKeys, folderByKey]);
  const currentFolderKey =
    props.section.type === "space"
      ? `space:${props.section.spaceId}`
      : props.section.type === "folder"
        ? `folder:${props.section.folderId}`
        : null;

  const applyZoomWidth = useCallback((nextWidth: number) => {
    const clamped = clampMasonryTargetWidth(nextWidth);
    setTargetColumnWidth(clamped);
    writeStoredMasonryTargetWidth(clamped);
    const width = scrollContainerRef.current?.getBoundingClientRect().width ?? 960;
    const metrics = computeMasonryMetrics(Math.max(240, width - 64), clamped);
    setZoomNotice({
      columns: metrics.columnCount,
      scalePct: Math.round((clamped / DEFAULT_MASONRY_TARGET_WIDTH) * 100),
    });
    if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(() => {
      zoomTimerRef.current = null;
      setZoomNotice(null);
    }, 1_100);
  }, []);

  useEffect(() => {
    return () => {
      if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
      if (dragPreviewRef.current) {
        dragPreviewRef.current.remove();
        dragPreviewRef.current = null;
      }
      clearActiveSpaceDragKeys();
    };
  }, []);

  useEffect(() => {
    if (view !== "grid") return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (Math.abs(event.deltaY) < 0.01) return;
      event.preventDefault();
      event.stopPropagation();
      setTargetColumnWidth((prev) => {
        const next = clampMasonryTargetWidth(prev * Math.exp(-event.deltaY * 0.0022));
        writeStoredMasonryTargetWidth(next);
        const width = el.getBoundingClientRect().width || 960;
        const metrics = computeMasonryMetrics(Math.max(240, width - 64), next);
        setZoomNotice({
          columns: metrics.columnCount,
          scalePct: Math.round((next / DEFAULT_MASONRY_TARGET_WIDTH) * 100),
        });
        if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = window.setTimeout(() => {
          zoomTimerRef.current = null;
          setZoomNotice(null);
        }, 1_100);
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view]);

  const handleTrashSelected = useCallback(() => {
    if (selectedFileItems.length === 0) return;
    const targets = [...selectedFileItems];
    setSelectedKeys(new Set());
    if (props.onTrashMany) {
      props.onTrashMany(targets);
      return;
    }
    for (const item of targets) props.onTrash?.(item);
  }, [selectedFileItems, props.onTrashMany, props.onTrash]);

  useEffect(() => {
    if (view === "canvas") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "Escape" && selectedKeys.size > 0) {
        event.preventDefault();
        setSelectedKeys(new Set());
        return;
      }
      if (event.key === "Enter") {
        if (selectedFolder && props.onOpenFolder) {
          event.preventDefault();
          props.onOpenFolder(selectedFolder);
          return;
        }
        if (selectedFileItems.length === 1) {
          event.preventDefault();
          props.onOpen(selectedFileItems[0]!);
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        if (orderedInteractiveItems.length === 0) return;
        event.preventDefault();
        setSelectedKeys(new Set(orderedInteractiveItems.map((entry) => entry.key)));
        anchorKeyRef.current = orderedInteractiveItems[0]?.key ?? null;
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedFileItems.length > 0 &&
        (props.onTrashMany || props.onTrash)
      ) {
        event.preventDefault();
        handleTrashSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    view,
    selectedKeys,
    selectedFolder,
    selectedFileItems,
    orderedInteractiveItems,
    props.onOpenFolder,
    props.onOpen,
    props.onTrashMany,
    props.onTrash,
    handleTrashSelected,
  ]);

  const handleFolderSelect = (folder: GalleryFolder) => {
    setSelectedKeys(new Set([folder.key]));
    anchorKeyRef.current = null;
  };

  const handleItemSelect = (item: SpaceItem, event: ReactMouseEvent<HTMLElement>) => {
    if (event.shiftKey && anchorKeyRef.current) {
      const orderedKeys = orderedInteractiveItems.map((entry) => entry.key);
      const start = orderedKeys.indexOf(anchorKeyRef.current);
      const end = orderedKeys.indexOf(item.key);
      if (start !== -1 && end !== -1) {
        const [low, high] = start <= end ? [start, end] : [end, start];
        const next = new Set(
          event.metaKey || event.ctrlKey
            ? [...selectedKeys].filter((k) => !folderByKey.has(k))
            : [],
        );
        for (let idx = low; idx <= high; idx += 1) {
          const key = orderedKeys[idx];
          if (key) next.add(key);
        }
        setSelectedKeys(next);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelectedKeys((prev) => {
        const next = new Set([...prev].filter((k) => !folderByKey.has(k)));
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
      anchorKeyRef.current = item.key;
      return;
    }
    setSelectedKeys(new Set([item.key]));
    anchorKeyRef.current = item.key;
  };

  const handleToggleSelect = (item: SpaceItem) => {
    setSelectedKeys((prev) => {
      const next = new Set([...prev].filter((k) => !folderByKey.has(k)));
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
    anchorKeyRef.current = item.key;
  };

  const handleDragStartItem = (item: SpaceItem, event: ReactDragEvent<HTMLElement>) => {
    const useSelection = selectedKeys.has(item.key) && selectedFileItems.length > 0;
    const dragKeys = useSelection ? selectedFileItems.map((entry) => entry.key) : [item.key];
    if (!useSelection) {
      setSelectedKeys(new Set([item.key]));
      anchorKeyRef.current = item.key;
    }
    setDraggingKeys(new Set(dragKeys));
    setActiveSpaceDragKeys(dragKeys);
    if (event.dataTransfer) {
      event.dataTransfer.setData(SPACE_ITEMS_DRAG_MIME, JSON.stringify(dragKeys));
      event.dataTransfer.setData("text/plain", dragKeys.join(","));
      event.dataTransfer.effectAllowed = "move";
      if (dragKeys.length > 1) {
        const badge = document.createElement("div");
        badge.textContent = `移动 ${dragKeys.length} 项`;
        badge.className =
          "pointer-events-none fixed -top-96 -left-96 rounded-full bg-info px-3 py-1.5 text-ui-xs font-medium text-white shadow-md";
        document.body.appendChild(badge);
        dragPreviewRef.current = badge;
        event.dataTransfer.setDragImage(badge, 24, 16);
        requestAnimationFrame(() => {
          badge.remove();
          if (dragPreviewRef.current === badge) dragPreviewRef.current = null;
        });
      }
    }
  };

  const handleDragEndItem = () => {
    setDraggingKeys(new Set());
    clearActiveSpaceDragKeys();
    if (dragPreviewRef.current) {
      dragPreviewRef.current.remove();
      dragPreviewRef.current = null;
    }
  };

  const handleDropOnFolder = (folder: GalleryFolder, keys: readonly string[]) => {
    const resolved = keys
      .map((key) => itemByKey.get(key))
      .filter((entry): entry is SpaceItem => entry !== undefined && entry.trashedAt === null);
    setDraggingKeys(new Set());
    clearActiveSpaceDragKeys();
    if (resolved.length === 0) return;
    setSelectedKeys(new Set());
    props.onMoveToFolder?.(resolved, folder);
  };

  const handleMoveSelected = (target: GalleryFolder | null) => {
    if (selectedFileItems.length === 0) return;
    const targets = [...selectedFileItems];
    setSelectedKeys(new Set());
    props.onMoveToFolder?.(targets, target);
  };

  const handleContainerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (view === "canvas" || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "[data-space-item], [data-gallery-card], button, a, input, textarea, [role='menu'], [data-space-selection-bar]",
      )
    ) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) return;
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const baseSelection = additive
      ? new Set([...selectedKeys].filter((k) => !folderByKey.has(k)))
      : new Set<string>();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragged = false;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) < 6) return;
      dragged = true;
      const rect = container.getBoundingClientRect();
      const x1 = Math.min(startX, moveEvent.clientX);
      const x2 = Math.max(startX, moveEvent.clientX);
      const y1 = Math.min(startY, moveEvent.clientY);
      const y2 = Math.max(startY, moveEvent.clientY);
      setMarquee({
        left: x1 - rect.left + container.scrollLeft,
        top: y1 - rect.top + container.scrollTop,
        width: x2 - x1,
        height: y2 - y1,
      });
      const next = new Set(baseSelection);
      for (const node of container.querySelectorAll<HTMLElement>("[data-space-item]")) {
        const key = node.dataset.spaceItem;
        if (!key) continue;
        const cardRect = node.getBoundingClientRect();
        const intersects =
          cardRect.right >= x1 &&
          cardRect.left <= x2 &&
          cardRect.bottom >= y1 &&
          cardRect.top <= y2;
        if (intersects) next.add(key);
      }
      setSelectedKeys(next);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setMarquee(null);
      if (!dragged && !additive) {
        setSelectedKeys(new Set());
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const canvasGroups: CanvasGroup[] = showFolders
    ? [
        ...folders
          .filter((folder) => folder.items.length > 0)
          .map((folder) => ({
            id: folder.key,
            label: folder.title,
            items: sortForGallery(folder.items),
          })),
        ...(gridItems.length ? [{ id: "loose", label: "未归入文件夹", items: gridItems }] : []),
      ]
    : groupByClass(visible);
  const emptyCreateAction = isAll
    ? filterEmptyCreateAction(kind, props.emptyCreate)
    : props.emptyCreate;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-space-home={props.section.type}>
      {/* One quiet row: the title, then only what changes this view. */}
      <header className="flex items-center gap-1.5 px-6 pt-6 pb-4 md:px-10 md:pt-8">
        <div className="min-w-0 flex-1">
          <h1 className={cn(PAGE_TITLE_CLASS_NAME, "truncate")}>{effectiveTitle}</h1>
          {props.description ? (
            <p className="mt-1 truncate text-ui-sm text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        {props.headerAction}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size={hasActiveFilter ? "sm" : "icon-sm"}
                variant="ghost"
                aria-label={isAll ? `筛选：${kindLabel}` : "排序与筛选"}
                data-pressed={hasActiveFilter ? "" : undefined}
              >
                <FilterIcon aria-hidden className="size-4" />
                {hasActiveFilter ? (isAll && kind !== "any" ? kindLabel : "已筛选") : null}
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
              <MenuGroupLabel>创建来源</MenuGroupLabel>
              {OWNER_FILTERS.map((entry) => (
                <MenuItem key={entry.id} onClick={() => setOwner(entry.id)}>
                  <span className="flex-1">{entry.label}</span>
                  {owner === entry.id ? <CheckIcon aria-hidden className="size-4" /> : null}
                </MenuItem>
              ))}
            </MenuGroup>
            {isAll ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>条目类型</MenuGroupLabel>
                  {SPACE_KIND_FILTERS.map((entry) => (
                    <MenuItem key={entry.id} onClick={() => setSyncedSpaceHomeKind(entry.id)}>
                      <span className="flex-1">{entry.label}</span>
                      {kind === entry.id ? <CheckIcon aria-hidden className="size-4" /> : null}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </>
            ) : null}
            {hasActiveFilter ? (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    setSort("updated");
                    setOwner("any");
                    if (isAll) setSyncedSpaceHomeKind("any");
                  }}
                >
                  重置筛选条件
                </MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
        {view === "grid" ? (
          <div
            className="flex items-center rounded-control bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5"
            aria-label="卡片缩放"
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="缩小卡片"
              disabled={targetColumnWidth <= MIN_MASONRY_TARGET_WIDTH}
              className="size-6 rounded-inline text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() => applyZoomWidth(targetColumnWidth - 36)}
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
                <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label="重置卡片大小"
              className="h-6 rounded-inline px-1.5 text-ui-xs tabular-nums text-muted-foreground hover:text-foreground"
              onClick={() => applyZoomWidth(DEFAULT_MASONRY_TARGET_WIDTH)}
            >
              {Math.round((targetColumnWidth / DEFAULT_MASONRY_TARGET_WIDTH) * 100)}%
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="放大卡片"
              disabled={targetColumnWidth >= MAX_MASONRY_TARGET_WIDTH}
              className="size-6 rounded-inline text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() => applyZoomWidth(targetColumnWidth + 36)}
            >
              <AddPlusIcon aria-hidden className="size-3.5" />
            </Button>
          </div>
        ) : null}
        <div className="flex items-center rounded-control bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5">
          {(
            [
              ["grid", "网格视图", LayoutGridIcon],
              ["list", "列表视图", ListBulletsIcon],
              ...(gallery ? ([["canvas", "画布视图", WhiteboardIcon]] as const) : []),
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              aria-pressed={view === id}
              title={label}
              className={cn(
                "flex size-6 items-center justify-center rounded-inline text-muted-foreground",
                view === id ? "bg-background text-foreground shadow-xs" : "hover:text-foreground",
              )}
              onClick={() => changeView(id)}
            >
              <Icon aria-hidden className="size-4" />
            </button>
          ))}
        </div>
      </header>
      <div
        ref={scrollContainerRef}
        onPointerDown={handleContainerPointerDown}
        className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-20 md:px-10"
      >
        {marquee ? (
          <div
            aria-hidden
            data-space-marquee
            className="pointer-events-none absolute z-30 rounded-control border border-info/70 bg-info/12"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        ) : null}
        {zoomNotice ? (
          <div
            role="status"
            aria-live="polite"
            data-space-zoom-indicator
            className="pointer-events-none fixed right-8 bottom-6 z-40 rounded-full border border-border/80 bg-card/92 px-3 py-1.5 text-ui-xs font-medium text-foreground shadow-md backdrop-blur-md"
          >
            每行 {zoomNotice.columns} 列 · {zoomNotice.scalePct}%
          </div>
        ) : null}
        {showStarterRows ? (
          <section className="mb-4" aria-label="新建" data-space-create-tiles>
            <div className="flex flex-wrap gap-3">
              {CREATION_TILES.map((tile) => {
                const Icon = tile.icon;
                return (
                  <Button
                    key={tile.action}
                    variant="outline"
                    data-space-create-tile={tile.action}
                    className="relative flex h-24 min-h-0 w-34 shrink-0 flex-col items-center justify-center gap-2 rounded-composer border-border/60 bg-card px-3 py-2.5 text-center shadow-2xs transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-border hover:shadow-sm max-sm:w-28"
                    // A flat, quiet tint of the kind's colour; in dark the colour is lifted
                    // toward the text colour so it does not turn muddy.
                    style={{
                      backgroundColor: `color-mix(in srgb, ${tile.hue} ${dark ? 8 : 7}%, var(--card))`,
                    }}
                    onClick={() => props.onCreate(tile.action)}
                  >
                    <Icon
                      aria-hidden
                      className="size-5 shrink-0"
                      style={{
                        color: dark
                          ? `color-mix(in srgb, ${tile.hue} 72%, var(--foreground))`
                          : tile.hue,
                      }}
                    />
                    <span className="truncate text-ui font-medium text-foreground">
                      {tile.label}
                    </span>
                  </Button>
                );
              })}
            </div>
          </section>
        ) : null}

        {showStarterRows && QUICK_START_TEMPLATES.length > 0 ? (
          // 快速开始: a few templates Moss fills in for you, one line of chips.
          <section
            className="mb-6 flex flex-wrap items-center gap-1.5"
            aria-label="快速开始"
            data-space-quick-start
          >
            <SparklesIcon aria-hidden className="me-1 size-3.5 text-muted-foreground" />
            {QUICK_START_TEMPLATES.map((template) => {
              const Icon = spaceKindMeta(template.kind).icon;
              return (
                <Button
                  key={template.id}
                  size="sm"
                  variant="outline"
                  disabled={launchingTemplateId !== null}
                  data-space-quick-start-template={template.id}
                  title={template.description || undefined}
                  className="rounded-full"
                  onClick={() => void launchStarterTemplate(template)}
                >
                  <Icon aria-hidden className="text-muted-foreground" />
                  {launchingTemplateId === template.id ? "创建中…" : template.title}
                </Button>
              );
            })}
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              onClick={() =>
                props.onBrowseTemplates ? props.onBrowseTemplates() : props.onCreate("template")
              }
            >
              更多模板
            </Button>
            {launchError ? (
              <p role="alert" className="w-full text-ui-sm text-destructive">
                {launchError}
              </p>
            ) : null}
          </section>
        ) : null}

        {props.error ? (
          <div role="alert" className="flex items-center gap-2 py-6 text-ui text-destructive">
            {props.error}
            <Button size="sm" variant="ghost" onClick={props.onRetry}>
              重新加载
            </Button>
          </div>
        ) : props.loading ? (
          <p role="status" className="py-6 text-ui text-muted-foreground">
            正在加载…
          </p>
        ) : visible.length === 0 && showStarterRows ? null : visible.length === 0 &&
          !showFolders ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ui text-muted-foreground">
            <p>{emptyMessage(props.section, effectiveKind)}</p>
            <Button size="sm" variant="outline" onClick={() => props.onCreate(emptyCreateAction)}>
              创建
            </Button>
          </div>
        ) : view === "canvas" ? (
          <div className="-mx-6 flex h-[max(28rem,calc(100vh-16rem))] md:-mx-10" data-space-canvas>
            <GalleryCanvas
              container={`${props.section.type}:${sectionKey(props.section)}:${effectiveKind}`}
              groups={canvasGroups}
            />
          </div>
        ) : view === "grid" ? (
          <>
            {showFolders ? (
              <>
                <section aria-label="资料空间" data-space-folders-section className="mb-8">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-ui font-medium text-foreground">资料空间</h2>
                      <span className="text-ui-xs tabular-nums text-muted-foreground">
                        {folders.length}
                      </span>
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="在此新建资料空间"
                      onClick={() => props.onCreate("space")}
                    >
                      <AddPlusIcon aria-hidden className="size-3.5" />
                      新建
                    </Button>
                  </div>
                  <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15.5rem),1fr))]">
                    {folders.map((folder) => (
                      <SpaceFolderCard
                        key={folder.key}
                        folder={folder}
                        marked={props.marked === folder.key}
                        selected={selectedKeys.has(folder.key)}
                        onSelect={(entry) => handleFolderSelect(entry)}
                        onOpen={(entry) => props.onOpenFolder?.(entry)}
                        onDropKeys={handleDropOnFolder}
                      />
                    ))}
                  </div>
                </section>
                <section
                  aria-label="未归入文件夹"
                  data-space-loose-section
                  className="border-t border-border/50 pt-6"
                >
                  <div className="mb-4 flex items-baseline gap-2">
                    <h2 className="text-ui font-medium text-foreground">未归入文件夹</h2>
                    <span className="text-ui-xs tabular-nums text-muted-foreground">
                      {gridItems.length}
                    </span>
                  </div>
                  {gridItems.length === 0 ? (
                    <p className="py-8 text-center text-ui-sm text-muted-foreground">
                      所有散落条目都已归入上方文件夹
                    </p>
                  ) : (
                    <SpaceMasonryGrid data-space-grid targetColumnWidth={targetColumnWidth}>
                      {pagedGridItems.map((item) => ({
                        key: item.key,
                        node: (
                          <SpaceItemCard
                            {...props}
                            folders={folders}
                            item={item}
                            view="grid"
                            place={props.placeOf(item)}
                            now={now}
                            marked={props.marked === item.key}
                            selected={selectedKeys.has(item.key)}
                            selectionActive={selectedFileItems.length > 0}
                            onSelect={handleItemSelect}
                            onToggleSelect={handleToggleSelect}
                            onDragStartItem={handleDragStartItem}
                            onDragEndItem={handleDragEndItem}
                            isDragging={draggingKeys.has(item.key)}
                          />
                        ),
                      }))}
                    </SpaceMasonryGrid>
                  )}
                </section>
              </>
            ) : (
              <SpaceMasonryGrid data-space-grid targetColumnWidth={targetColumnWidth}>
                {pagedGridItems.map((item) => ({
                  key: item.key,
                  node: (
                    <SpaceItemCard
                      {...props}
                      folders={folders}
                      item={item}
                      view="grid"
                      place={props.placeOf(item)}
                      now={now}
                      marked={props.marked === item.key}
                      selected={selectedKeys.has(item.key)}
                      selectionActive={selectedFileItems.length > 0}
                      onSelect={handleItemSelect}
                      onToggleSelect={handleToggleSelect}
                      onDragStartItem={handleDragStartItem}
                      onDragEndItem={handleDragEndItem}
                      isDragging={draggingKeys.has(item.key)}
                    />
                  ),
                }))}
              </SpaceMasonryGrid>
            )}
            {hasMore ? (
              <div ref={loadMoreRef} className="flex justify-center pt-6 pb-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setVisibleCount((current) => current + PAGE_STEP)}
                >
                  加载更多（剩余 {remainingCount} 项）
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {showFolders ? (
              <section aria-label="资料空间" data-space-folders-section className="mb-6">
                <div className="mb-3 flex items-baseline gap-2">
                  <h2 className="text-ui font-medium text-foreground">资料空间</h2>
                  <span className="text-ui-xs tabular-nums text-muted-foreground">
                    {folders.length}
                  </span>
                </div>
                <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15.5rem),1fr))]">
                  {folders.map((folder) => (
                    <SpaceFolderCard
                      key={folder.key}
                      folder={folder}
                      marked={props.marked === folder.key}
                      selected={selectedKeys.has(folder.key)}
                      onSelect={(entry) => handleFolderSelect(entry)}
                      onOpen={(entry) => props.onOpenFolder?.(entry)}
                      onDropKeys={handleDropOnFolder}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            <div role="grid" aria-label="条目列表" data-space-list>
              <SpaceListHeader />
              <div role="rowgroup" className="flex flex-col gap-0.5 pt-1">
                {pagedListItems.map((item) => (
                  <SpaceItemCard
                    key={item.key}
                    {...props}
                    folders={folders}
                    item={item}
                    view="list"
                    place={props.placeOf(item)}
                    now={now}
                    marked={props.marked === item.key}
                    selected={selectedKeys.has(item.key)}
                    selectionActive={selectedFileItems.length > 0}
                    onSelect={handleItemSelect}
                    onToggleSelect={handleToggleSelect}
                    onDragStartItem={handleDragStartItem}
                    onDragEndItem={handleDragEndItem}
                    isDragging={draggingKeys.has(item.key)}
                  />
                ))}
              </div>
            </div>
            {hasMore ? (
              <div ref={loadMoreRef} className="flex justify-center pt-6 pb-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setVisibleCount((current) => current + PAGE_STEP)}
                >
                  加载更多（剩余 {remainingCount} 项）
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      {selectedFileItems.length > 0 ? (
        <div
          role="toolbar"
          aria-label="已选条目操作"
          data-space-selection-bar
          className="pointer-events-auto fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/80 bg-card/95 px-3 py-1.5 shadow-lg backdrop-blur-md"
        >
          <span className="px-1.5 text-ui-xs font-medium tabular-nums text-foreground">
            已选 {selectedFileItems.length} 项
          </span>
          {selectedFileItems.length === 1 ? (
            <Button
              size="xs"
              variant="ghost"
              className="rounded-full"
              onClick={() => props.onOpen(selectedFileItems[0]!)}
            >
              打开
            </Button>
          ) : null}
          {props.onMoveToFolder && (folders.length > 0 || currentFolderKey !== null) ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="xs" variant="ghost" className="gap-1 rounded-full">
                    <FolderIcon aria-hidden className="size-3.5" />
                    移入资料空间
                  </Button>
                }
              />
              <ComposerPickerMenuPopup align="center" className="w-52 min-w-52">
                <MenuGroup>
                  <MenuGroupLabel>选择目标资料空间</MenuGroupLabel>
                  {folders.map((folder) => (
                    <MenuItem
                      key={folder.key}
                      disabled={folder.key === currentFolderKey}
                      onClick={() => handleMoveSelected(folder)}
                    >
                      <span className="flex-1 truncate">{folder.title}</span>
                      {folder.key === currentFolderKey ? (
                        <CheckIcon aria-hidden className="size-3.5" />
                      ) : null}
                    </MenuItem>
                  ))}
                  {currentFolderKey !== null ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={() => handleMoveSelected(null)}>
                        移出到未归入文件夹
                      </MenuItem>
                    </>
                  ) : null}
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          ) : null}
          {props.onTrashMany || props.onTrash ? (
            <Button
              size="xs"
              variant="ghost"
              className="gap-1 rounded-full text-destructive hover:text-destructive"
              onClick={handleTrashSelected}
            >
              <TrashCanIcon aria-hidden className="size-3.5" />
              移到回收站
            </Button>
          ) : null}
          {selectedFileItems.length < orderedInteractiveItems.length ? (
            <Button
              size="xs"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              onClick={() =>
                setSelectedKeys(new Set(orderedInteractiveItems.map((entry) => entry.key)))
              }
            >
              全选
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            className="rounded-full text-muted-foreground"
            aria-label="取消选择"
            onClick={() => setSelectedKeys(new Set())}
          >
            <XIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** On the canvas outside the home, notes and documents in one cluster, pictures in another. */
function groupByClass(items: readonly SpaceItem[]): CanvasGroup[] {
  const pictures = items.filter((item) => galleryClassOf(item) === "image");
  const rest = items.filter((item) => galleryClassOf(item) !== "image");
  return [
    ...(rest.length ? [{ id: "documents", label: "笔记和文档", items: rest }] : []),
    ...(pictures.length ? [{ id: "pictures", label: "图片", items: pictures }] : []),
  ];
}

function sectionKey(section: SpaceSection): string {
  switch (section.type) {
    case "kind":
      return section.kind;
    case "space":
      return section.spaceId;
    case "folder":
      return section.folderId;
    case "tag":
      return section.tag;
    case "collection":
      return section.id;
    default:
      return "";
  }
}

function emptyMessage(section: SpaceSection, kind: SpaceKindFilter): string {
  if (section.type === "space") return "这个资料空间还没有页面";
  if (section.type === "folder") return "这个文件夹还是空的";
  if (section.type === "tag" || section.type === "collection") return "还没有带这些标签的条目";
  if (section.type === "kind" || (section.type === "all" && kind !== "any")) {
    return "这里还没有内容";
  }
  return "还没有条目";
}
