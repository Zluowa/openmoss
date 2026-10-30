// FILE: safeFile.ts
// Purpose: Read and write bounded import files without following source
//          symlinks or accepting a source that changes mid-read.
// Layer: Server import helper

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

function sameIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

/** Read one regular file from an open descriptor, with a hard byte limit. */
export async function readRegularFileNoFollow(filePath: string, maxBytes: number): Promise<Buffer> {
  const pathStat = await fs.lstat(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("Import source is not a regular file.");
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      throw new Error("Import source exceeds the file limit.");
    }
    if (!sameIdentity(pathStat, before)) {
      throw new Error("Import source changed while it was opened.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Import source exceeds the file limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (!sameIdentity(before, after) || total !== before.size) {
      throw new Error("Import source changed while it was being read.");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function hashRegularFileNoFollow(filePath: string, maxBytes: number): Promise<string> {
  return createHash("sha256")
    .update(await readRegularFileNoFollow(filePath, maxBytes))
    .digest("hex");
}

/** Create a new destination file from an already snapshotted byte buffer. */
export async function writeNewFileNoFollow(
  filePath: string,
  contents: Uint8Array,
  mode = 0o600,
): Promise<void> {
  await fs.writeFile(filePath, contents, { flag: "wx", mode });
}
