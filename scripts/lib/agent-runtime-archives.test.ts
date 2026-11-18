import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findAgentRuntime } from "@moss/shared/agentRuntimeStore";

import {
  agentRuntimeArchiveList,
  agentRuntimePinsDocument,
  findPackagedResourcesDirectory,
  packAgentRuntimeArchive,
  resolveAgentRuntimesMode,
  unpackAgentRuntimeForVerification,
} from "./agent-runtime-archives.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(Path.join(tmpdir(), "moss runtime archives 构建-"));
  folders.push(root);
  return root;
}

/** A staged Codex runtime as the build leaves it in apps/desktop/codex-runtime. */
function stageCodex(root: string): Record<string, string> {
  const files: Record<string, string> = {
    "x86_64-pc-windows-msvc/bin/codex.exe": "MZ codex ".repeat(20_000),
    "x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe": "MZ host",
    "x86_64-pc-windows-msvc/codex-path/rg.exe": "MZ rg",
    "x86_64-pc-windows-msvc/codex-resources/voice/windows-crt.json": "{}",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(Path.join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(Path.join(root, ...path.split("/")), text);
  }
  return files;
}

const codexRuntime = (root: string) => ({
  name: "codex",
  version: "0.166.0",
  platform: "win32",
  arch: "x64",
  root,
  executable: "x86_64-pc-windows-msvc/bin/codex.exe",
});

describe("agent runtimes build mode", () => {
  it("defaults to bundled and allows download only for unsigned Windows builds", () => {
    expect(resolveAgentRuntimesMode({ requested: undefined, platform: "win", signed: false })).toBe(
      "bundled",
    );
    expect(
      resolveAgentRuntimesMode({ requested: "download", platform: "win", signed: false }),
    ).toBe("download");
    expect(resolveAgentRuntimesMode({ requested: "bundled", platform: "mac", signed: true })).toBe(
      "bundled",
    );
    expect(() =>
      resolveAgentRuntimesMode({ requested: "download", platform: "mac", signed: false }),
    ).toThrow(/Windows-only until a signed and notarized/u);
    expect(() =>
      resolveAgentRuntimesMode({ requested: "download", platform: "linux", signed: false }),
    ).toThrow();
    expect(() =>
      resolveAgentRuntimesMode({ requested: "download", platform: "win", signed: true }),
    ).toThrow(/does not support --signed/u);
    expect(() =>
      resolveAgentRuntimesMode({ requested: "lazy", platform: "win", signed: false }),
    ).toThrow(/bundled or download/u);
  });
});

describe("agent runtime archives", () => {
  it("packs the staged runtime, pins every file, and unpacks to exactly the staged bytes", async () => {
    const stage = folder();
    const files = stageCodex(stage);
    const output = folder();
    const packed = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: output,
    });

    expect(packed.objectPath).toBe(
      `runtimes/v1/codex/0.166.0/codex-0.166.0-win32-x64-${packed.pin.archive.sha256.slice(0, 16)}.tar.zst`,
    );
    expect(packed.archivePath).toBe(Path.join(output, ...packed.objectPath.split("/")));
    expect(packed.pin.files.map((file) => file.path).toSorted()).toEqual(
      Object.keys(files).toSorted(),
    );
    expect(packed.pin.files.find((file) => file.path === packed.pin.executable)?.executable).toBe(
      true,
    );

    const verifyRoot = Path.join(folder(), "resources");
    const unpacked = await unpackAgentRuntimeForVerification({
      packed,
      verifyRoot,
      layoutName: "codex-runtime",
    });
    expect(unpacked).toBe(Path.join(verifyRoot, "codex-runtime"));
    for (const [path, text] of Object.entries(files))
      expect(readFileSync(Path.join(unpacked, ...path.split("/")), "utf8")).toBe(text);

    // The app's store finds the same archive's pin installed (what the client will do).
    const store = folder();
    const { installAgentRuntimeArchive } = await import("@moss/shared/agentRuntimeStore");
    await installAgentRuntimeArchive({
      archivePath: packed.archivePath,
      pin: packed.pin,
      storeRoot: store,
    });
    expect((await findAgentRuntime([store], packed.pin)).state).toBe("ready");
  });

  it("packs the same staged runtime to the same bytes twice", async () => {
    const stage = folder();
    stageCodex(stage);
    const first = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
    });
    const second = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
    });
    expect(second.pin.archive).toEqual(first.pin.archive);
  });

  it("reuses a cached archive for the same staged files, and repacks when they change", async () => {
    const stage = folder();
    stageCodex(stage);
    const cacheDir = folder();
    const first = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
      cacheDir,
    });
    const second = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
      cacheDir,
    });
    expect([first.fromCache, second.fromCache]).toEqual([false, true]);
    expect(second.pin).toEqual(first.pin);

    writeFileSync(Path.join(stage, "x86_64-pc-windows-msvc", "codex-path", "rg.exe"), "MZ rg 2");
    const changed = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
      cacheDir,
    });
    expect(changed.fromCache).toBe(false);
    expect(changed.pin.archive.sha256).not.toBe(first.pin.archive.sha256);
  });

  it("repacks when a cached archive was damaged", async () => {
    const stage = folder();
    stageCodex(stage);
    const cacheDir = folder();
    const first = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
      cacheDir,
    });
    const { readdirSync } = await import("node:fs");
    const cached = readdirSync(cacheDir).find((name) => name.endsWith(".tar.zst"))!;
    writeFileSync(Path.join(cacheDir, cached), "damaged");
    const again = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
      cacheDir,
    });
    expect(again.fromCache).toBe(false);
    expect(again.pin).toEqual(first.pin);
  });

  it("refuses a staged runtime without its program", async () => {
    const stage = folder();
    stageCodex(stage);
    await expect(
      packAgentRuntimeArchive({
        runtime: { ...codexRuntime(stage), executable: "x86_64-pc-windows-msvc/bin/missing.exe" },
        outputRoot: folder(),
      }),
    ).rejects.toThrow(/has no x86_64-pc-windows-msvc\/bin\/missing.exe/u);
  });

  it("describes the objects for the upload and the pins for the app and the feed", async () => {
    const stage = folder();
    stageCodex(stage);
    const packed = await packAgentRuntimeArchive({
      runtime: codexRuntime(stage),
      outputRoot: folder(),
    });
    expect(agentRuntimeArchiveList([packed])).toEqual({
      schemaVersion: 1,
      objects: [
        {
          path: packed.objectPath,
          size: packed.pin.archive.size,
          sha256: packed.pin.archive.sha256,
        },
      ],
    });
    expect(agentRuntimePinsDocument({ appVersion: "1.0.8", pins: [packed.pin] })).toEqual({
      schemaVersion: 1,
      appVersion: "1.0.8",
      runtimes: [packed.pin],
    });
  });

  it("finds the one packaged resources folder under electron-builder's output", () => {
    const dist = folder();
    mkdirSync(Path.join(dist, "win-unpacked", "resources"), { recursive: true });
    writeFileSync(Path.join(dist, "win-unpacked", "resources", "app.asar"), "x");
    expect(findPackagedResourcesDirectory(dist)).toBe(Path.join(dist, "win-unpacked", "resources"));
    mkdirSync(Path.join(dist, "other", "resources"), { recursive: true });
    writeFileSync(Path.join(dist, "other", "resources", "app.asar"), "x");
    expect(() => findPackagedResourcesDirectory(dist)).toThrow(/found 2/u);
  });
});
