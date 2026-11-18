// FILE: sync-update-mirror.ts
// Purpose: Keeps the domestic update mirror on the latest official release with no human step. A
//          mirror that falls behind still answers "no update", so its users would silently stay on
//          an old version and never reach the official feed. This compares the release's manifests
//          with what the mirror serves, copies whatever is missing, signs the manifests, and reads
//          everything back through the public URL, so a stale mirror fails the run instead.
// Usage:   bun run scripts/sync-update-mirror.ts [--assets-dir <release-directory>]
//          `--assets-dir` uses the files already on this machine instead of downloading them again.
//          Settings come from the environment and one settings folder per store, listed in
//          `MOSS_UPDATE_MIRROR_SETTINGS_DIRS` (the environment, or a line in `~/.moss-release`) for
//          several stores, e.g. COS and R2; see docs/ops/moss-cn-update-mirror.md.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
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
  isChannelManifestFileName,
  isUpdateManifestFileName,
  RUNTIME_PINS_FILE_NAME,
} from "./sign-update-mirror-manifests.ts";

const GITHUB_API_URL = "https://api.github.com";
const UPLOAD_RETRIES = 3;
const SERVED_FILE_ATTEMPTS = 6;
const SERVED_FILE_RETRY_DELAY_MS = 15_000;
/** The settings files the sync reads from each settings folder. */
export const LOCAL_SETTINGS_FILES: ReadonlyArray<string> = [
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
    return { status: "in-sync", tag: release.tag };
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
    return { status: "synced", tag: release.tag, manifests: [...manifests.keys()], copied };
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
 * Settings that belong to one store: its public feed and catalog URLs and its storage account.
 * With several settings folders each store takes these from its own folder only.
 */
export const UPDATE_MIRROR_STORE_SETTING_NAMES: ReadonlyArray<string> = [
  "MOSS_UPDATE_MIRROR_FEED_URL",
  "MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID",
  "MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY",
  "MOSS_UPDATE_MIRROR_S3_BUCKET",
  "MOSS_UPDATE_MIRROR_S3_ENDPOINT",
  "MOSS_UPDATE_MIRROR_S3_REGION",
  "MOSS_UPDATE_MIRROR_S3_PATH_STYLE",
  "MOSS_UPDATE_MIRROR_S3_PREFIX",
  "MOSS_PLUGIN_CATALOG_S3_PREFIX",
  "MOSS_PLUGIN_CATALOG_URL",
];

export interface UpdateMirrorStoreSettings {
  /** The settings folder, for messages. */
  readonly label: string;
  /** What one store's run sees: the process environment plus that store's own folder. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * `MOSS_UPDATE_MIRROR_SETTINGS_DIRS` lists one settings folder per store, separated by the
 * platform's path-list separator (`;` on Windows, `:` elsewhere), as in PATH.
 */
export function splitUpdateMirrorSettingsDirs(
  value: string,
  separator: string = delimiter,
): ReadonlyArray<string> {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Names that say where the settings folders are; never a setting of a store. */
const SETTINGS_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "MOSS_UPDATE_MIRROR_SETTINGS_DIRS",
  "MOSS_UPDATE_MIRROR_SETTINGS_DIR",
]);

export interface UpdateMirrorStoreResolution {
  readonly stores: ReadonlyArray<UpdateMirrorStoreSettings>;
  /**
   * True when the stores come from a folder list (even a list of one): then every folder must
   * name its own feed URL, and nothing falls back to the single-store defaults.
   */
  readonly severalStores: boolean;
  /** The settings folder whose files listed the store folders; null for the variable or one store. */
  readonly listedIn: string | null;
}

/**
 * The stores to write and the settings of each, for every tool that writes the stores.
 *
 * - `MOSS_UPDATE_MIRROR_SETTINGS_DIRS` in the environment: one store per listed folder.
 * - Otherwise the settings folder is `MOSS_UPDATE_MIRROR_SETTINGS_DIR` (default `~/.moss-release`).
 *   If its files hold a `MOSS_UPDATE_MIRROR_SETTINGS_DIRS=` line, that line lists the store
 *   folders instead (relative entries resolve against that folder). The listing folder's own store
 *   settings apply to no store; its other settings (the signing key, for example) are shared by
 *   every store, below the environment.
 * - No list: one store from that folder, where values already in the environment win, as before.
 *
 * With a list each store's settings come only from its own folder: a store setting already in the
 * process environment is refused, since it would apply to every store at once. A listed folder
 * may not list folders itself.
 */
export async function resolveUpdateMirrorStores(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly files: ReadonlyArray<string>;
  readonly separator?: string;
}): Promise<UpdateMirrorStoreResolution> {
  const { env } = input;
  const readFolder = async (directory: string): Promise<Record<string, string>> => {
    const values: Record<string, string> = {};
    for (const fileName of input.files) {
      const text = await readFile(join(directory, fileName), "utf8").catch(() => "");
      for (const [name, value] of parseSettingsFile(text)) values[name] ??= value;
    }
    return values;
  };
  const definedEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );

  const listedStores = async (
    directories: ReadonlyArray<string>,
    source: string,
    shared: Readonly<Record<string, string>>,
  ): Promise<ReadonlyArray<UpdateMirrorStoreSettings>> => {
    const leaking = UPDATE_MIRROR_STORE_SETTING_NAMES.filter((name) => definedEnv[name]);
    if (leaking.length > 0) {
      throw new Error(
        `${leaking.join(", ")} ${leaking.length === 1 ? "is" : "are"} set in the environment; with ${source} every store's settings must come from its own folder.`,
      );
    }
    if (directories.length === 0) throw new Error(`${source} lists no folder.`);
    if (new Set(directories.map((directory) => resolve(directory))).size !== directories.length) {
      throw new Error(`${source} names a folder twice.`);
    }
    const stores: UpdateMirrorStoreSettings[] = [];
    for (const directory of directories) {
      const values = await readFolder(directory);
      if (values.MOSS_UPDATE_MIRROR_SETTINGS_DIRS?.trim()) {
        throw new Error(
          `${directory} is a store folder listed in ${source}, but it lists store folders itself (MOSS_UPDATE_MIRROR_SETTINGS_DIRS); remove that line from it.`,
        );
      }
      const own = Object.fromEntries(
        Object.entries(values).filter(([name]) => !SETTINGS_FOLDER_NAMES.has(name)),
      );
      stores.push({ label: directory, env: { ...shared, ...definedEnv, ...own } });
    }
    return stores;
  };

  const dirsValue = env.MOSS_UPDATE_MIRROR_SETTINGS_DIRS?.trim();
  if (dirsValue) {
    if (env.MOSS_UPDATE_MIRROR_SETTINGS_DIR?.trim()) {
      throw new Error(
        "Set MOSS_UPDATE_MIRROR_SETTINGS_DIRS or MOSS_UPDATE_MIRROR_SETTINGS_DIR, not both.",
      );
    }
    return {
      stores: await listedStores(
        splitUpdateMirrorSettingsDirs(dirsValue, input.separator),
        "MOSS_UPDATE_MIRROR_SETTINGS_DIRS",
        {},
      ),
      severalStores: true,
      listedIn: null,
    };
  }

  const directory =
    env.MOSS_UPDATE_MIRROR_SETTINGS_DIR?.trim() || join(input.homeDirectory, ".moss-release");
  const values = await readFolder(directory);
  const listValue = values.MOSS_UPDATE_MIRROR_SETTINGS_DIRS?.trim();
  if (!listValue) {
    return {
      stores: [{ label: directory, env: { ...values, ...definedEnv } }],
      severalStores: false,
      listedIn: null,
    };
  }
  const shared = Object.fromEntries(
    Object.entries(values).filter(
      ([name]) =>
        !UPDATE_MIRROR_STORE_SETTING_NAMES.includes(name) && !SETTINGS_FOLDER_NAMES.has(name),
    ),
  );
  return {
    stores: await listedStores(
      splitUpdateMirrorSettingsDirs(listValue, input.separator).map((entry) =>
        isAbsolute(entry) ? entry : resolve(directory, entry),
      ),
      `MOSS_UPDATE_MIRROR_SETTINGS_DIRS in ${directory}`,
      shared,
    ),
    severalStores: true,
    listedIn: directory,
  };
}

/** The stores only; see resolveUpdateMirrorStores. */
export async function readUpdateMirrorStoreSettings(
  input: Parameters<typeof resolveUpdateMirrorStores>[0],
): Promise<ReadonlyArray<UpdateMirrorStoreSettings>> {
  return (await resolveUpdateMirrorStores(input)).stores;
}

/** One line for the log when a settings file listed the stores; names folders, never values. */
export function describeUpdateMirrorStoreList(
  resolution: UpdateMirrorStoreResolution,
): string | null {
  if (resolution.listedIn === null) return null;
  return `Store folders listed in ${resolution.listedIn}: ${resolution.stores.map((store) => store.label).join(", ")}`;
}

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
  const assetsDirectoryFlag = input.args.indexOf("--assets-dir");
  const assetsDirectory =
    assetsDirectoryFlag >= 0 ? input.args[assetsDirectoryFlag + 1] : undefined;
  if (assetsDirectoryFlag >= 0 && !assetsDirectory) {
    throw new Error("Missing value for --assets-dir.");
  }

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
