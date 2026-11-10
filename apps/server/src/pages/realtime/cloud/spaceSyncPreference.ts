import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { writeFileStringAtomically } from "../../../atomicWrite";
import { syncDirectoryEntry } from "../../../privatePathPermissions";

export const syncDigest = (fields: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(fields)).digest("hex");
export const spaceTargetKey = (scope: string | null, space: string) =>
  syncDigest(["moss-space-sync-target", 1, scope, space]);

/** One owner-owned atomic file per document space; it contains no key, token,
 * device name or content. Missing is off. Unreadable data is a storage error. */
export function spaceSyncPreference(stateDir: string, targetKey: string) {
  if (!/^[a-f0-9]{64}$/.test(targetKey)) throw new Error("Invalid space preference");
  const filename = path.join(stateDir, "page-space-sync-" + targetKey + ".json");
  return {
    async snapshot() {
      let stat;
      try {
        stat = await lstat(filename);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT")
          return { version: "absent", binding: null, invalid: false };
        throw cause;
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > 160
      )
        return {
          version: syncDigest(["invalid-entry", stat.dev, stat.ino, stat.size, stat.ctimeMs]),
          binding: null,
          invalid: true,
        };
      const handle = await open(
        filename,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const current = await handle.stat();
        if (
          !current.isFile() ||
          current.nlink !== 1 ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino ||
          current.size !== stat.size
        )
          throw new Error("Space preference changed during read");
        const bytes = Buffer.alloc(161);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size) throw new Error("Invalid space preference");
        const version = createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex");
        try {
          const record = JSON.parse(bytes.toString("utf8", 0, bytesRead));
          if (
            !record ||
            Object.keys(record).length !== 2 ||
            record.v !== 1 ||
            !(
              record.binding === null ||
              (typeof record.binding === "string" && /^[a-f0-9]{64}$/.test(record.binding))
            )
          )
            throw new Error();
          return { version, binding: record.binding as string | null, invalid: false };
        } catch {
          return { version, binding: null, invalid: true };
        }
      } finally {
        await handle.close();
      }
    },
    write(binding: string | null) {
      return Effect.runPromise(
        writeFileStringAtomically({
          filePath: filename,
          mode: 0o600,
          contents: JSON.stringify({ v: 1, binding }),
        }),
      );
    },
    async clear() {
      try {
        await unlink(filename);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cause;
      }
      await syncDirectoryEntry(stateDir);
    },
  };
}
