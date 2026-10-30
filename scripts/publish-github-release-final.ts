#!/usr/bin/env node
// FILE: publish-github-release-final.ts
// Purpose: Perform the sole public release mutation with idempotent recovery.
// Layer: Release publication

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  publishGitHubReleaseFinal,
  type FinalGitHubReleasePublication,
} from "./lib/github-release-publication.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredExact(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseBoolean(name: string): boolean {
  const value = required(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got ${value}.`);
  }
  return parsed;
}

function parseMakeLatest(value: string): FinalGitHubReleasePublication["makeLatest"] {
  if (value === "true" || value === "false" || value === "legacy") return value;
  throw new Error(`MAKE_LATEST must be true, false, or legacy, got ${value}.`);
}

function runGitHubApi(args: readonly string[], token?: string): unknown {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(token === undefined ? {} : { GH_TOKEN: token }),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh api exited with status ${result.status}.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("gh api returned an invalid JSON release response.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface IndexedReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly state: "uploaded";
}

function parseObjectSha(value: unknown, label: string): string {
  if (
    !isRecord(value) ||
    !isRecord(value.object) ||
    typeof value.object.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.object.sha)
  ) {
    throw new Error(`${label} returned an invalid object SHA.`);
  }
  return value.object.sha;
}

function readIndexedReleaseAssets(
  indexPath: string,
  expectedIndexSha256: string,
): readonly IndexedReleaseAsset[] {
  const bytes = readFileSync(indexPath);
  const actualIndexSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualIndexSha256 !== expectedIndexSha256) {
    throw new Error("Release asset index changed before a publication attempt.");
  }
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.assets)) {
    throw new Error("Release asset index is missing its assets array.");
  }
  const assets = parsed.assets.map((value, index): IndexedReleaseAsset => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
      throw new Error(`Release asset index entry ${index + 1} is invalid.`);
    }
    return {
      name: value.name,
      size: value.size,
      digest: `sha256:${value.sha256}`,
      state: "uploaded",
    };
  });
  if (new Set(assets.map(({ name }) => name)).size !== assets.length) {
    throw new Error("Release asset index contains duplicate names.");
  }
  return assets.toSorted((left, right) => left.name.localeCompare(right.name));
}

function parseRemoteReleaseAssets(value: unknown): readonly IndexedReleaseAsset[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub release assets response must be an array.");
  }
  const assets = value.map((asset, index): IndexedReleaseAsset => {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      typeof asset.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(asset.digest) ||
      asset.state !== "uploaded"
    ) {
      throw new Error(`GitHub release asset ${index + 1} is invalid.`);
    }
    return {
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
      state: "uploaded",
    };
  });
  if (new Set(assets.map(({ name }) => name)).size !== assets.length) {
    throw new Error("GitHub release assets contain duplicate names.");
  }
  return assets.toSorted((left, right) => left.name.localeCompare(right.name));
}

function assertSameIndexedAssets(
  expectedAssets: readonly IndexedReleaseAsset[],
  remoteAssets: readonly IndexedReleaseAsset[],
): void {
  if (JSON.stringify(remoteAssets) !== JSON.stringify(expectedAssets)) {
    throw new Error("Remote release assets drifted from the immutable asset index.");
  }
}

const releaseVersion = required("RELEASE_VERSION");
const expected: FinalGitHubReleasePublication = {
  repository: required("MOSS_RELEASE_REPOSITORY"),
  releaseId: parsePositiveInteger("RELEASE_ID", required("RELEASE_ID")),
  releaseTag: required("RELEASE_TAG"),
  targetCommitish: "main",
  releaseName: `Moss v${releaseVersion}`,
  releaseBody: requiredExact("EXPECTED_RELEASE_BODY"),
  sourceRepository: required("SOURCE_REPOSITORY"),
  sourceCommit: required("EVENT_SHA"),
  workflowRunId: required("GITHUB_RUN_ID"),
  maxWorkflowRunAttempt: parsePositiveInteger("GITHUB_RUN_ATTEMPT", required("GITHUB_RUN_ATTEMPT")),
  prerelease: parseBoolean("IS_PRERELEASE"),
  makeLatest: parseMakeLatest(required("MAKE_LATEST")),
};
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository)) {
  throw new Error(`MOSS_RELEASE_REPOSITORY is invalid: ${expected.repository}.`);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.sourceRepository)) {
  throw new Error(`SOURCE_REPOSITORY is invalid: ${expected.sourceRepository}.`);
}
if (!/^[0-9a-f]{40}$/.test(expected.sourceCommit)) {
  throw new Error(`EVENT_SHA is invalid: ${expected.sourceCommit}.`);
}
if (!/^[1-9][0-9]*$/.test(expected.workflowRunId)) {
  throw new Error(`GITHUB_RUN_ID is invalid: ${expected.workflowRunId}.`);
}

const releaseEndpoint = `repos/${expected.repository}/releases/${expected.releaseId}`;
const sourceGitHubToken = required("SOURCE_GITHUB_TOKEN");
const publicMainSha = required("PUBLIC_MAIN_SHA");
const assetIndexPath = required("ASSET_INDEX_PATH");
const expectedAssetIndexSha256 = required("EXPECTED_ASSET_INDEX_SHA256");
if (!/^[0-9a-f]{40}$/.test(publicMainSha)) {
  throw new Error(`PUBLIC_MAIN_SHA is invalid: ${publicMainSha}.`);
}
if (!/^[0-9a-f]{64}$/.test(expectedAssetIndexSha256)) {
  throw new Error(`EXPECTED_ASSET_INDEX_SHA256 is invalid: ${expectedAssetIndexSha256}.`);
}

await publishGitHubReleaseFinal(expected, {
  readRelease: async () => runGitHubApi([releaseEndpoint]),
  readLatestRelease: async () => runGitHubApi([`repos/${expected.repository}/releases/latest`]),
  revalidateBeforePublish: async () => {
    const expectedAssets = readIndexedReleaseAssets(assetIndexPath, expectedAssetIndexSha256);
    const sourceMainSha = parseObjectSha(
      runGitHubApi([`repos/${expected.sourceRepository}/git/ref/heads/main`], sourceGitHubToken),
      "Source main",
    );
    if (sourceMainSha !== expected.sourceCommit) {
      throw new Error("Source main moved before a GitHub release publication attempt.");
    }
    const publicTagSha = parseObjectSha(
      runGitHubApi([`repos/${expected.repository}/git/ref/tags/${expected.releaseTag}`]),
      "Public release tag",
    );
    if (publicTagSha !== publicMainSha) {
      throw new Error("Public release tag moved before a GitHub release publication attempt.");
    }
    const remoteAssets = parseRemoteReleaseAssets(
      runGitHubApi([`${releaseEndpoint}/assets?per_page=100`]),
    );
    assertSameIndexedAssets(expectedAssets, remoteAssets);
  },
  publishRelease: async () =>
    runGitHubApi([
      "--method",
      "PATCH",
      releaseEndpoint,
      "-F",
      "draft=false",
      "-F",
      `prerelease=${expected.prerelease}`,
      "-f",
      `make_latest=${expected.makeLatest}`,
      "-f",
      `body=${expected.releaseBody}`,
    ]),
  waitBeforeRetry: async (attempt) => {
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  },
});
