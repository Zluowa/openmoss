// FILE: libraryImage.ts
// Purpose: Read bounded, indexed raster images without exposing client-selected paths.
// Layer: Server library media
import fs from "node:fs/promises";
import path from "node:path";

import { GUEST_MEDIA_MAX_BYTES, type LibraryItem } from "@moss/contracts";

import { sniffGuestMediaType } from "../guestShare/guestSharedResources.ts";
import { isPathInsideLibraryRoot, type LibraryScanRootSpec } from "./libraryScan.ts";

export interface LibraryImage {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export const LIBRARY_IMAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
} as const;

const pathKey = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

/** Reuse the guest image signature checks; SVG has no trusted sanitization path here. */
export function libraryImageMimeType(bytes: Uint8Array): LibraryImage["mimeType"] | null {
  if (bytes.byteLength === 0 || bytes.byteLength > GUEST_MEDIA_MAX_BYTES) return null;
  const type = sniffGuestMediaType("", bytes.subarray(0, 4096));
  return type === "image/svg+xml" ? null : type;
}

/** Only indexed, live images under their configured source root can be read. */
export async function readLibraryImage(
  item: LibraryItem,
  roots: readonly LibraryScanRootSpec[],
): Promise<LibraryImage | null> {
  if (item.trashedAt !== null || item.path === null) return null;
  const candidate = path.resolve(item.path);
  const root = roots.find(
    (entry) => entry.source === item.source && isPathInsideLibraryRoot(candidate, entry.dir),
  );
  if (!root) return null;
  try {
    // Resolve both ends and reject aliases, including links in ancestor directories.
    const [realRoot, realFile, before] = await Promise.all([
      fs.realpath(root.dir),
      fs.realpath(candidate),
      fs.lstat(candidate),
    ]);
    if (
      pathKey(realRoot) !== pathKey(root.dir) ||
      pathKey(realFile) !== pathKey(candidate) ||
      !isPathInsideLibraryRoot(realFile, realRoot) ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size === 0 ||
      before.size > GUEST_MEDIA_MAX_BYTES
    )
      return null;
    const handle = await fs.open(candidate, "r");
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
        return null;
      // Bounded even if a writer grows the file between stat and read.
      const bytes = new Uint8Array(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const [after, realAfter] = await Promise.all([fs.lstat(candidate), fs.realpath(candidate)]);
      if (
        length !== opened.size ||
        after.ino !== opened.ino ||
        after.dev !== opened.dev ||
        after.nlink !== 1 ||
        after.isSymbolicLink() ||
        pathKey(realAfter) !== pathKey(candidate)
      )
        return null;
      const body = bytes.subarray(0, length);
      const mimeType = libraryImageMimeType(body);
      return mimeType === null ? null : { bytes: body, mimeType };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
