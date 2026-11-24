// FILE: SpaceHome.tsx
// Purpose: The 资料空间's item views: 全部 (tabs 全部 / 你的条目 / 与你共享, pastel 新建 tiles,
//          dismissible 快速开始 template strip, search, kind/owner/sort filter, 3-col grid or
//          list), one item family (页面, 幻灯片…) and one 资料空间's pages.
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
  XIcon,
  type LucideIcon,
} from "~/lib/icons";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  PAGE_TITLE_CLASS_NAME,
  TAB_IDLE_SURFACE_CLASS_NAME,
  TAB_SELECTED_SURFACE_CLASS_NAME,
} from "~/surfaceStyles";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { createSpaceItem } from "../spaceTypes/spaceItemTypes";
import {
  dispatchSpaceTemplateLaunch,
  getTemplateLaunchMetadata,
  type SpaceTemplateLaunchMetadata,
} from "../spaceTypes/templates/TemplatePickerDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SearchInput } from "../ui/search-input";
import type { SpaceCreateAction } from "./SpaceCreateMenu";
import { SpaceItemCard, SpaceListHeader, type SpaceItemActions } from "./SpaceItemCard";
import {
  getSpaceDashboardRegistryVersion,
  getSyncedSpaceHomeKind,
  itemsForSection,
  pageItem,
  setSyncedSpaceHomeKind,
  SPACE_KIND_FILTERS,
  SPACE_TABS,
  subscribeSpaceDashboardRegistry,
  subscribeSyncedSpaceHomeKind,
  type SpaceItem,
  type SpaceKindFilter,
  type SpaceOwnerFilter,
  type SpaceSection,
  type SpaceSortOrder,
  type SpaceTab,
} from "./spaceItems";
import { spaceKindMeta } from "./spaceKinds";

const VIEW_STORAGE_KEY = "moss:space:view";
const HIDE_CREATE_TILES_KEY = "moss:space:hide-create-tiles";
const HIDE_QUICK_START_KEY = "moss:space:hide-quick-start";

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
    icon: WhiteboardIcon,
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

function readStoredView(): "grid" | "list" {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function readStoredFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeStoredFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Storage convenience; state still updates cleanly in memory.
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
  },
) {
  const [tab, setTab] = useState<SpaceTab>("all");
  const dark = useTheme().resolvedTheme === "dark";
  const kind = useSyncExternalStore(subscribeSyncedSpaceHomeKind, getSyncedSpaceHomeKind);
  useSyncExternalStore(subscribeSpaceDashboardRegistry, getSpaceDashboardRegistryVersion);
  const [owner, setOwner] = useState<SpaceOwnerFilter>("any");
  const [sort, setSort] = useState<SpaceSortOrder>("updated");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">(readStoredView);
  const [hideCreateTiles, setHideCreateTiles] = useState(() =>
    readStoredFlag(HIDE_CREATE_TILES_KEY),
  );
  const [hideQuickStart, setHideQuickStart] = useState(() => readStoredFlag(HIDE_QUICK_START_KEY));
  const [launchingTemplateId, setLaunchingTemplateId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const changeView = (next: "grid" | "list") => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // A remembered view is a convenience; the toggle still works without storage.
    }
  };

  const dismissCreateTiles = (hidden: boolean) => {
    setHideCreateTiles(hidden);
    writeStoredFlag(HIDE_CREATE_TILES_KEY, hidden);
  };

  const dismissQuickStart = (hidden: boolean) => {
    setHideQuickStart(hidden);
    writeStoredFlag(HIDE_QUICK_START_KEY, hidden);
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
    tab,
    kind: effectiveKind,
    query,
    owner,
    sort,
  });
  const kindLabel = SPACE_KIND_FILTERS.find((entry) => entry.id === kind)?.label ?? "全部类型";
  const hasActiveFilter = (isAll && kind !== "any") || owner !== "any" || sort !== "updated";
  const showHomeStarters = isAll && kind === "any" && query.trim() === "";
  const effectiveTitle =
    isAll && kind !== "any"
      ? (SPACE_KIND_FILTERS.find((e) => e.id === kind)?.label ?? props.title)
      : props.title;
  const emptyCreateAction = isAll
    ? filterEmptyCreateAction(kind, props.emptyCreate)
    : props.emptyCreate;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-space-home={props.section.type}>
      <header className="flex flex-col gap-3 px-6 pt-6 pb-3 md:px-10 md:pt-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className={PAGE_TITLE_CLASS_NAME}>{effectiveTitle}</h1>
            {props.description ? (
              <p className="mt-1 text-ui-sm text-muted-foreground">{props.description}</p>
            ) : null}
          </div>
          {props.headerAction ? (
            <div className="flex flex-wrap items-center gap-2">{props.headerAction}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAll ? (
            <div role="tablist" aria-label="条目分类" className="flex items-center gap-1">
              {SPACE_TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={cn(
                    "h-7 rounded-control px-2.5 text-ui",
                    tab === entry.id
                      ? TAB_SELECTED_SURFACE_CLASS_NAME
                      : TAB_IDLE_SURFACE_CLASS_NAME,
                  )}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="ms-auto flex flex-wrap items-center gap-1.5">
            <div className="w-56 max-sm:w-40">
              <SearchInput
                size="sm"
                aria-label="搜索条目"
                placeholder="搜索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={isAll ? `筛选：${kindLabel}` : "排序与筛选"}
                    data-pressed={hasActiveFilter ? "" : undefined}
                  >
                    <FilterIcon aria-hidden className="size-4" />
                    {isAll && kind !== "any" ? kindLabel : "筛选"}
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
                {hasActiveFilter || (isAll && (hideCreateTiles || hideQuickStart)) ? (
                  <>
                    <MenuSeparator />
                    {hasActiveFilter ? (
                      <MenuItem
                        onClick={() => {
                          setSort("updated");
                          setOwner("any");
                          if (isAll) setSyncedSpaceHomeKind("any");
                        }}
                      >
                        重置筛选条件
                      </MenuItem>
                    ) : null}
                    {isAll && (hideCreateTiles || hideQuickStart) ? (
                      <MenuItem
                        onClick={() => {
                          dismissCreateTiles(false);
                          dismissQuickStart(false);
                        }}
                      >
                        显示新建与快速开始
                      </MenuItem>
                    ) : null}
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
                <button
                  key={id}
                  type="button"
                  aria-label={label}
                  aria-pressed={view === id}
                  title={label}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-inline text-muted-foreground",
                    view === id
                      ? "bg-background text-foreground shadow-xs"
                      : "hover:text-foreground",
                  )}
                  onClick={() => changeView(id)}
                >
                  <Icon aria-hidden className="size-4" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 md:px-10">
        {showHomeStarters && !hideCreateTiles ? (
          <section className="mb-6" aria-label="新建" data-space-create-tiles>
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h2 className="text-ui-sm font-medium text-muted-foreground">新建</h2>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="收起新建卡片"
                onClick={() => dismissCreateTiles(true)}
              >
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
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
                    {tile.beta ? (
                      <Badge variant="secondary" size="sm" className="absolute top-1.5 right-1.5">
                        Beta
                      </Badge>
                    ) : null}
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

        {showHomeStarters && !hideQuickStart && QUICK_START_TEMPLATES.length > 0 ? (
          <section className="mb-6" aria-label="快速开始" data-space-quick-start>
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-ui-sm font-medium text-muted-foreground">
                <SparklesIcon aria-hidden className="size-3.5" />
                快速开始
              </h2>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    props.onBrowseTemplates ? props.onBrowseTemplates() : props.onCreate("template")
                  }
                >
                  浏览全部模板
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="收起快速开始"
                  onClick={() => dismissQuickStart(true)}
                >
                  <XIcon aria-hidden className="size-3.5" />
                </Button>
              </div>
            </div>
            {launchError ? (
              <p role="alert" className="mb-2 text-ui-sm text-destructive">
                {launchError}
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {QUICK_START_TEMPLATES.map((template) => {
                const kindMeta = spaceKindMeta(template.kind);
                const Icon = kindMeta.icon;
                const launchMeta = getTemplateLaunchMetadata(template, { autoRun: true });
                const isBusy = launchingTemplateId === template.id;
                return (
                  <Button
                    key={template.id}
                    variant="outline"
                    disabled={launchingTemplateId !== null}
                    data-space-quick-start-template={template.id}
                    className="@container flex h-auto min-h-0 flex-col items-start justify-between gap-1.5 rounded-panel border-border/70 bg-card px-3.5 py-3 text-left shadow-2xs transition-[box-shadow,border-color] hover:border-border hover:shadow-sm"
                    onClick={() => void launchStarterTemplate(template)}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
                        {template.title}
                      </span>
                      {/* On a narrow card the title wins: the kind tag gives way first. */}
                      <Badge variant="secondary" size="sm" className="shrink-0 @max-[10rem]:hidden">
                        {isBusy ? "创建中…" : kindMeta.label}
                      </Badge>
                    </span>
                    <span className="line-clamp-2 w-full whitespace-normal text-ui-xs font-normal text-muted-foreground">
                      {template.description || launchMeta.starterPrompt}
                    </span>
                  </Button>
                );
              })}
            </div>
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
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ui text-muted-foreground">
            <p>{emptyMessage(props.section, tab, query, effectiveKind)}</p>
            {/* Creating lives in the sidebar and the 新建 tiles; an empty kind list offers its own. */}
            {query === "" && tab !== "shared" && !(showHomeStarters && !hideCreateTiles) ? (
              <Button size="sm" variant="outline" onClick={() => props.onCreate(emptyCreateAction)}>
                创建
              </Button>
            ) : null}
          </div>
        ) : view === "grid" ? (
          <div
            className="grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(100%,max(15rem,30%)),1fr))]"
            data-space-grid
          >
            {visible.map((item) => (
              <SpaceItemCard
                key={item.key}
                {...props}
                item={item}
                view="grid"
                place={props.placeOf(item)}
                now={now}
              />
            ))}
          </div>
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
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function emptyMessage(
  section: SpaceSection,
  tab: SpaceTab,
  query: string,
  kind: SpaceKindFilter,
): string {
  if (query) return "没有匹配的条目";
  if (section.type === "space") return "这个资料空间还没有页面";
  if (section.type === "kind" || (section.type === "all" && kind !== "any")) {
    return "这里还没有内容";
  }
  switch (tab) {
    case "favorites":
      return "收藏的条目会显示在这里";
    case "shared":
      return "别人与你共享的条目会显示在这里";
    default:
      return "这里还没有内容";
  }
}
