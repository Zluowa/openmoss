// Rebuild an Electron app.asar from a base archive with some subtrees replaced, without extracting it.
//
// Used by scripts/desktop-fast-refresh.ts: the installed app's archive keeps every byte of its production
// node_modules, canvas bundle and runtime packs, and only the app code (desktop main, server, web client)
// is swapped for a fresh build. Kept files are copied byte range by byte range from the base, so the
// result is exact for them; new files get the same per-file SHA-256 integrity record electron-builder writes.
//
// Archive layout (Chromium pickle, as in @electron/asar): uint32 4, uint32 headerPickleSize, then the
// header pickle (uint32 payloadSize, uint32 jsonLength, json, zero padding to 4 bytes), then file data.
// File offsets in the header are decimal strings relative to the start of the data.
import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

export const ASAR_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const COPY_CHUNK = 8 * 1024 * 1024;

export interface AsarIntegrity {
  algorithm: "SHA256";
  hash: string;
  blockSize: number;
  blocks: string[];
}

export interface AsarFileEntry {
  size: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  integrity?: AsarIntegrity;
}

export interface AsarLinkEntry {
  link: string;
}

export interface AsarDirectory {
  files: Record<string, AsarNode>;
  unpacked?: boolean;
}

export type AsarNode = AsarDirectory | AsarFileEntry | AsarLinkEntry;

export interface AsarArchive {
  header: AsarDirectory;
  headerPickleSize: number;
  dataStart: number;
  fileSize: number;
}

export const isAsarDirectory = (node: AsarNode): node is AsarDirectory => "files" in node;
export const isAsarLink = (node: AsarNode): node is AsarLinkEntry => "link" in node;

export async function readAsarArchive(file: string): Promise<AsarArchive> {
  const handle = await open(file, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const sizePickle = Buffer.alloc(8);
    await readExactly(handle, sizePickle, 0);
    if (sizePickle.readUInt32LE(0) !== 4) throw new Error(`${file}: not an asar archive`);
    const headerPickleSize = sizePickle.readUInt32LE(4);
    if (
      headerPickleSize < 8 ||
      headerPickleSize > MAX_HEADER_BYTES ||
      8 + headerPickleSize > fileSize
    ) {
      throw new Error(`${file}: asar header size ${headerPickleSize} is out of range`);
    }
    const headerPickle = Buffer.alloc(headerPickleSize);
    await readExactly(handle, headerPickle, 8);
    const jsonLength = headerPickle.readUInt32LE(4);
    if (8 + jsonLength > headerPickleSize) throw new Error(`${file}: asar header string overruns`);
    const header = JSON.parse(
      headerPickle.subarray(8, 8 + jsonLength).toString("utf8"),
    ) as AsarDirectory;
    if (!header || typeof header !== "object" || !header.files) {
      throw new Error(`${file}: asar header has no file table`);
    }
    return { header, headerPickleSize, dataStart: 8 + headerPickleSize, fileSize };
  } finally {
    await handle.close();
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
    if (bytesRead === 0) throw new Error("unexpected end of file");
    done += bytesRead;
  }
}

export function encodeAsarHeader(header: AsarDirectory): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const payloadSize = 4 + padded;
  const headerPickle = Buffer.alloc(4 + payloadSize);
  headerPickle.writeUInt32LE(payloadSize, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle]);
}

export function asarIntegrity(bytes: Buffer): AsarIntegrity {
  const blocks: string[] = [];
  for (let start = 0; start < bytes.length; start += ASAR_INTEGRITY_BLOCK_SIZE) {
    blocks.push(
      createHash("sha256")
        .update(bytes.subarray(start, start + ASAR_INTEGRITY_BLOCK_SIZE))
        .digest("hex"),
    );
  }
  if (blocks.length === 0) blocks.push(createHash("sha256").digest("hex"));
  return {
    algorithm: "SHA256",
    hash: createHash("sha256").update(bytes).digest("hex"),
    blockSize: ASAR_INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

/** Every file entry with its archive path ("a/b/c"), depth first in header order. */
export function* walkAsarFiles(
  dir: AsarDirectory,
  prefix = "",
): Generator<{ path: string; entry: AsarFileEntry | AsarLinkEntry }> {
  for (const [name, node] of Object.entries(dir.files)) {
    const childPath = prefix ? `${prefix}/${name}` : name;
    if (isAsarDirectory(node)) yield* walkAsarFiles(node, childPath);
    else yield { path: childPath, entry: node };
  }
}

export function findAsarNode(header: AsarDirectory, archivePath: string): AsarNode | undefined {
  let node: AsarNode = header;
  for (const part of splitArchivePath(archivePath)) {
    if (!isAsarDirectory(node)) return undefined;
    const next: AsarNode | undefined = node.files[part];
    if (!next) return undefined;
    node = next;
  }
  return node;
}

const unsafeArchivePathPart = (part: string) =>
  !part || part === "." || part === ".." || part.includes("\\") || part.includes("\u0000");

function splitArchivePath(archivePath: string): string[] {
  const parts = archivePath.split("/");
  if (parts.some(unsafeArchivePathPart)) {
    throw new Error(`unsafe archive path: ${archivePath}`);
  }
  return parts;
}

export interface AsarSpliceInput {
  /** The archive whose bytes are kept outside the replaced paths. Never modified. */
  readonly base: string;
  /** Where the new archive is written (overwritten). */
  readonly output: string;
  /** Archive directory path -> local directory whose whole tree replaces it. */
  readonly replaceDirectories?: Readonly<Record<string, string>>;
  /** Archive file path -> new contents. The file must exist in the base. */
  readonly replaceFiles?: Readonly<Record<string, Buffer>>;
}

export interface AsarSpliceReport {
  keptFiles: number;
  keptBytes: number;
  newFiles: number;
  newBytes: number;
  removedFiles: number;
  outputBytes: number;
  /** Archive path -> sha256 of every file the splice wrote from new contents. */
  written: Record<string, string>;
}

interface PendingNewFile {
  entry: AsarFileEntry;
  bytes: Buffer;
  archivePath: string;
}

async function directoryNode(
  localDir: string,
  archivePrefix: string,
  pending: PendingNewFile[],
): Promise<AsarDirectory> {
  const node: AsarDirectory = { files: {} };
  const entries = await readdir(localDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of entries) {
    const local = path.join(localDir, dirent.name);
    const archivePath = `${archivePrefix}/${dirent.name}`;
    const stat = await lstat(local);
    if (stat.isSymbolicLink())
      throw new Error(`refusing a symbolic link in a replacement tree: ${local}`);
    if (stat.isDirectory()) {
      node.files[dirent.name] = await directoryNode(local, archivePath, pending);
    } else if (stat.isFile()) {
      const bytes = await readFile(local);
      const entry: AsarFileEntry = { size: bytes.length, integrity: asarIntegrity(bytes) };
      pending.push({ entry, bytes, archivePath });
      node.files[dirent.name] = entry;
    } else {
      throw new Error(`refusing a special file in a replacement tree: ${local}`);
    }
  }
  return node;
}

function assertPlainSubtree(node: AsarNode, archivePath: string): void {
  if (isAsarLink(node)) throw new Error(`cannot replace ${archivePath}: it is a link in the base`);
  if (isAsarDirectory(node)) {
    if (node.unpacked) throw new Error(`cannot replace ${archivePath}: it is unpacked in the base`);
    for (const [name, child] of Object.entries(node.files)) {
      assertPlainSubtree(child, `${archivePath}/${name}`);
    }
    return;
  }
  if (node.unpacked) {
    throw new Error(`cannot replace ${archivePath}: it lives in app.asar.unpacked in the base`);
  }
}

/**
 * Write `output`: the base archive with the given directories and files replaced. Kept files keep their
 * header records (integrity, executable, unpacked) and bytes; their offsets are compacted in base order.
 */
export async function spliceAsar(input: AsarSpliceInput): Promise<AsarSpliceReport> {
  const base = await readAsarArchive(input.base);
  const header = structuredClone(base.header);
  const pending: PendingNewFile[] = [];
  const replacedEntries = new Set<AsarFileEntry>();
  let removedFiles = 0;

  for (const [archivePath, localDir] of Object.entries(input.replaceDirectories ?? {})) {
    const parts = splitArchivePath(archivePath);
    const name = parts.pop()!;
    const parent = parts.length ? findAsarNode(header, parts.join("/")) : header;
    if (!parent || !isAsarDirectory(parent))
      throw new Error(`no directory ${parts.join("/")} in the base`);
    const existing = parent.files[name];
    if (!existing || !isAsarDirectory(existing))
      throw new Error(`no directory ${archivePath} in the base`);
    assertPlainSubtree(existing, archivePath);
    removedFiles += [...walkAsarFiles(existing)].length;
    const stat = await lstat(localDir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`${localDir} is not a directory`);
    parent.files[name] = await directoryNode(localDir, archivePath, pending);
  }

  for (const [archivePath, bytes] of Object.entries(input.replaceFiles ?? {})) {
    const node = findAsarNode(header, archivePath);
    if (!node || isAsarDirectory(node) || isAsarLink(node)) {
      throw new Error(`no file ${archivePath} in the base`);
    }
    assertPlainSubtree(node, archivePath);
    const entry: AsarFileEntry = { size: bytes.length, integrity: asarIntegrity(bytes) };
    if (node.executable) entry.executable = true;
    const parts = splitArchivePath(archivePath);
    const name = parts.pop()!;
    const parent = (parts.length ? findAsarNode(header, parts.join("/")) : header) as AsarDirectory;
    parent.files[name] = entry;
    removedFiles += 1;
    pending.push({ entry, bytes, archivePath });
  }
  for (const item of pending) replacedEntries.add(item.entry);

  // Kept packed files, in base data order, get compacted offsets; contiguous base ranges are merged.
  const kept: AsarFileEntry[] = [];
  for (const { entry } of walkAsarFiles(header)) {
    if (isAsarLink(entry) || entry.unpacked || replacedEntries.has(entry)) continue;
    if (entry.offset === undefined) throw new Error("a packed file has no offset");
    kept.push(entry);
  }
  kept.sort((a, b) => Number(a.offset) - Number(b.offset));
  // Merge kept files into contiguous base byte ranges; each range is copied once and every file keeps
  // its position inside its range.
  const ranges: Array<{ from: number; length: number; to: number }> = [];
  let newStart = 0;
  let keptBytes = 0;
  for (const entry of kept) {
    const from = Number(entry.offset);
    if (
      !Number.isSafeInteger(from) ||
      from < 0 ||
      base.dataStart + from + entry.size > base.fileSize
    ) {
      throw new Error(`a kept file lies outside the base archive (offset ${entry.offset})`);
    }
    if (entry.size === 0) {
      // Empty files own no bytes; any offset inside the archive is valid for them.
      entry.offset = String(newStart);
      continue;
    }
    const last = ranges.at(-1);
    if (last && from < last.from + last.length) {
      // Two records sharing bytes would be duplicated by a compaction; electron-builder never writes this.
      throw new Error(`overlapping file records in the base at offset ${from}`);
    }
    if (last && last.from + last.length === from) {
      last.length += entry.size;
    } else {
      ranges.push({ from, length: entry.size, to: newStart });
    }
    const range = ranges.at(-1)!;
    entry.offset = String(range.to + (from - range.from));
    newStart += entry.size;
    keptBytes += entry.size;
  }
  let newBytes = 0;
  for (const item of pending) {
    item.entry.offset = String(newStart + newBytes);
    newBytes += item.bytes.length;
  }

  const encodedHeader = encodeAsarHeader(header);
  const baseHandle = await open(input.base, "r");
  const out = await open(input.output, "w");
  try {
    let position = 0;
    const write = async (buffer: Buffer) => {
      let done = 0;
      while (done < buffer.length) {
        const { bytesWritten } = await out.write(buffer, done, buffer.length - done, position);
        done += bytesWritten;
        position += bytesWritten;
      }
    };
    await write(encodedHeader);
    const chunk = Buffer.alloc(COPY_CHUNK);
    for (const range of ranges) {
      let copied = 0;
      while (copied < range.length) {
        const length = Math.min(COPY_CHUNK, range.length - copied);
        const slice = chunk.subarray(0, length);
        await readExactly(baseHandle, slice, base.dataStart + range.from + copied);
        await write(slice);
        copied += length;
      }
    }
    for (const item of pending) await write(item.bytes);
    await out.sync();
    const written: Record<string, string> = {};
    for (const item of pending) written[item.archivePath] = item.entry.integrity!.hash;
    return {
      keptFiles: kept.length,
      keptBytes,
      newFiles: pending.length,
      newBytes,
      removedFiles,
      outputBytes: position,
      written,
    };
  } finally {
    await out.close();
    await baseHandle.close();
  }
}
