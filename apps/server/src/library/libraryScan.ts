// FILE: libraryScan.ts
// Purpose: Pure scan planning + classification for the Moss 资料库 local index.
//          Maps the Codex cloud-library data model onto local multi-agent roots
//          (codex attachments / generated images, claude downloads / file-history,
//          and the user import area under ~/.moss/library).
// Layer: Server utility (no IO; safe to import from anywhere)
// Exports: scan root specs, kind/source classification, item id + field builders.

import { createHash } from "node:crypto";
import path from "node:path";

import type { LibraryItemKind, LibrarySource, LibrarySourceCli } from "@synara/contracts";

export interface LibraryScanRootSpec {
  readonly id: string;
  readonly source: LibrarySource;
  readonly sourceCli: LibrarySourceCli;
  /** Absolute directory to walk when it exists. */
  readonly dir: string;
  /** 1 = files directly inside; attachments/generated add one thread-uuid level. */
  readonly depth: number;
  /** Parent directory name is the originating thread uuid (codex roots). */
  readonly threadIdFromParentDir: boolean;
}

/** Index files codex keeps next to attachments are not library content. */
const SCAN_SKIP_FILE_NAMES = new Set(["pasted-text-attachments.json"]);

export function isSkippableLibraryScanFile(fileName: string): boolean {
  return fileName.startsWith(".") || SCAN_SKIP_FILE_NAMES.has(fileName);
}

export function resolveLibraryScanRoots(input: {
  readonly codexHome: string;
  readonly claudeHome: string;
  readonly mossHome: string;
}): readonly LibraryScanRootSpec[] {
  return [
    {
      id: "codex-attachments",
      source: "codex:attachment",
      sourceCli: "codex",
      dir: path.join(input.codexHome, "attachments"),
      depth: 2,
      threadIdFromParentDir: true,
    },
    {
      id: "codex-generated-images",
      source: "codex:generated",
      sourceCli: "codex",
      dir: path.join(input.codexHome, "generated_images"),
      depth: 2,
      threadIdFromParentDir: true,
    },
    {
      id: "claude-downloads",
      source: "claude:downloads",
      sourceCli: "claude",
      dir: path.join(input.claudeHome, "downloads"),
      depth: 4,
      threadIdFromParentDir: false,
    },
    {
      id: "claude-file-history",
      source: "claude:file-history",
      sourceCli: "claude",
      dir: path.join(input.claudeHome, "file-history"),
      depth: 4,
      threadIdFromParentDir: false,
    },
    {
      id: "moss-library-imports",
      source: "user:import",
      sourceCli: "moss",
      dir: resolveLibraryImportRoot(input.mossHome),
      depth: 6,
      threadIdFromParentDir: false,
    },
  ];
}

/** User import area — the only root Moss may write/delete files in. */
export function resolveLibraryImportRoot(mossHome: string): string {
  return path.join(mossHome, "library");
}

export function isPathInsideLibraryRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".heic",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".bz2"]);
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".log",
  ".rtf",
]);

export function libraryFileExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function classifyLibraryKind(input: {
  readonly path?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
}): LibraryItemKind {
  const mime = (input.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "archive";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  const ext = libraryFileExtension(input.path ?? "");
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (mime === "application/json") return "document";
  return "other";
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
};

export function inferLibraryMimeType(filePath: string): string | null {
  return MIME_BY_EXTENSION[libraryFileExtension(filePath)] ?? null;
}

/** Attachment/generation roots nest files under a thread-uuid directory. */
export function extractLibraryOriginationThreadId(
  root: Pick<LibraryScanRootSpec, "dir" | "threadIdFromParentDir">,
  filePath: string,
): string | null {
  if (!root.threadIdFromParentDir) return null;
  const parent = path.basename(path.dirname(filePath));
  if (!parent || parent === path.basename(root.dir)) return null;
  return parent;
}

/** Path-stable ids: rescans update the same row instead of duplicating cards. */
export function libraryItemIdForPath(filePath: string): string {
  const digest = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 24);
  return `lib-${digest}`;
}

export interface ScannedLibraryFile {
  readonly root: LibraryScanRootSpec;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Item fields a scan can derive; DB merge keeps user metadata (favorite/folder/title). */
export function buildScannedLibraryItemFields(file: ScannedLibraryFile): {
  readonly id: string;
  readonly title: string;
  readonly kind: LibraryItemKind;
  readonly source: LibrarySource;
  readonly sourceCli: LibrarySourceCli;
  readonly path: string;
  readonly mimeType: string | null;
  readonly size: number;
  readonly originationThreadId: string | null;
  readonly updatedAt: string;
} {
  const mimeType = inferLibraryMimeType(file.path);
  return {
    id: libraryItemIdForPath(file.path),
    title: path.basename(file.path),
    kind: classifyLibraryKind({ path: file.path, mimeType }),
    source: file.root.source,
    sourceCli: file.root.sourceCli,
    path: file.path,
    mimeType,
    size: file.size,
    originationThreadId: extractLibraryOriginationThreadId(file.root, file.path),
    updatedAt: new Date(Math.max(0, file.mtimeMs)).toISOString(),
  };
}

/** Codex rename rule (§2.5): the extension must not change. */
export function libraryRenamePreservesExtension(currentTitle: string, nextTitle: string): boolean {
  return libraryFileExtension(currentTitle) === libraryFileExtension(nextTitle);
}

/** Collision-safe import destination name (no path traversal, no dotfiles). */
export function sanitizeLibraryImportFileName(name: string): string | null {
  const base = path.basename(name.replace(/\\/g, "/")).trim();
  if (!base || base.startsWith(".")) return null;
  return base;
}
