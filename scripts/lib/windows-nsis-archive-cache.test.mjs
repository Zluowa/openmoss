import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parse7zTechnicalListing,
  prepareCachedWindowsNsisArchive,
  resolveSevenZaBinaryPath,
  resolveWindowsNsisArchiveCacheDir,
} from "./windows-nsis-archive-cache.mjs";

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function freshDir() {
  root = mkdtempSync(Path.join(tmpdir(), "moss-nsis-cache-test-"));
  return root;
}

describe("windows-nsis-archive-cache", () => {
  it("resolves cache dir only when MOSS_WINDOWS_NSIS_ARCHIVE_CACHE is set", () => {
    expect(resolveWindowsNsisArchiveCacheDir({})).toBeUndefined();
    expect(
      resolveWindowsNsisArchiveCacheDir({ MOSS_WINDOWS_NSIS_ARCHIVE_CACHE: " " }),
    ).toBeUndefined();
    expect(
      resolveWindowsNsisArchiveCacheDir({ MOSS_WINDOWS_NSIS_ARCHIVE_CACHE: "win-cache" }),
    ).toMatch(/win-cache$/u);
  });

  it("parses 7za technical listings and skips folders", () => {
    const sample = [
      "7-Zip (a) 24.09",
      "",
      "----------",
      "Path = resources",
      "Folder = +",
      "Size = 0",
      "CRC = ",
      "",
      "Path = resources\\nested-dir",
      "Size = 0",
      "Attributes = D",
      "",
      "Path = resources\\app.asar",
      "Folder = -",
      "Size = 1234",
      "CRC = 0A1B2C3D",
      "",
      "Path = empty.txt",
      "Folder = -",
      "Size = 0",
      "CRC = ",
    ].join("\n");

    const parsed = parse7zTechnicalListing(sample);
    expect(parsed.size).toBe(2);
    expect(parsed.get("resources/app.asar")).toEqual({ size: 1234, crc32: "0A1B2C3D" });
    expect(parsed.get("empty.txt")).toEqual({ size: 0, crc32: "" });
  });

  it("builds cold, updates incrementally on changed/added/deleted files, and matches every extracted byte", async () => {
    const dir = freshDir();
    const cacheDir = Path.join(dir, "cache");
    const app1 = Path.join(dir, "app1");
    const out1 = Path.join(dir, "out1");
    mkdirSync(Path.join(app1, "resources/codex-runtime"), { recursive: true });
    mkdirSync(out1, { recursive: true });

    // Large unchanged file + small changing file + file that will be removed later + precompressed mp4 excluded.
    writeFileSync(Path.join(app1, "resources/codex-runtime/codex.bin"), "A".repeat(200_000));
    writeFileSync(Path.join(app1, "resources/app.asar"), "app-version-1");
    writeFileSync(Path.join(app1, "obsolete.txt"), "remove-me");
    writeFileSync(Path.join(app1, "demo.mp4"), "excluded-video");

    const sevenZaPath = resolveSevenZaBinaryPath();
    const cold = await prepareCachedWindowsNsisArchive({
      appOutDir: app1,
      outDir: out1,
      archiveFileName: "Moss-1.0.14-x64.nsis.7z",
      arch: "x64",
      cacheDir,
      sevenZaPath,
      compressionLevel: "1",
      coldCompressionLevel: "1",
    });
    expect(cold.mode).toBe("cold");
    expect(cold.totalFiles).toBe(3); // demo.mp4 excluded
    expect(statSync(cold.archiveFilePath).mtimeMs).toBeGreaterThan(statSync(app1).mtimeMs);

    // Second build: codex.bin unchanged, app.asar updated, obsolete.txt deleted, fresh.txt added.
    const app2 = Path.join(dir, "app2");
    const out2 = Path.join(dir, "out2");
    mkdirSync(Path.join(app2, "resources/codex-runtime"), { recursive: true });
    mkdirSync(out2, { recursive: true });
    writeFileSync(Path.join(app2, "resources/codex-runtime/codex.bin"), "A".repeat(200_000));
    writeFileSync(Path.join(app2, "resources/app.asar"), "app-version-2-updated");
    writeFileSync(Path.join(app2, "fresh.txt"), "brand-new");

    const warm = await prepareCachedWindowsNsisArchive({
      appOutDir: app2,
      outDir: out2,
      archiveFileName: "Moss-1.0.15-x64.nsis.7z",
      arch: "x64",
      cacheDir,
      sevenZaPath,
      compressionLevel: "1",
      coldCompressionLevel: "1",
    });
    expect(warm.mode).toBe("incremental");
    expect(warm.reusedFiles).toBe(1);
    expect(warm.updatedFiles).toBe(2);
    expect(warm.totalFiles).toBe(3);

    // Extract the incrementally built archive and verify exact contents.
    const extractDir = Path.join(dir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    execFileSync(sevenZaPath, ["x", "-bd", "-y", `-o${extractDir}`, warm.archiveFilePath], {
      windowsHide: true,
    });
    expect(readFileSync(Path.join(extractDir, "resources/codex-runtime/codex.bin"), "utf8")).toBe(
      "A".repeat(200_000),
    );
    expect(readFileSync(Path.join(extractDir, "resources/app.asar"), "utf8")).toBe(
      "app-version-2-updated",
    );
    expect(readFileSync(Path.join(extractDir, "fresh.txt"), "utf8")).toBe("brand-new");
    expect(existsSync(Path.join(extractDir, "obsolete.txt"))).toBe(false);
    expect(existsSync(Path.join(extractDir, "demo.mp4"))).toBe(false);

    // Third build with only volatile app.asar changed should reuse the stable base without rewriting it.
    const baseMtimeBefore = statSync(Path.join(cacheDir, "x64", "base.nsis.7z")).mtimeMs;
    const app3 = Path.join(dir, "app3");
    const out3 = Path.join(dir, "out3");
    mkdirSync(Path.join(app3, "resources/codex-runtime"), { recursive: true });
    mkdirSync(out3, { recursive: true });
    writeFileSync(Path.join(app3, "resources/codex-runtime/codex.bin"), "A".repeat(200_000));
    writeFileSync(Path.join(app3, "resources/app.asar"), "app-version-3-volatile-only");
    writeFileSync(Path.join(app3, "fresh.txt"), "brand-new");
    const volatileOnly = await prepareCachedWindowsNsisArchive({
      appOutDir: app3,
      outDir: out3,
      archiveFileName: "Moss-1.0.16-x64.nsis.7z",
      arch: "x64",
      cacheDir,
      sevenZaPath,
      compressionLevel: "1",
      coldCompressionLevel: "1",
    });
    expect(volatileOnly.mode).toBe("incremental");
    expect(volatileOnly.reusedFiles).toBe(2);
    expect(volatileOnly.updatedFiles).toBe(1);
    expect(statSync(Path.join(cacheDir, "x64", "base.nsis.7z")).mtimeMs).toBe(baseMtimeBefore);

    // A build with only stable files matching the cached base takes the exact-hit fast path.
    const appStableOnly = Path.join(dir, "app-stable-only");
    const outStable = Path.join(dir, "out-stable");
    mkdirSync(Path.join(appStableOnly, "resources/codex-runtime"), { recursive: true });
    mkdirSync(outStable, { recursive: true });
    writeFileSync(
      Path.join(appStableOnly, "resources/codex-runtime/codex.bin"),
      "A".repeat(200_000),
    );
    writeFileSync(Path.join(appStableOnly, "fresh.txt"), "brand-new");
    const exact = await prepareCachedWindowsNsisArchive({
      appOutDir: appStableOnly,
      outDir: outStable,
      archiveFileName: "Moss-stable-x64.nsis.7z",
      arch: "x64",
      cacheDir,
      sevenZaPath,
      compressionLevel: "1",
      coldCompressionLevel: "1",
    });
    expect(exact.mode).toBe("exact-hit");
    expect(exact.updatedFiles).toBe(0);

    // Corrupting the cached base archive must be detected by SHA-256 and trigger a clean cold rebuild.
    writeFileSync(Path.join(cacheDir, "x64", "base.nsis.7z"), "corrupted-bytes");
    const out4 = Path.join(dir, "out4");
    mkdirSync(out4, { recursive: true });
    const recovered = await prepareCachedWindowsNsisArchive({
      appOutDir: app2,
      outDir: out4,
      archiveFileName: "Moss-1.0.15-x64.nsis.7z",
      arch: "x64",
      cacheDir,
      sevenZaPath,
      compressionLevel: "1",
      coldCompressionLevel: "1",
    });
    expect(recovered.mode).toBe("cold");
    expect(recovered.totalFiles).toBe(3);
  });
});
