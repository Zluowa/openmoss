// FILE: HtmlRender.ts
// Purpose: Prepares and stores agent-authored HTML pages ("HTML renders") as thread attachments.
// Layer: Server service
// Origin: Ported from apps/server/src/htmlRender/HtmlRender.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at ba0ea3d152150f399827d36a5b4b86c5bbda2d7f
//   (PR #15968), with the viewport-height check from 08a463e29976617134de01e9341f898bc881d0eb.
//   Local absolute-path images follow T3's publish-time inlining behavior.
//   See THIRD_PARTY_NOTICES.md.

import type { ThreadId } from "@synara/contracts";
import {
  clampHtmlRenderHeight,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MEASURE_WIDTHS,
  HTML_RENDER_MAX_TITLE_LENGTH,
  injectHtmlRenderBootstrap,
  type HtmlRenderReference,
} from "@synara/shared/htmlRender";
import { type ThemeAppearance } from "@synara/shared/themePalettes";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Effect, FileSystem, Layer, Option, Schema, ServiceMap, Stream } from "effect";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { startPublicProxy } from "./publicProxy.ts";

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;
const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_600;
const MAX_CAPTURE_HEIGHT = 4_000;
const MAX_CONSOLE_MESSAGES = 20;
const MEASURE_TIMEOUT_MS = 6_000;
export const HTML_PREVIEW_BROWSER_INSTALL_TIMEOUT_MS = 180_000;
export const HTML_PREVIEW_BROWSER_INSTALL_PROGRESS_MESSAGE =
  "Moss is still downloading its dedicated headless preview browser. It can take a few minutes; try again shortly.";
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

type PlaywrightRuntimePaths = {
  /** Playwright's manifest pins the matching Chrome Headless Shell revision. */
  readonly browsersManifestPath: string;
};

/**
 * Resolve Playwright from this server module, not from a shell PATH. The
 * desktop package ships this dependency alongside the server, while `bunx`
 * is a development convenience that may not exist in a packaged build.
 */
export const resolveBundledPlaywrightPaths = (
  resolveDependency: (specifier: string) => string,
): PlaywrightRuntimePaths => {
  const packagePath = resolveDependency("playwright/package.json");
  return {
    browsersManifestPath: join(dirname(dirname(packagePath)), "playwright-core", "browsers.json"),
  };
};

interface PlaywrightHeadlessShellManifestEntry {
  readonly revision: string;
  readonly browserVersion: string;
}

/** Read the sole browser artifact the preview service needs from Playwright's manifest. */
export const playwrightHeadlessShellManifestEntry = (
  manifest: string,
): PlaywrightHeadlessShellManifestEntry => {
  const parsed: unknown = JSON.parse(manifest);
  const browsers =
    parsed && typeof parsed === "object" && "browsers" in parsed
      ? (parsed as { readonly browsers?: unknown }).browsers
      : undefined;
  if (!Array.isArray(browsers)) {
    throw new Error("Moss could not read its bundled Playwright browser manifest.");
  }
  const entry = browsers.find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.name === "chromium-headless-shell",
  );
  const revision = typeof entry?.revision === "string" ? entry.revision : undefined;
  const browserVersion =
    typeof entry?.browserVersion === "string" ? entry.browserVersion : undefined;
  if (!revision || !browserVersion) {
    throw new Error(
      "Moss could not find Chrome Headless Shell in its bundled Playwright manifest.",
    );
  }
  return { revision, browserVersion };
};

/** Chrome for Testing is the source Playwright's pinned headless shell builds from. */
export const chromeForTestingHeadlessShellUrl = (
  browserVersion: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string => {
  const target =
    platform === "linux" && arch === "x64"
      ? "linux64"
      : platform === "darwin" && arch === "x64"
        ? "mac-x64"
        : platform === "darwin" && arch === "arm64"
          ? "mac-arm64"
          : platform === "win32" && arch === "x64"
            ? "win64"
            : platform === "win32" && arch === "ia32"
              ? "win32"
              : undefined;
  if (!target) {
    throw new Error(
      `Moss's dedicated headless preview browser is not available for ${platform}/${arch}.`,
    );
  }
  return `https://storage.googleapis.com/chrome-for-testing-public/${browserVersion}/${target}/chrome-headless-shell-${target}.zip`;
};

const headlessShellArchiveName = "chrome-headless-shell.zip";

const extractHeadlessShellArchive = async (input: {
  readonly archivePath: string;
  readonly targetDirectory: string;
}): Promise<void> => {
  const command =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${input.archivePath.replaceAll("'", "''")}' -DestinationPath '${input.targetDirectory.replaceAll("'", "''")}' -Force`,
        ]
      : ["unzip", "-q", input.archivePath, "-d", input.targetDirectory];
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  if (exitCode !== 0) {
    throw new Error("Moss could not unpack its headless preview browser.");
  }
};

/**
 * Download the one binary used for screenshots. Playwright's CLI always adds
 * ffmpeg for every browser target; preview has no video path, so use the same
 * pinned Chrome-for-Testing shell directly instead.
 */
export const installDedicatedHeadlessShell = async (input: {
  readonly browserDirectory: string;
  readonly revision: string;
  readonly browserVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly extract?: (input: {
    readonly archivePath: string;
    readonly targetDirectory: string;
  }) => Promise<void>;
}): Promise<void> => {
  const targetDirectory = join(input.browserDirectory, `chromium_headless_shell-${input.revision}`);
  const archivePath = join(input.browserDirectory, headlessShellArchiveName);
  const fetchImpl = input.fetchImpl ?? fetch;
  const extract = input.extract ?? extractHeadlessShellArchive;
  await mkdir(targetDirectory, { recursive: true });
  try {
    const response = await fetchImpl(chromeForTestingHeadlessShellUrl(input.browserVersion));
    if (!response.ok || response.body === null) {
      throw new Error(
        `Moss could not download its headless preview browser (HTTP ${response.status}).`,
      );
    }
    await writeFile(archivePath, new Uint8Array(await response.arrayBuffer()));
    await extract({ archivePath, targetDirectory });
  } finally {
    await rm(archivePath, { force: true });
  }
};

/**
 * `chromium.launch({ executablePath })` works with the standalone headless
 * shell. Locate it directly rather than asking Playwright for `chromium`'s
 * full browser executable, which would make a preview pull Chromium and ffmpeg
 * in addition to the shell.
 */
export const dedicatedHeadlessShellExecutable = (
  browserDirectory: string,
  readDirectory: (path: string) => ReadonlyArray<string> = readdirSync,
  fileExists: (path: string) => boolean = existsSync,
): string | undefined => {
  let entries: ReadonlyArray<string>;
  try {
    entries = readDirectory(browserDirectory);
  } catch {
    return undefined;
  }
  const shellDirectory = entries.find((entry) => /^chromium[-_]headless[-_]shell-/u.test(entry));
  if (!shellDirectory) return undefined;
  for (const relativePath of [
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chrome-headless-shell-win32/chrome-headless-shell.exe",
    // Playwright's own archives name the executable `headless_shell`.
    "chrome-headless-shell-linux64/headless_shell",
    "chrome-headless-shell-mac-x64/headless_shell",
    "chrome-headless-shell-mac-arm64/headless_shell",
    "chrome-headless-shell-win64/headless_shell.exe",
    "chrome-headless-shell-win32/headless_shell.exe",
    // Older Playwright archives used these root directories.
    "chrome-linux/headless_shell",
    "chrome-linux64/headless_shell",
    "chrome-mac/headless_shell",
    "chrome-mac-arm64/headless_shell",
    "chrome-win/headless_shell.exe",
    "chrome-win64/headless_shell.exe",
  ]) {
    const executable = join(browserDirectory, shellDirectory, relativePath);
    if (fileExists(executable)) return executable;
  }
  return undefined;
};

interface SharedPreviewBrowserInstaller {
  readonly waitForInstall: () => Promise<void>;
}

/**
 * Share a one-time download across concurrent previews. A timeout reports
 * honest progress but leaves the shared install running, so a later preview
 * can use its completed cache without downloading a second time.
 */
export const makeSharedPreviewBrowserInstaller = (input: {
  readonly install: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly timeoutMessage?: string;
}): SharedPreviewBrowserInstaller => {
  const timeoutMs = input.timeoutMs ?? HTML_PREVIEW_BROWSER_INSTALL_TIMEOUT_MS;
  const timeoutMessage = input.timeoutMessage ?? HTML_PREVIEW_BROWSER_INSTALL_PROGRESS_MESSAGE;
  let installing: Promise<void> | null = null;

  const start = () => {
    if (installing !== null) return installing;
    installing = input.install().finally(() => {
      installing = null;
    });
    return installing;
  };

  return {
    waitForInstall: async () => {
      const completed = start();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
};

export class HtmlRenderImagesNotFoundError extends Schema.TaggedErrorClass<HtmlRenderImagesNotFoundError>()(
  "HtmlRenderImagesNotFoundError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These local images could not be read: ${this.paths.join(", ")}. Use absolute paths to existing image files, or remove them.`;
  }
}

export class HtmlRenderImageTooLargeError extends Schema.TaggedErrorClass<HtmlRenderImageTooLargeError>()(
  "HtmlRenderImageTooLargeError",
  { path: Schema.String, sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `${this.path} is ${formatMib(this.sizeBytes)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`;
  }
}

export class HtmlRenderPageTooLargeError extends Schema.TaggedErrorClass<HtmlRenderPageTooLargeError>()(
  "HtmlRenderPageTooLargeError",
  { sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `With its images inlined the page is ${formatMib(this.sizeBytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`;
  }
}

export class HtmlRenderViewportHeightError extends Schema.TaggedErrorClass<HtmlRenderViewportHeightError>()(
  "HtmlRenderViewportHeightError",
  { found: Schema.String },
) {
  override get message(): string {
    return `The page uses a viewport height unit (${this.found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`;
  }
}

// Checks only stylesheets and style attributes, even inside scripts, and skips
// comments whole. Unclosed comments, tags, and quotes run to the end, so both
// patterns stay linear on any input.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

const rejectViewportHeight = (html: string) => {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const css = sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const found = VIEWPORT_HEIGHT_UNIT.exec(css)?.[0];
    if (found !== undefined) return Effect.fail(new HtmlRenderViewportHeightError({ found }));
  }
  return Effect.void;
};

export class HtmlRenderStoreError extends Schema.TaggedErrorClass<HtmlRenderStoreError>()(
  "HtmlRenderStoreError",
  { cause: Schema.Defect },
) {
  override get message(): string {
    return "The HTML render could not be saved.";
  }
}

export class HtmlRenderPreviewError extends Schema.TaggedErrorClass<HtmlRenderPreviewError>()(
  "HtmlRenderPreviewError",
  { message: Schema.String },
) {}

export interface HtmlPreview {
  readonly png: string;
  readonly width: number;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<{
    readonly level: "log" | "info" | "warning" | "error";
    readonly text: string;
  }>;
  readonly missingImages?: ReadonlyArray<string>;
}

export type HtmlRenderPrepareError =
  | HtmlRenderImagesNotFoundError
  | HtmlRenderImageTooLargeError
  | HtmlRenderPageTooLargeError
  | HtmlRenderViewportHeightError;

export interface HtmlRenderShape {
  /** The self-contained page that gets stored: local images inlined, theme bootstrap injected. */
  readonly prepare: (
    html: string,
    cwd: string | null,
  ) => Effect.Effect<string, HtmlRenderPrepareError>;
  /** Stores a prepared page as a thread attachment for clients to show inline. */
  readonly publish: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string | null;
    readonly html: string;
    readonly title: string;
    readonly height: number;
  }) => Effect.Effect<HtmlRenderReference, HtmlRenderPrepareError | HtmlRenderStoreError>;
  /** Screenshots an unpublished page in Moss's dedicated headless browser. */
  readonly preview: (input: {
    readonly html: string;
    readonly width?: number;
    readonly appearance?: ThemeAppearance;
  }) => Effect.Effect<
    HtmlPreview,
    Exclude<HtmlRenderPrepareError, HtmlRenderImagesNotFoundError> | HtmlRenderPreviewError
  >;
}

export class HtmlRender extends ServiceMap.Service<HtmlRender, HtmlRenderShape>()(
  "moss/htmlRender/HtmlRender",
) {}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

const findLocalImages = (html: string) =>
  Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
const isImageBytes = (bytes: Uint8Array) => {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

/** The index just past `token` at or after `from`, or -1 when it never appears. */
const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

/** The index just past a doctype whose body starts at `from`, honoring quotes and its internal subset. */
const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

/** Replaces every local image reference with a data URI; unreadable paths stay as written. */
const inlineLocalImages = Effect.fn("HtmlRender.inlineLocalImages")(function* (html: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const references = findLocalImages(html);
  const files = yield* Effect.forEach(
    [...new Set(references.map((reference) => reference.path))],
    (path) =>
      fileSystem.stat(filePathFor(path)).pipe(
        Effect.map((info) => ({
          path,
          size: info.type === "File" ? Number(info.size) : undefined,
        })),
        Effect.orElseSucceed(() => ({ path, size: undefined })),
      ),
    { concurrency: 8 },
  );
  const oversized = files.find((file) => file.size !== undefined && file.size > MAX_IMAGE_BYTES);
  if (oversized?.size !== undefined) {
    return yield* new HtmlRenderImageTooLargeError({
      path: oversized.path,
      sizeBytes: oversized.size,
    });
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total +
          dataUriPrefix(reference.path).length +
          Math.ceil(size / 3) * 4 -
          Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: pageBytes });
  }
  // Files can grow after `stat`. Each read stops one byte past the image
  // limit, and reading stops once the images read so far cannot fit the page.
  let readBytes = 0;
  const images = yield* Effect.forEach(
    files.filter((file) => file.size !== undefined),
    (file) =>
      Effect.gen(function* () {
        const read = yield* fileSystem
          .stream(filePathFor(file.path), { bytesToRead: MAX_IMAGE_BYTES + 1 })
          .pipe(Stream.mkUint8Array, Effect.option);
        if (Option.isNone(read) || !isImageBytes(read.value)) return [];
        const bytes = read.value;
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return yield* new HtmlRenderImageTooLargeError({
            path: file.path,
            sizeBytes: bytes.byteLength,
          });
        }
        readBytes += Math.ceil(bytes.byteLength / 3) * 4;
        if (readBytes > MAX_PAGE_BYTES) {
          return yield* new HtmlRenderPageTooLargeError({ sizeBytes: readBytes });
        }
        return [{ path: file.path, bytes }];
      }),
    { concurrency: 4 },
  ).pipe(Effect.map((entries) => entries.flat()));
  const dataUris = new Map(
    images.map(
      (image) =>
        // Node's encoder: images run to 10 MiB.
        [
          image.path,
          dataUriPrefix(image.path) + Buffer.from(image.bytes).toString("base64"),
        ] as const,
    ),
  );
  const parts: Array<string> = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: inlinedBytes });
  }
  return {
    html: inlined,
    missing: files.filter((file) => !dataUris.has(file.path)).map((file) => file.path),
  };
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const previewBrowserDirectory = `${config.baseDir}/tools/html-preview-browser`;
  let resolvingPreviewBrowserExecutable: Promise<string | undefined> | null = null;
  const runtimeRequire = createRequire(import.meta.url);
  const bundledPlaywright = () =>
    resolveBundledPlaywrightPaths((specifier) => runtimeRequire.resolve(specifier));

  const previewBrowserInstaller = makeSharedPreviewBrowserInstaller({
    install: async () => {
      const manifest = playwrightHeadlessShellManifestEntry(
        readFileSync(bundledPlaywright().browsersManifestPath, "utf8"),
      );
      await installDedicatedHeadlessShell({
        browserDirectory: previewBrowserDirectory,
        ...manifest,
      });
      // A missing executable was cached before installation. The next preview
      // must look in the now-populated dedicated directory again.
      resolvingPreviewBrowserExecutable = null;
    },
  });

  /** Returns only Moss's dedicated headless shell, never a user-installed browser. */
  const dedicatedBrowserExecutable = async () => {
    if (resolvingPreviewBrowserExecutable !== null) return resolvingPreviewBrowserExecutable;
    resolvingPreviewBrowserExecutable = Promise.resolve(
      dedicatedHeadlessShellExecutable(previewBrowserDirectory),
    );
    return resolvingPreviewBrowserExecutable;
  };

  const runPreviewPage = async <A>(input: {
    readonly html: string;
    readonly width: number;
    readonly appearance: ThemeAppearance;
    readonly installWhenMissing: boolean;
    readonly beforeLoad?: (page: import("playwright").Page) => void;
    readonly action: (page: import("playwright").Page) => Promise<A>;
  }): Promise<A> => {
    let executable = await dedicatedBrowserExecutable();
    if (executable === undefined) {
      if (!input.installWhenMissing) {
        throw new Error("Moss's dedicated headless preview browser is not installed.");
      }
      // Preview callers wait for the one shared, bounded install. Publish uses
      // `installWhenMissing: false`, so storing a reader-visible page never
      // waits for a browser download or launch.
      await previewBrowserInstaller.waitForInstall();
      executable = await dedicatedBrowserExecutable();
      if (executable === undefined) {
        throw new Error("Moss installed its headless preview browser, but could not find it.");
      }
    }
    const { chromium } = await import("playwright");
    const proxy = await startPublicProxy();
    let browser: import("playwright").Browser | undefined;
    try {
      browser = await chromium.launch({
        executablePath: executable,
        headless: true,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--block-new-web-contents",
          `--proxy-server=socks5://127.0.0.1:${proxy.port}`,
          // Chromium otherwise skips the proxy for loopback, where a page could reach Moss.
          "--proxy-bypass-list=<-loopback>",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
      const page = await browser.newPage({ viewport: { width: input.width, height: 800 } });
      await page.emulateMedia({ colorScheme: input.appearance });
      input.beforeLoad?.(page);
      await page.setContent(input.html, { waitUntil: "load", timeout: 20_000 });
      await page.evaluate(
        "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
      );
      return await input.action(page);
    } finally {
      await browser?.close();
      await proxy.close();
    }
  };

  const capturePreview = async (input: {
    readonly html: string;
    readonly width: number;
    readonly appearance: ThemeAppearance;
  }): Promise<Omit<HtmlPreview, "missingImages">> => {
    const consoleMessages: Array<HtmlPreview["consoleMessages"][number]> = [];
    const captureConsole = (
      level: HtmlPreview["consoleMessages"][number]["level"],
      text: string,
    ) => {
      if (consoleMessages.length < MAX_CONSOLE_MESSAGES) {
        consoleMessages.push({ level, text: text.slice(0, 500) });
      }
    };
    return runPreviewPage({
      ...input,
      installWhenMissing: true,
      beforeLoad: (page) => {
        page.on("console", (message) => {
          const type = message.type();
          captureConsole(
            type === "error"
              ? "error"
              : type === "warning"
                ? "warning"
                : type === "info"
                  ? "info"
                  : "log",
            message.text(),
          );
        });
        page.on("pageerror", (error) => captureConsole("error", error.stack ?? error.message));
      },
      action: async (page) => {
        const contentHeight = await page.evaluate<number>(
          "(() => { const root = document.documentElement; return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height); })()",
        );
        const capturedHeight = Math.min(MAX_CAPTURE_HEIGHT, Math.max(1, contentHeight));
        const png = (
          await page.screenshot({
            type: "png",
            clip: { x: 0, y: 0, width: input.width, height: capturedHeight },
          })
        ).toString("base64");
        return { png, width: input.width, contentHeight, capturedHeight, consoleMessages };
      },
    });
  };

  const measure = async (
    html: string,
  ): Promise<ReadonlyArray<readonly [number, number]> | undefined> => {
    const timeout = new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), MEASURE_TIMEOUT_MS),
    );
    let next = 0;
    const results: Array<readonly [number, number]> = [];
    const measureOne = async () => {
      while (next < HTML_RENDER_MEASURE_WIDTHS.length) {
        const width = HTML_RENDER_MEASURE_WIDTHS[next++]!;
        results.push(
          await runPreviewPage({
            html,
            width,
            appearance: "dark",
            installWhenMissing: false,
            action: async (page) => {
              const height = await page.evaluate<number>(
                "(() => { const root = document.documentElement; return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height); })()",
              );
              return [width, height] as const;
            },
          }),
        );
      }
    };
    // Browser starts are memory-heavy. T3 likewise permits only two at once.
    const measured = Promise.all([measureOne(), measureOne()]).then(() =>
      results.toSorted(([left], [right]) => left - right),
    );
    return Promise.race([measured, timeout]).catch(() => undefined);
  };

  // The bootstrap goes in first so its head scan never runs over inlined image data.
  const inline = (html: string) =>
    inlineLocalImages(injectHtmlRenderBootstrap(html)).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

  const prepare = Effect.fn("HtmlRender.prepare")(function* (html: string, _cwd: string | null) {
    yield* rejectViewportHeight(html);
    const inlined = yield* inline(html);
    if (inlined.missing.length > 0) {
      return yield* new HtmlRenderImagesNotFoundError({ paths: inlined.missing });
    }
    return inlined.html;
  });

  const publish = Effect.fn("HtmlRender.publish")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string | null;
    readonly html: string;
    readonly title: string;
    readonly height: number;
  }) {
    const html = yield* prepare(input.html, input.cwd);
    // The attachments route serves `.html` attachments as sandboxed documents.
    const attachmentId = createAttachmentId(input.threadId);
    const filePath =
      attachmentId === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.html`,
          });
    if (attachmentId === null || filePath === null) {
      return yield* new HtmlRenderStoreError({ cause: new Error("Invalid thread id.") });
    }
    yield* fileSystem.writeFileString(filePath, html).pipe(
      Effect.mapError((cause) => new HtmlRenderStoreError({ cause })),
      // Only the returned reference lets retention find the page, so a publish
      // that fails or is interrupted before returning removes it.
      Effect.onError(() => fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)),
    );
    // Measuring is opportunistic: an absent browser, a network failure, or the bounded wait
    // never delays publishing a reply. Its only effect is a better initial frame height.
    const heights = yield* Effect.tryPromise({
      try: () => measure(html),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    return {
      attachmentId,
      title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
      height: clampHtmlRenderHeight(input.height),
      ...(heights === undefined ? {} : { heights }),
    } satisfies HtmlRenderReference;
  });

  const preview = Effect.fn("HtmlRender.preview")(function* (input: {
    readonly html: string;
    readonly width?: number;
    readonly appearance?: ThemeAppearance;
  }) {
    const width = Math.min(
      MAX_PREVIEW_WIDTH,
      Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH)),
    );
    const appearance = input.appearance ?? "dark";
    yield* rejectViewportHeight(input.html);
    const inlined = yield* inline(input.html);
    const screenshot = yield* Effect.tryPromise({
      try: () => capturePreview({ html: inlined.html, width, appearance }),
      catch: (cause) =>
        new HtmlRenderPreviewError({
          message: cause instanceof Error ? cause.message : "Headless preview failed.",
        }),
    });
    return {
      ...screenshot,
      ...(inlined.missing.length === 0 ? {} : { missingImages: inlined.missing }),
    } satisfies HtmlPreview;
  });

  return { prepare, publish, preview } satisfies HtmlRenderShape;
});

export const HtmlRenderLive = Layer.effect(HtmlRender, make);
