import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";

import { resolveCodexHomeOverlayAccountSegment } from "./codexHomePaths.ts";
import {
  createLocalPreviewGrant,
  declarePluginArtworkPaths,
  resolveAllowedLocalPreviewFile,
} from "./localImageFiles.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function makeNonTempDir(prefix: string): string {
  const directory = path.join(
    os.homedir(),
    `.${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveAllowedLocalPreviewFile", () => {
  it("allows images inside the current workspace", async () => {
    const workspace = makeTempDir("moss-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "preview.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(imagePath));
    assert.equal(result?.fileName, "preview.png");
  });

  it("allows images inside Codex generated_images without a cwd", async () => {
    const codexHome = makeTempDir("moss-codex-home-");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const imageDir = path.join(codexHome, "generated_images", "provider-thread");
      const imagePath = path.join(imageDir, "call.png");
      mkdirSync(imageDir, { recursive: true });
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it.each([
    ["installed plugin cache", ["plugins", "cache", "openai-curated", "github", "1.0.0"]],
    [
      "temporary bundled marketplace",
      [".tmp", "bundled-marketplaces", "openai-curated", "plugins", "github"],
    ],
    ["temporary plugin catalog", [".tmp", "plugins", "plugins", "github"]],
  ])("allows artwork inside the active Codex %s", async (_label, segments) => {
    const codexHome = makeNonTempDir("moss-codex-plugin-artwork-");
    const artworkDir = path.join(codexHome, ...segments, "assets");
    const artworkPath = path.join(artworkDir, "logo.png");
    mkdirSync(artworkDir, { recursive: true });
    writeFileSync(artworkPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: artworkPath,
      cwd: null,
      codexHomePaths: [codexHome],
    });

    assert.equal(result?.path, realpathSync(artworkPath));
  });

  it("allows canonical plugin artwork paths for a logical Codex home alias", async () => {
    const canonicalHome = makeNonTempDir("moss-codex-plugin-canonical-home-");
    const logicalHome = path.join(
      path.dirname(canonicalHome),
      `${path.basename(canonicalHome)}-logical`,
    );
    symlinkSync(canonicalHome, logicalHome, process.platform === "win32" ? "junction" : "dir");
    tempDirs.push(logicalHome);

    const artworkPath = path.join(
      canonicalHome,
      "plugins",
      "cache",
      "openai-curated",
      "github",
      "1.0.0",
      "assets",
      "app-icon.png",
    );
    mkdirSync(path.dirname(artworkPath), { recursive: true });
    writeFileSync(artworkPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: realpathSync(artworkPath),
      cwd: null,
      codexHomePaths: [logicalHome],
    });

    assert.equal(result?.path, realpathSync(artworkPath));
  });

  it("rejects plugin artwork from a Codex home outside the active account allowlist", async () => {
    const activeHome = makeNonTempDir("moss-codex-plugin-active-");
    // A disposable account home commonly lives under the OS temp root. The
    // generic temp-image fallback must not punch through the instance allowlist.
    const siblingHome = makeTempDir("moss-codex-plugin-sibling-");
    const artworkDir = path.join(
      siblingHome,
      "plugins",
      "cache",
      "personal",
      "private-plugin",
      "1.0.0",
      "assets",
    );
    const artworkPath = path.join(artworkDir, "logo.svg");
    mkdirSync(artworkDir, { recursive: true });
    writeFileSync(artworkPath, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: artworkPath,
      cwd: null,
      codexHomePaths: [activeHome],
    });

    assert.equal(result, null);
  });

  it("serves artwork a plugin listing declared, and nothing else beside it", async () => {
    // A user-added folder marketplace keeps its logo outside every Codex home.
    const marketplace = makeNonTempDir("moss-folder-marketplace-");
    const assets = path.join(marketplace, "plugins", "hoola", "assets");
    mkdirSync(assets, { recursive: true });
    const logo = path.join(assets, "icon.svg");
    const sibling = path.join(assets, "other.png");
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
    writeFileSync(sibling, "png", "utf8");
    const resolve = (requestedPath: string) =>
      resolveAllowedLocalPreviewFile({ requestedPath, cwd: null, codexHomePaths: [] });

    assert.equal(await resolve(logo), null);
    declarePluginArtworkPaths([logo, path.join(assets, "notes.txt"), null]);

    assert.equal((await resolve(logo))?.path, realpathSync(logo));
    assert.equal(await resolve(sibling), null);
  });

  it("rejects a plugin-cache symlink that escapes the active Codex home", async () => {
    const codexHome = makeNonTempDir("moss-codex-plugin-symlink-home-");
    const outside = makeNonTempDir("moss-codex-plugin-symlink-outside-");
    const pluginDir = path.join(codexHome, "plugins", "cache", "personal", "escaped", "1.0.0");
    const assetsLink = path.join(pluginDir, "assets");
    const outsideArtwork = path.join(outside, "logo.png");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(outsideArtwork, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    symlinkSync(outside, assetsLink, process.platform === "win32" ? "junction" : "dir");

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: path.join(assetsLink, "logo.png"),
      cwd: null,
      codexHomePaths: [codexHome],
    });

    assert.equal(result, null);
  });

  it("does not fall back to ambient Codex homes when the allowlist is intentionally empty", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-empty-allowlist-${process.pid}-${Date.now()}`,
    );
    const codexHome = path.join(fakeRoot, ".codex-disabled");
    const imageDir = path.join(codexHome, "generated_images", "provider-thread");
    const imagePath = path.join(imageDir, "call.png");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePaths: [],
      });

      assert.equal(result, null);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("does not let temp fallback bypass an empty allowlist through a generated_images symlink", async () => {
    const tempRoot = makeTempDir("moss-codex-symlinked-generated-images-");
    const targetDir = path.join(tempRoot, "target");
    const generatedImagesDir = path.join(tempRoot, "account", "generated_images");
    const logicalImagePath = path.join(generatedImagesDir, "secret.png");
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(path.dirname(generatedImagesDir), { recursive: true });
    writeFileSync(path.join(targetDir, "secret.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    symlinkSync(targetDir, generatedImagesDir, process.platform === "win32" ? "junction" : "dir");

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: logicalImagePath,
      cwd: null,
      codexHomePaths: [],
    });

    assert.equal(result, null);
  });

  it("allows images written to the MOSS_HOME codex-home-overlay generated_images root", async () => {
    // Codex app-server is launched with CODEX_HOME pointing at a Moss overlay
    // directory (see resolveMossCodexHomeOverlayPath). Generated images therefore
    // live under <MOSS_HOME>/codex-home-overlay/generated_images/<thread>/<call>.png,
    // which sits outside both the user's `~/.codex` source home and any workspace
    // root. The allowlist must still serve them.
    //
    // We anchor the fake homes inside the worktree (process.cwd() resolves to
    // apps/server/ when vitest runs) so neither path falls under os.tmpdir(); that
    // way only the overlay candidate can satisfy the allowlist.
    const fakeRoot = path.join(process.cwd(), `.test-codex-overlay-${process.pid}-${Date.now()}`);
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const mossHome = path.join(fakeRoot, "moss", "runtime");
    const overlayImageDir = path.join(
      mossHome,
      "codex-home-overlay",
      "generated_images",
      "thread-overlay",
    );
    const imagePath = path.join(overlayImageDir, "call.png");
    mkdirSync(overlayImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousCodexHome = process.env.CODEX_HOME;
    const previousMossHome = process.env.MOSS_HOME;
    process.env.CODEX_HOME = sourceHome;
    process.env.MOSS_HOME = mossHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousMossHome === undefined) {
        delete process.env.MOSS_HOME;
      } else {
        process.env.MOSS_HOME = previousMossHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated images from sibling Codex account overlays", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-account-overlay-${process.pid}-${Date.now()}`,
    );
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const mossHome = path.join(fakeRoot, "moss", "runtime");
    const siblingImageDir = path.join(
      mossHome,
      "codex-home-overlay",
      "accounts",
      "work-account",
      "generated_images",
      "thread-work",
    );
    const imagePath = path.join(siblingImageDir, "call.png");
    mkdirSync(siblingImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousMossHome = process.env.MOSS_HOME;
    process.env.MOSS_HOME = mossHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result, null);
    } finally {
      if (previousMossHome === undefined) {
        delete process.env.MOSS_HOME;
      } else {
        process.env.MOSS_HOME = previousMossHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows generated images from the configured Codex account overlay after direct-home toggles", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-configured-account-overlay-${process.pid}-${Date.now()}`,
    );
    const sourceHome = path.join(fakeRoot, "source", ".codex-work");
    const shadowHome = path.join(fakeRoot, "shadow", ".codex-work-auth");
    const mossHome = path.join(fakeRoot, "moss", "runtime");
    const accountSegment = resolveCodexHomeOverlayAccountSegment({
      homePath: sourceHome,
      shadowHomePath: shadowHome,
      accountId: "work",
    });
    assert.ok(accountSegment, "expected an account overlay segment");
    const imageDir = path.join(
      mossHome,
      "codex-home-overlay",
      "accounts",
      accountSegment,
      "generated_images",
      "thread-work",
    );
    const imagePath = path.join(imageDir, "call.png");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousMossHome = process.env.MOSS_HOME;
    process.env.MOSS_HOME = mossHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePaths: [
          {
            homePath: sourceHome,
            shadowHomePath: shadowHome,
            accountId: "work",
            environment: {},
          },
        ],
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousMossHome === undefined) {
        delete process.env.MOSS_HOME;
      } else {
        process.env.MOSS_HOME = previousMossHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside dot-prefixed workspace directories", async () => {
    const workspace = makeTempDir("moss-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "..assets", "spec.pdf");
    mkdirSync(path.dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "spec.pdf");
    assert.equal(result?.sizeBytes, 8);
  });

  it("allows archive downloads inside the current workspace", async () => {
    const workspace = makeTempDir("moss-archive-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const archivePath = path.join(workspace, "exports", "snapshot.zip");
    mkdirSync(path.dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: archivePath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(archivePath));
    assert.equal(result?.fileName, "snapshot.zip");
    assert.equal(result?.sizeBytes, 4);
  });

  it("allows a granted markdown file from the opened project", async () => {
    const workspace = makeTempDir("moss-markdown-workspace-");
    const markdownPath = path.join(workspace, "sample.md");
    writeFileSync(markdownPath, "# Fixture\n", "utf8");
    const grant = await createLocalPreviewGrant({ requestedPath: markdownPath });

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: markdownPath,
      cwd: "/",
      allowAbsoluteLocalPreviewFile: true,
      previewGrant: grant.grant,
    });

    assert.equal(result?.path, realpathSync(markdownPath));
  });

  it("accepts a file URL when Electron preserves the local path as a URI", async () => {
    const workspace = makeTempDir("moss-file-url-preview-");
    const filePath = path.join(workspace, "sample.mp3");
    writeFileSync(filePath, Buffer.from([0x49, 0x44, 0x33]));

    const grant = await createLocalPreviewGrant({ requestedPath: pathToFileURL(filePath).href });
    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pathToFileURL(filePath).href,
      cwd: workspace,
      previewGrant: grant.grant,
    });

    assert.equal(result?.path, realpathSync(filePath));
  });

  it("normalizes escaped paths identically for grants and preview reads without widening grants", async () => {
    const workspace = makeTempDir("moss-preview-uri-workspace-");
    const outside = makeTempDir("moss-preview-uri-outside-");
    const filePath = path.join(outside, "report with spaces.pdf");
    const otherPath = path.join(outside, "other.pdf");
    writeFileSync(filePath, "%PDF-granted");
    writeFileSync(otherPath, "%PDF-ungranted");
    const encodedPath = filePath.replaceAll(" ", "%20");
    const grant = await createLocalPreviewGrant({ requestedPath: encodedPath });
    for (const requestedPath of [filePath, encodedPath, pathToFileURL(filePath).href]) {
      const resolved = await resolveAllowedLocalPreviewFile({
        requestedPath,
        cwd: workspace,
        allowAbsoluteLocalPreviewFile: true,
        previewGrant: grant.grant,
      });
      assert.equal(resolved?.path, realpathSync(filePath));
    }
    assert.equal(
      await resolveAllowedLocalPreviewFile({
        requestedPath: otherPath,
        cwd: workspace,
        allowAbsoluteLocalPreviewFile: true,
        previewGrant: grant.grant,
      }),
      null,
    );
    assert.equal(
      await resolveAllowedLocalPreviewFile({
        requestedPath: encodedPath,
        cwd: workspace,
        allowAbsoluteLocalPreviewFile: true,
      }),
      null,
    );
  });

  it("prefers a literal percent filename and only decodes a file URL once", async () => {
    const workspace = makeTempDir("moss-preview-percent-");
    const literalPath = path.join(workspace, "report%20name.pdf");
    const spacePath = path.join(workspace, "report name.pdf");
    writeFileSync(literalPath, "%PDF-literal");
    writeFileSync(spacePath, "%PDF-decoded");
    for (const requestedPath of [literalPath, pathToFileURL(literalPath).href]) {
      const resolved = await resolveAllowedLocalPreviewFile({ requestedPath, cwd: workspace });
      assert.equal(resolved?.path, realpathSync(literalPath));
    }
  });

  it("allows PDFs inside a per-thread scratch workspace without a cwd", async () => {
    // Sessions that start before a project workspace exists run in
    // <tmpdir>/moss-codex-workspaces/<threadId>; files agents create there
    // are workspace-equivalent, so documents must be servable from that root.
    const scratchRoot = path.join(os.tmpdir(), "moss-codex-workspaces");
    const threadDir = path.join(scratchRoot, `test-thread-${process.pid}-${Date.now()}`);
    const pdfPath = path.join(threadDir, "viewer-test.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: pdfPath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(pdfPath));
      assert.equal(result?.fileName, "viewer-test.pdf");
      assert.equal(result?.sizeBytes, 8);
    } finally {
      // Remove only the per-thread dir — the shared scratch root may belong
      // to a live server.
      rmSync(threadDir, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside the configured private scratch root without a cwd", async () => {
    const privateTempRoot = makeTempDir("moss-private-scratch-");
    const scratchRoot = path.join(privateTempRoot, "moss-codex-workspaces");
    const threadDir = path.join(scratchRoot, "private-thread");
    const pdfPath = path.join(threadDir, "private-scratch.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
      scratchWorkspacesRoot: scratchRoot,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "private-scratch.pdf");
  });

  it("rejects PDFs outside the workspace even under the temp-dir image roots", async () => {
    // Temp/generated-image roots exist for agent-produced images in chat
    // markdown; documents must only ever be served from the workspace.
    const tempDir = makeTempDir("moss-pdf-outside-");
    const pdfPath = path.join(tempDir, "leak.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
    });

    assert.equal(result, null);
  });

  it("still allows images under the temp-dir roots without a workspace", async () => {
    const tempDir = makeTempDir("moss-image-tmp-root-");
    const imagePath = path.join(tempDir, "clip.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
    });

    assert.equal(result?.path, realpathSync(imagePath));
  });

  it("rejects unsupported paths", async () => {
    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: "/etc/hosts",
      cwd: null,
    });

    assert.equal(result, null);
  });
});
