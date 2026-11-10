import { lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
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
