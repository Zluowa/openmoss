import { describe, expect, it } from "vitest";
import {
  PageId,
  PageSpaceId,
  ThreadId,
  type LibraryItem,
  type Page,
  type SpaceOutput,
} from "@moss/contracts";

import {
  buildSpaceItems,
  formatRelativeTime,
  itemsForSection,
  recentItems,
  trashDaysLeft,
  spaceItemDisplayTitle,
  spaceMossMediaPath,
} from "./spaceItems";
import type { SpacePageApp } from "~/lib/spacePageApps";

const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T08:00:00.000Z`;

function page(id: string, overrides: Partial<Page> = {}): Page {
  return {
    id: PageId.makeUnsafe(id),
    scopeSpaceId: null,
    spaceId: null,
    parentPageId: null,
    rootPageId: PageId.makeUnsafe(id),
    title: id,
    revision: 1,
    pinned: false,
    trashedAt: null,
    sourceThreadId: null,
    assetIds: [],
    automationIds: [],
    createdAt: at(1),
    updatedAt: at(1),
    ...overrides,
  };
}

const output: SpaceOutput = {
  id: "thread-1|out/report.html",
  kind: "file",
  title: "report.html",
  path: "out/report.html",
  workspaceRoot: "/work",
  threadId: ThreadId.makeUnsafe("thread-1"),
  threadTitle: "Make a report",
  updatedAt: at(4),
  trashedAt: null,
};

const app: SpacePageApp = {
  id: "app-1",
  scopeSpaceId: null,
  spaceId: null,
  title: "Habit tracker",
  description: "",
  revision: 1,
  favorite: true,
  thumbnail: null,
  sourceThreadId: null,
  trashedAt: null,
  createdAt: at(2),
  updatedAt: at(2),
};

const library: LibraryItem = {
  id: "lib-1",
  title: "photo.png",
  kind: "image",
  source: "codex:generated",
  sourceCli: "codex",
  path: "C:/images/photo.png",
  mimeType: "image/png",
  size: 10,
  favorite: false,
  folderId: null,
  trashedAt: null,
  originationThreadId: "thread-2",
  createdAt: at(3),
  updatedAt: at(3),
};

const spaceId = PageSpaceId.makeUnsafe("space-1");
const pages = [
  page("personal", { updatedAt: at(5), pinned: true }),
  page("child", {
    parentPageId: PageId.makeUnsafe("personal"),
    rootPageId: PageId.makeUnsafe("personal"),
  }),
  page("root", { spaceId }),
  page("in-space", {
    spaceId,
    parentPageId: PageId.makeUnsafe("root"),
    rootPageId: PageId.makeUnsafe("root"),
  }),
  page("deck", { kind: "slides", updatedAt: at(6) }),
  page("old", { trashedAt: at(3) }),
  page("old-child", {
    trashedAt: at(3),
    parentPageId: PageId.makeUnsafe("old"),
    rootPageId: PageId.makeUnsafe("old"),
  }),
];
const items = buildSpaceItems({ pages, apps: [app], outputs: [output], library: [library] });
const keys = (list: readonly { key: string }[]) => list.map((item) => item.key);
const all = { tab: "mine" as const, kind: "any" as const, query: "" };

describe("资料空间 items", () => {
  it("merges every source newest first", () => {
    expect(keys(items).slice(0, 3)).toEqual([
      "page:deck",
      "page:personal",
      "output:thread-1|out/report.html",
    ]);
    expect(items.find((item) => item.key === "app:app-1")?.kind).toBe("app");
    expect(items.find((item) => item.key === "library:lib-1")?.kind).toBe("image");
  });

  it("lists top-level pages, a space's top pages and every other item under 你的条目", () => {
    expect(keys(itemsForSection(items, { type: "all" }, all)).toSorted()).toEqual(
      [
        "app:app-1",
        "library:lib-1",
        "output:thread-1|out/report.html",
        "page:deck",
        "page:in-space",
        "page:personal",
      ].toSorted(),
    );
  });

  it("finds subpages by search", () => {
    expect(keys(itemsForSection(items, { type: "all" }, { ...all, query: "CHILD" }))).toEqual([
      "page:child",
    ]);
  });

  it("filters by tab and kind", () => {
    expect(
      keys(itemsForSection(items, { type: "all" }, { ...all, tab: "favorites" })).toSorted(),
    ).toEqual(["app:app-1", "page:personal"]);
    expect(itemsForSection(items, { type: "all" }, { ...all, tab: "shared" })).toEqual([]);
    expect(keys(itemsForSection(items, { type: "all" }, { ...all, kind: "file" }))).toEqual([
      "output:thread-1|out/report.html",
    ]);
    expect(keys(itemsForSection(items, { type: "kind", kind: "slides" }, all))).toEqual([
      "page:deck",
    ]);
    expect(keys(itemsForSection(items, { type: "kind", kind: "image" }, all))).toEqual([
      "library:lib-1",
    ]);
    expect(keys(itemsForSection(items, { type: "space", spaceId }, all))).toEqual([
      "page:in-space",
    ]);
  });

  it("puts pinned items first under 推荐", () => {
    expect(
      itemsForSection(items, { type: "all" }, { ...all, tab: "recommended" })
        .slice(0, 2)
        .map((item) => item.pinned),
    ).toEqual([true, true]);
  });

  it("lists only trash roots in 回收站", () => {
    expect(keys(itemsForSection(items, { type: "trash" }, all))).toEqual(["page:old"]);
    expect(keys(recentItems(items, 20))).not.toContain("page:old");
  });

  it("counts the days left in trash and formats relative time", () => {
    const now = Date.parse(at(10));
    expect(trashDaysLeft(at(3), now, 30)).toBe(23);
    expect(trashDaysLeft("2026-09-01T00:00:00.000Z", now, 30)).toBe(0);
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe("刚刚");
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 分钟前");
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 小时前");
    expect(formatRelativeTime(at(8), now)).toBe("2 天前");
    expect(formatRelativeTime("2026-10-01T08:00:00.000Z", now)).toBe("10月1日");
  });
});

describe("spaceItemDisplayTitle", () => {
  it("keeps a real title and names untitled items instead of showing nothing", () => {
    expect(spaceItemDisplayTitle({ title: "会议纪要", kind: "page" })).toBe("会议纪要");
    expect(spaceItemDisplayTitle({ title: "  ", kind: "page" })).toBe("未命名页面");
    expect(spaceItemDisplayTitle({ title: "", kind: "slides" })).toBe("未命名");
  });
});

describe("资料空间 lists images and videos made in a chat", () => {
  const media = (id: string, kind: "image" | "video", title: string): LibraryItem => ({
    id: `moss-media:${"a".repeat(64)}:moss_${id}:0`,
    title,
    kind,
    source: "user:legacy",
    sourceCli: "moss",
    path: null,
    mimeType: kind === "video" ? "video/mp4" : "image/png",
    size: 10,
    favorite: false,
    folderId: null,
    trashedAt: null,
    originationThreadId: "thread-media",
    createdAt: at(7),
    updatedAt: at(7),
    mediaJobId: `moss_${id}`,
    mediaImageIndex: 0,
    previewPath: `/api/moss/media/assets/moss_${id}/0`,
  });
  const legacy: LibraryItem = { ...library, id: "legacy", path: null };
  const listed = buildSpaceItems({
    pages: [],
    apps: [],
    outputs: [],
    library: [media("img", "image", "小狐狸.png"), media("vid", "video", "海浪.mp4"), legacy],
  });

  it("keeps chat media (no local file, saved in Moss) and still drops legacy rows", () => {
    expect(keys(itemsForSection(listed, { type: "all" }, all)).toSorted()).toEqual(
      [
        `library:moss-media:${"a".repeat(64)}:moss_img:0`,
        `library:moss-media:${"a".repeat(64)}:moss_vid:0`,
      ].toSorted(),
    );
    expect(listed.map((item) => item.sourceThreadId)).toEqual(["thread-media", "thread-media"]);
    expect(listed.map((item) => item.kind).toSorted()).toEqual(["file", "image"]);
  });

  it("opens them from their saved Moss address", () => {
    expect(spaceMossMediaPath(media("vid", "video", "海浪.mp4"))).toBe(
      "/api/moss/media/assets/moss_vid/0",
    );
    expect(spaceMossMediaPath(legacy)).toBeNull();
    expect(
      spaceMossMediaPath({ ...media("x", "image", "x.png"), mediaJobId: "../escape" }),
    ).toBeNull();
  });
});
