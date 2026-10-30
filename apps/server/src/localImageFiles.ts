// FILE: localImageFiles.ts
// Purpose: Resolves local preview/download-file requests without exposing arbitrary files.
// Layer: Server HTTP utility
// Exports: local image route constants and allowlisted path resolver
// Depends on: fs realpath/stat, Codex generated image roots, safe preview extensions

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_IMAGE_ROUTE_PATH,
  isSupportedLocalImagePath,
  isSupportedLocalPreviewFilePath,
} from "@synara/shared/localPreviewFiles";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";

import {
  type CodexGeneratedImageHomeCandidate,
  resolveCodexGeneratedImagesRoots,
  resolveCodexHomeRoots,
} from "./codexGeneratedImages.ts";

export { LOCAL_IMAGE_ROUTE_PATH };

export interface ResolvedLocalPreviewFile {
  readonly path: string;
  readonly fileName: string;
  /** From the allowlist stat, so responses can set Content-Length without re-statting. */
  readonly sizeBytes: number;
}

export interface LocalPreviewGrantResult {
  readonly grant: string;
  readonly expiresAt: string;
}

const LOCAL_PREVIEW_GRANT_TTL_MS = 2 * 60 * 1000;
const localPreviewGrantByToken = new Map<string, { realFilePath: string; expiresAtMs: number }>();

function pruneExpiredPreviewGrants(nowMs = Date.now()): void {
  for (const [token, grant] of localPreviewGrantByToken) {
    if (grant.expiresAtMs <= nowMs) {
      localPreviewGrantByToken.delete(token);
    }
  }
}

function hasValidPreviewGrant(input: {
  readonly token: string | null | undefined;
  readonly realFilePath: string;
}): boolean {
  return resolveLocalPreviewGrantRealPath({ token: input.token }) === input.realFilePath;
}

export function resolveLocalPreviewGrantRealPath(input: {
  readonly token: string | null | undefined;
}): string | null {
  const token = input.token?.trim();
  if (!token) {
    return null;
  }
  const nowMs = Date.now();
  pruneExpiredPreviewGrants(nowMs);
  const grant = localPreviewGrantByToken.get(token);
  return grant !== undefined && grant.expiresAtMs > nowMs ? grant.realFilePath : null;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isInsideGeneratedImagesDirectory(candidate: string): boolean {
  let current = path.dirname(candidate);
  while (true) {
    if (path.basename(current) === "generated_images") {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

// Plugin manifests may point their artwork anywhere a marketplace lives: a
// folder the user added, Codex's runtime cache. Beyond the Codex-home plugin
// trees below, serve exactly the image files Codex reported as plugin artwork
// in a plugin listing — never their directories, never a symlinked target.
const MAX_DECLARED_PLUGIN_ARTWORK = 4096;
const declaredPluginArtwork = new Set<string>();

function pluginArtworkKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Records artwork paths from a plugin listing so the preview route may serve them. */
export function declarePluginArtworkPaths(paths: Iterable<string | null | undefined>): void {
  for (const candidate of paths) {
    if (!candidate || !path.isAbsolute(candidate) || !isSupportedLocalImagePath(candidate)) {
      continue;
    }
    const key = pluginArtworkKey(candidate);
    declaredPluginArtwork.delete(key);
    declaredPluginArtwork.add(key);
    if (declaredPluginArtwork.size > MAX_DECLARED_PLUGIN_ARTWORK) {
      const oldest = declaredPluginArtwork.values().next().value;
      if (oldest !== undefined) declaredPluginArtwork.delete(oldest);
    }
  }
}

function isDeclaredPluginArtwork(requestedPath: string, realFilePath: string): boolean {
  const key = pluginArtworkKey(requestedPath);
  return declaredPluginArtwork.has(key) && pluginArtworkKey(realFilePath) === key;
}

const CODEX_PLUGIN_IMAGE_SUBROOTS = [
  ["plugins", "cache"],
  [".tmp", "plugins", "plugins"],
  [".tmp", "bundled-marketplaces"],
] as const;

function isInsideCodexPluginImageDirectory(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  return (
    /(?:^|\/)plugins\/cache(?:\/|$)/.test(normalized) ||
    /(?:^|\/)\.tmp\/plugins\/plugins(?:\/|$)/.test(normalized) ||
    /(?:^|\/)\.tmp\/bundled-marketplaces(?:\/|$)/.test(normalized)
  );
}

async function realpathOrNull(candidate: string | undefined): Promise<string | null> {
  if (!candidate) {
    return null;
  }
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

/** Preserve literal percent characters; URI decoding is a missing-file fallback. */
export function localPreviewPathCandidates(value: string): readonly string[] {
  const requestedPath = value.trim();
  if (!requestedPath || requestedPath.includes("\0")) return [];
  if (/^file:/iu.test(requestedPath)) {
    try {
      // fileURLToPath already decodes once. Decoding again would select the
      // wrong file for a URL containing a literal percent-encoded filename.
      const decodedPath = fileURLToPath(requestedPath);
      return decodedPath.includes("\0") ? [] : [decodedPath];
    } catch {
      return [];
    }
  }
  try {
    const decodedPath = decodeURIComponent(requestedPath);
    return decodedPath !== requestedPath && !decodedPath.includes("\0")
      ? [requestedPath, decodedPath]
      : [requestedPath];
  } catch {
    return [requestedPath];
  }
}

export async function resolveLocalPreviewAbsolutePath(value: string): Promise<string | null> {
  for (const candidate of localPreviewPathCandidates(value)) {
    if (!path.isAbsolute(candidate)) continue;
    const realPath = await realpathOrNull(path.resolve(candidate));
    if (realPath !== null) return realPath;
  }
  return null;
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(path.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Keep walking until we hit the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function temporaryDirectoryRoots(): Promise<string[]> {
  const candidates = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.platform === "darwin" ? "/tmp" : undefined,
  ];
  const roots = await Promise.all(Array.from(new Set(candidates)).map(realpathOrNull));
  return Array.from(new Set(roots.filter((root): root is string => root !== null)));
}

async function resolveWorkspaceRoot(cwd: string | null): Promise<string | null> {
  if (!cwd) {
    return null;
  }
  const realCwd = await realpathOrNull(cwd);
  if (!realCwd) {
    return null;
  }
  const gitRoot = await findGitRoot(realCwd);
  return (gitRoot ? await realpathOrNull(gitRoot) : realCwd) ?? null;
}

export async function resolveAllowedLocalPreviewFile(input: {
  readonly requestedPath: string | null;
  readonly cwd: string | null;
  readonly codexHomePath?: CodexGeneratedImageHomeCandidate;
  /** Additional configured Codex homes (per-instance dedicated homes). */
  readonly codexHomePaths?: readonly CodexGeneratedImageHomeCandidate[];
  readonly scratchWorkspacesRoot?: string;
  readonly allowAbsoluteLocalPreviewFile?: boolean;
  readonly previewGrant?: string | null;
}): Promise<ResolvedLocalPreviewFile | null> {
  let selectedPath: {
    requestedPath: string;
    resolvedRequestedPath: string;
    realFilePath: string;
  } | null = null;
  for (const candidate of localPreviewPathCandidates(input.requestedPath ?? "")) {
    const resolvedRequestedPath = path.resolve(input.cwd ?? process.cwd(), candidate);
    const realFilePath = await realpathOrNull(resolvedRequestedPath);
    if (realFilePath !== null) {
      selectedPath = { requestedPath: candidate, resolvedRequestedPath, realFilePath };
      break;
    }
  }
  if (!selectedPath) return null;
  const { requestedPath, resolvedRequestedPath, realFilePath } = selectedPath;
  if (
    !isSupportedLocalPreviewFilePath(requestedPath) ||
    !isSupportedLocalPreviewFilePath(realFilePath)
  ) {
    return null;
  }

  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }
  const resolved: ResolvedLocalPreviewFile = {
    path: realFilePath,
    fileName: path.basename(realFilePath),
    sizeBytes: stat.size,
  };

  // The workspace check covers the common case (file previews), so resolve it
  // first and skip the broader root lookups entirely when it passes.
  const workspaceRoot = await resolveWorkspaceRoot(input.cwd);
  if (workspaceRoot !== null && isPathInside(realFilePath, workspaceRoot)) {
    return resolved;
  }

  // Sessions that start before a project workspace exists run in per-thread
  // scratch directories. Files agents create there are workspace-equivalent,
  // so every preview type is servable from the configured private root. Keep
  // the former temp roots readable for threads created before this migration.
  const tempRoots = await temporaryDirectoryRoots();
  const configuredScratchRoot = await realpathOrNull(input.scratchWorkspacesRoot);
  const scratchWorkspaceRoots = [
    ...(configuredScratchRoot ? [configuredScratchRoot] : []),
    ...tempRoots.map((root) => path.join(root, SCRATCH_WORKSPACES_DIRNAME)),
  ];
  if (scratchWorkspaceRoots.some((root) => isPathInside(realFilePath, root))) {
    return resolved;
  }

  // The in-app file panel may intentionally preview an absolute local path
  // supplied by the agent (for example a file in Downloads). Keep this opt-in
  // so other callers retain the narrower workspace/generated-image allowlist.
  if (
    input.allowAbsoluteLocalPreviewFile === true &&
    path.isAbsolute(requestedPath) &&
    hasValidPreviewGrant({ token: input.previewGrant, realFilePath })
  ) {
    return resolved;
  }

  // The generated-image and temp-dir roots exist for agent-produced images in
  // chat markdown; keep them image-only so they never serve documents or
  // unsupported binary downloads. Workspace/scratch files and explicitly
  // granted absolute paths returned above remain eligible for every allowlisted
  // preview/download extension.
  if (!isSupportedLocalImagePath(realFilePath)) {
    return null;
  }
  // A provided empty array means settings/live sessions intentionally allow no Codex homes.
  // Only fall back to the ambient CODEX_HOME when callers do not provide an allowlist at all.
  const codexHomeCandidates =
    input.codexHomePaths === undefined
      ? [input.codexHomePath]
      : input.codexHomePath === undefined
        ? input.codexHomePaths
        : [input.codexHomePath, ...input.codexHomePaths];

  // Plugin manifests contain filesystem-relative artwork paths. Codex resolves
  // those to absolute files beneath the active instance's source/overlay home,
  // so an app:// renderer must fetch them through this authenticated route.
  // Keep the allowlist to the three concrete plugin materialization trees and
  // require the requested path to remain inside the configured logical or
  // canonical root while the resolved file remains inside that canonical root.
  // This accepts filesystem aliases such as macOS /var -> /private/var without
  // allowing a symlink inside the plugin tree to turn a cache URL into an
  // arbitrary read.
  const codexPluginImageRoots = await Promise.all(
    [
      ...new Set(
        codexHomeCandidates.flatMap((home) =>
          resolveCodexHomeRoots(home).flatMap((root) =>
            CODEX_PLUGIN_IMAGE_SUBROOTS.map((segments) => path.join(root, ...segments)),
          ),
        ),
      ),
    ].map(async (logicalRoot) => ({
      logicalRoot: path.resolve(logicalRoot),
      realRoot: await realpathOrNull(logicalRoot),
    })),
  );
  const isAllowedCodexPluginImage = codexPluginImageRoots.some(
    ({ logicalRoot, realRoot }) =>
      realRoot !== null &&
      (isPathInside(resolvedRequestedPath, logicalRoot) ||
        isPathInside(resolvedRequestedPath, realRoot)) &&
      isPathInside(realFilePath, realRoot),
  );
  if (isAllowedCodexPluginImage || isDeclaredPluginArtwork(resolvedRequestedPath, realFilePath)) {
    return resolved;
  }

  const generatedImagesRoots = await Promise.all(
    [...new Set(codexHomeCandidates.flatMap((home) => resolveCodexGeneratedImagesRoots(home)))].map(
      realpathOrNull,
    ),
  ).then((roots) => roots.filter((root): root is string => root !== null));
  const isAllowedGeneratedImage = generatedImagesRoots.some((root) =>
    isPathInside(realFilePath, root),
  );
  // A Codex generated_images path is account-scoped data. Do not let the
  // broad temporary-image fallback bypass an explicit per-instance allowlist
  // merely because a runtime or test worktree happens to live under /tmp.
  // Check both the requested path and its canonical target: a generated_images
  // directory can itself be a symlink, which removes that segment after realpath.
  const allowed =
    isAllowedGeneratedImage ||
    (!isInsideGeneratedImagesDirectory(resolvedRequestedPath) &&
      !isInsideGeneratedImagesDirectory(realFilePath) &&
      !isInsideCodexPluginImageDirectory(resolvedRequestedPath) &&
      !isInsideCodexPluginImageDirectory(realFilePath) &&
      tempRoots.some((root) => isPathInside(realFilePath, root)));
  return allowed ? resolved : null;
}

export async function createLocalPreviewGrant(input: {
  readonly requestedPath: string;
}): Promise<LocalPreviewGrantResult> {
  if (
    !localPreviewPathCandidates(input.requestedPath).some((candidate) => path.isAbsolute(candidate))
  ) {
    throw new Error("Only absolute local files can be granted.");
  }
  const realFilePath = await resolveLocalPreviewAbsolutePath(input.requestedPath);
  if (!realFilePath) {
    throw new Error("Preview file not found.");
  }
  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("Preview path is not a file.");
  }

  const expiresAtMs = Date.now() + LOCAL_PREVIEW_GRANT_TTL_MS;
  const grant = crypto.randomUUID();
  localPreviewGrantByToken.set(grant, { realFilePath, expiresAtMs });
  pruneExpiredPreviewGrants();
  return { grant, expiresAt: new Date(expiresAtMs).toISOString() };
}
