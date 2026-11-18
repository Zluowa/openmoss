import { spawn } from "node:child_process";
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const code = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/** electron-builder can briefly retain the Windows stage as a working directory after exit. */
export async function retireWindowsDesktopStage(stage: string, tempRoot = tmpdir()): Promise<void> {
  const base = await realpath(tempRoot);
  if (
    !/^moss-desktop-(?:win|mac|linux)-stage-[a-zA-Z0-9_-]{6,}$/.test(basename(stage)) ||
    relative(base, await realpath(dirname(resolve(stage)))) !== ""
  ) {
    throw new Error("Refusing to retire a directory outside the desktop artifact scratch space");
  }
  // Retry the whole remove: Windows Bun can return EBUSY even when rm's own retry flags are set.
  for (let attempt = 0; ; attempt++) {
    try {
      const st = await lstat(stage);
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        relative(base, dirname(await realpath(stage))) !== ""
      ) {
        throw new Error("Refusing to retire a redirected desktop artifact stage");
      }
      await rm(stage, { recursive: true, force: true });
      return;
    } catch (error) {
      const reason = code(error);
      if (reason === "ENOENT") return;
      if (attempt >= 6 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(reason))) throw error;
      await wait(100 * (attempt + 1));
    }
  }
}

const RETIRING = /^moss-desktop-(?:win|mac|linux)-stage-[a-zA-Z0-9_-]{6,}\.retiring-\d+$/;

// Runs in a detached process: removes one renamed stage, retrying while Windows still holds a
// file, and gives up quietly after about a minute (the next build's sweep finds what is left).
const DETACHED_REMOVER = `
const { rm } = require("node:fs/promises");
const target = process.env.MOSS_RETIRE_STAGE;
(async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await rm(target, { recursive: true, force: true }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
})();
`;

/**
 * Like retireWindowsDesktopStage, without waiting for the delete: the stage is renamed aside in
 * its own folder (instant on the same volume) and a detached process removes it. Node's rm removes
 * links as links and never descends into them. Earlier renamed stages in the scratch folder are
 * swept the same way. If the rename keeps failing, the stage is retired in the foreground.
 */
export async function retireWindowsDesktopStageInBackground(
  stage: string,
  tempRoot = tmpdir(),
  spawnRemover: (target: string) => void = spawnDetachedRemover,
): Promise<void> {
  const base = await realpath(tempRoot);
  if (
    !/^moss-desktop-(?:win|mac|linux)-stage-[a-zA-Z0-9_-]{6,}$/.test(basename(stage)) ||
    relative(base, await realpath(dirname(resolve(stage)))) !== ""
  ) {
    throw new Error("Refusing to retire a directory outside the desktop artifact scratch space");
  }
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (RETIRING.test(name)) spawnRemover(join(base, name));
  }
  const aside = `${resolve(stage)}.retiring-${process.pid}`;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const st = await lstat(stage);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new Error("Refusing to retire a redirected desktop artifact stage");
      }
      await rename(stage, aside);
      spawnRemover(aside);
      return;
    } catch (error) {
      const reason = code(error);
      if (reason === "ENOENT") return;
      if (!["EBUSY", "EPERM", "EACCES"].includes(String(reason))) throw error;
      await wait(100 * (attempt + 1));
    }
  }
  await retireWindowsDesktopStage(stage, tempRoot);
}

function spawnDetachedRemover(target: string): void {
  if (!RETIRING.test(basename(target))) return;
  // The target goes through the environment: node and bun place `-e` arguments differently.
  spawn(process.execPath, ["-e", DETACHED_REMOVER], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, MOSS_RETIRE_STAGE: target },
  }).unref();
}
