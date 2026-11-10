// FILE: localImageUrls.ts
// Purpose: Builds authenticated local-image URLs for markdown image previews and downloads.
// Layer: Web utility
// Exports: local image URL detection and builders
// Depends on: wsHttpUrl (so desktop requests carry the legacy startup token used by attachments)
//             and @moss/shared/localPreviewFiles for the canonical route + extension allowlist.

import {
  LOCAL_IMAGE_ROUTE_PATH,
  SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX,
} from "@moss/shared/localPreviewFiles";
import { isLocalAbsolutePath, isWindowsAbsolutePath } from "@moss/shared/path";

import { resolveWsHttpUrl } from "./wsHttpUrl";

function normalizeMarkdownImagePath(src: string): string {
  const trimmed = src.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return trimmed;
    }
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function isLocalImageMarkdownSrc(src: string | undefined): src is string {
  if (!src) {
    return false;
  }
  const normalized = normalizeMarkdownImagePath(src);
  if (!SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX.test(normalized)) {
    return false;
  }
  // Treat Windows-style absolute paths (e.g. `C:\foo\bar.png`) as local images even though
  // their drive prefix would otherwise look like a URI scheme.
  if (isWindowsAbsolutePath(normalized)) {
    return true;
  }
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    !/^[a-z][a-z0-9+.-]*:/i.test(normalized)
  );
}

// Grants must name the same decoded file as the preview HTTP request.
export function localImageAbsolutePath(src: string): string | null {
  const normalized = normalizeMarkdownImagePath(src);
  return isLocalImageMarkdownSrc(src) && isLocalAbsolutePath(normalized) ? normalized : null;
}

let localImageUrlResolver: ((src: string) => string) | null = null;

/**
 * Lets a host that reaches the owner's pictures through another route say where they load from.
 * The guest page (served by the share relay) sets this once at startup, so a shared transcript's
 * local images load through the share's `media` route. The app itself never calls this.
 */
export function setLocalImageUrlResolver(resolver: ((src: string) => string) | null): void {
  localImageUrlResolver = resolver;
}

const mediaAssetRoute =
  /^\/api\/moss\/media\/assets\/moss_[A-Za-z0-9_-]{1,128}\/(\d{1,2})\?accountScope=[a-f0-9]{64}$/u;

export function isMossConversationImageSource(src: string): boolean {
  return mediaAssetRoute.test(src);
}

export function buildLocalImageUrl(input: {
  readonly src: string;
  readonly cwd: string | undefined;
  readonly download?: boolean;
  // Accept an explicit `undefined` (not just absent) so callers can forward an
  // optional `previewGrant: string | null | undefined` straight through under
  // exactOptionalPropertyTypes. Internally falsy grants are simply omitted below.
  readonly grant?: string | null | undefined;
  /** Changes the preview URL so an explicit reload bypasses browser caching. */
  readonly cacheKey?: string | number | undefined;
}): string {
  if (localImageUrlResolver !== null) return localImageUrlResolver(input.src.trim());
  if (isMossConversationImageSource(input.src)) {
    const revision = input.cacheKey === undefined ? "" : `&v=${encodeURIComponent(input.cacheKey)}`;
    return resolveWsHttpUrl(input.src + revision + (input.download ? "&download=1" : ""));
  }
  const params = new URLSearchParams({ path: normalizeMarkdownImagePath(input.src) });
  if (input.cwd) {
    params.set("cwd", input.cwd);
  }
  if (input.grant) {
    params.set("grant", input.grant);
  }
  if (input.cacheKey !== undefined) {
    params.set("v", String(input.cacheKey));
  }
  if (input.download) {
    params.set("download", "1");
  }
  // Always route through the WS-derived HTTP origin so desktop builds (custom protocol)
  // include the same legacy startup token attachments already use; in web/dev (where
  // the page and server share an origin) this falls back to the same relative path.
  return resolveWsHttpUrl(`${LOCAL_IMAGE_ROUTE_PATH}?${params.toString()}`);
}

/**
 * Turns a provider plugin's filesystem artwork into a browser-loadable URL.
 * Codex app-server emits absolute local paths for manifest-relative icons;
 * those cannot be loaded directly by the packaged app:// renderer.
 */
export function resolvePluginArtworkUrl(input: {
  readonly src: string;
  readonly cwd: string | undefined;
}): string {
  const src = input.src.trim();
  if (
    src.startsWith("//") ||
    /^(?:https?:|data:|blob:|app:|chrome:|resource:)/i.test(src) ||
    !isLocalImageMarkdownSrc(src)
  ) {
    return src;
  }
  return buildLocalImageUrl({ src, cwd: input.cwd });
}

export function localImageFileName(src: string): string {
  const media = mediaAssetRoute.exec(src);
  if (media) return `image-${Number(media[1]) + 1}`;
  const normalized = normalizeMarkdownImagePath(src);
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
