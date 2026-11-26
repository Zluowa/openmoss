// FILE: spaceItems.ts
// Purpose: One item model for everything the 资料空间 lists — pages (and the kinds stored as
//          pages: slides, sheets, sites…), 应用页 and files agents wrote in chats — plus the
//          section/tab/filter rules the sidebar and the 全部 view share.
// Layer: Space UI domain helper (pure; tested in spaceItems.test.ts)

import type {
  LibraryItem,
  Page,
  PageSpace,
  PageSpaceId,
  SpaceItemKind,
  SpaceOutput,
} from "@moss/contracts";

import type { SpacePageApp } from "~/lib/spacePageApps";

export type SpaceItemSource =
  | { readonly type: "page"; readonly page: Page }
  | { readonly type: "app"; readonly app: SpacePageApp }
  | { readonly type: "output"; readonly output: SpaceOutput }
  /** Uploads and generated images kept by the 资料库. */
  | { readonly type: "library"; readonly item: LibraryItem };

export interface SpaceItem {
  /** Unique across sources: `page:<id>`, `app:<id>`, `output:<id>`. */
  readonly key: string;
  readonly kind: SpaceItemKind | (string & {});
  readonly title: string;
  readonly spaceId: PageSpaceId | null;
  readonly pinned: boolean;
  readonly trashedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Agent-made items (chat outputs, pages and apps an agent created) carry their chat. */
  readonly sourceThreadId: string | null;
  readonly source: SpaceItemSource;
}

export function pageItem(page: Page): SpaceItem {
  return {
    key: `page:${page.id}`,
    kind: page.kind ?? "page",
    title: page.title,
    spaceId: page.spaceId,
    pinned: page.pinned,
    trashedAt: page.trashedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    sourceThreadId: page.sourceThreadId,
    source: { type: "page", page },
  };
}

export function appItem(app: SpacePageApp): SpaceItem {
  return {
    key: `app:${app.id}`,
    kind: "app",
    title: app.title,
    spaceId: app.spaceId,
    pinned: app.favorite,
    trashedAt: app.trashedAt,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    sourceThreadId: app.sourceThreadId,
    source: { type: "app", app },
  };
}

export function outputItem(output: SpaceOutput): SpaceItem {
  return {
    key: `output:${output.id}`,
    kind: output.kind,
    title: output.title,
    spaceId: null,
    pinned: false,
    trashedAt: output.trashedAt,
    createdAt: output.updatedAt,
    updatedAt: output.updatedAt,
    sourceThreadId: output.threadId,
    source: { type: "output", output },
  };
}

export function libraryItem(item: LibraryItem): SpaceItem {
  return {
    key: `library:${item.id}`,
    kind: item.kind === "image" ? "image" : "file",
    title: item.title,
    spaceId: null,
    pinned: item.favorite,
    trashedAt: item.trashedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sourceThreadId: item.originationThreadId,
    source: { type: "library", item },
  };
}

/**
 * The saved Moss media address of an image or video made in a chat, or null for other rows.
 * These rows have no local file; their bytes stay in Moss's media cache.
 */
export function spaceMossMediaPath(item: LibraryItem): string | null {
  const index = item.mediaImageIndex;
  return item.mediaJobId &&
    /^moss_[A-Za-z0-9_-]{1,128}$/u.test(item.mediaJobId) &&
    index !== undefined &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index <= 31
    ? `/api/moss/media/assets/${item.mediaJobId}/${index}`
    : null;
}

/** Every item from every source, newest first; `itemsForSection` decides what is listed. */
export function buildSpaceItems(input: {
  pages: readonly Page[];
  apps: readonly SpacePageApp[];
  outputs: readonly SpaceOutput[];
  library?: readonly LibraryItem[];
}): SpaceItem[] {
  const items = [
    ...input.pages.map(pageItem),
    ...input.apps.map(appItem),
    ...input.outputs.map(outputItem),
    // Metadata-only legacy rows have no local file to open. Images and videos made in a
    // chat have none either, but open from Moss's media cache.
    ...(input.library ?? [])
      .filter((item) => item.path !== null || spaceMossMediaPath(item) !== null)
      .map(libraryItem),
  ];
  return items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Sidebar destinations that show a list of items. */
export type SpaceSection =
  | { readonly type: "all" }
  | { readonly type: "kind"; readonly kind: SpaceKindSection }
  | { readonly type: "space"; readonly spaceId: PageSpaceId }
  /** A 资料库 folder with no 资料空间 of the same name (one with a name match is that space). */
  | { readonly type: "folder"; readonly folderId: string }
  /** Everything carrying one tag: a note's #标签 or a tag added to a picture. */
  | { readonly type: "tag"; readonly tag: string }
  /** A saved search: everything carrying all of its tags. */
  | { readonly type: "collection"; readonly id: string; readonly tags: readonly string[] }
  | { readonly type: "trash" };

export type SpaceKindSection = "page" | "slides" | "site" | "image" | "app";

/** Extended kind targets navigable from the sidebar or home filter. */
export type SpaceExtendedKindSection =
  | SpaceKindSection
  | "sheet"
  | "design"
  | "dashboard"
  | "board";

/** Tabs of the 全部 view. */
export type SpaceTab = "all" | "recommended" | "favorites" | "mine" | "shared";

export const SPACE_TABS: ReadonlyArray<{ id: SpaceTab; label: string }> = [
  { id: "all", label: "全部" },
  { id: "mine", label: "你的条目" },
  { id: "shared", label: "与你共享" },
];

/** Kind filter of the 全部 view: one bucket per item family. */
export type SpaceKindFilter =
  | "any"
  | "page"
  | "slides"
  | "sheet"
  | "design"
  | "dashboard"
  | "board"
  | "site"
  | "app"
  | "image"
  | "file";

export const SPACE_KIND_FILTERS: ReadonlyArray<{ id: SpaceKindFilter; label: string }> = [
  { id: "any", label: "全部类型" },
  { id: "page", label: "文档" },
  { id: "slides", label: "幻灯片" },
  { id: "sheet", label: "电子表格" },
  { id: "design", label: "设计" },
  { id: "dashboard", label: "数据看板" },
  { id: "board", label: "画布" },
  { id: "app", label: "应用页" },
  { id: "site", label: "站点" },
  { id: "image", label: "图像" },
  { id: "file", label: "文件" },
];

export type SpaceOwnerFilter = "any" | "mine" | "agent";
export type SpaceSortOrder = "updated" | "created" | "title";

const dashboardKeyMap = new Map<string, boolean>();
const dashboardListeners = new Set<() => void>();
let dashboardRegistryVersion = 0;

/** Records whether an app-backed item actually renders a 数据看板 payload. */
export function markSpaceDashboardItem(key: string, isDashboard: boolean): void {
  if (dashboardKeyMap.get(key) === isDashboard) return;
  dashboardKeyMap.set(key, isDashboard);
  dashboardRegistryVersion += 1;
  for (const listener of dashboardListeners) listener();
}

export function subscribeSpaceDashboardRegistry(listener: () => void): () => void {
  dashboardListeners.add(listener);
  return () => dashboardListeners.delete(listener);
}

export function getSpaceDashboardRegistryVersion(): number {
  return dashboardRegistryVersion;
}

/** Resolves the visual/filter kind, distinguishing 数据看板 from generic 应用页. */
export function effectiveSpaceItemKind(
  item: Pick<SpaceItem, "key" | "kind">,
): SpaceItemKind | (string & {}) {
  if (item.kind === "dashboard") return "dashboard";
  if (item.kind === "app" && dashboardKeyMap.get(item.key) === true) return "dashboard";
  return item.kind;
}

let syncedHomeKind: SpaceKindFilter = "any";
const homeKindListeners = new Set<() => void>();

export function getSyncedSpaceHomeKind(): SpaceKindFilter {
  return syncedHomeKind;
}

export function setSyncedSpaceHomeKind(kind: SpaceKindFilter): void {
  if (syncedHomeKind === kind) return;
  syncedHomeKind = kind;
  for (const listener of homeKindListeners) listener();
}

export function subscribeSyncedSpaceHomeKind(listener: () => void): () => void {
  homeKindListeners.add(listener);
  return () => homeKindListeners.delete(listener);
}

/**
 * A page is listed on its own when it is a top-level personal page or a top-level page of a
 * document space. Deeper subpages open from their parent; a space's root page is the space.
 */
function isListedPage(page: Page): boolean {
  if (page.spaceId === null) return page.parentPageId === null;
  return page.id !== page.rootPageId && page.parentPageId === page.rootPageId;
}

function isListed(item: SpaceItem): boolean {
  return item.source.type !== "page" || isListedPage(item.source.page);
}

export function itemsForSection(
  items: readonly SpaceItem[],
  section: SpaceSection,
  options: {
    tab: SpaceTab;
    kind: SpaceKindFilter;
    query: string;
    owner?: SpaceOwnerFilter;
    sort?: SpaceSortOrder;
    /** Tags of an item, for the tag and 合集 views. */
    tagsOf?: ((item: SpaceItem) => readonly string[]) | undefined;
  },
): SpaceItem[] {
  const query = options.query.trim().toLocaleLowerCase();
  const matchesQuery = (item: SpaceItem) =>
    query === "" ||
    item.title.toLocaleLowerCase().includes(query) ||
    spaceItemDisplayTitle(item).toLocaleLowerCase().includes(query);
  if (section.type === "trash") {
    return items.filter(
      (item) => item.trashedAt !== null && isTrashRoot(item, items) && matchesQuery(item),
    );
  }
  const matchesOwner = (item: SpaceItem) => {
    if (options.owner === "mine") return item.sourceThreadId === null;
    if (options.owner === "agent") return item.sourceThreadId !== null;
    return true;
  };
  const live = items.filter(
    (item) => item.trashedAt === null && matchesQuery(item) && matchesOwner(item),
  );
  if (section.type === "space") {
    return sortSpaceItems(
      live.filter((item) => item.spaceId === section.spaceId && (query !== "" || isListed(item))),
      options.sort,
    );
  }
  if (section.type === "folder") {
    return sortSpaceItems(
      live.filter(
        (item) => item.source.type === "library" && item.source.item.folderId === section.folderId,
      ),
      options.sort,
    );
  }
  if (section.type === "tag" || section.type === "collection") {
    const wanted = section.type === "tag" ? [section.tag] : section.tags;
    const tagsOf = options.tagsOf ?? (() => []);
    return sortSpaceItems(
      live.filter((item) => {
        const own = tagsOf(item);
        return wanted.length > 0 && wanted.every((tag) => own.includes(tag));
      }),
      options.sort,
    );
  }
  if (section.type === "kind") {
    // Search reaches subpages too; browsing a kind lists only what stands on its own.
    return sortSpaceItems(
      live.filter(
        (item) => effectiveSpaceItemKind(item) === section.kind && (query !== "" || isListed(item)),
      ),
      options.sort,
    );
  }
  const listed = live.filter((item) => query !== "" || isListed(item));
  const byKind =
    options.kind === "any" ? listed : listed.filter((item) => kindFilterOf(item) === options.kind);
  switch (options.tab) {
    case "favorites":
      return sortSpaceItems(
        byKind.filter((item) => item.pinned),
        options.sort,
      );
    case "all":
    case "mine":
      return sortSpaceItems(byKind, options.sort);
    case "shared":
      // Nothing is shared into a local profile yet; sharing fills this once links exist.
      return [];
    case "recommended":
      return sortSpaceItems(recommended(byKind), options.sort);
  }
}

function sortSpaceItems(items: SpaceItem[], sort?: SpaceSortOrder): SpaceItem[] {
  if (sort === "created") {
    return items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (sort === "title") {
    return items.toSorted((a, b) =>
      spaceItemDisplayTitle(a).localeCompare(spaceItemDisplayTitle(b), "zh-CN"),
    );
  }
  return items;
}

/** 推荐: pinned first, then what changed most recently, a short list. */
function recommended(items: readonly SpaceItem[]): SpaceItem[] {
  const pinned = items.filter((item) => item.pinned);
  const rest = items.filter((item) => !item.pinned);
  return [...pinned, ...rest].slice(0, 24);
}

const FILTERED_KINDS: ReadonlySet<string> = new Set([
  "page",
  "slides",
  "sheet",
  "design",
  "dashboard",
  "board",
  "site",
  "app",
  "image",
]);

function kindFilterOf(item: SpaceItem): SpaceKindFilter {
  const kind = effectiveSpaceItemKind(item);
  return FILTERED_KINDS.has(kind) ? (kind as SpaceKindFilter) : "file";
}

/** A trashed page whose parent was trashed with it is restored with that parent. */
function isTrashRoot(item: SpaceItem, items: readonly SpaceItem[]): boolean {
  if (item.source.type !== "page") return true;
  const parentId = item.source.page.parentPageId;
  if (parentId === null) return true;
  const parent = items.find(
    (candidate) => candidate.source.type === "page" && candidate.source.page.id === parentId,
  );
  return !parent || parent.trashedAt === null;
}

/**
 * The name a person sees for an item. Untitled ones read 「未命名文档」 (or 「未命名」 for
 * other kinds) rather than an empty row or a stored id.
 */
export function spaceItemDisplayTitle(item: Pick<SpaceItem, "title" | "kind">): string {
  const title = item.title.trim();
  // A picture reads by its name, as Finder shows it; the format is in its details.
  if (title && item.kind === "image") {
    return title.replace(/\.(?:png|jpe?g|webp|gif|avif|heic|bmp|svg)$/iu, "") || title;
  }
  if (title) return title;
  return item.kind === "page" ? "未命名文档" : "未命名";
}

/** Recent items for the sidebar list. */
export function recentItems(items: readonly SpaceItem[], limit = 8): SpaceItem[] {
  return items.filter((item) => item.trashedAt === null).slice(0, limit);
}

export interface SpaceRecentGroup {
  readonly id: "today" | "yesterday" | "week" | "earlier";
  readonly label: string;
  readonly items: readonly SpaceItem[];
}

/** Groups non-trashed recent items into 今天 / 昨天 / 近 7 天 / 更早 buckets for the sidebar. */
export function groupRecentItems(
  items: readonly SpaceItem[],
  now = Date.now(),
  limit = 12,
): SpaceRecentGroup[] {
  const recent = recentItems(items, limit);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const weekMs = todayMs - 6 * 86_400_000;

  const buckets: Record<SpaceRecentGroup["id"], SpaceItem[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  };

  for (const item of recent) {
    const ms = Date.parse(item.updatedAt);
    if (!Number.isFinite(ms) || ms < weekMs) {
      buckets.earlier.push(item);
    } else if (ms >= todayMs) {
      buckets.today.push(item);
    } else if (ms >= yesterdayMs) {
      buckets.yesterday.push(item);
    } else {
      buckets.week.push(item);
    }
  }

  const order: ReadonlyArray<{ id: SpaceRecentGroup["id"]; label: string }> = [
    { id: "today", label: "今天" },
    { id: "yesterday", label: "昨天" },
    { id: "week", label: "近 7 天" },
    { id: "earlier", label: "更早" },
  ];

  return order
    .map(({ id, label }) => ({ id, label, items: buckets[id] }))
    .filter((group) => group.items.length > 0);
}

export function spaceTitle(spaces: readonly PageSpace[], spaceId: PageSpaceId | null): string {
  if (spaceId === null) return "个人";
  return spaces.find((space) => space.id === spaceId)?.title ?? "资料空间";
}

/** Days left before a trashed item is deleted for good (never below 0). */
export function trashDaysLeft(trashedAt: string, now: number, retentionDays: number): number {
  const elapsed = (now - Date.parse(trashedAt)) / 86_400_000;
  return Math.max(0, Math.ceil(retentionDays - elapsed));
}

/** "刚刚", "5 分钟前", "3 小时前", "2 天前", then a date. */
export function formatRelativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
