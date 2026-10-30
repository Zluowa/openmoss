import * as FS from "node:fs";
import * as Path from "node:path";

/** Directory aliases need no Windows symlink privilege when created as junctions. */
export function createDirectoryAliasSync(targetDirectory: string, aliasPath: string): void {
  FS.symlinkSync(targetDirectory, aliasPath, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Only for tests that reject an alias with lstat before opening a file. Windows
 * uses a directory junction at the rejected path, so this helper must never be
 * used as a positive file-link fixture. For a real file reached through an
 * aliased parent, use createDirectoryAliasSync and append its basename instead.
 */
export function createRejectedFileAliasSync(targetFile: string, aliasPath: string): void {
  if (process.platform === "win32") {
    createDirectoryAliasSync(Path.dirname(targetFile), aliasPath);
    return;
  }
  FS.symlinkSync(targetFile, aliasPath, "file");
}
