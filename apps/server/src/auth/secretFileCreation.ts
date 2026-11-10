/**
 * Creates a random secret file only if none exists, so racing creators all end up with the same
 * key. Several services ask for the same secret at startup (the guest-share signing key is read
 * by thread shares and page sharing), and on a fresh profile they used to generate different keys
 * and race to rename them onto one path: on Windows the loser failed with EPERM, and when both
 * renames succeeded each service kept a different key in memory until the next start.
 *
 * The key is written to a temporary file and then hard-linked to its final name. `link` never
 * replaces an existing file, so exactly one creator wins and every other one reads the winner's
 * key. Windows answers a file that is being created, renamed or scanned with EPERM, EACCES or
 * EBUSY for a moment, so those are retried briefly. Filesystems without hard links fall back to
 * the atomic rename and re-read whatever ended up on disk.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

import { supportsPosixPermissions } from "../privatePathPermissions";

export interface SecretFileOps {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeNewFile: (path: string, contents: Uint8Array) => Promise<void>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

const writeNewFile = async (path: string, contents: Uint8Array) => {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const handle = await fs.open(path, flags, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (supportsPosixPermissions()) await fs.chmod(path, 0o600);
};

export const nodeSecretFileOps: SecretFileOps = {
  readFile: async (path) => Uint8Array.from(await fs.readFile(path)),
  writeNewFile,
  link: (existingPath, newPath) => fs.link(existingPath, newPath),
  rename: (from, to) => fs.rename(from, to),
  remove: (path) => fs.rm(path, { force: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const errorCode = (cause: unknown): string | undefined =>
  (cause as NodeJS.ErrnoException | null)?.code;

/** Brief Windows sharing violations, not real failures. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
/** The filesystem cannot hard-link (FAT, some network shares). */
const NO_LINK_CODES: ReadonlySet<string> = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);
export const SECRET_CREATE_ATTEMPTS = 6;
const backoffMs = (attempt: number) => 20 * (attempt + 1);

/** The secret on disk, or null when there is none yet (an empty file counts as none). */
async function readExisting(path: string, ops: SecretFileOps): Promise<Uint8Array | null> {
  try {
    const bytes = await ops.readFile(path);
    return bytes.byteLength > 0 ? bytes : null;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return null;
    throw cause;
  }
}

export async function getOrCreateSecretFile(
  finalPath: string,
  bytes: number,
  ops: SecretFileOps = nodeSecretFileOps,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SECRET_CREATE_ATTEMPTS; attempt += 1) {
    try {
      const existing = await readExisting(finalPath, ops);
      if (existing !== null) return existing;

      const generated = Uint8Array.from(randomBytes(bytes));
      const tempPath = `${finalPath}.${randomUUID()}.tmp`;
      await ops.writeNewFile(tempPath, generated);
      try {
        await ops.link(tempPath, finalPath);
        return generated;
      } catch (cause) {
        // Another creator won: the next pass reads its key.
        if (errorCode(cause) === "EEXIST") continue;
        if (!NO_LINK_CODES.has(errorCode(cause) ?? "")) throw cause;
        await ops.rename(tempPath, finalPath);
        // A concurrent rename may have landed after ours: whatever is on disk now is the key.
        return (await readExisting(finalPath, ops)) ?? generated;
      } finally {
        await ops.remove(tempPath).catch(() => undefined);
      }
    } catch (cause) {
      if (!TRANSIENT_CODES.has(errorCode(cause) ?? "")) throw cause;
      lastError = cause;
      await ops.sleep(backoffMs(attempt));
    }
  }
  // Still contended: a key that appeared meanwhile is as good as one we created.
  const existing = await readExisting(finalPath, ops).catch(() => null);
  if (existing !== null) return existing;
  throw lastError;
}
