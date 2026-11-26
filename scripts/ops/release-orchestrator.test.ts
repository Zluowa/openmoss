import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { releasePackageFiles } from "../update-release-package-versions.ts";
import {
  buildReleasePlan,
  defaultBuildNumberForVersion,
  runReleaseCut,
  verifyLiveReleaseEndpoints,
  verifyReleaseVersionAlignment,
  type CommandSpec,
  type ReleaseCutOptions,
} from "./release-orchestrator.ts";

const tempDirs: string[] = [];

function createRepoFixture(version: string, buildNumber: number): string {
  const root = mkdtempSync(join(tmpdir(), "release-orch-"));
  tempDirs.push(root);
  for (const rel of [...releasePackageFiles, "apps/mobile/package.json"]) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, JSON.stringify({ version }, null, 2));
  }
  const appJson = join(root, "apps/mobile/app.json");
  writeFileSync(
    appJson,
    JSON.stringify({ expo: { version, android: { versionCode: buildNumber } } }, null, 2),
  );
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function baseOptions(
  repoRoot: string,
  overrides: Partial<ReleaseCutOptions> = {},
): ReleaseCutOptions {
  return {
    repoRoot,
    version: "1.0.19",
    sourceCommit: "a".repeat(40),
    winArtifactsDir: "D:/DevTemp/moss-release/win-out",
    macArtifactsDir: "D:/DevTemp/moss-release/mac-out",
    androidApkPath: "D:/DevTemp/moss-release/Moss-Android-1.0.19.apk",
    bunBin: "bun",
    ghBin: "gh",
    releaseRepo: "Zluowa/moss-releases",
    execute: false,
    skipBuilds: false,
    skipPublish: false,
    skipSite: false,
    verifyOnly: false,
    ...overrides,
  };
}

describe("release-orchestrator", () => {
  it("computes monotonic Android build numbers and verifies manifest alignment", () => {
    expect(defaultBuildNumberForVersion("1.0.18")).toBe(10018);
    expect(defaultBuildNumberForVersion("1.2.3")).toBe(10203);

    const root = createRepoFixture("1.0.19", 10019);
    expect(
      verifyReleaseVersionAlignment({ repoRoot: root, version: "1.0.19", buildNumber: 10019 })
        .checkedFiles,
    ).toHaveLength(6);

    writeFileSync(
      join(root, "apps/mobile/app.json"),
      JSON.stringify({ expo: { version: "1.0.19", android: { versionCode: 10018 } } }),
    );
    expect(() =>
      verifyReleaseVersionAlignment({ repoRoot: root, version: "1.0.19", buildNumber: 10019 }),
    ).toThrow("versionCode");
  });

  it("runs builds in parallel and coordinates dry-run vs execute cleanly", async () => {
    const root = createRepoFixture("1.0.19", 10019);
    const seen: string[] = [];
    const dryReport = await runReleaseCut(baseOptions(root), {
      checkSourceCommit: () => {},
      runCommand: async (spec: CommandSpec) => {
        seen.push(`${spec.command} ${spec.args.join(" ")}`);
        return { status: 0, stdout: "dry-run ok", stderr: "" };
      },
      log: () => {},
    });
    expect(dryReport.execute).toBe(false);
    expect(dryReport.steps.some((s) => s.stage === "build" && s.status === "dry-run")).toBe(true);
    expect(seen.some((cmd) => cmd.includes("publish-desktop-feed-release.ts"))).toBe(true);
    expect(seen.some((cmd) => cmd.includes("--dry-run"))).toBe(true);

    const plan = buildReleasePlan(
      baseOptions(root, {
        execute: true,
        notesFile: "notes.md",
        tishiWebDir: "D:/ceshi/tishi-web",
      }),
    );
    expect(JSON.parse(plan.macNoticeJson)).toEqual({ version: "1.0.19" });
    expect(plan.builds.map((b) => b.name)).toEqual([
      "win-build-and-smoke",
      "mac-direct-build-and-smoke",
      "android-build-and-smoke",
    ]);
    expect(plan.siteCommands.map((s) => s.name)).toEqual(["tishi-web-sync-and-deploy"]);
  });

  it("verifies live endpoints, Range 206, and mandatory 404 on *-mac.yml", async () => {
    const mockFetch = async (url: string) => {
      if (url.endsWith("moss-mac-notice.json")) {
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => '{"version":"1.0.19"}',
        };
      }
      if (url.endsWith("latest-mac.yml") || url.endsWith("moss-mac.yml")) {
        return { status: 404, headers: { get: () => null }, text: async () => "not found" };
      }
      if (url.endsWith(".exe")) {
        return { status: 206, headers: { get: () => "bytes 0-15/100" }, text: async () => "" };
      }
      if (url.endsWith("android-latest.json")) {
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => '{"version":"1.0.19","buildNumber":10019}',
        };
      }
      return { status: 200, headers: { get: () => null }, text: async () => "ok" };
    };

    const steps = await verifyLiveReleaseEndpoints({
      version: "1.0.19",
      buildNumber: 10019,
      releaseRepo: "Zluowa/moss-releases",
      fetchImpl: mockFetch,
      downloadSources: ["https://mirror.example.com/"],
      siteUrls: ["https://mossbotai.com/download"],
    });
    expect(steps.map((s) => s.name)).toEqual([
      "mirror:https://mirror.example.com/",
      "site:https://mossbotai.com/download",
    ]);

    await expect(
      verifyLiveReleaseEndpoints({
        version: "1.0.19",
        buildNumber: 10019,
        releaseRepo: "Zluowa/moss-releases",
        fetchImpl: async (url) =>
          url.endsWith("latest-mac.yml")
            ? { status: 200, headers: { get: () => null }, text: async () => "bad" }
            : mockFetch(url),
        downloadSources: ["https://mirror.example.com/"],
        siteUrls: [],
      }),
    ).rejects.toThrow("latest-mac.yml must be 404");
  });
});
