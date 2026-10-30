import assert from "node:assert/strict";
import path from "node:path";

import { describe, it } from "vitest";

import {
  buildScannedLibraryItemFields,
  classifyLibraryKind,
  extractLibraryOriginationThreadId,
  inferLibraryMimeType,
  isPathInsideLibraryRoot,
  isSkippableLibraryScanFile,
  libraryItemIdForPath,
  libraryRenamePreservesExtension,
  resolveLibraryImportRoot,
  resolveLibraryScanRoots,
  sanitizeLibraryImportFileName,
  type LibraryScanRootSpec,
} from "./libraryScan.ts";

const homes = {
  codexHome: "/home/u/.codex",
  claudeHome: "/home/u/.claude",
  mossHome: "/home/u/.moss",
};

describe("resolveLibraryScanRoots", () => {
  it("covers every spec §4.1 root with the expected source mapping", () => {
    const roots = resolveLibraryScanRoots(homes);
    assert.deepStrictEqual(
      roots.map((root) => [root.dir, root.source, root.sourceCli]),
      [
        [path.join(homes.codexHome, "attachments"), "codex:attachment", "codex"],
        [path.join(homes.codexHome, "generated_images"), "codex:generated", "codex"],
        [path.join(homes.claudeHome, "downloads"), "claude:downloads", "claude"],
        [path.join(homes.claudeHome, "file-history"), "claude:file-history", "claude"],
        [path.join(homes.mossHome, "library"), "user:import", "moss"],
      ],
    );
  });
});

describe("classifyLibraryKind", () => {
  it("classifies by extension across the Codex-aligned buckets", () => {
    assert.strictEqual(classifyLibraryKind({ path: "a/shot.png" }), "image");
    assert.strictEqual(classifyLibraryKind({ path: "a/clip.mp4" }), "video");
    assert.strictEqual(classifyLibraryKind({ path: "a/bundle.zip" }), "archive");
    assert.strictEqual(classifyLibraryKind({ path: "a/notes.json" }), "document");
    assert.strictEqual(classifyLibraryKind({ path: "a/readme.md" }), "document");
    assert.strictEqual(classifyLibraryKind({ path: "a/blob.bin" }), "other");
  });

  it("prefers MIME when present", () => {
    assert.strictEqual(classifyLibraryKind({ path: "x", mimeType: "image/png" }), "image");
    assert.strictEqual(classifyLibraryKind({ path: "x", mimeType: "video/quicktime" }), "video");
    assert.strictEqual(classifyLibraryKind({ path: "x", mimeType: "application/zip" }), "archive");
    assert.strictEqual(classifyLibraryKind({ path: "x", mimeType: "text/plain" }), "document");
  });
});

describe("scanned item fields", () => {
  const attachmentRoot: LibraryScanRootSpec = resolveLibraryScanRoots(homes)[0]!;

  it("extracts the codex thread uuid as origination thread", () => {
    const filePath = path.join(attachmentRoot.dir, "thread-uuid-1", "image-1.png");
    assert.strictEqual(
      extractLibraryOriginationThreadId(attachmentRoot, filePath),
      "thread-uuid-1",
    );
    const claudeRoot = resolveLibraryScanRoots(homes)[2]!;
    assert.strictEqual(
      extractLibraryOriginationThreadId(claudeRoot, path.join(claudeRoot.dir, "a.png")),
      null,
    );
  });

  it("builds stable ids and basename titles from a scan hit", () => {
    const filePath = path.join(attachmentRoot.dir, "thread-uuid-1", "image-1.png");
    const fields = buildScannedLibraryItemFields({
      root: attachmentRoot,
      path: filePath,
      size: 123,
      mtimeMs: 1_700_000_000_000,
    });
    assert.strictEqual(fields.id, libraryItemIdForPath(filePath));
    assert.strictEqual(fields.title, "image-1.png");
    assert.strictEqual(fields.kind, "image");
    assert.strictEqual(fields.source, "codex:attachment");
    assert.strictEqual(fields.sourceCli, "codex");
    assert.strictEqual(fields.mimeType, "image/png");
    assert.strictEqual(fields.originationThreadId, "thread-uuid-1");
    assert.strictEqual(fields.updatedAt, new Date(1_700_000_000_000).toISOString());
  });
});

describe("import root + safety rules", () => {
  it("resolves the user import area under the moss home", () => {
    assert.strictEqual(
      resolveLibraryImportRoot(homes.mossHome),
      path.join(homes.mossHome, "library"),
    );
  });

  it("only treats descendants of the import root as Moss-owned", () => {
    const root = resolveLibraryImportRoot(homes.mossHome);
    assert.strictEqual(isPathInsideLibraryRoot(path.join(root, "imports", "a.png"), root), true);
    assert.strictEqual(
      isPathInsideLibraryRoot(path.join(homes.codexHome, "attachments", "a.png"), root),
      false,
    );
    assert.strictEqual(
      isPathInsideLibraryRoot(path.join(root, "..", "etc", "passwd"), root),
      false,
    );
  });

  it("skips dotfiles and codex attachment index files", () => {
    assert.strictEqual(isSkippableLibraryScanFile(".DS_Store"), true);
    assert.strictEqual(isSkippableLibraryScanFile("pasted-text-attachments.json"), true);
    assert.strictEqual(isSkippableLibraryScanFile("image-1.png"), false);
  });

  it("blocks rename attempts that change the extension", () => {
    assert.strictEqual(libraryRenamePreservesExtension("shot.png", "renamed.png"), true);
    assert.strictEqual(libraryRenamePreservesExtension("shot.png", "renamed.jpg"), false);
    assert.strictEqual(libraryRenamePreservesExtension("notes.md", "notes"), false);
  });

  it("sanitizes import file names against traversal and dotfiles", () => {
    assert.strictEqual(sanitizeLibraryImportFileName("photo.png"), "photo.png");
    assert.strictEqual(sanitizeLibraryImportFileName("../../etc/passwd"), "passwd");
    assert.strictEqual(sanitizeLibraryImportFileName("a\\b\\clip.mp4"), "clip.mp4");
    assert.strictEqual(sanitizeLibraryImportFileName(".hidden"), null);
    assert.strictEqual(sanitizeLibraryImportFileName("  "), null);
  });
});

describe("inferLibraryMimeType", () => {
  it("maps the common library extensions", () => {
    assert.strictEqual(inferLibraryMimeType("a.PNG"), "image/png");
    assert.strictEqual(inferLibraryMimeType("a.zip"), "application/zip");
    assert.strictEqual(inferLibraryMimeType("a.unknown"), null);
  });
});
