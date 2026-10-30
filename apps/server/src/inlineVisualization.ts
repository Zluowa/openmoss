// FILE: inlineVisualization.ts
// Purpose: Validate and render Codex visualization fragments from their owning Codex thread.
// Layer: Server security boundary

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const INLINE_VISUALIZATION_MAX_BYTES = 2 * 1024 * 1024;
export const INLINE_VISUALIZATION_RESOLVE_ROUTE_PATH = "/api/inline-visualization";
export const INLINE_VISUALIZATION_FRAME_ROUTE_PATH = "/api/inline-visualization/frame";
export const INLINE_VISUALIZATION_LIBRARIES_ROUTE_PREFIX = "/inline-visualization-libs/";

/**
 * Only these versioned, shipped assets are addressable from a visualization.
 * Keeping this a whitelist makes the HTTP route a library server rather than a
 * second static-file escape hatch.
 */
export const INLINE_VISUALIZATION_LIBRARY_CONTENT_TYPES = {
  "d3.min.js": "text/javascript; charset=utf-8",
  "d3.esm.js": "text/javascript; charset=utf-8",
  "three.min.js": "text/javascript; charset=utf-8",
  "three.module.js": "text/javascript; charset=utf-8",
  "chart.umd.js": "text/javascript; charset=utf-8",
  "chart.esm.js": "text/javascript; charset=utf-8",
  "fonts.css": "text/css; charset=utf-8",
  "inter-latin.woff2": "font/woff2",
  "jetbrains-mono-latin.woff2": "font/woff2",
} as const;

export function inlineVisualizationLibraryContentType(assetName: string) {
  return INLINE_VISUALIZATION_LIBRARY_CONTENT_TYPES[
    assetName as keyof typeof INLINE_VISUALIZATION_LIBRARY_CONTENT_TYPES
  ];
}

export const INLINE_VISUALIZATION_DOCUMENT_SECURITY_HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
} as const;

export type InlineVisualizationUnavailableReason =
  | "invalid-path"
  | "outside-thread"
  | "outside-workspace"
  | "missing"
  | "not-file"
  | "too-large"
  | "unknown-dependency";

export type ValidatedInlineVisualization = {
  readonly path: string;
  readonly source: string;
  readonly sha256: string;
};

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function hasExactVisualizationShape(input: {
  readonly visualizationsRoot: string;
  readonly realPath: string;
  readonly codexThreadId: string;
}) {
  const relative = path.relative(input.visualizationsRoot, input.realPath);
  const segments = relative.split(path.sep);
  // visualizations/YYYY/MM/DD/<native Codex thread>/<single file>.html
  return (
    segments.length === 5 &&
    segments[3] === input.codexThreadId &&
    /^[0-9]{4}$/u.test(segments[0] ?? "") &&
    /^[0-9]{2}$/u.test(segments[1] ?? "") &&
    /^[0-9]{2}$/u.test(segments[2] ?? "") &&
    !segments[4]?.includes(path.sep) &&
    path.extname(segments[4] ?? "").toLowerCase() === ".html"
  );
}

/**
 * Shared tail for both validators: after the caller has confined `realFile`
 * inside its authorized root, enforce file-ness and the size cap, then read.
 */
async function readValidatedVisualizationFile(
  realFile: string,
): Promise<ValidatedInlineVisualization | InlineVisualizationUnavailableReason> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(realFile);
  } catch {
    return "missing";
  }
  if (!stat.isFile()) return "not-file";
  if (stat.size > INLINE_VISUALIZATION_MAX_BYTES) return "too-large";
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(realFile);
  } catch {
    return "missing";
  }
  // Recheck the cap after read: a writer can race the stat but cannot make us
  // allocate or serve over the hard limit.
  if (bytes.byteLength > INLINE_VISUALIZATION_MAX_BYTES) return "too-large";
  return {
    path: realFile,
    source: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Resolve after every symlink component. The input must be a one-level HTML
 * file in this provider session's native Codex-thread directory; no caller
 * supplied prefix, traversal or symlink can widen the readable filesystem.
 */
export async function validateInlineVisualizationFile(input: {
  readonly requestedPath: string;
  readonly codexHome: string;
  readonly codexThreadId: string;
}): Promise<ValidatedInlineVisualization | InlineVisualizationUnavailableReason> {
  if (
    !path.isAbsolute(input.requestedPath) ||
    input.requestedPath.length > 4096 ||
    input.requestedPath.split(/[\\/]/u).includes("..") ||
    !input.codexThreadId ||
    path.extname(input.requestedPath).toLowerCase() !== ".html"
  ) {
    return "invalid-path";
  }
  const visualizationsRoot = path.join(input.codexHome, "visualizations");
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([
      fs.realpath(visualizationsRoot),
      fs.realpath(input.requestedPath),
    ]);
  } catch {
    return "missing";
  }
  if (
    !isInside(realRoot, realFile) ||
    !hasExactVisualizationShape({
      visualizationsRoot: realRoot,
      realPath: realFile,
      codexThreadId: input.codexThreadId,
    })
  ) {
    return "outside-thread";
  }
  return readValidatedVisualizationFile(realFile);
}

/**
 * Moss threads of any provider write visualization artifacts into the thread's
 * own workspace (e.g. `visualizations/special-relativity.html` in a worktree).
 * Resolve the marker path against that workspace — relative paths from the
 * workspace root, absolute paths only when they stay inside it — and confine
 * the result with realpath so no traversal or symlink escapes the workspace.
 */
export async function validateWorkspaceInlineVisualizationFile(input: {
  readonly requestedPath: string;
  readonly workspaceRoot: string;
}): Promise<ValidatedInlineVisualization | InlineVisualizationUnavailableReason> {
  const requestedPath = input.requestedPath.trim();
  if (
    requestedPath.length === 0 ||
    requestedPath.length > 4096 ||
    requestedPath.split(/[\\/]/u).includes("..") ||
    path.extname(requestedPath).toLowerCase() !== ".html" ||
    !path.isAbsolute(input.workspaceRoot)
  ) {
    return "invalid-path";
  }
  const candidate = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.join(input.workspaceRoot, requestedPath);
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([
      fs.realpath(input.workspaceRoot),
      fs.realpath(candidate),
    ]);
  } catch {
    return "missing";
  }
  if (!isInside(realRoot, realFile)) return "outside-workspace";
  return readValidatedVisualizationFile(realFile);
}

const LOCAL_LIB_ROOT = "/inline-visualization-libs";
const FONT_STYLESHEET = `${LOCAL_LIB_ROOT}/fonts.css`;

function isEsmUrl(url: string) {
  return /(?:^https:\/\/esm\.sh\/|[?&](?:module|target=es|type=module)(?:[=&]|$)|(?:\.mjs|\.module\.js|\+esm)(?:[?#]|$))/iu.test(
    url,
  );
}

/** Maps known Codex skill CDNs to checked-in, same-origin assets. */
export function rewriteInlineVisualizationCdnUrls(source: string) {
  const replace = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return raw;
    }
    const host = url.hostname.toLowerCase();
    if (
      ![
        "cdn.jsdelivr.net",
        "unpkg.com",
        "cdnjs.cloudflare.com",
        "esm.sh",
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "fonts.bunny.net",
      ].includes(host)
    ) {
      return raw;
    }
    const normalized = `${url.pathname}${url.search}`.toLowerCase();
    if (host.startsWith("fonts.")) {
      return normalized.includes(".woff") ? `${LOCAL_LIB_ROOT}/inter-latin.woff2` : FONT_STYLESHEET;
    }
    if (/(?:^|[\/@])d3(?:[\/@]|$)/u.test(normalized)) {
      return `${LOCAL_LIB_ROOT}/${host === "esm.sh" || isEsmUrl(raw) ? "d3.esm.js" : "d3.min.js"}`;
    }
    if (/(?:^|[\/@])three(?:[\/@]|$)/u.test(normalized)) {
      return `${LOCAL_LIB_ROOT}/${host === "esm.sh" || isEsmUrl(raw) ? "three.module.js" : "three.min.js"}`;
    }
    if (/(?:chart\.js|chartjs)(?:[\/@.]|$)/u.test(normalized)) {
      return `${LOCAL_LIB_ROOT}/${host === "esm.sh" || isEsmUrl(raw) ? "chart.esm.js" : "chart.umd.js"}`;
    }
    return raw;
  };
  return source.replace(/https:\/\/[^\s"'`<>\\)]+/giu, replace);
}

/** Detects resource URLs left after optional bundled-library rewriting. */
export function hasUnknownVisualizationDependency(source: string) {
  const resourceUrl =
    /(?:\b(?:src|href)\s*=\s*["']|\b(?:import|from)\s*\(?\s*["']|@import\s+(?:url\()?\s*["']?|url\(\s*["']?)(https?:\/\/[^\s"')>]+)/giu;
  return resourceUrl.test(source);
}

export function inlineVisualizationDocument(fragment: string) {
  // Bundling known chart libraries is a convenience, never a network policy:
  // visual replies retain the same remote-resource behavior as T3 Code.
  const rewritten = rewriteInlineVisualizationCdnUrls(fragment);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>html,body{margin:0;min-height:100%;background:transparent;color:CanvasText;font:14px/1.45 Inter,system-ui,sans-serif}*{box-sizing:border-box}</style></head><body>${rewritten}</body></html>`;
}
