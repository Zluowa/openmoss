// FILE: galleryModel.ts
// Purpose: The 资料空间 gallery's model: folders (a 资料空间 and the 资料库 folder of the same
//          name are one folder), what a folder holds, note excerpts and #标签, tags and
//          collections, the search over all of it, and the canvas's cluster layout.
// Layer: Space UI domain helper (pure; tested in galleryModel.test.ts)
// Why: Notes and pictures are equals here. Pages, 资料库 files and chat outputs live in
//      different stores, so the gallery decides once what is a folder, a note or an image.

import type { LibraryFolder, PageSpace } from "@moss/contracts";

import type { SpaceItem } from "../spaceItems";

/** What a card is drawn as. Everything that is not a note or a picture is an "other". */
export type GalleryClass = "note" | "image" | "other";

export function galleryClassOf(item: SpaceItem): GalleryClass {
  if (item.kind === "image") return "image";
  if (item.source.type === "page" && (item.source.page.kind ?? "page") === "page") return "note";
  return "other";
}

export interface GalleryFolder {
  /** `space:<id>` when a 资料空间 backs it, otherwise `folder:<资料库 folder id>`. */
  readonly key: string;
  readonly title: string;
  readonly spaceId: string | null;
  readonly libraryFolderIds: readonly string[];
  readonly items: readonly SpaceItem[];
  readonly updatedAt: string;
}

export interface GalleryTree {
  readonly folders: readonly GalleryFolder[];
  /** Items in no folder: the home view lists them after the folders. */
  readonly loose: readonly SpaceItem[];
}

/** A page is shown on its own when it is a top-level page; deeper subpages open from it. */
function isShownPage(item: SpaceItem): boolean {
  if (item.source.type !== "page") return true;
  const page = item.source.page;
  if (page.spaceId === null) return page.parentPageId === null;
  return page.id !== page.rootPageId && page.parentPageId === page.rootPageId;
}

function folderTitleKey(title: string): string {
  return title.trim().toLocaleLowerCase();
}

/**
 * Builds the folders and the loose items. A 资料空间 is a folder for its pages; a 资料库 folder
 * is a folder for its files. When both have the same name they are one folder, so a person who
 * keeps 「品牌」 pages and 「品牌」 pictures finds them side by side.
 */
export function buildGalleryTree(input: {
  readonly items: readonly SpaceItem[];
  readonly spaces: readonly PageSpace[];
  readonly libraryFolders: readonly LibraryFolder[];
  readonly folderAssignments?: Readonly<Record<string, string>>;
}): GalleryTree {
  const live = input.items.filter((item) => item.trashedAt === null && isShownPage(item));
  const drafts = new Map<
    string,
    { key: string; title: string; spaceId: string | null; libraryFolderIds: string[] }
  >();
  const byTitle = new Map<string, string>();
  for (const space of input.spaces) {
    if (space.trashedAt !== null) continue;
    const key = `space:${space.id}`;
    drafts.set(key, { key, title: space.title, spaceId: space.id, libraryFolderIds: [] });
    if (!byTitle.has(folderTitleKey(space.title))) byTitle.set(folderTitleKey(space.title), key);
  }
  const libraryFolderKey = new Map<string, string>();
  for (const folder of input.libraryFolders) {
    const same = byTitle.get(folderTitleKey(folder.title));
    if (same) {
      drafts.get(same)!.libraryFolderIds.push(folder.id);
      libraryFolderKey.set(folder.id, same);
      continue;
    }
    const key = `folder:${folder.id}`;
    drafts.set(key, { key, title: folder.title, spaceId: null, libraryFolderIds: [folder.id] });
    byTitle.set(folderTitleKey(folder.title), key);
    libraryFolderKey.set(folder.id, key);
  }
  const spaceKey = new Map(
    [...drafts.values()].flatMap((draft) =>
      draft.spaceId ? [[draft.spaceId, draft.key] as const] : [],
    ),
  );
  const contents = new Map<string, SpaceItem[]>();
  const loose: SpaceItem[] = [];
  for (const item of live) {
    const assignedKey = input.folderAssignments?.[item.key];
    const resolvedAssigned = assignedKey && drafts.has(assignedKey) ? assignedKey : undefined;
    const key =
      item.source.type === "library" && item.source.item.folderId
        ? libraryFolderKey.get(item.source.item.folderId)
        : item.spaceId
          ? spaceKey.get(item.spaceId)
          : resolvedAssigned;
    if (!key) {
      loose.push(item);
      continue;
    }
    const list = contents.get(key) ?? [];
    list.push(item);
    contents.set(key, list);
  }
  const folders = [...drafts.values()].map((draft): GalleryFolder => {
    const items = contents.get(draft.key) ?? [];
    const updatedAt = items.reduce(
      (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
      "",
    );
    return { ...draft, items, updatedAt };
  });
  return {
    folders: folders.toSorted(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title),
    ),
    loose: sortForGallery(loose),
  };
}

/**
 * Files each picture in a 资料库 folder into the 资料空间 of the same name, and resolves any
 * local folder assignments for items without server folder columns (such as chat outputs),
 * so that space's view, search and sidebar show all its contents together.
 */
export function fileIntoSpaces(input: {
  readonly items: readonly SpaceItem[];
  readonly spaces: readonly PageSpace[];
  readonly libraryFolders: readonly LibraryFolder[];
  readonly folderAssignments?: Readonly<Record<string, string>>;
}): SpaceItem[] {
  const spaceByTitle = new Map<string, PageSpace>();
  const spaceById = new Map<string, PageSpace>();
  for (const space of input.spaces) {
    if (space.trashedAt !== null) continue;
    spaceById.set(space.id, space);
    if (!spaceByTitle.has(folderTitleKey(space.title))) {
      spaceByTitle.set(folderTitleKey(space.title), space);
    }
  }
  const spaceByFolder = new Map<string, PageSpace>();
  for (const folder of input.libraryFolders) {
    const space = spaceByTitle.get(folderTitleKey(folder.title));
    if (space) spaceByFolder.set(folder.id, space);
  }
  const hasAssignments =
    input.folderAssignments !== undefined && Object.keys(input.folderAssignments).length > 0;
  if (spaceByFolder.size === 0 && !hasAssignments) return [...input.items];
  return input.items.map((item) => {
    if (item.source.type === "library" && item.source.item.folderId) {
      const space = spaceByFolder.get(item.source.item.folderId);
      return space ? { ...item, spaceId: space.id } : item;
    }
    if (item.spaceId === null && hasAssignments) {
      const assigned = input.folderAssignments?.[item.key];
      if (assigned?.startsWith("space:")) {
        const space = spaceById.get(assigned.slice("space:".length));
        if (space) return { ...item, spaceId: space.id };
      } else if (assigned?.startsWith("folder:")) {
        const space = spaceByFolder.get(assigned.slice("folder:".length));
        if (space) return { ...item, spaceId: space.id };
      }
    }
    return item;
  });
}

/** Notes first, then pictures, then the rest; newest first inside each. */
export function sortForGallery(items: readonly SpaceItem[]): SpaceItem[] {
  const rank: Record<GalleryClass, number> = { note: 0, image: 1, other: 2 };
  return items.toSorted(
    (a, b) =>
      rank[galleryClassOf(a)] - rank[galleryClassOf(b)] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** 「2 篇笔记 · 13 张图片 · 1 个其他」: what a folder holds, in the order cards show it. */
export function folderSummary(folder: Pick<GalleryFolder, "items">): string {
  const counts = { note: 0, image: 0, other: 0 };
  for (const item of folder.items) counts[galleryClassOf(item)] += 1;
  const parts = [
    counts.note ? `${counts.note} 篇笔记` : null,
    counts.image ? `${counts.image} 张图片` : null,
    counts.other ? `${counts.other} 个其他` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : "空文件夹";
}

// ---------------------------------------------------------------------------------------------
// Notes: excerpt blocks and #标签

export type NoteBlock =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "bullet"; readonly text: string }
  | { readonly type: "quote"; readonly text: string }
  | { readonly type: "task"; readonly text: string; readonly done: boolean }
  | { readonly type: "image"; readonly src: string; readonly alt: string };

function plainInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]+/gu, "")
    .trim();
}

/** The first blocks of a note, enough to fill a card. The title is the card's own heading. */
export function noteBlocks(markdown: string, limit = 14): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = plainInline(paragraph.join(" "));
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };
  for (const raw of markdown.split(/\r?\n/u)) {
    if (blocks.length >= limit) break;
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/u.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    const task = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/u.exec(line);
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    const quote = /^>\s?(.*)$/u.exec(line);
    if (image) {
      flush();
      blocks.push({ type: "image", src: image[2]!, alt: image[1] ?? "" });
    } else if (heading) {
      flush();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      const text = plainInline(heading[2]!);
      if (text) blocks.push({ type: "heading", level, text });
    } else if (task) {
      flush();
      blocks.push({ type: "task", text: plainInline(task[2]!), done: task[1] !== " " });
    } else if (quote) {
      flush();
      const text = plainInline(quote[1]!);
      if (text) blocks.push({ type: "quote", text });
    } else if (bullet) {
      flush();
      blocks.push({ type: "bullet", text: plainInline(bullet[1]!) });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks.slice(0, limit);
}

/** Plain text of a note for search: what a person reads, without markup. */
export function notePlainText(markdown: string): string {
  return noteBlocks(markdown, 10_000)
    .map((block) => (block.type === "image" ? block.alt : block.text))
    .join("\n");
}

const HASHTAG = /(^|[\s(（,，。;；:：])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})/gu;

/** `#标签` written in a note's text. A heading's `# ` is not a tag: a tag has no space. */
export function noteHashtags(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*#{1,6}\s/u.test(line)) continue;
    for (const match of line.matchAll(HASHTAG)) found.add(normalizeTag(match[2]!));
  }
  return [...found];
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Tags, search and collections

export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

/** Every tag with how many items carry it, most used first. */
export function countTags(
  items: readonly SpaceItem[],
  tagsOf: (item: SpaceItem) => readonly string[],
): TagCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of new Set(tagsOf(item))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export type GalleryFilter = "all" | "image" | "note" | "folder";

export interface GallerySearchInput {
  readonly query: string;
  /** Chosen tags: an item must carry every one. */
  readonly tags: readonly string[];
  readonly items: readonly SpaceItem[];
  readonly folders: readonly GalleryFolder[];
  readonly tagsOf: (item: SpaceItem) => readonly string[];
  readonly textOf: (item: SpaceItem) => string;
}

export interface GallerySearchResult {
  readonly items: readonly SpaceItem[];
  readonly folders: readonly GalleryFolder[];
  /** Tags whose name matches what was typed (typing 「log」 offers #logo, #login…). */
  readonly matchingTags: readonly TagCount[];
  /** Other tags the matched items carry, for narrowing further. */
  readonly relatedTags: readonly TagCount[];
  readonly counts: Readonly<Record<GalleryFilter, number>>;
}

export function searchGallery(input: GallerySearchInput): GallerySearchResult {
  const query = input.query.trim().toLocaleLowerCase();
  const chosen = input.tags.map(normalizeTag);
  const withTags = input.items.filter((item) => {
    const tags = input.tagsOf(item);
    return chosen.every((tag) => tags.includes(tag));
  });
  const scored = withTags
    .map((item) => ({ item, score: query ? scoreItem(item, query, input) : 1 }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
  const items = scored.map((entry) => entry.item);
  const folders =
    chosen.length === 0
      ? input.folders.filter((folder) => !query || folder.title.toLocaleLowerCase().includes(query))
      : [];
  const allTags = countTags(input.items, input.tagsOf);
  const matchingTags = query
    ? allTags.filter((entry) => entry.tag.includes(query) && !chosen.includes(entry.tag))
    : [];
  const relatedTags = countTags(items, input.tagsOf).filter((entry) => !chosen.includes(entry.tag));
  const images = items.filter((item) => galleryClassOf(item) === "image").length;
  const notes = items.filter((item) => galleryClassOf(item) === "note").length;
  return {
    items,
    folders,
    matchingTags: matchingTags.toSorted(
      (a, b) =>
        Number(b.tag.startsWith(query)) - Number(a.tag.startsWith(query)) || b.count - a.count,
    ),
    relatedTags,
    counts: {
      all: items.length + folders.length,
      image: images,
      note: notes,
      folder: folders.length,
    },
  };
}

function scoreItem(item: SpaceItem, query: string, input: GallerySearchInput): number {
  const title = item.title.toLocaleLowerCase();
  if (title.startsWith(query)) return 4;
  if (title.includes(query)) return 3;
  if (input.tagsOf(item).some((tag) => tag.includes(query))) return 2;
  if (input.textOf(item).toLocaleLowerCase().includes(query)) return 1;
  return 0;
}

export function filterSearchResult(
  result: GallerySearchResult,
  filter: GalleryFilter,
): { items: readonly SpaceItem[]; folders: readonly GalleryFolder[] } {
  switch (filter) {
    case "image":
    case "note":
      return { items: result.items.filter((item) => galleryClassOf(item) === filter), folders: [] };
    case "folder":
      return { items: [], folders: result.folders };
    default:
      return result;
  }
}

/** A saved search: the items carrying all of its tags. */
export interface GalleryCollection {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
}

export function collectionItems(
  collection: GalleryCollection,
  items: readonly SpaceItem[],
  tagsOf: (item: SpaceItem) => readonly string[],
): SpaceItem[] {
  const tags = collection.tags.map(normalizeTag);
  return sortForGallery(
    items.filter((item) => {
      const own = tagsOf(item);
      return tags.length > 0 && tags.every((tag) => own.includes(tag));
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Canvas layout

export interface CanvasGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SpaceItem[];
}

export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasLayout {
  readonly items: ReadonlyMap<string, CanvasRect>;
  readonly labels: ReadonlyArray<{ id: string; label: string; x: number; y: number }>;
  readonly bounds: CanvasRect;
}

export const CANVAS_NOTE_SIZE = { width: 180, height: 220 } as const;
const CANVAS_LABEL_SIZE = { width: 180, height: 44 } as const;
const CANVAS_TILE_HEIGHT = 120;
const CANVAS_GAP = 8;
const CANVAS_GROUP_GAP = 160;
const CANVAS_GROUP_WIDTH = 640;
const CANVAS_LABEL_SPACE = 36;
const CANVAS_COLUMNS = 2;

/**
 * Spreads groups out like prints on a studio wall: each group is a cluster (notes in a row on
 * top, pictures packed in rows under them at their own proportions), clusters two to a row.
 * `aspectOf` is width / height for a picture once known; unknown pictures are 4:3.
 */
export function layoutCanvas(
  groups: readonly CanvasGroup[],
  aspectOf: (item: SpaceItem) => number | undefined,
): CanvasLayout {
  const items = new Map<string, CanvasRect>();
  const labels: Array<{ id: string; label: string; x: number; y: number }> = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let maxX = 0;
  groups.forEach((group, index) => {
    if (index > 0 && index % CANVAS_COLUMNS === 0) {
      cursorX = 0;
      cursorY += rowHeight + CANVAS_GROUP_GAP;
      rowHeight = 0;
    }
    const originX = cursorX;
    const originY = cursorY;
    labels.push({ id: group.id, label: group.label, x: originX, y: originY });
    let y = originY + CANVAS_LABEL_SPACE;
    let width = 0;
    // Other kinds (slides, sheets…) are small labels in a row; notes are cards under them.
    const others = group.items.filter((item) => galleryClassOf(item) === "other");
    const notes = group.items.filter((item) => galleryClassOf(item) === "note");
    const pictures = group.items.filter((item) => galleryClassOf(item) === "image");
    for (const [row, size] of [
      [others, CANVAS_LABEL_SIZE],
      [notes, CANVAS_NOTE_SIZE],
    ] as const) {
      if (row.length === 0) continue;
      let x = originX;
      for (const item of row) {
        if (x > originX && x + size.width > originX + CANVAS_GROUP_WIDTH) {
          x = originX;
          y += size.height + CANVAS_GAP;
        }
        items.set(item.key, { x, y, ...size });
        x += size.width + CANVAS_GAP;
        width = Math.max(width, x - originX - CANVAS_GAP);
      }
      y += size.height + CANVAS_GAP * 3;
    }
    let x = originX;
    for (const picture of pictures) {
      const aspect = clampAspect(aspectOf(picture) ?? 4 / 3);
      const tileWidth = Math.round(CANVAS_TILE_HEIGHT * aspect);
      if (x > originX && x + tileWidth > originX + CANVAS_GROUP_WIDTH) {
        x = originX;
        y += CANVAS_TILE_HEIGHT + CANVAS_GAP;
      }
      items.set(picture.key, { x, y, width: tileWidth, height: CANVAS_TILE_HEIGHT });
      x += tileWidth + CANVAS_GAP;
      width = Math.max(width, x - originX - CANVAS_GAP);
    }
    const bottom = pictures.length ? y + CANVAS_TILE_HEIGHT : y - CANVAS_GAP * 3;
    rowHeight = Math.max(rowHeight, bottom - originY);
    cursorX = originX + Math.max(width, 200) + CANVAS_GROUP_GAP;
    maxX = Math.max(maxX, originX + width);
  });
  return {
    items,
    labels,
    bounds: { x: 0, y: 0, width: Math.max(maxX, 1), height: Math.max(cursorY + rowHeight, 1) },
  };
}

function clampAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 4 / 3;
  return Math.min(Math.max(aspect, 0.4), 3);
}

/** Scale and offset that fit `bounds` inside a viewport with some margin, never above 1. */
export function fitCanvas(
  bounds: CanvasRect,
  viewport: { readonly width: number; readonly height: number },
  margin = 48,
): { scale: number; x: number; y: number } {
  const width = Math.max(viewport.width - margin * 2, 1);
  const height = Math.max(viewport.height - margin * 2, 1);
  const scale = Math.min(1, width / bounds.width, height / bounds.height);
  return {
    scale,
    x: margin + (width - bounds.width * scale) / 2 - bounds.x * scale,
    y: margin + (height - bounds.height * scale) / 2 - bounds.y * scale,
  };
}
