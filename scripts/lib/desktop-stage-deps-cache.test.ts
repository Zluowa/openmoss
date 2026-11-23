import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  computeDesktopStageDepsCacheKey,
  resolveDesktopStageDepsCacheDir,
  restoreDesktopStageDepsFromCache,
  saveDesktopStageDepsToCache,
} from "./desktop-stage-deps-cache.ts";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function freshDir(): string {
  root = mkdtempSync(Path.join(tmpdir(), "moss-stage-deps-cache-"));
  return root;
}

function baseKeyInput() {
  return {
    platform: "win",
    arch: "x64",
    os: "win32",
    cpu: "x64",
    bunVersion: "1.4.4",
    stagePackageJsonText: '{"name":"moss-desktop-stage-dependencies"}',
    stageBunLockBytes: Buffer.from("lock-v1"),
    patches: [{ path: "patches/foo.patch", contents: Buffer.from("patch-v1") }],
  };
}

describe("desktop-stage-deps-cache", () => {
  it("resolves env var only when non-empty", () => {
    expect(resolveDesktopStageDepsCacheDir({})).toBeUndefined();
    expect(
      resolveDesktopStageDepsCacheDir({ MOSS_DESKTOP_STAGE_DEPS_CACHE: "  " }),
    ).toBeUndefined();
    expect(resolveDesktopStageDepsCacheDir({ MOSS_DESKTOP_STAGE_DEPS_CACHE: "cache-dir" })).toMatch(
      /cache-dir$/u,
    );
  });

  it("changes key whenever lockfile, package manifest, patch, target, or bun version changes", () => {
    const base = computeDesktopStageDepsCacheKey(baseKeyInput());
    expect(computeDesktopStageDepsCacheKey({ ...baseKeyInput(), bunVersion: "1.4.5" })).not.toBe(
      base,
    );
    expect(
      computeDesktopStageDepsCacheKey({
        ...baseKeyInput(),
        stageBunLockBytes: Buffer.from("lock-v2"),
      }),
    ).not.toBe(base);
    expect(
      computeDesktopStageDepsCacheKey({
        ...baseKeyInput(),
        patches: [{ path: "patches/foo.patch", contents: Buffer.from("patch-v2") }],
      }),
    ).not.toBe(base);
    expect(computeDesktopStageDepsCacheKey({ ...baseKeyInput(), arch: "arm64" })).not.toBe(base);
  });

  it("saves and restores node_modules while isolating downstream pruning from the cache", async () => {
    const dir = freshDir();
    const cacheDir = Path.join(dir, "cache");
    const installedNm = Path.join(dir, "stage1/node_modules");
    mkdirSync(Path.join(installedNm, "@openai/codex"), { recursive: true });
    mkdirSync(Path.join(installedNm, "node-pty"), { recursive: true });
    writeFileSync(Path.join(installedNm, "@openai/codex/codex.exe"), "codex-binary");
    writeFileSync(Path.join(installedNm, "node-pty/pty.node"), "pty-native");

    const key = computeDesktopStageDepsCacheKey(baseKeyInput());
    const saved = await saveDesktopStageDepsToCache({
      cacheDir,
      cacheKey: key,
      sourceNodeModulesDir: installedNm,
    });
    expect(saved).toEqual({ saved: true, pruned: 0 });

    const stage2Nm = Path.join(dir, "stage2/node_modules");
    const restored = await restoreDesktopStageDepsFromCache({
      cacheDir,
      cacheKey: key,
      targetNodeModulesDir: stage2Nm,
    });
    expect(restored.hit).toBe(true);
    expect(restored.files).toBe(2);
    expect(readFileSync(Path.join(stage2Nm, "@openai/codex/codex.exe"), "utf8")).toBe(
      "codex-binary",
    );

    // Downstream build steps prune build-only packages out of stageAppDir/node_modules.
    // The cached entry must remain untouched for future builds.
    rmSync(Path.join(stage2Nm, "@openai"), { recursive: true, force: true });
    expect(existsSync(Path.join(cacheDir, key, "node_modules/@openai/codex/codex.exe"))).toBe(true);
  });

  it("ignores incomplete entries and prunes old keys beyond keepEntries", async () => {
    const dir = freshDir();
    const cacheDir = Path.join(dir, "cache");
    const nm = Path.join(dir, "nm");
    mkdirSync(nm, { recursive: true });
    writeFileSync(Path.join(nm, "a.js"), "ok");

    const key1 = computeDesktopStageDepsCacheKey({ ...baseKeyInput(), bunVersion: "1.4.1" });
    const key2 = computeDesktopStageDepsCacheKey({ ...baseKeyInput(), bunVersion: "1.4.2" });
    const key3 = computeDesktopStageDepsCacheKey({ ...baseKeyInput(), bunVersion: "1.4.3" });

    // Incomplete entry without complete.json must miss.
    mkdirSync(Path.join(cacheDir, key1, "node_modules"), { recursive: true });
    const miss = await restoreDesktopStageDepsFromCache({
      cacheDir,
      cacheKey: key1,
      targetNodeModulesDir: Path.join(dir, "out1"),
    });
    expect(miss.hit).toBe(false);

    await saveDesktopStageDepsToCache({
      cacheDir,
      cacheKey: key1,
      sourceNodeModulesDir: nm,
      keepEntries: 2,
    });
    await saveDesktopStageDepsToCache({
      cacheDir,
      cacheKey: key2,
      sourceNodeModulesDir: nm,
      keepEntries: 2,
    });
    const third = await saveDesktopStageDepsToCache({
      cacheDir,
      cacheKey: key3,
      sourceNodeModulesDir: nm,
      keepEntries: 2,
    });
    expect(third.saved).toBe(true);
    expect(third.pruned).toBe(1);
    expect(existsSync(Path.join(cacheDir, key3, "complete.json"))).toBe(true);
  });
});
