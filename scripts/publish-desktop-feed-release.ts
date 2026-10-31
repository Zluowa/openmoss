// FILE: publish-desktop-feed-release.ts
// Purpose: Operator command for docs/release.md's unsigned feed release. Without
// `--publish` it only validates and prints the plan; publishing requires naming
// the exact tag, so a stray run cannot put anything on the public repository.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY } from "@synara/shared/desktopIdentity";

import {
  createCurlFeedClient,
  prepareFeedRelease,
  publishFeedRelease,
  syncDomesticMirror,
  verifyPublicFeed,
} from "./lib/desktop-feed-release.ts";
import { readReleaseUpdatePolicyConfig } from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RETRY_DELAY_MS = 15_000;

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function requireFlag(args: readonly string[], name: string): string {
  const value = readFlag(args, name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return value;
}

function git(args: readonly string[]): { readonly ok: boolean; readonly stdout: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout };
}

/** The feed must only carry bytes built from a commit that is really on main. */
function assertSourceCommit(sourceCommit: string, version: string): void {
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error(`--source-commit must be a full commit hash, got ${sourceCommit}.`);
  }
  const packageJson = git(["show", `${sourceCommit}:apps/desktop/package.json`]);
  if (!packageJson.ok) throw new Error(`Source commit ${sourceCommit} is not available locally.`);
  const sourceVersion = (JSON.parse(packageJson.stdout) as { version?: string }).version;
  if (sourceVersion !== version) {
    throw new Error(`Source commit carries version ${String(sourceVersion)}, expected ${version}.`);
  }
  if (!git(["merge-base", "--is-ancestor", sourceCommit, "refs/remotes/origin/main"]).ok) {
    throw new Error(
      `Source commit ${sourceCommit} is not on origin/main. Fetch, or merge it first.`,
    );
  }
}

function releaseBody(notes: string, version: string, sourceCommit: string): string {
  return [
    notes.trim(),
    "",
    `This build is not code signed. Windows may show a SmartScreen warning the first time it is installed; choose "More info", then "Run anyway". Moss apps already on 1.0.2-beta.1 or later update themselves on Windows.`,
    "",
    `这个版本没有代码签名。第一次安装时 Windows 可能提示“已保护你的电脑”，点“更多信息”，再点“仍要运行”。已经装了 1.0.2-beta.1 及之后版本的 Windows 用户会自动收到更新。`,
    "",
    `- Version: ${version}`,
    `- Source commit: ${sourceCommit}`,
    "- Checksums: SHA256SUMS",
  ].join("\n");
}

async function main(args: readonly string[]): Promise<void> {
  const artifactsDirectory = resolve(requireFlag(args, "--artifacts-directory"));
  const version = requireFlag(args, "--version");
  const sourceCommit = requireFlag(args, "--source-commit").toLowerCase();
  const publishTag = readFlag(args, "--publish");
  const notesFile = readFlag(args, "--notes-file");
  const verifyOnly = args.includes("--verify-only");
  const repository = readFlag(args, "--repository") ?? MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY;
  const token = process.env.GITHUB_TOKEN?.trim() || null;
  const wait = (): Promise<void> => sleep(RETRY_DELAY_MS).then(() => undefined);

  if (publishTag !== undefined && publishTag !== `v${version}`) {
    throw new Error(`--publish must name the exact tag v${version}, got ${publishTag}.`);
  }
  if (publishTag !== undefined && (!token || !notesFile)) {
    throw new Error("--publish requires GITHUB_TOKEN and --notes-file.");
  }

  const client = createCurlFeedClient({ repository, token });
  const channel = readReleaseUpdatePolicyConfig(repoRoot).channel;
  assertSourceCommit(sourceCommit, version);

  const releases = await client.listReleases();
  const publishedStableTags = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => release.tagName)
    .filter((tag) => !(verifyOnly && tag === `v${version}`));
  const prepared = prepareFeedRelease({
    artifactsDirectory,
    version,
    channel,
    publishedStableTags,
  });

  console.log(`Repository: ${repository}`);
  console.log(`Tag: ${prepared.tag} (GitHub Latest, not a prerelease)`);
  console.log(`Source commit: ${sourceCommit}`);
  console.log(`Update manifest apps request: ${prepared.manifestName}`);
  for (const asset of prepared.assets) {
    console.log(`  ${asset.name}  ${asset.size} bytes  sha256=${asset.sha256}`);
  }

  if (verifyOnly) {
    await verifyPublicFeed(prepared, client, { wait });
    console.log("Public feed answers with this build.");
    return;
  }
  if (publishTag === undefined) {
    console.log(`Dry run: nothing was sent. Publish with --publish ${prepared.tag}.`);
    return;
  }

  const published = await publishFeedRelease(prepared, client, {
    name: `Moss ${version}`,
    body: releaseBody(readFileSync(resolve(notesFile as string), "utf8"), version, sourceCommit),
    log: (message) => console.log(message),
    wait,
  });
  console.log(`Published and verified: ${published.htmlUrl}`);
  syncDomesticMirror({
    scriptPath: resolve(repoRoot, "scripts/sync-update-mirror.ts"),
    artifactsDirectory,
    cwd: repoRoot,
    log: (message) => console.log(message),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
