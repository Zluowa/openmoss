// FILE: GallerySearchDialog.tsx
// Purpose: ⌘K for the 资料空间: one box to search, or to open a note, picture, folder or tag.
//          Typing offers matching tags; choosing tags narrows to what carries all of them and
//          offers related tags, and the result can be saved as a 合集.
// Layer: Space UI (gallery)

import { useCallback, useMemo, useRef, useState } from "react";

import { LayersIcon, SearchIcon, XIcon } from "~/lib/icons";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { SpaceItemCard } from "../SpaceItemCard";
import type { SpaceItem } from "../spaceItems";
import { SpaceMasonryGrid } from "../SpaceMasonryGrid";
import { SpaceFolderCard } from "./GalleryCards";
import { useGallery, type GalleryPlace } from "./GalleryContext";
import { useGalleryLocalStore } from "./galleryLocalStore";
import {
  countTags,
  filterSearchResult,
  searchGallery,
  type GalleryFilter,
  type TagCount,
} from "./galleryModel";

const FILTERS: ReadonlyArray<{ id: GalleryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "image", label: "图片" },
  { id: "note", label: "笔记" },
  { id: "folder", label: "文件夹" },
];
const CHIP_LIMIT = 8;
const RESULT_LIMIT = 60;
const IDLE_LIMIT = 12;

/** What a result card can do besides opening: the same menu as anywhere in the 资料空间. */
interface ResultActions {
  readonly placeOf: (item: SpaceItem) => string;
  readonly onContinueInChat?: ((item: SpaceItem) => void) | undefined;
  readonly onTogglePin?: ((item: SpaceItem) => void) | undefined;
  readonly onTrash?: ((item: SpaceItem) => void) | undefined;
}

export function GallerySearchDialog(
  props: ResultActions & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Tags to start with (opening search from a tag). */
    initialTags?: readonly string[];
  },
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <DialogPopup
          showCloseButton={false}
          bottomStickOnMobile={false}
          className="max-h-[calc(100vh-6rem)] max-w-4xl self-start"
          viewportClassName="items-start pt-12"
          data-gallery-search
        >
          <DialogTitle className="sr-only">搜索资料空间</DialogTitle>
          <SearchBody
            {...props}
            initialTags={props.initialTags ?? []}
            onDone={() => props.onOpenChange(false)}
          />
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function SearchBody(props: ResultActions & { initialTags: readonly string[]; onDone: () => void }) {
  const gallery = useGallery();
  const saveCollection = useGalleryLocalStore((state) => state.saveCollection);
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<readonly string[]>(props.initialTags);
  const [filter, setFilter] = useState<GalleryFilter>("all");
  const [naming, setNaming] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const result = useMemo(
    () =>
      searchGallery({
        query,
        tags,
        items: gallery.items,
        folders: gallery.tree.folders,
        tagsOf: gallery.tagsOf,
        textOf: gallery.textOf,
      }),
    [query, tags, gallery.items, gallery.tree.folders, gallery.tagsOf, gallery.textOf],
  );
  const allTags = useMemo(
    () => countTags(gallery.items, gallery.tagsOf),
    [gallery.items, gallery.tagsOf],
  );
  const chips: readonly TagCount[] = query.trim()
    ? result.matchingTags
    : tags.length
      ? result.relatedTags
      : allTags;
  const chipLabel = query.trim() ? "标签" : tags.length ? "相关标签" : "标签";
  const shown = filterSearchResult(result, filter);
  type Entry =
    | { readonly type: "folder"; readonly folder: (typeof shown.folders)[number] }
    | { readonly type: "item"; readonly item: SpaceItem };
  const entries: Entry[] = [
    ...shown.folders.map((folder): Entry => ({ type: "folder", folder })),
    // Before anything is typed or chosen, a short recent list; the rest is a word away.
    ...shown.items
      .slice(0, query.trim() || tags.length ? RESULT_LIMIT : IDLE_LIMIT)
      .map((item): Entry => ({ type: "item", item })),
  ];

  const chooseTag = (tag: string) => {
    setTags((current) => (current.includes(tag) ? current : [...current, tag]));
    setQuery("");
    setNaming(null);
    inputRef.current?.focus();
  };
  const onOpenItem = useCallback(
    (item: SpaceItem) => {
      props.onDone();
      gallery.onOpenItem(item);
    },
    [gallery, props],
  );
  const onPlace = useCallback(
    (place: GalleryPlace) => {
      props.onDone();
      gallery.onPlace(place);
    },
    [gallery, props],
  );

  return (
    <div className="flex min-h-0 flex-col" data-gallery-search-body>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex shrink-0 items-center gap-1 rounded-control bg-accent ps-2 pe-0.5 text-ui"
            data-gallery-search-token={tag}
          >
            #{tag}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`移除标签 ${tag}`}
              onClick={() => setTags((current) => current.filter((entry) => entry !== tag))}
            >
              <XIcon />
            </Button>
          </span>
        ))}
        <input
          ref={inputRef}
          autoFocus
          value={query}
          aria-label="搜索资料空间"
          placeholder={tags.length ? "在这些标签里搜索" : "搜索笔记、图片或标签"}
          className="min-w-0 flex-1 bg-transparent text-ui-lg outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposingKeyEvent(event)) return;
            if (event.key === "Backspace" && query === "" && tags.length) {
              setTags((current) => current.slice(0, -1));
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            const exact = result.matchingTags.find(
              (entry) => entry.tag === query.trim().toLowerCase(),
            );
            if (exact) return chooseTag(exact.tag);
            const first = entries[0];
            if (!first) return;
            if (first.type === "folder") onPlace({ type: "folder", key: first.folder.key });
            else onOpenItem(first.item);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className="text-ui-xs text-muted-foreground">{chipLabel}</span>
        <div
          role="group"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          aria-label={chipLabel}
        >
          {chips.length === 0 ? (
            <span className="text-ui-xs text-muted-foreground">没有标签</span>
          ) : (
            chips.slice(0, CHIP_LIMIT).map((entry) => (
              <Button
                key={entry.tag}
                size="chip"
                variant="outline"
                className="rounded-full"
                aria-label={`标签 ${entry.tag}，${entry.count} 项`}
                data-gallery-tag-chip={entry.tag}
                onClick={() => chooseTag(entry.tag)}
              >
                <span className="text-muted-foreground">#</span>
                {entry.tag}
                <span className="text-ui-xs text-muted-foreground tabular-nums">{entry.count}</span>
              </Button>
            ))
          )}
        </div>
        {/* The type filter is for narrowing a result, so it shows once there is one. */}
        {query.trim() || tags.length ? (
          <div role="radiogroup" aria-label="类型" className="flex shrink-0 items-center gap-0.5">
            {FILTERS.filter((entry) => entry.id === "all" || result.counts[entry.id] > 0).map(
              (entry) => (
                <Button
                  key={entry.id}
                  size="xs"
                  variant="ghost"
                  role="radio"
                  aria-checked={filter === entry.id}
                  className={cn(filter === entry.id && "bg-accent text-foreground")}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label}
                  <span className="text-muted-foreground tabular-nums">
                    {result.counts[entry.id]}
                  </span>
                </Button>
              ),
            )}
          </div>
        ) : null}
      </div>
      {tags.length ? (
        <div className="flex items-center gap-2 px-4 pb-2">
          {naming === null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setNaming(tags.map((tag) => `#${tag}`).join(" "))}
            >
              <LayersIcon />
              保存为合集…
            </Button>
          ) : (
            <form
              className="flex flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const saved = saveCollection(naming, tags);
                onPlace({ type: "collection", id: saved.id });
              }}
            >
              <LayersIcon aria-hidden className="size-4 text-muted-foreground" />
              <input
                autoFocus
                aria-label="合集名称"
                value={naming}
                className="h-control-sm min-w-0 flex-1 rounded-control border border-border bg-transparent px-2 text-ui outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onChange={(event) => setNaming(event.target.value)}
              />
              <Button size="sm" type="submit">
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>
                取消
              </Button>
            </form>
          )}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border pt-3">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {entries.length === 0 ? (
            <p role="status" className="py-16 text-center text-ui text-muted-foreground">
              没有找到匹配项
            </p>
          ) : (
            <SpaceMasonryGrid>
              {entries.map((entry) =>
                entry.type === "folder"
                  ? {
                      key: entry.folder.key,
                      node: (
                        <SpaceFolderCard
                          folder={entry.folder}
                          marked={false}
                          onOpen={(folder) => onPlace({ type: "folder", key: folder.key })}
                        />
                      ),
                    }
                  : {
                      key: entry.item.key,
                      node: (
                        <SpaceItemCard
                          item={entry.item}
                          view="grid"
                          place={props.placeOf(entry.item)}
                          now={now}
                          onOpen={onOpenItem}
                          onContinueInChat={props.onContinueInChat}
                          onTogglePin={props.onTogglePin}
                          onTrash={props.onTrash}
                        />
                      ),
                    },
              )}
            </SpaceMasonryGrid>
          )}
        </div>
      </div>
    </div>
  );
}
