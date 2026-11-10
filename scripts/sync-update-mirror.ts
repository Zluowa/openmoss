// FILE: sync-update-mirror.ts
// Purpose: Keeps the domestic update mirror on the latest official release with no human step. A
//          mirror that falls behind still answers "no update", so its users would silently stay on
//          an old version and never reach the official feed. This compares the release's manifests
//          with what the mirror serves, copies whatever is missing, signs the manifests, and reads
//          everything back through the public URL, so a stale mirror fails the run instead.
// Usage:   bun run scripts/sync-update-mirror.ts [--assets-dir <release-directory>]
//          `--assets-dir` uses the files already on this machine instead of downloading them again.
//          Settings come from the environment; see docs/ops/moss-cn-update-mirror.md.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY } from "@moss/shared/desktopIdentity";
import {
  deriveMossUpdateManifestPublicKey,
  MOSS_DESKTOP_CN_UPDATE_MIRROR,
  MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX,
  parseMossUpdateMirrorConfig,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { parse } from "yaml";

import { isUpdateManifestFileName } from "./sign-update-mirror-manifests.ts";

const GITHUB_API_URL = "https://api.github.com";
const UPLOAD_RETRIES = 3;
const SERVED_FILE_ATTEMPTS = 6;
const SERVED_FILE_RETRY_DELAY_MS = 15_000;
const LOCAL_SETTINGS_FILES = [
  "update-mirror.env",
  "update-mirror-signing.env",
  "update-mirror-upload.env",
];

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
  upload(fileName: string, localPath: string): Promise<void>;
  /**
   * The stored size, or null if absent. This asks storage directly: asking through the CDN would
   * make it remember "not found" for a file that is about to exist.
   */
  sizeOf(fileName: string): Promise<number | null>;
}

export interface SyncUpdateMirrorInput {
  readonly repository: string;
  readonly feedUrl: string;
  readonly privateKey: string;
  readonly store: UpdateMirrorStore;
  /** A folder holding this release's files, used instead of downloading them when they match. */
  readonly assetsDirectory?: string;
  readonly githubApiUrl?: string;
  readonly githubToken?: string;
  readonly verifyRetryDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}

export type SyncUpdateMirrorResult =
  | { readonly status: "in-sync"; readonly tag: string }
  | {
      readonly status: "synced";
      readonly tag: string;
      readonly manifests: ReadonlyArray<string>;
      readonly copied: ReadonlyArray<string>;
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
  const manifestAssets = release.assets.filter((asset) => isUpdateManifestFileName(asset.name));
  if (manifestAssets.length === 0) {
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

  const problemsBefore = await findPublishProblems({
    fetchImpl,
    feedUrl: input.feedUrl,
    manifests,
    manifestPublicKey,
  });
  if (problemsBefore.length === 0) {
    log(`Mirror already serves ${release.tag}.`);
    return { status: "in-sync", tag: release.tag };
  }
  log(`Mirror is behind ${release.tag}: ${problemsBefore.join(" ")}`);

  // Validate the whole set first: a manifest pointing at a missing file must never go live.
  const copyPlan = new Map<string, { asset: ReleaseAsset; sha512: string | undefined }>();
  for (const [channelFile, manifest] of manifests) {
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
    return { status: "synced", tag: release.tag, manifests: [...manifests.keys()], copied };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function createS3MirrorStore(): UpdateMirrorStore {
  const prefix = process.env.MOSS_UPDATE_MIRROR_S3_PREFIX?.trim() ?? "";
  const client = new Bun.S3Client({
    accessKeyId: requireEnv("MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY"),
    bucket: requireEnv("MOSS_UPDATE_MIRROR_S3_BUCKET"),
    endpoint: requireEnv("MOSS_UPDATE_MIRROR_S3_ENDPOINT"),
    region: requireEnv("MOSS_UPDATE_MIRROR_S3_REGION"),
    // Tencent COS refuses path-style addressing on buckets created since 2024.
    virtualHostedStyle: process.env.MOSS_UPDATE_MIRROR_S3_PATH_STYLE !== "1",
  });
  return {
    upload: async (fileName, localPath) => {
      await client.file(`${prefix}${fileName}`).write(Bun.file(localPath), {
        type: isUpdateManifestFileName(fileName) ? "text/yaml" : "application/octet-stream",
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
  };
}

/** `KEY=VALUE` lines; blank lines and `#` comments are skipped. */
export function parseSettingsFile(text: string): ReadonlyArray<readonly [string, string]> {
  return text.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    return match?.[1] && match[2] ? [[match[1], match[2]]] : [];
  });
}

/**
 * The publishing machine keeps its settings in one folder, so publishing needs no extra setup.
 * Values already in the environment win.
 */
async function loadLocalSettings(): Promise<void> {
  const directory =
    process.env.MOSS_UPDATE_MIRROR_SETTINGS_DIR?.trim() || join(homedir(), ".moss-release");
  for (const fileName of LOCAL_SETTINGS_FILES) {
    const text = await readFile(join(directory, fileName), "utf8").catch(() => "");
    for (const [name, value] of parseSettingsFile(text)) {
      process.env[name] ??= value;
    }
  }
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  await loadLocalSettings();
  const builtIn = MOSS_DESKTOP_CN_UPDATE_MIRROR;
  const configuredFeedUrl = process.env.MOSS_UPDATE_MIRROR_FEED_URL?.trim() || builtIn?.feedUrl;
  // The publish tool always calls this. Before a mirror exists, that must not fail a release.
  if (!configuredFeedUrl) {
    console.log("No update mirror is configured; nothing to sync.");
    return;
  }
  const privateKey = requireEnv("MOSS_UPDATE_MIRROR_SIGNING_KEY");
  if (
    builtIn &&
    !process.env.MOSS_DESKTOP_MOCK_UPDATES &&
    builtIn.manifestPublicKey !== deriveMossUpdateManifestPublicKey(privateKey)
  ) {
    throw new Error("The signing key does not match the public key built into the app.");
  }
  const { feedUrl } = parseMossUpdateMirrorConfig(
    {
      feedUrl: configuredFeedUrl,
      manifestPublicKey: deriveMossUpdateManifestPublicKey(privateKey),
    },
    { allowLoopback: Boolean(process.env.MOSS_DESKTOP_MOCK_UPDATES) },
  );
  const assetsDirectoryFlag = args.indexOf("--assets-dir");
  const assetsDirectory = assetsDirectoryFlag >= 0 ? args[assetsDirectoryFlag + 1] : undefined;
  if (assetsDirectoryFlag >= 0 && !assetsDirectory) {
    throw new Error("Missing value for --assets-dir.");
  }
  const githubApiUrl = process.env.MOSS_UPDATE_MIRROR_GITHUB_API_URL?.trim();
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const result = await syncUpdateMirror({
    repository:
      process.env.MOSS_DESKTOP_UPDATE_REPOSITORY?.trim() || MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY,
    feedUrl,
    privateKey,
    store: createS3MirrorStore(),
    ...(assetsDirectory ? { assetsDirectory } : {}),
    ...(githubApiUrl ? { githubApiUrl } : {}),
    ...(githubToken ? { githubToken } : {}),
    log: (message) => console.log(message),
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
