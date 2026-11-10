/**
 * What a guest may load beside the transcript text: the pages the agent published with
 * `html_render`, and the pictures the agent's output shows from the owner's disk. A guest gets
 * only what its stream already shows (the sanitized snapshot window), never a file merely
 * because its path is known. Pictures are images by their bytes, not their names, and stay
 * under a size cap; the paths themselves never leave this module in a response.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  GUEST_FILE_MAX_BYTES,
  GUEST_MEDIA_MAX_BYTES,
  GUEST_RENDER_MAX_BYTES,
  INLINE_VISUAL_ACTIVITY_KIND,
  INLINE_VISUAL_ACTIVITY_KIND_UPSTREAM_ALIAS,
  type InlineVisualFormat,
  type GuestMessageAttachment,
  type OrchestrationThread,
} from "@moss/contracts";
import type { HtmlRenderReference } from "@moss/shared/htmlRender";
import { htmlRenderFromActivity } from "@moss/shared/htmlRenderActivity";
import { isSupportedLocalImagePath } from "@moss/shared/localPreviewFiles";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";
import { localPreviewPathCandidates, resolveAllowedLocalPreviewFile } from "../localImageFiles.ts";
import { matchesImageSignature } from "./guestAttachments.ts";

type GuestThreadView = Pick<OrchestrationThread, "id" | "messages" | "activities">;

// ── Pages ───────────────────────────────────────────────────────────

/** A published page of the shared window, and where it is stored; null when it is not one. */
export function findGuestHtmlRender(
  thread: GuestThreadView,
  attachmentId: string,
  attachmentsDir: string,
): { readonly reference: HtmlRenderReference; readonly path: string } | null {
  // Only ids minted for this thread: a fork's page belongs to the thread it was published in.
  if (!threadHtmlRenderAttachmentIds(thread.id, thread.activities).includes(attachmentId)) {
    return null;
  }
  const reference = thread.activities
    .map((activity) => htmlRenderFromActivity(activity))
    .find((candidate) => candidate?.attachmentId === attachmentId);
  if (reference === undefined) return null;
  const pagePath = resolveAttachmentRelativePath({
    attachmentsDir,
    relativePath: `${attachmentId}.html`,
  });
  return pagePath === null ? null : { reference, path: pagePath };
}

/** The page's size when it is a file the route may serve, else null. */
export async function guestHtmlRenderSize(pagePath: string): Promise<number | null> {
  const info = await fs.stat(pagePath).catch(() => null);
  if (info === null || !info.isFile() || info.size > GUEST_RENDER_MAX_BYTES) return null;
  return info.size;
}

// ── Tool media ──────────────────────────────────────────────────────

const LOCAL_ARTIFACT_SCAN_DEPTH = 8;

/**
 * A stored file a tool result in the shared window shows (an MCP tool's image or audio, kept
 * as a managed attachment), as the attachment route serves it; null when no result shows it.
 */
export function findGuestLocalArtifact(
  thread: GuestThreadView,
  attachmentId: string,
): GuestMessageAttachment | null {
  const visit = (value: unknown, depth: number): GuestMessageAttachment | null => {
    if (depth > LOCAL_ARTIFACT_SCAN_DEPTH || value === null || typeof value !== "object") {
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    const block = value as Record<string, unknown>;
    if (
      block.type === "local_artifact" &&
      block.attachmentId === attachmentId &&
      typeof block.mimeType === "string" &&
      typeof block.sizeBytes === "number"
    ) {
      const name = typeof block.name === "string" && block.name !== "" ? block.name : "file";
      return block.mediaKind === "image"
        ? {
            type: "image",
            id: attachmentId,
            name,
            mimeType: block.mimeType,
            sizeBytes: block.sizeBytes,
          }
        : {
            type: "file",
            id: attachmentId,
            name,
            mimeType: block.mimeType,
            sizeBytes: block.sizeBytes,
          };
    }
    for (const nested of Object.values(block)) {
      const found = visit(nested, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  for (const activity of thread.activities) {
    const found = visit(activity.payload, 0);
    if (found !== null) return found;
  }
  return null;
}

// ── Pictures ────────────────────────────────────────────────────────

/**
 * One spelling of a local path for comparison: forward slashes, no `file://`, percent-decoded,
 * and case-folded on Windows, where paths are case-insensitive.
 */
export function normalizeLocalReference(value: string, platform = process.platform): string {
  let text = value.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1);
  text = text.replace(/^file:\/\//iu, "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // A literal `%` stays as written.
  }
  text = text.replaceAll("\\", "/");
  // `file:///C:/x` leaves `/C:/x`.
  if (/^\/[a-z]:\//iu.test(text)) text = text.slice(1);
  return platform === "win32" ? text.toLowerCase() : text;
}

/** Text that the agent wrote or recorded, in one comparable spelling. */
function normalizeHaystack(text: string, platform: NodeJS.Platform): string {
  // JSON escapes a backslash as two; both spellings of a Windows path become `/`.
  const slashes = text.replaceAll("\\\\", "/").replaceAll("\\", "/");
  return platform === "win32" ? slashes.toLowerCase() : slashes;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The file of a finished generated-image record (Codex or Moss media), if this is one. */
function generatedImagePathOf(payload: unknown): string | null {
  const data = record(record(payload)?.data);
  const top = record(payload);
  if (top?.itemType !== "image_generation" || top.status !== "completed") return null;
  const kind = data?.kind;
  const filePath = data?.path;
  return (kind === "codex.generated_image" || kind === "moss.generated_image") &&
    typeof filePath === "string" &&
    filePath.length > 0
    ? filePath
    : null;
}

/** Where the shared window names pictures: the agent's replies and its recorded work. */
export interface GuestImageMentions {
  /** The agent's replies and activity payloads, normalized for comparison. */
  readonly haystacks: ReadonlyArray<string>;
  /** Normalized files of finished generated-image records: the server saved these itself. */
  readonly generatedPaths: ReadonlySet<string>;
}

export function guestImageMentions(
  thread: GuestThreadView,
  platform: NodeJS.Platform = process.platform,
): GuestImageMentions {
  const haystacks: Array<string> = [];
  const generatedPaths = new Set<string>();
  for (const message of thread.messages) {
    // A user turn can carry a guest's words; only the agent's output decides what is shown.
    if (message.role === "assistant" && message.text.length > 0) {
      haystacks.push(normalizeHaystack(message.text, platform));
    }
  }
  for (const activity of thread.activities) {
    const generated = generatedImagePathOf(activity.payload);
    if (generated !== null) generatedPaths.add(normalizeLocalReference(generated, platform));
    let json: string;
    try {
      json = JSON.stringify(activity.payload) ?? "";
    } catch {
      continue;
    }
    if (json.length > 0) haystacks.push(normalizeHaystack(json, platform));
  }
  return { haystacks, generatedPaths };
}

/** Whether the shared window names this picture source. */
export function isMentionedImageSource(
  mentions: GuestImageMentions,
  src: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const needle = normalizeLocalReference(src, platform);
  if (needle.length === 0) return false;
  if (mentions.generatedPaths.has(needle)) return true;
  return mentions.haystacks.some((haystack) => haystack.includes(needle));
}

/** Image types the guest page shows, by their bytes. */
export type GuestMediaMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/svg+xml";

const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const SNIFF_BYTES = 4096;

/**
 * Whether an XML document's root element is `<svg>`, after an optional byte-order mark, XML
 * declaration, comments, and doctype. Never a full parse: an SVG goes out under a sandbox policy
 * and loads as an image, so this only keeps other text from passing as a picture.
 */
export function hasSvgRoot(text: string): boolean {
  let rest = text.replace(/^\uFEFF/u, "");
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("<?")) {
      const end = rest.indexOf("?>");
      if (end === -1) return false;
      rest = rest.slice(end + 2);
      continue;
    }
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end === -1) return false;
      rest = rest.slice(end + 3);
      continue;
    }
    if (/^<!doctype/iu.test(rest)) {
      const end = rest.indexOf(">");
      if (end === -1) return false;
      rest = rest.slice(end + 1);
      continue;
    }
    return /^<svg[\s>/]/u.test(rest);
  }
}

/** The picture's type by its first bytes and its name; null for anything the page won't show. */
export function sniffGuestMediaType(filePath: string, head: Uint8Array): GuestMediaMimeType | null {
  for (const type of RASTER_TYPES) {
    if (matchesImageSignature(type, head)) return type;
  }
  if (path.extname(filePath).toLowerCase() === ".svg") {
    return hasSvgRoot(new TextDecoder().decode(head.subarray(0, SNIFF_BYTES)))
      ? "image/svg+xml"
      : null;
  }
  return null;
}

function isInsideGeneratedImagesDirectory(candidate: string): boolean {
  return candidate.split(/[\\/]/u).slice(0, -1).includes("generated_images");
}

export interface GuestSharedImage {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mimeType: GuestMediaMimeType;
}

/**
 * The picture behind a source the shared window names. It must resolve (against the thread's
 * folder when relative) to an image file the owner's own transcript would show without asking:
 * one in the thread's workspace or a scratch or temporary folder, an agent's `generated_images`
 * folder, or a file a generated-image record names. Then its bytes must be an image of a type the
 * page shows, under the size cap.
 */
export async function resolveGuestSharedImage(input: {
  readonly src: string;
  readonly cwd: string | null;
  readonly mentions: GuestImageMentions;
  readonly scratchWorkspacesRoot?: string;
  readonly platform?: NodeJS.Platform;
}): Promise<GuestSharedImage | null> {
  const platform = input.platform ?? process.platform;
  if (!isMentionedImageSource(input.mentions, input.src, platform)) return null;
  let realPath: string | null = null;
  for (const candidate of localPreviewPathCandidates(input.src)) {
    if (!path.isAbsolute(candidate) && input.cwd === null) continue;
    const resolved = path.resolve(input.cwd ?? path.sep, candidate);
    realPath = await fs.realpath(resolved).catch(() => null);
    if (realPath !== null) break;
  }
  if (realPath === null || !isSupportedLocalImagePath(realPath)) return null;
  const info = await fs.stat(realPath).catch(() => null);
  if (info === null || !info.isFile() || info.size === 0 || info.size > GUEST_MEDIA_MAX_BYTES) {
    return null;
  }
  const allowed =
    input.mentions.generatedPaths.has(normalizeLocalReference(input.src, platform)) ||
    input.mentions.generatedPaths.has(normalizeLocalReference(realPath, platform)) ||
    isInsideGeneratedImagesDirectory(realPath) ||
    (await resolveAllowedLocalPreviewFile({
      requestedPath: input.src,
      cwd: input.cwd,
      // No Codex homes: their plugin artwork is not the conversation's.
      codexHomePaths: [],
      ...(input.scratchWorkspacesRoot === undefined
        ? {}
        : { scratchWorkspacesRoot: input.scratchWorkspacesRoot }),
    }).catch(() => null)) !== null;
  if (!allowed) return null;
  const handle = await fs.open(realPath, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const head = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
    const mimeType = sniffGuestMediaType(realPath, head.subarray(0, bytesRead));
    return mimeType === null ? null : { path: realPath, sizeBytes: info.size, mimeType };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ── Inline visuals ──────────────────────────────────────────────────

/** An inline visual (`moss_show_visual`) the shared window shows; null when it shows none. */
export function findGuestInlineVisual(
  thread: GuestThreadView,
  visualId: string,
): { readonly title: string; readonly format: InlineVisualFormat } | null {
  if (!/^vis_[0-9a-f]{32}$/u.test(visualId)) return null;
  for (const activity of thread.activities) {
    if (
      activity.kind !== INLINE_VISUAL_ACTIVITY_KIND &&
      activity.kind !== INLINE_VISUAL_ACTIVITY_KIND_UPSTREAM_ALIAS
    ) {
      continue;
    }
    const payload = record(activity.payload);
    if (payload?.visualId !== visualId) continue;
    const format = payload.format;
    return {
      title: typeof payload.title === "string" && payload.title !== "" ? payload.title : "Visual",
      format: format === "openui" || format === "components" ? format : "html",
    };
  }
  return null;
}

// ── Linked files ────────────────────────────────────────────────────

/**
 * What the agent's replies name, in one comparable spelling, and the files the window's turns
 * changed (the "edited files" card and the page cards already show those names). Files the
 * viewer pane opens come only from here: tool calls touch many files, but only a file the agent
 * put in its answer or in a turn's change list is part of what the reader sees.
 */
export function guestReplyMentions(
  thread: GuestThreadView & { readonly checkpoints?: OrchestrationThread["checkpoints"] },
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  const replies = thread.messages.flatMap((message) =>
    message.role === "assistant" && message.text.length > 0
      ? [normalizeHaystack(message.text, platform)]
      : [],
  );
  const changed = (thread.checkpoints ?? []).flatMap((checkpoint) =>
    checkpoint.status === "ready"
      ? checkpoint.files.map((file) => normalizeHaystack(file.path, platform))
      : [],
  );
  return [...replies, ...changed];
}

const SECRET_FILE_NAME =
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.json)?|secrets?(?:\..*)?|.*-key-.*\.txt|\.npmrc|\.netrc|\.pypirc|auth\.json)$/iu;

/**
 * Whether a file under a shared root may reach a guest: never inside a hidden folder or
 * `node_modules`, never a hidden file (`.git`, `.env`, an agent's own state), and never a file
 * named like a key or credential, whatever the agent wrote about it.
 */
export function isShareableRelativePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u).filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment.startsWith(".") || segment === "node_modules")) {
    return false;
  }
  return !SECRET_FILE_NAME.test(segments.at(-1) ?? "");
}

function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

export interface GuestLinkedFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

const VIDEO_TYPES: Readonly<Record<string, "video/mp4" | "video/webm">> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
};

/** A file's type for the `file` route: pictures and web videos by their bytes, else bytes. */
export function guestFileMimeType(filePath: string, head: Uint8Array): string {
  for (const type of RASTER_TYPES) {
    if (matchesImageSignature(type, head)) return type;
  }
  const video = VIDEO_TYPES[path.extname(filePath).toLowerCase()];
  if (video === "video/mp4" && new TextDecoder().decode(head.subarray(4, 8)) === "ftyp") {
    return video;
  }
  if (
    video === "video/webm" &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return video;
  }
  return "application/octet-stream";
}

/**
 * The file behind a link in the agent's reply, for the guest's viewer pane. The reply must name
 * it, and it must resolve (against the thread's folder when relative) to a shareable file inside
 * that folder or a scratch workspace, under `GUEST_FILE_MAX_BYTES`. Paths never leave this
 * module in a response.
 */
export async function resolveGuestLinkedFile(input: {
  readonly src: string;
  readonly cwd: string | null;
  readonly replies: ReadonlyArray<string>;
  readonly scratchWorkspacesRoot?: string;
  readonly platform?: NodeJS.Platform;
}): Promise<GuestLinkedFile | null> {
  const platform = input.platform ?? process.platform;
  const needle = normalizeLocalReference(input.src, platform);
  if (needle.length === 0 || !input.replies.some((reply) => reply.includes(needle))) return null;
  const roots: Array<string> = [];
  for (const root of [input.cwd, input.scratchWorkspacesRoot]) {
    if (root === null || root === undefined) continue;
    const real = await fs.realpath(root).catch(() => null);
    if (real !== null) roots.push(real);
  }
  if (roots.length === 0) return null;
  let realPath: string | null = null;
  for (const candidate of localPreviewPathCandidates(input.src)) {
    if (!path.isAbsolute(candidate) && input.cwd === null) continue;
    realPath = await fs.realpath(path.resolve(input.cwd ?? path.sep, candidate)).catch(() => null);
    if (realPath !== null) break;
  }
  if (realPath === null) return null;
  const resolved = realPath;
  const relative = roots
    .map((root) => relativeInside(root, resolved))
    .find((value): value is string => value !== null);
  if (relative === undefined || !isShareableRelativePath(relative)) return null;
  const info = await fs.stat(resolved).catch(() => null);
  if (info === null || !info.isFile() || info.size > GUEST_FILE_MAX_BYTES) return null;
  const handle = await fs.open(resolved, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const head = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
    return {
      path: resolved,
      name: path.basename(resolved),
      sizeBytes: info.size,
      mimeType: guestFileMimeType(resolved, head.subarray(0, bytesRead)),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ── Visualization markers ───────────────────────────────────────────

const LIBRARY_REFERENCE = /\/inline-visualization-libs\/([A-Za-z0-9._-]+)/gu;

export type InlineVisualizationLibraryReader = (
  name: string,
) => Promise<{ readonly contents: Uint8Array; readonly contentType: string } | null>;

/**
 * A visualization document with its shipped libraries inlined as `data:` URLs. The owner's frame
 * loads them from the owner's server; a guest's frame is served by the relay, which does not
 * carry them, so the document brings its own copies. Fonts inside the stylesheet are inlined too.
 */
export async function inlineVisualizationLibraries(
  document: string,
  readLibrary: InlineVisualizationLibraryReader,
): Promise<string> {
  const names = new Set(Array.from(document.matchAll(LIBRARY_REFERENCE), (match) => match[1]!));
  const dataUrls = new Map<string, string>();
  for (const name of names) {
    const library = await readLibrary(name);
    if (library === null) continue;
    let bytes = library.contents;
    if (name.endsWith(".css")) {
      const css = await inlineVisualizationLibraries(new TextDecoder().decode(bytes), readLibrary);
      bytes = new TextEncoder().encode(css);
    }
    const type = library.contentType.split(";", 1)[0];
    dataUrls.set(name, `data:${type};base64,${Buffer.from(bytes).toString("base64")}`);
  }
  return document.replace(LIBRARY_REFERENCE, (whole, name: string) => dataUrls.get(name) ?? whole);
}

// ── Turn changes ────────────────────────────────────────────────────

/**
 * A turn's patch with the sections a guest may not see left out: files in hidden folders or
 * dependencies, and credential-shaped names, by the same rule as linked files. The rest is the
 * change the owner's own "review changes" shows.
 */
export function shareableTurnDiff(diff: string): string {
  const sections = diff.split(/^(?=diff --git )/mu);
  return sections
    .filter((section) => {
      if (!section.startsWith("diff --git ")) return section.trim().length === 0;
      const header = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/mu.exec(section);
      if (header === null) return false;
      return [header[1], header[2]].every(
        (name) => name !== undefined && isShareableRelativePath(name),
      );
    })
    .join("");
}

// ── Linked pages ────────────────────────────────────────────────────

/**
 * The policy a linked HTML file runs under on the guest page, as in the owner's file preview:
 * its own inline code and `data:` media only, nothing from the network, no forms sent anywhere.
 */
export const GUEST_LINKED_PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const LEADING_DOCTYPE = /^﻿?\s*<!doctype[^>]*>/iu;

/**
 * The page with that policy as its first element, ahead of every byte of the file, so even a
 * page that opens with a script runs under it. A page may add policies, never relax this one.
 */
export function withOfflinePagePolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${GUEST_LINKED_PAGE_CONTENT_SECURITY_POLICY}">`;
  const doctype = LEADING_DOCTYPE.exec(html)?.[0];
  return doctype === undefined
    ? `${meta}${html}`
    : `${doctype}${meta}${html.slice(doctype.length)}`;
}
