import { describe, expect, it } from "vitest";

import {
  compareSemver,
  DEFAULT_KEEP_MAC_VERSIONS,
  DEFAULT_KEEP_WIN_VERSIONS,
  formatByteSize,
  formatGigabytes,
  formatUpdateMirrorPruneSummary,
  isS3PermissionError,
  parseDesktopInstallerFileName,
  parseMacUpdateNoticeVersion,
  parseSemver,
  planUpdateMirrorPrune,
  type UpdateMirrorObject,
} from "./update-mirror-prune.ts";

describe("parseSemver and compareSemver", () => {
  it("orders versions numerically by semver rather than lexicographically", () => {
    const versions = ["1.0.2", "1.0.10", "1.0.9", "1.10.0", "1.2.0", "2.0.0", "1.0.10-rc.1"];
    const sorted = versions
      .map((version) => parseSemver(version)!)
      .toSorted(compareSemver)
      .map((parsed) => parsed.raw);

    expect(sorted).toEqual(["1.0.2", "1.0.9", "1.0.10-rc.1", "1.0.10", "1.2.0", "1.10.0", "2.0.0"]);
  });

  it("compares prerelease identifiers according to SemVer 2.0.0", () => {
    const ordered = [
      "1.0.0-1",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.2",
      "1.0.0-alpha.10",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const left = parseSemver(ordered[index]!)!;
      const right = parseSemver(ordered[index + 1]!)!;
      expect(compareSemver(left, right)).toBeLessThan(0);
      expect(compareSemver(right, left)).toBeGreaterThan(0);
    }
  });

  it("rejects non-semver strings and leading zeros", () => {
    expect(parseSemver("1.0")).toBeNull();
    expect(parseSemver("v1.0.0")).toBeNull();
    expect(parseSemver("01.0.0")).toBeNull();
    expect(parseSemver("1.0.0-01")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
  });
});

describe("parseDesktopInstallerFileName", () => {
  it("parses supported Windows and macOS versioned desktop installers", () => {
    expect(parseDesktopInstallerFileName("Moss-1.0.10-x64.exe")).toMatchObject({
      platform: "win",
      arch: "x64",
      lane: "win-x64",
      version: "1.0.10",
      extension: "exe",
      isBlockmap: false,
    });
    expect(parseDesktopInstallerFileName("Moss-1.0.10-x64.exe.blockmap")).toMatchObject({
      platform: "win",
      arch: "x64",
      lane: "win-x64",
      version: "1.0.10",
      extension: "exe.blockmap",
      isBlockmap: true,
    });
    expect(parseDesktopInstallerFileName("Moss-1.0.10-arm64.exe")).toMatchObject({
      platform: "win",
      arch: "arm64",
      lane: "win-arm64",
      version: "1.0.10",
      isBlockmap: false,
    });
    expect(parseDesktopInstallerFileName("Moss-1.0.9-arm64.dmg")).toMatchObject({
      platform: "mac",
      arch: "arm64",
      lane: "mac-arm64",
      version: "1.0.9",
      extension: "dmg",
      isBlockmap: false,
    });
    expect(parseDesktopInstallerFileName("Moss-1.0.9-x64.dmg")).toMatchObject({
      platform: "mac",
      arch: "x64",
      lane: "mac-x64",
      version: "1.0.9",
    });
    expect(parseDesktopInstallerFileName("Moss-1.0.9-arm64.zip")).toMatchObject({
      platform: "mac",
      arch: "arm64",
      lane: "mac-arm64",
      version: "1.0.9",
      extension: "zip",
    });
    expect(parseDesktopInstallerFileName("Moss-1.0.10-beta.1-x64.exe")).toMatchObject({
      platform: "win",
      arch: "x64",
      version: "1.0.10-beta.1",
    });
  });

  it("ignores manifests, signatures, nested paths, and unrecognized filenames", () => {
    for (const ignored of [
      "latest.yml",
      "latest.yml.sig",
      "moss.yml",
      "moss.yml.sig",
      "moss-mac-notice.json",
      "runtime-pins.json",
      "runtime-pins.json.sig",
      "Moss-1.0.10-x64.exe.sig",
      "Moss-1.0.10-x64.AppImage",
      "Moss-latest-x64.exe",
      "code/v1/Moss-1.0.10-x64.exe",
      "desktop/Moss-1.0.10-x64.exe",
      "SHA256SUMS",
      "",
    ]) {
      expect(parseDesktopInstallerFileName(ignored)).toBeNull();
    }
  });
});

describe("parseMacUpdateNoticeVersion", () => {
  it("extracts a valid semver version from moss-mac-notice.json", () => {
    expect(parseMacUpdateNoticeVersion('{"version":"1.0.9"}\n')).toBe("1.0.9");
    expect(parseMacUpdateNoticeVersion('{"version": " 1.0.10-rc.1 "}')).toBe("1.0.10-rc.1");
    expect(parseMacUpdateNoticeVersion('{"version":"bad"}')).toBeNull();
    expect(parseMacUpdateNoticeVersion("not-json")).toBeNull();
    expect(parseMacUpdateNoticeVersion("[]")).toBeNull();
  });
});

describe("planUpdateMirrorPrune", () => {
  const MB = 1_000_000;

  it("keeps the latest 2 Windows versions and latest 1 macOS version using semver ordering", () => {
    const objects: UpdateMirrorObject[] = [
      // Semver trap: "1.0.10" is newer than "1.0.9" and "1.0.2", even though "1.0.9" > "1.0.10" lexically.
      { key: "desktop/Moss-1.0.2-x64.exe", size: 500 * MB },
      { key: "desktop/Moss-1.0.2-x64.exe.blockmap", size: 1 * MB },
      { key: "desktop/Moss-1.0.9-x64.exe", size: 580 * MB },
      { key: "desktop/Moss-1.0.9-x64.exe.blockmap", size: 1 * MB },
      { key: "desktop/Moss-1.0.10-x64.exe", size: 590 * MB },
      { key: "desktop/Moss-1.0.10-x64.exe.blockmap", size: 1 * MB },
      { key: "desktop/Moss-1.0.7-arm64.dmg", size: 700 * MB },
      { key: "desktop/Moss-1.0.8-arm64.dmg", size: 720 * MB },
      { key: "desktop/Moss-1.0.9-arm64.dmg", size: 740 * MB },
      { key: "desktop/latest.yml", size: 350 },
      { key: "desktop/latest.yml.sig", size: 90 },
      { key: "desktop/moss.yml", size: 350 },
      { key: "desktop/moss.yml.sig", size: 90 },
    ];

    const plan = planUpdateMirrorPrune({
      objects,
      prefix: "desktop/",
      protectedFileNames: ["Moss-1.0.10-x64.exe"],
    });

    expect(plan.keepWinVersions).toBe(DEFAULT_KEEP_WIN_VERSIONS);
    expect(plan.keepMacVersions).toBe(DEFAULT_KEEP_MAC_VERSIONS);
    expect(plan.toDelete.map((item) => item.fileName)).toEqual([
      "Moss-1.0.7-arm64.dmg",
      "Moss-1.0.8-arm64.dmg",
      "Moss-1.0.2-x64.exe",
      "Moss-1.0.2-x64.exe.blockmap",
    ]);
    expect(plan.bytesToFree).toBe((700 + 720 + 500 + 1) * MB);
    expect(plan.remainingObjectCount).toBe(objects.length - 4);
    expect(plan.remainingBytes).toBe(plan.totalBytesBefore - plan.bytesToFree);
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.10-x64.exe");
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.9-x64.exe");
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.9-x64.exe.blockmap");
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.9-arm64.dmg");
  });

  it("groups architectures independently (win-x64, win-arm64, mac-arm64, mac-x64)", () => {
    const objects: UpdateMirrorObject[] = [
      { key: "desktop/Moss-1.0.1-x64.exe", size: 100 },
      { key: "desktop/Moss-1.0.2-x64.exe", size: 100 },
      { key: "desktop/Moss-1.0.3-x64.exe", size: 100 },
      { key: "desktop/Moss-1.0.1-arm64.exe", size: 100 },
      { key: "desktop/Moss-1.0.2-arm64.exe", size: 100 },
      { key: "desktop/Moss-1.0.1-arm64.dmg", size: 200 },
      { key: "desktop/Moss-1.0.2-arm64.dmg", size: 200 },
      { key: "desktop/Moss-1.0.1-x64.dmg", size: 200 },
      { key: "desktop/Moss-1.0.1-x64.zip", size: 200 },
    ];

    const plan = planUpdateMirrorPrune({ objects, prefix: "desktop/" });

    expect(plan.toDelete.map((item) => item.fileName)).toEqual([
      "Moss-1.0.1-arm64.dmg",
      "Moss-1.0.1-x64.exe",
    ]);
  });

  it("always protects the macOS version referenced by moss-mac-notice.json", () => {
    const objects: UpdateMirrorObject[] = [
      { key: "desktop/Moss-1.0.8-arm64.dmg", size: 700 * MB },
      { key: "desktop/Moss-1.0.9-arm64.dmg", size: 720 * MB },
      { key: "desktop/Moss-1.0.10-arm64.dmg", size: 740 * MB },
      { key: "desktop/moss-mac-notice.json", size: 22 },
    ];

    const plan = planUpdateMirrorPrune({
      objects,
      prefix: "desktop/",
      protectedMacVersions: ["1.0.9"],
    });

    // Keeps 1.0.10 (latest 1) AND 1.0.9 (protected by moss-mac-notice.json); deletes only 1.0.8.
    expect(plan.toDelete.map((item) => item.fileName)).toEqual(["Moss-1.0.8-arm64.dmg"]);
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.9-arm64.dmg");
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.10-arm64.dmg");
  });

  it("protects all macOS installers when protectAllMacVersions is set (fail-closed)", () => {
    const objects: UpdateMirrorObject[] = [
      { key: "desktop/Moss-1.0.8-arm64.dmg", size: 700 * MB },
      { key: "desktop/Moss-1.0.9-arm64.dmg", size: 720 * MB },
      { key: "desktop/Moss-1.0.2-x64.exe", size: 500 * MB },
      { key: "desktop/Moss-1.0.9-x64.exe", size: 580 * MB },
      { key: "desktop/Moss-1.0.10-x64.exe", size: 590 * MB },
    ];

    const plan = planUpdateMirrorPrune({
      objects,
      prefix: "desktop/",
      protectAllMacVersions: true,
    });

    expect(plan.toDelete.map((item) => item.fileName)).toEqual(["Moss-1.0.2-x64.exe"]);
  });

  it("always protects files named in synced latest.yml / moss.yml and their .blockmap companions", () => {
    const objects: UpdateMirrorObject[] = [
      // Rollback scenario: live manifest points to 1.0.2 while 1.0.9 and 1.0.10 also exist.
      { key: "desktop/Moss-1.0.1-x64.exe", size: 500 * MB },
      { key: "desktop/Moss-1.0.1-x64.exe.blockmap", size: 1 * MB },
      { key: "desktop/Moss-1.0.2-x64.exe", size: 510 * MB },
      { key: "desktop/Moss-1.0.2-x64.exe.blockmap", size: 1 * MB },
      { key: "desktop/Moss-1.0.9-x64.exe", size: 580 * MB },
      { key: "desktop/Moss-1.0.10-x64.exe", size: 590 * MB },
    ];

    const plan = planUpdateMirrorPrune({
      objects,
      prefix: "desktop/",
      protectedFileNames: ["Moss-1.0.2-x64.exe"],
    });

    expect(plan.toDelete.map((item) => item.fileName)).toEqual([
      "Moss-1.0.1-x64.exe",
      "Moss-1.0.1-x64.exe.blockmap",
    ]);
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.2-x64.exe");
    expect(plan.toKeep.map((item) => item.key)).toContain("desktop/Moss-1.0.2-x64.exe.blockmap");
  });

  it("never deletes manifests, desktop/code/, preview/, plugin-catalog/, runtimes/, or unknown files", () => {
    const objects: UpdateMirrorObject[] = [
      { key: "desktop/", size: 0 },
      { key: "desktop/latest.yml", size: 300 },
      { key: "desktop/latest.yml.sig", size: 90 },
      { key: "desktop/moss.yml", size: 300 },
      { key: "desktop/moss.yml.sig", size: 90 },
      { key: "desktop/moss-mac-notice.json", size: 22 },
      { key: "desktop/runtime-pins.json", size: 400 },
      { key: "desktop/runtime-pins.json.sig", size: 90 },
      { key: "desktop/code/latest.json", size: 200 },
      { key: "desktop/code/latest.json.sig", size: 90 },
      { key: "desktop/code/v1/moss-code-abc123456789-0123456789abcdef.asar.zst", size: 21 * MB },
      { key: "desktop/code/Moss-1.0.0-x64.exe", size: 500 * MB },
      { key: "preview/Moss-1.0.0-x64.exe", size: 500 * MB },
      { key: "preview/Moss-1.0.1-x64.exe", size: 500 * MB },
      { key: "preview/Moss-1.0.2-x64.exe", size: 500 * MB },
      { key: "plugin-catalog/v1/index.json", size: 2000 },
      {
        key: "runtimes/v1/codex/1.2.3/codex-1.2.3-win32-x64-0123456789abcdef.tar.zst",
        size: 105 * MB,
      },
      { key: "desktop/custom-archive.exe", size: 10 * MB },
      { key: "desktop/SHA256SUMS", size: 512 },
      { key: "desktop/Moss-1.0.1-x64.exe", size: 500 * MB },
      { key: "desktop/Moss-1.0.2-x64.exe", size: 500 * MB },
      { key: "desktop/Moss-1.0.3-x64.exe", size: 500 * MB },
    ];

    const plan = planUpdateMirrorPrune({ objects, prefix: "desktop/" });

    expect(plan.toDelete.map((item) => item.key)).toEqual(["desktop/Moss-1.0.1-x64.exe"]);
    expect(plan.toKeep).toHaveLength(objects.length - 1);
  });

  it("honors custom retention counts and validates positive integers", () => {
    const objects: UpdateMirrorObject[] = [
      { key: "Moss-1.0.1-x64.exe", size: 100 },
      { key: "Moss-1.0.2-x64.exe", size: 100 },
      { key: "Moss-1.0.3-x64.exe", size: 100 },
      { key: "Moss-1.0.4-x64.exe", size: 100 },
      { key: "Moss-1.0.1-arm64.dmg", size: 200 },
      { key: "Moss-1.0.2-arm64.dmg", size: 200 },
      { key: "Moss-1.0.3-arm64.dmg", size: 200 },
    ];

    const plan = planUpdateMirrorPrune({
      objects,
      keepWinVersions: 3,
      keepMacVersions: 2,
    });

    expect(plan.toDelete.map((item) => item.fileName)).toEqual([
      "Moss-1.0.1-arm64.dmg",
      "Moss-1.0.1-x64.exe",
    ]);

    expect(() => planUpdateMirrorPrune({ objects, keepWinVersions: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => planUpdateMirrorPrune({ objects, keepMacVersions: -1 })).toThrow(
      /positive integer/,
    );
    expect(() => planUpdateMirrorPrune({ objects, keepWinVersions: 1.5 })).toThrow(
      /positive integer/,
    );
  });
});

describe("isS3PermissionError", () => {
  it("recognizes Bun S3Error AccessDenied, HTTP 403, and Forbidden errors", () => {
    const bunS3Error = Object.assign(new Error("Access Denied."), {
      name: "S3Error",
      code: "AccessDenied",
    });
    expect(isS3PermissionError(bunS3Error)).toBe(true);
    expect(isS3PermissionError({ status: 403, message: "error" })).toBe(true);
    expect(isS3PermissionError({ statusCode: 403 })).toBe(true);
    expect(isS3PermissionError(new Error("HTTP 403 Forbidden"))).toBe(true);
    expect(isS3PermissionError(new Error("wrap", { cause: bunS3Error }))).toBe(true);

    expect(isS3PermissionError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
    expect(isS3PermissionError(new Error("ECONNRESET"))).toBe(false);
    expect(isS3PermissionError(null)).toBe(false);
  });
});

describe("formatting helpers", () => {
  it("formats byte sizes and prune summaries clearly", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(12_500)).toBe("12.5 KB");
    expect(formatByteSize(588_930_000)).toBe("588.9 MB");
    expect(formatByteSize(1_925_000_000)).toBe("1.93 GB");
    expect(formatGigabytes(1_925_000_000)).toBe("1.93 GB");

    expect(
      formatUpdateMirrorPruneSummary({
        dryRun: false,
        deletedCount: 2,
        freedBytes: 589_540_000,
        remainingObjects: 8,
        remainingBytes: 1_336_000_000,
        prefix: "desktop/",
      }),
    ).toBe(
      "Prune summary: deleted 2 object(s), freed 589.5 MB (0.59 GB); remaining 8 object(s), 1.34 GB under desktop/.",
    );

    expect(
      formatUpdateMirrorPruneSummary({
        dryRun: true,
        deletedCount: 1,
        freedBytes: 746_180_000,
        remainingObjects: 9,
        remainingBytes: 1_178_820_000,
        prefix: "desktop/",
      }),
    ).toBe(
      "Prune dry-run summary: would delete 1 object(s), freeing 746.2 MB (0.75 GB); would remain 9 object(s), 1.18 GB under desktop/.",
    );
  });
});
