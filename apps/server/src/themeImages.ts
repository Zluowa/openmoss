// FILE: themeImages.ts
// Purpose: The store of pictures themes use: files under `<stateDir>/theme-images`, named by the
//          SHA-256 of their bytes and their real type, so theme CSS and settings carry a short
//          reference (`moss-theme-image:<id>`) instead of the picture itself.
// Layer: Server storage
// Exports: themeImagesDir, sniffThemeImage, storeThemeImageBytes, storeThemeImageFile,
//          resolveThemeImagePath, sweepThemeImages, ThemeImageError
//
// Cleanup: a stored picture is kept while the theme an agent published refers to it, and while
// any window says one of its saved themes uses it: each window reports the pictures of both its
// packs when it starts and whenever they change (`keepThemeImages`), which sets the file's time.
// Loads do not count, because a browser serves a picture from its cache. Ten minutes after the
// server starts, a picture no published theme refers to and no window reported for 90 days is
// removed; a device that has not opened Moss for 90 days may then show its theme without the
// picture. Restoring the default look drops the references, so those pictures go 90 days later.
// Storing, reporting and cleanup take turns on one lock, so a picture reused or reported while
// the cleanup runs is never removed.

import { createHash, randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as NodePath from "node:path";

import type { MossPublishedTheme } from "@moss/contracts";
import {
  THEME_IMAGE_MAX_BYTES,
  isThemeImageId,
  themeCssImageIds,
  themeImageReference,
  type ThemeImageExtension,
} from "@moss/shared/themeCss";

export const THEME_IMAGE_UNUSED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class ThemeImageError extends Error {
  override readonly name = "ThemeImageError";
}

// One server process owns the store; its writers and the cleanup run one at a time.
let storeQueue: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(task, task);
  storeQueue = run.catch(() => undefined);
  return run;
}

export function themeImagesDir(stateDir: string): string {
  return NodePath.join(stateDir, "theme-images");
}

export interface SniffedThemeImage {
  readonly extension: ThemeImageExtension;
  /** Natural size in pixels, when the header states it (not for AVIF). */
  readonly width: number | null;
  readonly height: number | null;
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = u16be(bytes, offset + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return null;
}

/** The picture's real type from its first bytes, or null. SVG and every other type is refused. */
export function sniffThemeImage(bytes: Uint8Array): SniffedThemeImage | null {
  if (bytes.length >= 24 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) {
    return { extension: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return { extension: "jpg", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    return { extension: "gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const size = webpSize(bytes);
    return { extension: "webp", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(bytes, 8, 4))) {
    return { extension: "avif", width: null, height: null };
  }
  return null;
}

export interface StoredThemeImage extends SniffedThemeImage {
  readonly id: string;
  /** What theme CSS writes inside url(). */
  readonly reference: string;
  readonly bytes: number;
}

const TYPE_LIST = "PNG, JPEG, WebP, GIF or AVIF";

/** Store a picture under its content hash. Storing the same bytes again reuses the file. */
export async function storeThemeImageBytes(
  directory: string,
  bytes: Uint8Array,
  label = "The file",
): Promise<StoredThemeImage> {
  if (bytes.length === 0) throw new ThemeImageError(`${label} is empty.`);
  if (bytes.length > THEME_IMAGE_MAX_BYTES) {
    throw new ThemeImageError(
      `${label} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; a theme picture can be at most ${THEME_IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const sniffed = sniffThemeImage(bytes);
  if (!sniffed) {
    throw new ThemeImageError(
      `${label} is not a ${TYPE_LIST} picture (checked by its content, not its name). SVG is not accepted.`,
    );
  }
  const id = `${createHash("sha256").update(bytes).digest("hex")}.${sniffed.extension}`;
  return withStoreLock(() => writeThemeImage(directory, bytes, sniffed, id));
}

async function writeThemeImage(
  directory: string,
  bytes: Uint8Array,
  sniffed: SniffedThemeImage,
  id: string,
): Promise<StoredThemeImage> {
  await FS.mkdir(directory, { recursive: true });
  const target = NodePath.join(directory, id);
  const existing = await FS.stat(target).catch(() => null);
  if (existing?.isFile() && existing.size === bytes.length) {
    await FS.utimes(target, new Date(), new Date()).catch(() => undefined);
  } else {
    // Write beside it, then rename: a reader never sees half a picture.
    const temporary = NodePath.join(directory, `.${id}.${randomUUID()}.tmp`);
    await FS.writeFile(temporary, bytes);
    await FS.rename(temporary, target).catch(async (error: unknown) => {
      await FS.rm(temporary, { force: true });
      throw error;
    });
  }
  return { ...sniffed, id, reference: themeImageReference(id), bytes: bytes.length };
}

/**
 * A path that reaches another computer or a device: `\\host\share`, `//host/share`, and the
 * `\\?\`, `\\.\` and `\\??\` forms. Opening one makes Windows connect to that host (and send
 * the person's sign-in handshake) or open a device, so only local drive paths are accepted.
 */
export function isNetworkOrDevicePath(filePath: string): boolean {
  return /^[\\/]{2}/.test(filePath) || /^[\\/]\?\?[\\/]/.test(filePath);
}

/** Store the picture at an absolute path on this computer. */
export async function storeThemeImageFile(
  directory: string,
  filePath: string,
): Promise<StoredThemeImage> {
  // Checked by shape before anything else: on a system that is not Windows these are not
  // absolute paths, and the answer must still say why they are refused.
  if (isNetworkOrDevicePath(filePath)) {
    throw new ThemeImageError(
      `"${filePath}" is a network or device path. Copy the picture to a folder on this computer first.`,
    );
  }
  if (!NodePath.isAbsolute(filePath)) {
    throw new ThemeImageError(`"${filePath}" is not an absolute path.`);
  }
  // A link could point at a network share; follow it once and check where it goes.
  const link = await FS.lstat(filePath).catch(() => null);
  if (link?.isSymbolicLink()) {
    const target = await FS.readlink(filePath).catch(() => "");
    if (isNetworkOrDevicePath(target)) {
      throw new ThemeImageError(
        `"${filePath}" links to a network or device path. Copy the picture to a folder on this computer first.`,
      );
    }
  }
  const info = await FS.stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new ThemeImageError(`"${filePath}" is not a file Moss can read.`);
  if (info.size > THEME_IMAGE_MAX_BYTES) {
    throw new ThemeImageError(
      `"${filePath}" is ${(info.size / 1024 / 1024).toFixed(1)} MB; a theme picture can be at most ${THEME_IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const bytes = new Uint8Array(await FS.readFile(filePath));
  return storeThemeImageBytes(directory, bytes, `"${filePath}"`);
}

/** The stored file for `id`, or null when the id is malformed or nothing is stored under it. */
export async function resolveThemeImagePath(
  directory: string,
  id: string,
): Promise<{ readonly path: string; readonly sizeBytes: number } | null> {
  if (!isThemeImageId(id)) return null;
  const path = NodePath.join(directory, id);
  const info = await FS.lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (Date.now() - info.mtimeMs > TOUCH_INTERVAL_MS) {
    await FS.utimes(path, new Date(), new Date()).catch(() => undefined);
  }
  return { path, sizeBytes: info.size };
}

/**
 * A window says its saved themes use these pictures: set each stored file's time to now, so the
 * cleanup keeps it. Ids of another shape and ids not stored are ignored. Returns the ids kept.
 */
export function keepThemeImages(directory: string, ids: ReadonlyArray<string>): Promise<string[]> {
  return withStoreLock(async () => {
    const kept: string[] = [];
    for (const id of new Set(ids)) {
      if (!isThemeImageId(id)) continue;
      const path = NodePath.join(directory, id);
      const info = await FS.lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      await FS.utimes(path, new Date(), new Date()).catch(() => undefined);
      kept.push(id);
    }
    return kept;
  });
}

/** Ids of the pictures the theme an agent published refers to, in either pack. */
export function publishedThemeImageIds(theme: MossPublishedTheme | null | undefined): string[] {
  if (!theme) return [];
  return [
    ...new Set([
      ...themeCssImageIds(theme.light?.css ?? ""),
      ...themeCssImageIds(theme.dark?.css ?? ""),
    ]),
  ];
}

/**
 * Remove pictures no theme in `keep` refers to that nobody stored or loaded for 30 days, and
 * temporary files left by an interrupted write. Returns the removed ids.
 */
export function sweepThemeImages(
  directory: string,
  keep: ReadonlySet<string>,
  now = Date.now(),
): Promise<string[]> {
  return withStoreLock(() => sweepUnlocked(directory, keep, now));
}

async function sweepUnlocked(
  directory: string,
  keep: ReadonlySet<string>,
  now: number,
): Promise<string[]> {
  const names = await FS.readdir(directory).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of names) {
    const path = NodePath.join(directory, name);
    const info = await FS.lstat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const temporary = name.startsWith(".") && name.endsWith(".tmp");
    if (!temporary && (!isThemeImageId(name) || keep.has(name))) continue;
    if (now - info.mtimeMs < (temporary ? TOUCH_INTERVAL_MS : THEME_IMAGE_UNUSED_RETENTION_MS)) {
      continue;
    }
    // Look again right before removing: the time may have moved since the first look.
    const again = await FS.lstat(path).catch(() => null);
    const limit = temporary ? TOUCH_INTERVAL_MS : THEME_IMAGE_UNUSED_RETENTION_MS;
    if (!again?.isFile() || Date.now() - again.mtimeMs < limit || now - again.mtimeMs < limit) {
      continue;
    }
    await FS.rm(path, { force: true }).catch(() => undefined);
    if (!temporary) removed.push(name);
  }
  return removed;
}
