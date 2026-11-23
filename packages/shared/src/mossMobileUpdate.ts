// FILE: mossMobileUpdate.ts
// Purpose: Runtime-agnostic manifest contract, semver comparison, and signed update mirror
//          policy shared by Moss Mobile (Hermes / Web) and release publishing CLI tools.
//          Keeps zero `node:*` imports so Expo/Metro can bundle it on Android, iOS, and Web.
// Layer: Shared release/runtime contract (pure TypeScript, no I/O).

import { mossDownloadSourceUrls, type MossDownloadSourceOrder } from "./mossDownloadSources";

/** The Moss release key's public half (base64 DER SPKI, Ed25519). Every mirror is checked against it. */
export const MOSS_UPDATE_MANIFEST_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAsF4Nc7+iI39nphKy9Sot+jfpQSMcVLQyjeTkLHZJHwE=";

export const MOSS_UPDATE_SIGNATURE_DOMAIN = "moss-update-manifest-v1";
export const MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX = ".sig";

/** The stable mobile feed directory on every download source (bucket root `mobile/`). */
export const MOSS_MOBILE_UPDATE_FEED_PATH = "mobile/";
export const MOSS_MOBILE_ANDROID_MANIFEST_FILE = "android-latest.json";
export const MOSS_MOBILE_IOS_MANIFEST_FILE = "ios-latest.json";
export const MOSS_MOBILE_ANDROID_APK_PREFIX = "Moss-Android-";

export type MossMobilePlatform = "android" | "ios";

export interface MossMobileUpdateNotes {
  readonly zh: string;
  readonly en: string;
}

export interface MossMobileUpdateManifest {
  readonly schemaVersion: 1;
  readonly platform: MossMobilePlatform;
  readonly channel: "stable";
  readonly version: string;
  readonly buildNumber: number;
  readonly releaseDate: string;
  readonly fileName?: string;
  readonly path?: string;
  readonly mirrorPath?: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly minSupportedVersion?: string;
  readonly releaseNotes: MossMobileUpdateNotes;
}

export interface MossMobileUpdateMirrorConfig {
  readonly feedUrl: string;
  readonly manifestPublicKey: string;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_APK_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/;
const SAFE_MIRROR_ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:apk|bin)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** True when a feed URL uses Tencent COS's default `*.myqcloud.com` domain (which blocks `.apk`/`.ipa`). */
export function isCosDefaultDomainFeed(feedUrl: string): boolean {
  try {
    return new URL(feedUrl).hostname.toLowerCase().endsWith(".myqcloud.com");
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Exact signed message string verified by both Desktop (`node:crypto`) and Mobile (pure-TS Ed25519). */
export function buildMossUpdateSignaturePayload(channelFile: string, manifest: string): string {
  return `${MOSS_UPDATE_SIGNATURE_DOMAIN}\n${channelFile}\n${manifest}`;
}

/** Feed directory URLs (`.../mobile/`) ordered for the caller's access region. */
export function mossMobileUpdateMirrorBases(
  region: MossDownloadSourceOrder,
): ReadonlyArray<string> {
  return mossDownloadSourceUrls(region, MOSS_MOBILE_UPDATE_FEED_PATH);
}

/** Signed mirror endpoints paired with Moss's pinned Ed25519 public key. */
export function mossMobileUpdateMirrorConfigs(
  region: MossDownloadSourceOrder,
): ReadonlyArray<MossMobileUpdateMirrorConfig> {
  return Object.freeze(
    mossMobileUpdateMirrorBases(region).map((feedUrl) =>
      Object.freeze({
        feedUrl,
        manifestPublicKey: MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
      }),
    ),
  );
}

/** Default production mobile update mirrors in mainland-preferred failover order (COS CN -> R2). */
export const MOSS_MOBILE_UPDATE_MIRRORS: ReadonlyArray<MossMobileUpdateMirrorConfig> =
  mossMobileUpdateMirrorConfigs("cn");

export function parseSemver(version: string): {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
} {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/** Standard SemVer 2.0.0 precedence: returns `< 0`, `0`, or `> 0`. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const maxLen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < maxLen; i += 1) {
    const segA = pa.prerelease[i];
    const segB = pb.prerelease[i];
    if (segA === undefined) return -1;
    if (segB === undefined) return 1;
    if (segA === segB) continue;
    const numA = typeof segA === "number";
    const numB = typeof segB === "number";
    if (numA && numB) return segA - segB;
    if (numA !== numB) return numA ? -1 : 1;
    return String(segA).localeCompare(String(segB));
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeSingleSegmentFilename(
  value: unknown,
  fieldName: string,
  pattern: RegExp,
  expectedExt: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Manifest missing ${fieldName}.`);
  }
  const trimmed = value.trim();
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes(":") ||
    !pattern.test(trimmed)
  ) {
    throw new Error(
      `Manifest ${fieldName} must be a safe single-segment ${expectedExt} filename: ${trimmed}`,
    );
  }
  return trimmed;
}

function assertSafeSingleSegmentApkName(value: unknown, fieldName: string): string {
  return assertSafeSingleSegmentFilename(value, fieldName, SAFE_APK_FILENAME_RE, ".apk");
}

/** Parses and strictly validates a signed mobile update manifest JSON document. */
export function parseMossMobileUpdateManifest(raw: string): MossMobileUpdateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid mobile update manifest JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Mobile update manifest must be a JSON object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported mobile update schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (parsed.platform !== "android" && parsed.platform !== "ios") {
    throw new Error(`Unsupported mobile update platform: ${String(parsed.platform)}`);
  }
  if (parsed.channel !== "stable") {
    throw new Error(`Unsupported mobile update channel: ${String(parsed.channel)}`);
  }
  if (typeof parsed.version !== "string") {
    throw new Error("Manifest missing version.");
  }
  const version = parsed.version.trim();
  parseSemver(version);

  const buildNumber = parsed.buildNumber;
  if (
    typeof buildNumber !== "number" ||
    !Number.isInteger(buildNumber) ||
    !Number.isFinite(buildNumber) ||
    buildNumber <= 0
  ) {
    throw new Error(`Invalid mobile update buildNumber: ${String(buildNumber)}`);
  }

  if (typeof parsed.releaseDate !== "string" || !ISO_DATE_RE.test(parsed.releaseDate.trim())) {
    throw new Error(`Invalid mobile update releaseDate: ${String(parsed.releaseDate)}`);
  }
  const releaseDate = parsed.releaseDate.trim();

  if (!isRecord(parsed.releaseNotes)) {
    throw new Error("Manifest missing releaseNotes.");
  }
  const zhNote = typeof parsed.releaseNotes.zh === "string" ? parsed.releaseNotes.zh.trim() : "";
  const enNote = typeof parsed.releaseNotes.en === "string" ? parsed.releaseNotes.en.trim() : "";
  if (!zhNote || !enNote) {
    throw new Error("Manifest releaseNotes.zh and releaseNotes.en must be non-empty.");
  }

  let minSupportedVersion: string | undefined;
  if (parsed.minSupportedVersion !== undefined) {
    if (typeof parsed.minSupportedVersion !== "string") {
      throw new Error("Invalid minSupportedVersion.");
    }
    minSupportedVersion = parsed.minSupportedVersion.trim();
    parseSemver(minSupportedVersion);
  }

  if (parsed.platform === "android") {
    const fileName = assertSafeSingleSegmentApkName(parsed.fileName, "fileName");
    const artifactPath = assertSafeSingleSegmentApkName(parsed.path ?? fileName, "path");
    if (artifactPath !== fileName) {
      throw new Error(`Manifest path (${artifactPath}) must match fileName (${fileName}).`);
    }
    const mirrorPath =
      parsed.mirrorPath !== undefined
        ? assertSafeSingleSegmentFilename(
            parsed.mirrorPath,
            "mirrorPath",
            SAFE_MIRROR_ARTIFACT_RE,
            ".apk or .bin",
          )
        : undefined;
    const size = parsed.size;
    if (
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      !Number.isFinite(size) ||
      size <= 0
    ) {
      throw new Error(`Invalid mobile APK size: ${String(size)}`);
    }
    if (typeof parsed.sha256 !== "string" || !SHA256_RE.test(parsed.sha256.trim())) {
      throw new Error("Manifest sha256 must be 64 lowercase hex characters.");
    }
    return {
      schemaVersion: 1,
      platform: "android",
      channel: "stable",
      version,
      buildNumber,
      releaseDate,
      fileName,
      path: artifactPath,
      ...(mirrorPath ? { mirrorPath } : {}),
      size,
      sha256: parsed.sha256.trim(),
      ...(minSupportedVersion ? { minSupportedVersion } : {}),
      releaseNotes: { zh: zhNote, en: enNote },
    };
  }

  return {
    schemaVersion: 1,
    platform: "ios",
    channel: "stable",
    version,
    buildNumber,
    releaseDate,
    ...(minSupportedVersion ? { minSupportedVersion } : {}),
    releaseNotes: { zh: zhNote, en: enNote },
  };
}

/** True only when `candidate` is strictly newer by SemVer, or equal SemVer with higher buildNumber. */
export function isNewerMobileRelease(input: {
  readonly currentVersion: string;
  readonly currentBuildNumber?: number;
  readonly candidate: Pick<MossMobileUpdateManifest, "version" | "buildNumber">;
}): boolean {
  const cmp = compareSemver(input.candidate.version, input.currentVersion);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  if (input.currentBuildNumber === undefined) return false;
  return input.candidate.buildNumber > input.currentBuildNumber;
}

/** Resolves an artifact filename safely within `feedBaseUrl` without allowing origin/path escapes. */
export function resolveMobileArtifactUrl(
  feedBaseUrl: string,
  manifest: MossMobileUpdateManifest,
  options: { readonly allowLoopback?: boolean } = {},
): string {
  const parsedBase = new URL(feedBaseUrl);
  const loopback = isLoopbackHostname(parsedBase.hostname);
  if (loopback ? !options.allowLoopback : parsedBase.protocol !== "https:") {
    throw new Error("Mobile update feed base URL must use HTTPS.");
  }
  if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
    throw new Error("Mobile update feed base URL must be HTTP(S).");
  }
  if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error("Mobile update feed base URL must not carry credentials, query, or hash.");
  }
  const normalizedBase = parsedBase.href.endsWith("/") ? parsedBase.href : `${parsedBase.href}/`;
  const rawName =
    isCosDefaultDomainFeed(normalizedBase) && manifest.mirrorPath
      ? manifest.mirrorPath
      : (manifest.path ?? manifest.fileName);
  const relativeName = assertSafeSingleSegmentFilename(
    rawName,
    "path",
    SAFE_MIRROR_ARTIFACT_RE,
    ".apk or .bin",
  );
  const resolved = new URL(relativeName, normalizedBase);
  if (
    resolved.origin !== parsedBase.origin ||
    !resolved.href.startsWith(normalizedBase) ||
    resolved.href !== `${normalizedBase}${relativeName}`
  ) {
    throw new Error(`Artifact URL escaped feed base URL: ${resolved.href}`);
  }
  return resolved.href;
}

/**
 * Returns deduplicated HTTPS artifact download URLs ordered across all configured mirrors.
 * Any COS default-domain feed lacking a `.bin` `mirrorPath` is demoted after custom-domain mirrors.
 */
export function resolveMobileArtifactUrls(
  feedBaseUrls: ReadonlyArray<string>,
  manifest: MossMobileUpdateManifest,
  options: { readonly allowLoopback?: boolean } = {},
): ReadonlyArray<string> {
  const preferred: string[] = [];
  const deferredCosApk: string[] = [];
  const seen = new Set<string>();

  for (const baseUrl of feedBaseUrls) {
    const resolved = resolveMobileArtifactUrl(baseUrl, manifest, options);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isCosDefaultDomainFeed(baseUrl) && !manifest.mirrorPath) {
      deferredCosApk.push(resolved);
    } else {
      preferred.push(resolved);
    }
  }
  return [...preferred, ...deferredCosApk];
}
