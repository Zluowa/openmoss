// FILE: moss-packaged-app-archive.ts
// Purpose: Fails closed on unsafe Moss release ZIP metadata before any extractor sees it.
// Layer: Shared release-artifact boundary

import { spawnSync } from "node:child_process";
import { posix } from "node:path";

const REQUIRED_PACKAGED_MOSS_ARCHIVE_ENTRIES = [
  "Moss.app/Contents/Info.plist",
  "Moss.app/Contents/MacOS/Moss",
  "Moss.app/Contents/Resources/app.asar",
] as const;
const MAX_PACKAGED_MOSS_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PACKAGED_MOSS_ARCHIVE_EXPANSION_RATIO = 64;
const MAX_PACKAGED_MOSS_ARCHIVE_SYMLINK_BYTES = 4 * 1024;

interface PackagedMossArchiveEntryMetadata {
  readonly path: string;
  readonly mode: string;
  readonly uncompressedBytes: number;
  readonly compressedBytes: number;
}

function assertPackagedMossArchiveEntries(entries: readonly string[]): void {
  if (entries.length === 0 || entries.length > 100_000) {
    throw new Error("Packaged Moss archive entry inventory is empty or unbounded.");
  }
  const unique = new Set<string>();
  const portableUnique = new Set<string>();
  for (const entry of entries) {
    if (
      !entry ||
      entry.includes("\\") ||
      entry.includes("\0") ||
      entry.includes("\uFFFD") ||
      /[\u0000-\u001f\u007f]/u.test(entry) ||
      /[*?[\]]/u.test(entry) ||
      Buffer.byteLength(entry, "utf8") > 4_096 ||
      entry.startsWith("/") ||
      entry.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`Packaged Moss archive contains an unsafe traversal entry: ${entry}.`);
    }
    if (unique.has(entry)) {
      throw new Error(`Packaged Moss archive contains a duplicate entry: ${entry}.`);
    }
    unique.add(entry);
    const portableKey = entry.normalize("NFD").toLowerCase();
    if (portableUnique.has(portableKey)) {
      throw new Error(`Packaged Moss archive contains a portable path collision: ${entry}.`);
    }
    portableUnique.add(portableKey);
    if (entry === "__MACOSX/") continue;
    const [root, second] = entry.split("/");
    if (root !== "Moss.app" && !(root === "__MACOSX" && second === "Moss.app")) {
      throw new Error(`Packaged Moss archive contains an unexpected top-level root: ${entry}.`);
    }
  }
  for (const required of REQUIRED_PACKAGED_MOSS_ARCHIVE_ENTRIES) {
    if (!unique.has(required)) {
      throw new Error(`Packaged Moss archive is missing required ${required}.`);
    }
  }
}

function listPackagedMossArchiveEntries(artifactPath: string): readonly string[] {
  if (!artifactPath.toLowerCase().endsWith(".zip")) {
    throw new Error("Packaged Moss verification requires the release ZIP artifact.");
  }
  const listed = spawnSync("/usr/bin/unzip", ["-Z1", artifactPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (listed.error || listed.status !== 0) {
    throw new Error("Packaged Moss release ZIP inventory could not be read.", {
      cause: listed.error,
    });
  }
  const entries = listed.stdout.split("\n").filter((entry) => entry.length > 0);
  assertPackagedMossArchiveEntries(entries);
  return entries;
}

function packagedMossArchiveEntryMetadata(
  artifactPath: string,
  expectedEntries: readonly string[],
): readonly PackagedMossArchiveEntryMetadata[] {
  const listed = spawnSync("/usr/bin/zipinfo", ["-l", artifactPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (listed.error || listed.status !== 0) {
    throw new Error("Packaged Moss release ZIP metadata could not be read.", {
      cause: listed.error,
    });
  }
  const linePattern = /^(\S{10})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/u;
  const metadata = listed.stdout
    .split("\n")
    .map((line) => line.match(linePattern))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      mode: match[1]!,
      uncompressedBytes: Number(match[2]),
      compressedBytes: Number(match[3]),
      path: match[4]!,
    }));
  if (
    metadata.length !== expectedEntries.length ||
    metadata.some((entry, index) => entry.path !== expectedEntries[index])
  ) {
    throw new Error(
      "Packaged Moss archive metadata does not exactly match its path inventory; ambiguous names are forbidden.",
    );
  }
  let totalUncompressedBytes = 0;
  let totalCompressedBytes = 0;
  for (const entry of metadata) {
    if (
      !Number.isSafeInteger(entry.uncompressedBytes) ||
      !Number.isSafeInteger(entry.compressedBytes) ||
      entry.uncompressedBytes < 0 ||
      entry.compressedBytes < 0
    ) {
      throw new Error(`Packaged Moss archive contains invalid entry sizes: ${entry.path}.`);
    }
    const type = entry.mode[0];
    if (type !== "-" && type !== "d" && type !== "l") {
      throw new Error(`Packaged Moss archive contains an unsafe special entry: ${entry.path}.`);
    }
    if ((type === "d") !== entry.path.endsWith("/")) {
      throw new Error(`Packaged Moss archive entry type disagrees with its path: ${entry.path}.`);
    }
    totalUncompressedBytes += entry.uncompressedBytes;
    totalCompressedBytes += entry.compressedBytes;
  }
  if (
    !Number.isSafeInteger(totalUncompressedBytes) ||
    totalUncompressedBytes > MAX_PACKAGED_MOSS_ARCHIVE_UNCOMPRESSED_BYTES ||
    totalCompressedBytes <= 0 ||
    totalUncompressedBytes / totalCompressedBytes > MAX_PACKAGED_MOSS_ARCHIVE_EXPANSION_RATIO
  ) {
    throw new Error("Packaged Moss archive expansion is empty, unbounded, or zip-bomb shaped.");
  }
  return metadata;
}

function assertPackagedMossArchiveSymlinks(
  artifactPath: string,
  metadata: readonly PackagedMossArchiveEntryMetadata[],
): void {
  const sortedPaths = metadata.map((entry) => entry.path).sort();
  const hasDescendant = (path: string): boolean => {
    const prefix = `${path}/`;
    let lower = 0;
    let upper = sortedPaths.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (sortedPaths[middle]! < prefix) lower = middle + 1;
      else upper = middle;
    }
    return sortedPaths[lower]?.startsWith(prefix) === true;
  };
  for (const entry of metadata) {
    if (!entry.mode.startsWith("l")) continue;
    if (
      entry.path.startsWith("__MACOSX/") ||
      entry.uncompressedBytes <= 0 ||
      entry.uncompressedBytes > MAX_PACKAGED_MOSS_ARCHIVE_SYMLINK_BYTES ||
      hasDescendant(entry.path)
    ) {
      throw new Error(`Packaged Moss archive contains an unsafe symlink entry: ${entry.path}.`);
    }
    const targetRead = spawnSync("/usr/bin/unzip", ["-p", artifactPath, entry.path], {
      encoding: "buffer",
      maxBuffer: MAX_PACKAGED_MOSS_ARCHIVE_SYMLINK_BYTES + 1,
      timeout: 30_000,
    });
    const targetBytes = Buffer.isBuffer(targetRead.stdout)
      ? targetRead.stdout
      : Buffer.from(targetRead.stdout ?? "");
    if (
      targetRead.error ||
      targetRead.status !== 0 ||
      targetBytes.length !== entry.uncompressedBytes
    ) {
      throw new Error(`Packaged Moss archive symlink target could not be read: ${entry.path}.`, {
        cause: targetRead.error,
      });
    }
    let target: string;
    try {
      target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
    } catch {
      throw new Error(`Packaged Moss archive symlink target is not UTF-8: ${entry.path}.`);
    }
    if (
      !target ||
      target.startsWith("/") ||
      target.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(target)
    ) {
      throw new Error(
        `Packaged Moss archive symlink has an absolute or unsafe target: ${entry.path}.`,
      );
    }
    const resolvedTarget = posix.normalize(posix.join(posix.dirname(entry.path), target));
    if (
      resolvedTarget === "Moss.app" ||
      !resolvedTarget.startsWith("Moss.app/") ||
      resolvedTarget === posix.normalize(entry.path)
    ) {
      throw new Error(
        `Packaged Moss archive symlink escapes or aliases its app root: ${entry.path}.`,
      );
    }
  }
}

export function inspectPackagedMossArchive(artifactPath: string): readonly string[] {
  const entries = listPackagedMossArchiveEntries(artifactPath);
  const metadata = packagedMossArchiveEntryMetadata(artifactPath, entries);
  assertPackagedMossArchiveSymlinks(artifactPath, metadata);
  return entries;
}

export function assertPackagedMossArchiveEntriesForTesting(entries: readonly string[]): void {
  assertPackagedMossArchiveEntries(entries);
}

export function assertPackagedMossArchiveMetadataForTesting(artifactPath: string): void {
  inspectPackagedMossArchive(artifactPath);
}
