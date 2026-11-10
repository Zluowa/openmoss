// Bounded ZIP extraction for native agent packages. Preflight every entry before
// writing; only ordinary files/directories using store or deflate are accepted.
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";
import { crc32, inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);
export const AGENT_ZIP_LIMITS = {
  archive: 128 * 1024 * 1024,
  expanded: 512 * 1024 * 1024,
  file: 128 * 1024 * 1024,
  entries: 10_000,
  ratio: 1_000,
} as const;

interface Entry {
  path: string;
  directory: boolean;
  method: number;
  crc: number;
  size: number;
  dataStart: number;
  dataEnd: number;
}

function reject(message: string): never {
  throw new Error(`Unsupported agent ZIP: ${message}`);
}

function safePath(name: string, root: string): string {
  if (!name.startsWith(`${root}/`)) reject("unexpected package root");
  const path = name.slice(root.length + 1).replace(/\/$/u, "");
  if (!path || path.length > 1_024) reject("empty or oversized path");
  for (const segment of path.split("/")) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[\\<>:"|?*\u0000-\u001f]/u.test(segment) ||
      /[. ]$/u.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)
    )
      reject("unsafe Windows path");
  }
  return path;
}

function checkExtras(bytes: Buffer, start: number, length: number) {
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) reject("truncated extra field");
    const id = bytes.readUInt16LE(start);
    const size = bytes.readUInt16LE(start + 2);
    if (id === 1) reject("ZIP64");
    start += 4 + size;
    if (start > end) reject("truncated extra field");
  }
}

function planArchive(bytes: Buffer, root: string): Entry[] {
  if (bytes.length < 22 || bytes.length > AGENT_ZIP_LIMITS.archive) reject("archive size");
  let end = bytes.length - 22;
  const first = Math.max(0, end - 65_535);
  while (end >= first) {
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
    end -= 1;
  }
  if (end < first) reject("missing end record");
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    !count ||
    count > AGENT_ZIP_LIMITS.entries ||
    centralStart + centralSize !== end
  )
    reject("split, oversized or inconsistent central directory");
  const entries: Entry[] = [];
  const paths = new Map<string, boolean>();
  const ranges: Array<[number, number]> = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = centralStart;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) reject("central entry");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const attrs = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || bytes.readUInt16LE(offset + 34) !== 0) reject("truncated or split entry");
    if ((flags & ~0x800) !== 0 || (method !== 0 && method !== 8)) reject("flags or compression");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x800) && rawName.some((byte) => byte > 127))
      reject("ambiguous filename encoding");
    const name = decoder.decode(rawName);
    const directory = name.endsWith("/");
    const kind = (attrs >>> 16) & 0xf000;
    if (kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) reject("link or special file");
    if ((attrs & 0x400) !== 0 || ((attrs & 0x10) !== 0 && !directory))
      reject("reparse or directory attributes");
    const path = safePath(name, root);
    const canonical = path.normalize("NFC").toLowerCase();
    if (paths.has(canonical)) reject("duplicate case-insensitive path");
    paths.set(canonical, directory);
    expanded += size;
    if (
      size > AGENT_ZIP_LIMITS.file ||
      expanded > AGENT_ZIP_LIMITS.expanded ||
      size > Math.max(compressed, 1) * AGENT_ZIP_LIMITS.ratio ||
      (directory && (size !== 0 || compressed !== 0 || crc !== 0)) ||
      (method === 0 && size !== compressed)
    )
      reject("expanded size or compression ratio");
    checkExtras(bytes, offset + 46 + nameLength, extraLength);
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50)
      reject("local header");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (
      dataEnd > centralStart ||
      localNameLength !== nameLength ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName) ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 14) !== crc ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== size
    )
      reject("local/central header mismatch");
    checkExtras(bytes, local + 30 + localNameLength, localExtraLength);
    ranges.push([local, dataEnd]);
    entries.push({ path, directory, method, crc, size, dataStart, dataEnd });
    offset = next;
  }
  if (offset !== end) reject("extra central records");
  ranges.sort((a, b) => a[0] - b[0]);
  let previousEnd = 0;
  for (const [start, finish] of ranges) {
    if (start < previousEnd) reject("overlapping local entries");
    previousEnd = finish;
  }
  for (const path of paths.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.get(parts.slice(0, index).join("/")) === false) reject("file used as parent");
    }
  }
  return entries;
}

/** Destination must be a fresh, empty ordinary directory owned by this install. */
export async function extractAgentZip(
  archive: Uint8Array,
  destination: string,
  packageRoot = "dist-package",
): Promise<number> {
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const entries = planArchive(bytes, packageRoot);
  const root = Path.resolve(destination);
  const stat = await FS.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await FS.readdir(root)).length !== 0)
    reject("destination is not fresh");
  const checkedDirectories = new Set([root]);
  const ensureDirectory = async (directory: string) => {
    const relative = Path.relative(root, directory);
    if (relative.startsWith("..") || Path.isAbsolute(relative)) reject("destination escape");
    let current = root;
    for (const part of relative.split(Path.sep).filter(Boolean)) {
      current = Path.join(current, part);
      if (checkedDirectories.has(current)) continue;
      await FS.mkdir(current).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EEXIST") throw cause;
      });
      const info = await FS.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) reject("linked parent directory");
      checkedDirectories.add(current);
    }
  };
  let written = 0;
  for (const entry of entries) {
    const target = Path.resolve(root, ...entry.path.split("/"));
    if (!target.startsWith(`${root}${Path.sep}`)) reject("destination escape");
    if (entry.directory) {
      await ensureDirectory(target);
      continue;
    }
    const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
    const data =
      entry.method === 0
        ? compressed
        : await inflate(compressed, { maxOutputLength: Math.max(1, entry.size) });
    if (data.length !== entry.size || crc32(data) !== entry.crc) reject("size or CRC mismatch");
    await ensureDirectory(Path.dirname(target));
    await FS.writeFile(target, data, { flag: "wx" });
    written += 1;
  }
  return written;
}
