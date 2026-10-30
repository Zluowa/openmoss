import { lstat, readFile, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export async function expectCodexOverlayPrivateFile(target: string, source: string): Promise<void> {
  const [actual, expected, metadata] = await Promise.all([
    readFile(target),
    readFile(source),
    lstat(target, { bigint: true }),
  ]);
  expect(actual).toEqual(expected);
  if (metadata.isSymbolicLink()) {
    expect(path.resolve(await readlink(target))).toBe(path.resolve(source));
  } else {
    // Rewrite-replaced private files use a refreshed copy when Windows denies
    // file symlinks. An inode hard link would retain the wrong login after a rename.
    expect(process.platform).toBe("win32");
    expect(metadata.isFile()).toBe(true);
    expect(metadata.ino).not.toBe((await lstat(source, { bigint: true })).ino);
  }
}

/** Create an actual alias for rejection/removal fixtures without elevated Windows privileges. */
export async function createCodexAliasFixture(
  source: string,
  target: string,
  type: "file" | "dir" = "file",
): Promise<void> {
  await symlink(
    process.platform === "win32" && type === "file" ? path.dirname(source) : source,
    target,
    process.platform === "win32" ? "junction" : type,
  );
}
