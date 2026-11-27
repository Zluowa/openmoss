import {
  PageId,
  type LibraryFolder,
  type LibraryItem,
  type Page,
  type PageSpace,
} from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { libraryItem, pageItem, type SpaceItem } from "../spaceItems";
import {
  buildGalleryTree,
  collectionItems,
  fileIntoSpaces,
  filterSearchResult,
  fitCanvas,
  folderSummary,
  layoutCanvas,
  noteBlocks,
  noteHashtags,
  searchGallery,
} from "./galleryModel";

const T = "2026-11-20T09:00:00.000Z";

function page(id: string, overrides: Partial<Page> = {}): Page {
  return {
    id: PageId.makeUnsafe(id),
    scopeSpaceId: null,
    spaceId: null,
    parentPageId: null,
    rootPageId: PageId.makeUnsafe(id),
    title: id,
    kind: "page",
    sourceThreadId: null,
    pinned: false,
    trashedAt: null,
    assetIds: [],
    automationIds: [],
    createdAt: T,
    updatedAt: T,
    revision: 1,
    ...overrides,
  } as Page;
}

function space(id: string, title: string): PageSpace {
  return {
    id,
    scopeSpaceId: null,
    rootPageId: PageId.makeUnsafe(`${id}-root`),
    title,
    revision: 1,
    trashedAt: null,
    createdAt: T,
    updatedAt: T,
  } as PageSpace;
}

function image(id: string, folderId: string | null, updatedAt = T): SpaceItem {
  return libraryItem({
    id,
    title: `${id}.png`,
    kind: "image",
    source: "upload",
    sourceCli: null,
    path: `/pictures/${id}.png`,
    mimeType: "image/png",
    size: 1000,
    favorite: false,
    folderId,
    trashedAt: null,
    originationThreadId: null,
    createdAt: T,
    updatedAt,
  } as unknown as LibraryItem);
}

const folder = (id: string, title: string): LibraryFolder => ({
  id,
  title,
  createdAt: T,
  updatedAt: T,
});

describe("buildGalleryTree", () => {
  it("makes a 资料空间 and the 资料库 folder of the same name one folder", () => {
    const brand = space("space-brand", "品牌");
    const note = pageItem(
      page("brief", {
        spaceId: brand.id,
        rootPageId: brand.rootPageId,
        parentPageId: brand.rootPageId,
      }),
    );
    const root = pageItem(page("space-brand-root", { spaceId: brand.id }));
    const tree = buildGalleryTree({
      items: [note, root, image("logo", "lib-brand"), image("loose", null)],
      spaces: [brand],
      libraryFolders: [folder("lib-brand", "品牌"), folder("lib-cars", "汽车")],
    });
    expect(tree.folders.map((entry) => entry.title)).toEqual(["品牌", "汽车"]);
    const merged = tree.folders[0]!;
    expect(merged.items.map((item) => item.key)).toEqual(["page:brief", "library:logo"]);
    expect(folderSummary(merged)).toBe("1 篇笔记 · 1 张图片");
    expect(folderSummary(tree.folders[1]!)).toBe("空文件夹");
    // A space's root page is the folder itself, not a card inside it.
    expect(tree.loose.map((item) => item.key)).toEqual(["library:loose"]);
  });
});

describe("notes", () => {
  const markdown = [
    "# 本周",
    "Locus",
    "- [ ] 定下图标 #logo",
    "- [x] 默认用画廊",
    "- 量一下谷仓门",
    "![草图](https://example.com/a.png)",
    "颜色参考 #黑白 和 #typography。",
    "> 少，但是更好",
  ].join("\n");

  it("reads headings, tasks, bullets, images and paragraphs", () => {
    expect(noteBlocks(markdown).map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "task",
      "task",
      "bullet",
      "image",
      "paragraph",
      "quote",
    ]);
    expect(noteBlocks(markdown)[3]).toEqual({ type: "task", text: "默认用画廊", done: true });
  });

  it("finds #tags but not headings", () => {
    expect(noteHashtags(markdown)).toEqual(["logo", "黑白", "typography"]);
  });
});

describe("searchGallery", () => {
  const items = [image("logo-dark", null), image("barn", null), pageItem(page("brief"))];
  const tags: Record<string, string[]> = {
    "library:logo-dark": ["logo", "black and white"],
    "library:barn": ["barn", "black and white"],
    "page:brief": ["logo"],
  };
  const base = {
    items,
    folders: [],
    tagsOf: (item: SpaceItem) => tags[item.key] ?? [],
    textOf: (item: SpaceItem) => (item.key === "page:brief" ? "a notes app" : ""),
  };

  it("offers tags matching what was typed", () => {
    const result = searchGallery({ ...base, query: "lo", tags: [] });
    expect(result.matchingTags.map((entry) => entry.tag)).toEqual(["logo"]);
    expect(result.items.map((item) => item.key)).toEqual(["library:logo-dark", "page:brief"]);
  });

  it("narrows by every chosen tag and offers related tags", () => {
    const result = searchGallery({ ...base, query: "", tags: ["logo"] });
    expect(result.items).toHaveLength(2);
    expect(result.relatedTags).toEqual([{ tag: "black and white", count: 1 }]);
    expect(result.counts).toMatchObject({ image: 1, note: 1, folder: 0 });
    expect(filterSearchResult(result, "image").items.map((item) => item.key)).toEqual([
      "library:logo-dark",
    ]);
  });

  it("matches note text", () => {
    expect(
      searchGallery({ ...base, query: "notes app", tags: [] }).items.map((item) => item.key),
    ).toEqual(["page:brief"]);
  });

  it("collections hold what carries all their tags", () => {
    const collection = { id: "c", title: "Logo", tags: ["logo", "black and white"] };
    expect(collectionItems(collection, items, base.tagsOf).map((item) => item.key)).toEqual([
      "library:logo-dark",
    ]);
  });
});

describe("layout", () => {
  it("packs a cluster's pictures in rows at their proportions", () => {
    const pictures = [image("a", null), image("b", null), image("c", null)];
    const layout = layoutCanvas([{ id: "g", label: "图片", items: pictures }], (item) =>
      item.key === "library:a" ? 2 : 1,
    );
    expect(layout.items.get("library:a")).toMatchObject({ x: 0, width: 240, height: 120 });
    expect(layout.items.get("library:b")).toMatchObject({ x: 248, width: 120 });
    expect(layout.labels).toEqual([{ id: "g", label: "图片", x: 0, y: 0 }]);
  });

  it("fits bounds into a viewport without enlarging", () => {
    expect(
      fitCanvas({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 600 }),
    ).toEqual({ scale: 1, x: 450, y: 250 });
  });
});

describe("folderAssignments overrides", () => {
  it("files loose items without DB folder columns into assigned folders and spaces", () => {
    const space = {
      id: "space-brand" as never,
      scopeSpaceId: null,
      rootPageId: "root-brand" as never,
      title: "品牌方向",
      revision: 1,
      trashedAt: null,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    };
    const looseOutput = {
      key: "output:out-1",
      kind: "file" as const,
      title: "report.html",
      spaceId: null,
      pinned: false,
      trashedAt: null,
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
      sourceThreadId: "thread-1",
      source: {
        type: "output" as const,
        output: {
          id: "out-1",
          kind: "file" as const,
          title: "report.html",
          path: "report.html",
          workspaceRoot: "D:/repo",
          threadId: "thread-1" as never,
          threadTitle: "工作对话",
          updatedAt: "2026-11-21T00:00:00.000Z",
          trashedAt: null,
        },
      },
    };
    const assignments = { "output:out-1": "space:space-brand" };
    const filed = fileIntoSpaces({
      items: [looseOutput],
      spaces: [space],
      libraryFolders: [],
      folderAssignments: assignments,
    });
    expect(filed[0]?.spaceId).toBe("space-brand");

    const tree = buildGalleryTree({
      items: filed,
      spaces: [space],
      libraryFolders: [],
      folderAssignments: assignments,
    });
    expect(tree.loose).toHaveLength(0);
    expect(tree.folders[0]?.items.map((item) => item.key)).toEqual(["output:out-1"]);
  });
});
