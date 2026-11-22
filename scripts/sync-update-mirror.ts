// FILE: sync-update-mirror.ts
// Purpose: Keeps the domestic update mirror on the latest official release with no human step. A
//          mirror that falls behind still answers "no update", so its users would silently stay on
//          an old version and never reach the official feed. This compares the release's manifests
//          with what the mirror serves, copies whatever is missing, signs the manifests, and reads
//          everything back through the public URL, so a stale mirror fails the run instead.
// Usage:   bun run scripts/sync-update-mirror.ts [--assets-dir <release-directory>]
//            [--no-prune] [--prune-dry-run] [--keep-win-versions <n>] [--keep-mac-versions <n>]
//          `--assets-dir` uses the files already on this machine instead of downloading them again.
//          Automatic pruning runs strictly after upload and public URL read-back succeed, keeping
//          the latest 2 Windows versions and 1 macOS version per architecture (plus any file named
//          in synced manifests or `moss-mac-notice.json`).
//          Settings come from the environment and one settings folder per store, listed in
//          `MOSS_UPDATE_MIRROR_SETTINGS_DIRS` (the environment, or a line in `~/.moss-release`) for
//          several stores, e.g. COS and R2; see docs/ops/moss-cn-update-mirror.md.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY } from "@moss/shared/desktopIdentity";
import { mossDownloadSourceUrls } from "@moss/shared/mossDownloadSources";
import {
  deriveMossUpdateManifestPublicKey,
  MOSS_DESKTOP_UPDATE_FEED_PATH,
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
  MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX,
  parseMossUpdateMirrorConfig,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { parse } from "yaml";

import {
  checkRuntimeArchivesServed,
  formatRuntimeArchiveLine,
  parseRuntimePins,
  runtimeArchivesMissingMessage,
  runtimeSourceBaseUrl,
} from "./lib/runtime-archive-check.ts";
import {
  DEFAULT_KEEP_MAC_VERSIONS,
  DEFAULT_KEEP_WIN_VERSIONS,
  formatByteSize,
  formatGigabytes,
  formatUpdateMirrorPruneSummary,
  isS3PermissionError,
  MAC_UPDATE_NOTICE_FILE_NAME,
  parseMacUpdateNoticeVersion,
  planUpdateMirrorPrune,
  type UpdateMirrorObject,
} from "./lib/update-mirror-prune.ts";
import {
  describeUpdateMirrorStoreList,
  LOCAL_SETTINGS_FILES,
  resolveUpdateMirrorStores,
  type UpdateMirrorStoreSettings,
} from "./lib/update-mirror-stores.ts";
import {
  isChannelManifestFileName,
  isUpdateManifestFileName,
  RUNTIME_PINS_FILE_NAME,
} from "./sign-update-mirror-manifests.ts";

const GITHUB_API_URL = "https://api.github.com";
const UPLOAD_RETRIES = 3;
const SERVED_FILE_ATTEMPTS = 6;
const SERVED_FILE_RETRY_DELAY_MS = 15_000;
interface ReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly downloadUrl: string;
}

interface ManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

/** Where mirror objects are written. Anything meant to prove the mirror works reads the public URL. */
export interface UpdateMirrorStore {
  /** Bucket key prefix for this feed (e.g. "desktop/"); empty when keys are unprefixed. */
  readonly prefix?: string;
  upload(fileName: string, localPath: string): Promise<void>;
  /**
   * The stored size, or null if absent. This asks storage directly: asking through the CDN would
   * make it remember "not found" for a file that is about to exist.
   */
  sizeOf(fileName: string): Promise<number | null>;
  /** Lists objects stored under `prefix` (optional; enables automatic post-sync pruning). */
  list?(): Promise<ReadonlyArray<UpdateMirrorObject>>;
  /** Reads a UTF-8 text object directly from storage (e.g. `moss-mac-notice.json`). */
  readText?(fileName: string): Promise<string | null>;
  /** Deletes one object under `prefix` by its prefix-relative file name. */
  delete?(fileName: string): Promise<void>;
}

export interface UpdateMirrorPruneOptions {
  /** Whether pruning runs after upload and read-back succeed. Default: true. */
  readonly enabled?: boolean;
  /** When true, plans and logs deletions without removing any objects. Default: false. */
  readonly dryRun?: boolean;
  /** Number of latest Windows versions to retain per architecture lane. Default: 2. */
  readonly keepWinVersions?: number;
  /** Number of latest macOS versions to retain per architecture lane. Default: 1. */
  readonly keepMacVersions?: number;
}

export type UpdateMirrorPruneResult =
  | {
      readonly status: "pruned";
      readonly dryRun: false;
      readonly deleted: ReadonlyArray<string>;
      readonly bytesFreed: number;
      readonly remainingObjects: number;
      readonly remainingBytes: number;
    }
  | {
      readonly status: "dry-run";
      readonly dryRun: true;
      readonly wouldDelete: ReadonlyArray<string>;
      readonly bytesToFree: number;
      readonly remainingObjects: number;
      readonly remainingBytes: number;
    }
  | {
      readonly status: "permission-denied";
      readonly operation: "list" | "delete";
      readonly deleted: ReadonlyArray<string>;
      readonly bytesFreed: number;
      readonly message: string;
    };

export interface SyncUpdateMirrorInput {
  readonly repository: string;
  readonly feedUrl: string;
  readonly privateKey: string;
  readonly store: UpdateMirrorStore;
  /** A folder holding this release's files, used instead of downloading them when they match. */
  readonly assetsDirectory?: string;
  readonly prune?: UpdateMirrorPruneOptions;
  readonly githubApiUrl?: string;
  readonly githubToken?: string;
  readonly verifyRetryDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}

export type SyncUpdateMirrorResult =
  | {
      readonly status: "in-sync";
      readonly tag: string;
      readonly prune?: UpdateMirrorPruneResult;
    }
  | {
      readonly status: "synced";
      readonly tag: string;
      readonly manifests: ReadonlyArray<string>;
      readonly copied: ReadonlyArray<string>;
      readonly prune?: UpdateMirrorPruneResult;
    };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uncachedUrl(feedUrl: string, fileName: string): string {
  const url = new URL(fileName, feedUrl);
  url.searchParams.set("noCache", Date.now().toString(32));
  return url.toString();
}

async function readLatestRelease(input: {
  readonly repository: string;
  readonly apiUrl: string;
  readonly token: string | undefined;
  readonly fetchImpl: typeof fetch;
}): Promise<{ readonly tag: string; readonly assets: ReadonlyArray<ReleaseAsset> }> {
  const response = await input.fetchImpl(
    `${input.apiUrl}/repos/${input.repository}/releases/latest`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "moss-update-mirror-sync",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Could not read the latest release of ${input.repository}: ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.tag_name !== "string" || !Array.isArray(body.assets)) {
    throw new Error(`Unexpected release response from ${input.repository}.`);
  }
  const assets = body.assets.flatMap((asset: unknown): ReleaseAsset[] =>
    isRecord(asset) &&
    typeof asset.name === "string" &&
    typeof asset.size === "number" &&
    typeof asset.browser_download_url === "string"
      ? [{ name: asset.name, size: asset.size, downloadUrl: asset.browser_download_url }]
      : [],
  );
  return { tag: body.tag_name, assets };
}

function parseManifestFiles(channelFile: string, manifest: string): ReadonlyArray<ManifestFile> {
  const parsed: unknown = parse(manifest);
  const files = isRecord(parsed) ? parsed.files : null;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Manifest ${channelFile} lists no files.`);
  }
  return files.map((file: unknown): ManifestFile => {
    if (
      !isRecord(file) ||
      typeof file.url !== "string" ||
      typeof file.sha512 !== "string" ||
      typeof file.size !== "number"
    ) {
      throw new Error(`Manifest ${channelFile} has an invalid file entry.`);
    }
    return { url: file.url, sha512: file.sha512, size: file.size };
  });
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const response = await fetchImpl(url);
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function downloadVerified(input: {
  readonly fetchImpl: typeof fetch;
  readonly asset: ReleaseAsset;
  readonly destination: string;
  readonly expectedSha512: string | undefined;
}): Promise<void> {
  const { asset } = input;
  const response = await input.fetchImpl(asset.downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${asset.name}: ${response.status}`);
  }
  const hash = createHash("sha512");
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(input.destination),
  );
  if (size !== asset.size) {
    throw new Error(`${asset.name} is ${size} bytes, expected ${asset.size}.`);
  }
  if (input.expectedSha512 !== undefined && hash.digest("base64") !== input.expectedSha512) {
    throw new Error(`${asset.name} does not match the sha512 in its manifest.`);
  }
}

async function isMatchingLocalCopy(input: {
  readonly path: string;
  readonly asset: ReleaseAsset;
  readonly expectedSha512: string | undefined;
}): Promise<boolean> {
  try {
    if ((await stat(input.path)).size !== input.asset.size) return false;
    if (input.expectedSha512 === undefined) return true;
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(input.path)) hash.update(chunk as Buffer);
    return hash.digest("base64") === input.expectedSha512;
  } catch {
    return false;
  }
}

/**
 * Downloads the file the way an app will and checks it against its manifest entry, before that
 * manifest goes live. A file that is not served yet gets a few more tries; wrong bytes fail at once,
 * because waiting will not change them.
 */
async function assertServedAsListed(input: {
  readonly fetchImpl: typeof fetch;
  readonly feedUrl: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha512: string;
  readonly retryDelayMs: number;
}): Promise<void> {
  let lastProblem = "";
  for (let attempt = 0; attempt < SERVED_FILE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(input.retryDelayMs);
    const response = await input
      .fetchImpl(new URL(input.fileName, input.feedUrl))
      .catch((error: unknown) => {
        lastProblem = error instanceof Error ? error.message : String(error);
        return null;
      });
    if (!response) continue;
    if (!response.ok || !response.body) {
      lastProblem = `HTTP ${response.status}`;
      await response.body?.cancel();
      continue;
    }
    const hash = createHash("sha512");
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== input.size || hash.digest("base64") !== input.sha512) {
      throw new Error(`${input.fileName} on the mirror does not match its manifest.`);
    }
    return;
  }
  throw new Error(`${input.fileName} is not served by the mirror: ${lastProblem}`);
}

// What the app itself will do: signed manifest, no stale cache, and byte ranges for resuming.
async function findPublishProblems(input: {
  readonly fetchImpl: typeof fetch;
  readonly feedUrl: string;
  readonly manifests: ReadonlyMap<string, string>;
  readonly manifestPublicKey: string;
}): Promise<ReadonlyArray<string>> {
  const { fetchImpl, feedUrl } = input;
  const problems: string[] = [];
  for (const [channelFile, manifest] of input.manifests) {
    const live = await fetchText(fetchImpl, uncachedUrl(feedUrl, channelFile));
    if (live !== manifest) {
      problems.push(`${channelFile} on the mirror differs from the release.`);
      continue;
    }
    const signature = await fetchText(
      fetchImpl,
      uncachedUrl(feedUrl, `${channelFile}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`),
    );
    if (
      signature === null ||
      !verifyMossUpdateManifest({
        channelFile,
        manifest,
        signature,
        manifestPublicKey: input.manifestPublicKey,
      })
    ) {
      problems.push(`${channelFile} has no valid signature on the mirror.`);
    }
    const plain = await fetchText(fetchImpl, new URL(channelFile, feedUrl).toString());
    if (plain !== manifest) {
      problems.push(`${channelFile} is served stale without a cache-busting query; fix the CDN.`);
    }
    // Runtime pins name no installer; the runtimes have their own upload and check.
    if (!isChannelManifestFileName(channelFile)) continue;
    for (const file of parseManifestFiles(channelFile, manifest)) {
      const response = await fetchImpl(new URL(file.url, feedUrl), {
        headers: { range: "bytes=0-0" },
      }).catch(() => null);
      await response?.body?.cancel();
      const total = response?.headers.get("content-range")?.split("/")[1];
      if (response?.status !== 206 || Number(total) !== file.size) {
        problems.push(`${file.url} is not served with byte ranges at its full size.`);
      }
    }
  }
  return problems;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" && code.trim() !== ""
      ? `${code.trim()}: ${error.message}`
      : error.message;
  }
  return String(error);
}

function collectManifestProtectedFileNames(
  manifests: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
  const names: string[] = [];
  for (const [channelFile, manifest] of manifests) {
    if (!isChannelManifestFileName(channelFile)) continue;
    for (const file of parseManifestFiles(channelFile, manifest)) {
      names.push(file.url);
    }
  }
  return names;
}

/**
 * Removes obsolete versioned desktop installers strictly AFTER upload and public read-back checks
 * have passed for this store. Permission errors (403 / AccessDenied) log an actionable warning
 * without failing the release publish.
 */
async function pruneObsoleteInstallers(input: {
  readonly store: UpdateMirrorStore;
  readonly feedUrl: string;
  readonly manifests: ReadonlyMap<string, string>;
  readonly options: UpdateMirrorPruneOptions | undefined;
  readonly fetchImpl: typeof fetch;
  readonly log: (message: string) => void;
}): Promise<UpdateMirrorPruneResult | undefined> {
  const { store, feedUrl, log } = input;
  const enabled = input.options?.enabled ?? true;
  if (!enabled || !store.list) return undefined;

  const dryRun = input.options?.dryRun ?? false;
  const keepWinVersions = input.options?.keepWinVersions ?? DEFAULT_KEEP_WIN_VERSIONS;
  const keepMacVersions = input.options?.keepMacVersions ?? DEFAULT_KEEP_MAC_VERSIONS;
  const prefix = store.prefix ?? "";
  const prefixScope = prefix ? `prefix "${prefix}"` : "this store";

  let objects: ReadonlyArray<UpdateMirrorObject>;
  try {
    objects = await store.list();
  } catch (error) {
    if (isS3PermissionError(error)) {
      const detail = errorDetail(error);
      const message = `Warning: skipped pruning on ${feedUrl} — storage credentials lack ListBucket permission (${detail}). Grant ListBucket/GetBucket and DeleteObject on ${prefixScope} to enable automatic pruning.`;
      log(message);
      return {
        status: "permission-denied",
        operation: "list",
        deleted: [],
        bytesFreed: 0,
        message,
      };
    }
    throw error;
  }

  const protectedMacVersions: string[] = [];
  let protectAllMacVersions = false;
  const macNoticeKey = `${prefix}${MAC_UPDATE_NOTICE_FILE_NAME}`;
  if (objects.some((object) => object.key === macNoticeKey)) {
    const noticeText = store.readText
      ? await store.readText(MAC_UPDATE_NOTICE_FILE_NAME).catch(() => null)
      : await fetchText(input.fetchImpl, uncachedUrl(feedUrl, MAC_UPDATE_NOTICE_FILE_NAME));
    const noticeVersion = noticeText === null ? null : parseMacUpdateNoticeVersion(noticeText);
    if (noticeVersion !== null) {
      protectedMacVersions.push(noticeVersion);
    } else {
      protectAllMacVersions = true;
      log(
        `Warning: could not read or parse ${MAC_UPDATE_NOTICE_FILE_NAME} on ${feedUrl}; protecting all macOS installers from pruning.`,
      );
    }
  }

  const plan = planUpdateMirrorPrune({
    objects,
    prefix,
    keepWinVersions,
    keepMacVersions,
    protectedFileNames: collectManifestProtectedFileNames(input.manifests),
    protectedMacVersions,
    protectAllMacVersions,
  });

  if (dryRun) {
    for (const candidate of plan.toDelete) {
      log(`Prune dry-run: would delete ${candidate.fileName} (${formatByteSize(candidate.size)})`);
    }
    log(
      formatUpdateMirrorPruneSummary({
        dryRun: true,
        deletedCount: plan.toDelete.length,
        freedBytes: plan.bytesToFree,
        remainingObjects: plan.remainingObjectCount,
        remainingBytes: plan.remainingBytes,
        prefix,
      }),
    );
    return {
      status: "dry-run",
      dryRun: true,
      wouldDelete: plan.toDelete.map((candidate) => candidate.fileName),
      bytesToFree: plan.bytesToFree,
      remainingObjects: plan.remainingObjectCount,
      remainingBytes: plan.remainingBytes,
    };
  }

  if (plan.toDelete.length > 0 && !store.delete) {
    const message = `Warning: skipped pruning on ${feedUrl} — storage client does not support object deletion.`;
    log(message);
    return {
      status: "permission-denied",
      operation: "delete",
      deleted: [],
      bytesFreed: 0,
      message,
    };
  }

  const deleted: string[] = [];
  let bytesFreed = 0;
  for (const candidate of plan.toDelete) {
    try {
      await store.delete!(candidate.fileName);
    } catch (error) {
      if (isS3PermissionError(error)) {
        const detail = errorDetail(error);
        const remainingObjects = objects.length - deleted.length;
        const remainingBytes = Math.max(0, plan.totalBytesBefore - bytesFreed);
        const message = `Warning: stopped pruning on ${feedUrl} while deleting ${candidate.fileName} — storage credentials lack DeleteObject permission (${detail}). Grant DeleteObject on ${prefixScope} to enable automatic pruning. (Deleted ${deleted.length} object(s), freed ${formatByteSize(bytesFreed)}; remaining ${remainingObjects} object(s), ${formatGigabytes(remainingBytes)}.)`;
        log(message);
        return {
          status: "permission-denied",
          operation: "delete",
          deleted,
          bytesFreed,
          message,
        };
      }
      throw error;
    }
    deleted.push(candidate.fileName);
    bytesFreed += candidate.size;
    log(`Pruned ${candidate.fileName} (${formatByteSize(candidate.size)})`);
  }

  log(
    formatUpdateMirrorPruneSummary({
      dryRun: false,
      deletedCount: deleted.length,
      freedBytes: bytesFreed,
      remainingObjects: plan.remainingObjectCount,
      remainingBytes: plan.remainingBytes,
      prefix,
    }),
  );
  return {
    status: "pruned",
    dryRun: false,
    deleted,
    bytesFreed,
    remainingObjects: plan.remainingObjectCount,
    remainingBytes: plan.remainingBytes,
  };
}

export async function syncUpdateMirror(
  input: SyncUpdateMirrorInput,
): Promise<SyncUpdateMirrorResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = input.log ?? (() => undefined);
  const manifestPublicKey = deriveMossUpdateManifestPublicKey(input.privateKey);
  const release = await readLatestRelease({
    repository: input.repository,
    apiUrl: input.githubApiUrl ?? GITHUB_API_URL,
    token: input.githubToken,
    fetchImpl,
  });
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]));
  // Runtime pins first, so they are live before a channel manifest offers the version needing them.
  // Older releases have none, which is fine.
  const manifestAssets = release.assets
    .filter((asset) => isUpdateManifestFileName(asset.name))
    .toSorted(
      (left, right) =>
        Number(right.name === RUNTIME_PINS_FILE_NAME) -
        Number(left.name === RUNTIME_PINS_FILE_NAME),
    );
  if (!manifestAssets.some((asset) => isChannelManifestFileName(asset.name))) {
    throw new Error(
      `Latest release ${release.tag} of ${input.repository} has no update manifests, so no install can update from it.`,
    );
  }

  const manifests = new Map<string, string>();
  for (const asset of manifestAssets) {
    const manifest = await fetchText(fetchImpl, asset.downloadUrl);
    if (manifest === null) throw new Error(`Could not download ${asset.name}.`);
    manifests.set(asset.name, manifest);
  }

  // The app fetches the pinned runtimes right after install, so a store that lacks one would break
  // first launch for everyone it serves. Checked before this store gets any write.
  const pinsText = manifests.get(RUNTIME_PINS_FILE_NAME);
  if (pinsText !== undefined) {
    const pins = parseRuntimePins(pinsText);
    const lines = await checkRuntimeArchivesServed({
      pins,
      stores: [
        {
          label: input.feedUrl,
          baseUrl: runtimeSourceBaseUrl(
            { MOSS_UPDATE_MIRROR_FEED_URL: input.feedUrl },
            { severalStores: true },
          ),
        },
      ],
      fetchImpl,
      ...(input.verifyRetryDelayMs !== undefined ? { retryDelayMs: input.verifyRetryDelayMs } : {}),
    });
    for (const line of lines) log(formatRuntimeArchiveLine(line));
    const missing = lines.filter((line) => !line.ok);
    if (missing.length > 0) {
      throw new Error(
        `Nothing was written to this store. ${runtimeArchivesMissingMessage(missing)}`,
      );
    }
  }

  const problemsBefore = await findPublishProblems({
    fetchImpl,
    feedUrl: input.feedUrl,
    manifests,
    manifestPublicKey,
  });
  if (problemsBefore.length === 0) {
    log(`Mirror already serves ${release.tag}.`);
    const prune = await pruneObsoleteInstallers({
      store: input.store,
      feedUrl: input.feedUrl,
      manifests,
      options: input.prune,
      fetchImpl,
      log,
    });
    return {
      status: "in-sync",
      tag: release.tag,
      ...(prune ? { prune } : {}),
    };
  }
  log(`Mirror is behind ${release.tag}: ${problemsBefore.join(" ")}`);

  // Validate the whole set first: a manifest pointing at a missing file must never go live.
  const copyPlan = new Map<string, { asset: ReleaseAsset; sha512: string | undefined }>();
  for (const [channelFile, manifest] of manifests) {
    if (!isChannelManifestFileName(channelFile)) continue;
    for (const file of parseManifestFiles(channelFile, manifest)) {
      const asset = assetsByName.get(file.url);
      if (!asset) {
        throw new Error(`${channelFile} names ${file.url}, which the release does not have.`);
      }
      if (asset.size !== file.size) {
        throw new Error(
          `${file.url} is ${asset.size} bytes, but ${channelFile} says ${file.size}.`,
        );
      }
      copyPlan.set(file.url, { asset, sha512: file.sha512 });
      const blockmap = assetsByName.get(`${file.url}.blockmap`);
      if (blockmap) copyPlan.set(blockmap.name, { asset: blockmap, sha512: undefined });
    }
  }

  const workDirectory = await mkdtemp(join(tmpdir(), "moss-update-mirror-"));
  try {
    const copied: string[] = [];
    for (const { asset, sha512 } of copyPlan.values()) {
      if ((await input.store.sizeOf(asset.name)) === asset.size) {
        log(`Already on the mirror: ${asset.name}`);
        continue;
      }
      const localCopy = input.assetsDirectory ? join(input.assetsDirectory, asset.name) : null;
      if (
        localCopy !== null &&
        (await isMatchingLocalCopy({ path: localCopy, asset, expectedSha512: sha512 }))
      ) {
        log(`Copying ${asset.name} (${asset.size} bytes) from this machine`);
        await input.store.upload(asset.name, localCopy);
        copied.push(asset.name);
        continue;
      }
      const localPath = join(workDirectory, asset.name);
      log(`Copying ${asset.name} (${asset.size} bytes)`);
      await downloadVerified({ fetchImpl, asset, destination: localPath, expectedSha512: sha512 });
      await input.store.upload(asset.name, localPath);
      await rm(localPath, { force: true });
      copied.push(asset.name);
    }

    for (const { asset, sha512 } of copyPlan.values()) {
      if (sha512 === undefined) continue;
      log(`Checking ${asset.name} through the public URL`);
      await assertServedAsListed({
        fetchImpl,
        feedUrl: input.feedUrl,
        fileName: asset.name,
        size: asset.size,
        sha512,
        retryDelayMs: input.verifyRetryDelayMs ?? SERVED_FILE_RETRY_DELAY_MS,
      });
    }

    // Last, so a client never reads a manifest whose files are not there yet.
    for (const [channelFile, manifest] of manifests) {
      const manifestPath = join(workDirectory, channelFile);
      const signatureName = `${channelFile}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`;
      const signaturePath = join(workDirectory, signatureName);
      await writeFile(manifestPath, manifest);
      await writeFile(
        signaturePath,
        `${signMossUpdateManifest({ channelFile, manifest, privateKey: input.privateKey })}\n`,
      );
      await input.store.upload(signatureName, signaturePath);
      await input.store.upload(channelFile, manifestPath);
    }

    const problemsAfter = await findPublishProblems({
      fetchImpl,
      feedUrl: input.feedUrl,
      manifests,
      manifestPublicKey,
    });
    if (problemsAfter.length > 0) {
      throw new Error(`Mirror is still wrong after syncing: ${problemsAfter.join(" ")}`);
    }
    log(`Mirror now serves ${release.tag}.`);
    const prune = await pruneObsoleteInstallers({
      store: input.store,
      feedUrl: input.feedUrl,
      manifests,
      options: input.prune,
      fetchImpl,
      log,
    });
    return {
      status: "synced",
      tag: release.tag,
      manifests: [...manifests.keys()],
      copied,
      ...(prune ? { prune } : {}),
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export interface UpdateMirrorS3ClientOptions {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly virtualHostedStyle: boolean;
}

/**
 * The storage client settings shared by this tool and the plugin catalog upload, for one store.
 * Cloudflare R2 (endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`) is
 * addressed path-style, which is the default. `MOSS_UPDATE_MIRROR_S3_PATH_STYLE=0` switches to
 * virtual-hosted addressing, which the Tencent COS bucket requires.
 */
export function readUpdateMirrorS3ClientOptions(
  env: Readonly<Record<string, string | undefined>>,
): UpdateMirrorS3ClientOptions {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  const pathStyle = env.MOSS_UPDATE_MIRROR_S3_PATH_STYLE?.trim();
  if (pathStyle !== undefined && pathStyle !== "" && pathStyle !== "0" && pathStyle !== "1") {
    throw new Error(
      "MOSS_UPDATE_MIRROR_S3_PATH_STYLE must be 1 (path-style) or 0 (virtual-hosted).",
    );
  }
  return {
    accessKeyId: required("MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID"),
    secretAccessKey: required("MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY"),
    bucket: required("MOSS_UPDATE_MIRROR_S3_BUCKET"),
    endpoint: required("MOSS_UPDATE_MIRROR_S3_ENDPOINT"),
    region: required("MOSS_UPDATE_MIRROR_S3_REGION"),
    virtualHostedStyle: pathStyle === "0",
  };
}

function createS3MirrorStore(env: Readonly<Record<string, string | undefined>>): UpdateMirrorStore {
  const prefix = env.MOSS_UPDATE_MIRROR_S3_PREFIX?.trim() ?? "";
  const client = new Bun.S3Client(readUpdateMirrorS3ClientOptions(env));
  return {
    prefix,
    upload: async (fileName, localPath) => {
      await client.file(`${prefix}${fileName}`).write(Bun.file(localPath), {
        type: isChannelManifestFileName(fileName)
          ? "text/yaml"
          : fileName.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
        retry: UPLOAD_RETRIES,
      });
    },
    sizeOf: async (fileName) => {
      try {
        return (await client.file(`${prefix}${fileName}`).stat()).size;
      } catch {
        // Treated as missing: the worst case is uploading a file again.
        return null;
      }
    },
    list: async () => {
      const objects: UpdateMirrorObject[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.list({
          ...(prefix ? { prefix } : {}),
          maxKeys: 1000,
          ...(continuationToken ? { continuationToken } : {}),
        });
        for (const entry of response.contents ?? []) {
          objects.push({ key: entry.key, size: entry.size ?? 0 });
        }
        continuationToken = response.isTruncated ? response.nextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
    readText: async (fileName) => {
      try {
        return await client.file(`${prefix}${fileName}`).text();
      } catch {
        return null;
      }
    },
    delete: async (fileName) => {
      await client.file(`${prefix}${fileName}`).delete();
    },
  };
}

// The store resolver lives in scripts/lib (other projects compile that folder); importers of this
// file keep finding it here.
export {
  describeUpdateMirrorStoreList,
  LOCAL_SETTINGS_FILES,
  parseSettingsFile,
  readUpdateMirrorStoreSettings,
  resolveUpdateMirrorStores,
  splitUpdateMirrorSettingsDirs,
  UPDATE_MIRROR_STORE_SETTING_NAMES,
  type UpdateMirrorStoreResolution,
  type UpdateMirrorStoreSettings,
} from "./lib/update-mirror-stores.ts";

/** The one signing key every store shares; it may be set in the environment or in any folder. */
export function resolveUpdateMirrorSigningKey(
  stores: ReadonlyArray<UpdateMirrorStoreSettings>,
): string {
  const keys = new Set(
    stores.flatMap((store) => {
      const value = store.env.MOSS_UPDATE_MIRROR_SIGNING_KEY?.trim();
      return value ? [value] : [];
    }),
  );
  if (keys.size === 0) throw new Error("MOSS_UPDATE_MIRROR_SIGNING_KEY is not set.");
  if (keys.size > 1) {
    throw new Error("The settings folders hold different MOSS_UPDATE_MIRROR_SIGNING_KEY values.");
  }
  return [...keys][0]!;
}

/** Where a single store's feed is when its settings do not say: the R2 source. */
const DEFAULT_SINGLE_STORE_FEED_URL = mossDownloadSourceUrls(
  "global",
  MOSS_DESKTOP_UPDATE_FEED_PATH,
)[0]!;

export interface UpdateMirrorStoreOutcome {
  readonly label: string;
  readonly feedUrl: string | null;
  readonly result: SyncUpdateMirrorResult | null;
  readonly error: string | null;
}

export interface SyncUpdateMirrorCliOptions {
  readonly assetsDirectory: string | undefined;
  readonly prune: Required<UpdateMirrorPruneOptions>;
}

function parsePositiveIntegerFlag(flag: string, rawValue: string | undefined): number {
  if (!rawValue || rawValue.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  if (!/^[1-9]\d*$/u.test(rawValue)) {
    throw new Error(`${flag} must be a positive integer (>= 1), got "${rawValue}".`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer (>= 1), got "${rawValue}".`);
  }
  return value;
}

export function parseSyncUpdateMirrorArgs(args: ReadonlyArray<string>): SyncUpdateMirrorCliOptions {
  let assetsDirectory: string | undefined;
  let noPrune = false;
  let pruneDryRun = false;
  let keepWinVersions = DEFAULT_KEEP_WIN_VERSIONS;
  let keepMacVersions = DEFAULT_KEEP_MAC_VERSIONS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--assets-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --assets-dir.");
      assetsDirectory = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--assets-dir=")) {
      const value = arg.slice("--assets-dir=".length);
      if (!value) throw new Error("Missing value for --assets-dir.");
      assetsDirectory = value;
      continue;
    }
    if (arg === "--no-prune") {
      noPrune = true;
      continue;
    }
    if (arg === "--prune-dry-run") {
      pruneDryRun = true;
      continue;
    }
    if (arg === "--keep-win-versions") {
      keepWinVersions = parsePositiveIntegerFlag("--keep-win-versions", args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--keep-win-versions=")) {
      keepWinVersions = parsePositiveIntegerFlag(
        "--keep-win-versions",
        arg.slice("--keep-win-versions=".length),
      );
      continue;
    }
    if (arg === "--keep-mac-versions") {
      keepMacVersions = parsePositiveIntegerFlag("--keep-mac-versions", args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--keep-mac-versions=")) {
      keepMacVersions = parsePositiveIntegerFlag(
        "--keep-mac-versions",
        arg.slice("--keep-mac-versions=".length),
      );
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (noPrune && pruneDryRun) {
    throw new Error("Cannot combine --no-prune and --prune-dry-run.");
  }

  return {
    assetsDirectory,
    prune: {
      enabled: !noPrune,
      dryRun: pruneDryRun,
      keepWinVersions,
      keepMacVersions,
    },
  };
}

/**
 * Syncs every configured store, one after another, each with its own feed URL and storage, then
 * fails if any store failed or is still stale. One store failing never hides another's result.
 */
export async function runUpdateMirrorSync(input: {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly createStore?: (env: Readonly<Record<string, string | undefined>>) => UpdateMirrorStore;
  /** The public key built into the app; null skips the check (mock updates). */
  readonly builtInPublicKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly verifyRetryDelayMs?: number;
  readonly log?: (message: string) => void;
}): Promise<ReadonlyArray<UpdateMirrorStoreOutcome>> {
  const log = input.log ?? (() => undefined);
  const cli = parseSyncUpdateMirrorArgs(input.args);
  const resolution = await resolveUpdateMirrorStores({
    env: input.env,
    homeDirectory: input.homeDirectory,
    files: LOCAL_SETTINGS_FILES,
  });
  const listNote = describeUpdateMirrorStoreList(resolution);
  if (listNote) log(listNote);
  const { stores, severalStores } = resolution;
  const mock = Boolean(input.env.MOSS_DESKTOP_MOCK_UPDATES);
  const privateKey = resolveUpdateMirrorSigningKey(stores);
  const publicKey = deriveMossUpdateManifestPublicKey(privateKey);
  const builtInPublicKey =
    input.builtInPublicKey === undefined
      ? mock
        ? null
        : MOSS_UPDATE_MANIFEST_PUBLIC_KEY
      : input.builtInPublicKey;
  if (builtInPublicKey !== null && builtInPublicKey !== publicKey) {
    throw new Error("The signing key does not match the public key built into the app.");
  }
  const { assetsDirectory, prune } = cli;

  const outcomes: UpdateMirrorStoreOutcome[] = [];
  const feedUrlsSeen = new Set<string>();
  for (const store of stores) {
    let feedUrl: string | null = null;
    try {
      const configuredFeedUrl = store.env.MOSS_UPDATE_MIRROR_FEED_URL?.trim();
      if (!configuredFeedUrl && severalStores) {
        throw new Error(`MOSS_UPDATE_MIRROR_FEED_URL is not set in ${store.label}.`);
      }
      feedUrl = parseMossUpdateMirrorConfig(
        {
          feedUrl: configuredFeedUrl || DEFAULT_SINGLE_STORE_FEED_URL,
          manifestPublicKey: publicKey,
        },
        { allowLoopback: mock },
      ).feedUrl;
      if (feedUrlsSeen.has(feedUrl)) {
        throw new Error(`${feedUrl} is the feed of another settings folder too.`);
      }
      feedUrlsSeen.add(feedUrl);
      if (severalStores) log(`Store ${store.label}: ${feedUrl}`);
      const githubApiUrl = store.env.MOSS_UPDATE_MIRROR_GITHUB_API_URL?.trim();
      const githubToken = store.env.GITHUB_TOKEN?.trim();
      const result = await syncUpdateMirror({
        repository:
          store.env.MOSS_DESKTOP_UPDATE_REPOSITORY?.trim() ||
          MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY,
        feedUrl,
        privateKey,
        store: (input.createStore ?? createS3MirrorStore)(store.env),
        ...(assetsDirectory ? { assetsDirectory } : {}),
        prune,
        ...(githubApiUrl ? { githubApiUrl } : {}),
        ...(githubToken ? { githubToken } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.verifyRetryDelayMs !== undefined
          ? { verifyRetryDelayMs: input.verifyRetryDelayMs }
          : {}),
        log,
      });
      outcomes.push({ label: store.label, feedUrl, result, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Store ${store.label} failed: ${message}`);
      outcomes.push({ label: store.label, feedUrl, result: null, error: message });
    }
  }
  const failed = outcomes.filter((outcome) => outcome.error !== null);
  if (failed.length > 0) {
    const summary = failed.map((outcome) => `${outcome.label}: ${outcome.error}`).join("\n");
    throw Object.assign(
      new Error(
        `${failed.length} of ${outcomes.length} update mirror store(s) failed:\n${summary}`,
      ),
      { outcomes },
    );
  }
  return outcomes;
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const outcomes = await runUpdateMirrorSync({
    args,
    env: process.env,
    homeDirectory: homedir(),
    log: (message) => console.log(message),
  });
  for (const outcome of outcomes) console.log(JSON.stringify(outcome.result));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
