// FILE: SpaceHome.tsx
// Purpose: The 资料空间's item views: 全部 (tabs 推荐 / 收藏 / 你的条目 / 与你共享, search,
//          kind filter, masonry grid or list), one item family (页面, 幻灯片…) and one
//          资料空间's pages.
// Layer: Space UI

import { useEffect, useState, type ReactNode } from "react";

import { CheckIcon, FilterIcon, LayoutGridIcon, ListBulletsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  PAGE_TITLE_CLASS_NAME,
  TAB_IDLE_SURFACE_CLASS_NAME,
  TAB_SELECTED_SURFACE_CLASS_NAME,
} from "~/surfaceStyles";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { SearchInput } from "../ui/search-input";
import { SpaceCreateMenu, type SpaceCreateAction } from "./SpaceCreateMenu";
import { SpaceItemCard, SpaceListHeader, type SpaceItemActions } from "./SpaceItemCard";
import {
  itemsForSection,
  SPACE_KIND_FILTERS,
  SPACE_TABS,
  type SpaceItem,
  type SpaceKindFilter,
  type SpaceSection,
  type SpaceTab,
} from "./spaceItems";

const VIEW_STORAGE_KEY = "moss:space:view";

function readStoredView(): "grid" | "list" {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
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
  },
) {
  const [tab, setTab] = useState<SpaceTab>("recommended");
  const [kind, setKind] = useState<SpaceKindFilter>("any");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">(readStoredView);
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
  const isAll = props.section.type === "all";
  const visible = itemsForSection(props.items, props.section, { tab, kind, query });
  const kindLabel = SPACE_KIND_FILTERS.find((entry) => entry.id === kind)?.label ?? "全部类型";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-space-home={props.section.type}>
      <header className="flex flex-col gap-3 px-6 pt-6 pb-3 md:px-10 md:pt-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className={PAGE_TITLE_CLASS_NAME}>{props.title}</h1>
            <p className="mt-1 text-ui-sm text-muted-foreground">{props.description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {props.headerAction}
            <SpaceCreateMenu
              align="end"
              onCreate={props.onCreate}
              trigger={<Button size="sm">创建</Button>}
            />
          </div>
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
          <div className="ms-auto flex items-center gap-1.5">
            <div className="w-56 max-sm:w-40">
              <SearchInput
                size="sm"
                aria-label="搜索条目"
                placeholder="搜索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {isAll ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`筛选：${kindLabel}`}
                      data-pressed={kind !== "any" ? "" : undefined}
                    >
                      <FilterIcon aria-hidden className="size-4" />
                      {kind === "any" ? "筛选" : kindLabel}
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup align="end" className="w-40 min-w-40">
                  {SPACE_KIND_FILTERS.map((entry) => (
                    <MenuItem key={entry.id} onClick={() => setKind(entry.id)}>
                      <span className="flex-1">{entry.label}</span>
                      {kind === entry.id ? <CheckIcon aria-hidden className="size-4" /> : null}
                    </MenuItem>
                  ))}
                </ComposerPickerMenuPopup>
              </Menu>
            ) : null}
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
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-ui text-muted-foreground">
            <p>{emptyMessage(props.section, tab, query)}</p>
            {query === "" && tab !== "shared" ? (
              <Button size="sm" variant="outline" onClick={() => props.onCreate(props.emptyCreate)}>
                创建
              </Button>
            ) : null}
          </div>
        ) : view === "grid" ? (
          <div className="columns-[15rem] gap-3" data-space-grid>
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

function emptyMessage(section: SpaceSection, tab: SpaceTab, query: string): string {
  if (query) return "没有匹配的条目";
  if (section.type === "space") return "这个资料空间还没有页面";
  if (section.type === "kind") return "这里还没有内容";
  switch (tab) {
    case "favorites":
      return "收藏的条目会显示在这里";
    case "shared":
      return "别人与你共享的条目会显示在这里";
    default:
      return "还没有条目。创建一个页面，或让对话里的助手生成文件。";
  }
}
