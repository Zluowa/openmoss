// FILE: MossLibrarySurface.logic.ts
// Purpose: Codex-aligned Moss 资料库 sections, multi-CLI ingest, filter/sort, relative time.
// Layer: Web shell destination logic

import type {
  LibraryFolder as ServerLibraryFolder,
  LibraryItem as ServerLibraryItem,
  LibraryItemKind as ServerLibraryItemKind,
  LibraryRegisterItem,
  LibrarySourceCli,
} from "@synara/contracts";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

export type MossLibrarySectionId = "recommended" | "favorites" | "folders" | "images" | "all";

export type MossLibraryViewMode = "grid" | "list";

export type MossLibrarySortId = "recent" | "name" | "kind";

export interface MossLibrarySection {
  readonly id: MossLibrarySectionId;
  readonly labelZh: string;
  readonly labelEn: string;
  /** Empty-state hint — Moss brand only (no OpenAI/Codex product copy). */
  readonly emptyHintZh: string;
  /** Keywords used by local search against section chrome (scaffold stage). */
  readonly searchTokens: readonly string[];
}

export interface MossLibraryNewAction {
  readonly id: "folder" | "import" | "from-chatgpt" | "from-canvas";
  readonly labelZh: string;
  readonly hintZh: string;
}

export interface MossLibrarySortOption {
  readonly id: MossLibrarySortId;
  readonly labelZh: string;
}

/** Codex Library sections: 推荐 / 收藏 / 文件夹 / 图像 / 全部 */
export const MOSS_LIBRARY_SECTIONS: readonly MossLibrarySection[] = [
  {
    id: "recommended",
    labelZh: "推荐",
    labelEn: "Recommended",
    emptyHintZh: "创建新内容。你创建的内容（如图像和文档）将显示在这里。",
    searchTokens: ["推荐", "recommended"],
  },
  {
    id: "favorites",
    labelZh: "收藏",
    labelEn: "Favorites",
    emptyHintZh: "暂无收藏。收藏的资料会显示在这里。",
    searchTokens: ["收藏", "favorites", "starred"],
  },
  {
    id: "folders",
    labelZh: "文件夹",
    labelEn: "Folders",
    emptyHintZh: "创建你的第一个文件夹。创建文件夹以整理资料库中的项目。",
    searchTokens: ["文件夹", "folders", "folder"],
  },
  {
    id: "images",
    labelZh: "图像",
    labelEn: "Images",
    emptyHintZh: "暂无图像。生成或从 Moss Canvas 保存的图像会显示在这里。",
    searchTokens: ["图像", "images", "image", "canvas"],
  },
  {
    id: "all",
    labelZh: "全部",
    labelEn: "All",
    emptyHintZh: "暂无文件。上传文件，开始构建你的资料库。",
    searchTokens: ["全部", "all", "library", "资料库"],
  },
];

/** Masonry placeholder heights (px) approximating Codex empty library scaffold columns. */
export const MOSS_LIBRARY_EMPTY_TILE_HEIGHTS: readonly number[] = [
  168, 236, 188, 264, 176, 220, 200, 248, 160, 212, 184, 240, 172, 228, 196,
];

/** Moss-branded 新建 dropdown actions (Codex has a New chevron). */
export const MOSS_LIBRARY_NEW_ACTIONS: readonly MossLibraryNewAction[] = [
  {
    id: "folder",
    labelZh: "新建文件夹",
    hintZh: "在资料库中整理条目",
  },
  {
    id: "import",
    labelZh: "导入文件",
    hintZh: "复制进 Moss 资料库（任意类型均可）",
  },
  {
    id: "from-chatgpt",
    labelZh: "从 ChatGPT 资料库导入…",
    hintZh: "选择在 chatgpt.com/library 批量下载的文件夹",
  },
  {
    id: "from-canvas",
    labelZh: "从 Moss Canvas 保存",
    hintZh: "把当前画布导出到图像分区",
  },
];

export const MOSS_LIBRARY_SORT_OPTIONS: readonly MossLibrarySortOption[] = [
  { id: "recent", labelZh: "最近更新" },
  { id: "name", labelZh: "名称" },
  { id: "kind", labelZh: "类型" },
];

/**
 * Filesystem convention roots (under Moss user data / home) where multi-CLI
 * outputs are discovered. Renderer may not have FS access — Electron hosts
 * can scan these and feed descriptors into `discoverMossLibraryItemsFromDescriptors`.
 */
export const MOSS_LIBRARY_CLI_SCAN_ROOT_HINTS: readonly string[] = [
  "library/cli-outputs/codex",
  "library/cli-outputs/claude",
  "library/cli-outputs/opencode",
  "library/cli-outputs/grok",
  "library/cli-outputs/moss",
  "library/imports",
];

/** How many recent non-folder items surface under 推荐 when not explicitly tagged. */
export const MOSS_LIBRARY_RECOMMENDED_RECENT_LIMIT = 12;

export function resolveMossLibrarySection(id: string | null | undefined): MossLibrarySection {
  const match = MOSS_LIBRARY_SECTIONS.find((section) => section.id === id);
  return match ?? MOSS_LIBRARY_SECTIONS[0]!;
}

/** Normalize free-text search for Library chrome matching. */
export function normalizeMossLibraryQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * Whether the current section chrome matches the search box.
 * Scaffold stage: no real items yet — still drives empty/search UI honestly.
 */
export function mossLibrarySectionMatchesQuery(
  section: MossLibrarySection,
  query: string,
): boolean {
  const normalized = normalizeMossLibraryQuery(query);
  if (!normalized) return true;
  const haystack = [section.labelZh, section.labelEn, section.emptyHintZh, ...section.searchTokens]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(normalized);
}

export function resolveMossLibrarySort(id: string | null | undefined): MossLibrarySortOption {
  const match = MOSS_LIBRARY_SORT_OPTIONS.find((option) => option.id === id);
  return match ?? MOSS_LIBRARY_SORT_OPTIONS[0]!;
}

/** Heights for the active section; folders use slightly flatter tiles. */
export function mossLibraryEmptyHeightsForSection(
  sectionId: MossLibrarySectionId,
): readonly number[] {
  if (sectionId === "folders") {
    return MOSS_LIBRARY_EMPTY_TILE_HEIGHTS.map((height) =>
      Math.max(120, Math.round(height * 0.72)),
    );
  }
  if (sectionId === "images") {
    return MOSS_LIBRARY_EMPTY_TILE_HEIGHTS.map((height, index) =>
      index % 3 === 0 ? Math.round(height * 1.08) : height,
    );
  }
  return MOSS_LIBRARY_EMPTY_TILE_HEIGHTS;
}

/** CLI / agent sources that can deposit generated files into Moss Library. */
export type MossLibrarySourceCli = "codex" | "claude" | "opencode" | "grok" | "moss" | "other";

/** Card kinds mirroring Codex library item surfaces (doc / image / folder / code). */
export type MossLibraryItemKind =
  | "document"
  | "image"
  | "folder"
  | "code"
  | "video"
  | "archive"
  | "other";

export interface MossLibraryItem {
  readonly id: string;
  readonly title: string;
  readonly kind: MossLibraryItemKind;
  readonly sourceCli: MossLibrarySourceCli;
  /** Absolute or workspace-relative path when known. */
  readonly path?: string;
  readonly mimeType?: string;
  readonly updatedAt: number;
  readonly favorite: boolean;
  /** Explicit section membership; `all` is always implied for non-folder items. */
  readonly sectionIds: readonly MossLibrarySectionId[];
  /** Short subtitle for list/grid cards (CLI + kind). */
  readonly subtitleZh: string;
  /** Optional image/data URL for masonry thumbnail (images). */
  readonly thumbnailUrl?: string;
  /** Parent folder item id — Codex folders group items (添加到文件夹). */
  readonly folderId?: string;
  /** Set when the item sits in the two-stage 回收站 (ms epoch). */
  readonly trashedAt?: number;
  /** File size in bytes when known. */
  readonly size?: number;
  /** Originating agent thread (Codex origination_thread_id equivalent). */
  readonly originationThreadId?: string;
  readonly mediaJobId?: string;
  readonly mediaImageIndex?: number;
  /** True when seeded for empty-store demos — UI must mark clearly. */
  readonly isDemo?: boolean;
}

export interface MossLibraryCliIngestInput {
  readonly title: string;
  readonly sourceCli: MossLibrarySourceCli;
  readonly path?: string;
  readonly mimeType?: string;
  readonly kind?: MossLibraryItemKind;
  readonly favorite?: boolean;
  readonly updatedAt?: number;
  readonly id?: string;
  readonly thumbnailUrl?: string;
  readonly isDemo?: boolean;
  /** Force membership in 推荐 (in addition to recent heuristic). */
  readonly recommended?: boolean;
}

/** Descriptor from a filesystem / workspace scan (Electron or host inject). */
export interface MossLibraryCliFileDescriptor {
  readonly path: string;
  readonly title?: string;
  readonly sourceCli?: MossLibrarySourceCli;
  readonly mimeType?: string;
  readonly kind?: MossLibraryItemKind;
  readonly mtimeMs?: number;
  readonly favorite?: boolean;
  readonly thumbnailUrl?: string;
  readonly isDirectory?: boolean;
}

const IMAGE_MIME_PREFIX = "image/";
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".md",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".sh",
]);
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".7z", ".rar"]);

export function inferMossLibraryItemKind(input: {
  readonly mimeType?: string;
  readonly path?: string;
  readonly kind?: MossLibraryItemKind;
  readonly isDirectory?: boolean;
}): MossLibraryItemKind {
  if (input.kind) return input.kind;
  if (input.isDirectory) return "folder";
  const mime = (input.mimeType ?? "").toLowerCase();
  if (mime.startsWith(IMAGE_MIME_PREFIX)) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "archive";
  if (mime === "inode/directory" || mime === "application/x-directory") return "folder";
  const path = (input.path ?? "").toLowerCase();
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot) : "";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (dot >= 0 && CODE_EXTENSIONS.has(ext)) return "code";
  if (path.endsWith("/") || path.endsWith("\\")) return "folder";
  return "document";
}

export function inferMossLibrarySourceCliFromPath(
  path: string | null | undefined,
): MossLibrarySourceCli {
  const normalized = (path ?? "").replace(/\\/g, "/").toLowerCase();
  if (!normalized) return "other";
  if (
    normalized.includes("/cli-outputs/codex/") ||
    normalized.includes("/.codex/") ||
    normalized.includes("/codex/")
  ) {
    return "codex";
  }
  if (
    normalized.includes("/cli-outputs/claude/") ||
    normalized.includes("/.claude/") ||
    normalized.includes("/claude/")
  ) {
    return "claude";
  }
  if (
    normalized.includes("/cli-outputs/opencode/") ||
    normalized.includes("/.opencode/") ||
    normalized.includes("/opencode/")
  ) {
    return "opencode";
  }
  if (
    normalized.includes("/cli-outputs/grok/") ||
    normalized.includes("/.grok/") ||
    normalized.includes("/grok/")
  ) {
    return "grok";
  }
  if (
    normalized.includes("/cli-outputs/moss/") ||
    normalized.includes("/moss-library/") ||
    normalized.includes("/moss/")
  ) {
    return "moss";
  }
  return "other";
}

export function sourceCliLabelZh(cli: MossLibrarySourceCli): string {
  switch (cli) {
    case "codex":
      return "Codex CLI";
    case "claude":
      return "Claude CLI";
    case "opencode":
      return "OpenCode";
    case "grok":
      return "Grok CLI";
    case "moss":
      return "Moss";
    default:
      return "其他 CLI";
  }
}

function kindLabelZh(kind: MossLibraryItemKind): string {
  switch (kind) {
    case "document":
      return "文档";
    case "image":
      return "图像";
    case "folder":
      return "文件夹";
    case "code":
      return "代码";
    case "video":
      return "视频";
    case "archive":
      return "压缩包";
    default:
      return "文件";
  }
}

function basenameFromPath(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || fallback;
}

/**
 * Ingest a file produced by any supported CLI into a Codex-shaped Library card.
 * Does not invent OpenAI-only providers — sourceCli is the generating CLI/agent.
 */
export function ingestMossLibraryItemFromCliFile(
  input: MossLibraryCliIngestInput,
): MossLibraryItem {
  const kind = inferMossLibraryItemKind(input);
  const sectionIds: MossLibrarySectionId[] = [];
  if (input.favorite) sectionIds.push("favorites");
  if (kind === "folder") sectionIds.push("folders");
  if (kind === "image") sectionIds.push("images");
  if (input.recommended) sectionIds.push("recommended");
  // Prefer path-stable ids so rescans update the same card instead of duplicating.
  const id =
    input.id?.trim() ||
    (input.path?.trim()
      ? `cli:${input.sourceCli}:${input.path.trim()}`
      : `cli:${input.sourceCli}:${input.title}:${input.updatedAt ?? 0}`);
  const path = input.path?.trim() || undefined;
  const mimeType = input.mimeType?.trim() || undefined;
  const thumbnailUrl = input.thumbnailUrl?.trim() || undefined;
  return {
    id,
    title: input.title.trim() || "未命名",
    kind,
    sourceCli: input.sourceCli,
    updatedAt: input.updatedAt ?? Date.now(),
    favorite: Boolean(input.favorite),
    sectionIds,
    subtitleZh: `${sourceCliLabelZh(input.sourceCli)} · ${kindLabelZh(kind)}`,
    isDemo: Boolean(input.isDemo),
    ...(path ? { path } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

/** Map a scanned filesystem descriptor into a Library card. */
export function ingestMossLibraryItemFromDescriptor(
  descriptor: MossLibraryCliFileDescriptor,
): MossLibraryItem {
  const path = descriptor.path;
  const sourceCli = descriptor.sourceCli ?? inferMossLibrarySourceCliFromPath(path);
  const title = (descriptor.title ?? basenameFromPath(path, "未命名")).trim();
  const kind = inferMossLibraryItemKind({
    path,
    ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
    ...(descriptor.kind ? { kind: descriptor.kind } : {}),
    ...(descriptor.isDirectory !== undefined ? { isDirectory: descriptor.isDirectory } : {}),
  });
  return ingestMossLibraryItemFromCliFile({
    title,
    sourceCli,
    path,
    kind,
    updatedAt: descriptor.mtimeMs ?? Date.now(),
    ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
    ...(descriptor.favorite !== undefined ? { favorite: descriptor.favorite } : {}),
    ...(descriptor.thumbnailUrl ? { thumbnailUrl: descriptor.thumbnailUrl } : {}),
  });
}

/** Discover / register Library items from a multi-CLI scan result. */
export function discoverMossLibraryItemsFromDescriptors(
  descriptors: readonly MossLibraryCliFileDescriptor[],
): MossLibraryItem[] {
  const byId = new Map<string, MossLibraryItem>();
  for (const descriptor of descriptors) {
    if (!descriptor.path?.trim()) continue;
    const item = ingestMossLibraryItemFromDescriptor(descriptor);
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Merge catalogs by id (later entries win). */
export function mergeMossLibraryItems(
  ...catalogs: readonly (readonly MossLibraryItem[])[]
): MossLibraryItem[] {
  const byId = new Map<string, MossLibraryItem>();
  for (const catalog of catalogs) {
    for (const item of catalog) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Resolve the catalog shown on open from persisted and discovered artifacts.
 * Demo catalogs remain available as an explicit test fixture, but are never the
 * default runtime fallback.
 */
export function resolveMossLibraryCatalog(input: {
  readonly persisted?: readonly MossLibraryItem[] | null;
  readonly discovered?: readonly MossLibraryItem[] | null;
  readonly seedDemoIfEmpty?: boolean;
  readonly now?: number;
}): {
  readonly items: MossLibraryItem[];
  readonly source: "persisted" | "discovered" | "merged" | "demo" | "empty";
  readonly hasDemo: boolean;
} {
  // A previous Helios build persisted demo rows. Treat those rows as absent so
  // reopening the destination cannot render synthetic artifacts.
  const persisted = (input.persisted ?? []).filter((item) => !item.isDemo);
  const discovered = (input.discovered ?? []).filter((item) => !item.isDemo);
  const merged = mergeMossLibraryItems(persisted, discovered);
  if (merged.length > 0) {
    const source =
      persisted.length > 0 && discovered.length > 0
        ? "merged"
        : persisted.length > 0
          ? "persisted"
          : "discovered";
    return {
      items: merged,
      source,
      hasDemo: merged.some((item) => item.isDemo),
    };
  }
  // Seeding is opt-in for tests and explicit host previews. Production callers
  // omit this flag and therefore stay in the honest empty state.
  if (input.seedDemoIfEmpty === true) {
    const demo = createMossLibraryDemoCatalog(input.now ?? Date.now());
    return { items: demo, source: "demo", hasDemo: true };
  }
  return { items: [], source: "empty", hasDemo: false };
}

/** Codex-like relative time for card footers (Asia/Shanghai-facing zh labels). */
export function formatMossLibraryRelativeTime(updatedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "未知时间";
  const deltaMs = now - updatedAt;
  if (deltaMs < 0) return "刚刚";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 45) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  const year = Math.floor(day / 365);
  return `${Math.max(1, year)} 年前`;
}

export function mossLibraryItemMatchesSection(
  item: MossLibraryItem,
  sectionId: MossLibrarySectionId,
  allItems: readonly MossLibraryItem[] = [],
): boolean {
  if (sectionId === "all") return true;
  if (sectionId === "recommended") {
    // Items filed into a folder leave 推荐 until removed from it (Codex behavior).
    if (item.folderId) return false;
    if (item.sectionIds.includes("recommended")) return true;
    // Recent heuristic: top N non-folder by updatedAt among the full catalog.
    const recentIds = new Set(
      [...allItems]
        .filter((candidate) => candidate.kind !== "folder" && !candidate.folderId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MOSS_LIBRARY_RECOMMENDED_RECENT_LIMIT)
        .map((candidate) => candidate.id),
    );
    return recentIds.has(item.id);
  }
  if (sectionId === "favorites") return item.favorite || item.sectionIds.includes("favorites");
  if (sectionId === "folders") return item.kind === "folder" || item.sectionIds.includes("folders");
  if (sectionId === "images") return item.kind === "image" || item.sectionIds.includes("images");
  return item.sectionIds.includes(sectionId);
}

export function mossLibraryItemMatchesQuery(item: MossLibraryItem, query: string): boolean {
  const normalized = normalizeMossLibraryQuery(query);
  if (!normalized) return true;
  const haystack = [
    item.title,
    item.subtitleZh,
    item.path ?? "",
    item.mimeType ?? "",
    item.sourceCli,
    item.kind,
    sourceCliLabelZh(item.sourceCli),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(normalized);
}

export function filterMossLibraryItems(
  items: readonly MossLibraryItem[],
  options: {
    readonly sectionId: MossLibrarySectionId;
    readonly query?: string;
    readonly sortId?: MossLibrarySortId;
  },
): MossLibraryItem[] {
  const filtered = items.filter(
    (item) =>
      mossLibraryItemMatchesSection(item, options.sectionId, items) &&
      mossLibraryItemMatchesQuery(item, options.query ?? ""),
  );
  const sortId = options.sortId ?? "recent";
  const sorted = [...filtered];
  sorted.sort((a, b) => {
    if (sortId === "name") return a.title.localeCompare(b.title, "zh");
    if (sortId === "kind") {
      const kindCmp = a.kind.localeCompare(b.kind);
      return kindCmp !== 0 ? kindCmp : b.updatedAt - a.updatedAt;
    }
    return b.updatedAt - a.updatedAt;
  });
  return sorted;
}

/** Tiny inline PNG (1×1) data URL — used only as demo image thumbnail placeholder. */
const DEMO_THUMB_PNG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#3d4a5c"/><stop offset="100%" stop-color="#1e2530"/>
      </linearGradient></defs>
      <rect width="320" height="200" rx="16" fill="url(#g)"/>
      <text x="24" y="108" fill="#c7d0dc" font-family="system-ui,sans-serif" font-size="18">CLI · image</text>
    </svg>`,
  );

/**
 * Clearly-marked demo catalog when no persisted/discovered files exist.
 * Helios wants real store not forever-empty — demo is only the empty fallback.
 */
export function createMossLibraryDemoCatalog(now: number = Date.now()): MossLibraryItem[] {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  return [
    ingestMossLibraryItemFromCliFile({
      id: "demo:codex:research-notes.md",
      title: "research-notes.md",
      sourceCli: "codex",
      path: "library/cli-outputs/codex/research-notes.md",
      mimeType: "text/markdown",
      updatedAt: now - 12 * minute,
      recommended: true,
      isDemo: true,
    }),
    ingestMossLibraryItemFromCliFile({
      id: "demo:claude:dashboard.png",
      title: "dashboard.png",
      sourceCli: "claude",
      path: "library/cli-outputs/claude/dashboard.png",
      mimeType: "image/png",
      favorite: true,
      recommended: true,
      updatedAt: now - 2 * hour,
      thumbnailUrl: DEMO_THUMB_PNG,
      isDemo: true,
    }),
    ingestMossLibraryItemFromCliFile({
      id: "demo:opencode:agent-harness",
      title: "agent-harness",
      sourceCli: "opencode",
      path: "library/cli-outputs/opencode/agent-harness/",
      kind: "folder",
      updatedAt: now - 1 * day,
      isDemo: true,
    }),
    ingestMossLibraryItemFromCliFile({
      id: "demo:grok:grok-summary.txt",
      title: "grok-summary.txt",
      sourceCli: "grok",
      path: "library/cli-outputs/grok/grok-summary.txt",
      mimeType: "text/plain",
      updatedAt: now - 3 * day,
      recommended: true,
      isDemo: true,
    }),
    ingestMossLibraryItemFromCliFile({
      id: "demo:moss:canvas-export.png",
      title: "canvas-export.png",
      sourceCli: "moss",
      path: "library/cli-outputs/moss/canvas-export.png",
      mimeType: "image/png",
      updatedAt: now - 6 * hour,
      thumbnailUrl: DEMO_THUMB_PNG,
      isDemo: true,
    }),
  ];
}

/** @deprecated Prefer createMossLibraryDemoCatalog — kept for existing call sites/tests. */
export function createMossLibraryStubCatalog(now?: number): MossLibraryItem[] {
  return createMossLibraryDemoCatalog(now);
}

// ---------------------------------------------------------------------------
// Codex interaction parity: multi-select, context menu, folders, rename, etc.
// ---------------------------------------------------------------------------

/** Context-menu entries (Codex 右键菜单, image ref 8). */
export type MossLibraryContextActionId =
  | "chat"
  | "favorite"
  | "download"
  | "share"
  | "rename"
  | "add-to-folder"
  | "delete";

export interface MossLibraryContextMenuEntry {
  readonly id: MossLibraryContextActionId;
  readonly labelZh: string;
  /** Codex renders 删除 in red. */
  readonly danger?: boolean;
}

/** Build the Codex context menu for a card; favorite label flips with state. */
export function buildMossLibraryContextMenu(
  item: Pick<MossLibraryItem, "favorite" | "kind">,
): readonly MossLibraryContextMenuEntry[] {
  return [
    { id: "chat", labelZh: "围绕此内容展开对话" },
    { id: "favorite", labelZh: item.favorite ? "从收藏夹移除" : "添加到收藏夹" },
    { id: "download", labelZh: "下载" },
    { id: "share", labelZh: "分享" },
    { id: "rename", labelZh: "重命名" },
    { id: "add-to-folder", labelZh: "添加到文件夹" },
    { id: "delete", labelZh: "删除", danger: true },
  ];
}

/** Toggle an id inside a multi-select set (immutable). */
export function toggleMossLibrarySelectedId(
  selected: readonly string[],
  id: string,
): readonly string[] {
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
}

/** Create a new folder card (新建 → 新建文件夹). */
export function createMossLibraryFolder(title: string, now: number = Date.now()): MossLibraryItem {
  const trimmed = title.trim() || "未命名文件夹";
  return {
    id: `folder:${now}:${trimmed}`,
    title: trimmed,
    kind: "folder",
    sourceCli: "moss",
    updatedAt: now,
    favorite: false,
    sectionIds: ["folders"],
    subtitleZh: "Moss · 文件夹",
  };
}

/** Rename a card in place (immutable catalog update). */
export function renameMossLibraryItem(
  items: readonly MossLibraryItem[],
  id: string,
  title: string,
  now: number = Date.now(),
): MossLibraryItem[] {
  const trimmed = title.trim();
  if (!trimmed) return [...items];
  return items.map((item) => (item.id === id ? { ...item, title: trimmed, updatedAt: now } : item));
}

/** Toggle 收藏 for the given ids; returns the updated catalog. */
export function setMossLibraryItemsFavorite(
  items: readonly MossLibraryItem[],
  ids: readonly string[],
  favorite: boolean,
): MossLibraryItem[] {
  const idSet = new Set(ids);
  return items.map((item) => {
    if (!idSet.has(item.id)) return item;
    const sectionIds = favorite
      ? item.sectionIds.includes("favorites")
        ? item.sectionIds
        : [...item.sectionIds, "favorites" as const]
      : item.sectionIds.filter((section) => section !== "favorites");
    return { ...item, favorite, sectionIds };
  });
}

/** Whether every targeted item is already favorited (drives menu label). */
export function mossLibraryItemsAllFavorite(
  items: readonly MossLibraryItem[],
  ids: readonly string[],
): boolean {
  const idSet = new Set(ids);
  const targets = items.filter((item) => idSet.has(item.id));
  return targets.length > 0 && targets.every((item) => item.favorite);
}

/** Assign items to a folder (添加到文件夹); `folderId: null` moves them out. */
export function assignMossLibraryItemsToFolder(
  items: readonly MossLibraryItem[],
  ids: readonly string[],
  folderId: string | null,
): MossLibraryItem[] {
  const idSet = new Set(ids);
  return items.map((item) => {
    if (!idSet.has(item.id) || item.kind === "folder") return item;
    if (folderId === null) {
      const { folderId: _removed, ...rest } = item;
      return rest;
    }
    return { ...item, folderId };
  });
}

/** Remove items (删除). Folders are removed with their children filed out. */
export function removeMossLibraryItemsById(
  items: readonly MossLibraryItem[],
  ids: readonly string[],
): MossLibraryItem[] {
  const idSet = new Set(ids);
  const removedFolderIds = new Set(
    items.filter((item) => idSet.has(item.id) && item.kind === "folder").map((item) => item.id),
  );
  return items
    .filter((item) => !idSet.has(item.id))
    .map((item) =>
      item.folderId && removedFolderIds.has(item.folderId)
        ? (() => {
            const { folderId: _removed, ...rest } = item;
            return rest;
          })()
        : item,
    );
}

/** Items filed inside a folder (drill-down view). */
export function mossLibraryFolderChildren(
  items: readonly MossLibraryItem[],
  folderId: string,
): MossLibraryItem[] {
  return items
    .filter((item) => item.folderId === folderId)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Codex 全部 tab grouping (image ref 10): 文件夹 cards on top, 项目 grid below.
 * Items filed inside a folder stay out of the top-level 项目 grid.
 */
export function partitionMossLibraryAllSection(items: readonly MossLibraryItem[]): {
  readonly folders: MossLibraryItem[];
  readonly projects: MossLibraryItem[];
} {
  const folders = items
    .filter((item) => item.kind === "folder")
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const projects = items
    .filter((item) => item.kind !== "folder" && !item.folderId)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  return { folders, projects };
}

/** Selection-bar action ids (Codex 底部选择栏, image ref 7). */
export type MossLibrarySelectionActionId = "chat" | "download" | "delete" | "more" | "dismiss";

export function mossLibrarySelectionSummaryZh(count: number): string {
  return `已选择 ${count} 个`;
}

// ---------------------------------------------------------------------------
// Server index mapping (Moss 资料库 local index ↔ Codex-shaped cards)
// ---------------------------------------------------------------------------

const SERVER_KIND_TO_VIEW: Record<ServerLibraryItemKind, MossLibraryItemKind> = {
  image: "image",
  video: "video",
  archive: "archive",
  document: "document",
  other: "other",
};

/** Map a server index row into the Codex-shaped card model. */
export function mossLibraryItemFromServer(item: ServerLibraryItem): MossLibraryItem {
  const kind = SERVER_KIND_TO_VIEW[item.kind] ?? "other";
  const sectionIds: MossLibrarySectionId[] = [];
  if (item.favorite) sectionIds.push("favorites");
  if (kind === "image") sectionIds.push("images");
  return {
    id: item.id,
    title: item.title,
    kind,
    sourceCli: item.sourceCli,
    updatedAt: Date.parse(item.updatedAt) || 0,
    favorite: item.favorite,
    sectionIds,
    subtitleZh: `${sourceCliLabelZh(item.sourceCli)} · ${kindLabelZh(kind)}`,
    ...(item.previewPath &&
    /^\/api\/moss\/media\/assets\/moss_[A-Za-z0-9_-]+\/\d+$/u.test(item.previewPath)
      ? { thumbnailUrl: resolveWsHttpUrl(item.previewPath) }
      : {}),
    ...(item.mediaJobId ? { mediaJobId: item.mediaJobId } : {}),
    ...(item.mediaImageIndex !== undefined ? { mediaImageIndex: item.mediaImageIndex } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    ...(item.folderId ? { folderId: item.folderId } : {}),
    ...(item.trashedAt ? { trashedAt: Date.parse(item.trashedAt) || 0 } : {}),
    ...(item.size ? { size: item.size } : {}),
    ...(item.originationThreadId ? { originationThreadId: item.originationThreadId } : {}),
  };
}

/** Server folders arrive in their own table; the surface renders them as cards. */
export function mossLibraryFolderItemFromServer(folder: ServerLibraryFolder): MossLibraryItem {
  return {
    id: folder.id,
    title: folder.title,
    kind: "folder",
    sourceCli: "moss",
    updatedAt: Date.parse(folder.updatedAt) || 0,
    favorite: false,
    sectionIds: ["folders"],
    subtitleZh: "Moss · 文件夹",
  };
}

/** Client-generated id for a folder row the server will persist. */
export function newMossLibraryFolderId(): string {
  return `folder-${crypto.randomUUID()}`;
}

const LEGACY_SOURCE_CLI_TO_SERVER: Record<MossLibrarySourceCli, LibrarySourceCli> = {
  codex: "codex",
  claude: "claude",
  moss: "moss",
  opencode: "other",
  grok: "other",
  other: "other",
};

const LEGACY_KIND_TO_SERVER: Partial<Record<MossLibraryItemKind, ServerLibraryItemKind>> = {
  image: "image",
  video: "video",
  archive: "archive",
  document: "document",
  code: "document",
  other: "other",
};

/**
 * One-time migration payload for a legacy localStorage row (the pre-index
 * catalog — e.g. Lovart cloud items with no local file). Folders were
 * local-only fiction and are not migrated.
 */
export function mossLibraryRegisterPayloadFromLegacy(
  item: MossLibraryItem,
): LibraryRegisterItem | null {
  if (item.kind === "folder" || item.isDemo) return null;
  return {
    id: item.id,
    title: item.title,
    kind: LEGACY_KIND_TO_SERVER[item.kind] ?? "other",
    sourceCli: LEGACY_SOURCE_CLI_TO_SERVER[item.sourceCli],
    favorite: item.favorite,
    updatedAt: item.updatedAt,
    ...(item.folderId ? { folderId: item.folderId } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
  };
}

/** Codex 重命名 rule: the extension must not change (folder cards have none). */
export function mossLibraryRenameKeepsExtension(currentTitle: string, nextTitle: string): boolean {
  const extensionOf = (title: string) => {
    const dot = title.lastIndexOf(".");
    return dot > 0 ? title.slice(dot).toLowerCase() : "";
  };
  return extensionOf(currentTitle) === extensionOf(nextTitle);
}

/** Codex 回收站 subtitle (§2.6). */
export const MOSS_LIBRARY_TRASH_SUBTITLE_ZH = "恢复最近删除的文件。这些文件将在 30 天后永久删除。";

/** Codex 删除 confirmation copy (§2.5). */
export function mossLibraryTrashConfirmZh(title: string): string {
  return `“${title}”将移至回收站，并在 30 天后永久删除。`;
}

/** Codex 永久删除 confirmation copy (§2.6). */
export const MOSS_LIBRARY_DELETE_FOREVER_CONFIRM_ZH = "此操作无法撤消。";

/** Codex 拖拽导入 prompt (§2.3). */
export const MOSS_LIBRARY_DROP_PROMPT_ZH = "将任意文件拖放到此处，即可添加到你的资料库";
