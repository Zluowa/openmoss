// FILE: tar.ts
// Purpose: Streams a (gzipped) tar archive entry by entry without extracting it to disk.
// Layer: Release/build helper (agent runtime bumps)

import * as FS from "node:fs";
import * as Zlib from "node:zlib";

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

/** Streams a tar or tar.gz file through the visitor. Gzip is detected from the magic bytes. */
export async function readTarFile(filePath: string, visitor: TarEntryVisitor): Promise<void> {
  const head = Buffer.alloc(2);
  const descriptor = FS.openSync(filePath, "r");
  try {
    FS.readSync(descriptor, head, 0, 2, 0);
  } finally {
    FS.closeSync(descriptor);
  }
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  const parser = createTarParser(visitor);
  const source = FS.createReadStream(filePath);
  const stream = gzipped ? source.pipe(Zlib.createGunzip()) : source;
  await new Promise<void>((resolve, reject) => {
    source.on("error", reject);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => {
      try {
        parser.write(chunk);
      } catch (error) {
        stream.destroy();
        reject(error);
      }
    });
    stream.on("end", () => {
      try {
        parser.finish();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Reads the named entries of a tar(.gz) into memory, keyed by their stored path. */
export async function readTarEntries(
  filePath: string,
  wanted: (header: TarEntryHeader) => boolean,
): Promise<Map<string, { readonly header: TarEntryHeader; readonly bytes: Buffer }>> {
  const result = new Map<string, { header: TarEntryHeader; bytes: Buffer }>();
  await readTarFile(filePath, {
    entry: (header) => {
      if (!wanted(header)) return null;
      const parts: Buffer[] = [];
      return {
        chunk: (bytes) => parts.push(Buffer.from(bytes)),
        end: () => {
          result.set(header.path, { header, bytes: Buffer.concat(parts) });
        },
      };
    },
  });
  return result;
}
