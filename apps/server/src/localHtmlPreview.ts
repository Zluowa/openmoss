// Serves a rendered HTML file preview. A short-lived file grant names one HTML
// document; the route then serves only web assets inside that document's own
// folder tree. The response policy gives the page an opaque sandbox origin and
// no network access at all, and nothing it receives names a local path.
import fs from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_HTML_PAGE_ASSET_EXTENSIONS,
  LOCAL_HTML_PREVIEW_ROUTE_PREFIX,
  localHtmlPageContentSecurityPolicy,
  localHtmlPageResponseHeaders,
} from "@moss/shared/localPreviewFiles";

import { renewLocalPreviewGrant, resolveLocalPreviewGrantRealPath } from "./localImageFiles";

export const LOCAL_HTML_PREVIEW_PREFIX = LOCAL_HTML_PREVIEW_ROUTE_PREFIX;
const HTML_MAX_BYTES = 5_000_000;
// Only resources a page can load under the shared page policy.
const ASSET_EXTENSIONS = LOCAL_HTML_PAGE_ASSET_EXTENSIONS;

export interface LocalHtmlPreviewAsset {
  readonly path: string;
  readonly sizeBytes: number;
  readonly token: string;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * One URL path segment as a plain file or folder name. Rejects empty segments (from
 * `//`, which is how UNC-style references arrive), dot segments and dotfiles, NUL,
 * both separators, and `:` (Windows drive letters and alternate data streams).
 */
function decodeAssetSegment(encoded: string): string | null {
  let segment: string;
  try {
    segment = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!segment || segment.startsWith(".") || segment.includes("\0") || /[\\/:]/u.test(segment)) {
    return null;
  }
  return segment;
}

export async function resolveLocalHtmlPreviewAsset(
  pathname: string,
): Promise<LocalHtmlPreviewAsset | null> {
  if (!pathname.startsWith(LOCAL_HTML_PREVIEW_PREFIX)) return null;
  const [token, ...encodedSegments] = pathname.slice(LOCAL_HTML_PREVIEW_PREFIX.length).split("/");
  if (!token || encodedSegments.length === 0) return null;
  const source = resolveLocalPreviewGrantRealPath({ token });
  if (!source || !/\.html?$/iu.test(source)) return null;
  // The grant stores the document's real path, so this is the real folder: a link
  // or junction on the way to the document cannot widen the tree.
  const root = path.dirname(source);
  if (root === path.parse(root).root) return null;
  const segments: string[] = [];
  for (const encoded of encodedSegments) {
    const segment = decodeAssetSegment(encoded);
    if (segment === null) return null;
    segments.push(segment);
  }
  const requested = path.join(root, ...segments);
  if (!isInsideRoot(root, requested)) return null;
  if (!ASSET_EXTENSIONS.has(path.extname(requested).toLowerCase())) return null;
  try {
    // Containment is checked again on the real path, so a symlink or junction
    // inside the folder cannot point the page at a file outside it.
    const realPath = await fs.realpath(requested);
    if (!isInsideRoot(root, realPath)) return null;
    // Reject hidden targets and disguised links even inside the allowed root.
    if (
      path
        .relative(root, realPath)
        .split(path.sep)
        .some((part) => part.startsWith("."))
    ) {
      return null;
    }
    if (!ASSET_EXTENSIONS.has(path.extname(realPath).toLowerCase())) return null;
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || (/\.html?$/iu.test(realPath) && stat.size > HTML_MAX_BYTES)) return null;
    // Every page or asset the open preview loads keeps its grant alive.
    renewLocalPreviewGrant(token);
    return { path: realPath, sizeBytes: stat.size, token };
  } catch {
    return null;
  }
}

/**
 * Policy for every response on the route (the shared local-page policy): an opaque
 * sandbox origin and no network at all. See `localHtmlPageContentSecurityPolicy`.
 */
export function localHtmlPreviewContentSecurityPolicy(scope: string): string {
  return localHtmlPageContentSecurityPolicy(scope);
}

export function localHtmlPreviewHeaders(
  origin: string,
  token: string,
  assetPath: string,
): Record<string, string> {
  return localHtmlPageResponseHeaders({
    scope: `${origin}${LOCAL_HTML_PREVIEW_PREFIX}${encodeURIComponent(token)}/`,
    assetPath,
  });
}
