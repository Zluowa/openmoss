// FILE: bundled-codex-release-compliance.ts
// Purpose: Fails closed on bundled Codex SBOM, license evidence, obligations, and payload bytes.
// Layer: Release/build helper

import * as Crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareUtf8Bytes } from "./utf8-byte-order.ts";
import { normalizeSignatureStrippedMachO } from "./mac-macho-canonical.mjs";
import {
  verifyPackagedAsarIntegrity,
  type PackagedAsarIntegrityReceipt,
} from "./mac-asar-integrity.mjs";

import {
  assertBundledClaudeFinalArtifactVerificationReceipt,
  assertBundledClaudeReleaseVerificationReceipt,
  verifyFinalBundledClaudeMacRuntime,
  type BundledClaudeFinalArtifactVerificationReceipt,
} from "./bundled-claude-runtime.ts";

export const BUNDLED_CODEX_COMPLIANCE_VERSION = "0.163.0";
const CODEX_VERSION = BUNDLED_CODEX_COMPLIANCE_VERSION;
const SHA256 = /^[0-9a-f]{64}$/u;
export const BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM =
  "moss-bundled-codex-compliance-tree-v1";
export const BUNDLED_CODEX_COMPLIANCE_BUNDLE_ENTRY_COUNT = 704;
export const BUNDLED_CODEX_COMPLIANCE_BUNDLE_FILE_COUNT = 696;
export const BUNDLED_CODEX_COMPLIANCE_BUNDLE_DIRECTORY_COUNT = 8;
export const BUNDLED_CODEX_COMPLIANCE_BUNDLE_TOTAL_BYTES = 22_917_887;
export const BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256 =
  "54fdddeb41ead1f973cadc0b790f1a185063cc35737b08f91d7d4d45a1877dec";
export const BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT = 1_478;
export const BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT = 673;
export const BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT = 273;
export const BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT = 2;
export const BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH = "/usr/bin/unsquashfs";
export const BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID = "root-owned-system-unsquashfs-v1";

export const BUNDLED_CODEX_COMPLIANCE_REPOSITORY_RELATIVE_DIRECTORY = Path.join(
  "third_party",
  "openai-codex",
  BUNDLED_CODEX_COMPLIANCE_VERSION,
);
export const BUNDLED_CODEX_COMPLIANCE_PACKAGE_RELATIVE_DIRECTORY = Path.join(
  "third-party-licenses",
  "openai-codex",
  BUNDLED_CODEX_COMPLIANCE_VERSION,
);
export const BUNDLED_CODEX_COMPLIANCE_EXTRA_RESOURCE = {
  from: "third-party-licenses",
  to: "third-party-licenses",
  filter: ["**/*"],
} as const;
export const BUNDLED_CODEX_COMPLIANCE_STAGE_ASAR_EXCLUSION = "!third-party-licenses{,/**}";

const TOP_LEVEL_LICENSE_SHA256 = "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc";
const TOP_LEVEL_NOTICE_SHA256 = "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915";
const PAYLOADS_SHA256 = "1a4ece010c159c9a314a8151c14ac962e3e451b18cc342f368c7662662158e5d";
const EXPECTED_SOURCE_DOCUMENT = {
  packageName: "@openai/codex",
  packageVersion: BUNDLED_CODEX_COMPLIANCE_VERSION,
  licenseExpression: "Apache-2.0",
  repositoryUrl: "https://github.com/openai/codex",
  sourceTag: "rust-v0.163.0",
  sourceCommit: "83086188ae0614bd882818ff1aa23f3194962012",
  sourceFiles: {
    LICENSE: {
      url: "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/LICENSE",
      sha256: TOP_LEVEL_LICENSE_SHA256,
    },
    NOTICE: {
      url: "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/NOTICE",
      sha256: TOP_LEVEL_NOTICE_SHA256,
    },
  },
  retrievalPolicy:
    "Repository-owned release input; never copied from an installed Codex Desktop app.",
} as const;

export const BUNDLED_CODEX_COMPLIANCE_TOP_LEVEL_ENTRIES = [
  "COMPONENTS.cdx.json",
  "LICENSE",
  "LICENSE_EVIDENCE.json",
  "NOTICE",
  "OBLIGATIONS.json",
  "PAYLOADS.json",
  "REBUILD.md",
  "SOURCE.json",
  "SOURCE_MATERIALS.json",
  "licenses",
  "sources",
] as const;

const REBUILD_SHA256 = "a7df5327a5fc0515d04865bc0cc31565b4bfe075948e6e33632a155a353a40ad";
const APPROVED_RUST_LICENSE_IDS = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);
const APPROVED_RUST_LICENSE_EXCEPTIONS = new Set(["LLVM-exception"]);
const EXPECTED_NAMED_LICENSE_PATHS = [
  "licenses/bubblewrap/COPYING",
  "licenses/libcap/License",
  "licenses/pcre2/LICENCE.md",
  "licenses/ripgrep/LICENSE-MIT",
  "licenses/ripgrep/UNLICENSE",
  "licenses/voice/LGPL-2.1.txt",
  "licenses/voice/Opus.txt",
  "licenses/voice/PCRE2.md",
  "licenses/voice/libffi.txt",
  "licenses/voice/proxy-libintl.txt",
  "licenses/voice/sljit.txt",
  "licenses/voice/zlib.txt",
] as const;
// This metadata file preserves upstream license bytes in Git without making
// it part of the audited license-text inventory.
const LICENSE_DIRECTORY_METADATA_FILE = ".gitattributes";

const EXPECTED_SOURCE_MATERIALS = {
  "codex-rust-v0.163.0": {
    path: "sources/codex-rust-v0.163.0-source.tar.gz",
    size: 17_520_744,
    sha256: "e57f1d4f914c71c3532a12d5c14f740909fca4e7e041fa1b3db71618c88e5567",
    mediaType: "application/gzip",
  },
  "libcap-2.75": {
    path: "sources/libcap-2.75.tar.xz",
    size: 197_868,
    sha256: "de4e7e064c9ba451d5234dd46e897d7c71c96a9ebf9a0c445bc04f4742d83632",
    mediaType: "application/x-xz",
  },
} as const;

const EXPECTED_ARCHIVES = {
  launcher: {
    npmVersion: CODEX_VERSION,
    archive: `codex-${CODEX_VERSION}.tgz`,
    size: 4_902,
    sha256: "1a71db36560bb446d2c2e63ae675c4a3018c38ace38ca533f8d1b25d3e6555b4",
    npmIntegrity:
      "sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw==",
  },
  "darwin-arm64": {
    npmVersion: `${CODEX_VERSION}-darwin-arm64`,
    archive: `codex-${CODEX_VERSION}-darwin-arm64.tgz`,
    size: 137_871_195,
    sha256: "1193ff4ce72387a5d6c34820b54a9dc57d007c67a958e8acb4715924facd3c31",
    npmIntegrity:
      "sha512-i7Dzk2a5aGmuGM9aNZgaUVTojZ/4bc5lRfosz++Y7X2BGhDkz+cySgbD+NYS1pOxfm0VEbLi9PZ3pAulI4kchw==",
  },
  "darwin-x64": {
    npmVersion: `${CODEX_VERSION}-darwin-x64`,
    archive: `codex-${CODEX_VERSION}-darwin-x64.tgz`,
    size: 147_149_519,
    sha256: "74267d7b7a18a5029fbefc85b003a2c56a7b3bbee1418162208dab5b6babf0da",
    npmIntegrity:
      "sha512-Ioj7h+B1ME9ZU1PH1ATfvFV5DiototEpFFaSSbg3kfDifB9djhl5fcJ++g5mpcL/+uVbcnReei+RiSXEx8o+kw==",
  },
  "linux-arm64": {
    npmVersion: `${CODEX_VERSION}-linux-arm64`,
    archive: `codex-${CODEX_VERSION}-linux-arm64.tgz`,
    size: 154_715_729,
    sha256: "dc6e7c4d6de71c23a0f60d05e2577ff7eef615b76f22630d58ad384b84763522",
    npmIntegrity:
      "sha512-IH2/R+4OarjGvsAf1ll3fdyLwrPgYLl3uzp6u9CyD9sj2Lw+ViDSe3QBZVHdcHJs0eIiZFg6Wprcuy4CRZaUGw==",
  },
  "linux-x64": {
    npmVersion: `${CODEX_VERSION}-linux-x64`,
    archive: `codex-${CODEX_VERSION}-linux-x64.tgz`,
    size: 162_055_867,
    sha256: "30efc97738b975940d78b59a9bea115fa34040b732807d54ec35ae6b7528de94",
    npmIntegrity:
      "sha512-uwRaOsrYogLQhcxAM/GoeWrw0QIWEMRo7c9gM8sKAviVkZQHlu9kRLJ5PkufbV+ABGjyZgIwiFdJ0LCJ0N6e8w==",
  },
  "win32-arm64": {
    npmVersion: `${CODEX_VERSION}-win32-arm64`,
    archive: `codex-${CODEX_VERSION}-win32-arm64.tgz`,
    size: 156_994_368,
    sha256: "3b9fee420b273ed693486c5d81bacea70c0952851ffae8c8ac0edaf3661992d6",
    npmIntegrity:
      "sha512-QnLn3gR2dExcdTThE/HAo5BrUq0/C8zDGQ0UZL3hNzfqt9ZklT6jGTyt8JhDyNZX4uSB4HhcJtbcOWucZGC0VQ==",
  },
  "win32-x64": {
    npmVersion: `${CODEX_VERSION}-win32-x64`,
    archive: `codex-${CODEX_VERSION}-win32-x64.tgz`,
    size: 167_618_721,
    sha256: "81377fd73b502a9e7208e32a4da2d468cdb3fc978e0b818c4707d846ad94eb1e",
    npmIntegrity:
      "sha512-QQGQ/q9dCJ5C5jqhgFrwycpWG3szIyFNThMiKl6hYtu6N/eM3Qd7StesgnCFAfzVED8IkE3N3oH71szzcludqw==",
  },
} as const;

const TARGET_TRIPLE_TO_ARCHIVE = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-unknown-linux-musl": "linux-arm64",
  "x86_64-unknown-linux-musl": "linux-x64",
  "aarch64-pc-windows-msvc": "win32-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
} as const;

const REQUIRED_PAYLOAD_SUFFIXES = {
  "darwin-arm64": [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/voice/bin/codex-voice-host",
  ],
  "darwin-x64": [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/voice/bin/codex-voice-host",
  ],
  "linux-arm64": [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/bwrap",
    "codex-resources/voice/bin/codex-voice-host",
  ],
  "linux-x64": [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/bwrap",
    "codex-resources/voice/bin/codex-voice-host",
  ],
  "win32-arm64": [
    "bin/codex.exe",
    "bin/codex-code-mode-host.exe",
    "codex-path/rg.exe",
    "codex-resources/codex-command-runner.exe",
    "codex-resources/codex-windows-sandbox-setup.exe",
    "codex-resources/voice/bin/codex-voice-host.exe",
  ],
  "win32-x64": [
    "bin/codex.exe",
    "bin/codex-code-mode-host.exe",
    "codex-path/rg.exe",
    "codex-resources/codex-command-runner.exe",
    "codex-resources/codex-windows-sandbox-setup.exe",
    "codex-resources/voice/bin/codex-voice-host.exe",
  ],
} as const;

// osx-sign re-seals every Mach-O in the app, including the GStreamer libraries
// Codex ships for voice, so they are compared with their signatures stripped.
const MAC_RESEALED_PAYLOAD_LIBRARY = /^codex-resources\/voice\/(?:lib|plugins)\/[^/]+\.dylib$/u;

/** Copied payload paths whose signature the platform's packaging may replace. */
export function resolveResealedBundledCodexPayloadPaths(input: {
  readonly archiveId: (typeof TARGET_TRIPLE_TO_ARCHIVE)[keyof typeof TARGET_TRIPLE_TO_ARCHIVE];
  readonly files: readonly PayloadFile[];
  readonly platform: "mac" | "win";
}): string[] {
  const libraries =
    input.platform === "mac"
      ? input.files
          .map((file) => file.path)
          .filter((path) => MAC_RESEALED_PAYLOAD_LIBRARY.test(path))
      : [];
  return [...REQUIRED_PAYLOAD_SUFFIXES[input.archiveId], ...libraries];
}

type JsonRecord = Record<string, unknown>;

interface BomLicenseBinding {
  readonly component: string;
  readonly declaredLicenseExpression: string;
  readonly selectedLicenseExpression: string;
  readonly sourceLocator: string;
  readonly sourceIntegrity: string;
}

export interface PayloadFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PayloadArchive {
  readonly id: keyof typeof EXPECTED_ARCHIVES;
  readonly npmPackage: string;
  readonly npmVersion: string;
  readonly archive: string;
  readonly npmIntegrity: string;
  readonly size: number;
  readonly sha256: string;
  readonly files: readonly PayloadFile[];
}

interface PayloadDocument {
  readonly schemaVersion: number;
  readonly package: string;
  readonly baseVersion: string;
  readonly registry: string;
  readonly archives: readonly PayloadArchive[];
}

export interface BundledCodexComplianceValidation {
  readonly directory: string;
  readonly bundleRootAlgorithm: typeof BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM;
  readonly bundleEntryCount: number;
  readonly bundleFileCount: number;
  readonly bundleDirectoryCount: number;
  readonly bundleTotalBytes: number;
  readonly bundleRootSha256: string;
  readonly componentCount: number;
  readonly licenseTextCount: number;
  readonly payloadFileCount: number;
  readonly sourceMaterialCount: number;
  readonly releaseDecision: "approved" | "blocked";
  readonly blockers: readonly string[];
}

function sha256File(filePath: string): string {
  return Crypto.createHash("sha256").update(FS.readFileSync(filePath)).digest("hex");
}

interface ImmutableFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface ImmutableFileSnapshot {
  readonly filePath: string;
  readonly label: string;
  readonly descriptor: number;
  readonly identity: ImmutableFileIdentity;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

interface ImmutableFileDigest {
  readonly filePath: string;
  readonly label: string;
  readonly descriptor: number;
  readonly identity: ImmutableFileIdentity;
  readonly size: number;
  readonly sha256: string;
}

function immutableIdentity(stat: FS.BigIntStats): ImmutableFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function immutableIdentityEquals(
  left: ImmutableFileIdentity,
  right: ImmutableFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readDescriptorBytes(descriptor: number, size: bigint, label: string): Buffer {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Bundled Codex immutable snapshot has an invalid size for ${label}.`);
  }
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = FS.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) {
      throw new Error(
        `Bundled Codex immutable snapshot reached an unexpected end of file for ${label}.`,
      );
    }
    offset += read;
  }
  return bytes;
}

function hashDescriptor(
  descriptor: number,
  size: bigint,
  label: string,
): { readonly size: number; readonly sha256: string } {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Bundled Codex immutable digest has an invalid size for ${label}.`);
  }
  const hash = Crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  const expectedSize = Number(size);
  while (offset < expectedSize) {
    const read = FS.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, expectedSize - offset),
      offset,
    );
    if (read === 0) {
      throw new Error(
        `Bundled Codex immutable digest reached an unexpected end of file for ${label}.`,
      );
    }
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return { size: expectedSize, sha256: hash.digest("hex") };
}

function openImmutableFileDigest(filePath: string, label: string): ImmutableFileDigest {
  let pathStat: FS.BigIntStats;
  try {
    pathStat = FS.lstatSync(filePath, { bigint: true });
  } catch {
    throw new Error(`Bundled Codex immutable digest is missing ${label}.`);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) {
    throw new Error(
      `Bundled Codex immutable digest requires a plain single-link file for ${label}.`,
    );
  }
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = FS.openSync(filePath, FS.constants.O_RDONLY | noFollow);
  } catch (cause) {
    throw new Error(`Bundled Codex immutable digest could not securely open ${label}.`, { cause });
  }
  try {
    const descriptorStatBefore = FS.fstatSync(descriptor, { bigint: true });
    const pathIdentity = immutableIdentity(pathStat);
    const descriptorIdentityBefore = immutableIdentity(descriptorStatBefore);
    if (
      !descriptorStatBefore.isFile() ||
      descriptorStatBefore.nlink !== 1n ||
      pathIdentity.dev !== descriptorIdentityBefore.dev ||
      pathIdentity.ino !== descriptorIdentityBefore.ino
    ) {
      throw new Error(
        `Bundled Codex immutable digest detected an identity change while opening ${label}.`,
      );
    }
    const digest = hashDescriptor(descriptor, descriptorStatBefore.size, label);
    const descriptorIdentityAfter = immutableIdentity(FS.fstatSync(descriptor, { bigint: true }));
    if (!immutableIdentityEquals(descriptorIdentityBefore, descriptorIdentityAfter)) {
      throw new Error(`Bundled Codex immutable digest detected ${label} changing while read.`);
    }
    return {
      filePath,
      label,
      descriptor,
      identity: descriptorIdentityAfter,
      ...digest,
    };
  } catch (cause) {
    FS.closeSync(descriptor);
    throw cause;
  }
}

function assertImmutableFileDigestCurrent(digest: ImmutableFileDigest): void {
  let pathStat: FS.BigIntStats;
  try {
    pathStat = FS.lstatSync(digest.filePath, { bigint: true });
  } catch {
    throw new Error(
      `Bundled Codex immutable digest detected ${digest.label} changed while verification was in progress.`,
    );
  }
  const descriptorStat = FS.fstatSync(digest.descriptor, { bigint: true });
  const pathIdentity = immutableIdentity(pathStat);
  const descriptorIdentity = immutableIdentity(descriptorStat);
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.nlink !== 1n ||
    !immutableIdentityEquals(digest.identity, descriptorIdentity) ||
    pathIdentity.dev !== digest.identity.dev ||
    pathIdentity.ino !== digest.identity.ino
  ) {
    throw new Error(
      `Bundled Codex immutable digest detected ${digest.label} changed while verification was in progress.`,
    );
  }
  const current = hashDescriptor(digest.descriptor, descriptorStat.size, digest.label);
  if (current.size !== digest.size || current.sha256 !== digest.sha256) {
    throw new Error(
      `Bundled Codex immutable digest detected ${digest.label} changed while verification was in progress.`,
    );
  }
}

/**
 * Validates a disposable container input after a platform tool has consumed it.
 * macOS hdiutil may update filesystem timestamps on a read-only attach input;
 * the source artifact and the retained immutable copy remain under the strict
 * identity check above. This check still fails closed on replacement, link,
 * size, or content changes to the disposable input.
 */
function assertImmutableFileDigestContentCurrent(digest: ImmutableFileDigest): void {
  let pathStat: FS.BigIntStats;
  try {
    pathStat = FS.lstatSync(digest.filePath, { bigint: true });
  } catch {
    throw new Error(
      `Bundled Codex disposable container input ${digest.label} disappeared while verification was in progress.`,
    );
  }
  const descriptorStat = FS.fstatSync(digest.descriptor, { bigint: true });
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.nlink !== 1n ||
    descriptorStat.dev !== digest.identity.dev ||
    descriptorStat.ino !== digest.identity.ino ||
    descriptorStat.nlink !== digest.identity.nlink ||
    descriptorStat.size !== BigInt(digest.size) ||
    pathStat.dev !== digest.identity.dev ||
    pathStat.ino !== digest.identity.ino
  ) {
    throw new Error(
      `Bundled Codex disposable container input ${digest.label} changed identity while verification was in progress.`,
    );
  }
  const current = hashDescriptor(digest.descriptor, descriptorStat.size, digest.label);
  if (current.size !== digest.size || current.sha256 !== digest.sha256) {
    throw new Error(
      `Bundled Codex disposable container input ${digest.label} content changed while verification was in progress.`,
    );
  }
}

function closeImmutableFileDigest(digest: ImmutableFileDigest): void {
  FS.closeSync(digest.descriptor);
}

function openImmutableFileSnapshot(
  filePath: string,
  label: string,
  maxBytes?: number,
): ImmutableFileSnapshot {
  let pathStat: FS.BigIntStats;
  try {
    pathStat = FS.lstatSync(filePath, { bigint: true });
  } catch {
    throw new Error(`Bundled Codex immutable snapshot is missing ${label}.`);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) {
    throw new Error(
      `Bundled Codex immutable snapshot requires a plain single-link file for ${label}.`,
    );
  }
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = FS.openSync(filePath, FS.constants.O_RDONLY | noFollow);
  } catch (cause) {
    throw new Error(`Bundled Codex immutable snapshot could not securely open ${label}.`, {
      cause,
    });
  }
  try {
    const descriptorStatBefore = FS.fstatSync(descriptor, { bigint: true });
    const pathIdentity = immutableIdentity(pathStat);
    const descriptorIdentityBefore = immutableIdentity(descriptorStatBefore);
    if (
      !descriptorStatBefore.isFile() ||
      descriptorStatBefore.nlink !== 1n ||
      pathIdentity.dev !== descriptorIdentityBefore.dev ||
      pathIdentity.ino !== descriptorIdentityBefore.ino
    ) {
      throw new Error(
        `Bundled Codex immutable snapshot detected an identity change while opening ${label}.`,
      );
    }
    if (
      maxBytes !== undefined &&
      (descriptorStatBefore.size < 0n || descriptorStatBefore.size > BigInt(maxBytes))
    ) {
      throw new Error(
        `Bundled Codex immutable snapshot for ${label} exceeds its ${maxBytes}-byte limit.`,
      );
    }
    const bytes = readDescriptorBytes(descriptor, descriptorStatBefore.size, label);
    const descriptorStatAfter = FS.fstatSync(descriptor, { bigint: true });
    const descriptorIdentityAfter = immutableIdentity(descriptorStatAfter);
    if (
      !immutableIdentityEquals(descriptorIdentityBefore, descriptorIdentityAfter) ||
      BigInt(bytes.length) !== descriptorStatAfter.size
    ) {
      throw new Error(
        `Bundled Codex immutable snapshot detected ${label} changing while it was read.`,
      );
    }
    return {
      filePath,
      label,
      descriptor,
      identity: descriptorIdentityAfter,
      bytes,
      size: bytes.length,
      sha256: Crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (cause) {
    FS.closeSync(descriptor);
    throw cause;
  }
}

function assertImmutableFileSnapshotCurrent(snapshot: ImmutableFileSnapshot): void {
  let pathStat: FS.BigIntStats;
  try {
    pathStat = FS.lstatSync(snapshot.filePath, { bigint: true });
  } catch {
    throw new Error(
      `Bundled Codex immutable snapshot detected ${snapshot.label} changed while verification was in progress.`,
    );
  }
  const descriptorStat = FS.fstatSync(snapshot.descriptor, { bigint: true });
  const pathIdentity = immutableIdentity(pathStat);
  const descriptorIdentity = immutableIdentity(descriptorStat);
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.nlink !== 1n ||
    !immutableIdentityEquals(snapshot.identity, descriptorIdentity) ||
    pathIdentity.dev !== snapshot.identity.dev ||
    pathIdentity.ino !== snapshot.identity.ino
  ) {
    throw new Error(
      `Bundled Codex immutable snapshot detected ${snapshot.label} changed while verification was in progress.`,
    );
  }
  const bytes = readDescriptorBytes(snapshot.descriptor, descriptorStat.size, snapshot.label);
  if (
    !bytes.equals(snapshot.bytes) ||
    Crypto.createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
  ) {
    throw new Error(
      `Bundled Codex immutable snapshot detected ${snapshot.label} changed while verification was in progress.`,
    );
  }
}

function closeImmutableFileSnapshot(snapshot: ImmutableFileSnapshot): void {
  FS.closeSync(snapshot.descriptor);
}

function requirePlainFile(filePath: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(filePath);
  } catch {
    throw new Error(`Bundled Codex compliance validation failed: missing ${label}.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${label} must be a plain regular file.`,
    );
  }
}

function listPlainRelativeFiles(rootDirectory: string, label: string): string[] {
  let rootStat: FS.Stats;
  try {
    rootStat = FS.lstatSync(rootDirectory);
  } catch {
    throw new Error(`Bundled Codex compliance validation failed: missing ${label}.`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${label} must be a plain directory.`,
    );
  }
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of FS.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = Path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        files.push(Path.relative(rootDirectory, absolutePath).split(Path.sep).join("/"));
      } else {
        throw new Error(
          `Bundled Codex compliance validation failed: ${label} contains a non-plain entry ${absolutePath}.`,
        );
      }
    }
  };
  visit(rootDirectory);
  return files.toSorted(compareUtf8Bytes);
}

interface ComplianceBundleTreeEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly mode: "040755" | "100644" | "100755";
  readonly size?: number;
  readonly sha256?: string;
}

function validatePortableCompliancePath(relativePath: string): void {
  const segments = relativePath.split("/");
  const isLicenseGitAttributes = relativePath === "licenses/.gitattributes";
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\r") ||
    relativePath.includes("\n") ||
    relativePath.includes("\\") ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        (!isLicenseGitAttributes && !/^[A-Za-z0-9][A-Za-z0-9._+@-]*$/u.test(segment)),
    )
  ) {
    throw new Error(
      `Bundled Codex compliance validation failed: invalid portable bundle path ${JSON.stringify(relativePath)}.`,
    );
  }
}

function strictPosixBundleMode(stat: FS.Stats, expectedMode: number, relativePath: string): void {
  if (process.platform !== "win32" && (stat.mode & 0o777) !== expectedMode) {
    throw new Error(
      `Bundled Codex compliance validation failed: non-canonical permissions for ${relativePath}; expected ${expectedMode.toString(8).padStart(4, "0")}, found ${(stat.mode & 0o777).toString(8).padStart(4, "0")}.`,
    );
  }
}

function listComplianceBundleTree(rootDirectory: string): ComplianceBundleTreeEntry[] {
  let rootStat: FS.Stats;
  try {
    rootStat = FS.lstatSync(rootDirectory);
  } catch {
    throw new Error("Bundled Codex compliance validation failed: compliance bundle is missing.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      "Bundled Codex compliance validation failed: compliance bundle must be a plain directory.",
    );
  }

  const entries: ComplianceBundleTreeEntry[] = [];
  const visit = (directory: string, parentRelativePath: string): void => {
    for (const name of FS.readdirSync(directory)) {
      const relativePath = parentRelativePath ? `${parentRelativePath}/${name}` : name;
      validatePortableCompliancePath(relativePath);
      const absolutePath = Path.join(directory, name);
      const stat = FS.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Bundled Codex compliance validation failed: compliance bundle contains a symlink or junction at ${relativePath}.`,
        );
      }
      if (stat.isDirectory()) {
        strictPosixBundleMode(stat, 0o755, relativePath);
        entries.push({ kind: "directory", path: relativePath, mode: "040755" });
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `Bundled Codex compliance validation failed: compliance bundle contains a special entry at ${relativePath}.`,
        );
      }
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new Error(
          `Bundled Codex compliance validation failed: invalid file size for ${relativePath}.`,
        );
      }
      const executable = (stat.mode & 0o111) !== 0;
      strictPosixBundleMode(stat, executable ? 0o755 : 0o644, relativePath);
      const bytes = FS.readFileSync(absolutePath);
      if (bytes.length !== stat.size) {
        throw new Error(
          `Bundled Codex compliance validation failed: file changed while reading ${relativePath}.`,
        );
      }
      entries.push({
        kind: "file",
        path: relativePath,
        mode: executable ? "100755" : "100644",
        size: stat.size,
        sha256: Crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  visit(rootDirectory, "");
  return entries.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
}

function validateComplianceBundleRoot(directory: string): {
  readonly algorithm: typeof BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
  readonly rootSha256: string;
} {
  const entries = listComplianceBundleTree(directory);
  const hash = Crypto.createHash("sha256");
  hash.update(`${BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM}\0`, "ascii");
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    if (entry.kind === "directory") {
      directoryCount += 1;
      hash.update(`D\0${entry.mode}\0${pathBytes.length}\0`, "ascii");
      hash.update(pathBytes);
      hash.update("\0", "ascii");
      continue;
    }
    fileCount += 1;
    totalBytes += entry.size!;
    hash.update(
      `F\0${entry.mode}\0${entry.size!}\0${entry.sha256!}\0${pathBytes.length}\0`,
      "ascii",
    );
    hash.update(pathBytes);
    hash.update("\0", "ascii");
  }
  hash.update(`END\0${entries.length}\0${fileCount}\0${directoryCount}\0`, "ascii");
  const rootSha256 = hash.digest("hex");
  if (
    entries.length !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_ENTRY_COUNT ||
    fileCount !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_FILE_COUNT ||
    directoryCount !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_DIRECTORY_COUNT ||
    totalBytes !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_TOTAL_BYTES ||
    rootSha256 !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256
  ) {
    throw new Error(
      `Bundled Codex compliance validation failed: bundle root SHA-256 mismatch (algorithm=${BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM}, entries=${entries.length}, files=${fileCount}, directories=${directoryCount}, bytes=${totalBytes}, sha256=${rootSha256}).`,
    );
  }
  return {
    algorithm: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM,
    entryCount: entries.length,
    fileCount,
    directoryCount,
    totalBytes,
    rootSha256,
  };
}

function readJson(filePath: string, label: string): JsonRecord {
  requirePlainFile(filePath, label);
  let value: unknown;
  try {
    value = JSON.parse(FS.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`Bundled Codex compliance validation failed: ${label} is not valid JSON.`, {
      cause,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Bundled Codex compliance validation failed: ${label} must be an object.`);
  }
  return value as JsonRecord;
}

export function assertBundledCodexComplianceVersion(expectedVersion: string): void {
  if (expectedVersion !== BUNDLED_CODEX_COMPLIANCE_VERSION) {
    throw new Error(
      `Bundled Codex compliance validation failed: runtime version ${expectedVersion} is not bound to compliance version ${BUNDLED_CODEX_COMPLIANCE_VERSION}.`,
    );
  }
}

function validateTopLevelProvenance(directory: string): void {
  const licensePath = Path.join(directory, "LICENSE");
  const noticePath = Path.join(directory, "NOTICE");
  const sourcePath = Path.join(directory, "SOURCE.json");
  requirePlainFile(licensePath, "LICENSE");
  requirePlainFile(noticePath, "NOTICE");
  if (sha256File(licensePath) !== TOP_LEVEL_LICENSE_SHA256) {
    throw new Error("Bundled Codex compliance validation failed: LICENSE SHA-256 mismatch.");
  }
  if (sha256File(noticePath) !== TOP_LEVEL_NOTICE_SHA256) {
    throw new Error("Bundled Codex compliance validation failed: NOTICE SHA-256 mismatch.");
  }
  const source = readJson(sourcePath, "SOURCE.json");
  if (!isDeepStrictEqual(source, EXPECTED_SOURCE_DOCUMENT)) {
    throw new Error(
      "Bundled Codex compliance validation failed: SOURCE.json does not exactly match the pinned source provenance.",
    );
  }
}

function stringField(record: JsonRecord, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Bundled Codex compliance validation failed: ${label}.${field} is invalid.`);
  }
  return value;
}

function numberField(record: JsonRecord, field: string, label: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Bundled Codex compliance validation failed: ${label}.${field} is invalid.`);
  }
  return value;
}

function arrayField(record: JsonRecord, field: string, label: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new Error(`Bundled Codex compliance validation failed: ${label}.${field} is invalid.`);
  }
  return value;
}

function objectEntry(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Bundled Codex compliance validation failed: ${label} must be an object.`);
  }
  return value as JsonRecord;
}

function componentProperty(component: JsonRecord, propertyName: string, label: string): string {
  const properties = arrayField(component, "properties", label);
  const matching = properties
    .map((value, index) => objectEntry(value, `${label}.properties[${index}]`))
    .filter((property) => property.name === propertyName);
  if (matching.length !== 1) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${label} must have exactly one ${propertyName} property.`,
    );
  }
  return stringField(matching[0]!, "value", `${label}.${propertyName}`);
}

function validateSelectedRustLicense(expression: string, bomRef: string): void {
  if (expression.includes(" OR ") || expression.includes("/") || !expression) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${bomRef} does not have one deterministic selected-license branch.`,
    );
  }
  for (const atom of expression.split(" AND ")) {
    const parts = atom.split(" WITH ");
    if (
      parts.length > 2 ||
      !APPROVED_RUST_LICENSE_IDS.has(parts[0] ?? "") ||
      (parts[1] !== undefined && !APPROVED_RUST_LICENSE_EXCEPTIONS.has(parts[1]))
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: ${bomRef} selected an unapproved or strong-copyleft license (${expression}).`,
      );
    }
  }
}

function validateSourceBinding(
  sourceLocator: string,
  sourceIntegrity: string,
  bomRef: string,
): void {
  if (sourceLocator.startsWith("registry+")) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(sourceIntegrity)) {
      throw new Error(
        `Bundled Codex compliance validation failed: ${bomRef} registry source is not bound to a Cargo checksum.`,
      );
    }
    return;
  }
  const commit = /#([0-9a-f]{40})$/u.exec(sourceLocator)?.[1];
  if (!commit || sourceIntegrity !== `git:${commit}`) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${bomRef} git source is not bound to its exact commit.`,
    );
  }
}

function validateBom(directory: string): {
  componentCount: number;
  bomRefs: Set<string>;
  cargoBindings: Map<string, BomLicenseBinding>;
} {
  const bom = readJson(Path.join(directory, "COMPONENTS.cdx.json"), "COMPONENTS.cdx.json");
  if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.6" || bom.version !== 1) {
    throw new Error(
      "Bundled Codex compliance validation failed: CycloneDX identity/version mismatch.",
    );
  }
  const components = arrayField(bom, "components", "COMPONENTS.cdx.json");
  if (components.length !== BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected exactly ${BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT} components, found ${components.length}.`,
    );
  }
  const bomRefs = new Set<string>();
  const cargoBindings = new Map<string, BomLicenseBinding>();
  for (const [index, value] of components.entries()) {
    const component = objectEntry(value, `components[${index}]`);
    const bomRef = stringField(component, "bom-ref", `components[${index}]`);
    if (bomRefs.has(bomRef)) {
      throw new Error(`Bundled Codex compliance validation failed: duplicate bom-ref ${bomRef}.`);
    }
    bomRefs.add(bomRef);
    const licenses = arrayField(component, "licenses", `components[${index}]`);
    if (licenses.length === 0) {
      throw new Error(
        `Bundled Codex compliance validation failed: ${bomRef} has no declared license.`,
      );
    }
    if (bomRef.startsWith("cargo-")) {
      if (licenses.length !== 1) {
        throw new Error(
          `Bundled Codex compliance validation failed: ${bomRef} Cargo license declaration must be singular.`,
        );
      }
      const declaredLicenseExpression = stringField(
        objectEntry(licenses[0], `${bomRef}.licenses[0]`),
        "expression",
        `${bomRef}.licenses[0]`,
      );
      const selectedLicenseExpression = componentProperty(
        component,
        "moss:selected-license",
        bomRef,
      );
      const sourceLocator = componentProperty(component, "moss:source", bomRef);
      const sourceIntegrity = componentProperty(component, "moss:source-integrity", bomRef);
      validateSelectedRustLicense(selectedLicenseExpression, bomRef);
      validateSourceBinding(sourceLocator, sourceIntegrity, bomRef);
      cargoBindings.set(bomRef, {
        component: `${stringField(component, "name", bomRef)}@${stringField(component, "version", bomRef)}`,
        declaredLicenseExpression,
        selectedLicenseExpression,
        sourceLocator,
        sourceIntegrity,
      });
    }
  }
  for (const required of [
    "native-codex-voice-host",
    "native-pcre2-10.45",
    "native-bubblewrap-0.11.2",
    "native-libcap-2.75",
  ]) {
    if (!bomRefs.has(required)) {
      throw new Error(
        `Bundled Codex compliance validation failed: missing native component ${required}.`,
      );
    }
  }
  const expectedNativeSelections = new Map([
    ["native-codex-voice-host", "mixed permissive and LGPL-2.1-or-later"],
    ["native-pcre2-10.45", "BSD-3-Clause"],
    ["native-bubblewrap-0.11.2", "LGPL-2.0-or-later"],
    ["native-libcap-2.75", "BSD-3-Clause"],
  ]);
  for (const componentValue of components) {
    const component = objectEntry(componentValue, "native component");
    const bomRef = stringField(component, "bom-ref", "native component");
    const expectedSelection = expectedNativeSelections.get(bomRef);
    if (
      expectedSelection &&
      componentProperty(component, "moss:selected-license", bomRef) !== expectedSelection
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: selected native license mismatch for ${bomRef}.`,
      );
    }
  }
  if (cargoBindings.size !== 1_474) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected 1474 Cargo source/license bindings, found ${cargoBindings.size}.`,
    );
  }
  return { componentCount: components.length, bomRefs, cargoBindings };
}

function validateLicenseEvidence(
  directory: string,
  bomRefs: ReadonlySet<string>,
  cargoBindings: ReadonlyMap<string, BomLicenseBinding>,
): { textCount: number } {
  const evidence = readJson(Path.join(directory, "LICENSE_EVIDENCE.json"), "LICENSE_EVIDENCE.json");
  if (evidence.schemaVersion !== 1 || evidence.codexVersion !== CODEX_VERSION) {
    throw new Error(
      "Bundled Codex compliance validation failed: LICENSE_EVIDENCE identity/version mismatch.",
    );
  }
  const componentCount = numberField(evidence, "componentCount", "LICENSE_EVIDENCE.json");
  const textCount = numberField(evidence, "textCount", "LICENSE_EVIDENCE.json");
  const missing = arrayField(evidence, "missingEvidence", "LICENSE_EVIDENCE.json");
  const mappings = arrayField(evidence, "componentEvidence", "LICENSE_EVIDENCE.json");
  if (missing.length !== 0 || mappings.length !== componentCount || componentCount < 1_000) {
    throw new Error(
      `Bundled Codex compliance validation failed: license evidence is incomplete (components=${componentCount}, mappings=${mappings.length}, missing=${missing.length}).`,
    );
  }
  const seenTexts = new Set<string>();
  const seenTextPaths = new Set<string>();
  // Shared license texts occur in many component mappings. Aggregate their
  // requirements, then read every distinct file once in this validation call.
  // The final whole-tree commitment independently rereads all bundle bytes.
  const expectedTexts = new Map<string, { relativePath: string; sha256: string }>();
  const seenMappings = new Set<string>();
  for (const [mappingIndex, mappingValue] of mappings.entries()) {
    const mapping = objectEntry(mappingValue, `componentEvidence[${mappingIndex}]`);
    const bomRef = stringField(mapping, "bomRef", `componentEvidence[${mappingIndex}]`);
    const binding = cargoBindings.get(bomRef);
    if (!bomRefs.has(bomRef) || !binding || seenMappings.has(bomRef)) {
      throw new Error(
        `Bundled Codex compliance validation failed: unknown or duplicate evidence bom-ref ${bomRef}.`,
      );
    }
    seenMappings.add(bomRef);
    if (
      stringField(mapping, "component", `componentEvidence[${mappingIndex}]`) !==
        binding.component ||
      stringField(mapping, "declaredLicenseExpression", `componentEvidence[${mappingIndex}]`) !==
        binding.declaredLicenseExpression ||
      stringField(mapping, "selectedLicenseExpression", `componentEvidence[${mappingIndex}]`) !==
        binding.selectedLicenseExpression ||
      stringField(mapping, "sourceLocator", `componentEvidence[${mappingIndex}]`) !==
        binding.sourceLocator ||
      stringField(mapping, "sourceIntegrity", `componentEvidence[${mappingIndex}]`) !==
        binding.sourceIntegrity
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: selected-license/source binding mismatch for ${bomRef}.`,
      );
    }
    validateSelectedRustLicense(binding.selectedLicenseExpression, bomRef);
    validateSourceBinding(binding.sourceLocator, binding.sourceIntegrity, bomRef);
    const files = arrayField(mapping, "files", `componentEvidence[${mappingIndex}]`);
    if (files.length === 0) {
      throw new Error(`Bundled Codex compliance validation failed: ${bomRef} has no license text.`);
    }
    for (const [fileIndex, fileValue] of files.entries()) {
      const file = objectEntry(fileValue, `componentEvidence[${mappingIndex}].files[${fileIndex}]`);
      const relativePath = stringField(file, "relativePath", "license evidence file");
      const expectedHash = stringField(file, "sha256", "license evidence file");
      if (!SHA256.test(expectedHash) || !relativePath.startsWith("licenses/rust/")) {
        throw new Error(
          `Bundled Codex compliance validation failed: invalid license evidence path/hash for ${bomRef}.`,
        );
      }
      const absolutePath = Path.resolve(directory, relativePath);
      const relativeToDirectory = Path.relative(directory, absolutePath);
      if (relativeToDirectory.startsWith("..") || Path.isAbsolute(relativeToDirectory)) {
        throw new Error(
          `Bundled Codex compliance validation failed: license evidence escapes bundle for ${bomRef}.`,
        );
      }
      const existingText = expectedTexts.get(absolutePath);
      if (existingText !== undefined && existingText.sha256 !== expectedHash) {
        throw new Error(
          `Bundled Codex compliance validation failed: license evidence SHA-256 mismatch for ${relativePath}.`,
        );
      }
      if (existingText === undefined) {
        expectedTexts.set(absolutePath, { relativePath, sha256: expectedHash });
      }
      seenTexts.add(expectedHash);
      seenTextPaths.add(relativePath);
    }
  }
  for (const [absolutePath, expectedText] of expectedTexts) {
    requirePlainFile(absolutePath, expectedText.relativePath);
    if (sha256File(absolutePath) !== expectedText.sha256) {
      throw new Error(
        `Bundled Codex compliance validation failed: license evidence SHA-256 mismatch for ${expectedText.relativePath}.`,
      );
    }
  }
  if (textCount !== BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected ${BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT} license texts, found ${textCount}.`,
    );
  }
  if (seenTexts.size !== textCount) {
    throw new Error(
      `Bundled Codex compliance validation failed: license text count mismatch (${seenTexts.size} != ${textCount}).`,
    );
  }
  if (seenMappings.size !== cargoBindings.size) {
    throw new Error(
      `Bundled Codex compliance validation failed: Cargo evidence coverage mismatch (${seenMappings.size} != ${cargoBindings.size}).`,
    );
  }
  const actualLicensePaths = listPlainRelativeFiles(Path.join(directory, "licenses"), "licenses")
    .filter((relativePath) => relativePath !== LICENSE_DIRECTORY_METADATA_FILE)
    .map((relativePath) => `licenses/${relativePath}`)
    .toSorted(compareUtf8Bytes);
  const expectedLicensePaths = [...seenTextPaths, ...EXPECTED_NAMED_LICENSE_PATHS].toSorted(
    compareUtf8Bytes,
  );
  if (JSON.stringify(actualLicensePaths) !== JSON.stringify(expectedLicensePaths)) {
    throw new Error(
      `Bundled Codex compliance validation failed: license file inventory mismatch (${actualLicensePaths.length} != ${expectedLicensePaths.length}).`,
    );
  }
  return { textCount };
}

function parsePayloads(directory: string): PayloadDocument {
  const payloadsPath = Path.join(directory, "PAYLOADS.json");
  requirePlainFile(payloadsPath, "PAYLOADS.json");
  if (sha256File(payloadsPath) !== PAYLOADS_SHA256) {
    throw new Error("Bundled Codex compliance validation failed: PAYLOADS.json SHA-256 mismatch.");
  }
  const payloads = readJson(payloadsPath, "PAYLOADS.json");
  if (
    payloads.schemaVersion !== 1 ||
    payloads.package !== "@openai/codex" ||
    payloads.baseVersion !== CODEX_VERSION ||
    payloads.registry !== "https://registry.npmjs.org"
  ) {
    throw new Error(
      "Bundled Codex compliance validation failed: PAYLOADS identity/version mismatch.",
    );
  }
  const archives = arrayField(payloads, "archives", "PAYLOADS.json").map(
    (archiveValue, archiveIndex) => {
      const archive = objectEntry(archiveValue, `archives[${archiveIndex}]`);
      const id = stringField(archive, "id", `archives[${archiveIndex}]`);
      if (!(id in EXPECTED_ARCHIVES)) {
        throw new Error(`Bundled Codex compliance validation failed: unexpected archive ${id}.`);
      }
      const files = arrayField(archive, "files", `archives[${archiveIndex}]`).map(
        (fileValue, fileIndex) => {
          const file = objectEntry(fileValue, `archives[${archiveIndex}].files[${fileIndex}]`);
          return {
            path: stringField(file, "path", "payload file"),
            size: numberField(file, "size", "payload file"),
            sha256: stringField(file, "sha256", "payload file"),
          };
        },
      );
      return {
        id: id as keyof typeof EXPECTED_ARCHIVES,
        npmPackage: stringField(archive, "npmPackage", `archives[${archiveIndex}]`),
        npmVersion: stringField(archive, "npmVersion", `archives[${archiveIndex}]`),
        archive: stringField(archive, "archive", `archives[${archiveIndex}]`),
        npmIntegrity: stringField(archive, "npmIntegrity", `archives[${archiveIndex}]`),
        size: numberField(archive, "size", `archives[${archiveIndex}]`),
        sha256: stringField(archive, "sha256", `archives[${archiveIndex}]`),
        files,
      } satisfies PayloadArchive;
    },
  );
  return {
    schemaVersion: 1,
    package: "@openai/codex",
    baseVersion: CODEX_VERSION,
    registry: "https://registry.npmjs.org",
    archives,
  };
}

function validatePayloadDocument(payloads: PayloadDocument): number {
  if (payloads.archives.length !== Object.keys(EXPECTED_ARCHIVES).length) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected seven npm archives, found ${payloads.archives.length}.`,
    );
  }
  const seen = new Set<string>();
  let payloadFileCount = 0;
  for (const archive of payloads.archives) {
    if (seen.has(archive.id)) {
      throw new Error(
        `Bundled Codex compliance validation failed: duplicate archive ${archive.id}.`,
      );
    }
    seen.add(archive.id);
    const expected = EXPECTED_ARCHIVES[archive.id];
    if (
      archive.npmPackage !== "@openai/codex" ||
      archive.npmVersion !== expected.npmVersion ||
      archive.archive !== expected.archive ||
      archive.size !== expected.size ||
      archive.sha256 !== expected.sha256 ||
      archive.npmIntegrity !== expected.npmIntegrity ||
      archive.files.length === 0
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: registry archive lock mismatch for ${archive.id}.`,
      );
    }
    const filePaths = new Set<string>();
    for (const file of archive.files) {
      if (
        filePaths.has(file.path) ||
        file.path.startsWith("/") ||
        file.path.split("/").includes("..") ||
        file.size <= 0 ||
        !SHA256.test(file.sha256)
      ) {
        throw new Error(
          `Bundled Codex compliance validation failed: invalid payload file lock in ${archive.id}: ${file.path}.`,
        );
      }
      filePaths.add(file.path);
      payloadFileCount += 1;
    }
    if (archive.id !== "launcher") {
      const requiredSuffixes = REQUIRED_PAYLOAD_SUFFIXES[archive.id];
      for (const suffix of requiredSuffixes) {
        if (![...filePaths].some((path) => path.endsWith(`/${suffix}`))) {
          throw new Error(
            `Bundled Codex compliance validation failed: ${archive.id} omits required ${suffix}.`,
          );
        }
      }
    }
  }
  if (payloadFileCount !== BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected ${BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT} locked npm files, found ${payloadFileCount}.`,
    );
  }
  return payloadFileCount;
}

function validateSourceMaterials(directory: string): number {
  const document = readJson(Path.join(directory, "SOURCE_MATERIALS.json"), "SOURCE_MATERIALS.json");
  if (
    document.schemaVersion !== 1 ||
    document.codexVersion !== CODEX_VERSION ||
    document.legalStatus !==
      "engineering-source-closure-present; legal review is outside this build gate"
  ) {
    throw new Error(
      "Bundled Codex compliance validation failed: SOURCE_MATERIALS identity/legal status mismatch.",
    );
  }
  const rebuildPath = Path.join(directory, "REBUILD.md");
  requirePlainFile(rebuildPath, "REBUILD.md");
  if (sha256File(rebuildPath) !== REBUILD_SHA256) {
    throw new Error("Bundled Codex compliance validation failed: REBUILD.md SHA-256 mismatch.");
  }
  const sourcesDirectory = Path.join(directory, "sources");
  let sourcesStat: FS.Stats;
  try {
    sourcesStat = FS.lstatSync(sourcesDirectory);
  } catch {
    throw new Error("Bundled Codex compliance validation failed: sources directory is missing.");
  }
  if (!sourcesStat.isDirectory() || sourcesStat.isSymbolicLink()) {
    throw new Error(
      "Bundled Codex compliance validation failed: sources must be a plain directory.",
    );
  }
  const expectedSourceFiles = Object.values(EXPECTED_SOURCE_MATERIALS)
    .map((material) => Path.basename(material.path))
    .toSorted(compareUtf8Bytes);
  const actualSourceFiles = FS.readdirSync(sourcesDirectory).toSorted(compareUtf8Bytes);
  if (JSON.stringify(actualSourceFiles) !== JSON.stringify(expectedSourceFiles)) {
    throw new Error(
      `Bundled Codex compliance validation failed: source archive set mismatch (${actualSourceFiles.join(", ")}).`,
    );
  }

  const materials = arrayField(document, "materials", "SOURCE_MATERIALS.json");
  if (materials.length !== BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected ${BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT} source materials, found ${materials.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const [index, value] of materials.entries()) {
    const material = objectEntry(value, `materials[${index}]`);
    const id = stringField(material, "id", `materials[${index}]`);
    if (seen.has(id) || !(id in EXPECTED_SOURCE_MATERIALS)) {
      throw new Error(
        `Bundled Codex compliance validation failed: unexpected/duplicate source material ${id}.`,
      );
    }
    seen.add(id);
    const expected = EXPECTED_SOURCE_MATERIALS[id as keyof typeof EXPECTED_SOURCE_MATERIALS];
    const relativePath = stringField(material, "path", `materials[${index}]`);
    if (
      relativePath !== expected.path ||
      numberField(material, "size", `materials[${index}]`) !== expected.size ||
      stringField(material, "sha256", `materials[${index}]`) !== expected.sha256 ||
      stringField(material, "mediaType", `materials[${index}]`) !== expected.mediaType
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: source material lock mismatch for ${id}.`,
      );
    }
    if (id === "codex-rust-v0.163.0") {
      if (
        material.repository !== "https://github.com/openai/codex" ||
        material.revision !== "83086188ae0614bd882818ff1aa23f3194962012" ||
        JSON.stringify(material.relevantPaths) !==
          JSON.stringify([
            "codex-rs/vendor/bubblewrap",
            "codex-rs/bwrap",
            ".github/scripts/install-musl-build-tools.sh",
            ".github/workflows/rust-release.yml",
          ])
      ) {
        throw new Error(
          "Bundled Codex compliance validation failed: Codex source provenance mismatch.",
        );
      }
    } else if (
      material.distributionUrl !==
      "https://mirrors.edge.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.75.tar.xz"
    ) {
      throw new Error(
        "Bundled Codex compliance validation failed: libcap source provenance mismatch.",
      );
    }
    const absolutePath = Path.resolve(directory, relativePath);
    const relativeToDirectory = Path.relative(directory, absolutePath);
    if (relativeToDirectory.startsWith("..") || Path.isAbsolute(relativeToDirectory)) {
      throw new Error(
        `Bundled Codex compliance validation failed: source material escapes bundle for ${id}.`,
      );
    }
    requirePlainFile(absolutePath, relativePath);
    if (
      FS.statSync(absolutePath).size !== expected.size ||
      sha256File(absolutePath) !== expected.sha256
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: source archive SHA-256/size mismatch for ${relativePath}.`,
      );
    }
  }
  return materials.length;
}

function validateObligations(directory: string): {
  releaseDecision: "approved" | "blocked";
  blockers: string[];
} {
  const obligations = readJson(Path.join(directory, "OBLIGATIONS.json"), "OBLIGATIONS.json");
  if (
    obligations.schemaVersion !== 1 ||
    obligations.codexVersion !== CODEX_VERSION ||
    obligations.decisionScope !==
      "automated engineering evidence and distribution-asset completeness; not legal advice"
  ) {
    throw new Error(
      "Bundled Codex compliance validation failed: OBLIGATIONS identity/version mismatch.",
    );
  }
  if (obligations.releaseDecision !== "approved") {
    throw new Error(
      "Bundled Codex compliance validation failed: audited engineering releaseDecision must be approved.",
    );
  }
  const runtimePolicy = objectEntry(obligations.runtimePolicy, "OBLIGATIONS.json.runtimePolicy");
  if (
    runtimePolicy.linuxPublicArchitecture !== "x64" ||
    runtimePolicy.linuxLibc !== "glibc" ||
    runtimePolicy.minimumGlibcVersion !== "2.38" ||
    runtimePolicy.maximumVoiceHostGlibcVersion !== "2.38" ||
    runtimePolicy.packageCoordinate !== "x86_64-unknown-linux-musl" ||
    JSON.stringify(runtimePolicy.requiredSharedLibraries) !==
      JSON.stringify([...LINUX_PUBLIC_SHARED_LIBRARIES]) ||
    JSON.stringify(runtimePolicy.requiredRuntimeProbes) !==
      JSON.stringify([
        "codex --version",
        "codex debug models --bundled",
        "readelf --version-info codex-voice-host",
        "readelf --dynamic codex-voice-host",
      ])
  ) {
    throw new Error("Bundled Codex compliance validation failed: Linux runtime policy mismatch.");
  }
  const blockerIds = arrayField(obligations, "blockers", "OBLIGATIONS.json")
    .map((value, index) =>
      stringField(objectEntry(value, `blockers[${index}]`), "id", `blockers[${index}]`),
    )
    .toSorted(compareUtf8Bytes);
  if (blockerIds.length !== 0) {
    throw new Error(
      "Bundled Codex compliance validation failed: approved ledger must have no blockers.",
    );
  }
  const licenseAssets = arrayField(obligations, "licenseAssets", "OBLIGATIONS.json");
  if (licenseAssets.length !== EXPECTED_NAMED_LICENSE_PATHS.length) {
    throw new Error(
      `Bundled Codex compliance validation failed: expected ${EXPECTED_NAMED_LICENSE_PATHS.length} named license assets, found ${licenseAssets.length}.`,
    );
  }
  for (const [index, assetValue] of licenseAssets.entries()) {
    const asset = objectEntry(assetValue, `licenseAssets[${index}]`);
    const relativePath = stringField(asset, "path", `licenseAssets[${index}]`);
    const expectedHash = stringField(asset, "sha256", `licenseAssets[${index}]`);
    const absolutePath = Path.resolve(directory, relativePath);
    const relativeToDirectory = Path.relative(directory, absolutePath);
    if (
      !relativePath.startsWith("licenses/") ||
      !SHA256.test(expectedHash) ||
      relativeToDirectory.startsWith("..") ||
      Path.isAbsolute(relativeToDirectory)
    ) {
      throw new Error(
        `Bundled Codex compliance validation failed: invalid named license asset ${relativePath}.`,
      );
    }
    requirePlainFile(absolutePath, relativePath);
    if (sha256File(absolutePath) !== expectedHash) {
      throw new Error(
        `Bundled Codex compliance validation failed: named license SHA-256 mismatch for ${relativePath}.`,
      );
    }
  }
  const fulfilledEvidenceIds = arrayField(obligations, "fulfilledEvidence", "OBLIGATIONS.json")
    .map((value, index) =>
      stringField(
        objectEntry(value, `fulfilledEvidence[${index}]`),
        "id",
        `fulfilledEvidence[${index}]`,
      ),
    )
    .toSorted(compareUtf8Bytes);
  const expectedFulfilledEvidenceIds = [
    "linux-bwrap-source-materials",
    "linux-voice-host-glibc-runtime-policy",
    "named-native-license-texts",
    "runtime-component-inventory",
    "rust-license-selection-policy",
    "top-level-codex-apache",
  ];
  if (JSON.stringify(fulfilledEvidenceIds) !== JSON.stringify(expectedFulfilledEvidenceIds)) {
    throw new Error(
      "Bundled Codex compliance validation failed: fulfilled evidence ledger mismatch.",
    );
  }
  return { releaseDecision: obligations.releaseDecision, blockers: blockerIds };
}

export function validateBundledCodexReleaseComplianceBundle(input: {
  readonly directory: string;
}): BundledCodexComplianceValidation {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(input.directory);
  } catch {
    throw new Error(
      `Bundled Codex compliance validation failed: compliance bundle is missing at ${input.directory}.`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "Bundled Codex compliance validation failed: compliance bundle must be a plain directory.",
    );
  }
  const entries = FS.readdirSync(input.directory).toSorted(compareUtf8Bytes);
  if (
    JSON.stringify(entries) !==
    JSON.stringify([...BUNDLED_CODEX_COMPLIANCE_TOP_LEVEL_ENTRIES].toSorted(compareUtf8Bytes))
  ) {
    throw new Error(
      `Bundled Codex compliance validation failed: top-level entries mismatch (${entries.join(", ")}).`,
    );
  }
  validateTopLevelProvenance(input.directory);
  const { componentCount, bomRefs, cargoBindings } = validateBom(input.directory);
  const { textCount } = validateLicenseEvidence(input.directory, bomRefs, cargoBindings);
  const payloadFileCount = validatePayloadDocument(parsePayloads(input.directory));
  const sourceMaterialCount = validateSourceMaterials(input.directory);
  const { releaseDecision, blockers } = validateObligations(input.directory);
  // Validate the deterministic whole-tree commitment last so targeted
  // semantic failures remain actionable while self-consistent tampering,
  // extra empty directories, permissions, and special entries still fail.
  const bundleRoot = validateComplianceBundleRoot(input.directory);
  return {
    directory: input.directory,
    bundleRootAlgorithm: bundleRoot.algorithm,
    bundleEntryCount: bundleRoot.entryCount,
    bundleFileCount: bundleRoot.fileCount,
    bundleDirectoryCount: bundleRoot.directoryCount,
    bundleTotalBytes: bundleRoot.totalBytes,
    bundleRootSha256: bundleRoot.rootSha256,
    componentCount,
    licenseTextCount: textCount,
    payloadFileCount,
    sourceMaterialCount,
    releaseDecision,
    blockers,
  };
}

export function assertBundledCodexReleaseApproved(input: { readonly directory: string }): void {
  const validation = validateBundledCodexReleaseComplianceBundle(input);
  if (validation.releaseDecision !== "approved") {
    throw new Error(
      `Bundled Codex release compliance is blocked: ${validation.blockers.join(", ")}. Resolve the audited obligations before packaging.`,
    );
  }
}

function assertContainedPath(rootDirectory: string, directory: string, label: string): void {
  const relative = Path.relative(rootDirectory, directory);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${Path.sep}`) ||
    Path.isAbsolute(relative)
  ) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${label} escapes its owning directory.`,
    );
  }
}

function requirePlainDirectory(directory: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(directory);
  } catch {
    throw new Error(
      `Bundled Codex compliance validation failed: missing ${label} at ${directory}.`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Bundled Codex compliance validation failed: ${label} must be a plain directory.`,
    );
  }
}

function requirePlainStageParentChain(stageAppDir: string): void {
  requirePlainDirectory(stageAppDir, "staged application directory");
  let current = stageAppDir;
  for (const segment of ["third-party-licenses", "openai-codex"]) {
    current = Path.join(current, segment);
    if (!FS.existsSync(current)) {
      FS.mkdirSync(current);
      continue;
    }
    requirePlainDirectory(current, `staged compliance parent ${segment}`);
  }
}

/**
 * `fs.cpSync` creates copied files with the process umask on macOS (our
 * release workers use a private umask, so readable compliance files can land
 * as 0600).  The compliance tree is intentionally portable and its root
 * commitment includes canonical POSIX modes; normalize the destination from
 * the already-validated source before validating it.
 */
function normalizeComplianceBundleModes(
  sourceDirectory: string,
  destinationDirectory: string,
): void {
  const sourceStat = FS.lstatSync(sourceDirectory);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Bundled Codex compliance staging source must be a plain directory.");
  }
  FS.chmodSync(destinationDirectory, 0o755);
  for (const entry of FS.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = Path.join(sourceDirectory, entry.name);
    const destinationPath = Path.join(destinationDirectory, entry.name);
    const entryStat = FS.lstatSync(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(
        `Bundled Codex compliance staging source contains a symbolic link at ${entry.name}.`,
      );
    }
    if (entryStat.isDirectory()) {
      normalizeComplianceBundleModes(sourcePath, destinationPath);
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(
        `Bundled Codex compliance staging source contains a special entry at ${entry.name}.`,
      );
    }
    FS.chmodSync(destinationPath, (entryStat.mode & 0o111) !== 0 ? 0o755 : 0o644);
  }
}

function resolvePlainComplianceDirectory(input: {
  readonly rootDirectory: string;
  readonly relativeDirectory: string;
  readonly label: string;
}): string {
  requirePlainDirectory(input.rootDirectory, `${input.label} root`);
  let current = input.rootDirectory;
  for (const segment of input.relativeDirectory.split(Path.sep)) {
    current = Path.join(current, segment);
    requirePlainDirectory(current, `${input.label} path segment ${segment}`);
  }
  return current;
}

export function validateRepositoryBundledCodexComplianceBundle(input: {
  readonly repoRoot: string;
  readonly expectedVersion: string;
}): BundledCodexComplianceValidation {
  assertBundledCodexComplianceVersion(input.expectedVersion);
  requirePlainDirectory(input.repoRoot, "repository root");
  const directory = resolvePlainComplianceDirectory({
    rootDirectory: input.repoRoot,
    relativeDirectory: BUNDLED_CODEX_COMPLIANCE_REPOSITORY_RELATIVE_DIRECTORY,
    label: "repository compliance bundle",
  });
  const validation = validateBundledCodexReleaseComplianceBundle({ directory });
  const realRepoRoot = FS.realpathSync(input.repoRoot);
  const realDirectory = FS.realpathSync(directory);
  assertContainedPath(realRepoRoot, realDirectory, "repository compliance bundle");
  return validation;
}

export function stageBundledCodexComplianceBundle(input: {
  readonly repoRoot: string;
  readonly stageAppDir: string;
  readonly expectedVersion: string;
}): BundledCodexComplianceValidation {
  const source = validateRepositoryBundledCodexComplianceBundle({
    repoRoot: input.repoRoot,
    expectedVersion: input.expectedVersion,
  });
  requirePlainStageParentChain(input.stageAppDir);
  const directory = Path.resolve(
    input.stageAppDir,
    BUNDLED_CODEX_COMPLIANCE_PACKAGE_RELATIVE_DIRECTORY,
  );
  assertContainedPath(Path.resolve(input.stageAppDir), directory, "staged compliance bundle");
  FS.rmSync(directory, { recursive: true, force: true });
  FS.cpSync(source.directory, directory, { recursive: true });
  normalizeComplianceBundleModes(source.directory, directory);
  return validateStagedBundledCodexComplianceBundle({
    stageAppDir: input.stageAppDir,
    expectedVersion: input.expectedVersion,
  });
}

export function validateStagedBundledCodexComplianceBundle(input: {
  readonly stageAppDir: string;
  readonly expectedVersion: string;
}): BundledCodexComplianceValidation {
  assertBundledCodexComplianceVersion(input.expectedVersion);
  return validateBundledCodexReleaseComplianceBundle({
    directory: resolvePlainComplianceDirectory({
      rootDirectory: input.stageAppDir,
      relativeDirectory: BUNDLED_CODEX_COMPLIANCE_PACKAGE_RELATIVE_DIRECTORY,
      label: "staged compliance bundle",
    }),
  });
}

export function validatePackagedBundledCodexComplianceBundle(input: {
  readonly resourcesDir: string;
  readonly expectedVersion: string;
}): BundledCodexComplianceValidation {
  assertBundledCodexComplianceVersion(input.expectedVersion);
  return validateBundledCodexReleaseComplianceBundle({
    directory: resolvePlainComplianceDirectory({
      rootDirectory: input.resourcesDir,
      relativeDirectory: BUNDLED_CODEX_COMPLIANCE_PACKAGE_RELATIVE_DIRECTORY,
      label: "packaged compliance bundle",
    }),
  });
}

export function resolveBundledCodexPayloadPackageRootCandidates(input: {
  readonly nodeModulesDir: string;
  readonly archiveId: string;
}): string[] {
  const packageLeaf = `codex-${input.archiveId}`;
  const mainPackageRoot = Path.join(input.nodeModulesDir, "@openai", "codex");
  let bunOptionalPackageRoot: string | null = null;
  try {
    bunOptionalPackageRoot = Path.join(Path.dirname(FS.realpathSync(mainPackageRoot)), packageLeaf);
  } catch {
    // Missing launcher package is reported with the complete candidate list below.
  }
  return [
    ...new Set([
      Path.join(input.nodeModulesDir, "@openai", packageLeaf),
      Path.join(mainPackageRoot, "node_modules", "@openai", packageLeaf),
      ...(bunOptionalPackageRoot ? [bunOptionalPackageRoot] : []),
    ]),
  ];
}

export function validateBundledCodexRuntimePayload(input: {
  readonly packageRoot: string;
  readonly archive: PayloadArchive;
}): void {
  let rootStat: FS.Stats;
  try {
    rootStat = FS.lstatSync(input.packageRoot);
  } catch {
    throw new Error(
      `Bundled Codex payload validation failed: missing package root for ${input.archive.id}.`,
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      `Bundled Codex payload validation failed: ${input.archive.id} package root must be a plain directory.`,
    );
  }
  const expectedPaths = input.archive.files.map((file) => file.path).toSorted(compareUtf8Bytes);
  const actualPaths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of FS.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = Path.join(directory, entry.name);
      if (directory === input.packageRoot && entry.name === "node_modules" && entry.isDirectory()) {
        continue;
      }
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        actualPaths.push(Path.relative(input.packageRoot, absolutePath).split(Path.sep).join("/"));
      } else {
        throw new Error(
          `Bundled Codex payload validation failed: non-plain entry ${absolutePath}.`,
        );
      }
    }
  };
  visit(input.packageRoot);
  actualPaths.sort(compareUtf8Bytes);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Bundled Codex payload validation failed: ${input.archive.id} file set does not match the registry tarball lock.`,
    );
  }
  for (const expected of input.archive.files) {
    const filePath = Path.join(input.packageRoot, expected.path);
    const stat = FS.statSync(filePath);
    if (stat.size !== expected.size || sha256File(filePath) !== expected.sha256) {
      throw new Error(
        `Bundled Codex payload validation failed: SHA-256/size mismatch for ${input.archive.id}/${expected.path}.`,
      );
    }
  }
}

export function validateCopiedBundledCodexRuntimePayload(input: {
  readonly resourcesDir: string;
  readonly targetTriple: string;
  readonly archive: PayloadArchive;
}): void {
  const copiedFiles = resolveCopiedBundledCodexPayloadFiles({
    targetTriple: input.targetTriple,
    archive: input.archive,
  });
  validateBundledCodexRuntimePayload({
    packageRoot: Path.join(input.resourcesDir, "codex-runtime", input.targetTriple),
    archive: { ...input.archive, files: copiedFiles },
  });
}

function resolveCopiedBundledCodexPayloadFiles(input: {
  readonly targetTriple: string;
  readonly archive: PayloadArchive;
}): PayloadFile[] {
  const vendorPrefix = `vendor/${input.targetTriple}/`;
  const copiedFiles = input.archive.files
    .filter((file) => file.path.startsWith(vendorPrefix))
    .map((file) => ({
      path: file.path.slice(vendorPrefix.length),
      size: file.size,
      sha256: file.sha256,
    }));
  if (copiedFiles.length === 0) {
    throw new Error(
      `Bundled Codex payload validation failed: ${input.archive.id} has no locked vendor payload for ${input.targetTriple}.`,
    );
  }
  return copiedFiles;
}

export function validateStagedBundledCodexPayloadIntegrity(
  input: {
    readonly complianceDirectory: string;
    readonly targetTriples: readonly string[];
  } & ({ readonly nodeModulesDir: string } | { readonly packagedResourcesDir: string }),
): void {
  const payloads = parsePayloads(input.complianceDirectory);
  validatePayloadDocument(payloads);
  const archives = new Map(payloads.archives.map((archive) => [archive.id, archive]));
  if ("nodeModulesDir" in input) {
    const launcher = archives.get("launcher");
    if (!launcher) {
      throw new Error("Bundled Codex payload validation failed: missing launcher lock.");
    }
    validateBundledCodexRuntimePayload({
      packageRoot: Path.join(input.nodeModulesDir, "@openai", "codex"),
      archive: launcher,
    });
  }
  for (const targetTriple of input.targetTriples) {
    const archiveId =
      TARGET_TRIPLE_TO_ARCHIVE[targetTriple as keyof typeof TARGET_TRIPLE_TO_ARCHIVE];
    if (!archiveId) {
      throw new Error(`Bundled Codex payload validation failed: unknown target ${targetTriple}.`);
    }
    const archive = archives.get(archiveId);
    if (!archive) {
      throw new Error(`Bundled Codex payload validation failed: missing lock for ${archiveId}.`);
    }
    if ("packagedResourcesDir" in input) {
      validateCopiedBundledCodexRuntimePayload({
        resourcesDir: input.packagedResourcesDir,
        targetTriple,
        archive,
      });
      continue;
    }
    const packageRoot = resolveBundledCodexPayloadPackageRootCandidates({
      nodeModulesDir: input.nodeModulesDir,
      archiveId,
    }).find((candidate) => FS.existsSync(candidate));
    if (!packageRoot) {
      throw new Error(`Bundled Codex payload validation failed: missing package ${archiveId}.`);
    }
    validateBundledCodexRuntimePayload({ packageRoot, archive });
  }
}

export interface BundledCodexCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface BundledCodexCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type BundledCodexCommandRunner = (
  input: BundledCodexCommandInput,
) => BundledCodexCommandResult;

function resolveWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim() || env.WINDIR?.trim() || "C:\\Windows";
  if (!Path.win32.isAbsolute(systemRoot)) {
    throw new Error("Bundled Codex Windows verification requires an absolute SystemRoot.");
  }
  return Path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runBundledCodexCommand(input: BundledCodexCommandInput): BundledCodexCommandResult {
  const result = spawnSync(input.command, [...input.args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...(input.env ? { env: input.env } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function commandForReport(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function runRequiredBundledCodexCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly label: string;
  readonly runCommand: BundledCodexCommandRunner;
}): { readonly command: string; readonly stdout: string; readonly stderr: string } {
  const result = input.runCommand({
    command: input.command,
    args: input.args,
    ...(input.env ? { env: input.env } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  const command = commandForReport(input.command, input.args);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Bundled Codex ${input.label} failed (${command}): ${result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`}`,
    );
  }
  return { command, stdout: result.stdout, stderr: result.stderr };
}

interface BundledCodexDigestTreeEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BundledCodexMachOIdentity {
  readonly architecture: "arm64" | "x86_64";
  readonly uuid: string;
}

function formatMachOUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inspectThinMachOIdentity(bytes: Buffer, label: string): BundledCodexMachOIdentity {
  const MACH_HEADER_64_SIZE = 32;
  const LC_UUID = 0x1b;
  if (bytes.length < MACH_HEADER_64_SIZE || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(
      `Bundled Codex Mach-O identity requires a little-endian thin 64-bit Mach-O for ${label}.`,
    );
  }
  const cpuType = bytes.readUInt32LE(4);
  const architecture =
    cpuType === 0x0100000c ? "arm64" : cpuType === 0x01000007 ? "x86_64" : undefined;
  if (!architecture) {
    throw new Error(
      `Bundled Codex Mach-O identity has unsupported CPU type 0x${cpuType.toString(16)} for ${label}.`,
    );
  }
  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  const commandsEnd = MACH_HEADER_64_SIZE + commandBytes;
  if (
    commandCount === 0 ||
    commandCount > 65_535 ||
    commandsEnd < MACH_HEADER_64_SIZE ||
    commandsEnd > bytes.length
  ) {
    throw new Error(`Bundled Codex Mach-O identity has invalid load commands for ${label}.`);
  }

  let cursor = MACH_HEADER_64_SIZE;
  let uuid: string | undefined;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandsEnd) {
      throw new Error(`Bundled Codex Mach-O identity has truncated commands for ${label}.`);
    }
    const command = bytes.readUInt32LE(cursor);
    const commandSize = bytes.readUInt32LE(cursor + 4);
    if (commandSize < 8 || cursor + commandSize > commandsEnd) {
      throw new Error(`Bundled Codex Mach-O identity has invalid command bounds for ${label}.`);
    }
    if (command === LC_UUID) {
      if (commandSize !== 24 || uuid) {
        throw new Error(
          `Bundled Codex Mach-O identity has invalid or duplicate UUID for ${label}.`,
        );
      }
      uuid = formatMachOUuid(bytes.subarray(cursor + 8, cursor + 24));
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd || !uuid) {
    throw new Error(`Bundled Codex Mach-O identity is missing a canonical UUID for ${label}.`);
  }
  return { architecture, uuid };
}

function digestBundledCodexFileTree(
  algorithm: string,
  entries: readonly BundledCodexDigestTreeEntry[],
): string {
  const hash = Crypto.createHash("sha256");
  hash.update(algorithm, "utf8");
  hash.update("\0", "utf8");
  const seenPaths = new Set<string>();
  for (const entry of entries.toSorted((left, right) => compareUtf8Bytes(left.path, right.path))) {
    if (seenPaths.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Bundled Codex signed payload tree contains invalid entry ${entry.path}.`);
    }
    seenPaths.add(entry.path);
    hash.update(String(Buffer.byteLength(entry.path, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(entry.size), "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha256, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

const WINDOWS_SIGNATURE_STRIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:MOSS_CODEX_SIGNATURE_STRIP_PATH",
  "if ([string]::IsNullOrWhiteSpace($path)) { throw 'Missing signature-strip path.' }",
  "$before = Get-AuthenticodeSignature -LiteralPath $path",
  "if ([string]$before.Status -ne 'NotSigned') {",
  "  $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)",
  "  if (-not [IO.Path]::IsPathFullyQualified($programFilesX86)) { throw 'Program Files (x86) is not absolute.' }",
  "  $kitsRoot = Join-Path $programFilesX86 'Windows Kits\\10\\bin'",
  "  $signtool = @(Get-ChildItem -Path (Join-Path $kitsRoot '*\\x64\\signtool.exe') -File -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName)[0]",
  "  if (-not $signtool -or -not [IO.Path]::IsPathFullyQualified($signtool) -or -not $signtool.StartsWith($kitsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'A trusted absolute Windows Kits signtool.exe was not found.' }",
  "  & $signtool remove /s $path",
  '  if ($LASTEXITCODE -ne 0) { throw "signtool remove failed with exit $LASTEXITCODE." }',
  "}",
  "$after = Get-AuthenticodeSignature -LiteralPath $path",
  "if ([string]$after.Status -ne 'NotSigned') { throw \"Signature removal did not produce NotSigned: $($after.Status).\" }",
].join("\n");

function canonicalizeSignedBundledCodexExecutable(input: {
  readonly snapshot: ImmutableFileSnapshot;
  readonly relativePath: string;
  readonly platform: "mac" | "win";
  readonly runCommand: BundledCodexCommandRunner;
  readonly commands: string[];
}): {
  readonly rawSize: number;
  readonly rawSha256: string;
  readonly canonicalBytes: Buffer;
} {
  const temporaryDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-signature-strip-"));
  FS.chmodSync(temporaryDirectory, 0o700);
  const temporaryPath = Path.join(
    temporaryDirectory,
    input.platform === "win" ? "payload.exe" : "payload",
  );
  try {
    const noFollow = FS.constants.O_NOFOLLOW ?? 0;
    const descriptor = FS.openSync(
      temporaryPath,
      FS.constants.O_WRONLY | FS.constants.O_CREAT | FS.constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      FS.writeFileSync(descriptor, input.snapshot.bytes);
      FS.fsyncSync(descriptor);
    } finally {
      FS.closeSync(descriptor);
    }
    const command =
      input.platform === "mac"
        ? runRequiredBundledCodexCommand({
            command: "/usr/bin/codesign",
            args: ["--remove-signature", temporaryPath],
            label: `signature removal for ${input.relativePath}`,
            runCommand: input.runCommand,
          })
        : runRequiredBundledCodexCommand({
            command: resolveWindowsPowerShellPath(),
            args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SIGNATURE_STRIP_SCRIPT],
            env: {
              ...process.env,
              MOSS_CODEX_SIGNATURE_STRIP_PATH: temporaryPath,
            },
            label: `signature removal for ${input.relativePath}`,
            runCommand: input.runCommand,
          });
    input.commands.push(command.command);
    const strippedSnapshot = openImmutableFileSnapshot(
      temporaryPath,
      `signature-stripped payload ${input.relativePath}`,
    );
    try {
      assertImmutableFileSnapshotCurrent(strippedSnapshot);
      return {
        rawSize: input.snapshot.size,
        rawSha256: input.snapshot.sha256,
        canonicalBytes:
          input.platform === "mac"
            ? normalizeSignatureStrippedMachO(strippedSnapshot.bytes, input.relativePath)
            : strippedSnapshot.bytes,
      };
    } finally {
      closeImmutableFileSnapshot(strippedSnapshot);
    }
  } finally {
    FS.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export interface BundledCodexSignedPayloadFileReceipt {
  readonly path: string;
  readonly signedExecutable: boolean;
  readonly sourceSize: number;
  readonly sourceSha256: string;
  readonly finalSize: number;
  readonly finalSha256: string;
  readonly canonicalSize: number;
  readonly canonicalSha256: string;
  readonly machO?: BundledCodexMachOIdentity;
}

export interface BundledCodexSignedRuntimePayloadReceipt {
  readonly archiveId: PayloadArchive["id"];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly finalTreeSha256: string;
  readonly canonicalContentTreeSha256: string;
  readonly files: readonly BundledCodexSignedPayloadFileReceipt[];
  readonly commands: readonly string[];
}

export function validateSignedBundledCodexRuntimePayload(input: {
  readonly sourcePackageRoot: string;
  readonly finalPackageRoot: string;
  readonly archive: PayloadArchive;
  readonly signedExecutableRelativePaths: readonly string[];
  readonly platform: "mac" | "win";
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexSignedRuntimePayloadReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const requiredHost = input.platform === "mac" ? "darwin" : "win32";
  if (hostPlatform !== requiredHost) {
    throw new Error(
      `Bundled Codex signed payload verification for ${input.platform} requires a ${requiredHost} host, found ${hostPlatform}.`,
    );
  }
  const expectedPaths = input.archive.files.map((file) => file.path).toSorted(compareUtf8Bytes);
  if (new Set(expectedPaths).size !== expectedPaths.length) {
    throw new Error(
      `Bundled Codex signed payload validation found duplicate locked paths for ${input.archive.id}.`,
    );
  }
  for (const relativePath of expectedPaths) validatePortableCompliancePath(relativePath);
  const signedExecutablePaths = [...input.signedExecutableRelativePaths].toSorted(compareUtf8Bytes);
  if (
    signedExecutablePaths.length === 0 ||
    new Set(signedExecutablePaths).size !== signedExecutablePaths.length ||
    signedExecutablePaths.some((relativePath) => !expectedPaths.includes(relativePath))
  ) {
    throw new Error(
      `Bundled Codex signed payload validation has an invalid signed executable set for ${input.archive.id}.`,
    );
  }
  const signedExecutableSet = new Set(signedExecutablePaths);
  const sourcePaths = listPlainRelativeFiles(
    input.sourcePackageRoot,
    `signed payload source ${input.archive.id}`,
  );
  const finalPaths = listPlainRelativeFiles(
    input.finalPackageRoot,
    `signed payload final ${input.archive.id}`,
  );
  if (JSON.stringify(sourcePaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Bundled Codex signed payload source inventory mismatch for ${input.archive.id}.`,
    );
  }
  if (JSON.stringify(finalPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Bundled Codex signed payload final inventory mismatch for ${input.archive.id}.`,
    );
  }

  const sourceSnapshots = new Map<string, ImmutableFileSnapshot>();
  const finalSnapshots = new Map<string, ImmutableFileSnapshot>();
  try {
    for (const relativePath of expectedPaths) {
      sourceSnapshots.set(
        relativePath,
        openImmutableFileSnapshot(
          Path.join(input.sourcePackageRoot, relativePath),
          `${input.archive.id}/${relativePath} source`,
        ),
      );
      finalSnapshots.set(
        relativePath,
        openImmutableFileSnapshot(
          Path.join(input.finalPackageRoot, relativePath),
          `${input.archive.id}/${relativePath} final`,
        ),
      );
    }

    const runCommand = input.runCommand ?? runBundledCodexCommand;
    const commands: string[] = [];
    const files: BundledCodexSignedPayloadFileReceipt[] = [];
    for (const expected of input.archive.files.toSorted((left, right) =>
      compareUtf8Bytes(left.path, right.path),
    )) {
      const sourceSnapshot = sourceSnapshots.get(expected.path);
      const finalSnapshot = finalSnapshots.get(expected.path);
      if (!sourceSnapshot || !finalSnapshot) {
        throw new Error(
          `Bundled Codex signed payload immutable snapshot is missing ${input.archive.id}/${expected.path}.`,
        );
      }
      const signedExecutable = signedExecutableSet.has(expected.path);
      let sourceSize: number;
      let sourceSha256: string;
      let finalSize: number;
      let finalSha256: string;
      let canonicalSize: number;
      let canonicalSha256: string;
      let machO: BundledCodexMachOIdentity | undefined;
      if (signedExecutable) {
        if (input.platform === "mac") {
          const sourceIdentity = inspectThinMachOIdentity(
            sourceSnapshot.bytes,
            `${input.archive.id}/${expected.path} source`,
          );
          const finalIdentity = inspectThinMachOIdentity(
            finalSnapshot.bytes,
            `${input.archive.id}/${expected.path} final`,
          );
          const expectedArchitecture = input.archive.id === "darwin-x64" ? "x86_64" : "arm64";
          if (
            sourceIdentity.architecture !== expectedArchitecture ||
            finalIdentity.architecture !== expectedArchitecture
          ) {
            throw new Error(
              `Bundled Codex Mach-O architecture mismatch for ${input.archive.id}/${expected.path}: expected ${expectedArchitecture}, source ${sourceIdentity.architecture}, final ${finalIdentity.architecture}.`,
            );
          }
          if (sourceIdentity.uuid !== finalIdentity.uuid) {
            throw new Error(
              `Bundled Codex Mach-O UUID mismatch for ${input.archive.id}/${expected.path}: source ${sourceIdentity.uuid}, final ${finalIdentity.uuid}.`,
            );
          }
          machO = finalIdentity;
        }
        const sourceCanonicalSnapshot = canonicalizeSignedBundledCodexExecutable({
          snapshot: sourceSnapshot,
          relativePath: `${input.archive.id}/${expected.path} source`,
          platform: input.platform,
          runCommand,
          commands,
        });
        const finalCanonicalSnapshot = canonicalizeSignedBundledCodexExecutable({
          snapshot: finalSnapshot,
          relativePath: `${input.archive.id}/${expected.path} final`,
          platform: input.platform,
          runCommand,
          commands,
        });
        sourceSize = sourceCanonicalSnapshot.rawSize;
        sourceSha256 = sourceCanonicalSnapshot.rawSha256;
        finalSize = finalCanonicalSnapshot.rawSize;
        finalSha256 = finalCanonicalSnapshot.rawSha256;
        if (sourceSize !== expected.size || sourceSha256 !== expected.sha256) {
          throw new Error(
            `Bundled Codex signed payload source SHA-256/size mismatch for ${input.archive.id}/${expected.path}.`,
          );
        }
        const sourceCanonicalSha256 = Crypto.createHash("sha256")
          .update(sourceCanonicalSnapshot.canonicalBytes)
          .digest("hex");
        canonicalSize = finalCanonicalSnapshot.canonicalBytes.length;
        canonicalSha256 = Crypto.createHash("sha256")
          .update(finalCanonicalSnapshot.canonicalBytes)
          .digest("hex");
        if (
          sourceCanonicalSnapshot.canonicalBytes.length !==
            finalCanonicalSnapshot.canonicalBytes.length ||
          sourceCanonicalSha256 !== canonicalSha256
        ) {
          throw new Error(
            `Bundled Codex signature-stripped content mismatch for ${input.archive.id}/${expected.path}.`,
          );
        }
      } else {
        sourceSize = sourceSnapshot.size;
        sourceSha256 = sourceSnapshot.sha256;
        if (sourceSize !== expected.size || sourceSha256 !== expected.sha256) {
          throw new Error(
            `Bundled Codex signed payload source SHA-256/size mismatch for ${input.archive.id}/${expected.path}.`,
          );
        }
        finalSize = finalSnapshot.size;
        finalSha256 = finalSnapshot.sha256;
        canonicalSize = finalSize;
        canonicalSha256 = finalSha256;
        if (finalSize !== expected.size || finalSha256 !== expected.sha256) {
          throw new Error(
            `Bundled Codex signed payload unsigned file ${input.archive.id}/${expected.path} SHA-256/size mismatch.`,
          );
        }
      }
      files.push({
        path: expected.path,
        signedExecutable,
        sourceSize,
        sourceSha256,
        finalSize,
        finalSha256,
        canonicalSize,
        canonicalSha256,
        ...(machO ? { machO } : {}),
      });
    }
    for (const snapshot of [...sourceSnapshots.values(), ...finalSnapshots.values()]) {
      assertImmutableFileSnapshotCurrent(snapshot);
    }
    if (
      JSON.stringify(
        listPlainRelativeFiles(
          input.sourcePackageRoot,
          `signed payload source ${input.archive.id}`,
        ),
      ) !== JSON.stringify(expectedPaths) ||
      JSON.stringify(
        listPlainRelativeFiles(input.finalPackageRoot, `signed payload final ${input.archive.id}`),
      ) !== JSON.stringify(expectedPaths)
    ) {
      throw new Error(
        `Bundled Codex signed payload inventory changed while verification was in progress for ${input.archive.id}.`,
      );
    }
    return {
      archiveId: input.archive.id,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.finalSize, 0),
      finalTreeSha256: digestBundledCodexFileTree(
        "moss-bundled-codex-signed-final-tree-v1",
        files.map((file) => ({
          path: file.path,
          size: file.finalSize,
          sha256: file.finalSha256,
        })),
      ),
      canonicalContentTreeSha256: digestBundledCodexFileTree(
        "moss-bundled-codex-signed-canonical-tree-v1",
        files.map((file) => ({
          path: file.path,
          size: file.canonicalSize,
          sha256: file.canonicalSha256,
        })),
      ),
      files,
      commands,
    };
  } finally {
    for (const snapshot of [...sourceSnapshots.values(), ...finalSnapshots.values()]) {
      closeImmutableFileSnapshot(snapshot);
    }
  }
}

export interface BundledCodexSignedPayloadIntegrityReceipt {
  readonly platform: "mac" | "win";
  readonly targetReceipts: readonly (BundledCodexSignedRuntimePayloadReceipt & {
    readonly targetTriple: string;
  })[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly finalTreeSha256: string;
  readonly canonicalContentTreeSha256: string;
  readonly commands: readonly string[];
}

export function validateSignedBundledCodexPayloadIntegrity(input: {
  readonly sourceResourcesDir: string;
  readonly finalResourcesDir: string;
  readonly complianceDirectory: string;
  readonly targetTriples: readonly string[];
  readonly platform: "mac" | "win";
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexSignedPayloadIntegrityReceipt {
  const payloads = parsePayloads(input.complianceDirectory);
  validatePayloadDocument(payloads);
  const archives = new Map(payloads.archives.map((archive) => [archive.id, archive]));
  const targetTriples = [...input.targetTriples].toSorted(compareUtf8Bytes);
  if (targetTriples.length === 0 || new Set(targetTriples).size !== targetTriples.length) {
    throw new Error("Bundled Codex signed payload validation requires unique target triples.");
  }
  const targetReceipts = targetTriples.map((targetTriple) => {
    const archiveId =
      TARGET_TRIPLE_TO_ARCHIVE[targetTriple as keyof typeof TARGET_TRIPLE_TO_ARCHIVE];
    const expectedArchivePrefix = input.platform === "mac" ? "darwin-" : "win32-";
    if (!archiveId?.startsWith(expectedArchivePrefix)) {
      throw new Error(
        `Bundled Codex signed payload validation received invalid ${input.platform} target ${targetTriple}.`,
      );
    }
    const archive = archives.get(archiveId);
    if (!archive) {
      throw new Error(`Bundled Codex signed payload validation is missing lock ${archiveId}.`);
    }
    const copiedArchive = {
      ...archive,
      files: resolveCopiedBundledCodexPayloadFiles({ targetTriple, archive }),
    } satisfies PayloadArchive;
    const receipt = validateSignedBundledCodexRuntimePayload({
      sourcePackageRoot: Path.join(input.sourceResourcesDir, "codex-runtime", targetTriple),
      finalPackageRoot: Path.join(input.finalResourcesDir, "codex-runtime", targetTriple),
      archive: copiedArchive,
      signedExecutableRelativePaths: resolveResealedBundledCodexPayloadPaths({
        archiveId,
        files: copiedArchive.files,
        platform: input.platform,
      }),
      platform: input.platform,
      ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
      ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    });
    return {
      targetTriple,
      archiveId: receipt.archiveId,
      fileCount: receipt.fileCount,
      totalBytes: receipt.totalBytes,
      finalTreeSha256: receipt.finalTreeSha256,
      canonicalContentTreeSha256: receipt.canonicalContentTreeSha256,
      files: receipt.files,
      commands: receipt.commands,
    };
  });
  const aggregateFiles = targetReceipts.flatMap((target) =>
    target.files.map((file) => ({
      path: `codex-runtime/${target.targetTriple}/${file.path}`,
      finalSize: file.finalSize,
      finalSha256: file.finalSha256,
      canonicalSize: file.canonicalSize,
      canonicalSha256: file.canonicalSha256,
    })),
  );
  return {
    platform: input.platform,
    targetReceipts,
    fileCount: aggregateFiles.length,
    totalBytes: aggregateFiles.reduce((total, file) => total + file.finalSize, 0),
    finalTreeSha256: digestBundledCodexFileTree(
      "moss-bundled-codex-signed-final-tree-v1",
      aggregateFiles.map((file) => ({
        path: file.path,
        size: file.finalSize,
        sha256: file.finalSha256,
      })),
    ),
    canonicalContentTreeSha256: digestBundledCodexFileTree(
      "moss-bundled-codex-signed-canonical-tree-v1",
      aggregateFiles.map((file) => ({
        path: file.path,
        size: file.canonicalSize,
        sha256: file.canonicalSha256,
      })),
    ),
    commands: targetReceipts.flatMap((target) => target.commands),
  };
}

export function shouldRunBundledCodexLinuxPublicRuntimeProbes(input: {
  readonly platform: "linux" | "mac" | "win";
  readonly arch: "arm64" | "x64" | "universal";
  readonly releaseMode: "build-only" | "publish";
  readonly signed: boolean;
}): boolean {
  if (input.platform !== "linux") return false;
  if (input.signed) {
    throw new Error(
      "Bundled Codex Linux artifacts do not support --signed; Linux always uses exact final payload hashes.",
    );
  }
  if (input.releaseMode !== "publish") return false;
  if (input.arch !== "x64") {
    throw new Error(
      `Public Linux bundled Codex releases support only x64, not ${input.arch}; arm64 remains an internal build-only lane.`,
    );
  }
  return true;
}

const LINUX_PUBLIC_TARGET_TRIPLE = "x86_64-unknown-linux-musl";
const LINUX_PUBLIC_EXECUTABLES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/bwrap",
  "codex-resources/voice/bin/codex-voice-host",
] as const;
const LINUX_PUBLIC_SHARED_LIBRARIES = [
  "libc.so.6",
  "libdl.so.2",
  "libgio-2.0.so.0",
  "libglib-2.0.so.0",
  "libgobject-2.0.so.0",
  "libgstapp-1.0.so.0",
  "libgstaudio-1.0.so.0",
  "libgstbase-1.0.so.0",
  "libgstreamer-1.0.so.0",
  "libm.so.6",
  "libopus.so.0",
  "libpthread.so.0",
  "librt.so.1",
] as const;

function compareVersionParts(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export interface BundledCodexLinuxPublicRuntimeReceipt {
  readonly targetTriple: typeof LINUX_PUBLIC_TARGET_TRIPLE;
  readonly commands: readonly string[];
  readonly maximumGlibcVersion: string;
  readonly neededLibraries: readonly string[];
  readonly resolvedLibraries: readonly string[];
}

export interface BundledCodexMacArtifactContainerLifecycleReceipt {
  readonly artifacts: readonly {
    readonly kind: "dmg" | "zip";
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
    readonly installedClosure: unknown;
  }[];
}

function validateArtifactFileName(
  fileName: string,
  expectedExtension: ".AppImage" | ".dmg" | ".zip" | ".exe",
): string {
  if (
    fileName !== fileName.trim() ||
    Path.basename(fileName) !== fileName ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    !fileName.toLowerCase().endsWith(expectedExtension.toLowerCase())
  ) {
    throw new Error(`Bundled Codex final artifact has invalid file name ${fileName}.`);
  }
  return fileName;
}

function resolveOnlyTopLevelAppBundle(directory: string, label: string): string {
  requirePlainDirectory(directory, label);
  const appEntries = FS.readdirSync(directory, { withFileTypes: true }).filter((entry) =>
    entry.name.toLowerCase().endsWith(".app"),
  );
  if (appEntries.length !== 1 || !appEntries[0]!.isDirectory()) {
    throw new Error(`Bundled Codex ${label} must contain exactly one top-level plain .app bundle.`);
  }
  const appBundlePath = Path.join(directory, appEntries[0]!.name);
  const stat = FS.lstatSync(appBundlePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Bundled Codex ${label} .app bundle must be a plain directory.`);
  }
  return appBundlePath;
}

export function verifyBundledCodexMacArtifactContainerLifecycle(input: {
  readonly stageDistDir: string;
  readonly dmgFileName?: string;
  readonly zipFileName?: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
  readonly validateAppBundle: (input: {
    readonly artifactKind: "dmg" | "zip";
    readonly appBundlePath: string;
  }) => unknown;
}): BundledCodexMacArtifactContainerLifecycleReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "darwin") {
    throw new Error(
      `Bundled Codex final macOS artifact verification requires a macOS host, found ${hostPlatform}.`,
    );
  }
  requirePlainDirectory(input.stageDistDir, "final macOS artifact directory");
  const requested = [
    ...(input.dmgFileName
      ? [
          {
            kind: "dmg" as const,
            fileName: validateArtifactFileName(input.dmgFileName, ".dmg"),
          },
        ]
      : []),
    ...(input.zipFileName
      ? [
          {
            kind: "zip" as const,
            fileName: validateArtifactFileName(input.zipFileName, ".zip"),
          },
        ]
      : []),
  ].toSorted((left, right) => compareUtf8Bytes(left.kind, right.kind));
  if (requested.length === 0) {
    throw new Error("Bundled Codex final macOS verification requires a DMG and/or ZIP artifact.");
  }
  for (const extension of [".dmg", ".zip"] as const) {
    const expected = requested.filter((artifact) => artifact.fileName.endsWith(extension));
    if (expected.length === 0) continue;
    const actual = FS.readdirSync(input.stageDistDir, { withFileTypes: true })
      .filter((entry) => entry.name.toLowerCase().endsWith(extension))
      .map((entry) => {
        if (!entry.isFile()) {
          throw new Error(`Bundled Codex final macOS artifact ${entry.name} must be a plain file.`);
        }
        return entry.name;
      })
      .toSorted(compareUtf8Bytes);
    if (JSON.stringify(actual) !== JSON.stringify(expected.map((artifact) => artifact.fileName))) {
      throw new Error(
        `Bundled Codex final macOS ${extension} inventory does not match the expected artifact.`,
      );
    }
  }

  const snapshots = new Map<"dmg" | "zip", ImmutableFileDigest>();
  const privateSnapshots = new Map<"dmg" | "zip", ImmutableFileDigest>();
  const mountSnapshots = new Map<"dmg" | "zip", ImmutableFileDigest>();
  const temporaryRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-final-mac-artifacts-"));
  FS.chmodSync(temporaryRoot, 0o700);
  const runCommand = input.runCommand ?? runBundledCodexCommand;
  try {
    for (const artifact of requested) {
      snapshots.set(
        artifact.kind,
        openImmutableFileDigest(
          Path.join(input.stageDistDir, artifact.fileName),
          `final macOS ${artifact.kind} ${artifact.fileName}`,
        ),
      );
    }
    for (const artifact of requested) {
      privateSnapshots.set(
        artifact.kind,
        copyDigestNoReplace({
          source: snapshots.get(artifact.kind)!,
          outputDirectory: temporaryRoot,
          targetPath: Path.join(temporaryRoot, `immutable-${artifact.kind}.${artifact.kind}`),
        }),
      );
      mountSnapshots.set(
        artifact.kind,
        copyDigestNoReplace({
          source: privateSnapshots.get(artifact.kind)!,
          outputDirectory: temporaryRoot,
          targetPath: Path.join(temporaryRoot, `mount-${artifact.kind}.${artifact.kind}`),
        }),
      );
    }
    const artifacts: BundledCodexMacArtifactContainerLifecycleReceipt["artifacts"][number][] = [];
    for (const artifact of requested) {
      const snapshot = snapshots.get(artifact.kind)!;
      const privateSnapshot = privateSnapshots.get(artifact.kind)!;
      const mountSnapshot = mountSnapshots.get(artifact.kind)!;
      let appBundlePath: string;
      if (artifact.kind === "zip") {
        const extractDirectory = Path.join(temporaryRoot, "zip-extracted");
        FS.mkdirSync(extractDirectory, { mode: 0o700 });
        runRequiredBundledCodexCommand({
          command: "/usr/bin/ditto",
          args: ["-x", "-k", "--rsrc", mountSnapshot.filePath, extractDirectory],
          label: "final ZIP extraction",
          runCommand,
        });
        appBundlePath = resolveOnlyTopLevelAppBundle(
          extractDirectory,
          "final ZIP extraction directory",
        );
      } else {
        const mountPoint = Path.join(temporaryRoot, "dmg-mounted");
        FS.mkdirSync(mountPoint, { mode: 0o700 });
        runRequiredBundledCodexCommand({
          command: "/usr/bin/hdiutil",
          args: [
            "attach",
            "-readonly",
            "-nobrowse",
            "-mountpoint",
            mountPoint,
            mountSnapshot.filePath,
          ],
          label: "final DMG mount",
          runCommand,
        });
        try {
          appBundlePath = resolveOnlyTopLevelAppBundle(mountPoint, "final DMG mount point");
          const installedClosure = input.validateAppBundle({
            artifactKind: artifact.kind,
            appBundlePath,
          });
          assertImmutableFileDigestCurrent(snapshot);
          assertImmutableFileDigestCurrent(privateSnapshot);
          assertImmutableFileDigestContentCurrent(mountSnapshot);
          artifacts.push({
            kind: artifact.kind,
            fileName: artifact.fileName,
            size: snapshot.size,
            sha256: snapshot.sha256,
            installedClosure,
          });
        } finally {
          runRequiredBundledCodexCommand({
            command: "/usr/bin/hdiutil",
            args: ["detach", mountPoint],
            label: "final DMG unmount",
            runCommand,
          });
        }
        continue;
      }
      const installedClosure = input.validateAppBundle({
        artifactKind: artifact.kind,
        appBundlePath,
      });
      assertImmutableFileDigestCurrent(snapshot);
      assertImmutableFileDigestCurrent(privateSnapshot);
      assertImmutableFileDigestContentCurrent(mountSnapshot);
      artifacts.push({
        kind: artifact.kind,
        fileName: artifact.fileName,
        size: snapshot.size,
        sha256: snapshot.sha256,
        installedClosure,
      });
    }
    for (const snapshot of snapshots.values()) assertImmutableFileDigestCurrent(snapshot);
    for (const snapshot of privateSnapshots.values()) assertImmutableFileDigestCurrent(snapshot);
    for (const snapshot of mountSnapshots.values()) {
      assertImmutableFileDigestContentCurrent(snapshot);
    }
    return { artifacts };
  } finally {
    for (const snapshot of mountSnapshots.values()) closeImmutableFileDigest(snapshot);
    for (const snapshot of privateSnapshots.values()) closeImmutableFileDigest(snapshot);
    for (const snapshot of snapshots.values()) closeImmutableFileDigest(snapshot);
    FS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export interface BundledCodexLinuxAppImageContainerLifecycleReceipt {
  readonly appImageFileName: string;
  readonly appImageSize: number;
  readonly appImageSha256: string;
  readonly container: {
    readonly format: "AppImage-type-2";
    readonly elfClass: "ELF64";
    readonly machine: "x86_64";
    readonly squashfsVersion: "4.0";
    readonly squashfsOffset: number;
    readonly squashfsBytesUsed: number;
    readonly extractor: typeof BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID;
    readonly validated: true;
  };
  readonly extractedClosure: unknown;
  readonly extractionValidated: true;
}

interface BundledCodexAppImageContainerDescriptor {
  readonly squashfsOffset: number;
  readonly squashfsBytesUsed: number;
}

const APPIMAGE_ELF_HEADER_BYTES = 64;
const SQUASHFS_SUPERBLOCK_BYTES = 96;
const SQUASHFS_MAGIC = Buffer.from("hsqs", "ascii");
const SQUASHFS_IMAGE_ALIGNMENT = 4_096;
const SQUASHFS_SCAN_CHUNK_BYTES = 1024 * 1024;
const SQUASHFS_INVALID_TABLE_OFFSET = 0xffff_ffff_ffff_ffffn;

function assertLinuxX64Elf64Header(digest: ImmutableFileDigest, label: string): Buffer {
  if (digest.size < APPIMAGE_ELF_HEADER_BYTES) {
    throw new Error(`Bundled Codex ${label} is too small to contain an ELF64 header.`);
  }
  const header = readImmutableDigestRange(digest, 0, APPIMAGE_ELF_HEADER_BYTES);
  if (
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[6] !== 1
  ) {
    throw new Error(`Bundled Codex ${label} must have a little-endian ELF64 header.`);
  }
  const elfType = header.readUInt16LE(16);
  if ((elfType !== 2 && elfType !== 3) || header.readUInt16LE(18) !== 62) {
    throw new Error(`Bundled Codex ${label} must be an x86_64 ELF executable.`);
  }
  if (header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== APPIMAGE_ELF_HEADER_BYTES) {
    throw new Error(`Bundled Codex ${label} has an invalid ELF64 header layout.`);
  }
  return header;
}

function readImmutableDigestRange(
  digest: ImmutableFileDigest,
  offset: number,
  length: number,
): Buffer {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > digest.size
  ) {
    throw new Error(`Bundled Codex immutable digest range is invalid for ${digest.label}.`);
  }
  const bytes = Buffer.alloc(length);
  let readOffset = 0;
  while (readOffset < length) {
    const read = FS.readSync(
      digest.descriptor,
      bytes,
      readOffset,
      length - readOffset,
      offset + readOffset,
    );
    if (read === 0) {
      throw new Error(
        `Bundled Codex immutable digest reached an unexpected end of file for ${digest.label}.`,
      );
    }
    readOffset += read;
  }
  return bytes;
}

function assertLinuxX64AppImageType2Header(digest: ImmutableFileDigest): void {
  if (digest.size < APPIMAGE_ELF_HEADER_BYTES + SQUASHFS_SUPERBLOCK_BYTES) {
    throw new Error("Bundled Codex final AppImage is too small to contain a type-2 container.");
  }
  const header = assertLinuxX64Elf64Header(digest, "final AppImage");
  if (header[8] !== 0x41 || header[9] !== 0x49 || header[10] !== 2) {
    throw new Error("Bundled Codex final AppImage must have the AppImage type-2 marker.");
  }
}

function squashfsTableOffsetIsValid(value: bigint, bytesUsed: bigint): boolean {
  return value === SQUASHFS_INVALID_TABLE_OFFSET || (value >= 96n && value < bytesUsed);
}

function parseSquashfsSuperblock(
  digest: ImmutableFileDigest,
  offset: number,
): BundledCodexAppImageContainerDescriptor | null {
  if (offset < APPIMAGE_ELF_HEADER_BYTES || offset + SQUASHFS_SUPERBLOCK_BYTES > digest.size) {
    return null;
  }
  const superblock = readImmutableDigestRange(digest, offset, SQUASHFS_SUPERBLOCK_BYTES);
  if (!superblock.subarray(0, SQUASHFS_MAGIC.length).equals(SQUASHFS_MAGIC)) return null;
  const inodeCount = superblock.readUInt32LE(4);
  const blockSize = superblock.readUInt32LE(12);
  const compression = superblock.readUInt16LE(20);
  const blockLog = superblock.readUInt16LE(22);
  const idCount = superblock.readUInt16LE(26);
  const major = superblock.readUInt16LE(28);
  const minor = superblock.readUInt16LE(30);
  const bytesUsed = superblock.readBigUInt64LE(40);
  if (
    inodeCount === 0 ||
    idCount === 0 ||
    blockSize < 4_096 ||
    blockSize > 1024 * 1024 ||
    (blockSize & (blockSize - 1)) !== 0 ||
    blockLog !== Math.log2(blockSize) ||
    compression < 1 ||
    compression > 6 ||
    major !== 4 ||
    minor !== 0 ||
    bytesUsed < BigInt(SQUASHFS_SUPERBLOCK_BYTES) ||
    bytesUsed > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  // Linux fs/squashfs/squashfs_fs.h defines these six on-disk u64 fields in
  // this exact order after bytes_used.
  const idTableStart = superblock.readBigUInt64LE(48);
  const xattrTableStart = superblock.readBigUInt64LE(56);
  const inodeTableStart = superblock.readBigUInt64LE(64);
  const directoryTableStart = superblock.readBigUInt64LE(72);
  const fragmentTableStart = superblock.readBigUInt64LE(80);
  const exportTableStart = superblock.readBigUInt64LE(88);
  if (
    inodeTableStart < 96n ||
    inodeTableStart >= bytesUsed ||
    directoryTableStart < 96n ||
    directoryTableStart >= bytesUsed ||
    idTableStart < 96n ||
    idTableStart >= bytesUsed ||
    !squashfsTableOffsetIsValid(fragmentTableStart, bytesUsed) ||
    !squashfsTableOffsetIsValid(exportTableStart, bytesUsed) ||
    !squashfsTableOffsetIsValid(xattrTableStart, bytesUsed)
  ) {
    return null;
  }
  const squashfsBytesUsed = Number(bytesUsed);
  const containerBytes = digest.size - offset;
  const paddedBytes =
    Math.ceil(squashfsBytesUsed / SQUASHFS_IMAGE_ALIGNMENT) * SQUASHFS_IMAGE_ALIGNMENT;
  if (containerBytes !== squashfsBytesUsed && containerBytes !== paddedBytes) return null;
  const paddingBytes = containerBytes - squashfsBytesUsed;
  if (paddingBytes > 0) {
    const padding = readImmutableDigestRange(digest, offset + squashfsBytesUsed, paddingBytes);
    if (padding.some((byte) => byte !== 0)) return null;
  }
  return { squashfsOffset: offset, squashfsBytesUsed };
}

function inspectLinuxX64AppImageType2(
  digest: ImmutableFileDigest,
): BundledCodexAppImageContainerDescriptor {
  assertLinuxX64AppImageType2Header(digest);
  const validSuperblocks = new Map<number, BundledCodexAppImageContainerDescriptor>();
  const stride = SQUASHFS_SCAN_CHUNK_BYTES - (SQUASHFS_MAGIC.length - 1);
  for (
    let chunkOffset = APPIMAGE_ELF_HEADER_BYTES;
    chunkOffset < digest.size;
    chunkOffset += stride
  ) {
    const chunk = readImmutableDigestRange(
      digest,
      chunkOffset,
      Math.min(SQUASHFS_SCAN_CHUNK_BYTES, digest.size - chunkOffset),
    );
    let searchOffset = 0;
    while (searchOffset <= chunk.length - SQUASHFS_MAGIC.length) {
      const index = chunk.indexOf(SQUASHFS_MAGIC, searchOffset);
      if (index < 0) break;
      const squashfsOffset = chunkOffset + index;
      if (!validSuperblocks.has(squashfsOffset)) {
        const descriptor = parseSquashfsSuperblock(digest, squashfsOffset);
        if (descriptor) validSuperblocks.set(squashfsOffset, descriptor);
      }
      searchOffset = index + 1;
    }
  }
  if (validSuperblocks.size !== 1) {
    throw new Error(
      `Bundled Codex final AppImage must contain exactly one unambiguous SquashFS v4 filesystem, found ${validSuperblocks.size}.`,
    );
  }
  return [...validSuperblocks.values()][0]!;
}

/** Static container inspection does not execute, extract, or establish release eligibility. */
export function inspectBundledCodexLinuxAppImageContainer(
  filePath: string,
): BundledCodexAppImageContainerDescriptor {
  const digest = openImmutableFileDigest(filePath, "AppImage static container inspection");
  try {
    const descriptor = inspectLinuxX64AppImageType2(digest);
    assertImmutableFileDigestContentCurrent(digest);
    return descriptor;
  } finally {
    closeImmutableFileDigest(digest);
  }
}

function openTrustedUnsquashfsDigest(): ImmutableFileDigest {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH);
  } catch {
    throw new Error(
      `Bundled Codex final AppImage verification requires trusted ${BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH}.`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(
      `Bundled Codex final AppImage extractor ${BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH} must be a root-owned, non-writable plain file.`,
    );
  }
  try {
    FS.accessSync(BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH, FS.constants.X_OK);
  } catch {
    throw new Error(
      `Bundled Codex final AppImage extractor ${BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH} is not executable.`,
    );
  }
  return openImmutableFileDigest(
    BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH,
    "trusted AppImage unsquashfs extractor",
  );
}

export function verifyBundledCodexLinuxAppImageContainerLifecycle(input: {
  readonly stageDistDir: string;
  readonly appImageFileName: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly runCommand?: BundledCodexCommandRunner;
  readonly validateExtractedApplication: (input: {
    readonly appDir: string;
    readonly privateAppImagePath: string;
  }) => unknown;
}): BundledCodexLinuxAppImageContainerLifecycleReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const hostArch = input.hostArch ?? process.arch;
  if (hostPlatform !== "linux" || hostArch !== "x64") {
    throw new Error(
      `Bundled Codex final AppImage verification requires a native linux/x64 host, found ${hostPlatform}/${hostArch}.`,
    );
  }
  requirePlainDirectory(input.stageDistDir, "final Linux artifact directory");
  const appImageFileName = validateArtifactFileName(input.appImageFileName, ".AppImage");
  const appImageNames = FS.readdirSync(input.stageDistDir, {
    withFileTypes: true,
  })
    .filter((entry) => entry.name.toLowerCase().endsWith(".appimage"))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(`Bundled Codex final AppImage ${entry.name} must be a plain file.`);
      }
      return entry.name;
    })
    .toSorted(compareUtf8Bytes);
  if (JSON.stringify(appImageNames) !== JSON.stringify([appImageFileName])) {
    throw new Error("Bundled Codex final AppImage inventory does not match the expected artifact.");
  }
  const sourceSnapshot = openImmutableFileDigest(
    Path.join(input.stageDistDir, appImageFileName),
    `final AppImage ${appImageFileName}`,
  );
  if ((sourceSnapshot.identity.mode & 0o111n) === 0n) {
    closeImmutableFileDigest(sourceSnapshot);
    throw new Error("Bundled Codex final AppImage candidate is not executable.");
  }
  const temporaryRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-final-appimage-"));
  FS.chmodSync(temporaryRoot, 0o700);
  const appDir = Path.join(temporaryRoot, "squashfs-root");
  let privateSnapshot: ImmutableFileDigest | undefined;
  let trustedUnsquashfs: ImmutableFileDigest | undefined;
  try {
    privateSnapshot = copyDigestNoReplace({
      source: sourceSnapshot,
      outputDirectory: temporaryRoot,
      targetPath: Path.join(temporaryRoot, "immutable.AppImage"),
      mode: 0o600,
    });
    const container = inspectLinuxX64AppImageType2(privateSnapshot);
    if (!input.runCommand) trustedUnsquashfs = openTrustedUnsquashfsDigest();
    runRequiredBundledCodexCommand({
      command: BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH,
      args: [
        "-no-progress",
        "-no-xattrs",
        "-d",
        appDir,
        "-o",
        String(container.squashfsOffset),
        privateSnapshot.filePath,
      ],
      cwd: temporaryRoot,
      label: "final AppImage extraction",
      runCommand: input.runCommand ?? runBundledCodexCommand,
    });
    requirePlainDirectory(appDir, "final AppImage extracted AppDir");
    const extractedClosure = input.validateExtractedApplication({
      appDir,
      privateAppImagePath: privateSnapshot.filePath,
    });
    assertImmutableFileDigestCurrent(sourceSnapshot);
    assertImmutableFileDigestCurrent(privateSnapshot);
    if (trustedUnsquashfs) assertImmutableFileDigestCurrent(trustedUnsquashfs);
    return {
      appImageFileName,
      appImageSize: sourceSnapshot.size,
      appImageSha256: sourceSnapshot.sha256,
      container: {
        format: "AppImage-type-2",
        elfClass: "ELF64",
        machine: "x86_64",
        squashfsVersion: "4.0",
        squashfsOffset: container.squashfsOffset,
        squashfsBytesUsed: container.squashfsBytesUsed,
        extractor: BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID,
        validated: true,
      },
      extractedClosure,
      extractionValidated: true,
    };
  } finally {
    if (trustedUnsquashfs) closeImmutableFileDigest(trustedUnsquashfs);
    if (privateSnapshot) closeImmutableFileDigest(privateSnapshot);
    closeImmutableFileDigest(sourceSnapshot);
    FS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const WINDOWS_NSIS_INSTALL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$installer = $env:MOSS_CODEX_NSIS_INSTALLER_PATH",
  "$installDirectory = $env:MOSS_CODEX_NSIS_INSTALL_DIRECTORY",
  "if (-not [IO.Path]::IsPathFullyQualified($installer) -or -not [IO.Path]::IsPathFullyQualified($installDirectory)) { throw 'NSIS verification paths must be absolute.' }",
  "$process = Start-Process -FilePath $installer -ArgumentList @('/S', \"/D=$installDirectory\") -NoNewWindow -PassThru -Wait",
  'if ($process.ExitCode -ne 0) { throw "NSIS installer exited with code $($process.ExitCode)." }',
].join("\n");

const WINDOWS_NSIS_UNINSTALL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$uninstaller = $env:MOSS_CODEX_NSIS_UNINSTALLER_PATH",
  "$installDirectory = $env:MOSS_CODEX_NSIS_INSTALL_DIRECTORY",
  "if (-not [IO.Path]::IsPathFullyQualified($uninstaller) -or -not [IO.Path]::IsPathFullyQualified($installDirectory)) { throw 'NSIS uninstall verification paths must be absolute.' }",
  "$process = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -NoNewWindow -PassThru -Wait",
  'if ($process.ExitCode -ne 0) { throw "NSIS uninstaller exited with code $($process.ExitCode)." }',
  "$deadline = [DateTime]::UtcNow.AddSeconds(15)",
  "while ((Test-Path -LiteralPath $installDirectory) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }",
  "if (Test-Path -LiteralPath $installDirectory) { throw 'NSIS uninstall completed but the installed tree remains.' }",
].join("\n");

export interface BundledCodexWindowsInstallerLifecycleReceipt {
  readonly installerFileName: string;
  readonly installerSize: number;
  readonly installerSha256: string;
  readonly installedClosure: unknown;
  readonly uninstallValidated: boolean;
}

export function verifyBundledCodexWindowsInstallerLifecycle(input: {
  readonly stageDistDir: string;
  readonly installerFileName: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
  readonly validateInstalledApplication: (input: {
    readonly installDirectory: string;
    readonly resourcesDir: string;
  }) => unknown;
}): BundledCodexWindowsInstallerLifecycleReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "win32") {
    throw new Error(
      `Bundled Codex final NSIS verification requires a Windows host, found ${hostPlatform}.`,
    );
  }
  requirePlainDirectory(input.stageDistDir, "final Windows artifact directory");
  const installerFileName = validateArtifactFileName(input.installerFileName, ".exe");
  const installerNames = FS.readdirSync(input.stageDistDir, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(`Bundled Codex final NSIS artifact ${entry.name} must be a plain file.`);
      }
      return entry.name;
    })
    .toSorted(compareUtf8Bytes);
  if (JSON.stringify(installerNames) !== JSON.stringify([installerFileName])) {
    throw new Error("Bundled Codex final NSIS inventory does not match the expected installer.");
  }
  const installerSnapshot = openImmutableFileDigest(
    Path.join(input.stageDistDir, installerFileName),
    `final NSIS installer ${installerFileName}`,
  );
  const temporaryRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-final-nsis-"));
  FS.chmodSync(temporaryRoot, 0o700);
  const installDirectory = Path.join(temporaryRoot, "Moss Installer Verification");
  const resourcesDir = Path.join(installDirectory, "resources");
  const uninstallerPath = Path.join(installDirectory, "Uninstall Moss.exe");
  const runCommand = input.runCommand ?? runBundledCodexCommand;
  let privateInstallerSnapshot: ImmutableFileDigest | undefined;
  let uninstallValidated = false;
  try {
    privateInstallerSnapshot = copyDigestNoReplace({
      source: installerSnapshot,
      outputDirectory: temporaryRoot,
      targetPath: Path.join(temporaryRoot, "immutable-installer.exe"),
    });
    runRequiredBundledCodexCommand({
      command: resolveWindowsPowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_NSIS_INSTALL_SCRIPT],
      env: {
        ...process.env,
        MOSS_CODEX_NSIS_INSTALLER_PATH: privateInstallerSnapshot.filePath,
        MOSS_CODEX_NSIS_INSTALL_DIRECTORY: installDirectory,
      },
      label: "final NSIS installation",
      runCommand,
    });
    requirePlainDirectory(installDirectory, "final NSIS installed application");
    requirePlainDirectory(resourcesDir, "final NSIS installed resources");
    requirePlainFile(uninstallerPath, "final NSIS uninstaller");
    const installedClosure = input.validateInstalledApplication({
      installDirectory,
      resourcesDir,
    });
    assertImmutableFileDigestCurrent(installerSnapshot);
    runRequiredBundledCodexCommand({
      command: resolveWindowsPowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_NSIS_UNINSTALL_SCRIPT],
      env: {
        ...process.env,
        MOSS_CODEX_NSIS_UNINSTALLER_PATH: uninstallerPath,
        MOSS_CODEX_NSIS_INSTALL_DIRECTORY: installDirectory,
      },
      label: "final NSIS uninstall",
      runCommand,
    });
    if (FS.existsSync(installDirectory)) {
      throw new Error(
        "Bundled Codex final NSIS uninstall completed but the installed tree remains.",
      );
    }
    uninstallValidated = true;
    assertImmutableFileDigestCurrent(installerSnapshot);
    assertImmutableFileDigestCurrent(privateInstallerSnapshot);
    return {
      installerFileName,
      installerSize: installerSnapshot.size,
      installerSha256: installerSnapshot.sha256,
      installedClosure,
      uninstallValidated,
    };
  } finally {
    if (privateInstallerSnapshot) closeImmutableFileDigest(privateInstallerSnapshot);
    closeImmutableFileDigest(installerSnapshot);
    FS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

interface BundledCodexSanitizedComplianceReceipt {
  readonly bundleRootAlgorithm: string;
  readonly bundleEntryCount: number;
  readonly bundleFileCount: number;
  readonly bundleDirectoryCount: number;
  readonly bundleTotalBytes: number;
  readonly bundleRootSha256: string;
  readonly componentCount: number;
  readonly licenseTextCount: number;
  readonly payloadFileCount: number;
  readonly sourceMaterialCount: number;
  readonly releaseDecision: "approved" | "blocked";
  readonly blockers: readonly string[];
}

function sanitizeComplianceReceipt(
  receipt: BundledCodexComplianceValidation,
): BundledCodexSanitizedComplianceReceipt {
  return {
    bundleRootAlgorithm: receipt.bundleRootAlgorithm,
    bundleEntryCount: receipt.bundleEntryCount,
    bundleFileCount: receipt.bundleFileCount,
    bundleDirectoryCount: receipt.bundleDirectoryCount,
    bundleTotalBytes: receipt.bundleTotalBytes,
    bundleRootSha256: receipt.bundleRootSha256,
    componentCount: receipt.componentCount,
    licenseTextCount: receipt.licenseTextCount,
    payloadFileCount: receipt.payloadFileCount,
    sourceMaterialCount: receipt.sourceMaterialCount,
    releaseDecision: receipt.releaseDecision,
    blockers: receipt.blockers,
  };
}

export interface BundledCodexLinuxLauncherIdentityReceipt {
  readonly executableFile: string;
  readonly executableSize: number;
  readonly executableSha256: string;
  readonly arguments: readonly ["--version"];
  readonly runtimeVersion: string;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly validated: true;
}

export function verifyBundledCodexLinuxLauncherIdentity(input: {
  readonly executablePath: string;
  readonly expectedExecutableFile: string;
  readonly expectedRuntimeVersion: string;
  readonly expectedIdentity?: BundledCodexLinuxLauncherIdentityReceipt;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexLinuxLauncherIdentityReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const hostArch = input.hostArch ?? process.arch;
  if (hostPlatform !== "linux" || hostArch !== "x64") {
    throw new Error(
      `Bundled Codex Linux launcher verification requires a native linux/x64 host, found ${hostPlatform}/${hostArch}.`,
    );
  }
  const executableFile = validateArtifactFileName(
    `${input.expectedExecutableFile}.AppImage`,
    ".AppImage",
  ).slice(0, -".AppImage".length);
  if (
    !executableFile ||
    executableFile.includes(".") ||
    Path.basename(input.executablePath) !== executableFile
  ) {
    throw new Error("Bundled Codex Linux launcher executable path is invalid.");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.expectedRuntimeVersion)) {
    throw new Error("Bundled Codex Linux launcher expected runtime version is invalid.");
  }
  requirePlainFile(input.executablePath, "Linux launcher executable");
  const snapshot = openImmutableFileDigest(
    input.executablePath,
    `Linux launcher ${executableFile}`,
  );
  try {
    assertLinuxX64Elf64Header(snapshot, `Linux launcher ${executableFile}`);
    try {
      FS.accessSync(input.executablePath, FS.constants.X_OK);
    } catch {
      throw new Error("Bundled Codex Linux launcher executable is not executable.");
    }
    if (
      input.expectedIdentity &&
      (input.expectedIdentity.executableFile !== executableFile ||
        input.expectedIdentity.executableSize !== snapshot.size ||
        input.expectedIdentity.executableSha256 !== snapshot.sha256 ||
        input.expectedIdentity.runtimeVersion !== input.expectedRuntimeVersion ||
        !isDeepStrictEqual(input.expectedIdentity.arguments, ["--version"]) ||
        input.expectedIdentity.validated !== true)
    ) {
      throw new Error(
        "Bundled Codex Linux launcher does not match the expected packaged launcher identity.",
      );
    }
    const startup = runRequiredBundledCodexCommand({
      command: input.executablePath,
      args: ["--version"],
      cwd: Path.dirname(input.executablePath),
      label: "Linux launcher runtime-version probe",
      runCommand: input.runCommand ?? runBundledCodexCommand,
    });
    const output = startup.stdout.trim();
    const expectedOutput = `v${input.expectedRuntimeVersion}`;
    if (output !== expectedOutput) {
      throw new Error(
        `Bundled Codex Linux launcher runtime version mismatch: expected ${expectedOutput}, found ${output || "(empty)"}.`,
      );
    }
    const identity: BundledCodexLinuxLauncherIdentityReceipt = {
      executableFile,
      executableSize: snapshot.size,
      executableSha256: snapshot.sha256,
      arguments: ["--version"],
      runtimeVersion: input.expectedRuntimeVersion,
      outputBytes: Buffer.byteLength(output, "utf8"),
      outputSha256: Crypto.createHash("sha256").update(output, "utf8").digest("hex"),
      validated: true,
    };
    if (input.expectedIdentity && !isDeepStrictEqual(identity, input.expectedIdentity)) {
      throw new Error(
        "Bundled Codex Linux launcher runtime output does not match the expected packaged launcher identity.",
      );
    }
    assertImmutableFileDigestCurrent(snapshot);
    return identity;
  } finally {
    closeImmutableFileDigest(snapshot);
  }
}

export interface BundledCodexFinalLinuxAppImageReceipt {
  readonly platform: "linux";
  readonly appImageFileName: string;
  readonly appImageSize: number;
  readonly appImageSha256: string;
  readonly container: BundledCodexLinuxAppImageContainerLifecycleReceipt["container"];
  readonly extractionValidated: true;
  readonly extractedClosure: {
    readonly compliance: BundledCodexSanitizedComplianceReceipt;
    readonly payload: {
      readonly mode: "exact-final-payload-hashes";
      readonly targetTriples: readonly string[];
      readonly validated: true;
    };
    readonly runtime: {
      readonly targetTriple: typeof LINUX_PUBLIC_TARGET_TRIPLE;
      readonly maximumGlibcVersion: string;
      readonly neededLibraries: readonly string[];
      readonly resolvedLibraries: readonly string[];
      readonly commandCount: number;
      readonly validated: true;
    };
    readonly startup: BundledCodexLinuxLauncherIdentityReceipt;
  };
}

export type BundledCodexLinuxFinalInstallableVerifier = (input: {
  readonly stageDistDir: string;
  readonly appImageFileName: string;
  readonly expectedLauncher: BundledCodexLinuxLauncherIdentityReceipt;
}) => BundledCodexFinalLinuxAppImageReceipt;

export function verifyFinalBundledCodexLinuxAppImage(input: {
  readonly stageDistDir: string;
  readonly expectedVersion: string;
  readonly targetTriples: readonly string[];
  readonly expectedMainExecutableName: string;
  readonly expectedAppImageFileName: string;
  readonly expectedLauncher: BundledCodexLinuxLauncherIdentityReceipt;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexFinalLinuxAppImageReceipt {
  assertBundledCodexComplianceVersion(input.expectedVersion);
  if (
    !isDeepStrictEqual([...input.targetTriples].toSorted(compareUtf8Bytes), [
      LINUX_PUBLIC_TARGET_TRIPLE,
    ])
  ) {
    throw new Error(`Bundled Codex final AppImage requires exactly ${LINUX_PUBLIC_TARGET_TRIPLE}.`);
  }
  const mainExecutableName = validateArtifactFileName(
    `${input.expectedMainExecutableName}.AppImage`,
    ".AppImage",
  ).slice(0, -".AppImage".length);
  if (!mainExecutableName || mainExecutableName.includes(".")) {
    throw new Error("Bundled Codex final AppImage main executable name is invalid.");
  }
  const lifecycle = verifyBundledCodexLinuxAppImageContainerLifecycle({
    stageDistDir: input.stageDistDir,
    appImageFileName: input.expectedAppImageFileName,
    ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
    ...(input.hostArch ? { hostArch: input.hostArch } : {}),
    ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    validateExtractedApplication: ({ appDir }) => {
      const executablePath = Path.join(appDir, mainExecutableName);
      const startup = verifyBundledCodexLinuxLauncherIdentity({
        executablePath,
        expectedExecutableFile: mainExecutableName,
        expectedRuntimeVersion: input.expectedLauncher.runtimeVersion,
        expectedIdentity: input.expectedLauncher,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.hostArch ? { hostArch: input.hostArch } : {}),
        ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      });
      const resourcesDir = Path.join(appDir, "resources");
      requirePlainDirectory(resourcesDir, "final AppImage resources directory");
      const compliance = validatePackagedBundledCodexComplianceBundle({
        resourcesDir,
        expectedVersion: input.expectedVersion,
      });
      validateStagedBundledCodexPayloadIntegrity({
        packagedResourcesDir: resourcesDir,
        complianceDirectory: compliance.directory,
        targetTriples: input.targetTriples,
      });
      const runtime = validateBundledCodexLinuxX64PublicRuntime({
        resourcesDir,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.hostArch ? { hostArch: input.hostArch } : {}),
        ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      });
      return {
        compliance: sanitizeComplianceReceipt(compliance),
        payload: {
          mode: "exact-final-payload-hashes" as const,
          targetTriples: [...input.targetTriples].toSorted(compareUtf8Bytes),
          validated: true as const,
        },
        runtime: {
          targetTriple: runtime.targetTriple,
          maximumGlibcVersion: runtime.maximumGlibcVersion,
          neededLibraries: runtime.neededLibraries,
          resolvedLibraries: runtime.resolvedLibraries,
          commandCount: runtime.commands.length,
          validated: true as const,
        },
        startup,
      };
    },
  });
  return {
    platform: "linux",
    appImageFileName: lifecycle.appImageFileName,
    appImageSize: lifecycle.appImageSize,
    appImageSha256: lifecycle.appImageSha256,
    container: lifecycle.container,
    extractionValidated: lifecycle.extractionValidated,
    extractedClosure:
      lifecycle.extractedClosure as BundledCodexFinalLinuxAppImageReceipt["extractedClosure"],
  };
}

function signedPayloadBindingProjection(
  receipt: BundledCodexSignedPayloadIntegrityReceipt,
): unknown {
  return {
    platform: receipt.platform,
    targetReceipts: receipt.targetReceipts.map((target) => ({
      targetTriple: target.targetTriple,
      archiveId: target.archiveId,
      fileCount: target.fileCount,
      totalBytes: target.totalBytes,
      finalTreeSha256: target.finalTreeSha256,
      canonicalContentTreeSha256: target.canonicalContentTreeSha256,
      files: target.files,
    })),
    fileCount: receipt.fileCount,
    totalBytes: receipt.totalBytes,
    finalTreeSha256: receipt.finalTreeSha256,
    canonicalContentTreeSha256: receipt.canonicalContentTreeSha256,
  };
}

function assertSignedPayloadReceiptBound(input: {
  readonly expected: BundledCodexSignedPayloadIntegrityReceipt;
  readonly actual: BundledCodexSignedPayloadIntegrityReceipt;
  readonly label: string;
}): void {
  if (
    !isDeepStrictEqual(
      signedPayloadBindingProjection(input.expected),
      signedPayloadBindingProjection(input.actual),
    )
  ) {
    throw new Error(
      `Bundled Codex ${input.label} payload receipt is not bound to the verified unpacked application.`,
    );
  }
}

interface BundledCodexSanitizedSignedPayloadReceipt {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly finalTreeSha256: string;
  readonly canonicalContentTreeSha256: string;
}

function sanitizeSignedPayloadReceipt(
  receipt: BundledCodexSignedPayloadIntegrityReceipt,
): BundledCodexSanitizedSignedPayloadReceipt {
  return {
    fileCount: receipt.fileCount,
    totalBytes: receipt.totalBytes,
    finalTreeSha256: receipt.finalTreeSha256,
    canonicalContentTreeSha256: receipt.canonicalContentTreeSha256,
  };
}

export interface BundledCodexFinalMacArtifactsReceipt {
  readonly platform: "mac";
  readonly artifacts: readonly {
    readonly kind: "dmg" | "zip";
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
    readonly installedClosure: {
      readonly compliance: BundledCodexSanitizedComplianceReceipt;
      readonly payload: BundledCodexSanitizedSignedPayloadReceipt;
      readonly signature: {
        readonly bundleIdentifier: string;
        readonly teamIdentifier: string;
        readonly nestedRuntimeExecutableCount: number;
        readonly notarizationValidated: boolean;
        readonly canonicalFilesystemHelper: PackagedCanonicalFilesystemHelperBindingReceipt;
      };
      readonly bundledClaude: BundledClaudeFinalArtifactVerificationReceipt;
    };
  }[];
}

export function verifyFinalBundledCodexMacArtifacts(input: {
  readonly stageDistDir: string;
  readonly sourceResourcesDir: string;
  readonly expectedVersion: string;
  readonly arch: "arm64" | "x64" | "universal";
  readonly targetTriples: readonly string[];
  readonly expectedPayloadReceipt: BundledCodexSignedPayloadIntegrityReceipt;
  readonly expectedTeamIdentifier: string;
  readonly expectedBundleIdentifier: string;
  readonly requireNotarization: boolean;
  readonly dmgFileName?: string;
  readonly zipFileName?: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexFinalMacArtifactsReceipt {
  const lifecycle = verifyBundledCodexMacArtifactContainerLifecycle({
    stageDistDir: input.stageDistDir,
    ...(input.dmgFileName ? { dmgFileName: input.dmgFileName } : {}),
    ...(input.zipFileName ? { zipFileName: input.zipFileName } : {}),
    ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
    ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    validateAppBundle: ({ artifactKind, appBundlePath }) => {
      const resourcesDir = Path.join(appBundlePath, "Contents", "Resources");
      const compliance = validatePackagedBundledCodexComplianceBundle({
        resourcesDir,
        expectedVersion: input.expectedVersion,
      });
      const payload = validateSignedBundledCodexPayloadIntegrity({
        sourceResourcesDir: input.sourceResourcesDir,
        finalResourcesDir: resourcesDir,
        complianceDirectory: compliance.directory,
        targetTriples: input.targetTriples,
        platform: "mac",
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      });
      assertSignedPayloadReceiptBound({
        expected: input.expectedPayloadReceipt,
        actual: payload,
        label: `final ${artifactKind.toUpperCase()}`,
      });
      const signature = verifyPackagedBundledCodexMacCodeSignature({
        appBundlePath,
        resourcesDir,
        targetTriples: input.targetTriples,
        expectedTeamIdentifier: input.expectedTeamIdentifier,
        expectedBundleIdentifier: input.expectedBundleIdentifier,
        requireNotarization: input.requireNotarization,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      });
      const bundledClaude = verifyFinalBundledClaudeMacRuntime({
        resourcesDir,
        arch: input.arch,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.hostArch ? { hostArch: input.hostArch } : {}),
      });
      return {
        compliance: sanitizeComplianceReceipt(compliance),
        payload: sanitizeSignedPayloadReceipt(payload),
        signature: {
          bundleIdentifier: signature.bundleIdentifier,
          teamIdentifier: signature.teamIdentifier,
          nestedRuntimeExecutableCount: signature.runtimeExecutablePaths.length,
          notarizationValidated: signature.notarizationValidated,
          canonicalFilesystemHelper: signature.canonicalFilesystemHelper,
        },
        bundledClaude,
      };
    },
  });
  return {
    platform: "mac",
    artifacts: lifecycle.artifacts as BundledCodexFinalMacArtifactsReceipt["artifacts"],
  };
}

export interface BundledClaudeFinalMacArtifactsReceipt {
  readonly platform: "mac";
  readonly artifacts: readonly {
    readonly kind: "dmg" | "zip";
    readonly fileName: string;
    readonly size: number;
    readonly sha256: string;
    readonly bundledClaude: BundledClaudeFinalArtifactVerificationReceipt;
    readonly asarIntegrity?: PackagedAsarIntegrityReceipt;
  }[];
}

/**
 * Runs the final extracted DMG/ZIP Claude probe for build-only macOS lanes.
 * Developer ID/Codex signature proof is intentionally separate: an unsigned
 * local candidate can still prove that the shipped Claude executable exists,
 * is executable, and reports the pinned version from the actual container.
 */
export function verifyFinalBundledClaudeMacArtifacts(input: {
  readonly stageDistDir: string;
  readonly arch: "arm64" | "x64" | "universal";
  readonly dmgFileName?: string;
  readonly zipFileName?: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly runCommand?: BundledCodexCommandRunner;
  readonly verifyAsarIntegrity?: boolean;
}): BundledClaudeFinalMacArtifactsReceipt {
  const lifecycle = verifyBundledCodexMacArtifactContainerLifecycle({
    stageDistDir: input.stageDistDir,
    ...(input.dmgFileName ? { dmgFileName: input.dmgFileName } : {}),
    ...(input.zipFileName ? { zipFileName: input.zipFileName } : {}),
    ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
    ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    validateAppBundle: ({ appBundlePath }) => {
      const resourcesDir = Path.join(appBundlePath, "Contents", "Resources");
      const asarIntegrity = input.verifyAsarIntegrity
        ? verifyPackagedAsarIntegrity(appBundlePath)
        : undefined;
      const bundledClaude = verifyFinalBundledClaudeMacRuntime({
        resourcesDir,
        arch: input.arch,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.hostArch ? { hostArch: input.hostArch } : {}),
      });
      return { bundledClaude, ...(asarIntegrity ? { asarIntegrity } : {}) };
    },
  });
  return {
    platform: "mac",
    artifacts: lifecycle.artifacts.map((artifact) => ({
      kind: artifact.kind,
      fileName: artifact.fileName,
      size: artifact.size,
      sha256: artifact.sha256,
      ...(artifact.installedClosure as {
        bundledClaude: BundledClaudeFinalArtifactVerificationReceipt;
        asarIntegrity?: PackagedAsarIntegrityReceipt;
      }),
    })),
  };
}

export interface BundledCodexFinalWindowsInstallerReceipt {
  readonly platform: "win";
  readonly installerFileName: string;
  readonly installerSize: number;
  readonly installerSha256: string;
  readonly uninstallValidated: boolean;
  readonly installedClosure: {
    readonly compliance: BundledCodexSanitizedComplianceReceipt;
    readonly payload: BundledCodexSanitizedSignedPayloadReceipt;
    readonly authenticode: {
      readonly executableFiles: readonly string[];
      readonly certificateIdentity: BundledCodexWindowsAuthenticodeReceipt["certificateIdentity"];
      readonly signatures: BundledCodexWindowsAuthenticodeReceipt["signatures"];
    };
  };
}

export function verifyFinalBundledCodexWindowsInstaller(input: {
  readonly stageDistDir: string;
  readonly sourceResourcesDir: string;
  readonly expectedVersion: string;
  readonly targetTriples: readonly string[];
  readonly expectedPayloadReceipt: BundledCodexSignedPayloadIntegrityReceipt;
  readonly expectedMainExecutableName: string;
  readonly expectedInstallerFileName: string;
  readonly expectedPublisherName: string;
  readonly expectedCertificateSubjectDn: string;
  readonly expectedCertificateThumbprint: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexFinalWindowsInstallerReceipt {
  const lifecycle = verifyBundledCodexWindowsInstallerLifecycle({
    stageDistDir: input.stageDistDir,
    installerFileName: input.expectedInstallerFileName,
    ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
    ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    validateInstalledApplication: ({ resourcesDir }) => {
      const compliance = validatePackagedBundledCodexComplianceBundle({
        resourcesDir,
        expectedVersion: input.expectedVersion,
      });
      const payload = validateSignedBundledCodexPayloadIntegrity({
        sourceResourcesDir: input.sourceResourcesDir,
        finalResourcesDir: resourcesDir,
        complianceDirectory: compliance.directory,
        targetTriples: input.targetTriples,
        platform: "win",
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      });
      assertSignedPayloadReceiptBound({
        expected: input.expectedPayloadReceipt,
        actual: payload,
        label: "final installed NSIS",
      });
      const authenticode = verifyPackagedBundledCodexWindowsAuthenticode({
        stageDistDir: input.stageDistDir,
        resourcesDir,
        targetTriples: input.targetTriples,
        expectedMainExecutableName: input.expectedMainExecutableName,
        expectedInstallerFileName: input.expectedInstallerFileName,
        expectedPublisherName: input.expectedPublisherName,
        expectedCertificateSubjectDn: input.expectedCertificateSubjectDn,
        expectedCertificateThumbprint: input.expectedCertificateThumbprint,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.runCommand ? { runCommand: input.runCommand } : {}),
      });
      return {
        compliance: sanitizeComplianceReceipt(compliance),
        payload: sanitizeSignedPayloadReceipt(payload),
        authenticode: {
          executableFiles: authenticode.executableFiles,
          certificateIdentity: authenticode.certificateIdentity,
          signatures: authenticode.signatures,
        },
      };
    },
  });
  const installedClosure =
    lifecycle.installedClosure as BundledCodexFinalWindowsInstallerReceipt["installedClosure"];
  const signatureByFile = new Map(
    installedClosure.authenticode.signatures.map(
      (signature) => [signature.file, signature] as const,
    ),
  );
  for (const target of input.expectedPayloadReceipt.targetReceipts) {
    for (const file of target.files.filter((entry) => entry.signedExecutable)) {
      const logicalPath = `app/resources/codex-runtime/${target.targetTriple}/${file.path}`;
      const signature = signatureByFile.get(logicalPath);
      if (
        !signature ||
        signature.size !== file.finalSize ||
        signature.sha256 !== file.finalSha256
      ) {
        throw new Error(
          `Bundled Codex installed Authenticode bytes are not bound to payload ${logicalPath}.`,
        );
      }
    }
  }
  const installerSignature = signatureByFile.get(`installer/${lifecycle.installerFileName}`);
  if (
    !installerSignature ||
    installerSignature.size !== lifecycle.installerSize ||
    installerSignature.sha256 !== lifecycle.installerSha256
  ) {
    throw new Error(
      "Bundled Codex installed Authenticode proof is not bound to the immutable NSIS installer.",
    );
  }
  return {
    platform: "win",
    installerFileName: lifecycle.installerFileName,
    installerSize: lifecycle.installerSize,
    installerSha256: lifecycle.installerSha256,
    uninstallValidated: lifecycle.uninstallValidated,
    installedClosure,
  };
}

export interface BundledCodexReleaseArtifactReceipt {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BundledCodexReleaseReceipt {
  readonly schemaVersion: 1;
  readonly kind: "moss-bundled-codex-release-receipt";
  readonly platform: "linux" | "mac" | "win";
  readonly arch: "arm64" | "x64" | "universal";
  readonly releaseMode: "build-only" | "publish";
  readonly signed: boolean;
  readonly publishEligible: boolean;
  readonly bundledCodexVersion: string;
  readonly complianceBundleRootSha256: string;
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
  readonly verification: JsonRecord;
}

function assertReceiptSafeJson(value: unknown, label = "verification"): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (
      Path.isAbsolute(value) ||
      Path.win32.isAbsolute(value) ||
      /(?:^|[?&])(token|key|secret|password)=/iu.test(value)
    ) {
      throw new Error(`Bundled Codex release receipt contains unsafe private data at ${label}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReceiptSafeJson(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Bundled Codex release receipt contains non-JSON data at ${label}.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      /(?:^|_)(?:absolute_)?(?:path|directory|command|env|token|secret|password|private_key)$/iu.test(
        key,
      )
    ) {
      throw new Error(`Bundled Codex release receipt contains a private field at ${label}.${key}.`);
    }
    assertReceiptSafeJson(entry, `${label}.${key}`);
  }
}

interface BundledCodexReceiptPayloadBinding {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly finalTreeSha256: string;
  readonly canonicalContentTreeSha256: string;
}

function assertExactReceiptComplianceEvidence(value: unknown, label: string): void {
  const compliance = objectEntry(value, label);
  const blockers = arrayField(compliance, "blockers", label);
  const exact =
    compliance.bundleRootAlgorithm === BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM &&
    compliance.bundleEntryCount === BUNDLED_CODEX_COMPLIANCE_BUNDLE_ENTRY_COUNT &&
    compliance.bundleFileCount === BUNDLED_CODEX_COMPLIANCE_BUNDLE_FILE_COUNT &&
    compliance.bundleDirectoryCount === BUNDLED_CODEX_COMPLIANCE_BUNDLE_DIRECTORY_COUNT &&
    compliance.bundleTotalBytes === BUNDLED_CODEX_COMPLIANCE_BUNDLE_TOTAL_BYTES &&
    compliance.bundleRootSha256 === BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256 &&
    compliance.componentCount === BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT &&
    compliance.licenseTextCount === BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT &&
    compliance.payloadFileCount === BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT &&
    compliance.sourceMaterialCount === BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT &&
    compliance.releaseDecision === "approved" &&
    blockers.length === 0;
  if (!exact) {
    throw new Error(`Bundled Codex release receipt ${label} is not the exact approved closure.`);
  }
}

function readReceiptSignedPayloadBinding(
  value: unknown,
  label: string,
): BundledCodexReceiptPayloadBinding {
  const payload = objectEntry(value, label);
  const fileCount = numberField(payload, "fileCount", label);
  const totalBytes = numberField(payload, "totalBytes", label);
  const finalTreeSha256 = stringField(payload, "finalTreeSha256", label);
  const canonicalContentTreeSha256 = stringField(payload, "canonicalContentTreeSha256", label);
  if (
    fileCount === 0 ||
    totalBytes === 0 ||
    !SHA256.test(finalTreeSha256) ||
    !SHA256.test(canonicalContentTreeSha256)
  ) {
    throw new Error(`Bundled Codex release receipt ${label} has invalid payload binding.`);
  }
  return { fileCount, totalBytes, finalTreeSha256, canonicalContentTreeSha256 };
}

function assertMacBuildOnlySignatureProvenance(
  value: unknown,
  expectedArch: PackagedCanonicalFilesystemHelperBindingReceipt["arch"],
): void {
  const label = "verification.macBuildOnlySignature";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Bundled Codex macOS build-only canonical payload requires explicit ad-hoc signature provenance.",
    );
  }
  const provenance = objectEntry(value, label);
  const signatures = arrayField(provenance, "signatures", label);
  if (
    provenance.releaseEligibility !== "build-only-only" ||
    provenance.signatureType !== "adhoc" ||
    signatures.length < 2
  ) {
    throw new Error(
      "Bundled Codex macOS build-only canonical payload requires explicit ad-hoc signature provenance.",
    );
  }
  const logicalFiles = new Set<string>();
  for (const [index, rawSignature] of signatures.entries()) {
    const signatureLabel = `${label}.signatures[${index}]`;
    const signature = objectEntry(rawSignature, signatureLabel);
    const logicalFile = stringField(signature, "logicalFile", signatureLabel);
    const identifier = stringField(signature, "identifier", signatureLabel);
    const cdHash = stringField(signature, "cdHash", signatureLabel);
    const authorities = arrayField(signature, "authorities", signatureLabel);
    assertReceiptLogicalPath(logicalFile, `${signatureLabel}.logicalFile`);
    if (
      logicalFiles.has(logicalFile) ||
      !identifier.trim() ||
      !/^[a-f0-9]{40,64}$/u.test(cdHash) ||
      signature.signatureType !== "adhoc" ||
      signature.teamIdentifier !== null ||
      authorities.length !== 0
    ) {
      throw new Error(
        "Bundled Codex macOS build-only canonical payload requires explicit ad-hoc signature provenance.",
      );
    }
    logicalFiles.add(logicalFile);
  }
  if (!logicalFiles.has("app")) {
    throw new Error(
      "Bundled Codex macOS build-only canonical payload requires explicit ad-hoc signature provenance for the app.",
    );
  }
  readPackagedCanonicalFilesystemHelperBindingReceipt({
    value: provenance.canonicalFilesystemHelper,
    label: `${label}.canonicalFilesystemHelper`,
    expectedArch,
  });
}

function assertReceiptLogicalPath(value: string, label: string): void {
  const segments = value.split("/");
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    Path.posix.normalize(value) !== value ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Bundled Codex release receipt ${label} is not a safe logical path.`);
  }
}

function assertMacFinalInstallableBound(input: {
  readonly finalInstallable: JsonRecord;
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
  readonly packagedPayload: BundledCodexReceiptPayloadBinding;
  readonly expectedArch: PackagedCanonicalFilesystemHelperBindingReceipt["arch"];
}): void {
  assertMacFinalClaudeInstallableBound({
    finalInstallable: input.finalInstallable,
    artifacts: input.artifacts,
    expectedArch: input.expectedArch,
  });
  const releaseContainers = input.artifacts.filter(
    (artifact) =>
      artifact.fileName.toLowerCase().endsWith(".dmg") ||
      artifact.fileName.toLowerCase().endsWith(".zip"),
  );
  const lifecycleArtifacts = arrayField(
    input.finalInstallable,
    "artifacts",
    "verification.finalInstallable",
  );
  if (
    input.finalInstallable.platform !== "mac" ||
    releaseContainers.length === 0 ||
    lifecycleArtifacts.length !== releaseContainers.length
  ) {
    throw new Error(
      "Bundled Codex final installable macOS proof is not bound to every copied container.",
    );
  }
  const releaseByName = new Map(releaseContainers.map((artifact) => [artifact.fileName, artifact]));
  const seen = new Set<string>();
  let expectedCanonicalFilesystemHelper:
    | PackagedCanonicalFilesystemHelperBindingReceipt
    | undefined;
  for (const [index, value] of lifecycleArtifacts.entries()) {
    const label = `verification.finalInstallable.artifacts[${index}]`;
    const artifact = objectEntry(value, label);
    const kind = stringField(artifact, "kind", label);
    const fileName = stringField(artifact, "fileName", label);
    const size = numberField(artifact, "size", label);
    const sha256 = stringField(artifact, "sha256", label);
    const releaseArtifact = releaseByName.get(fileName);
    if (
      (kind !== "dmg" && kind !== "zip") ||
      !fileName.toLowerCase().endsWith(`.${kind}`) ||
      seen.has(fileName) ||
      !releaseArtifact ||
      size !== releaseArtifact.size ||
      sha256 !== releaseArtifact.sha256
    ) {
      throw new Error(
        `Bundled Codex final installable macOS proof is not bound to copied artifact ${fileName}.`,
      );
    }
    seen.add(fileName);
    const installedClosure = objectEntry(artifact.installedClosure, `${label}.installedClosure`);
    assertExactReceiptComplianceEvidence(
      installedClosure.compliance,
      `${label}.installedClosure.compliance`,
    );
    const payload = readReceiptSignedPayloadBinding(
      installedClosure.payload,
      `${label}.installedClosure.payload`,
    );
    if (!isDeepStrictEqual(payload, input.packagedPayload)) {
      throw new Error(
        `Bundled Codex final installable macOS payload is not bound to copied artifact ${fileName}.`,
      );
    }
    const signature = objectEntry(
      installedClosure.signature,
      `${label}.installedClosure.signature`,
    );
    if (
      typeof signature.bundleIdentifier !== "string" ||
      !signature.bundleIdentifier ||
      typeof signature.teamIdentifier !== "string" ||
      !/^[A-Z0-9]{10}$/u.test(signature.teamIdentifier) ||
      !Number.isSafeInteger(signature.nestedRuntimeExecutableCount) ||
      Number(signature.nestedRuntimeExecutableCount) <= 0 ||
      signature.notarizationValidated !== true
    ) {
      throw new Error(
        `Bundled Codex final installable macOS signature proof is incomplete for ${fileName}.`,
      );
    }
    const canonicalFilesystemHelper = readPackagedCanonicalFilesystemHelperBindingReceipt({
      value: signature.canonicalFilesystemHelper,
      label: `${label}.installedClosure.signature.canonicalFilesystemHelper`,
      expectedArch: input.expectedArch,
    });
    if (
      expectedCanonicalFilesystemHelper &&
      !isDeepStrictEqual(canonicalFilesystemHelper, expectedCanonicalFilesystemHelper)
    ) {
      throw new Error(
        "Bundled Codex final macOS containers do not contain the same canonical filesystem helper binding.",
      );
    }
    expectedCanonicalFilesystemHelper = canonicalFilesystemHelper;
  }
  if (seen.size !== releaseByName.size) {
    throw new Error(
      "Bundled Codex final installable macOS proof is not bound to every copied container.",
    );
  }
}

function assertMacFinalClaudeInstallableBound(input: {
  readonly finalInstallable: JsonRecord;
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
  readonly expectedArch: "arm64" | "x64" | "universal";
}): void {
  const releaseContainers = input.artifacts.filter(
    (artifact) =>
      artifact.fileName.toLowerCase().endsWith(".dmg") ||
      artifact.fileName.toLowerCase().endsWith(".zip"),
  );
  const lifecycleArtifacts = arrayField(
    input.finalInstallable,
    "artifacts",
    "verification.finalInstallable",
  );
  if (
    input.finalInstallable.platform !== "mac" ||
    releaseContainers.length === 0 ||
    lifecycleArtifacts.length !== releaseContainers.length
  ) {
    throw new Error(
      "Bundled Codex final installable Claude macOS proof is not bound to every copied DMG/ZIP container.",
    );
  }
  const releaseByName = new Map(releaseContainers.map((artifact) => [artifact.fileName, artifact]));
  const seen = new Set<string>();
  for (const [index, value] of lifecycleArtifacts.entries()) {
    const label = `verification.finalInstallable.artifacts[${index}]`;
    const artifact = objectEntry(value, label);
    const kind = stringField(artifact, "kind", label);
    const fileName = stringField(artifact, "fileName", label);
    const size = numberField(artifact, "size", label);
    const sha256 = stringField(artifact, "sha256", label);
    const releaseArtifact = releaseByName.get(fileName);
    if (
      (kind !== "dmg" && kind !== "zip") ||
      !fileName.toLowerCase().endsWith(`.${kind}`) ||
      seen.has(fileName) ||
      !releaseArtifact ||
      size !== releaseArtifact.size ||
      sha256 !== releaseArtifact.sha256
    ) {
      throw new Error(
        `Bundled Codex final installable Claude macOS proof is not bound to copied artifact ${fileName}.`,
      );
    }
    const installedClosure =
      artifact.bundledClaude ??
      objectEntry(artifact.installedClosure, `${label}.installedClosure`).bundledClaude;
    assertBundledClaudeFinalArtifactVerificationReceipt({
      value: installedClosure,
      expectedArch: input.expectedArch,
    });
    seen.add(fileName);
  }
  if (seen.size !== releaseByName.size) {
    throw new Error(
      "Bundled Codex final installable Claude macOS proof is not bound to every copied container.",
    );
  }
}

function assertWindowsFinalInstallableBound(input: {
  readonly finalInstallable: JsonRecord;
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
  readonly packagedPayload: BundledCodexReceiptPayloadBinding;
}): void {
  const installers = input.artifacts.filter((artifact) =>
    artifact.fileName.toLowerCase().endsWith(".exe"),
  );
  const installerFileName = stringField(
    input.finalInstallable,
    "installerFileName",
    "verification.finalInstallable",
  );
  const installerSize = numberField(
    input.finalInstallable,
    "installerSize",
    "verification.finalInstallable",
  );
  const installerSha256 = stringField(
    input.finalInstallable,
    "installerSha256",
    "verification.finalInstallable",
  );
  const installer = installers[0];
  if (
    input.finalInstallable.platform !== "win" ||
    input.finalInstallable.uninstallValidated !== true ||
    installers.length !== 1 ||
    !installer ||
    installer.fileName !== installerFileName ||
    installer.size !== installerSize ||
    installer.sha256 !== installerSha256
  ) {
    throw new Error(
      "Bundled Codex final installable Windows proof is not bound to the copied NSIS installer.",
    );
  }
  const installedClosure = objectEntry(
    input.finalInstallable.installedClosure,
    "verification.finalInstallable.installedClosure",
  );
  assertExactReceiptComplianceEvidence(
    installedClosure.compliance,
    "verification.finalInstallable.installedClosure.compliance",
  );
  const payload = readReceiptSignedPayloadBinding(
    installedClosure.payload,
    "verification.finalInstallable.installedClosure.payload",
  );
  if (!isDeepStrictEqual(payload, input.packagedPayload)) {
    throw new Error(
      "Bundled Codex final installable Windows payload is not bound to the copied NSIS installer.",
    );
  }
  const authenticode = objectEntry(
    installedClosure.authenticode,
    "verification.finalInstallable.installedClosure.authenticode",
  );
  const executableFiles = arrayField(
    authenticode,
    "executableFiles",
    "verification.finalInstallable.installedClosure.authenticode",
  ).map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(
        `Bundled Codex final installable Windows executableFiles[${index}] is invalid.`,
      );
    }
    assertReceiptLogicalPath(value, `Windows executableFiles[${index}]`);
    return value;
  });
  if (
    executableFiles.length < 3 ||
    new Set(executableFiles).size !== executableFiles.length ||
    !executableFiles.includes(`installer/${installerFileName}`) ||
    !executableFiles.some((file) => /^app\/[^/]+\.exe$/iu.test(file))
  ) {
    throw new Error("Bundled Codex final installable Windows executable inventory is incomplete.");
  }
  const certificateIdentity = objectEntry(
    authenticode.certificateIdentity,
    "verification.finalInstallable.installedClosure.authenticode.certificateIdentity",
  );
  const subjectDn = stringField(
    certificateIdentity,
    "subjectDn",
    "verification.finalInstallable.installedClosure.authenticode.certificateIdentity",
  );
  const thumbprint = stringField(
    certificateIdentity,
    "thumbprint",
    "verification.finalInstallable.installedClosure.authenticode.certificateIdentity",
  );
  stringField(
    certificateIdentity,
    "issuerDn",
    "verification.finalInstallable.installedClosure.authenticode.certificateIdentity",
  );
  stringField(
    certificateIdentity,
    "serialNumber",
    "verification.finalInstallable.installedClosure.authenticode.certificateIdentity",
  );
  if (!subjectDn.includes("=") || !/^[A-F0-9]{40}$/u.test(thumbprint)) {
    throw new Error(
      "Bundled Codex final installable Windows certificate identity proof is incomplete.",
    );
  }
  const signatures = arrayField(
    authenticode,
    "signatures",
    "verification.finalInstallable.installedClosure.authenticode",
  );
  if (signatures.length !== executableFiles.length) {
    throw new Error("Bundled Codex final installable Windows signature inventory is incomplete.");
  }
  const signatureFiles = new Set<string>();
  for (const [index, value] of signatures.entries()) {
    const label = `verification.finalInstallable.installedClosure.authenticode.signatures[${index}]`;
    const signature = objectEntry(value, label);
    const file = stringField(signature, "file", label);
    const size = numberField(signature, "size", label);
    const sha256 = stringField(signature, "sha256", label);
    assertReceiptLogicalPath(file, `${label}.file`);
    const timestamp = objectEntry(signature.timestamp, `${label}.timestamp`);
    const timestampThumbprint = stringField(timestamp, "thumbprint", `${label}.timestamp`);
    if (
      signature.status !== "Valid" ||
      signature.signatureType !== "Authenticode" ||
      size <= 0 ||
      !SHA256.test(sha256) ||
      (file === `installer/${installerFileName}` &&
        (size !== installerSize || sha256 !== installerSha256)) ||
      signatureFiles.has(file) ||
      !executableFiles.includes(file) ||
      !stringField(timestamp, "subjectDn", `${label}.timestamp`).includes("=") ||
      !/^[A-F0-9]{40}$/u.test(timestampThumbprint) ||
      !stringField(timestamp, "serialNumber", `${label}.timestamp`) ||
      !Number.isFinite(Date.parse(stringField(timestamp, "notBeforeUtc", `${label}.timestamp`))) ||
      !Number.isFinite(Date.parse(stringField(timestamp, "notAfterUtc", `${label}.timestamp`))) ||
      timestamp.signtoolVerified !== true
    ) {
      throw new Error(
        `Bundled Codex final installable Windows signature proof is invalid for ${file}.`,
      );
    }
    signatureFiles.add(file);
  }
}

function readLinuxRuntimeReceipt(
  value: unknown,
  label: string,
): BundledCodexFinalLinuxAppImageReceipt["extractedClosure"]["runtime"] {
  const runtime = objectEntry(value, label);
  const maximumGlibcVersion = stringField(runtime, "maximumGlibcVersion", label);
  const glibcMatch = /^(\d+)\.(\d+)$/u.exec(maximumGlibcVersion);
  const neededLibraries = arrayField(runtime, "neededLibraries", label);
  const resolvedLibraries = arrayField(runtime, "resolvedLibraries", label);
  const expectedLibraries = [...LINUX_PUBLIC_SHARED_LIBRARIES].toSorted(compareUtf8Bytes);
  const commandCount =
    runtime.commandCount === undefined ? 0 : numberField(runtime, "commandCount", label);
  if (
    runtime.targetTriple !== LINUX_PUBLIC_TARGET_TRIPLE ||
    glibcMatch === null ||
    compareVersionParts([Number(glibcMatch[1]), Number(glibcMatch[2])], [2, 38]) > 0 ||
    !isDeepStrictEqual(neededLibraries, expectedLibraries) ||
    !isDeepStrictEqual(resolvedLibraries, expectedLibraries) ||
    (runtime.commandCount !== undefined && (commandCount < 5 || runtime.validated !== true))
  ) {
    throw new Error(`Bundled Codex release receipt ${label} is not a valid Linux runtime proof.`);
  }
  return {
    targetTriple: LINUX_PUBLIC_TARGET_TRIPLE,
    maximumGlibcVersion,
    neededLibraries: expectedLibraries,
    resolvedLibraries: expectedLibraries,
    commandCount,
    validated: true,
  };
}

function readLinuxLauncherIdentityReceipt(
  value: unknown,
  label: string,
): BundledCodexLinuxLauncherIdentityReceipt {
  const launcher = objectEntry(value, label);
  const executableFile = stringField(launcher, "executableFile", label);
  const executableSize = numberField(launcher, "executableSize", label);
  const executableSha256 = stringField(launcher, "executableSha256", label);
  const runtimeVersion = stringField(launcher, "runtimeVersion", label);
  const outputBytes = numberField(launcher, "outputBytes", label);
  const outputSha256 = stringField(launcher, "outputSha256", label);
  assertReceiptLogicalPath(executableFile, `${label}.executableFile`);
  const expectedOutput = `v${runtimeVersion}`;
  if (
    executableFile !== "moss" ||
    executableSize <= APPIMAGE_ELF_HEADER_BYTES ||
    !SHA256.test(executableSha256) ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(runtimeVersion) ||
    !isDeepStrictEqual(launcher.arguments, ["--version"]) ||
    outputBytes !== Buffer.byteLength(expectedOutput, "utf8") ||
    outputSha256 !== Crypto.createHash("sha256").update(expectedOutput, "utf8").digest("hex") ||
    launcher.validated !== true
  ) {
    throw new Error(`Bundled Codex release receipt ${label} is not a valid launcher identity.`);
  }
  return {
    executableFile,
    executableSize,
    executableSha256,
    arguments: ["--version"],
    runtimeVersion,
    outputBytes,
    outputSha256,
    validated: true,
  };
}

function assertLinuxFinalInstallableBound(input: {
  readonly finalInstallable: JsonRecord;
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
  readonly packagedCompliance: unknown;
  readonly linuxRuntime: unknown;
  readonly linuxLauncher: unknown;
}): void {
  const appImages = input.artifacts.filter((artifact) =>
    artifact.fileName.toLowerCase().endsWith(".appimage"),
  );
  const appImageFileName = stringField(
    input.finalInstallable,
    "appImageFileName",
    "verification.finalInstallable",
  );
  const appImageSize = numberField(
    input.finalInstallable,
    "appImageSize",
    "verification.finalInstallable",
  );
  const appImageSha256 = stringField(
    input.finalInstallable,
    "appImageSha256",
    "verification.finalInstallable",
  );
  const appImage = appImages[0];
  if (
    input.finalInstallable.platform !== "linux" ||
    input.finalInstallable.extractionValidated !== true ||
    appImages.length !== 1 ||
    !appImage ||
    appImage.fileName !== appImageFileName ||
    appImage.size !== appImageSize ||
    appImage.sha256 !== appImageSha256
  ) {
    throw new Error(
      "Bundled Codex final installable Linux proof is not bound to the copied AppImage.",
    );
  }
  const container = objectEntry(
    input.finalInstallable.container,
    "verification.finalInstallable.container",
  );
  const squashfsOffset = numberField(
    container,
    "squashfsOffset",
    "verification.finalInstallable.container",
  );
  const squashfsBytesUsed = numberField(
    container,
    "squashfsBytesUsed",
    "verification.finalInstallable.container",
  );
  if (
    container.format !== "AppImage-type-2" ||
    container.elfClass !== "ELF64" ||
    container.machine !== "x86_64" ||
    container.squashfsVersion !== "4.0" ||
    container.extractor !== BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID ||
    container.validated !== true ||
    squashfsOffset < APPIMAGE_ELF_HEADER_BYTES ||
    squashfsBytesUsed < SQUASHFS_SUPERBLOCK_BYTES ||
    squashfsOffset + squashfsBytesUsed > appImageSize
  ) {
    throw new Error("Bundled Codex final AppImage container proof is invalid.");
  }
  const extractedClosure = objectEntry(
    input.finalInstallable.extractedClosure,
    "verification.finalInstallable.extractedClosure",
  );
  assertExactReceiptComplianceEvidence(
    extractedClosure.compliance,
    "verification.finalInstallable.extractedClosure.compliance",
  );
  if (!isDeepStrictEqual(extractedClosure.compliance, input.packagedCompliance)) {
    throw new Error(
      "Bundled Codex final AppImage compliance closure does not match the packaged closure.",
    );
  }
  const payload = objectEntry(
    extractedClosure.payload,
    "verification.finalInstallable.extractedClosure.payload",
  );
  if (
    payload.mode !== "exact-final-payload-hashes" ||
    payload.validated !== true ||
    !isDeepStrictEqual(payload.targetTriples, [LINUX_PUBLIC_TARGET_TRIPLE])
  ) {
    throw new Error("Bundled Codex final AppImage exact payload closure is invalid.");
  }
  const finalRuntime = readLinuxRuntimeReceipt(
    extractedClosure.runtime,
    "verification.finalInstallable.extractedClosure.runtime",
  );
  const packagedRuntime = readLinuxRuntimeReceipt(input.linuxRuntime, "verification.linuxRuntime");
  if (
    !isDeepStrictEqual(
      {
        targetTriple: finalRuntime.targetTriple,
        maximumGlibcVersion: finalRuntime.maximumGlibcVersion,
        neededLibraries: finalRuntime.neededLibraries,
        resolvedLibraries: finalRuntime.resolvedLibraries,
      },
      {
        targetTriple: packagedRuntime.targetTriple,
        maximumGlibcVersion: packagedRuntime.maximumGlibcVersion,
        neededLibraries: packagedRuntime.neededLibraries,
        resolvedLibraries: packagedRuntime.resolvedLibraries,
      },
    )
  ) {
    throw new Error(
      "Bundled Codex final AppImage runtime closure does not match the packaged closure.",
    );
  }
  const startup = readLinuxLauncherIdentityReceipt(
    extractedClosure.startup,
    "verification.finalInstallable.extractedClosure.startup",
  );
  const packagedLauncher = readLinuxLauncherIdentityReceipt(
    input.linuxLauncher,
    "verification.linuxLauncher",
  );
  if (!isDeepStrictEqual(startup, packagedLauncher)) {
    throw new Error(
      "Bundled Codex final AppImage launcher identity does not match the packaged launcher.",
    );
  }
}

function deriveBundledCodexPublishEligibility(input: {
  readonly platform: BundledCodexReleaseReceipt["platform"];
  readonly arch: BundledCodexReleaseReceipt["arch"];
  readonly releaseMode: BundledCodexReleaseReceipt["releaseMode"];
  readonly signed: boolean;
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
  readonly verification: JsonRecord;
}): boolean {
  if (
    input.verification.complianceBundleRootSha256 !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256
  ) {
    throw new Error(
      "Bundled Codex release receipt is missing the exact compliance bundle root SHA-256.",
    );
  }
  assertExactReceiptComplianceEvidence(
    input.verification.packagedCompliance,
    "verification.packagedCompliance",
  );
  const packagedPayload = objectEntry(
    input.verification.packagedPayload,
    "verification.packagedPayload",
  );
  let signedPayload: BundledCodexReceiptPayloadBinding | null = null;
  if (input.signed) {
    if (packagedPayload.mode !== "signed-canonical-binding") {
      throw new Error("Bundled Codex release receipt is missing signed payload binding evidence.");
    }
    signedPayload = readReceiptSignedPayloadBinding(
      packagedPayload,
      "verification.packagedPayload",
    );
  } else if (input.platform === "mac" && input.releaseMode === "build-only") {
    if (packagedPayload.mode !== "signed-canonical-binding") {
      throw new Error(
        "Bundled Codex macOS build-only canonical payload is missing signed content binding evidence.",
      );
    }
    signedPayload = readReceiptSignedPayloadBinding(
      packagedPayload,
      "verification.packagedPayload",
    );
    assertMacBuildOnlySignatureProvenance(input.verification.macBuildOnlySignature, input.arch);
  } else if (
    packagedPayload.mode !== "exact-final-payload-hashes" ||
    packagedPayload.validated !== true
  ) {
    throw new Error("Bundled Codex release receipt is missing exact final payload hash evidence.");
  }
  if (input.releaseMode !== "publish") return false;

  if (input.platform === "linux") {
    readLinuxRuntimeReceipt(input.verification.linuxRuntime, "verification.linuxRuntime");
    readLinuxLauncherIdentityReceipt(
      input.verification.linuxLauncher,
      "verification.linuxLauncher",
    );
    const finalInstallable = objectEntry(
      input.verification.finalInstallable,
      "verification.finalInstallable",
    );
    assertLinuxFinalInstallableBound({
      finalInstallable,
      artifacts: input.artifacts,
      packagedCompliance: input.verification.packagedCompliance,
      linuxRuntime: input.verification.linuxRuntime,
      linuxLauncher: input.verification.linuxLauncher,
    });
    return input.arch === "x64" && !input.signed;
  }

  if (!input.signed || !signedPayload) return false;
  const finalInstallable = objectEntry(
    input.verification.finalInstallable,
    "verification.finalInstallable",
  );
  if (input.platform === "mac") {
    assertMacFinalInstallableBound({
      finalInstallable,
      artifacts: input.artifacts,
      packagedPayload: signedPayload,
      expectedArch: input.arch,
    });
  } else {
    assertWindowsFinalInstallableBound({
      finalInstallable,
      artifacts: input.artifacts,
      packagedPayload: signedPayload,
    });
  }
  return true;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = FS.openSync(directory, FS.constants.O_RDONLY);
    FS.fsyncSync(descriptor);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EPERM")) throw cause;
  } finally {
    if (descriptor !== undefined) FS.closeSync(descriptor);
  }
}

function writeBufferNoReplace(input: {
  readonly outputDirectory: string;
  readonly targetPath: string;
  readonly bytes: Buffer;
  readonly mode: number;
}): void {
  if (FS.existsSync(input.targetPath)) {
    throw new Error(
      `Bundled Codex release target already exists: ${Path.basename(input.targetPath)}.`,
    );
  }
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  const temporaryPath = Path.join(
    input.outputDirectory,
    `.moss-codex-release-${process.pid}-${Crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = FS.openSync(
      temporaryPath,
      FS.constants.O_WRONLY | FS.constants.O_CREAT | FS.constants.O_EXCL | noFollow,
      0o600,
    );
    FS.writeFileSync(descriptor, input.bytes);
    FS.fsyncSync(descriptor);
    FS.fchmodSync(descriptor, input.mode);
    FS.closeSync(descriptor);
    descriptor = undefined;
    try {
      FS.linkSync(temporaryPath, input.targetPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Bundled Codex release target already exists: ${Path.basename(input.targetPath)}.`,
          { cause },
        );
      }
      throw cause;
    }
    FS.unlinkSync(temporaryPath);
    fsyncDirectory(input.outputDirectory);
  } finally {
    if (descriptor !== undefined) FS.closeSync(descriptor);
    FS.rmSync(temporaryPath, { force: true });
  }
}

function copyDigestNoReplace(input: {
  readonly source: ImmutableFileDigest;
  readonly outputDirectory: string;
  readonly targetPath: string;
  readonly mode?: number;
}): ImmutableFileDigest {
  if (FS.existsSync(input.targetPath)) {
    throw new Error(
      `Bundled Codex release target already exists: ${Path.basename(input.targetPath)}.`,
    );
  }
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  const temporaryPath = Path.join(
    input.outputDirectory,
    `.moss-codex-copy-${process.pid}-${Crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = FS.openSync(
      temporaryPath,
      FS.constants.O_WRONLY | FS.constants.O_CREAT | FS.constants.O_EXCL | noFollow,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < input.source.size) {
      const read = FS.readSync(
        input.source.descriptor,
        buffer,
        0,
        Math.min(buffer.length, input.source.size - offset),
        offset,
      );
      if (read === 0) {
        throw new Error(
          `Bundled Codex release source changed while copying ${input.source.label}.`,
        );
      }
      let written = 0;
      while (written < read) {
        written += FS.writeSync(descriptor, buffer, written, read - written);
      }
      offset += read;
    }
    FS.fsyncSync(descriptor);
    FS.fchmodSync(descriptor, input.mode ?? Number(input.source.identity.mode & 0o777n));
    FS.closeSync(descriptor);
    descriptor = undefined;
    try {
      FS.linkSync(temporaryPath, input.targetPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Bundled Codex release target already exists: ${Path.basename(input.targetPath)}.`,
          { cause },
        );
      }
      throw cause;
    }
    FS.unlinkSync(temporaryPath);
    fsyncDirectory(input.outputDirectory);
    const target = openImmutableFileDigest(
      input.targetPath,
      `copied release artifact ${Path.basename(input.targetPath)}`,
    );
    if (target.size !== input.source.size || target.sha256 !== input.source.sha256) {
      closeImmutableFileDigest(target);
      throw new Error(
        `Bundled Codex copied release artifact SHA-256/size mismatch for ${Path.basename(input.targetPath)}.`,
      );
    }
    assertImmutableFileDigestCurrent(input.source);
    return target;
  } finally {
    if (descriptor !== undefined) FS.closeSync(descriptor);
    FS.rmSync(temporaryPath, { force: true });
  }
}

export function copyBundledCodexReleaseArtifactsAndWriteReceipt(input: {
  readonly stageDistDir: string;
  readonly outputDir: string;
  readonly platform: BundledCodexReleaseReceipt["platform"];
  readonly arch: BundledCodexReleaseReceipt["arch"];
  readonly releaseMode: BundledCodexReleaseReceipt["releaseMode"];
  readonly signed: boolean;
  readonly expectedVersion: string;
  readonly verification: JsonRecord;
  readonly linuxFinalVerifier?: BundledCodexLinuxFinalInstallableVerifier;
}): {
  readonly receiptPath: string;
  readonly receipt: BundledCodexReleaseReceipt;
} {
  assertBundledCodexComplianceVersion(input.expectedVersion);
  requirePlainDirectory(input.stageDistDir, "release staging directory");
  FS.mkdirSync(input.outputDir, { recursive: true, mode: 0o755 });
  requirePlainDirectory(input.outputDir, "release output directory");
  assertReceiptSafeJson(input.verification);

  const sourceNames = FS.readdirSync(input.stageDistDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      if (
        Path.basename(entry.name) !== entry.name ||
        entry.name.includes("\\") ||
        entry.name.includes("\0") ||
        entry.name.includes("\r") ||
        entry.name.includes("\n")
      ) {
        throw new Error(`Bundled Codex release staging contains invalid file ${entry.name}.`);
      }
      return entry.name;
    })
    .toSorted(compareUtf8Bytes);
  if (sourceNames.length === 0) {
    throw new Error("Bundled Codex release staging contains no artifact files.");
  }
  const createdTargets: string[] = [];
  const sourceDigests: ImmutableFileDigest[] = [];
  const targetDigests: ImmutableFileDigest[] = [];
  try {
    const artifacts: BundledCodexReleaseArtifactReceipt[] = [];
    for (const fileName of sourceNames) {
      const source = openImmutableFileDigest(
        Path.join(input.stageDistDir, fileName),
        `staged release artifact ${fileName}`,
      );
      sourceDigests.push(source);
      const targetPath = Path.join(input.outputDir, fileName);
      const target = copyDigestNoReplace({
        source,
        outputDirectory: input.outputDir,
        targetPath,
      });
      targetDigests.push(target);
      createdTargets.push(targetPath);
      artifacts.push({ fileName, size: target.size, sha256: target.sha256 });
    }
    for (const digest of [...sourceDigests, ...targetDigests]) {
      assertImmutableFileDigestCurrent(digest);
    }
    const publishEligible = deriveBundledCodexPublishEligibility({
      platform: input.platform,
      arch: input.arch,
      releaseMode: input.releaseMode,
      signed: input.signed,
      artifacts,
      verification: input.verification,
    });
    if (input.releaseMode === "publish" && !publishEligible) {
      throw new Error(
        "Bundled Codex publish receipt is not backed by the required final installable verification.",
      );
    }
    const receipt: BundledCodexReleaseReceipt = {
      schemaVersion: 1,
      kind: "moss-bundled-codex-release-receipt",
      platform: input.platform,
      arch: input.arch,
      releaseMode: input.releaseMode,
      signed: input.signed,
      publishEligible,
      bundledCodexVersion: input.expectedVersion,
      complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
      artifacts,
      verification: input.verification,
    };
    const receiptFileName = `moss-bundled-codex-release-receipt-${input.platform}-${input.arch}.json`;
    const receiptPath = Path.join(input.outputDir, receiptFileName);
    writeBufferNoReplace({
      outputDirectory: input.outputDir,
      targetPath: receiptPath,
      bytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
      mode: 0o644,
    });
    createdTargets.push(receiptPath);
    const verified = verifyBundledCodexReleaseReceipt({
      outputDir: input.outputDir,
      expectedPlatform: input.platform,
      expectedArch: input.arch,
      requirePublishEligible: input.releaseMode === "publish",
      ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
    });
    if (!isDeepStrictEqual(verified, receipt)) {
      throw new Error("Bundled Codex persisted release receipt changed after it was written.");
    }
    return { receiptPath, receipt };
  } catch (cause) {
    for (const targetPath of createdTargets.toReversed()) FS.rmSync(targetPath, { force: true });
    throw cause;
  } finally {
    for (const digest of [...sourceDigests, ...targetDigests]) closeImmutableFileDigest(digest);
  }
}

export function verifyBundledCodexReleaseReceipt(input: {
  readonly outputDir: string;
  readonly expectedPlatform: BundledCodexReleaseReceipt["platform"];
  readonly expectedArch: BundledCodexReleaseReceipt["arch"];
  readonly requirePublishEligible: boolean;
  readonly linuxFinalVerifier?: BundledCodexLinuxFinalInstallableVerifier;
}): BundledCodexReleaseReceipt {
  requirePlainDirectory(input.outputDir, "release receipt output directory");
  const receiptFileName = `moss-bundled-codex-release-receipt-${input.expectedPlatform}-${input.expectedArch}.json`;
  const receiptSnapshot = openImmutableFileSnapshot(
    Path.join(input.outputDir, receiptFileName),
    `release receipt ${receiptFileName}`,
  );
  const artifactDigests: ImmutableFileDigest[] = [];
  try {
    let value: unknown;
    try {
      value = JSON.parse(receiptSnapshot.bytes.toString("utf8"));
    } catch (cause) {
      throw new Error("Bundled Codex release receipt is not valid JSON.", { cause });
    }
    const receipt = objectEntry(value, "release receipt");
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "moss-bundled-codex-release-receipt" ||
      receipt.platform !== input.expectedPlatform ||
      receipt.arch !== input.expectedArch ||
      (receipt.releaseMode !== "build-only" && receipt.releaseMode !== "publish") ||
      typeof receipt.signed !== "boolean" ||
      typeof receipt.publishEligible !== "boolean" ||
      receipt.bundledCodexVersion !== BUNDLED_CODEX_COMPLIANCE_VERSION ||
      receipt.complianceBundleRootSha256 !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256 ||
      !Array.isArray(receipt.artifacts) ||
      !receipt.verification ||
      typeof receipt.verification !== "object" ||
      Array.isArray(receipt.verification)
    ) {
      throw new Error("Bundled Codex release receipt metadata is invalid.");
    }
    if (
      input.requirePublishEligible &&
      (receipt.releaseMode !== "publish" || receipt.publishEligible !== true)
    ) {
      throw new Error("Bundled Codex release receipt is not publish eligible.");
    }
    assertReceiptSafeJson(receipt.verification);
    assertBundledClaudeReleaseVerificationReceipt({
      value: (receipt.verification as Record<string, unknown>).bundledClaude,
      expectedPlatform: input.expectedPlatform,
      expectedArch: input.expectedArch,
    });
    const seen = new Set<string>();
    const artifacts: BundledCodexReleaseArtifactReceipt[] = [];
    for (const [index, artifactValue] of receipt.artifacts.entries()) {
      const artifact = objectEntry(artifactValue, `release receipt artifacts[${index}]`);
      const fileName = stringField(artifact, "fileName", `release receipt artifacts[${index}]`);
      const size = numberField(artifact, "size", `release receipt artifacts[${index}]`);
      const sha256 = stringField(artifact, "sha256", `release receipt artifacts[${index}]`);
      if (
        Path.basename(fileName) !== fileName ||
        fileName.includes("\\") ||
        fileName.includes("\0") ||
        fileName.includes("\r") ||
        fileName.includes("\n") ||
        seen.has(fileName) ||
        !SHA256.test(sha256)
      ) {
        throw new Error(`Bundled Codex release receipt has invalid artifact ${fileName}.`);
      }
      seen.add(fileName);
      const digest = openImmutableFileDigest(
        Path.join(input.outputDir, fileName),
        `receipt artifact ${fileName}`,
      );
      artifactDigests.push(digest);
      if (digest.size !== size || digest.sha256 !== sha256) {
        throw new Error(`Bundled Codex release artifact SHA-256/size mismatch for ${fileName}.`);
      }
      artifacts.push({ fileName, size, sha256 });
    }
    if (seen.size === 0) {
      throw new Error("Bundled Codex release receipt contains no artifacts.");
    }
    const verificationRecord = receipt.verification as Record<string, unknown>;
    if (receipt.platform === "mac" && verificationRecord.finalInstallable !== undefined) {
      assertMacFinalClaudeInstallableBound({
        finalInstallable: objectEntry(
          verificationRecord.finalInstallable,
          "verification.finalInstallable",
        ),
        artifacts,
        expectedArch: receipt.arch as "arm64" | "x64" | "universal",
      });
    }
    if (
      !isDeepStrictEqual(
        artifacts.map((artifact) => artifact.fileName),
        artifacts.map((artifact) => artifact.fileName).toSorted(compareUtf8Bytes),
      )
    ) {
      throw new Error("Bundled Codex release receipt artifact inventory is not bytewise sorted.");
    }
    const expectedOutputNames = [
      receiptFileName,
      ...artifacts.map((artifact) => artifact.fileName),
    ].toSorted(compareUtf8Bytes);
    const actualOutputNames = FS.readdirSync(input.outputDir, { withFileTypes: true })
      .map((entry) => {
        if (!entry.isFile()) {
          throw new Error(
            `Bundled Codex release output contains an unreceipted non-file entry ${entry.name}.`,
          );
        }
        return entry.name;
      })
      .toSorted(compareUtf8Bytes);
    if (!isDeepStrictEqual(actualOutputNames, expectedOutputNames)) {
      throw new Error(
        "Bundled Codex release output inventory contains unreceipted or missing files.",
      );
    }
    const derivedPublishEligible = deriveBundledCodexPublishEligibility({
      platform: receipt.platform as BundledCodexReleaseReceipt["platform"],
      arch: receipt.arch as BundledCodexReleaseReceipt["arch"],
      releaseMode: receipt.releaseMode,
      signed: receipt.signed,
      artifacts,
      verification: receipt.verification as JsonRecord,
    });
    if (receipt.publishEligible !== derivedPublishEligible) {
      throw new Error(
        "Bundled Codex release receipt publish eligibility does not match its verification evidence.",
      );
    }
    if (
      receipt.platform === "linux" &&
      receipt.releaseMode === "publish" &&
      receipt.publishEligible === true
    ) {
      const appImage = artifacts.find((artifact) =>
        artifact.fileName.toLowerCase().endsWith(".appimage"),
      );
      if (!appImage) {
        throw new Error("Bundled Codex publish receipt is missing its final AppImage.");
      }
      const expectedLauncher = readLinuxLauncherIdentityReceipt(
        (receipt.verification as JsonRecord).linuxLauncher,
        "verification.linuxLauncher",
      );
      const linuxFinalVerifier: BundledCodexLinuxFinalInstallableVerifier =
        input.linuxFinalVerifier ??
        ((verificationInput) =>
          verifyFinalBundledCodexLinuxAppImage({
            stageDistDir: verificationInput.stageDistDir,
            expectedVersion: BUNDLED_CODEX_COMPLIANCE_VERSION,
            targetTriples: [LINUX_PUBLIC_TARGET_TRIPLE],
            expectedMainExecutableName: "moss",
            expectedAppImageFileName: verificationInput.appImageFileName,
            expectedLauncher: verificationInput.expectedLauncher,
          }));
      const reverified = linuxFinalVerifier({
        stageDistDir: input.outputDir,
        appImageFileName: appImage.fileName,
        expectedLauncher,
      });
      if (!isDeepStrictEqual(reverified, (receipt.verification as JsonRecord).finalInstallable)) {
        throw new Error(
          "Bundled Codex final AppImage re-verification does not match its receipted closure.",
        );
      }
    }
    for (const digest of artifactDigests) assertImmutableFileDigestCurrent(digest);
    assertImmutableFileSnapshotCurrent(receiptSnapshot);
    return receipt as unknown as BundledCodexReleaseReceipt;
  } finally {
    for (const digest of artifactDigests) closeImmutableFileDigest(digest);
    closeImmutableFileSnapshot(receiptSnapshot);
  }
}

function isPublicBundledCodexReleaseAsset(fileName: string): boolean {
  return (
    /\.(?:appimage|blockmap|dmg|exe|zip)$/iu.test(fileName) ||
    /^latest(?:-[a-z0-9-]+)?\.ya?ml$/iu.test(fileName)
  );
}

export function promoteBundledCodexReleaseArtifacts(input: {
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly expectedPlatform: BundledCodexReleaseReceipt["platform"];
  readonly expectedArch: BundledCodexReleaseReceipt["arch"];
  readonly requirePublishEligible: boolean;
  readonly artifactRenames?: Readonly<Record<string, string>>;
  readonly linuxFinalVerifier?: BundledCodexLinuxFinalInstallableVerifier;
}): {
  readonly receiptPath: string;
  readonly receipt: BundledCodexReleaseReceipt;
} {
  const sourceReceipt = verifyBundledCodexReleaseReceipt({
    outputDir: input.sourceDir,
    expectedPlatform: input.expectedPlatform,
    expectedArch: input.expectedArch,
    requirePublishEligible: input.requirePublishEligible,
    ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
  });
  if (FS.existsSync(input.outputDir)) {
    requirePlainDirectory(input.outputDir, "release promotion output directory");
    if (FS.readdirSync(input.outputDir).length !== 0) {
      throw new Error("Bundled Codex release promotion output directory must be empty.");
    }
  }
  const publicArtifacts = sourceReceipt.artifacts.filter((artifact) =>
    isPublicBundledCodexReleaseAsset(artifact.fileName),
  );
  if (publicArtifacts.length === 0) {
    throw new Error("Bundled Codex release promotion found no public artifact files.");
  }
  const publicNames = new Set(publicArtifacts.map((artifact) => artifact.fileName));
  const renames = new Map<string, string>();
  for (const [sourceName, targetName] of Object.entries(input.artifactRenames ?? {})) {
    if (
      !publicNames.has(sourceName) ||
      !/^latest(?:-[a-z0-9-]+)?\.ya?ml$/iu.test(sourceName) ||
      !/^latest(?:-[a-z0-9-]+)?\.ya?ml$/iu.test(targetName) ||
      Path.basename(targetName) !== targetName ||
      targetName.includes("\\")
    ) {
      throw new Error(
        `Bundled Codex release promotion has an invalid manifest rename ${sourceName} -> ${targetName}.`,
      );
    }
    renames.set(sourceName, targetName);
  }
  const promotedNames = publicArtifacts.map(
    (artifact) => renames.get(artifact.fileName) ?? artifact.fileName,
  );
  if (new Set(promotedNames).size !== promotedNames.length) {
    throw new Error("Bundled Codex release promotion contains a target-name collision.");
  }

  const temporaryRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-promotion-"));
  FS.chmodSync(temporaryRoot, 0o700);
  const sourceDigests: ImmutableFileDigest[] = [];
  const stagedDigests: ImmutableFileDigest[] = [];
  try {
    for (const artifact of publicArtifacts) {
      const source = openImmutableFileDigest(
        Path.join(input.sourceDir, artifact.fileName),
        `promotion source artifact ${artifact.fileName}`,
      );
      sourceDigests.push(source);
      if (source.size !== artifact.size || source.sha256 !== artifact.sha256) {
        throw new Error(
          `Bundled Codex release promotion source SHA-256/size mismatch for ${artifact.fileName}.`,
        );
      }
      stagedDigests.push(
        copyDigestNoReplace({
          source,
          outputDirectory: temporaryRoot,
          targetPath: Path.join(temporaryRoot, renames.get(artifact.fileName) ?? artifact.fileName),
        }),
      );
    }
    const promoted = copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir: temporaryRoot,
      outputDir: input.outputDir,
      platform: sourceReceipt.platform,
      arch: sourceReceipt.arch,
      releaseMode: sourceReceipt.releaseMode,
      signed: sourceReceipt.signed,
      expectedVersion: sourceReceipt.bundledCodexVersion,
      verification: sourceReceipt.verification,
      ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
    });
    for (const digest of [...sourceDigests, ...stagedDigests]) {
      assertImmutableFileDigestCurrent(digest);
    }
    const reverified = verifyBundledCodexReleaseReceipt({
      outputDir: input.outputDir,
      expectedPlatform: input.expectedPlatform,
      expectedArch: input.expectedArch,
      requirePublishEligible: input.requirePublishEligible,
      ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
    });
    if (!isDeepStrictEqual(reverified, promoted.receipt)) {
      throw new Error("Bundled Codex promoted release receipt changed after final verification.");
    }
    return promoted;
  } finally {
    for (const digest of [...stagedDigests, ...sourceDigests]) closeImmutableFileDigest(digest);
    FS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function validateBundledCodexLinuxX64PublicRuntime(input: {
  readonly resourcesDir: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexLinuxPublicRuntimeReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const hostArch = input.hostArch ?? process.arch;
  if (hostPlatform !== "linux" || hostArch !== "x64") {
    throw new Error(
      `Bundled Codex public Linux verification requires a native linux/x64 host, found ${hostPlatform}/${hostArch}.`,
    );
  }
  const runtimeRoot = Path.join(input.resourcesDir, "codex-runtime", LINUX_PUBLIC_TARGET_TRIPLE);
  requirePlainDirectory(runtimeRoot, `public Linux runtime ${LINUX_PUBLIC_TARGET_TRIPLE}`);
  for (const relativePath of LINUX_PUBLIC_EXECUTABLES) {
    const executablePath = Path.join(runtimeRoot, relativePath);
    requirePlainFile(executablePath, `${LINUX_PUBLIC_TARGET_TRIPLE}/${relativePath}`);
    try {
      FS.accessSync(executablePath, FS.constants.X_OK);
    } catch {
      throw new Error(`Bundled Codex public Linux X_OK validation failed for ${relativePath}.`);
    }
  }

  const runCommand = input.runCommand ?? runBundledCodexCommand;
  const commands: string[] = [];
  const run = (command: string, args: readonly string[], label: string) => {
    const result = runRequiredBundledCodexCommand({ command, args, label, runCommand });
    commands.push(result.command);
    return result.stdout;
  };
  const codexPath = Path.join(runtimeRoot, "bin/codex");
  const voiceHostPath = Path.join(runtimeRoot, "codex-resources/voice/bin/codex-voice-host");
  const codexVersion = run(codexPath, ["--version"], "version probe").trim();
  if (codexVersion !== `codex-cli ${CODEX_VERSION}`) {
    throw new Error(
      `Bundled Codex version probe mismatch: expected codex-cli ${CODEX_VERSION}, found ${codexVersion || "empty output"}.`,
    );
  }
  const modelCatalog = run(codexPath, ["debug", "models", "--bundled"], "bundled model catalog");
  if (!modelCatalog.includes('"models"')) {
    throw new Error("Bundled Codex model catalog smoke did not return a models list.");
  }

  const versionInfo = run(
    "/usr/bin/readelf",
    ["--version-info", voiceHostPath],
    "readelf GLIBC probe",
  );
  const glibcVersions = [...versionInfo.matchAll(/GLIBC_(\d+)\.(\d+)/gu)].map(
    (match) => [Number(match[1]), Number(match[2])] as const,
  );
  if (glibcVersions.length === 0) {
    throw new Error("Bundled Codex readelf GLIBC probe found no version requirements.");
  }
  const maximumGlibc = glibcVersions.toSorted(compareVersionParts).at(-1)!;
  const maximumGlibcVersion = `${maximumGlibc[0]}.${maximumGlibc[1]}`;
  if (compareVersionParts(maximumGlibc, [2, 38]) > 0) {
    throw new Error(
      `Bundled Codex GLIBC requirement ${maximumGlibcVersion} exceeds the public maximum 2.38.`,
    );
  }

  const dynamic = run("/usr/bin/readelf", ["--dynamic", voiceHostPath], "readelf NEEDED probe");
  const neededLibraries = [...dynamic.matchAll(/\(NEEDED\)[^\n]*Shared library:\s*\[([^\]]+)\]/gu)]
    .map((match) => match[1]!)
    .toSorted(compareUtf8Bytes);
  const expectedLibraries = [...LINUX_PUBLIC_SHARED_LIBRARIES].toSorted(compareUtf8Bytes);
  if (JSON.stringify(neededLibraries) !== JSON.stringify(expectedLibraries)) {
    throw new Error(
      `Bundled Codex readelf NEEDED mismatch: expected ${expectedLibraries.join(", ")}; found ${neededLibraries.join(", ") || "none"}.`,
    );
  }

  const lddOutput = run("/usr/bin/ldd", [voiceHostPath], "ldd resolution probe");
  const resolvedLibraries: string[] = [];
  for (const library of expectedLibraries) {
    const resolution = new RegExp(
      `^\\s*${escapeRegularExpression(library)}\\s*=>\\s*(\\S+)`,
      "mu",
    ).exec(lddOutput)?.[1];
    if (!resolution || resolution === "not" || !Path.isAbsolute(resolution)) {
      throw new Error(`Bundled Codex ldd library ${library} is not resolved to an absolute path.`);
    }
    resolvedLibraries.push(library);
  }
  return {
    targetTriple: LINUX_PUBLIC_TARGET_TRIPLE,
    commands,
    maximumGlibcVersion,
    neededLibraries,
    resolvedLibraries: resolvedLibraries.toSorted(compareUtf8Bytes),
  };
}

export interface BundledCodexWindowsAuthenticodeReceipt {
  readonly executableFiles: readonly string[];
  readonly mainExecutableFile: string;
  readonly installerFile: string;
  readonly commands: readonly string[];
  readonly publisherName: string;
  readonly certificateIdentity: {
    readonly subjectDn: string;
    readonly thumbprint: string;
    readonly issuerDn: string;
    readonly serialNumber: string;
  };
  readonly signatures: readonly {
    readonly file: string;
    readonly size: number;
    readonly sha256: string;
    readonly status: "Valid";
    readonly signatureType: "Authenticode";
    readonly timestamp: {
      readonly subjectDn: string;
      readonly thumbprint: string;
      readonly serialNumber: string;
      readonly notBeforeUtc: string;
      readonly notAfterUtc: string;
      readonly signtoolVerified: true;
    };
  }[];
}

export function verifyPackagedBundledCodexWindowsAuthenticode(input: {
  readonly stageDistDir: string;
  readonly resourcesDir: string;
  readonly targetTriples: readonly string[];
  readonly expectedMainExecutableName: string;
  readonly expectedInstallerFileName: string;
  readonly expectedPublisherName: string;
  readonly expectedCertificateSubjectDn: string;
  readonly expectedCertificateThumbprint: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexWindowsAuthenticodeReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "win32") {
    throw new Error(
      `Bundled Codex Authenticode verification requires a Windows host, found ${hostPlatform}.`,
    );
  }
  const publisherName = input.expectedPublisherName.trim();
  if (!publisherName) {
    throw new Error("Bundled Codex Authenticode verification requires an expected publisher name.");
  }
  const expectedCertificateSubjectDn = input.expectedCertificateSubjectDn.trim();
  const expectedCertificateThumbprint = input.expectedCertificateThumbprint
    .replaceAll(/\s/gu, "")
    .toUpperCase();
  if (
    !expectedCertificateSubjectDn ||
    expectedCertificateSubjectDn !== input.expectedCertificateSubjectDn ||
    !/^[A-F0-9]{40}$/u.test(expectedCertificateThumbprint)
  ) {
    throw new Error(
      "Bundled Codex Authenticode verification requires an exact certificate subject DN and 40-hex thumbprint.",
    );
  }
  requirePlainDirectory(input.stageDistDir, "Windows artifact dist directory");
  requirePlainDirectory(input.resourcesDir, "Windows packaged resources directory");
  const validateExecutableName = (value: string, label: string): string => {
    const name = value.trim();
    if (
      !name ||
      name !== value ||
      Path.basename(name) !== name ||
      name.includes("/") ||
      name.includes("\\") ||
      !name.toLowerCase().endsWith(".exe")
    ) {
      throw new Error(`Bundled Codex Authenticode verification has invalid ${label} ${value}.`);
    }
    return name;
  };
  const mainExecutableName = validateExecutableName(
    input.expectedMainExecutableName,
    "main executable name",
  );
  const installerFileName = validateExecutableName(
    input.expectedInstallerFileName,
    "installer file name",
  );
  const unpackedRoot = Path.dirname(input.resourcesDir);
  requirePlainDirectory(unpackedRoot, "Windows unpacked application directory");
  const mainExecutablePath = Path.join(unpackedRoot, mainExecutableName);
  requirePlainFile(mainExecutablePath, `main executable ${mainExecutableName}`);

  const installerNames = FS.readdirSync(input.stageDistDir, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `Bundled Codex Windows installer ${entry.name} must be a plain regular file.`,
        );
      }
      return entry.name;
    })
    .toSorted(compareUtf8Bytes);
  if (installerNames.length !== 1 || installerNames[0] !== installerFileName) {
    throw new Error(
      `Bundled Codex Windows installer inventory must contain exactly one ${installerFileName}; found ${installerNames.join(", ") || "none"}.`,
    );
  }
  const installerPath = Path.join(input.stageDistDir, installerFileName);
  requirePlainFile(installerPath, `installer ${installerFileName}`);

  const executables: { readonly path: string; readonly file: string }[] = [
    { path: mainExecutablePath, file: `app/${mainExecutableName}` },
    { path: installerPath, file: `installer/${installerFileName}` },
  ];
  for (const targetTriple of input.targetTriples) {
    const archiveId =
      TARGET_TRIPLE_TO_ARCHIVE[targetTriple as keyof typeof TARGET_TRIPLE_TO_ARCHIVE];
    if (!archiveId?.startsWith("win32-")) {
      throw new Error(
        `Bundled Codex Authenticode verification received non-Windows target ${targetTriple}.`,
      );
    }
    const runtimeRoot = Path.join(input.resourcesDir, "codex-runtime", targetTriple);
    const actualExePaths = listPlainRelativeFiles(runtimeRoot, `Windows runtime ${targetTriple}`)
      .filter((relativePath) => relativePath.toLowerCase().endsWith(".exe"))
      .toSorted(compareUtf8Bytes);
    const expectedExePaths = REQUIRED_PAYLOAD_SUFFIXES[archiveId]
      .filter((relativePath) => relativePath.endsWith(".exe"))
      .toSorted(compareUtf8Bytes);
    if (JSON.stringify(actualExePaths) !== JSON.stringify(expectedExePaths)) {
      const missing = expectedExePaths.filter(
        (relativePath) => !actualExePaths.includes(relativePath),
      );
      throw new Error(
        `Bundled Codex Windows runtime EXE inventory mismatch for ${targetTriple}; missing ${missing.join(", ") || "none"}.`,
      );
    }
    executables.push(
      ...actualExePaths.map((relativePath) => ({
        path: Path.join(runtimeRoot, relativePath),
        file: `app/resources/codex-runtime/${targetTriple}/${relativePath}`,
      })),
    );
  }
  if (executables.length === 0) {
    throw new Error("Bundled Codex Authenticode verification found no runtime executables.");
  }
  const sourceDigests: ImmutableFileDigest[] = [];
  const privateDigests: ImmutableFileDigest[] = [];
  const temporaryRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-authenticode-"));
  FS.chmodSync(temporaryRoot, 0o700);
  try {
    const privateExecutables = executables.map((executable, index) => {
      const source = openImmutableFileDigest(
        executable.path,
        `Authenticode source ${executable.file}`,
      );
      sourceDigests.push(source);
      const privateDigest = copyDigestNoReplace({
        source,
        outputDirectory: temporaryRoot,
        targetPath: Path.join(temporaryRoot, `${String(index).padStart(4, "0")}.exe`),
      });
      privateDigests.push(privateDigest);
      return { ...executable, source, path: privateDigest.filePath };
    });
    const executablePaths = privateExecutables.map((executable) => executable.path);

    const powershellScript = [
      "$ErrorActionPreference = 'Stop'",
      "$paths = @(ConvertFrom-Json -InputObject $env:MOSS_CODEX_AUTHENTICODE_PATHS_JSON)",
      "$programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)",
      "if (-not [IO.Path]::IsPathFullyQualified($programFilesX86)) { throw 'Program Files (x86) is not absolute.' }",
      "$kitsRoot = Join-Path $programFilesX86 'Windows Kits\\10\\bin'",
      "$signtool = @(Get-ChildItem -Path (Join-Path $kitsRoot '*\\x64\\signtool.exe') -File -ErrorAction Stop | Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName)[0]",
      "if (-not $signtool -or -not [IO.Path]::IsPathFullyQualified($signtool) -or -not $signtool.StartsWith($kitsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'A trusted absolute Windows Kits signtool.exe was not found.' }",
      "$signatures = @($paths | ForEach-Object {",
      "  $verifyOutput = & $signtool verify /pa /all /v $_ 2>&1 | Out-String",
      '  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed for $($_): $verifyOutput" }',
      "  $signature = Get-AuthenticodeSignature -LiteralPath $_",
      '  if (-not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) { throw "Incomplete signer or timestamp certificate for $($_)." }',
      "  [pscustomobject]@{ path = $_; status = [string]$signature.Status; signatureType = [string]$signature.SignatureType; subjectDn = [string]$signature.SignerCertificate.Subject; thumbprint = [string]$signature.SignerCertificate.Thumbprint; issuerDn = [string]$signature.SignerCertificate.Issuer; serialNumber = [string]$signature.SignerCertificate.SerialNumber; timestampSubjectDn = [string]$signature.TimeStamperCertificate.Subject; timestampThumbprint = [string]$signature.TimeStamperCertificate.Thumbprint; timestampSerialNumber = [string]$signature.TimeStamperCertificate.SerialNumber; timestampNotBeforeUtc = $signature.TimeStamperCertificate.NotBefore.ToUniversalTime().ToString('o'); timestampNotAfterUtc = $signature.TimeStamperCertificate.NotAfter.ToUniversalTime().ToString('o'); signtoolVerified = $true; signtoolPath = [string]$signtool }",
      "})",
      "[pscustomobject]@{ signatures = $signatures } | ConvertTo-Json -Compress -Depth 4",
    ].join("\n");
    const env = {
      ...process.env,
      MOSS_CODEX_AUTHENTICODE_PATHS_JSON: JSON.stringify(executablePaths),
    };
    const result = runRequiredBundledCodexCommand({
      command: resolveWindowsPowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command", powershellScript],
      env,
      label: "Authenticode probe",
      runCommand: input.runCommand ?? runBundledCodexCommand,
    });
    let signatures: unknown;
    try {
      signatures = (JSON.parse(result.stdout) as { readonly signatures?: unknown }).signatures;
    } catch (cause) {
      throw new Error("Bundled Codex Authenticode probe returned invalid JSON.", { cause });
    }
    if (!Array.isArray(signatures) || signatures.length !== executablePaths.length) {
      throw new Error("Bundled Codex Authenticode probe returned incomplete signature evidence.");
    }
    const executableByPath = new Map(
      privateExecutables.map((executable) => [executable.path, executable] as const),
    );
    const seenPaths = new Set<string>();
    let certificateIdentity:
      | BundledCodexWindowsAuthenticodeReceipt["certificateIdentity"]
      | undefined;
    const signatureReceipts: BundledCodexWindowsAuthenticodeReceipt["signatures"][number][] = [];
    for (const [index, value] of signatures.entries()) {
      const signature = objectEntry(value, `Authenticode signatures[${index}]`);
      const executablePath = stringField(signature, "path", `Authenticode signatures[${index}]`);
      const status = stringField(signature, "status", `Authenticode signatures[${index}]`);
      const signatureType = stringField(
        signature,
        "signatureType",
        `Authenticode signatures[${index}]`,
      );
      const subjectDn = stringField(signature, "subjectDn", `Authenticode signatures[${index}]`);
      const thumbprint = stringField(signature, "thumbprint", `Authenticode signatures[${index}]`)
        .replaceAll(/\s/gu, "")
        .toUpperCase();
      const issuerDn = stringField(signature, "issuerDn", `Authenticode signatures[${index}]`);
      const serialNumber = stringField(
        signature,
        "serialNumber",
        `Authenticode signatures[${index}]`,
      );
      const timestampSubjectDn = stringField(
        signature,
        "timestampSubjectDn",
        `Authenticode signatures[${index}]`,
      );
      const timestampThumbprint = stringField(
        signature,
        "timestampThumbprint",
        `Authenticode signatures[${index}]`,
      )
        .replaceAll(/\s/gu, "")
        .toUpperCase();
      const timestampSerialNumber = stringField(
        signature,
        "timestampSerialNumber",
        `Authenticode signatures[${index}]`,
      );
      const timestampNotBeforeUtc = stringField(
        signature,
        "timestampNotBeforeUtc",
        `Authenticode signatures[${index}]`,
      );
      const timestampNotAfterUtc = stringField(
        signature,
        "timestampNotAfterUtc",
        `Authenticode signatures[${index}]`,
      );
      const signtoolPath = stringField(
        signature,
        "signtoolPath",
        `Authenticode signatures[${index}]`,
      );
      const signtoolVerified = signature.signtoolVerified;
      const executable = executableByPath.get(executablePath);
      if (!executable || seenPaths.has(executablePath)) {
        throw new Error(
          `Bundled Codex Authenticode probe returned unexpected path ${executablePath}.`,
        );
      }
      seenPaths.add(executablePath);
      if (status !== "Valid") {
        throw new Error(
          `Bundled Codex Authenticode status for ${executablePath} is ${status}, not Valid.`,
        );
      }
      if (
        signatureType !== "Authenticode" ||
        subjectDn !== expectedCertificateSubjectDn ||
        thumbprint !== expectedCertificateThumbprint
      ) {
        throw new Error(
          `Bundled Codex Authenticode certificate identity mismatch for ${executable.file}.`,
        );
      }
      const currentIdentity = { subjectDn, thumbprint, issuerDn, serialNumber };
      if (certificateIdentity && !isDeepStrictEqual(certificateIdentity, currentIdentity)) {
        throw new Error(
          `Bundled Codex Authenticode certificate identity changed across ${executable.file}.`,
        );
      }
      certificateIdentity = currentIdentity;
      if (
        signtoolVerified !== true ||
        !Path.win32.isAbsolute(signtoolPath) ||
        !/[\\/]Windows Kits[\\/]10[\\/]bin[\\/]/iu.test(signtoolPath) ||
        !/^[A-F0-9]{40}$/u.test(timestampThumbprint) ||
        !timestampSubjectDn.trim() ||
        !timestampSerialNumber.trim() ||
        !Number.isFinite(Date.parse(timestampNotBeforeUtc)) ||
        !Number.isFinite(Date.parse(timestampNotAfterUtc)) ||
        Date.parse(timestampNotBeforeUtc) >= Date.parse(timestampNotAfterUtc)
      ) {
        throw new Error(
          `Bundled Codex trusted Authenticode timestamp evidence is incomplete for ${executable.file}.`,
        );
      }
      signatureReceipts.push({
        file: executable.file,
        size: executable.source.size,
        sha256: executable.source.sha256,
        status: "Valid",
        signatureType: "Authenticode",
        timestamp: {
          subjectDn: timestampSubjectDn,
          thumbprint: timestampThumbprint,
          serialNumber: timestampSerialNumber,
          notBeforeUtc: timestampNotBeforeUtc,
          notAfterUtc: timestampNotAfterUtc,
          signtoolVerified: true,
        },
      });
    }
    if (!certificateIdentity) {
      throw new Error("Bundled Codex Authenticode verification produced no certificate identity.");
    }
    for (const digest of [...sourceDigests, ...privateDigests]) {
      assertImmutableFileDigestCurrent(digest);
    }
    return {
      executableFiles: executables.map((executable) => executable.file).toSorted(compareUtf8Bytes),
      mainExecutableFile: `app/${mainExecutableName}`,
      installerFile: `installer/${installerFileName}`,
      commands: [result.command],
      publisherName,
      certificateIdentity,
      signatures: signatureReceipts.toSorted((left, right) =>
        compareUtf8Bytes(left.file, right.file),
      ),
    };
  } finally {
    for (const digest of privateDigests) closeImmutableFileDigest(digest);
    for (const digest of sourceDigests) closeImmutableFileDigest(digest);
    FS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const MAC_DEVELOPER_ID_TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u;
const MAC_CANONICAL_FILESYSTEM_HELPER_NAME = "moss-canonical-filesystem-helper";
const MAC_CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION = 2;
const MAC_CANONICAL_FILESYSTEM_HELPER_MAX_BYTES = 8 * 1024 * 1024;
const MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_MAX_BYTES = 64 * 1024;
const MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_KEYS = [
  "arch",
  "architectures",
  "fingerprint",
  "helper",
  "protocolVersion",
  "schemaVersion",
  "sha256",
  "size",
] as const;

export interface PackagedCanonicalFilesystemHelperBindingReceipt {
  readonly helperFile: "Contents/Helpers/moss-canonical-filesystem-helper";
  readonly metadataFile: "Contents/Resources/moss-canonical-filesystem-helper.build.json";
  readonly schemaVersion: 1;
  readonly protocolVersion: 2;
  readonly arch: "arm64" | "x64" | "universal";
  readonly architectures: readonly ("arm64" | "x64")[];
  readonly fingerprint: string;
  readonly sha256: string;
  readonly size: number;
}

function canonicalFilesystemHelperArchitectures(
  arch: PackagedCanonicalFilesystemHelperBindingReceipt["arch"],
): readonly ("arm64" | "x64")[] {
  return arch === "universal" ? ["arm64", "x64"] : [arch];
}

export function readPackagedCanonicalFilesystemHelperBindingReceipt(input: {
  readonly value: unknown;
  readonly label: string;
  readonly expectedArch: PackagedCanonicalFilesystemHelperBindingReceipt["arch"];
}): PackagedCanonicalFilesystemHelperBindingReceipt {
  const receipt = objectEntry(input.value, input.label);
  if (
    !isDeepStrictEqual(Object.keys(receipt).toSorted(compareUtf8Bytes), [
      "arch",
      "architectures",
      "fingerprint",
      "helperFile",
      "metadataFile",
      "protocolVersion",
      "schemaVersion",
      "sha256",
      "size",
    ])
  ) {
    throw new Error(`Bundled Codex release receipt ${input.label} has invalid helper fields.`);
  }
  const helperFile = stringField(receipt, "helperFile", input.label);
  const metadataFile = stringField(receipt, "metadataFile", input.label);
  const fingerprint = stringField(receipt, "fingerprint", input.label);
  const sha256 = stringField(receipt, "sha256", input.label);
  const size = numberField(receipt, "size", input.label);
  const expectedArchitectures = canonicalFilesystemHelperArchitectures(input.expectedArch);
  assertReceiptLogicalPath(helperFile, `${input.label}.helperFile`);
  assertReceiptLogicalPath(metadataFile, `${input.label}.metadataFile`);
  if (
    helperFile !== "Contents/Helpers/moss-canonical-filesystem-helper" ||
    metadataFile !== "Contents/Resources/moss-canonical-filesystem-helper.build.json" ||
    receipt.schemaVersion !== 1 ||
    receipt.protocolVersion !== MAC_CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION ||
    receipt.arch !== input.expectedArch ||
    !isDeepStrictEqual(receipt.architectures, expectedArchitectures) ||
    !SHA256.test(fingerprint) ||
    !SHA256.test(sha256) ||
    size < 1 ||
    size > MAC_CANONICAL_FILESYSTEM_HELPER_MAX_BYTES
  ) {
    throw new Error(`Bundled Codex release receipt ${input.label} is not a valid helper binding.`);
  }
  return {
    helperFile: "Contents/Helpers/moss-canonical-filesystem-helper",
    metadataFile: "Contents/Resources/moss-canonical-filesystem-helper.build.json",
    schemaVersion: 1,
    protocolVersion: 2,
    arch: input.expectedArch,
    architectures: expectedArchitectures,
    fingerprint,
    sha256,
    size,
  };
}

function canonicalFilesystemHelperTargetArchitecture(targetTriples: readonly string[]): {
  readonly expectedArch: "arm64" | "x64" | "universal";
  readonly expectedArchitectures: Array<"arm64" | "x64">;
} {
  const targetSet = new Set(targetTriples);
  if (targetSet.size !== targetTriples.length || targetSet.size < 1) {
    throw new Error(
      "Packaged canonical filesystem helper requires a non-empty unique macOS target set.",
    );
  }
  const hasArm64 = targetSet.delete("aarch64-apple-darwin");
  const hasX64 = targetSet.delete("x86_64-apple-darwin");
  if (targetSet.size > 0 || (!hasArm64 && !hasX64)) {
    throw new Error("Packaged canonical filesystem helper received an invalid macOS target set.");
  }
  const expectedArch: "arm64" | "x64" | "universal" =
    hasArm64 && hasX64 ? "universal" : hasArm64 ? "arm64" : "x64";
  const expectedArchitectures: Array<"arm64" | "x64"> = hasArm64
    ? hasX64
      ? ["arm64", "x64"]
      : ["arm64"]
    : ["x64"];
  return { expectedArch, expectedArchitectures };
}

/** Content validation alone does not establish native executable or signing identity. */
export function validatePackagedCanonicalFilesystemHelperMetadata(input: {
  readonly metadataBytes: Buffer;
  readonly targetTriples: readonly string[];
  readonly helperSha256: string;
  readonly helperSize: number;
}): {
  readonly arch: "arm64" | "x64" | "universal";
  readonly architectures: Array<"arm64" | "x64">;
  readonly fingerprint: string;
} {
  if (
    input.metadataBytes.byteLength < 1 ||
    input.metadataBytes.byteLength > MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_MAX_BYTES
  ) {
    throw new Error(
      `Packaged canonical filesystem helper metadata exceeds the ${MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_MAX_BYTES}-byte limit.`,
    );
  }
  const { expectedArch, expectedArchitectures } = canonicalFilesystemHelperTargetArchitecture(
    input.targetTriples,
  );
  let value: unknown;
  try {
    value = JSON.parse(input.metadataBytes.toString("utf8"));
  } catch (cause) {
    throw new Error("Packaged canonical filesystem helper metadata is not valid JSON.", {
      cause,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Packaged canonical filesystem helper metadata must be a JSON object.");
  }
  const metadata = value as JsonRecord;
  if (
    !isDeepStrictEqual(Object.keys(metadata).toSorted(compareUtf8Bytes), [
      ...MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_KEYS,
    ]) ||
    metadata.schemaVersion !== 1 ||
    metadata.helper !== MAC_CANONICAL_FILESYSTEM_HELPER_NAME ||
    metadata.protocolVersion !== MAC_CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION ||
    metadata.arch !== expectedArch ||
    !Array.isArray(metadata.architectures) ||
    !isDeepStrictEqual(metadata.architectures, expectedArchitectures) ||
    typeof metadata.fingerprint !== "string" ||
    !SHA256.test(metadata.fingerprint) ||
    typeof metadata.sha256 !== "string" ||
    !SHA256.test(metadata.sha256) ||
    typeof metadata.size !== "number" ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > MAC_CANONICAL_FILESYSTEM_HELPER_MAX_BYTES
  ) {
    throw new Error(
      "Packaged canonical filesystem helper metadata schema or identity fields are invalid.",
    );
  }
  if (metadata.sha256 !== input.helperSha256 || metadata.size !== input.helperSize) {
    throw new Error(
      "Packaged canonical filesystem helper SHA-256 or size does not match its metadata.",
    );
  }
  return {
    arch: expectedArch,
    architectures: expectedArchitectures,
    fingerprint: metadata.fingerprint as string,
  };
}

export function verifyPackagedCanonicalFilesystemHelperBinding(input: {
  readonly appBundlePath: string;
  readonly resourcesDir: string;
  readonly targetTriples: readonly string[];
}): PackagedCanonicalFilesystemHelperBindingReceipt {
  const appBundlePath = Path.resolve(input.appBundlePath);
  const resourcesDir = Path.resolve(input.resourcesDir);
  const contentsDir = Path.join(appBundlePath, "Contents");
  const helpersDir = Path.join(contentsDir, "Helpers");
  const expectedResourcesDir = Path.join(appBundlePath, "Contents", "Resources");
  if (resourcesDir !== expectedResourcesDir) {
    throw new Error(
      "Packaged canonical filesystem helper metadata must be in the verified app Contents/Resources directory.",
    );
  }

  requirePlainDirectory(appBundlePath, "packaged canonical filesystem helper application bundle");
  requirePlainDirectory(contentsDir, "packaged canonical filesystem helper Contents directory");
  requirePlainDirectory(helpersDir, "packaged canonical filesystem helper Helpers directory");
  requirePlainDirectory(resourcesDir, "packaged canonical filesystem helper Resources directory");
  const realAppBundlePath = FS.realpathSync(appBundlePath);
  const realContentsDir = FS.realpathSync(contentsDir);
  const realHelpersDir = FS.realpathSync(helpersDir);
  const realResourcesDir = FS.realpathSync(resourcesDir);
  if (
    realContentsDir !== Path.join(realAppBundlePath, "Contents") ||
    realHelpersDir !== Path.join(realContentsDir, "Helpers") ||
    realResourcesDir !== Path.join(realContentsDir, "Resources")
  ) {
    throw new Error(
      "Packaged canonical filesystem helper directories escape the verified application bundle.",
    );
  }
  const assertDirectoryChainCurrent = (): void => {
    requirePlainDirectory(appBundlePath, "packaged canonical filesystem helper application bundle");
    requirePlainDirectory(contentsDir, "packaged canonical filesystem helper Contents directory");
    requirePlainDirectory(helpersDir, "packaged canonical filesystem helper Helpers directory");
    requirePlainDirectory(resourcesDir, "packaged canonical filesystem helper Resources directory");
    if (
      FS.realpathSync(appBundlePath) !== realAppBundlePath ||
      FS.realpathSync(contentsDir) !== realContentsDir ||
      FS.realpathSync(helpersDir) !== realHelpersDir ||
      FS.realpathSync(resourcesDir) !== realResourcesDir
    ) {
      throw new Error(
        "Packaged canonical filesystem helper directory identity changed during verification.",
      );
    }
  };

  const { expectedArch, expectedArchitectures } = canonicalFilesystemHelperTargetArchitecture(
    input.targetTriples,
  );

  const helperPath = Path.join(helpersDir, MAC_CANONICAL_FILESYSTEM_HELPER_NAME);
  const metadataPath = Path.join(
    resourcesDir,
    `${MAC_CANONICAL_FILESYSTEM_HELPER_NAME}.build.json`,
  );
  const helperSnapshot = openImmutableFileSnapshot(
    helperPath,
    "packaged canonical filesystem helper",
    MAC_CANONICAL_FILESYSTEM_HELPER_MAX_BYTES,
  );
  let metadataSnapshot: ImmutableFileSnapshot | undefined;
  try {
    if ((helperSnapshot.identity.mode & 0o111n) === 0n) {
      throw new Error("Packaged canonical filesystem helper must be executable.");
    }
    metadataSnapshot = openImmutableFileSnapshot(
      metadataPath,
      "packaged canonical filesystem helper metadata",
      MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_MAX_BYTES,
    );
    assertDirectoryChainCurrent();
    if (
      FS.realpathSync(helperPath) !==
        Path.join(realHelpersDir, MAC_CANONICAL_FILESYSTEM_HELPER_NAME) ||
      FS.realpathSync(metadataPath) !==
        Path.join(realResourcesDir, `${MAC_CANONICAL_FILESYSTEM_HELPER_NAME}.build.json`)
    ) {
      throw new Error(
        "Packaged canonical filesystem helper or metadata escapes the verified application bundle.",
      );
    }
    const metadata = validatePackagedCanonicalFilesystemHelperMetadata({
      metadataBytes: metadataSnapshot.bytes,
      targetTriples: input.targetTriples,
      helperSha256: helperSnapshot.sha256,
      helperSize: helperSnapshot.size,
    });
    assertImmutableFileSnapshotCurrent(helperSnapshot);
    assertImmutableFileSnapshotCurrent(metadataSnapshot);
    assertDirectoryChainCurrent();
    if (
      FS.realpathSync(helperPath) !==
        Path.join(realHelpersDir, MAC_CANONICAL_FILESYSTEM_HELPER_NAME) ||
      FS.realpathSync(metadataPath) !==
        Path.join(realResourcesDir, `${MAC_CANONICAL_FILESYSTEM_HELPER_NAME}.build.json`)
    ) {
      throw new Error(
        "Packaged canonical filesystem helper or metadata changed containment during verification.",
      );
    }
    return {
      helperFile: "Contents/Helpers/moss-canonical-filesystem-helper",
      metadataFile: "Contents/Resources/moss-canonical-filesystem-helper.build.json",
      schemaVersion: 1,
      protocolVersion: 2,
      arch: expectedArch,
      architectures: expectedArchitectures,
      fingerprint: metadata.fingerprint,
      sha256: helperSnapshot.sha256,
      size: helperSnapshot.size,
    };
  } finally {
    if (metadataSnapshot) closeImmutableFileSnapshot(metadataSnapshot);
    closeImmutableFileSnapshot(helperSnapshot);
  }
}

export interface BundledCodexMacCodeSignatureReceipt {
  readonly appBundlePath: string;
  readonly bundleIdentifier: string;
  readonly teamIdentifier: string;
  readonly runtimeExecutablePaths: readonly string[];
  readonly commands: readonly string[];
  readonly notarizationValidated: boolean;
  readonly canonicalFilesystemHelper: PackagedCanonicalFilesystemHelperBindingReceipt;
}

interface MacCodeSignatureDetails {
  readonly identifier: string;
  readonly teamIdentifier: string;
  readonly authorities: readonly string[];
  readonly designatedRequirement: string;
}

function parseMacCodeSignatureDetails(output: string, label: string): MacCodeSignatureDetails {
  if (/^Signature=adhoc$/imu.test(output) || /^TeamIdentifier=not set$/imu.test(output)) {
    throw new Error(`Bundled Codex macOS ${label} uses an ad-hoc signature.`);
  }
  const identifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1]!.trim());
  const designatedRequirement = /^(?:#\s*)?designated\s*=>\s*(.+)$/mu.exec(output)?.[1]?.trim();
  if (!identifier || !teamIdentifier || authorities.length === 0 || !designatedRequirement) {
    throw new Error(`Bundled Codex macOS ${label} returned incomplete signature identity details.`);
  }
  return { identifier, teamIdentifier, authorities, designatedRequirement };
}

function assertMacDeveloperIdIdentity(input: {
  readonly details: MacCodeSignatureDetails;
  readonly expectedTeamIdentifier: string;
  readonly label: string;
}): void {
  if (
    !input.details.authorities.some((authority) =>
      authority.startsWith("Developer ID Application:"),
    )
  ) {
    throw new Error(
      `Bundled Codex macOS ${input.label} is not signed by a Developer ID Application identity.`,
    );
  }
  if (input.details.teamIdentifier !== input.expectedTeamIdentifier) {
    throw new Error(
      `Bundled Codex macOS TeamIdentifier mismatch for ${input.label}: expected ${input.expectedTeamIdentifier}, found ${input.details.teamIdentifier}.`,
    );
  }
}

export interface BundledCodexMacBuildOnlySignatureIdentity {
  readonly logicalFile: string;
  readonly identifier: string;
  readonly cdHash: string;
  readonly signatureType: "adhoc";
  readonly teamIdentifier: null;
  readonly authorities: readonly [];
}

export interface BundledCodexMacBuildOnlySignatureReceipt {
  readonly releaseEligibility: "build-only-only";
  readonly signatureType: "adhoc";
  readonly signatures: readonly BundledCodexMacBuildOnlySignatureIdentity[];
  readonly commands: readonly string[];
  readonly canonicalFilesystemHelper: PackagedCanonicalFilesystemHelperBindingReceipt;
}

function parseMacBuildOnlySignatureDetails(
  output: string,
  logicalFile: string,
): BundledCodexMacBuildOnlySignatureIdentity {
  const identifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const cdHash = /^CDHash=([a-f0-9]{40,64})$/imu.exec(output)?.[1]?.toLowerCase();
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1]!.trim());
  const designatedRequirement = /^(?:#\s*)?designated\s*=>\s*(.+)$/mu.exec(output)?.[1]?.trim();
  if (
    !identifier ||
    !cdHash ||
    !designatedRequirement ||
    !/^Signature=adhoc$/imu.test(output) ||
    teamIdentifier !== "not set" ||
    authorities.length !== 0
  ) {
    throw new Error(
      `Bundled Codex macOS build-only signature provenance requires an ad-hoc identity with no Team ID or authority for ${logicalFile}.`,
    );
  }
  return {
    logicalFile,
    identifier,
    cdHash,
    signatureType: "adhoc",
    teamIdentifier: null,
    authorities: [],
  };
}

export function verifyPackagedBundledCodexMacBuildOnlySignatures(input: {
  readonly appBundlePath: string;
  readonly resourcesDir: string;
  readonly targetTriples: readonly string[];
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexMacBuildOnlySignatureReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "darwin") {
    throw new Error(
      `Bundled Codex macOS build-only signature verification requires a macOS host, found ${hostPlatform}.`,
    );
  }
  const appBundlePath = Path.resolve(input.appBundlePath);
  const resourcesDir = Path.resolve(input.resourcesDir);
  requirePlainDirectory(appBundlePath, "build-only macOS application bundle");
  requirePlainDirectory(
    Path.join(appBundlePath, "Contents"),
    "build-only macOS Contents directory",
  );
  requirePlainDirectory(resourcesDir, "build-only macOS Resources directory");
  if (resourcesDir !== Path.join(appBundlePath, "Contents", "Resources")) {
    throw new Error(
      "Bundled Codex macOS build-only signature verification requires Resources inside the verified application bundle.",
    );
  }

  const executableEntries: Array<{ readonly logicalFile: string; readonly absolutePath: string }> =
    [];
  const seenTargets = new Set<string>();
  for (const targetTriple of input.targetTriples) {
    if (seenTargets.has(targetTriple)) {
      throw new Error(
        `Bundled Codex macOS build-only signature verification received duplicate target ${targetTriple}.`,
      );
    }
    seenTargets.add(targetTriple);
    const archiveId =
      TARGET_TRIPLE_TO_ARCHIVE[targetTriple as keyof typeof TARGET_TRIPLE_TO_ARCHIVE];
    if (!archiveId?.startsWith("darwin-")) {
      throw new Error(
        `Bundled Codex macOS build-only signature verification received non-macOS target ${targetTriple}.`,
      );
    }
    const runtimeRoot = Path.join(resourcesDir, "codex-runtime", targetTriple);
    requirePlainDirectory(runtimeRoot, `build-only macOS runtime ${targetTriple}`);
    for (const relativePath of REQUIRED_PAYLOAD_SUFFIXES[archiveId]) {
      const absolutePath = Path.join(runtimeRoot, relativePath);
      requirePlainFile(absolutePath, `${targetTriple}/${relativePath}`);
      executableEntries.push({ logicalFile: `${targetTriple}/${relativePath}`, absolutePath });
    }
  }
  if (executableEntries.length === 0) {
    throw new Error(
      "Bundled Codex macOS build-only signature verification found no runtime executables.",
    );
  }

  const runCommand = input.runCommand ?? runBundledCodexCommand;
  const commands: string[] = [];
  const run = (command: string, args: readonly string[], label: string) => {
    const result = runRequiredBundledCodexCommand({ command, args, label, runCommand });
    commands.push(result.command);
    return `${result.stdout}\n${result.stderr}`;
  };
  run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath],
    "build-only outer code-signature verification",
  );
  const signatures: BundledCodexMacBuildOnlySignatureIdentity[] = [
    parseMacBuildOnlySignatureDetails(
      run(
        "/usr/bin/codesign",
        ["--display", "--verbose=4", "--requirements", "-", appBundlePath],
        "build-only outer code-signature identity probe",
      ),
      "app",
    ),
  ];
  for (const entry of executableEntries.toSorted((left, right) =>
    compareUtf8Bytes(left.logicalFile, right.logicalFile),
  )) {
    run(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=4", entry.absolutePath],
      `build-only nested code-signature verification for ${entry.logicalFile}`,
    );
    signatures.push(
      parseMacBuildOnlySignatureDetails(
        run(
          "/usr/bin/codesign",
          ["--display", "--verbose=4", "--requirements", "-", entry.absolutePath],
          `build-only nested code-signature identity probe for ${entry.logicalFile}`,
        ),
        entry.logicalFile,
      ),
    );
  }
  const canonicalFilesystemHelper = verifyPackagedCanonicalFilesystemHelperBinding({
    appBundlePath,
    resourcesDir,
    targetTriples: input.targetTriples,
  });
  return {
    releaseEligibility: "build-only-only",
    signatureType: "adhoc",
    signatures,
    commands,
    canonicalFilesystemHelper,
  };
}

export function verifyPackagedBundledCodexMacCodeSignature(input: {
  readonly appBundlePath: string;
  readonly resourcesDir: string;
  readonly targetTriples: readonly string[];
  readonly expectedTeamIdentifier: string;
  readonly expectedBundleIdentifier: string;
  readonly requireNotarization: boolean;
  readonly hostPlatform?: NodeJS.Platform;
  readonly runCommand?: BundledCodexCommandRunner;
}): BundledCodexMacCodeSignatureReceipt {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "darwin") {
    throw new Error(
      `Bundled Codex macOS signature verification requires a macOS host, found ${hostPlatform}.`,
    );
  }
  const teamIdentifier = input.expectedTeamIdentifier.trim();
  if (!MAC_DEVELOPER_ID_TEAM_IDENTIFIER.test(teamIdentifier)) {
    throw new Error(
      "Bundled Codex macOS signature verification requires a trusted 10-character APPLE_TEAM_ID.",
    );
  }
  const bundleIdentifier = input.expectedBundleIdentifier.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/u.test(bundleIdentifier)) {
    throw new Error(
      "Bundled Codex macOS signature verification requires an expected bundle identifier.",
    );
  }

  const appBundlePath = Path.resolve(input.appBundlePath);
  const resourcesDir = Path.resolve(input.resourcesDir);
  requirePlainDirectory(appBundlePath, "signed macOS application bundle");
  requirePlainDirectory(Path.join(appBundlePath, "Contents"), "signed macOS Contents directory");
  requirePlainDirectory(resourcesDir, "signed macOS Resources directory");
  if (resourcesDir !== Path.join(appBundlePath, "Contents", "Resources")) {
    throw new Error(
      "Bundled Codex macOS signature verification requires Resources inside the verified application bundle.",
    );
  }

  const runtimeExecutablePaths: string[] = [];
  const seenTargets = new Set<string>();
  for (const targetTriple of input.targetTriples) {
    if (seenTargets.has(targetTriple)) {
      throw new Error(
        `Bundled Codex macOS signature verification received duplicate target ${targetTriple}.`,
      );
    }
    seenTargets.add(targetTriple);
    const archiveId =
      TARGET_TRIPLE_TO_ARCHIVE[targetTriple as keyof typeof TARGET_TRIPLE_TO_ARCHIVE];
    if (!archiveId?.startsWith("darwin-")) {
      throw new Error(
        `Bundled Codex macOS signature verification received non-macOS target ${targetTriple}.`,
      );
    }
    const runtimeRoot = Path.join(resourcesDir, "codex-runtime", targetTriple);
    requirePlainDirectory(runtimeRoot, `macOS runtime ${targetTriple}`);
    for (const relativePath of REQUIRED_PAYLOAD_SUFFIXES[archiveId]) {
      const executablePath = Path.join(runtimeRoot, relativePath);
      requirePlainFile(executablePath, `${targetTriple}/${relativePath}`);
      runtimeExecutablePaths.push(executablePath);
    }
  }
  if (runtimeExecutablePaths.length === 0) {
    throw new Error("Bundled Codex macOS signature verification found no runtime executables.");
  }

  const runCommand = input.runCommand ?? runBundledCodexCommand;
  const commands: string[] = [];
  const run = (command: string, args: readonly string[], label: string) => {
    const result = runRequiredBundledCodexCommand({ command, args, label, runCommand });
    commands.push(result.command);
    return `${result.stdout}\n${result.stderr}`;
  };
  run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath],
    "outer code-signature verification",
  );
  const outerDetails = parseMacCodeSignatureDetails(
    run(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", "--requirements", "-", appBundlePath],
      "outer code-signature identity probe",
    ),
    "outer application",
  );
  assertMacDeveloperIdIdentity({
    details: outerDetails,
    expectedTeamIdentifier: teamIdentifier,
    label: "outer application",
  });
  if (outerDetails.identifier !== bundleIdentifier) {
    throw new Error(
      `Bundled Codex macOS bundle Identifier mismatch: expected ${bundleIdentifier}, found ${outerDetails.identifier}.`,
    );
  }
  const escapedBundleIdentifier = escapeRegularExpression(bundleIdentifier);
  const escapedTeamIdentifier = escapeRegularExpression(teamIdentifier);
  if (
    !new RegExp(`identifier\\s+"${escapedBundleIdentifier}"`, "u").test(
      outerDetails.designatedRequirement,
    ) ||
    !/anchor apple generic/u.test(outerDetails.designatedRequirement) ||
    !new RegExp(
      `certificate leaf\\[subject\\.OU\\]\\s*=\\s*"?${escapedTeamIdentifier}"?`,
      "u",
    ).test(outerDetails.designatedRequirement)
  ) {
    throw new Error(
      "Bundled Codex macOS outer designated requirement does not bind the expected bundle identifier, Apple anchor, and Team ID.",
    );
  }

  for (const executablePath of runtimeExecutablePaths.toSorted(compareUtf8Bytes)) {
    run(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=4", executablePath],
      "nested runtime code-signature verification",
    );
    const details = parseMacCodeSignatureDetails(
      run(
        "/usr/bin/codesign",
        ["--display", "--verbose=4", "--requirements", "-", executablePath],
        "nested runtime code-signature identity probe",
      ),
      executablePath,
    );
    assertMacDeveloperIdIdentity({
      details,
      expectedTeamIdentifier: teamIdentifier,
      label: executablePath,
    });
  }

  if (input.requireNotarization) {
    run("/usr/bin/xcrun", ["stapler", "validate", appBundlePath], "stapled-ticket validation");
    run(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=4", appBundlePath],
      "Gatekeeper assessment",
    );
  }

  const canonicalFilesystemHelper = verifyPackagedCanonicalFilesystemHelperBinding({
    appBundlePath,
    resourcesDir,
    targetTriples: input.targetTriples,
  });

  return {
    appBundlePath,
    bundleIdentifier,
    teamIdentifier,
    runtimeExecutablePaths: runtimeExecutablePaths.toSorted(compareUtf8Bytes),
    commands,
    notarizationValidated: input.requireNotarization,
    canonicalFilesystemHelper,
  };
}
