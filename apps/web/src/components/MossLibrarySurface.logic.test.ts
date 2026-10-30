import { describe, expect, it } from "vitest";

import {
  MOSS_LIBRARY_CLI_SCAN_ROOT_HINTS,
  MOSS_LIBRARY_EMPTY_TILE_HEIGHTS,
  MOSS_LIBRARY_NEW_ACTIONS,
  MOSS_LIBRARY_RECOMMENDED_RECENT_LIMIT,
  MOSS_LIBRARY_SECTIONS,
  MOSS_LIBRARY_SORT_OPTIONS,
  assignMossLibraryItemsToFolder,
  buildMossLibraryContextMenu,
  createMossLibraryDemoCatalog,
  createMossLibraryFolder,
  createMossLibraryStubCatalog,
  discoverMossLibraryItemsFromDescriptors,
  filterMossLibraryItems,
  formatMossLibraryRelativeTime,
  inferMossLibrarySourceCliFromPath,
  ingestMossLibraryItemFromCliFile,
  mergeMossLibraryItems,
  mossLibraryEmptyHeightsForSection,
  mossLibraryFolderChildren,
  mossLibraryFolderItemFromServer,
  mossLibraryItemFromServer,
  mossLibraryItemsAllFavorite,
  mossLibraryRegisterPayloadFromLegacy,
  mossLibraryRenameKeepsExtension,
  mossLibrarySectionMatchesQuery,
  mossLibrarySelectionSummaryZh,
  normalizeMossLibraryQuery,
  partitionMossLibraryAllSection,
  removeMossLibraryItemsById,
  renameMossLibraryItem,
  resolveMossLibraryCatalog,
  resolveMossLibrarySection,
  resolveMossLibrarySort,
  setMossLibraryItemsFavorite,
  toggleMossLibrarySelectedId,
} from "./MossLibrarySurface.logic";

describe("MossLibrarySurface logic", () => {
  it("exposes Codex-aligned 资料库 sections", () => {
    expect(MOSS_LIBRARY_SECTIONS.map((section) => section.labelZh)).toEqual([
      "推荐",
      "收藏",
      "文件夹",
      "图像",
      "全部",
    ]);
  });

  it("resolves known and unknown section ids", () => {
    expect(resolveMossLibrarySection("folders").id).toBe("folders");
    expect(resolveMossLibrarySection("nope").id).toBe("recommended");
  });

  it("carries empty-state hints and masonry tile scaffold", () => {
    expect(resolveMossLibrarySection("images").emptyHintZh).toContain("Moss Canvas");
    expect(MOSS_LIBRARY_EMPTY_TILE_HEIGHTS.length).toBeGreaterThanOrEqual(12);
  });

  it("matches section chrome against search query", () => {
    const images = resolveMossLibrarySection("images");
    expect(mossLibrarySectionMatchesQuery(images, "")).toBe(true);
    expect(mossLibrarySectionMatchesQuery(images, "  canvas ")).toBe(true);
    expect(mossLibrarySectionMatchesQuery(images, "xyz-nope")).toBe(false);
    expect(normalizeMossLibraryQuery("  资料库 ")).toBe("资料库");
  });

  it("exposes Moss-branded 新建 actions and sort options", () => {
    expect(MOSS_LIBRARY_NEW_ACTIONS.map((action) => action.id)).toEqual([
      "folder",
      "import",
      "from-chatgpt",
      "from-canvas",
    ]);
    // The only sanctioned brand mention is the ChatGPT migration channel (§4.6);
    // no other action may borrow OpenAI product copy.
    expect(
      MOSS_LIBRARY_NEW_ACTIONS.filter((action) => action.id !== "from-chatgpt").some((action) =>
        /OpenAI|ChatGPT/i.test(action.labelZh),
      ),
    ).toBe(false);
    expect(resolveMossLibrarySort("name").labelZh).toBe("名称");
    expect(resolveMossLibrarySort("bogus").id).toBe("recent");
    expect(MOSS_LIBRARY_SORT_OPTIONS).toHaveLength(3);
  });

  it("varies empty masonry heights by section", () => {
    const recommended = mossLibraryEmptyHeightsForSection("recommended");
    const folders = mossLibraryEmptyHeightsForSection("folders");
    const images = mossLibraryEmptyHeightsForSection("images");
    expect(folders[0]!).toBeLessThan(recommended[0]!);
    expect(images.some((height, index) => height !== recommended[index])).toBe(true);
  });

  it("documents multi-CLI scan root convention under Moss user data", () => {
    expect(
      MOSS_LIBRARY_CLI_SCAN_ROOT_HINTS.some((hint) => hint.includes("cli-outputs/codex")),
    ).toBe(true);
    expect(MOSS_LIBRARY_CLI_SCAN_ROOT_HINTS.some((hint) => hint.includes("cli-outputs/grok"))).toBe(
      true,
    );
  });
});

describe("MossLibrary multi-CLI ingest mapping", () => {
  it("ingests CLI files into Codex-shaped cards without OpenAI-only providers", () => {
    const item = ingestMossLibraryItemFromCliFile({
      title: "notes.md",
      sourceCli: "codex",
      path: "/tmp/notes.md",
      mimeType: "text/markdown",
    });
    expect(item.kind).toBe("code");
    expect(item.sourceCli).toBe("codex");
    expect(item.subtitleZh).toContain("Codex CLI");
    expect(item.subtitleZh).not.toMatch(/ChatGPT|OpenAI/i);
  });

  it("infers source CLI from filesystem convention paths", () => {
    expect(inferMossLibrarySourceCliFromPath("library/cli-outputs/claude/dash.png")).toBe("claude");
    expect(inferMossLibrarySourceCliFromPath("/Users/x/.opencode/out/run.ts")).toBe("opencode");
    expect(inferMossLibrarySourceCliFromPath("library/cli-outputs/grok/summary.txt")).toBe("grok");
    expect(inferMossLibrarySourceCliFromPath("random/path.txt")).toBe("other");
  });

  it("discovers descriptors into deduped library items", () => {
    const discovered = discoverMossLibraryItemsFromDescriptors([
      {
        path: "library/cli-outputs/codex/plan.md",
        mimeType: "text/markdown",
        mtimeMs: 100,
      },
      {
        path: "library/cli-outputs/codex/plan.md",
        mimeType: "text/markdown",
        mtimeMs: 200,
      },
      {
        path: "library/cli-outputs/claude/shot.png",
        mimeType: "image/png",
        mtimeMs: 300,
        favorite: true,
      },
      {
        path: "library/cli-outputs/opencode/harness/",
        isDirectory: true,
        mtimeMs: 150,
      },
    ]);
    expect(discovered).toHaveLength(3);
    expect(discovered[0]!.sourceCli).toBe("claude");
    expect(discovered.some((item) => item.kind === "folder")).toBe(true);
    expect(discovered.some((item) => item.favorite)).toBe(true);
  });

  it("filters and sorts demo catalog by section", () => {
    const now = 1_800_000_000_000;
    const catalog = createMossLibraryDemoCatalog(now);
    expect(catalog.every((item) => item.isDemo)).toBe(true);
    expect(catalog.map((item) => item.sourceCli).sort()).toEqual([
      "claude",
      "codex",
      "grok",
      "moss",
      "opencode",
    ]);
    const images = filterMossLibraryItems(catalog, { sectionId: "images" });
    expect(images.every((item) => item.kind === "image")).toBe(true);
    expect(images.every((item) => Boolean(item.thumbnailUrl))).toBe(true);
    const favorites = filterMossLibraryItems(catalog, { sectionId: "favorites" });
    expect(favorites.some((item) => item.favorite)).toBe(true);
    const all = filterMossLibraryItems(catalog, { sectionId: "all", sortId: "name" });
    expect(all.map((item) => item.title)).toEqual([
      "agent-harness",
      "canvas-export.png",
      "dashboard.png",
      "grok-summary.txt",
      "research-notes.md",
    ]);
    const byKind = filterMossLibraryItems(catalog, { sectionId: "all", sortId: "kind" });
    expect(byKind[0]!.kind <= byKind[byKind.length - 1]!.kind).toBe(true);
  });

  it("surfaces recent multi-CLI cards under 推荐 (not permanent empty)", () => {
    const now = Date.now();
    const catalog = createMossLibraryDemoCatalog(now);
    const recommended = filterMossLibraryItems(catalog, { sectionId: "recommended" });
    expect(recommended.length).toBeGreaterThan(0);
    expect(
      recommended.every(
        (item) => item.kind !== "folder" || item.sectionIds.includes("recommended"),
      ),
    ).toBe(true);
    expect(recommended.length).toBeLessThanOrEqual(MOSS_LIBRARY_RECOMMENDED_RECENT_LIMIT);
    expect(createMossLibraryStubCatalog(now)).toHaveLength(catalog.length);
  });

  it("formats relative time in zh for card footers", () => {
    const now = 1_800_000_000_000;
    expect(formatMossLibraryRelativeTime(now - 10_000, now)).toBe("刚刚");
    expect(formatMossLibraryRelativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatMossLibraryRelativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(formatMossLibraryRelativeTime(now - 24 * 3_600_000, now)).toBe("昨天");
    expect(formatMossLibraryRelativeTime(now - 5 * 24 * 3_600_000, now)).toBe("5 天前");
  });

  it("resolves catalog: discovered wins over empty; demo only when empty", () => {
    const discovered = discoverMossLibraryItemsFromDescriptors([
      {
        path: "library/cli-outputs/grok/live.txt",
        mimeType: "text/plain",
        mtimeMs: 42,
      },
    ]);
    const withDiscovered = resolveMossLibraryCatalog({
      persisted: [],
      discovered,
      seedDemoIfEmpty: true,
    });
    expect(withDiscovered.source).toBe("discovered");
    expect(withDiscovered.hasDemo).toBe(false);
    expect(withDiscovered.items[0]!.title).toBe("live.txt");

    const demo = resolveMossLibraryCatalog({
      persisted: [],
      discovered: [],
      seedDemoIfEmpty: true,
      now: 99,
    });
    expect(demo.source).toBe("demo");
    expect(demo.hasDemo).toBe(true);
    expect(demo.items.every((item) => item.isDemo)).toBe(true);

    const empty = resolveMossLibraryCatalog({
      persisted: [],
      discovered: [],
      seedDemoIfEmpty: false,
    });
    expect(empty.source).toBe("empty");
    expect(empty.items).toEqual([]);
  });

  it("merges catalogs by id with later wins", () => {
    const a = ingestMossLibraryItemFromCliFile({
      id: "same",
      title: "old",
      sourceCli: "codex",
      updatedAt: 1,
    });
    const b = ingestMossLibraryItemFromCliFile({
      id: "same",
      title: "new",
      sourceCli: "claude",
      updatedAt: 2,
    });
    const merged = mergeMossLibraryItems([a], [b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("new");
    expect(merged[0]!.sourceCli).toBe("claude");
  });
});

describe("MossLibrary Codex interaction parity", () => {
  it("builds the Codex context menu with favorite label flipping", () => {
    const root = buildMossLibraryContextMenu({ favorite: false, kind: "document" });
    expect(root.map((entry) => entry.id)).toEqual([
      "chat",
      "favorite",
      "download",
      "share",
      "rename",
      "add-to-folder",
      "delete",
    ]);
    expect(root.map((entry) => entry.labelZh)).toEqual([
      "围绕此内容展开对话",
      "添加到收藏夹",
      "下载",
      "分享",
      "重命名",
      "添加到文件夹",
      "删除",
    ]);
    expect(root.find((entry) => entry.id === "delete")?.danger).toBe(true);
    const favorited = buildMossLibraryContextMenu({ favorite: true, kind: "image" });
    expect(favorited.find((entry) => entry.id === "favorite")?.labelZh).toBe("从收藏夹移除");
  });

  it("toggles multi-select membership immutably", () => {
    const empty: readonly string[] = [];
    const one = toggleMossLibrarySelectedId(empty, "a");
    expect(one).toEqual(["a"]);
    expect(empty).toEqual([]);
    expect(toggleMossLibrarySelectedId(one, "b")).toEqual(["a", "b"]);
    expect(toggleMossLibrarySelectedId(["a", "b"], "a")).toEqual(["b"]);
    expect(mossLibrarySelectionSummaryZh(16)).toBe("已选择 16 个");
  });

  it("creates folders, renames items, and toggles favorites", () => {
    const folder = createMossLibraryFolder("Pets", 1000);
    expect(folder.kind).toBe("folder");
    expect(folder.title).toBe("Pets");
    expect(folder.sectionIds).toContain("folders");

    const doc = ingestMossLibraryItemFromCliFile({
      id: "doc-1",
      title: "notes.md",
      sourceCli: "codex",
      updatedAt: 10,
    });
    const renamed = renameMossLibraryItem([doc], "doc-1", "  新名字.md  ", 20);
    expect(renamed[0]!.title).toBe("新名字.md");
    expect(renamed[0]!.updatedAt).toBe(20);
    // Blank titles are rejected.
    expect(renameMossLibraryItem([doc], "doc-1", "   ", 20)[0]!.title).toBe("notes.md");

    const favorited = setMossLibraryItemsFavorite([doc], ["doc-1"], true);
    expect(favorited[0]!.favorite).toBe(true);
    expect(favorited[0]!.sectionIds).toContain("favorites");
    const unfavorited = setMossLibraryItemsFavorite(favorited, ["doc-1"], false);
    expect(unfavorited[0]!.favorite).toBe(false);
    expect(unfavorited[0]!.sectionIds).not.toContain("favorites");
    expect(mossLibraryItemsAllFavorite(favorited, ["doc-1"])).toBe(true);
    expect(mossLibraryItemsAllFavorite(unfavorited, ["doc-1"])).toBe(false);
  });

  it("assigns items to folders and hides them from 推荐", () => {
    const folder = createMossLibraryFolder("Pets", 1000);
    const doc = ingestMossLibraryItemFromCliFile({
      id: "doc-2",
      title: "pet-quality.json",
      sourceCli: "moss",
      updatedAt: 5000,
    });
    const assigned = assignMossLibraryItemsToFolder([folder, doc], ["doc-2"], folder.id);
    expect(assigned.find((item) => item.id === "doc-2")?.folderId).toBe(folder.id);
    expect(mossLibraryFolderChildren(assigned, folder.id).map((item) => item.id)).toEqual([
      "doc-2",
    ]);
    // Filed items leave 推荐 even when recent.
    const recommended = filterMossLibraryItems(assigned, { sectionId: "recommended" });
    expect(recommended.some((item) => item.id === "doc-2")).toBe(false);
    // Folders themselves cannot be filed into folders.
    const other = createMossLibraryFolder("Other", 2000);
    const nested = assignMossLibraryItemsToFolder([folder, other], [other.id], folder.id);
    expect(nested.find((item) => item.id === other.id)?.folderId).toBeUndefined();
    // Moving out clears folderId.
    const cleared = assignMossLibraryItemsToFolder(assigned, ["doc-2"], null);
    expect(cleared.find((item) => item.id === "doc-2")?.folderId).toBeUndefined();
  });

  it("removes items and files folder children out on folder delete", () => {
    const folder = createMossLibraryFolder("Pets", 1000);
    const doc = ingestMossLibraryItemFromCliFile({
      id: "doc-3",
      title: "a.md",
      sourceCli: "codex",
      updatedAt: 10,
    });
    const assigned = assignMossLibraryItemsToFolder([folder, doc], ["doc-3"], folder.id);
    const withoutFolder = removeMossLibraryItemsById(assigned, [folder.id]);
    expect(withoutFolder.some((item) => item.id === folder.id)).toBe(false);
    expect(withoutFolder.find((item) => item.id === "doc-3")?.folderId).toBeUndefined();
    expect(
      removeMossLibraryItemsById(assigned, ["doc-3"]).some((item) => item.id === "doc-3"),
    ).toBe(false);
  });

  it("partitions the 全部 tab into 文件夹 group and 项目 grid", () => {
    const folder = createMossLibraryFolder("Pets", 1000);
    const loose = ingestMossLibraryItemFromCliFile({
      id: "loose",
      title: "loose.md",
      sourceCli: "codex",
      updatedAt: 10,
    });
    const filed = ingestMossLibraryItemFromCliFile({
      id: "filed",
      title: "filed.md",
      sourceCli: "claude",
      updatedAt: 20,
    });
    const catalog = assignMossLibraryItemsToFolder([folder, loose, filed], ["filed"], folder.id);
    const partition = partitionMossLibraryAllSection(catalog);
    expect(partition.folders.map((item) => item.id)).toEqual([folder.id]);
    expect(partition.projects.map((item) => item.id)).toEqual(["loose"]);
  });

  it("maps server index rows and folders into Codex-shaped cards", () => {
    const card = mossLibraryItemFromServer({
      id: "lib-1",
      title: "exec-1.png",
      kind: "image",
      source: "codex:generated",
      sourceCli: "codex",
      path: "/home/u/.codex/generated_images/thread-1/exec-1.png",
      mimeType: "image/png",
      size: 2048,
      favorite: true,
      folderId: "folder-1",
      trashedAt: null,
      originationThreadId: "thread-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T03:04:05.000Z",
    });
    expect(card.kind).toBe("image");
    expect(card.favorite).toBe(true);
    expect(card.sectionIds).toEqual(["favorites", "images"]);
    expect(card.folderId).toBe("folder-1");
    expect(card.originationThreadId).toBe("thread-1");
    expect(card.updatedAt).toBe(Date.parse("2026-10-02T03:04:05.000Z"));
    expect(card.subtitleZh).toContain("Codex CLI");

    const trashed = mossLibraryItemFromServer({
      id: "lib-2",
      title: "bundle.zip",
      kind: "archive",
      source: "user:import",
      sourceCli: "moss",
      path: "/home/u/.moss/library/bundle.zip",
      mimeType: "application/zip",
      size: 10,
      favorite: false,
      folderId: null,
      trashedAt: "2026-10-03T00:00:00.000Z",
      originationThreadId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(trashed.kind).toBe("archive");
    expect(trashed.trashedAt).toBe(Date.parse("2026-10-03T00:00:00.000Z"));

    const folderCard = mossLibraryFolderItemFromServer({
      id: "folder-1",
      title: "参考图",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(folderCard.kind).toBe("folder");
    expect(folderCard.sectionIds).toEqual(["folders"]);
  });

  it("builds legacy migration payloads and skips folders/demo rows", () => {
    const payload = mossLibraryRegisterPayloadFromLegacy(
      ingestMossLibraryItemFromCliFile({
        id: "cli:codex:lovart/landing.png",
        title: "landing.png",
        sourceCli: "codex",
        kind: "image",
        favorite: true,
        updatedAt: 1_700_000_000_000,
      }),
    );
    expect(payload).toEqual({
      id: "cli:codex:lovart/landing.png",
      title: "landing.png",
      kind: "image",
      sourceCli: "codex",
      favorite: true,
      updatedAt: 1_700_000_000_000,
    });

    const folder = createMossLibraryFolder("Pets", 1000);
    expect(mossLibraryRegisterPayloadFromLegacy(folder)).toBeNull();

    const opencodeDoc = mossLibraryRegisterPayloadFromLegacy(
      ingestMossLibraryItemFromCliFile({
        id: "cli:opencode:notes.md",
        title: "notes.md",
        sourceCli: "opencode",
        updatedAt: 20,
      }),
    );
    expect(opencodeDoc?.sourceCli).toBe("other");
    expect(opencodeDoc?.kind).toBe("document");
  });

  it("guards renames against extension changes", () => {
    expect(mossLibraryRenameKeepsExtension("shot.png", "renamed.png")).toBe(true);
    expect(mossLibraryRenameKeepsExtension("shot.png", "renamed.jpg")).toBe(false);
    expect(mossLibraryRenameKeepsExtension("Pets", "参考")).toBe(true);
  });
});
