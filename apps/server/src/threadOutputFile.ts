import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { workspaceRootsEqual } from "@moss/shared/threadWorkspace";
import { isShareableRelativePath } from "./guestShare/guestSharedResources";
import { readRegularFileNoFollow, writeNewFileNoFollow } from "./workspaceImport/safeFile";

const MAX_BYTES = 60 * 1024 * 1024;

/** Keep both the requested path and its resolved parents inside this thread's actual root. */
async function threadOutputPath(
  root: string,
  requested: string,
  createParents = false,
): Promise<string> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Unsafe output workspace.");
  const canonical = await realpath(root);
  const file = path.resolve(canonical, requested);
  const relative = path.relative(canonical, file);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    !isShareableRelativePath(relative.split(path.sep).join("/"))
  ) {
    throw new Error("The output must be a document inside this conversation's workspace.");
  }
  let parent = canonical;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, part);
    if (createParents)
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe output directory.");
  }
  if (!workspaceRootsEqual(await realpath(path.dirname(file)), path.dirname(file))) {
    throw new Error("The output directory changed.");
  }
  return file;
}

export async function readThreadOutput(root: string, requested: string, sha256?: string) {
  const file = await threadOutputPath(root, requested);
  const before = await lstat(file);
  if (before.nlink !== 1 || !before.isFile() || before.isSymbolicLink())
    throw new Error("Unsafe output file.");
  const bytes = await readRegularFileNoFollow(file, MAX_BYTES);
  const after = await lstat(await threadOutputPath(root, requested));
  if (
    after.nlink !== 1 ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (sha256 && createHash("sha256").update(bytes).digest("hex") !== sha256)
  ) {
    throw new Error("The exported file has changed.");
  }
  return { bytes, name: path.basename(file) };
}

/** Publish complete bytes without following or overwriting an existing destination. */
export async function publishThreadOutput(
  root: string,
  requested: string,
  bytes: Uint8Array,
  autoName: boolean,
) {
  if (bytes.length > MAX_BYTES) throw new Error("Export exceeds the file limit.");
  const base = await threadOutputPath(root, requested, true);
  const temp = path.join(path.dirname(base), `.moss-output-${randomUUID()}.tmp`);
  await writeNewFileNoFollow(temp, bytes);
  try {
    const parsed = path.parse(base);
    for (let index = 0; index < 1000; index++) {
      const file = index ? path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`) : base;
      await threadOutputPath(root, file);
      try {
        await link(temp, file);
        return {
          file,
          relative: path
            .relative(await realpath(root), file)
            .split(path.sep)
            .join("/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (error) {
        if (!autoName || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("No free export filename.");
  } finally {
    await rm(temp, { force: true });
  }
}
