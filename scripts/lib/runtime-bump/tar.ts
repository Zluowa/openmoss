// FILE: tar.ts
// Purpose: Streams a (gzipped) tar archive entry by entry without extracting it to disk.
// Layer: Release/build helper (agent runtime bumps). The parser itself lives in @moss/shared/tarArchive.

import * as FS from "node:fs";
import * as Zlib from "node:zlib";

import {
  createTarParser,
  type TarEntryHeader,
  type TarEntryVisitor,
} from "@moss/shared/tarArchive";

export {
  createTarParser,
  type TarEntryHeader,
  type TarEntrySink,
  type TarEntryVisitor,
} from "@moss/shared/tarArchive";

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
