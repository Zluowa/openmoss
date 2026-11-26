#!/usr/bin/env bun
// FILE: release-orchestrator.ts
// Purpose: Unified `bun run release:cut` pipeline coordinating version alignment checks,
//          parallel Win + Mac-direct + Android build/smoke, GitHub/COS/R2/mac-notice publish,
//          tishi-web + gh-pages sync, and live verification.
// Layer: Release orchestration CLI. Safe dry-run by default; requires `--execute` to mutate.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { MOSS_DOWNLOAD_SOURCES } from "@moss/shared/mossDownloadSources";
import { parseSemver } from "@moss/shared/mossUpdateMirror";

import { releasePackageFiles } from "../update-release-package-versions.ts";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CommandOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type AsyncCommandRunner = (spec: CommandSpec) => Promise<CommandOutcome>;

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly text: () => Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> },
) => Promise<FetchResponseLike>;

export interface ReleaseCutOptions {
  readonly repoRoot: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly buildNumber?: number | undefined;
  readonly winArtifactsDir: string;
  readonly macArtifactsDir: string;
  readonly androidApkPath: string;
  readonly notesFile?: string | undefined;
  readonly notesZh?: string | undefined;
  readonly notesEn?: string | undefined;
  readonly tishiWebDir?: string | undefined;
  readonly ghPagesDir?: string | undefined;
  readonly macDirectScript?: string | undefined;
  readonly bunBin: string;
  readonly ghBin: string;
  readonly releaseRepo: string;
  readonly execute: boolean;
  readonly skipBuilds: boolean;
  readonly skipPublish: boolean;
  readonly skipSite: boolean;
  readonly verifyOnly: boolean;
}

export interface ReleaseStepReport {
  readonly stage: "preflight" | "build" | "publish" | "site" | "verify";
  readonly name: string;
  readonly status: "ok" | "dry-run" | "skipped" | "failed";
  readonly detail: string;
}

export interface ReleaseCutReport {
  readonly version: string;
  readonly buildNumber: number;
  readonly sourceCommit: string;
  readonly execute: boolean;
  readonly steps: ReadonlyArray<ReleaseStepReport>;
}

/** Standard Moss Android monotonic versionCode formula: major*10000 + minor*100 + patch. */
export function defaultBuildNumberForVersion(version: string): number {
  const parsed = parseSemver(version);
  return parsed.major * 10_000 + parsed.minor * 100 + parsed.patch;
}

/**
 * Verifies every release manifest (server, desktop, web, contracts, mobile package.json,
 * and Expo app.json version + android.versionCode) matches the target release version.
 */
export function verifyReleaseVersionAlignment(input: {
  readonly repoRoot: string;
  readonly version: string;
  readonly buildNumber: number;
}): { readonly checkedFiles: ReadonlyArray<string> } {
  const checkedFiles: string[] = [];
  for (const rel of [...releasePackageFiles, "apps/mobile/package.json"]) {
    const abs = join(input.repoRoot, rel);
    if (!existsSync(abs)) {
      throw new Error(`Missing version manifest: ${rel}`);
    }
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as { version?: string };
    if (parsed.version !== input.version) {
      throw new Error(`${rel} has version ${String(parsed.version)}, expected ${input.version}.`);
    }
    checkedFiles.push(rel);
  }
  const appJsonRel = "apps/mobile/app.json";
  const appJsonAbs = join(input.repoRoot, appJsonRel);
  if (!existsSync(appJsonAbs)) {
    throw new Error(`Missing version manifest: ${appJsonRel}`);
  }
  const appJson = JSON.parse(readFileSync(appJsonAbs, "utf8")) as {
    expo?: { version?: string; android?: { versionCode?: number } };
  };
  if (appJson.expo?.version !== input.version) {
    throw new Error(
      `${appJsonRel} has expo.version ${String(appJson.expo?.version)}, expected ${input.version}.`,
    );
  }
  if (appJson.expo?.android?.versionCode !== input.buildNumber) {
    throw new Error(
      `${appJsonRel} has expo.android.versionCode ${String(appJson.expo?.android?.versionCode)}, expected ${input.buildNumber}.`,
    );
  }
  checkedFiles.push(appJsonRel);
  return { checkedFiles };
}

/** Builds the ordered command plan for parallel Win/Mac-direct/Android build+smoke, publish, and site sync. */
export function buildReleasePlan(options: ReleaseCutOptions): {
  readonly macNoticeJson: string;
  readonly builds: ReadonlyArray<{ readonly name: string; readonly spec: CommandSpec }>;
  readonly publishDesktop: CommandSpec;
  readonly publishGitHubMacUpload: CommandSpec;
  readonly publishMobileRelease: CommandSpec;
  readonly publishMobileFeed: CommandSpec;
  readonly siteCommands: ReadonlyArray<{ readonly name: string; readonly spec: CommandSpec }>;
} {
  const tag = `v${options.version}`;
  const mobileTag = `mobile-${tag}`;
  const macNoticeJson = `${JSON.stringify({ version: options.version })}\n`;
  const macCmd = options.macDirectScript
    ? {
        command: "bash",
        args: [
          options.macDirectScript,
          options.sourceCommit,
          "--owner",
          "release-orchestrator",
          "--",
          `bun run dist:desktop:dmg:arm64 && bun run release:smoke:mac-installed -- --dmg ~/tmp/moss-release-${options.version}/Moss-${options.version}-arm64.dmg --expected-version ${options.version}`,
        ],
        cwd: options.repoRoot,
      }
    : {
        command: options.bunBin,
        args: ["run", "release:smoke:mac-installed", "--", "--expected-version", options.version],
        cwd: options.repoRoot,
      };

  const builds = [
    {
      name: "win-build-and-smoke",
      spec: {
        command: options.bunBin,
        args: ["run", "dist:desktop:win"],
        cwd: options.repoRoot,
      },
    },
    {
      name: "mac-direct-build-and-smoke",
      spec: macCmd,
    },
    {
      name: "android-build-and-smoke",
      spec: {
        command: options.bunBin,
        args: ["run", "mobile:check"],
        cwd: options.repoRoot,
      },
    },
  ] as const;

  const publishDesktop: CommandSpec = {
    command: options.bunBin,
    args: [
      "run",
      "scripts/publish-desktop-feed-release.ts",
      "--artifacts-directory",
      options.winArtifactsDir,
      "--version",
      options.version,
      "--source-commit",
      options.sourceCommit,
      ...(options.execute && options.notesFile
        ? ["--notes-file", options.notesFile, "--publish", tag]
        : []),
    ],
    cwd: options.repoRoot,
  };

  const publishGitHubMacUpload: CommandSpec = {
    command: options.ghBin,
    args: [
      "release",
      "upload",
      tag,
      join(options.macArtifactsDir, `Moss-${options.version}-arm64.dmg`),
      join(options.macArtifactsDir, `Moss-${options.version}-arm64.zip`),
      join(options.macArtifactsDir, "SHA256SUMS-macOS"),
      "-R",
      options.releaseRepo,
      "--clobber",
    ],
    cwd: options.repoRoot,
  };

  const publishMobileRelease: CommandSpec = {
    command: options.ghBin,
    args: [
      "release",
      "create",
      mobileTag,
      options.androidApkPath,
      "-R",
      options.releaseRepo,
      "--title",
      `Moss Android ${options.version}`,
      "--latest=false",
    ],
    cwd: options.repoRoot,
  };

  const publishMobileFeed: CommandSpec = {
    command: options.bunBin,
    args: [
      "run",
      "scripts/publish-mobile-release.ts",
      "--apk",
      options.androidApkPath,
      "--version",
      options.version,
      "--build-number",
      String(options.buildNumber ?? defaultBuildNumberForVersion(options.version)),
      "--notes-zh",
      options.notesZh ?? `Moss ${options.version} 发布`,
      "--notes-en",
      options.notesEn ?? `Moss ${options.version} release`,
      ...(options.execute ? [] : ["--dry-run"]),
    ],
    cwd: options.repoRoot,
  };

  const siteCommands: Array<{ readonly name: string; readonly spec: CommandSpec }> = [];
  if (options.tishiWebDir) {
    siteCommands.push({
      name: "tishi-web-sync-and-deploy",
      spec: {
        command: "npm",
        args: ["run", options.execute ? "deploy" : "build"],
        cwd: options.tishiWebDir,
      },
    });
  }
  if (options.ghPagesDir) {
    siteCommands.push({
      name: "gh-pages-sync",
      spec: {
        command: "git",
        args: ["status", "--short"],
        cwd: options.ghPagesDir,
      },
    });
  }

  return {
    macNoticeJson,
    builds,
    publishDesktop,
    publishGitHubMacUpload,
    publishMobileRelease,
    publishMobileFeed,
    siteCommands,
  };
}

/** Verifies live public endpoints: desktop feeds, moss-mac-notice.json, no *-mac.yml, and Range 206. */
export async function verifyLiveReleaseEndpoints(input: {
  readonly version: string;
  readonly buildNumber: number;
  readonly releaseRepo: string;
  readonly fetchImpl?: FetchLike;
  readonly downloadSources?: ReadonlyArray<string>;
  readonly siteUrls?: ReadonlyArray<string>;
}): Promise<ReadonlyArray<ReleaseStepReport>> {
  const fetchFn: FetchLike =
    input.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>);
  const sources = input.downloadSources ?? MOSS_DOWNLOAD_SOURCES.global;
  const results: ReleaseStepReport[] = [];

  for (const base of sources) {
    const normalized = base.endsWith("/") ? base : `${base}/`;
    const noticeRes = await fetchFn(`${normalized}desktop/moss-mac-notice.json`);
    if (noticeRes.status !== 200) {
      throw new Error(
        `${normalized}desktop/moss-mac-notice.json returned HTTP ${noticeRes.status}.`,
      );
    }
    const notice = JSON.parse(await noticeRes.text()) as { version?: string };
    if (notice.version !== input.version) {
      throw new Error(
        `${normalized}desktop/moss-mac-notice.json version=${String(notice.version)}, expected ${input.version}.`,
      );
    }

    for (const forbidden of ["latest-mac.yml", "moss-mac.yml"]) {
      const macYmlRes = await fetchFn(`${normalized}desktop/${forbidden}`);
      if (macYmlRes.status !== 404) {
        throw new Error(
          `${normalized}desktop/${forbidden} must be 404 (in-app Mac auto-update stays off), got ${macYmlRes.status}.`,
        );
      }
    }

    const winRange = await fetchFn(`${normalized}desktop/Moss-${input.version}-x64.exe`, {
      headers: { Range: "bytes=0-15" },
    });
    if (winRange.status !== 206) {
      throw new Error(
        `${normalized}desktop/Moss-${input.version}-x64.exe Range 0-15 returned ${winRange.status}, expected 206.`,
      );
    }

    const mobileManifestRes = await fetchFn(`${normalized}mobile/android-latest.json`);
    if (mobileManifestRes.status !== 200) {
      throw new Error(
        `${normalized}mobile/android-latest.json returned HTTP ${mobileManifestRes.status}.`,
      );
    }
    const mobileManifest = JSON.parse(await mobileManifestRes.text()) as {
      version?: string;
      buildNumber?: number;
    };
    if (
      mobileManifest.version !== input.version ||
      mobileManifest.buildNumber !== input.buildNumber
    ) {
      throw new Error(
        `${normalized}mobile/android-latest.json mismatch: got ${String(mobileManifest.version)}/${String(mobileManifest.buildNumber)}.`,
      );
    }

    results.push({
      stage: "verify",
      name: `mirror:${normalized}`,
      status: "ok",
      detail: `version=${input.version} buildNumber=${input.buildNumber} range206=ok macYml=404`,
    });
  }

  for (const url of input.siteUrls ?? [
    "https://mossbotai.com/download",
    "https://tishilabs.com/moss/download",
    `https://github.com/${input.releaseRepo}/releases/tag/v${input.version}`,
  ]) {
    const res = await fetchFn(url);
    if (res.status < 200 || res.status >= 400) {
      throw new Error(`Site verification failed for ${url}: HTTP ${res.status}.`);
    }
    results.push({
      stage: "verify",
      name: `site:${url}`,
      status: "ok",
      detail: `HTTP ${res.status}`,
    });
  }

  return results;
}

function defaultRunCommand(spec: CommandSpec): Promise<CommandOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function assertStepOk(name: string, res: CommandOutcome): string {
  if (res.status !== 0) {
    const tail = `${res.stdout}\n${res.stderr}`.trim().slice(-600);
    throw new Error(`${name} failed (exit ${String(res.status)}): ${tail}`);
  }
  return res.stdout.trim().split(/\r?\n/).at(-1) ?? "ok";
}

/** Executes or dry-runs the full unified release cut pipeline. */
export async function runReleaseCut(
  options: ReleaseCutOptions,
  deps: {
    readonly runCommand?: AsyncCommandRunner;
    readonly fetchImpl?: FetchLike;
    readonly log?: (line: string) => void;
    readonly checkSourceCommit?: (repoRoot: string, commit: string) => void;
  } = {},
): Promise<ReleaseCutReport> {
  const buildNumber = options.buildNumber ?? defaultBuildNumberForVersion(options.version);
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const log = deps.log ?? ((line: string) => console.log(line));
  const steps: ReleaseStepReport[] = [];

  if (!/^[0-9a-f]{40}$/i.test(options.sourceCommit)) {
    throw new Error(`--source-commit must be a 40-char SHA, got ${options.sourceCommit}.`);
  }

  if (!options.verifyOnly) {
    const alignment = verifyReleaseVersionAlignment({
      repoRoot: options.repoRoot,
      version: options.version,
      buildNumber,
    });
    const checkCommit =
      deps.checkSourceCommit ??
      ((repoRoot: string, commit: string) => {
        const res = spawnSync(
          "git",
          ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
          { cwd: repoRoot, encoding: "utf8", windowsHide: true },
        );
        if (res.status !== 0) {
          throw new Error(`Source commit ${commit} is not an ancestor of origin/main.`);
        }
      });
    checkCommit(options.repoRoot, options.sourceCommit);
    steps.push({
      stage: "preflight",
      name: "version-and-commit",
      status: "ok",
      detail: `${alignment.checkedFiles.length} manifests aligned at ${options.version} (${buildNumber})`,
    });
    log(`[preflight] ${steps.at(-1)!.detail}`);
  }

  const plan = buildReleasePlan({ ...options, buildNumber });

  if (!options.verifyOnly && !options.skipBuilds) {
    if (!options.execute) {
      for (const item of plan.builds) {
        steps.push({
          stage: "build",
          name: item.name,
          status: "dry-run",
          detail: `${item.spec.command} ${item.spec.args.join(" ")}`,
        });
      }
    } else {
      const outcomes = await Promise.all(
        plan.builds.map(async (item) => {
          const outcome = await runCommand(item.spec);
          return { name: item.name, detail: assertStepOk(item.name, outcome) };
        }),
      );
      for (const outcome of outcomes) {
        steps.push({ stage: "build", name: outcome.name, status: "ok", detail: outcome.detail });
      }
    }
  } else {
    steps.push({ stage: "build", name: "parallel-builds", status: "skipped", detail: "skipped" });
  }

  if (!options.verifyOnly && !options.skipPublish) {
    const desktopOut = await runCommand(plan.publishDesktop);
    steps.push({
      stage: "publish",
      name: "desktop-feed-release",
      status: options.execute ? "ok" : "dry-run",
      detail: assertStepOk("desktop-feed-release", desktopOut),
    });

    const mobileFeedOut = await runCommand(plan.publishMobileFeed);
    steps.push({
      stage: "publish",
      name: "mobile-feed-release",
      status: options.execute ? "ok" : "dry-run",
      detail: assertStepOk("mobile-feed-release", mobileFeedOut),
    });

    if (options.execute) {
      assertStepOk("github-mac-upload", await runCommand(plan.publishGitHubMacUpload));
      assertStepOk("github-mobile-release", await runCommand(plan.publishMobileRelease));
      steps.push({
        stage: "publish",
        name: "github-mac-and-mobile-assets",
        status: "ok",
        detail: `uploaded v${options.version} Mac + mobile-v${options.version} APK`,
      });
    } else {
      steps.push({
        stage: "publish",
        name: "github-mac-and-mobile-assets",
        status: "dry-run",
        detail: `would upload Mac assets to v${options.version} and create mobile-v${options.version}; moss-mac-notice.json=${plan.macNoticeJson.trim()}`,
      });
    }
  } else {
    steps.push({
      stage: "publish",
      name: "artifact-publish",
      status: "skipped",
      detail: "skipped",
    });
  }

  if (!options.verifyOnly && !options.skipSite && plan.siteCommands.length > 0) {
    for (const item of plan.siteCommands) {
      if (options.execute) {
        const res = await runCommand(item.spec);
        steps.push({
          stage: "site",
          name: item.name,
          status: "ok",
          detail: assertStepOk(item.name, res),
        });
      } else {
        steps.push({
          stage: "site",
          name: item.name,
          status: "dry-run",
          detail: `${item.spec.command} ${item.spec.args.join(" ")}`,
        });
      }
    }
  } else {
    steps.push({ stage: "site", name: "site-sync", status: "skipped", detail: "skipped" });
  }

  if (options.verifyOnly || options.execute) {
    const verified = await verifyLiveReleaseEndpoints({
      version: options.version,
      buildNumber,
      releaseRepo: options.releaseRepo,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    steps.push(...verified);
  } else {
    steps.push({
      stage: "verify",
      name: "live-endpoints",
      status: "dry-run",
      detail: "skipped in dry-run unless --verify-only is passed",
    });
  }

  return {
    version: options.version,
    buildNumber,
    sourceCommit: options.sourceCommit,
    execute: options.execute,
    steps,
  };
}

function parseCli(argv: ReadonlyArray<string>): ReleaseCutOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "string" },
      "source-commit": { type: "string" },
      "build-number": { type: "string" },
      "win-artifacts": { type: "string", default: "D:/DevTemp/moss-release/win-out" },
      "mac-artifacts": { type: "string", default: "D:/DevTemp/moss-release/mac-out" },
      "android-apk": { type: "string", default: "D:/DevTemp/moss-release/Moss-Android.apk" },
      "notes-file": { type: "string" },
      "notes-zh": { type: "string" },
      "notes-en": { type: "string" },
      "tishi-web-dir": { type: "string" },
      "gh-pages-dir": { type: "string" },
      "mac-direct-script": { type: "string" },
      "release-repo": { type: "string", default: "Zluowa/moss-releases" },
      execute: { type: "boolean", default: false },
      "skip-builds": { type: "boolean", default: false },
      "skip-publish": { type: "boolean", default: false },
      "skip-site": { type: "boolean", default: false },
      "verify-only": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.version || !values["source-commit"]) {
    throw new Error(
      "Usage: bun run release:cut -- --version <semver> --source-commit <40-hex-sha> [--execute] [--verify-only]",
    );
  }

  return {
    repoRoot: defaultRepoRoot,
    version: values.version,
    sourceCommit: values["source-commit"],
    buildNumber: values["build-number"] ? Number(values["build-number"]) : undefined,
    winArtifactsDir: values["win-artifacts"],
    macArtifactsDir: values["mac-artifacts"],
    androidApkPath: values["android-apk"],
    notesFile: values["notes-file"],
    notesZh: values["notes-zh"],
    notesEn: values["notes-en"],
    tishiWebDir: values["tishi-web-dir"],
    ghPagesDir: values["gh-pages-dir"],
    macDirectScript: values["mac-direct-script"],
    bunBin: process.execPath,
    ghBin: process.env.MOSS_GATES_GH ?? "gh",
    releaseRepo: values["release-repo"],
    execute: Boolean(values.execute),
    skipBuilds: Boolean(values["skip-builds"]),
    skipPublish: Boolean(values["skip-publish"]),
    skipSite: Boolean(values["skip-site"]),
    verifyOnly: Boolean(values["verify-only"]),
  };
}

if (import.meta.main) {
  const report = await runReleaseCut(parseCli(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
}
