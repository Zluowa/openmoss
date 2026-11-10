import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retireWindowsDesktopStage } from "./desktop-artifact-stage.ts";

it.runIf(process.platform === "win32")(
  "waits for a child to release its Windows working directory and only retires its own stage",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "moss-build-cleanup-test-"));
    const stage = await mkdtemp(join(base, "moss-desktop-win-stage-"));
    const app = join(stage, "app");
    await mkdir(app);
    const child = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("ready");setTimeout(() => {}, 500)'],
      {
        cwd: app,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const stopped = once(child, "exit");
    try {
      await once(child.stdout!, "data");
      await expect(retireWindowsDesktopStage(app, base)).rejects.toThrow("Refusing");
      await retireWindowsDesktopStage(stage, base);
      await expect(stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
      await retireWindowsDesktopStage(stage, base);
    } finally {
      if (child.exitCode === null) child.kill();
      await stopped;
      await retireWindowsDesktopStage(stage, base);
      await rmdir(base);
    }
  },
);
