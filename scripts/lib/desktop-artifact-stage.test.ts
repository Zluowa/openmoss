import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  retireWindowsDesktopStage,
  retireWindowsDesktopStageInBackground,
} from "./desktop-artifact-stage.ts";

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
  // Starting the child node process alone can take seconds on a loaded Windows machine (11-17:
  // timed out at the default 5 s during a full lane, 3 of 3 green alone).
  30_000,
);

it("retires a stage in the background: renamed aside at once, removed by a detached process", async () => {
  const base = await mkdtemp(join(tmpdir(), "moss-build-cleanup-test-"));
  const stage = await mkdtemp(join(base, "moss-desktop-win-stage-"));
  await mkdir(join(stage, "app", "node_modules", "dep"), { recursive: true });
  await writeFile(join(stage, "app", "node_modules", "dep", "index.js"), "x");
  const outside = await mkdtemp(join(tmpdir(), "moss-build-cleanup-outside-"));
  await writeFile(join(outside, "keep.txt"), "must survive");
  await symlink(outside, join(stage, "link"), process.platform === "win32" ? "junction" : "dir");
  const leftover = join(base, `moss-desktop-win-stage-older1.retiring-1`);
  await mkdir(leftover);
  try {
    const removed: string[] = [];
    const started = performance.now();
    await retireWindowsDesktopStageInBackground(stage, base, (target) => removed.push(target));
    expect(performance.now() - started).toBeLessThan(2_000);
    await expect(stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    expect(removed).toEqual([leftover, `${stage}.retiring-${process.pid}`]);
    await expect(retireWindowsDesktopStageInBackground(base, tmpdir())).rejects.toThrow("Refusing");

    // The real detached remover deletes the renamed stage and only removes the link to `outside`.
    const aside = `${stage}.retiring-${process.pid}`;
    await rm(leftover, { recursive: true, force: true });
    await rename(aside, stage);
    await retireWindowsDesktopStageInBackground(stage, base);
    await expect
      .poll(
        () =>
          stat(aside).then(
            () => "present",
            () => "gone",
          ),
        { timeout: 20_000, interval: 200 },
      )
      .toBe("gone");
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("must survive");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 30_000);
