// FILE: pack-tar.ts
// Purpose: Build the portable tar invocation and pure-Node streaming tar.gz writer for server package archives.
// Layer: Release/build helper
// Exports: createPackTarCommandPlan, createPackTarStreamCommandPlan, writePackTarGz

import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, readFile, readlink, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export interface PackTarCommandPlanInput {
  readonly stagedPackageDir: string;
  readonly outDir: string;
  readonly tarballName: string;
  readonly patchedRuntimeDirectory?: string;
}

export interface PackTarStreamCommandPlanInput {
  readonly stagedPackageDir: string;
  readonly outDir: string;
  readonly patchedRuntimeDirectory?: string;
}

const TAR_BLOCK_BYTES = 512;
const ZERO_EOF_BLOCKS = Buffer.alloc(TAR_BLOCK_BYTES * 2);
const PREFETCH_CONCURRENCY = 16;
const MAX_PREFETCH_FILE_BYTES = 4 * 1024 * 1024;
const EXECUTABLE_ARCHIVE_PATHS = new Set(["dist/index.mjs", "dist/restoreMigrationBackup.mjs"]);

type TarArchiveEntry =
  | {
      readonly kind: "directory";
      readonly archivePath: string;
      readonly mode: number;
    }
  | {
      readonly kind: "file";
      readonly archivePath: string;
      readonly absolutePath: string;
      readonly size: number;
      readonly mode: number;
    }
  | {
      readonly kind: "symlink";
      readonly archivePath: string;
      readonly linkTarget: string;
      readonly mode: number;
    };

const usesWindowsPathSyntax = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value);

function resolvePackTarPathContext(input: PackTarStreamCommandPlanInput) {
  // Tests and release tooling can pass Windows paths even when the plan is
  // evaluated on Linux (for example in the public mirror's Linux runner).
  // Select the path flavor from the inputs so drive-letter paths keep their
  // Windows volume semantics without changing how real POSIX paths are packed.
  const pathApi =
    usesWindowsPathSyntax(input.outDir) || usesWindowsPathSyntax(input.stagedPackageDir)
      ? path.win32
      : path.posix;
  const relativeStagedPackageDir = pathApi.relative(input.outDir, input.stagedPackageDir);
  const stagedPackagePath = pathApi.isAbsolute(relativeStagedPackageDir)
    ? input.stagedPackageDir
    : relativeStagedPackageDir;
  const forceLocal = pathApi.isAbsolute(relativeStagedPackageDir);
  return { forceLocal, stagedPackagePath };
}

export function createPackTarCommandPlan(input: PackTarCommandPlanInput) {
  const { forceLocal, stagedPackagePath } = resolvePackTarPathContext(input);

  return {
    args: [
      ...(forceLocal ? ["--force-local"] : []),
      "-czf",
      input.tarballName,
      "-C",
      stagedPackagePath,
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
      ...(input.patchedRuntimeDirectory ? [input.patchedRuntimeDirectory] : []),
    ],
    cwd: input.outDir,
  } as const;
}

export function createPackTarStreamCommandPlan(input: PackTarStreamCommandPlanInput) {
  const { forceLocal, stagedPackagePath } = resolvePackTarPathContext(input);
  // Windows System32 bsdtar rejects GNU tar's --force-local flag, and streaming to `-`
  // never passes a drive-letter archive filename to `-f`.
  const isWindowsPath =
    usesWindowsPathSyntax(input.outDir) || usesWindowsPathSyntax(input.stagedPackageDir);

  return {
    args: [
      ...(forceLocal && !isWindowsPath ? ["--force-local"] : []),
      "-cf",
      "-",
      "-C",
      stagedPackagePath,
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
      ...(input.patchedRuntimeDirectory ? [input.patchedRuntimeDirectory] : []),
    ],
    cwd: input.outDir,
  } as const;
}

function writeAsciiString(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(block, offset, 0, Math.min(length, bytes.length));
}

function writeOctalField(block: Buffer, offset: number, length: number, value: number): void {
  writeAsciiString(block, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
}

function encodeTarHeaderBlock(input: {
  readonly name: string;
  readonly size: number;
  readonly mode: number;
  readonly flag: string;
  readonly linkName?: string;
}): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_BYTES);
  writeAsciiString(block, 0, 100, input.name);
  writeOctalField(block, 100, 8, input.mode);
  writeOctalField(block, 108, 8, 0);
  writeOctalField(block, 116, 8, 0);
  writeOctalField(block, 124, 12, input.size);
  writeOctalField(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  writeAsciiString(block, 156, 1, input.flag);
  if (input.linkName) {
    writeAsciiString(block, 157, 100, input.linkName);
  }
  writeAsciiString(block, 257, 6, "ustar");
  writeAsciiString(block, 263, 2, "00");
  let checksum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    checksum += block[index]!;
  }
  writeAsciiString(block, 148, 7, `${checksum.toString(8).padStart(6, "0")}\0`);
  return block;
}

function encodePaxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) {
    length = String(length).length + bodyBytes;
  }
  return Buffer.from(`${length}${body}`, "utf8");
}

function tarPaddingBuffer(size: number): Buffer {
  const remainder = size % TAR_BLOCK_BYTES;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_BYTES - remainder);
}

function needsPaxField(value: string): boolean {
  return Buffer.byteLength(value, "utf8") > 100 || /[^\x20-\x7e]/u.test(value);
}

function truncateUstarField(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= 100) return value;
  return bytes.subarray(bytes.length - 100).toString("latin1");
}

function resolveFileArchiveMode(archivePath: string, statMode: number): number {
  if (
    (statMode & 0o111) !== 0 ||
    EXECUTABLE_ARCHIVE_PATHS.has(archivePath) ||
    archivePath.endsWith(".sh")
  ) {
    return 0o755;
  }
  return 0o644;
}

async function collectRootEntries(
  stagedPackageDir: string,
  relPath: string,
  entries: TarArchiveEntry[],
): Promise<void> {
  const absolutePath = path.join(stagedPackageDir, relPath);
  const stat = await lstat(absolutePath);
  if (stat.isDirectory()) {
    entries.push({
      kind: "directory",
      archivePath: `${relPath}/`,
      mode: 0o755,
    });
    const children = (await readdir(absolutePath)).toSorted();
    for (const child of children) {
      await collectRootEntries(stagedPackageDir, `${relPath}/${child}`, entries);
    }
    return;
  }
  if (stat.isFile()) {
    entries.push({
      kind: "file",
      archivePath: relPath,
      absolutePath,
      size: stat.size,
      mode: resolveFileArchiveMode(relPath, stat.mode),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    entries.push({
      kind: "symlink",
      archivePath: relPath,
      linkTarget: await readlink(absolutePath),
      mode: 0o777,
    });
    return;
  }
  throw new Error(`tar: refusing to archive unsupported entry type at ${relPath}`);
}

async function* generateTarBuffers(
  entries: ReadonlyArray<TarArchiveEntry>,
): AsyncGenerator<Buffer> {
  const prefetched = new Map<number, Promise<Buffer>>();
  let nextPrefetchIndex = 0;

  const fillPrefetchWindow = () => {
    while (prefetched.size < PREFETCH_CONCURRENCY && nextPrefetchIndex < entries.length) {
      const idx = nextPrefetchIndex;
      nextPrefetchIndex += 1;
      const entry = entries[idx]!;
      if (entry.kind === "file" && entry.size > 0 && entry.size <= MAX_PREFETCH_FILE_BYTES) {
        const readPromise = readFile(entry.absolutePath);
        // Prevent unhandled rejection if an earlier entry fails before this slot is awaited.
        readPromise.catch(() => undefined);
        prefetched.set(idx, readPromise);
      }
    }
  };

  fillPrefetchWindow();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const paxParts: Buffer[] = [];
    if (needsPaxField(entry.archivePath)) {
      paxParts.push(encodePaxRecord("path", entry.archivePath));
    }
    if (entry.kind === "symlink" && needsPaxField(entry.linkTarget)) {
      paxParts.push(encodePaxRecord("linkpath", entry.linkTarget));
    }
    if (paxParts.length > 0) {
      const paxPayload = Buffer.concat(paxParts);
      yield encodeTarHeaderBlock({
        name: "PaxHeader",
        size: paxPayload.length,
        mode: 0o644,
        flag: "x",
      });
      yield paxPayload;
      const paxPad = tarPaddingBuffer(paxPayload.length);
      if (paxPad.length > 0) yield paxPad;
    }

    const ustarName = needsPaxField(entry.archivePath)
      ? truncateUstarField(entry.archivePath)
      : entry.archivePath;

    if (entry.kind === "directory") {
      yield encodeTarHeaderBlock({
        name: ustarName,
        size: 0,
        mode: entry.mode,
        flag: "5",
      });
      continue;
    }

    if (entry.kind === "symlink") {
      yield encodeTarHeaderBlock({
        name: ustarName,
        size: 0,
        mode: entry.mode,
        flag: "2",
        linkName: needsPaxField(entry.linkTarget)
          ? truncateUstarField(entry.linkTarget)
          : entry.linkTarget,
      });
      continue;
    }

    yield encodeTarHeaderBlock({
      name: ustarName,
      size: entry.size,
      mode: entry.mode,
      flag: "0",
    });

    if (entry.size > 0) {
      const prefetchedRead = prefetched.get(index);
      if (prefetchedRead) {
        prefetched.delete(index);
        fillPrefetchWindow();
        const bytes = await prefetchedRead;
        if (bytes.byteLength !== entry.size) {
          throw new Error(`tar: ${entry.archivePath} changed size while it was archived`);
        }
        yield bytes;
      } else {
        let written = 0;
        for await (const chunk of createReadStream(entry.absolutePath, {
          highWaterMark: 1024 * 1024,
        })) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          written += buffer.byteLength;
          yield buffer;
        }
        if (written !== entry.size) {
          throw new Error(`tar: ${entry.archivePath} changed size while it was archived`);
        }
      }
      const pad = tarPaddingBuffer(entry.size);
      if (pad.length > 0) yield pad;
    }
  }

  yield ZERO_EOF_BLOCKS;
}

/**
 * Writes a deterministic POSIX ustar/PAX `.tar.gz` archive in-process with concurrent file
 * prefetching and Node's zlib gzip stream. Avoiding external `tar.exe` eliminates ~100s
 * Windows Defender / bsdtar stalls on freshly staged server builds.
 */
export async function writePackTarGz(
  input: PackTarCommandPlanInput & { readonly gzipLevel?: number },
): Promise<string> {
  const roots = [
    "dist",
    "package.json",
    "npm-shrinkwrap.json",
    ...(input.patchedRuntimeDirectory ? [input.patchedRuntimeDirectory] : []),
  ];
  const entries: TarArchiveEntry[] = [];
  for (const rootEntry of roots) {
    await collectRootEntries(input.stagedPackageDir, rootEntry, entries);
  }

  const tarballPath = path.join(input.outDir, input.tarballName);
  const tempPath = `${tarballPath}.${process.pid}.tmp`;

  try {
    await pipeline(
      Readable.from(generateTarBuffers(entries)),
      createGzip({ level: input.gzipLevel ?? 6 }),
      createWriteStream(tempPath),
    );
    await rename(tempPath, tarballPath);
    return tarballPath;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
