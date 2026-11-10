// FILE: mossPluginPackage.ts
// Purpose: The file format of one Moss plugin catalog package: a JSON document
//          listing a plugin folder's files (path, executable bit, base64 bytes),
//          gzipped on the mirror. The hash pinned in the catalog is the sha256
//          of the uncompressed JSON, so the check does not depend on which
//          gzip build compressed it. Server-only (Node APIs).
// Layer: Shared Node utility (the catalog build script encodes; the server decodes)
// Exports: encodeMossPluginPackage, decodeMossPluginPackage, sha256Hex, limits

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/** The package format the server unpacks; bumping it means a new mirror folder. */
export const MOSS_PLUGIN_PACKAGE_FORMAT = "moss-plugin-package";
export const MOSS_PLUGIN_PACKAGE_FORMAT_VERSION = 1;

/** Generous for a skills plugin; the largest catalog package is ~2.5 MB unpacked. */
export const MOSS_PLUGIN_PACKAGE_MAX_BYTES = 48 * 1024 * 1024;
export const MOSS_PLUGIN_PACKAGE_MAX_FILES = 4_000;

export interface MossPluginPackageFile {
  /** Relative, forward slashes, inside the plugin folder. */
  readonly path: string;
  readonly executable: boolean;
  readonly bytes: Uint8Array;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** No separators, no characters Windows forbids in names, no control characters. */
const SAFE_SEGMENT = /^[^<>:"|?*\\/\p{Cc}]+$/u;

/** A path the server may write under the plugin folder: relative, no `..`, no drive or device names. */
export function isSafeMossPluginPackagePath(path: string): boolean {
  if (path.length === 0 || path.length > 400 || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      SAFE_SEGMENT.test(segment) &&
      !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu.test(segment),
  );
}

/** The canonical JSON bytes (files sorted by path) and their gzip for the mirror. */
export function encodeMossPluginPackage(input: {
  readonly name: string;
  readonly version: string;
  readonly files: ReadonlyArray<MossPluginPackageFile>;
}): { readonly json: Uint8Array; readonly gzip: Uint8Array; readonly sha256: string } {
  const files = input.files.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const [index, file] of files.entries()) {
    if (!isSafeMossPluginPackagePath(file.path)) {
      throw new Error(`Unsafe plugin package path: ${file.path}`);
    }
    if (index > 0 && files[index - 1]?.path.toLowerCase() === file.path.toLowerCase()) {
      throw new Error(`Duplicate plugin package path: ${file.path}`);
    }
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      format: MOSS_PLUGIN_PACKAGE_FORMAT,
      formatVersion: MOSS_PLUGIN_PACKAGE_FORMAT_VERSION,
      name: input.name,
      version: input.version,
      files: files.map((file) => ({
        path: file.path,
        executable: file.executable,
        data: Buffer.from(file.bytes).toString("base64"),
      })),
    }),
  );
  return { json, gzip: gzipSync(json, { level: 9 }), sha256: sha256Hex(json) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unpacks a downloaded package after checking it is the one pinned in the
 * catalog. Throws on any mismatch; nothing is written by this function.
 */
export function decodeMossPluginPackage(input: {
  readonly gzip: Uint8Array;
  readonly expectedName: string;
  readonly expectedVersion: string;
  readonly expectedSha256: string;
}): ReadonlyArray<MossPluginPackageFile> {
  let json: Buffer;
  try {
    json = gunzipSync(input.gzip, { maxOutputLength: MOSS_PLUGIN_PACKAGE_MAX_BYTES });
  } catch {
    throw new Error("The plugin package is not a valid archive.");
  }
  if (sha256Hex(json) !== input.expectedSha256.toLowerCase()) {
    throw new Error("The plugin package does not match the catalog.");
  }
  const parsed: unknown = JSON.parse(json.toString("utf8"));
  if (
    !isRecord(parsed) ||
    parsed.format !== MOSS_PLUGIN_PACKAGE_FORMAT ||
    parsed.formatVersion !== MOSS_PLUGIN_PACKAGE_FORMAT_VERSION ||
    parsed.name !== input.expectedName ||
    parsed.version !== input.expectedVersion ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0 ||
    parsed.files.length > MOSS_PLUGIN_PACKAGE_MAX_FILES
  ) {
    throw new Error("The plugin package is not in the expected format.");
  }
  const seen = new Set<string>();
  return parsed.files.map((raw) => {
    if (
      !isRecord(raw) ||
      typeof raw.path !== "string" ||
      typeof raw.data !== "string" ||
      typeof raw.executable !== "boolean" ||
      !isSafeMossPluginPackagePath(raw.path) ||
      seen.has(raw.path.toLowerCase())
    ) {
      throw new Error("The plugin package lists an invalid file.");
    }
    seen.add(raw.path.toLowerCase());
    return { path: raw.path, executable: raw.executable, bytes: Buffer.from(raw.data, "base64") };
  });
}
