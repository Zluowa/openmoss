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
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  CheckIcon,
  DataDashboardIcon,
  FilterIcon,
  LayoutGridIcon,
  ListBulletsIcon,
  PageTextIcon,
  PaletteIcon,
  SlidesIcon,
  SparklesIcon,
  TableIcon,
  WhiteboardIcon,
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
import { SpaceMasonryGrid } from "./SpaceMasonryGrid";
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
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 md:px-10">
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
          <SpaceMasonryGrid data-space-grid>
            {[
              ...(showFolders
                ? folders.map((folder) => ({
                    key: folder.key,
                    node: (
                      <SpaceFolderCard
                        folder={folder}
                        marked={props.marked === folder.key}
                        onOpen={(entry) => props.onOpenFolder?.(entry)}
                      />
                    ),
                  }))
                : []),
              ...gridItems.map((item) => ({
                key: item.key,
                node: (
                  <SpaceItemCard
                    {...props}
                    item={item}
                    view="grid"
                    place={props.placeOf(item)}
                    now={now}
                    marked={props.marked === item.key}
                  />
                ),
              })),
            ]}
          </SpaceMasonryGrid>
        ) : (
          <div role="grid" aria-label="条目列表" data-space-list>
            <SpaceListHeader />
            <div role="rowgroup" className="flex flex-col gap-0.5 pt-1">
              {visible.map((item) => (
                <SpaceItemCard
                  key={item.key}
                  {...props}
                  item={item}
                  view="list"
                  place={props.placeOf(item)}
                  now={now}
                  marked={props.marked === item.key}
                />
              ))}
            </div>
          </div>
        )}
      </div>
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
