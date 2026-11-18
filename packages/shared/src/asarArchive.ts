// Read, write and splice Electron asar archives without extracting them.
//
// Used by scripts/desktop-fast-refresh.ts and by code updates (codeUpdate.ts): the installed app's archive
// keeps every byte of its production node_modules and resources, and only the app code (desktop main,
// server, web client) is swapped, from loose files (fast refresh) or from a code archive (code updates). Kept files are copied byte range by byte range from the base, so the
// result is exact for them; new files get the same per-file SHA-256 integrity record electron-builder writes.
//
// Archive layout (Chromium pickle, as in @electron/asar): uint32 4, uint32 headerPickleSize, then the
// header pickle (uint32 payloadSize, uint32 jsonLength, json, zero padding to 4 bytes), then file data.
// File offsets in the header are decimal strings relative to the start of the data.
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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

/**
 * Writes one directory of an archive to `destination` (which must not exist yet), checking every
 * file against its integrity hash. Refuses unpacked files and links: their bytes are not in the
 * archive. Returns the number of files written.
 */
export async function extractAsarDirectory(
  archiveFile: string,
  archivePath: string,
  destination: string,
): Promise<number> {
  const archive = await readAsarArchive(archiveFile);
  const node = findAsarNode(archive.header, archivePath);
  if (!node || !isAsarDirectory(node))
    throw new Error(`${archivePath} is not a directory in ${archiveFile}`);
  await mkdir(destination, { recursive: false });
  const handle = await open(archiveFile, "r");
  const pending: Promise<void>[] = [];
  let written = 0;
  try {
    for (const { path: rel, entry } of walkAsarFiles(node)) {
      if (isAsarLink(entry) || entry.unpacked || entry.offset === undefined) {
        throw new Error(`${archivePath}/${rel} is a link or unpacked; it cannot be extracted`);
      }
      const bytes = Buffer.alloc(entry.size);
      if (entry.size > 0)
        await readExactly(handle, bytes, archive.dataStart + Number(entry.offset));
      if (
        entry.integrity &&
        createHash("sha256").update(bytes).digest("hex") !== entry.integrity.hash
      ) {
        throw new Error(`${archivePath}/${rel} does not match its integrity record`);
      }
      const target = path.join(destination, ...splitArchivePath(rel));
      pending.push(
        mkdir(path.dirname(target), { recursive: true }).then(() => writeFile(target, bytes)),
      );
      written += 1;
      // Small files dominate (a web client is thousands of them): write a batch at a time.
      if (pending.length >= 64) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending.splice(0));
  } finally {
    await handle.close();
  }
  return written;
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
  /**
   * Directories taken whole from another archive (same path in both). Every file must carry an
   * integrity record there, and its bytes are checked against it while they are copied.
   */
  readonly replaceFromArchive?: {
    readonly archive: string;
    readonly directories: ReadonlyArray<string>;
  };
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
  /** New contents, or where they lie in the replacement archive (absolute file offset). */
  bytes?: Buffer;
  sourcePosition?: number;
  archivePath: string;
}

/** A copy of `node` from a replacement archive, its files queued with their source positions. */
function archiveSubtree(
  node: AsarNode,
  archivePath: string,
  dataStart: number,
  fileSize: number,
  pending: PendingNewFile[],
): AsarNode {
  if (isAsarLink(node)) throw new Error(`refusing a link in a replacement archive: ${archivePath}`);
  if (node.unpacked)
    throw new Error(`refusing an unpacked entry in a replacement archive: ${archivePath}`);
  if (isAsarDirectory(node)) {
    const files: Record<string, AsarNode> = {};
    for (const name of Object.keys(node.files)) {
      if (unsafeArchivePathPart(name))
        throw new Error(`unsafe name in a replacement archive: ${name}`);
      files[name] = archiveSubtree(
        node.files[name]!,
        `${archivePath}/${name}`,
        dataStart,
        fileSize,
        pending,
      );
    }
    return { files };
  }
  const integrity = node.integrity;
  if (
    !integrity ||
    integrity.algorithm !== "SHA256" ||
    integrity.blockSize !== ASAR_INTEGRITY_BLOCK_SIZE ||
    !/^[0-9a-f]{64}$/u.test(integrity.hash)
  ) {
    throw new Error(`no usable integrity record for ${archivePath} in the replacement archive`);
  }
  const offset = Number(node.offset);
  if (
    !Number.isSafeInteger(node.size) ||
    node.size < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    dataStart + offset + node.size > fileSize
  ) {
    throw new Error(`${archivePath} lies outside the replacement archive`);
  }
  const entry: AsarFileEntry = {
    size: node.size,
    integrity: { ...integrity, blocks: [...integrity.blocks] },
  };
  if (node.executable) entry.executable = true;
  pending.push({ entry, sourcePosition: dataStart + offset, archivePath });
  return entry;
}

async function directoryNode(
  localDir: string,
  archivePrefix: string,
  pending: PendingNewFile[],
  skip?: (archivePath: string) => boolean,
): Promise<AsarDirectory> {
  const node: AsarDirectory = { files: {} };
  const entries = await readdir(localDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Files are read several at a time (one at a time cost about 66 s for 3,820 files on a loaded
  // PC, 1.3 s on a quiet one), but every slot is taken in name order first, so the header and the
  // data order are exactly what a one-by-one walk produces.
  const reads: Array<{ local: string; item: PendingNewFile }> = [];
  for (const dirent of entries) {
    const local = path.join(localDir, dirent.name);
    const archivePath = `${archivePrefix}/${dirent.name}`;
    if (skip?.(archivePath)) continue;
    const stat = await lstat(local);
    if (stat.isSymbolicLink())
      throw new Error(`refusing a symbolic link in a replacement tree: ${local}`);
    if (stat.isDirectory()) {
      node.files[dirent.name] = await directoryNode(local, archivePath, pending, skip);
    } else if (stat.isFile()) {
      const entry: AsarFileEntry = { size: 0 };
      const item: PendingNewFile = { entry, archivePath };
      pending.push(item);
      node.files[dirent.name] = entry;
      reads.push({ local, item });
    } else {
      throw new Error(`refusing a special file in a replacement tree: ${local}`);
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < reads.length) {
      const { local, item } = reads[next++]!;
      const bytes = await readFile(local);
      item.bytes = bytes;
      item.entry.size = bytes.length;
      item.entry.integrity = asarIntegrity(bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, reads.length) }, worker));
  return node;
}

const READ_CONCURRENCY = 16;

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

  const fromArchive = input.replaceFromArchive
    ? {
        ...input.replaceFromArchive,
        parsed: await readAsarArchive(input.replaceFromArchive.archive),
      }
    : null;
  for (const archivePath of fromArchive?.directories ?? []) {
    const parts = splitArchivePath(archivePath);
    const name = parts.pop()!;
    const parent = parts.length ? findAsarNode(header, parts.join("/")) : header;
    const existing = parent && isAsarDirectory(parent) ? parent.files[name] : undefined;
    if (!parent || !isAsarDirectory(parent) || !existing || !isAsarDirectory(existing)) {
      throw new Error(`no directory ${archivePath} in the base`);
    }
    assertPlainSubtree(existing, archivePath);
    const source = findAsarNode(fromArchive!.parsed.header, archivePath);
    if (!source || !isAsarDirectory(source)) {
      throw new Error(`no directory ${archivePath} in the replacement archive`);
    }
    removedFiles += [...walkAsarFiles(existing)].length;
    parent.files[name] = archiveSubtree(
      source,
      archivePath,
      fromArchive!.parsed.dataStart,
      fromArchive!.parsed.fileSize,
      pending,
    );
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
    newBytes += item.entry.size;
  }

  const encodedHeader = encodeAsarHeader(header);
  const baseHandle = await open(input.base, "r");
  const sourceHandle = fromArchive ? await open(fromArchive.archive, "r") : null;
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
    for (const item of pending) {
      if (item.bytes) {
        await write(item.bytes);
        continue;
      }
      // From the replacement archive, one integrity block at a time, each block checked.
      const integrity = item.entry.integrity!;
      const whole = createHash("sha256");
      const blocks: string[] = [];
      let copied = 0;
      do {
        const length = Math.min(ASAR_INTEGRITY_BLOCK_SIZE, item.entry.size - copied);
        const slice = Buffer.alloc(length);
        if (length > 0) await readExactly(sourceHandle!, slice, item.sourcePosition! + copied);
        whole.update(slice);
        blocks.push(createHash("sha256").update(slice).digest("hex"));
        await write(slice);
        copied += length;
      } while (copied < item.entry.size);
      if (
        whole.digest("hex") !== integrity.hash ||
        blocks.length !== integrity.blocks.length ||
        blocks.some((block, index) => block !== integrity.blocks[index])
      ) {
        throw new Error(`${item.archivePath} does not match its integrity record`);
      }
    }
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
    await sourceHandle?.close();
  }
}

export interface AsarPackInput {
  /** Where the archive is written (overwritten). */
  readonly output: string;
  /** Archive directory path -> local directory whose whole tree it holds. */
  readonly directories: Readonly<Record<string, string>>;
  /** Archive file path -> contents (inside one of the directories, or beside them). */
  readonly files?: Readonly<Record<string, Buffer>>;
  /** Archive paths left out (files or whole directories). */
  readonly skip?: (archivePath: string) => boolean;
}

/**
 * Writes a new archive from local trees. Deterministic: entries are sorted by name, offsets follow
 * that order, and nothing about the machine (times, owners, modes) is recorded.
 */
export async function packAsar(
  input: AsarPackInput,
): Promise<{ files: number; bytes: number; outputBytes: number }> {
  const header: AsarDirectory = { files: {} };
  const pending: PendingNewFile[] = [];
  const ensureDirectory = (parts: string[]): AsarDirectory => {
    let node = header;
    for (const part of parts) {
      const next = (node.files[part] ??= { files: {} });
      if (!isAsarDirectory(next)) throw new Error(`${parts.join("/")} is a file and a directory`);
      node = next;
    }
    return node;
  };
  for (const archivePath of Object.keys(input.directories).toSorted()) {
    const parts = splitArchivePath(archivePath);
    const name = parts.pop()!;
    const stat = await lstat(input.directories[archivePath]!);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${input.directories[archivePath]} is not a directory`);
    }
    ensureDirectory(parts).files[name] = await directoryNode(
      input.directories[archivePath]!,
      archivePath,
      pending,
      input.skip,
    );
  }
  for (const archivePath of Object.keys(input.files ?? {}).toSorted()) {
    const parts = splitArchivePath(archivePath);
    const name = parts.pop()!;
    const bytes = input.files![archivePath]!;
    const entry: AsarFileEntry = { size: bytes.length, integrity: asarIntegrity(bytes) };
    const parent = ensureDirectory(parts);
    if (parent.files[name]) throw new Error(`${archivePath} is given twice`);
    parent.files[name] = entry;
    pending.push({ entry, bytes, archivePath });
  }
  // Offsets in header order, so the bytes follow the sorted tree.
  const order = new Map<AsarFileEntry, number>();
  for (const [index, { entry }] of [...walkAsarFiles(sortedTree(header))].entries()) {
    order.set(entry as AsarFileEntry, index);
  }
  pending.sort((a, b) => order.get(a.entry)! - order.get(b.entry)!);
  const sorted = sortedTree(header);
  let offset = 0;
  for (const item of pending) {
    item.entry.offset = String(offset);
    offset += item.entry.size;
  }
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
    await write(encodeAsarHeader(sorted));
    for (const item of pending) await write(item.bytes!);
    await out.sync();
    return { files: pending.length, bytes: offset, outputBytes: position };
  } finally {
    await out.close();
  }
}

/** The same tree with every directory's names in code-unit order (JSON keeps insertion order). */
function sortedTree(node: AsarDirectory): AsarDirectory {
  const files: Record<string, AsarNode> = {};
  for (const name of Object.keys(node.files).toSorted()) {
    const child = node.files[name]!;
    files[name] = isAsarDirectory(child) ? sortedTree(child) : child;
  }
  return { ...node, files };
}
