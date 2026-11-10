// FILE: localPreviewFiles.ts
// Purpose: Single source of truth for the /api/local-image route shape consumed by
//          both the server (HTTP route + filesystem allowlist) and the web client
//          (URL builder + markdown image source detection). The route serves every
//          allowlisted preview/download file: images (rendered via <img>), PDFs
//          (rendered by pdf.js), media/HTML previews, and unsupported archives
//          through the download fallback.
// Layer: Shared utility (no runtime dependencies)
// Exports: route path, preview-file extension allowlists, and helper predicates
//          derived from them.

export const LOCAL_IMAGE_ROUTE_PATH = "/api/local-image" as const;

/** A durable library image reference contains only its opaque index ID. */
export const LIBRARY_IMAGE_ROUTE_PREFIX = "/api/library-image/" as const;
export const libraryImagePreviewPath = (itemId: string) =>
  `${LIBRARY_IMAGE_ROUTE_PREFIX}${encodeURIComponent(itemId)}`;

/** Only the exact local reference is accepted; absolute/external URLs are never proxied. */
export function libraryImageIdFromPath(value: string): string | null {
  if (!value.startsWith(LIBRARY_IMAGE_ROUTE_PREFIX)) return null;
  const id = value.slice(LIBRARY_IMAGE_ROUTE_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : null;
}

/**
 * Rendered HTML file previews: `<prefix><grant>/<file name>`. The server serves the
 * granted document and web assets inside its own folder tree, never anything above it.
 */
export const LOCAL_HTML_PREVIEW_ROUTE_PREFIX = "/api/local-html/" as const;

// Lower-case extensions (with leading dot) that the server is willing to serve and
// the web client is willing to treat as local-image markdown sources. Keep these in
// sync with the MIME allowlist used elsewhere; this list is the canonical answer.
export const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
] as const;

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
);

/** Lower-cased extension (with leading dot) of a path, or null when there is none. */
export function lowerCaseExtensionOf(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return filePath.slice(dot).toLowerCase();
}

export function isSupportedLocalImagePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET.has(extension);
}

export const SUPPORTED_LOCAL_PDF_EXTENSION = ".pdf" as const;

export function isSupportedLocalPdfPath(filePath: string): boolean {
  return lowerCaseExtensionOf(filePath) === SUPPORTED_LOCAL_PDF_EXTENSION;
}

export const SUPPORTED_LOCAL_AUDIO_EXTENSIONS = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4a",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
] as const;
export const SUPPORTED_LOCAL_VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".ogv"] as const;
export const SUPPORTED_LOCAL_HTML_EXTENSIONS = [".html", ".htm"] as const;
// Markdown is normally read through the workspace RPC. It is also a valid
// local preview target when the desktop explorer has handed us an absolute
// path and the caller presents a short-lived preview grant.
export const SUPPORTED_LOCAL_TEXT_EXTENSIONS = [
  ".md",
  ".markdown",
  ".mdown",
  ".mdx",
  ".mkd",
] as const;
// Archives do not have an in-app renderer, but they still need to pass through
// the authenticated local-file route so the unsupported card can offer the
// same download action as Codex's library preview.
export const SUPPORTED_LOCAL_ARCHIVE_EXTENSIONS = [
  ".zip",
  ".tar",
  ".tgz",
  ".gz",
  ".bz2",
  ".xz",
  ".rar",
  ".7z",
] as const;

// Office artifacts and delimited spreadsheets are rendered by the workspace
// artifact surface, but still travel through the authenticated local-file
// route when the reference is an absolute path.
export const SUPPORTED_LOCAL_ARTIFACT_EXTENSIONS = [
  ".docx",
  ".xlsx",
  ".xlsm",
  ".pptx",
  ".csv",
  ".tsv",
  ".ipynb",
  ".tex",
] as const;

export function isSupportedLocalAudioPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return (
    extension !== null &&
    (SUPPORTED_LOCAL_AUDIO_EXTENSIONS as readonly string[]).includes(extension)
  );
}

export function isSupportedLocalVideoPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return (
    extension !== null &&
    (SUPPORTED_LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(extension)
  );
}

export function isSupportedLocalHtmlPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return (
    extension !== null && (SUPPORTED_LOCAL_HTML_EXTENSIONS as readonly string[]).includes(extension)
  );
}

export function isSupportedLocalTextPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return (
    extension !== null && (SUPPORTED_LOCAL_TEXT_EXTENSIONS as readonly string[]).includes(extension)
  );
}

export function isSupportedLocalArchivePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return (
    extension !== null &&
    (SUPPORTED_LOCAL_ARCHIVE_EXTENSIONS as readonly string[]).includes(extension)
  );
}

export function isSupportedLocalArtifactPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return (
    extension !== null &&
    (SUPPORTED_LOCAL_ARTIFACT_EXTENSIONS as readonly string[]).includes(extension)
  );
}

// Full allowlist for the /api/local-image serving route. Markdown image source
// detection (below) intentionally stays image-only: a `.pdf`, media, HTML, or
// archive link in chat markdown must never be inlined as an <img>.
export function isSupportedLocalPreviewFilePath(filePath: string): boolean {
  return (
    isSupportedLocalImagePath(filePath) ||
    isSupportedLocalPdfPath(filePath) ||
    isSupportedLocalAudioPath(filePath) ||
    isSupportedLocalVideoPath(filePath) ||
    isSupportedLocalHtmlPath(filePath) ||
    isSupportedLocalArchivePath(filePath) ||
    isSupportedLocalTextPath(filePath) ||
    isSupportedLocalArtifactPath(filePath)
  );
}

// Built from the canonical extensions list so the web regex never drifts from the
// server allowlist. Anchored at end-of-string to match `.png`-style suffixes only.
export const SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX: RegExp = (() => {
  const escaped = SUPPORTED_LOCAL_IMAGE_EXTENSIONS.map((extension) =>
    extension.slice(1).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`\\.(?:${escaped.join("|")})$`, "i");
})();

// ---------------------------------------------------------------------------
// Rendered local HTML pages. One policy for both places a page from disk is shown:
// the backend's /api/local-html/ route (file pane, plain browser build) and the
// desktop browser panel's local-file scheme. Moving it here keeps the two from
// drifting apart.

/**
 * Files a rendered local page may load from its own folder tree. Data files (JSON and
 * the like) are absent because the page has no way to fetch them.
 */
export const LOCAL_HTML_PAGE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".css",
  ".js",
  ".mjs",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
]);

/**
 * Assets an opaque-origin page needs CORS for (module scripts, fonts, `crossorigin`
 * stylesheets). Everything else is served without it, so it still displays but a
 * script cannot read its pixels or bytes.
 */
export const LOCAL_HTML_PAGE_CORS_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".css",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

/**
 * Policy for every response of a rendered local page. `sandbox allow-scripts` without
 * `allow-same-origin` gives the page an opaque origin (no cookies, storage or app
 * APIs), and every fetch directive allows only the page's own folder (`scope`) or
 * inline/data content, so it cannot load, send or submit anything over the network.
 * `extraSources` are sites the person explicitly allowed for local pages; they are
 * added to the load directives only.
 */
export function localHtmlPageContentSecurityPolicy(
  scope: string,
  extraSources: readonly string[] = [],
): string {
  const sources = [scope, ...extraSources].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${sources}`,
    `style-src 'unsafe-inline' ${sources}`,
    `img-src data: blob: ${sources}`,
    `font-src data: ${sources}`,
    `media-src data: blob: ${sources}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${scope}`,
  ].join("; ");
}

/** Response headers for one file of a rendered local page. */
export function localHtmlPageResponseHeaders(input: {
  readonly scope: string;
  readonly assetPath: string;
  readonly extraSources?: readonly string[];
}): Record<string, string> {
  const extension = lowerCaseExtensionOf(input.assetPath) ?? "";
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-DNS-Prefetch-Control": "off",
    // A page from disk gets no channel to Moss or its agents: no page tools.
    "Permissions-Policy": "tools=()",
    // Never allow credentials; the scope is a grant, not an app auth token.
    ...(LOCAL_HTML_PAGE_CORS_ASSET_EXTENSIONS.has(extension)
      ? { "Access-Control-Allow-Origin": "*" }
      : {}),
    "Content-Security-Policy": localHtmlPageContentSecurityPolicy(
      input.scope,
      input.extraSources ?? [],
    ),
  };
}
