// FILE: desktop-feed-release.ts
// Purpose: Puts one built Windows installer on the public update feed under the
// file names installed apps request, then proves the feed answers the way the
// updater will ask. release.yml stays the signed path; this is the operator path
// for builds made outside it, and everything it ships is unsigned.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { parse } from "yaml";

import {
  assertStableReleaseVersionMonotonic,
  channelManifestNames,
} from "./release-update-policy.ts";

const DEFAULT_MAX_UPLOAD_ATTEMPTS = 3;
const DEFAULT_MAX_VERIFY_ATTEMPTS = 10;

export interface PrepareFeedReleaseInput {
  readonly artifactsDirectory: string;
  readonly version: string;
  readonly channel: string;
  readonly publishedStableTags: readonly string[];
}

interface FeedFileDigest {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly sha512: string;
}

export interface FeedAsset extends FeedFileDigest {
  readonly path: string;
}

export interface PreparedFeedRelease {
  readonly version: string;
  readonly tag: string;
  readonly installerName: string;
  readonly manifestName: string;
  readonly assets: readonly FeedAsset[];
}

export interface RemoteRelease {
  readonly id: number;
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly htmlUrl: string;
}

export interface RemoteAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly state: string;
  readonly digest: string | null;
}

export interface FeedReleaseClient {
  readonly listReleases: () => Promise<readonly RemoteRelease[]>;
  readonly tagExists: (tag: string) => Promise<boolean>;
  readonly createDraft: (input: {
    readonly tag: string;
    readonly name: string;
    readonly body: string;
  }) => Promise<RemoteRelease>;
  readonly listAssets: (releaseId: number) => Promise<readonly RemoteAsset[]>;
  readonly deleteAsset: (assetId: number) => Promise<void>;
  readonly uploadAsset: (releaseId: number, asset: FeedAsset) => Promise<void>;
  readonly publish: (releaseId: number) => Promise<RemoteRelease>;
  /** The tag the updater resolves as Latest, asked the way the updater asks. */
  readonly readLatestTag: () => Promise<string | null>;
  readonly readPublicFile: (tag: string, name: string) => Promise<Buffer | null>;
  readonly readPublicFileSize: (tag: string, name: string) => Promise<number | null>;
}

export interface PublishFeedReleaseOptions {
  readonly name: string;
  readonly body: string;
  readonly log?: (message: string) => void;
  readonly wait?: (attempt: number) => Promise<void>;
  readonly maxUploadAttempts?: number;
  readonly maxVerifyAttempts?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestFile(path: string): FeedFileDigest {
  const name = basename(path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Release asset must be a non-empty regular file: ${name}`);
  }
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  let size = 0;
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      sha512.update(chunk);
      size += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return { name, size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

function assertWindowsManifestMatchesInstaller(
  manifestText: string,
  version: string,
  installer: FeedFileDigest,
): void {
  const manifest = parse(manifestText) as unknown;
  if (!isRecord(manifest)) {
    throw new Error("latest.yml must be an object.");
  }
  if (manifest.version !== version) {
    throw new Error(`latest.yml has version ${String(manifest.version)}, expected ${version}.`);
  }
  const files = manifest.files;
  const file = Array.isArray(files) && files.length === 1 ? (files[0] as unknown) : null;
  if (!isRecord(file) || file.url !== installer.name) {
    throw new Error(`latest.yml must list exactly one file, ${installer.name}.`);
  }
  if (file.sha512 !== installer.sha512 || file.size !== installer.size) {
    throw new Error(`latest.yml does not describe the bytes of ${installer.name}.`);
  }
  if (manifest.path !== installer.name || manifest.sha512 !== installer.sha512) {
    throw new Error(`latest.yml path and sha512 must point at ${installer.name}.`);
  }
}

/**
 * Validates a build folder and writes the two derived files into it: the channel
 * manifest installed apps request, and the checksum list. Only reads the network
 * through `publishedStableTags`, so a dry run can call this with nothing at stake.
 */
export function prepareFeedRelease(input: PrepareFeedReleaseInput): PreparedFeedRelease {
  const { artifactsDirectory, version, channel } = input;
  // A suffixed version would never reach production installs: they follow GitHub's
  // Latest release, which excludes prereleases, and isUpdateVersionAllowedForFlavor
  // refuses any suffix. So this also rejects what the updater would silently ignore.
  assertStableReleaseVersionMonotonic(version, input.publishedStableTags);
  const [, manifestName] = channelManifestNames(channel);
  if (!manifestName) throw new Error(`No Windows manifest for channel ${channel}.`);

  const installerName = `Moss-${version}-x64.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const installer = digestFile(join(artifactsDirectory, installerName));
  const latestPath = join(artifactsDirectory, "latest.yml");
  const latest = digestFile(latestPath);
  const blockmap = digestFile(join(artifactsDirectory, blockmapName));

  const manifestBytes = readFileSync(latestPath);
  assertWindowsManifestMatchesInstaller(manifestBytes.toString("utf8"), version, installer);

  const manifestPath = join(artifactsDirectory, manifestName);
  writeFileSync(manifestPath, manifestBytes);
  const manifest = digestFile(manifestPath);

  const checksummed = [installer, blockmap, latest, manifest].toSorted((left, right) =>
    left.name < right.name ? -1 : 1,
  );
  const checksumPath = join(artifactsDirectory, "SHA256SUMS");
  writeFileSync(
    checksumPath,
    `${checksummed.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
  );
  const checksum = digestFile(checksumPath);

  return {
    version,
    tag: `v${version}`,
    installerName,
    manifestName,
    assets: [...checksummed, checksum].map((asset) =>
      Object.assign({ path: join(artifactsDirectory, asset.name) }, asset),
    ),
  };
}

function isCompleteUpload(remote: RemoteAsset, local: FeedAsset): boolean {
  return (
    remote.state === "uploaded" &&
    remote.size === local.size &&
    (remote.digest === null || remote.digest === `sha256:${local.sha256}`)
  );
}

async function reconcileDraftAssets(
  prepared: PreparedFeedRelease,
  releaseId: number,
  client: FeedReleaseClient,
  log: (message: string) => void,
): Promise<readonly FeedAsset[]> {
  const localByName = new Map(prepared.assets.map((asset) => [asset.name, asset]));
  const complete = new Set<string>();
  for (const remote of await client.listAssets(releaseId)) {
    const local = localByName.get(remote.name);
    if (local && isCompleteUpload(remote, local)) {
      complete.add(remote.name);
      continue;
    }
    log(`Removing incomplete or foreign draft asset ${remote.name}.`);
    await client.deleteAsset(remote.id);
  }
  return prepared.assets.filter((asset) => !complete.has(asset.name));
}

async function uploadAllAssets(
  prepared: PreparedFeedRelease,
  releaseId: number,
  client: FeedReleaseClient,
  options: PublishFeedReleaseOptions,
  log: (message: string) => void,
): Promise<void> {
  const maxAttempts = options.maxUploadAttempts ?? DEFAULT_MAX_UPLOAD_ATTEMPTS;
  let lastFailure: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const missing = await reconcileDraftAssets(prepared, releaseId, client, log);
    if (missing.length === 0) return;
    try {
      for (const asset of missing) {
        log(`Uploading ${asset.name} (${asset.size} bytes).`);
        await client.uploadAsset(releaseId, asset);
      }
    } catch (cause) {
      lastFailure = cause;
      log(`Upload attempt ${attempt} failed: ${describeFailure(cause)}`);
      await options.wait?.(attempt);
    }
  }
  const stillMissing = await reconcileDraftAssets(prepared, releaseId, client, log);
  if (stillMissing.length > 0) {
    throw new Error(
      `Draft release is still missing ${stillMissing.map((asset) => asset.name).join(", ")}; nothing was published. Last failure: ${describeFailure(lastFailure)}`,
    );
  }
}

async function readFeedProblem(
  prepared: PreparedFeedRelease,
  client: FeedReleaseClient,
): Promise<string | null> {
  const latestTag = await client.readLatestTag();
  if (latestTag !== prepared.tag) {
    return `GitHub's Latest release is ${String(latestTag)}, expected ${prepared.tag}.`;
  }
  const manifest = prepared.assets.find((asset) => asset.name === prepared.manifestName);
  const installer = prepared.assets.find((asset) => asset.name === prepared.installerName);
  if (!manifest || !installer) throw new Error("Prepared release lost its manifest or installer.");

  const publicManifest = await client.readPublicFile(prepared.tag, manifest.name);
  if (publicManifest === null) return `${manifest.name} is not publicly downloadable yet.`;
  if (!publicManifest.equals(readFileSync(manifest.path))) {
    return `Public ${manifest.name} differs from the file that was uploaded.`;
  }
  const publicSize = await client.readPublicFileSize(prepared.tag, installer.name);
  if (publicSize !== installer.size) {
    return `Public ${installer.name} is ${String(publicSize)} bytes, expected ${installer.size}.`;
  }
  return null;
}

/** Checks the feed the way an installed app does, anonymously and through Latest. */
export async function verifyPublicFeed(
  prepared: PreparedFeedRelease,
  client: FeedReleaseClient,
  options: Pick<PublishFeedReleaseOptions, "wait" | "maxVerifyAttempts"> = {},
): Promise<void> {
  const maxAttempts = options.maxVerifyAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS;
  let problem: string | null = "not checked";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    problem = await readFeedProblem(prepared, client);
    if (problem === null) return;
    if (attempt < maxAttempts) await options.wait?.(attempt);
  }
  throw new Error(`Public update feed check failed after ${maxAttempts} attempts: ${problem}`);
}

/** Uploads to a draft first, so users see nothing until every byte is on GitHub. */
export async function publishFeedRelease(
  prepared: PreparedFeedRelease,
  client: FeedReleaseClient,
  options: PublishFeedReleaseOptions,
): Promise<RemoteRelease> {
  const log = options.log ?? (() => {});
  const releases = await client.listReleases();
  const existing = releases.filter((release) => release.tagName === prepared.tag);
  if (existing.some((release) => !release.draft) || (await client.tagExists(prepared.tag))) {
    throw new Error(`${prepared.tag} already exists on the feed; releases are never overwritten.`);
  }
  const draft =
    existing[0] ??
    (await client.createDraft({ tag: prepared.tag, name: options.name, body: options.body }));
  log(`Using draft release ${draft.id} for ${prepared.tag}.`);

  await uploadAllAssets(prepared, draft.id, client, options, log);

  const published = await client.publish(draft.id);
  log(`Published ${published.htmlUrl}; checking the public feed.`);
  await verifyPublicFeed(prepared, client, options);
  return published;
}

export interface SyncDomesticMirrorInput {
  readonly scriptPath: string;
  readonly artifactsDirectory: string;
  readonly cwd: string;
  readonly log?: (message: string) => void;
}

/**
 * The domestic mirror must follow every release: a stale mirror still answers
 * "no update", so the accounts that read it first would never see this version.
 * This runs after publication, and publishing again refuses an existing tag, so a
 * failure names the one command that finishes the job.
 */
export function syncDomesticMirror(input: SyncDomesticMirrorInput): void {
  const { scriptPath, artifactsDirectory, cwd } = input;
  if (!existsSync(scriptPath)) {
    input.log?.("This checkout has no domestic mirror sync; skipping it.");
    return;
  }
  const result = spawnSync(process.execPath, [scriptPath, "--assets-dir", artifactsDirectory], {
    cwd,
    stdio: "inherit",
    // This token can write to the public repository; the sync only reads it.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "GITHUB_TOKEN"),
    ),
  });
  if (result.status !== 0) {
    throw new Error(
      `Published to GitHub, but the domestic mirror did not sync. Fix it and rerun: bun run scripts/sync-update-mirror.ts --assets-dir ${artifactsDirectory}`,
    );
  }
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface CurlFeedClientOptions {
  readonly repository: string;
  readonly token: string | null;
  readonly apiBaseUrl?: string;
  readonly uploadBaseUrl?: string;
  readonly webBaseUrl?: string;
}

interface CurlResponse {
  readonly status: number;
  readonly body: Buffer;
}

function runCurl(args: readonly string[], token: string | null): Promise<CurlResponse> {
  return new Promise((resolvePromise, reject) => {
    // The token goes through stdin so it never appears in a process listing.
    const child = spawn(
      "curl",
      ["--silent", "--show-error", "--location", "--config", "-", ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      const output = Buffer.concat(stdout);
      const separator = output.lastIndexOf(0x0a);
      resolvePromise({
        status: Number(output.subarray(separator + 1).toString("utf8")),
        body: output.subarray(0, Math.max(separator, 0)),
      });
    });
    child.stdin.end(token ? `header = "Authorization: Bearer ${token}"\n` : "");
  });
}

function parseRelease(value: unknown): RemoteRelease {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.tag_name !== "string" ||
    typeof value.draft !== "boolean" ||
    typeof value.prerelease !== "boolean" ||
    typeof value.html_url !== "string"
  ) {
    throw new Error("GitHub release response is missing its identity.");
  }
  return {
    id: value.id,
    tagName: value.tag_name,
    draft: value.draft,
    prerelease: value.prerelease,
    htmlUrl: value.html_url,
  };
}

function parseAsset(value: unknown): RemoteAsset {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.name !== "string" ||
    typeof value.size !== "number" ||
    typeof value.state !== "string"
  ) {
    throw new Error("GitHub release asset response is missing its identity.");
  }
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    state: value.state,
    digest: typeof value.digest === "string" ? value.digest : null,
  };
}

function json(response: CurlResponse): unknown {
  return JSON.parse(response.body.toString("utf8")) as unknown;
}

/** GitHub client over curl, which reaches GitHub where this machine's Node fetch times out. */
export function createCurlFeedClient(options: CurlFeedClientOptions): FeedReleaseClient {
  const { repository, token } = options;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const uploadBaseUrl = options.uploadBaseUrl ?? "https://uploads.github.com";
  const webBaseUrl = options.webBaseUrl ?? "https://github.com";
  const statusFormat = ["--write-out", "\n%{http_code}"];
  const apiHeaders = [
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    "X-GitHub-Api-Version: 2022-11-28",
  ];

  const api = async (
    method: string,
    path: string,
    body?: unknown,
    allowedStatuses: readonly number[] = [],
  ): Promise<CurlResponse> => {
    const response = await runCurl(
      [
        ...statusFormat,
        ...apiHeaders,
        "--request",
        method,
        ...(body === undefined
          ? []
          : ["--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body)]),
        `${apiBaseUrl}${path}`,
      ],
      token,
    );
    if (
      (response.status < 200 || response.status >= 300) &&
      !allowedStatuses.includes(response.status)
    ) {
      throw new Error(
        `GitHub ${method} ${path} answered ${response.status}: ${response.body.toString("utf8").slice(0, 300)}`,
      );
    }
    return response;
  };

  return {
    listReleases: async () => {
      const response = await api("GET", `/repos/${repository}/releases?per_page=100`);
      const releases = json(response);
      if (!Array.isArray(releases)) throw new Error("GitHub release list is not an array.");
      return releases.map(parseRelease);
    },
    tagExists: async (tag) => {
      const response = await api(
        "GET",
        `/repos/${repository}/git/ref/tags/${tag}`,
        undefined,
        [404],
      );
      return response.status !== 404;
    },
    createDraft: async ({ tag, name, body }) =>
      parseRelease(
        json(
          await api("POST", `/repos/${repository}/releases`, {
            tag_name: tag,
            target_commitish: "main",
            name,
            body,
            draft: true,
            prerelease: false,
          }),
        ),
      ),
    listAssets: async (releaseId) => {
      const response = await api(
        "GET",
        `/repos/${repository}/releases/${releaseId}/assets?per_page=100`,
      );
      const assets = json(response);
      if (!Array.isArray(assets)) throw new Error("GitHub asset list is not an array.");
      return assets.map(parseAsset);
    },
    deleteAsset: async (assetId) => {
      await api("DELETE", `/repos/${repository}/releases/assets/${assetId}`);
    },
    uploadAsset: async (releaseId, asset) => {
      const response = await runCurl(
        [
          ...statusFormat,
          ...apiHeaders,
          "--header",
          "Content-Type: application/octet-stream",
          // Without this, curl waits on a 100-continue that GitHub may never send.
          "--header",
          "Expect:",
          "--speed-limit",
          "1024",
          "--speed-time",
          "120",
          "--request",
          "POST",
          "--upload-file",
          asset.path,
          `${uploadBaseUrl}/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
        ],
        token,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Upload of ${asset.name} answered ${response.status}: ${response.body.toString("utf8").slice(0, 300)}`,
        );
      }
    },
    publish: async (releaseId) =>
      parseRelease(
        json(
          await api("PATCH", `/repos/${repository}/releases/${releaseId}`, {
            draft: false,
            prerelease: false,
            make_latest: "true",
          }),
        ),
      ),
    readLatestTag: async () => {
      const response = await runCurl(
        [
          ...statusFormat,
          "--header",
          "Accept: application/json",
          `${webBaseUrl}/${repository}/releases/latest`,
        ],
        null,
      );
      if (response.status !== 200) return null;
      const latest = json(response);
      return isRecord(latest) && typeof latest.tag_name === "string" ? latest.tag_name : null;
    },
    readPublicFile: async (tag, name) => {
      const response = await runCurl(
        [...statusFormat, `${webBaseUrl}/${repository}/releases/download/${tag}/${name}`],
        null,
      );
      return response.status === 200 ? response.body : null;
    },
    readPublicFileSize: async (tag, name) => {
      // Prints the headers of every redirect hop; the last length is the file's.
      const response = await runCurl(
        [...statusFormat, "--head", `${webBaseUrl}/${repository}/releases/download/${tag}/${name}`],
        null,
      );
      if (response.status !== 200) return null;
      const lengths = [...response.body.toString("utf8").matchAll(/^content-length:\s*(\d+)/gim)];
      const length = lengths.at(-1)?.[1];
      return length === undefined ? null : Number(length);
    },
  };
}
