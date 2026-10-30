import { symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** A real directory alias; descendants retain their actual file identities on Windows. */
export function createDirectoryAlias(target: string, linkPath: string): void {
  symlinkSync(
    resolve(dirname(linkPath), target),
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/**
 * A symbolic entry for rejection tests. Windows file symlinks require a host privilege, so use
 * a directory junction there. This entry must never serve as a positive file-target fixture.
 */
export function createRejectedFileAlias(target: string, linkPath: string): void {
  if (process.platform === "win32") {
    createDirectoryAlias(dirname(resolve(dirname(linkPath), target)), linkPath);
  } else {
    symlinkSync(target, linkPath, "file");
  }
}
