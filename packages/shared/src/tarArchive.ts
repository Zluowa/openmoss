// FILE: tarArchive.ts
// Purpose: Reads tar archives incrementally and writes deterministic ones, with no dependency.
// Layer: Shared runtime utility (agent runtime archives, runtime bump scripts)

import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TarEntryHeader {
  /** Entry path exactly as stored, after pax/GNU long-name resolution. */
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "hardlink" | "other";
  readonly mode: number;
  readonly size: number;
  readonly linkName: string;
}

export interface TarEntryVisitor {
  /**
   * Called once per entry. Return a sink to receive the entry's bytes, or null to skip them.
   * The sink's `end` runs after the last chunk.
   */
  readonly entry: (header: TarEntryHeader) => TarEntrySink | null;
}

export interface TarEntrySink {
  readonly chunk: (bytes: Buffer) => void;
  readonly end: () => void;
}

const BLOCK = 512;

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const slice = block.subarray(offset, offset + length);
  // GNU base-256 encoding for sizes above 8 GiB is not expected in npm or crate archives.
  if ((slice[0]! & 0x80) !== 0) throw new Error("tar: base-256 numeric fields are unsupported");
  const text = readString(block, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(bytes: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(0x20, position);
    if (space === -1) break;
    const length = Number.parseInt(bytes.subarray(position, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("tar: malformed pax record");
    const record = bytes.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return records;
}

function entryType(flag: string): TarEntryHeader["type"] {
  if (flag === "0" || flag === "" || flag === "7") return "file";
  if (flag === "5") return "directory";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  return "other";
}

/** Incremental tar parser: feed it bytes in any chunking, then call `finish`. */
export function createTarParser(visitor: TarEntryVisitor): {
  readonly write: (bytes: Buffer) => void;
  readonly finish: () => void;
} {
  let pending: Buffer = Buffer.alloc(0);
  let state: "header" | "data" | "meta" | "done" = "header";
  let remaining = 0;
  let padding = 0;
  let sink: TarEntrySink | null = null;
  let meta: { kind: "pax" | "gnu-long-name" | "gnu-long-link" | "global"; parts: Buffer[] } | null =
    null;
  let nextPax = new Map<string, string>();
  let nextLongName: string | null = null;
  let nextLongLink: string | null = null;

  const handleHeader = (block: Buffer): void => {
    if (block.every((byte) => byte === 0)) {
      state = "done";
      return;
    }
    const checksum = readOctal(block, 148, 8);
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
    }
    if (sum !== checksum) throw new Error("tar: header checksum mismatch");
    const flag = String.fromCharCode(block[156]!).replace("\0", "");
    const size = readOctal(block, 124, 12);
    remaining = size;
    padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      meta = {
        kind:
          flag === "x"
            ? "pax"
            : flag === "g"
              ? "global"
              : flag === "L"
                ? "gnu-long-name"
                : "gnu-long-link",
        parts: [],
      };
      state = "meta";
      return;
    }
    const magic = readString(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(block, 345, 155) : "";
    const name = readString(block, 0, 100);
    const path = nextPax.get("path") ?? nextLongName ?? (prefix ? `${prefix}/${name}` : name);
    const linkName = nextPax.get("linkpath") ?? nextLongLink ?? readString(block, 157, 100);
    const paxSize = nextPax.get("size");
    if (paxSize !== undefined) {
      remaining = Number.parseInt(paxSize, 10);
      padding = (BLOCK - (remaining % BLOCK)) % BLOCK;
    }
    nextPax = new Map();
    nextLongName = null;
    nextLongLink = null;
    const header: TarEntryHeader = {
      path,
      type: entryType(flag),
      mode: readOctal(block, 100, 8),
      size: remaining,
      linkName,
    };
    sink = header.type === "file" ? visitor.entry(header) : (visitor.entry(header), null);
    state = "data";
    if (remaining === 0) {
      sink?.end();
      sink = null;
    }
  };

  const write = (bytes: Buffer): void => {
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    let offset = 0;
    while (state !== "done") {
      if (state === "header") {
        if (pending.length - offset < BLOCK) break;
        handleHeader(pending.subarray(offset, offset + BLOCK));
        offset += BLOCK;
        continue;
      }
      if (remaining > 0) {
        const available = Math.min(remaining, pending.length - offset);
        if (available === 0) break;
        const slice = pending.subarray(offset, offset + available);
        if (state === "meta") meta!.parts.push(Buffer.from(slice));
        else sink?.chunk(slice);
        remaining -= available;
        offset += available;
        if (remaining > 0) break;
        if (state === "data") {
          sink?.end();
          sink = null;
        }
      }
      if (padding > 0) {
        const skip = Math.min(padding, pending.length - offset);
        padding -= skip;
        offset += skip;
        if (padding > 0) break;
      }
      if (state === "meta") {
        const body = Buffer.concat(meta!.parts);
        if (meta!.kind === "pax") nextPax = parsePax(body);
        else if (meta!.kind === "gnu-long-name") nextLongName = readString(body, 0, body.length);
        else if (meta!.kind === "gnu-long-link") nextLongLink = readString(body, 0, body.length);
        meta = null;
      }
      state = "header";
    }
    pending = pending.subarray(offset);
  };

  return {
    write,
    finish: () => {
      if (state !== "done" && (state !== "header" || pending.length > 0)) {
        // A truncated archive is never silently accepted.
        if (state !== "header") throw new Error("tar: archive ended inside an entry");
      }
    },
  };
}

export interface TarWriteEntry {
  /** Forward-slash path inside the archive, relative, no `..`. */
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mode: number;
}

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeString(block, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
}

function headerBlock(input: {
  readonly name: string;
  readonly size: number;
  readonly mode: number;
  readonly flag: string;
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeString(block, 0, 100, input.name);
  writeOctal(block, 100, 8, input.mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, input.size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  writeString(block, 156, 1, input.flag);
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 7, sum.toString(8).padStart(6, "0") + "\0");
  return block;
}

function paxRecord(key: string, value: string): Buffer {
  // A record is "<length> <key>=<value>\n" where <length> counts its own digits too.
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return Buffer.from(`${length}${body}`, "utf8");
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/**
 * Lists a folder's regular files for an archive, sorted by path so the same folder always
 * gives the same bytes. Links and other special files are refused, never followed.
 */
export async function listTarEntries(root: string, prefix = ""): Promise<TarWriteEntry[]> {
  const entries: TarWriteEntry[] = [];
  const names = (await readdir(join(root, prefix))).toSorted();
  for (const name of names) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolutePath = join(root, relative);
    const stat = await lstat(absolutePath);
    if (stat.isDirectory()) entries.push(...(await listTarEntries(root, relative)));
    else if (stat.isFile())
      entries.push({ path: relative, absolutePath, size: stat.size, mode: stat.mode & 0o777 });
    else throw new Error(`tar: refusing to archive ${relative}: not a regular file`);
  }
  return entries;
}

/**
 * Streams a deterministic ustar archive of the given files: no times, owners or directory
 * entries, a pax record for paths over 100 bytes, executable bits kept, everything else 0644.
 */
export async function* writeTarArchive(
  entries: ReadonlyArray<TarWriteEntry>,
): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const mode = entry.mode & 0o111 ? 0o755 : 0o644;
    if (Buffer.byteLength(entry.path) > 100) {
      const pax = paxRecord("path", entry.path);
      yield headerBlock({ name: "PaxHeader", size: pax.length, mode: 0o644, flag: "x" });
      yield Buffer.concat([pax, padding(pax.length)]);
    }
    const name = Buffer.byteLength(entry.path) > 100 ? entry.path.slice(-100) : entry.path;
    yield headerBlock({ name, size: entry.size, mode, flag: "0" });
    let written = 0;
    for await (const chunk of createReadStream(entry.absolutePath)) {
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (written !== entry.size) throw new Error(`tar: ${entry.path} changed while it was archived`);
    yield padding(entry.size);
  }
  yield Buffer.alloc(BLOCK * 2);
}
