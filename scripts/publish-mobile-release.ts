// FILE: publish-mobile-release.ts
// Purpose: Validates a dual-ABI Moss Android APK, writes & Ed25519-signs `android-latest.json`,
//          uploads it to BOTH Tencent COS (CN) and Cloudflare R2 (Global) under `mobile/`, verifies
//          live public GET + Range 206 read-back on every mirror, and prunes obsolete APK versions.
// Layer: Release CLI / tooling (Bun + TypeScript). Never logs or prints secrets.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  compareSemver,
  deriveMossUpdateManifestPublicKey,
  isCosDefaultDomainFeed,
  MOSS_MOBILE_ANDROID_APK_PREFIX,
  MOSS_MOBILE_ANDROID_MANIFEST_FILE,
  MOSS_MOBILE_UPDATE_FEED_PATH,
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
  MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX,
  parseMossMobileUpdateManifest,
  parseSemver,
  resolveMobileArtifactUrl,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
  type MossMobileUpdateManifest,
} from "../packages/shared/src/mossUpdateMirror";
import {
  LOCAL_SETTINGS_FILES,
  resolveUpdateMirrorStores,
  type UpdateMirrorStoreSettings,
} from "./lib/update-mirror-stores.ts";
import {
  readUpdateMirrorS3ClientOptions,
  resolveUpdateMirrorSigningKey,
} from "./sync-update-mirror.ts";

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const APK_VERSION_NAME_RE = /^Moss-Android-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.(?:apk|bin)$/;

export interface ApkZipInspection {
  readonly entryNames: ReadonlyArray<string>;
  readonly hasArm64: boolean;
  readonly hasX86_64: boolean;
  readonly hasAndroidBundle: boolean;
}

/** Parses ZIP Central Directory entries directly from `apkBuffer` and validates Dual-ABI + RN bundle. */
export function inspectApkZipEntries(apkBuffer: Buffer): ApkZipInspection {
  if (
    apkBuffer.length < 22 ||
    apkBuffer[0] !== ZIP_LOCAL_MAGIC[0] ||
    apkBuffer[1] !== ZIP_LOCAL_MAGIC[1] ||
    apkBuffer[2] !== ZIP_LOCAL_MAGIC[2] ||
    apkBuffer[3] !== ZIP_LOCAL_MAGIC[3]
  ) {
    throw new Error("APK does not start with valid ZIP magic bytes.");
  }

  let eocdOffset = -1;
  const minOffset = Math.max(0, apkBuffer.length - 65557);
  for (let offset = apkBuffer.length - 22; offset >= minOffset; offset -= 1) {
    if (apkBuffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLen = apkBuffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLen === apkBuffer.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Could not locate ZIP End-of-Central-Directory record in APK.");
  }

  const totalEntries = apkBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = apkBuffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset >= apkBuffer.length) {
    throw new Error("ZIP Central Directory offset is out of bounds.");
  }

  const entryNames: string[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries && cursor + 46 <= eocdOffset; i += 1) {
    if (apkBuffer.readUInt32LE(cursor) !== CD_SIGNATURE) {
      throw new Error(`Invalid ZIP Central Directory header at offset ${cursor}.`);
    }
    const nameLen = apkBuffer.readUInt16LE(cursor + 28);
    const extraLen = apkBuffer.readUInt16LE(cursor + 30);
    const commentLen = apkBuffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > eocdOffset) {
      throw new Error("ZIP Central Directory filename extends past EOCD.");
    }
    entryNames.push(apkBuffer.subarray(nameStart, nameEnd).toString("utf8"));
    cursor = nameEnd + extraLen + commentLen;
  }

  const hasArm64 = entryNames.some((name) => name.startsWith("lib/arm64-v8a/"));
  const hasX86_64 = entryNames.some((name) => name.startsWith("lib/x86_64/"));
  const hasAndroidBundle = entryNames.includes("assets/index.android.bundle");

  if (!hasArm64 || !hasX86_64 || !hasAndroidBundle) {
    throw new Error(
      `APK is missing required Dual-ABI/bundle entries: arm64=${String(hasArm64)}, x86_64=${String(hasX86_64)}, bundle=${String(hasAndroidBundle)}.`,
    );
  }

  return { entryNames, hasArm64, hasX86_64, hasAndroidBundle };
}

export interface MobileMirrorTarget {
  readonly label: string;
  readonly prefix: string;
  readonly feedUrl: string;
}

/**
 * Resolves the mobile S3 prefix (`mobile/` at bucket root, never `desktop/mobile/`) and
 * public feed URL (`https://<mirror>/mobile/`) from a mirror store's settings folder.
 */
export function resolveMobileMirrorTarget(store: UpdateMirrorStoreSettings): MobileMirrorTarget {
  const explicitPrefix = store.env.MOSS_MOBILE_UPDATE_S3_PREFIX?.trim();
  const prefix = explicitPrefix
    ? explicitPrefix.endsWith("/")
      ? explicitPrefix
      : `${explicitPrefix}/`
    : MOSS_MOBILE_UPDATE_FEED_PATH;

  const explicitFeedUrl = store.env.MOSS_MOBILE_UPDATE_FEED_URL?.trim();
  let feedUrl: string;
  if (explicitFeedUrl) {
    feedUrl = explicitFeedUrl.endsWith("/") ? explicitFeedUrl : `${explicitFeedUrl}/`;
  } else {
    const mirrorFeedUrl = store.env.MOSS_UPDATE_MIRROR_FEED_URL?.trim();
    if (!mirrorFeedUrl) {
      throw new Error(`${store.label}: MOSS_UPDATE_MIRROR_FEED_URL is not set.`);
    }
    const base = new URL(mirrorFeedUrl);
    if (/\/desktop\/?$/i.test(base.pathname)) {
      base.pathname = base.pathname.replace(/\/desktop\/?$/i, `/${MOSS_MOBILE_UPDATE_FEED_PATH}`);
    } else {
      const next = new URL(
        MOSS_MOBILE_UPDATE_FEED_PATH,
        base.href.endsWith("/") ? base.href : `${base.href}/`,
      );
      base.href = next.href;
    }
    feedUrl = base.href.endsWith("/") ? base.href : `${base.href}/`;
  }

  return { label: store.label, prefix, feedUrl };
}

export interface BuildMobileReleaseManifestInput {
  readonly version: string;
  readonly buildNumber: number;
  readonly apkBuffer: Buffer;
  readonly notesZh: string;
  readonly notesEn: string;
  readonly releaseDate?: string;
}

export interface BuiltMobileRelease {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly manifest: MossMobileUpdateManifest;
  readonly manifestJson: string;
}

export function buildMobileReleaseManifest(
  input: BuildMobileReleaseManifestInput,
): BuiltMobileRelease {
  parseSemver(input.version);
  if (!Number.isInteger(input.buildNumber) || input.buildNumber <= 0) {
    throw new Error(`Invalid --build-number: ${String(input.buildNumber)}`);
  }
  const notesZh = input.notesZh.trim();
  const notesEn = input.notesEn.trim();
  if (!notesZh || !notesEn) {
    throw new Error("Both --notes-zh and --notes-en must be non-empty.");
  }

  inspectApkZipEntries(input.apkBuffer);
  const sha256 = createHash("sha256").update(input.apkBuffer).digest("hex");
  const size = input.apkBuffer.length;
  const trimmedVersion = input.version.trim();
  const fileName = `${MOSS_MOBILE_ANDROID_APK_PREFIX}${trimmedVersion}.apk`;
  const mirrorPath = `${MOSS_MOBILE_ANDROID_APK_PREFIX}${trimmedVersion}.bin`;
  const releaseDate = (input.releaseDate ?? new Date().toISOString()).trim();

  const rawJson = `${JSON.stringify(
    {
      schemaVersion: 1,
      platform: "android",
      channel: "stable",
      version: trimmedVersion,
      buildNumber: input.buildNumber,
      releaseDate,
      fileName,
      path: fileName,
      mirrorPath,
      size,
      sha256,
      releaseNotes: {
        zh: notesZh,
        en: notesEn,
      },
    },
    null,
    2,
  )}\n`;

  const manifest = parseMossMobileUpdateManifest(rawJson);
  return { fileName, size, sha256, manifest, manifestJson: rawJson };
}

/** Plans obsolete `mobile/Moss-Android-*.{apk,bin}` deletions while preserving the latest `keep` versions. */
export function planMobileApkPrune(input: {
  readonly keys: ReadonlyArray<string>;
  readonly prefix: string;
  readonly protectedFileName: string;
  readonly keep: number;
}): ReadonlyArray<string> {
  const keepCount = Math.max(1, input.keep);
  const protectedMatch = APK_VERSION_NAME_RE.exec(input.protectedFileName);
  const parsed: { key: string; fileName: string; version: string }[] = [];
  for (const key of input.keys) {
    if (!key.startsWith(input.prefix)) continue;
    const rel = key.slice(input.prefix.length);
    if (rel.includes("/")) continue;
    const match = APK_VERSION_NAME_RE.exec(rel);
    if (!match?.[1]) continue;
    parsed.push({ key, fileName: rel, version: match[1] });
  }
  parsed.sort((a, b) => compareSemver(b.version, a.version));
  const retainedVersions = new Set<string>(protectedMatch?.[1] ? [protectedMatch[1]] : []);
  const retainedFiles = new Set<string>([input.protectedFileName]);
  for (const item of parsed) {
    if (retainedVersions.has(item.version)) {
      retainedFiles.add(item.fileName);
      continue;
    }
    if (retainedVersions.size < keepCount) {
      retainedVersions.add(item.version);
      retainedFiles.add(item.fileName);
    }
  }
  return parsed.filter((item) => !retainedFiles.has(item.fileName)).map((item) => item.key);
}

export interface MobileMirrorStorageClient {
  readonly uploadFile: (input: {
    readonly key: string;
    readonly localPath: string;
    readonly contentType: string;
  }) => Promise<void>;
  readonly listKeys: (prefix: string) => Promise<ReadonlyArray<string>>;
  readonly deleteKey: (key: string) => Promise<void>;
}

function createBunS3MobileClient(
  env: Readonly<Record<string, string | undefined>>,
): MobileMirrorStorageClient {
  const client = new Bun.S3Client(readUpdateMirrorS3ClientOptions(env));
  return {
    uploadFile: async ({ key, localPath, contentType }) => {
      await client.file(key).write(Bun.file(localPath), { type: contentType, retry: 3 });
    },
    listKeys: async (prefix) => {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const res = await client.list({
          prefix,
          maxKeys: 1000,
          ...(continuationToken ? { continuationToken } : {}),
        });
        for (const entry of res.contents ?? []) {
          if (entry.key) keys.push(entry.key);
        }
        continuationToken = res.isTruncated ? res.nextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    deleteKey: async (key) => {
      await client.file(key).delete();
    },
  };
}

export interface PublishedMirrorOutcome {
  readonly label: string;
  readonly bucketPrefix: string;
  readonly feedUrl: string;
  readonly apkUrl: string;
  readonly verifiedManifestSignature: boolean;
  readonly verifiedRange206: boolean;
  readonly prunedKeys: ReadonlyArray<string>;
}

async function verifyPublicMirrorReadBack(input: {
  readonly feedUrl: string;
  readonly expectedManifest: MossMobileUpdateManifest;
  readonly expectedPublicKey: string;
  readonly fetchImpl: typeof fetch;
  readonly allowLoopback?: boolean;
  readonly retryDelayMs?: number;
}): Promise<string> {
  const apkUrl = resolveMobileArtifactUrl(input.feedUrl, input.expectedManifest, {
    allowLoopback: input.allowLoopback,
  });
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const nonce = `${Date.now().toString(36)}-${attempt}`;
      const manifestUrl = new URL(MOSS_MOBILE_ANDROID_MANIFEST_FILE, input.feedUrl);
      manifestUrl.searchParams.set("noCache", nonce);
      const sigUrl = new URL(
        `${MOSS_MOBILE_ANDROID_MANIFEST_FILE}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`,
        input.feedUrl,
      );
      sigUrl.searchParams.set("noCache", nonce);

      const [manifestRes, sigRes] = await Promise.all([
        input.fetchImpl(manifestUrl.href, { method: "GET" }),
        input.fetchImpl(sigUrl.href, { method: "GET" }),
      ]);
      if (!manifestRes.ok) throw new Error(`GET ${manifestUrl.href} -> ${manifestRes.status}`);
      if (!sigRes.ok) throw new Error(`GET ${sigUrl.href} -> ${sigRes.status}`);

      const manifestBody = await manifestRes.text();
      const sigBody = await sigRes.text();
      const sigOk = verifyMossUpdateManifest({
        channelFile: MOSS_MOBILE_ANDROID_MANIFEST_FILE,
        manifest: manifestBody,
        signature: sigBody,
        manifestPublicKey: input.expectedPublicKey,
      });
      if (!sigOk) {
        throw new Error(`Public Ed25519 signature check failed on ${input.feedUrl}`);
      }
      const remoteManifest = parseMossMobileUpdateManifest(manifestBody);
      if (
        remoteManifest.version !== input.expectedManifest.version ||
        remoteManifest.buildNumber !== input.expectedManifest.buildNumber ||
        remoteManifest.sha256 !== input.expectedManifest.sha256 ||
        remoteManifest.size !== input.expectedManifest.size
      ) {
        throw new Error(`Published manifest mismatch on ${input.feedUrl}`);
      }

      // Single-range GET (COS returns 403 on HEAD, so verify live APK availability via GET Range).
      const rangeRes = await input.fetchImpl(apkUrl, {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
      });
      if (rangeRes.status !== 206) {
        throw new Error(`Range GET ${apkUrl} expected 206, got ${rangeRes.status}`);
      }
      const rangeBytes = new Uint8Array(await rangeRes.arrayBuffer());
      if (
        rangeBytes.length < 4 ||
        rangeBytes[0] !== ZIP_LOCAL_MAGIC[0] ||
        rangeBytes[1] !== ZIP_LOCAL_MAGIC[1] ||
        rangeBytes[2] !== ZIP_LOCAL_MAGIC[2] ||
        rangeBytes[3] !== ZIP_LOCAL_MAGIC[3]
      ) {
        throw new Error(`Range GET ${apkUrl} returned invalid ZIP header`);
      }

      return apkUrl;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, input.retryDelayMs ?? 500));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface PublishMobileReleaseOptions {
  readonly apkPath: string;
  readonly version: string;
  readonly buildNumber: number;
  readonly notesZh: string;
  readonly notesEn: string;
  readonly keep?: number;
  readonly dryRun?: boolean;
  readonly releaseDate?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly expectedPublicKey?: string;
  readonly allowLoopback?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly verifyRetryDelayMs?: number;
  readonly createStoreClient?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => MobileMirrorStorageClient;
  readonly log?: (line: string) => void;
}

export interface PublishMobileReleaseResult {
  readonly version: string;
  readonly buildNumber: number;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly dryRun: boolean;
  readonly stores: ReadonlyArray<PublishedMirrorOutcome>;
}

export async function publishMobileRelease(
  options: PublishMobileReleaseOptions,
): Promise<PublishMobileReleaseResult> {
  const log = options.log ?? ((line: string) => console.log(`[publish-mobile] ${line}`));
  const env = options.env ?? process.env;
  const apkBuffer = await readFile(options.apkPath);
  const built = buildMobileReleaseManifest({
    version: options.version,
    buildNumber: options.buildNumber,
    apkBuffer,
    notesZh: options.notesZh,
    notesEn: options.notesEn,
    releaseDate: options.releaseDate,
  });

  const { stores } = await resolveUpdateMirrorStores({
    env,
    homeDirectory: options.homeDirectory ?? homedir(),
    files: LOCAL_SETTINGS_FILES,
  });
  const privateKey = resolveUpdateMirrorSigningKey(stores);
  const expectedPublicKey = options.expectedPublicKey ?? MOSS_UPDATE_MANIFEST_PUBLIC_KEY;
  if (deriveMossUpdateManifestPublicKey(privateKey) !== expectedPublicKey) {
    throw new Error("Signing key does not match pinned MOSS_UPDATE_MANIFEST_PUBLIC_KEY.");
  }

  const signatureBase64 = signMossUpdateManifest({
    channelFile: MOSS_MOBILE_ANDROID_MANIFEST_FILE,
    manifest: built.manifestJson,
    privateKey,
  });
  const signatureText = `${signatureBase64}\n`;
  if (
    !verifyMossUpdateManifest({
      channelFile: MOSS_MOBILE_ANDROID_MANIFEST_FILE,
      manifest: built.manifestJson,
      signature: signatureText,
      manifestPublicKey: expectedPublicKey,
    })
  ) {
    throw new Error("Local Ed25519 self-verification of android-latest.json failed.");
  }

  log(
    `Validated ${built.fileName} (version=${built.manifest.version}, build=${built.manifest.buildNumber}, size=${built.size} bytes, sha256=${built.sha256})`,
  );

  if (options.dryRun) {
    const planned = stores.map((store) => {
      const target = resolveMobileMirrorTarget(store);
      return {
        label: target.label,
        bucketPrefix: target.prefix,
        feedUrl: target.feedUrl,
        apkUrl: resolveMobileArtifactUrl(target.feedUrl, built.manifest, {
          allowLoopback: options.allowLoopback,
        }),
        verifiedManifestSignature: true,
        verifiedRange206: false,
        prunedKeys: [],
      };
    });
    return {
      version: built.manifest.version,
      buildNumber: built.manifest.buildNumber,
      fileName: built.fileName,
      size: built.size,
      sha256: built.sha256,
      dryRun: true,
      stores: planned,
    };
  }

  const stageDir = await mkdtemp(join(tmpdir(), "moss-mobile-release-"));
  const localManifestPath = join(stageDir, MOSS_MOBILE_ANDROID_MANIFEST_FILE);
  const localSigPath = join(
    stageDir,
    `${MOSS_MOBILE_ANDROID_MANIFEST_FILE}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`,
  );
  await writeFile(localManifestPath, built.manifestJson, "utf8");
  await writeFile(localSigPath, signatureText, "utf8");

  const outcomes: PublishedMirrorOutcome[] = [];
  const createClient = options.createStoreClient ?? createBunS3MobileClient;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  try {
    for (const store of stores) {
      const target = resolveMobileMirrorTarget(store);
      const client = createClient(store.env);
      const usesCosBin = isCosDefaultDomainFeed(target.feedUrl);
      const artifactFileName =
        usesCosBin && built.manifest.mirrorPath ? built.manifest.mirrorPath : built.fileName;
      const artifactContentType = usesCosBin
        ? "application/octet-stream"
        : "application/vnd.android.package-archive";

      log(
        `Uploading ${artifactFileName} + signed manifest to ${target.label} (${target.prefix})...`,
      );
      await client.uploadFile({
        key: `${target.prefix}${artifactFileName}`,
        localPath: options.apkPath,
        contentType: artifactContentType,
      });
      await client.uploadFile({
        key: `${target.prefix}${MOSS_MOBILE_ANDROID_MANIFEST_FILE}`,
        localPath: localManifestPath,
        contentType: "application/json; charset=utf-8",
      });
      await client.uploadFile({
        key: `${target.prefix}${MOSS_MOBILE_ANDROID_MANIFEST_FILE}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`,
        localPath: localSigPath,
        contentType: "text/plain; charset=utf-8",
      });

      if (usesCosBin && artifactFileName !== built.fileName) {
        try {
          await client.deleteKey(`${target.prefix}${built.fileName}`);
        } catch {
          // Uploader credential may lack DeleteObject permission; ignore best-effort cleanup.
        }
      }

      const apkUrl = await verifyPublicMirrorReadBack({
        feedUrl: target.feedUrl,
        expectedManifest: built.manifest,
        expectedPublicKey,
        fetchImpl,
        allowLoopback: options.allowLoopback,
        retryDelayMs: options.verifyRetryDelayMs,
      });

      const deletedKeys: string[] = [];
      try {
        const existingKeys = await client.listKeys(target.prefix);
        const toDelete = planMobileApkPrune({
          keys: existingKeys,
          prefix: target.prefix,
          protectedFileName: artifactFileName,
          keep: options.keep ?? 2,
        });
        for (const obsoleteKey of toDelete) {
          await client.deleteKey(obsoleteKey);
          deletedKeys.push(obsoleteKey);
        }
      } catch (pruneError) {
        const reason = pruneError instanceof Error ? pruneError.message : String(pruneError);
        log(`Skipping prune on ${target.label}: ${reason}`);
      }

      log(
        `Verified live read-back + Ed25519 + HTTP 206 on ${target.feedUrl} (pruned ${deletedKeys.length})`,
      );
      outcomes.push({
        label: target.label,
        bucketPrefix: target.prefix,
        feedUrl: target.feedUrl,
        apkUrl,
        verifiedManifestSignature: true,
        verifiedRange206: true,
        prunedKeys: deletedKeys,
      });
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }

  return {
    version: built.manifest.version,
    buildNumber: built.manifest.buildNumber,
    fileName: built.fileName,
    size: built.size,
    sha256: built.sha256,
    dryRun: false,
    stores: outcomes,
  };
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apk: { type: "string" },
      version: { type: "string" },
      "build-number": { type: "string" },
      "notes-zh": { type: "string" },
      "notes-en": { type: "string" },
      keep: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (
    !values.apk ||
    !values.version ||
    !values["build-number"] ||
    !values["notes-zh"] ||
    !values["notes-en"]
  ) {
    throw new Error(
      "Usage: bun run scripts/publish-mobile-release.ts --apk <path> --version <semver> --build-number <int> --notes-zh <text> --notes-en <text> [--keep 2] [--dry-run]",
    );
  }

  const result = await publishMobileRelease({
    apkPath: values.apk,
    version: values.version,
    buildNumber: Number(values["build-number"]),
    notesZh: values["notes-zh"],
    notesEn: values["notes-en"],
    keep: values.keep ? Number(values.keep) : 2,
    dryRun: Boolean(values["dry-run"]),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
