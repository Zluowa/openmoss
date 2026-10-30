import * as Crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createDirectoryAlias, createRejectedFileAlias } from "../fixtures/filesystem-links";

import {
  assertBundledCodexComplianceVersion,
  assertBundledCodexReleaseApproved,
  BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_DIRECTORY_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ENTRY_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_FILE_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_TOTAL_BYTES,
  BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT,
  BUNDLED_CODEX_COMPLIANCE_PACKAGE_RELATIVE_DIRECTORY,
  BUNDLED_CODEX_COMPLIANCE_REPOSITORY_RELATIVE_DIRECTORY,
  BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT,
  BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT,
  BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH,
  BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID,
  copyBundledCodexReleaseArtifactsAndWriteReceipt,
  promoteBundledCodexReleaseArtifacts,
  type BundledCodexCommandRunner,
  type PayloadArchive,
  resolveBundledCodexPayloadPackageRootCandidates,
  resolveResealedBundledCodexPayloadPaths,
  shouldRunBundledCodexLinuxPublicRuntimeProbes,
  stageBundledCodexComplianceBundle,
  validateBundledCodexReleaseComplianceBundle,
  validateBundledCodexLinuxX64PublicRuntime,
  validateBundledCodexRuntimePayload,
  validateCopiedBundledCodexRuntimePayload,
  validatePackagedBundledCodexComplianceBundle,
  validateRepositoryBundledCodexComplianceBundle,
  validateSignedBundledCodexRuntimePayload,
  validateStagedBundledCodexComplianceBundle,
  type BundledCodexFinalLinuxAppImageReceipt,
  inspectBundledCodexLinuxAppImageContainer,
  verifyBundledCodexReleaseReceipt,
  verifyBundledCodexLinuxAppImageContainerLifecycle,
  verifyBundledCodexLinuxLauncherIdentity,
  verifyBundledCodexMacArtifactContainerLifecycle,
  verifyBundledCodexWindowsInstallerLifecycle,
  verifyPackagedBundledCodexMacBuildOnlySignatures,
  verifyPackagedBundledCodexMacCodeSignature,
  verifyPackagedCanonicalFilesystemHelperBinding,
  validatePackagedCanonicalFilesystemHelperMetadata,
  verifyPackagedBundledCodexWindowsAuthenticode,
} from "./bundled-codex-release-compliance.ts";
import {
  BUNDLED_CLAUDE_AGENT_SDK_VERSION,
  BUNDLED_CLAUDE_CODE_VERSION,
  resolveBundledClaudeTargets,
} from "./bundled-claude-runtime.ts";

const REPO_ROOT = Path.resolve(import.meta.dirname, "../..");
const CANONICAL_BUNDLE = Path.join(
  REPO_ROOT,
  BUNDLED_CODEX_COMPLIANCE_REPOSITORY_RELATIVE_DIRECTORY,
);
const CANONICAL_COMPLIANCE = validateBundledCodexReleaseComplianceBundle({
  directory: CANONICAL_BUNDLE,
});
const tempDirs = new Set<string>();

function makeTempDir(prefix: string): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  tempDirs.add(directory);
  return directory;
}

function copyCanonicalBundle(prefix: string): string {
  const directory = Path.join(makeTempDir(prefix), "bundle");
  FS.cpSync(CANONICAL_BUNDLE, directory, { recursive: true });
  const normalizeModes = (source: string, destination: string): void => {
    FS.chmodSync(destination, 0o755);
    for (const entry of FS.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = Path.join(source, entry.name);
      const destinationPath = Path.join(destination, entry.name);
      const stat = FS.lstatSync(sourcePath);
      if (stat.isDirectory()) {
        normalizeModes(sourcePath, destinationPath);
      } else if (stat.isFile()) {
        FS.chmodSync(destinationPath, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
      }
    }
  };
  if (process.platform !== "win32") normalizeModes(CANONICAL_BUNDLE, directory);
  return directory;
}

function sha256(data: Buffer): string {
  return Crypto.createHash("sha256").update(data).digest("hex");
}

const LINUX_X64_TARGET = "x86_64-unknown-linux-musl";
const LINUX_RUNTIME_EXECUTABLES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/bwrap",
  "codex-resources/voice/bin/codex-voice-host",
] as const;
const WINDOWS_X64_TARGET = "x86_64-pc-windows-msvc";
const WINDOWS_RUNTIME_EXECUTABLES = [
  "bin/codex.exe",
  "bin/codex-code-mode-host.exe",
  "codex-path/rg.exe",
  "codex-resources/codex-command-runner.exe",
  "codex-resources/codex-windows-sandbox-setup.exe",
  "codex-resources/voice/bin/codex-voice-host.exe",
] as const;
const EXPECTED_WINDOWS_PUBLISHER = "Moss Software";
const EXPECTED_WINDOWS_SUBJECT_DN = "CN=Moss Software, O=Moss Software, C=CN";
const EXPECTED_WINDOWS_THUMBPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";
const EXPECTED_WINDOWS_ISSUER_DN = "CN=Microsoft ID Verified CS AOC CA 02";
const EXPECTED_WINDOWS_SERIAL = "0102030405060708";
const MAC_ARM64_TARGET = "aarch64-apple-darwin";
const MAC_RUNTIME_EXECUTABLES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/voice/bin/codex-voice-host",
] as const;
const EXPECTED_APPLE_TEAM_ID = "AB12CD34EF";
const EXPECTED_MAC_BUNDLE_ID = "com.moss.desktop";
const EXPECTED_ELECTRON_RUNTIME_VERSION = "40.6.0";
const MAC_CANONICAL_FILESYSTEM_HELPER_NAME = "moss-canonical-filesystem-helper";

function bundledClaudeVerification(
  platform: "linux" | "mac" | "win",
  arch: "arm64" | "x64" | "universal",
): Record<string, unknown> {
  const targetOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const targetCpus = arch === "universal" ? ["arm64", "x64"] : [arch];
  const runnerArch = arch === "universal" ? "arm64" : arch;
  return {
    schemaVersion: 1,
    kind: "moss-bundled-claude-runtime-verification",
    agentSdkVersion: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
    codeVersion: BUNDLED_CLAUDE_CODE_VERSION,
    runner: {
      platform: targetOs,
      arch: runnerArch,
    },
    targets: targetCpus.map((cpu) => ({
      resourceFolder: `${targetOs === "win32" ? "win32" : targetOs}-${cpu}`,
      os: targetOs,
      cpu,
      executable: targetOs === "win32" ? "claude.exe" : "claude",
      method:
        targetOs === "darwin" && runnerArch === "arm64" && cpu === "x64"
          ? "macos-arch-exec"
          : "direct-exec",
      argv: ["--version"],
      reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
    })),
  };
}

function bundledClaudeFinalVerification(
  arch: "arm64" | "x64" | "universal",
): Record<string, unknown> {
  const targets = resolveBundledClaudeTargets({ platform: "mac", arch });
  return {
    schemaVersion: 1,
    kind: "moss-bundled-claude-final-artifact-verification",
    platform: "mac",
    arch,
    targets: targets.map((target) => ({
      resourceFolder: target.resourceFolder,
      cpu: target.cpu,
      executable: target.executable,
      relativePath: `claude-runtime/${target.resourceFolder}/${target.executable}`,
      fileSize: 1_024,
      fileSha256: "c".repeat(64),
      executableVerified: true,
      method: target.cpu === "x64" && arch === "universal" ? "macos-arch-exec" : "direct-exec",
      argv: ["--version"],
      reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
    })),
  };
}

function fakeLinuxX64Elf(size = 128): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 64));
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  return bytes;
}

function fakeAppImageType2(
  input: {
    readonly squashfsOffset?: number;
    readonly bytesUsed?: number;
    readonly trailingByte?: number;
  } = {},
): Buffer {
  const squashfsOffset = input.squashfsOffset ?? 4_096;
  const bytesUsed = input.bytesUsed ?? 512;
  const header = Buffer.alloc(squashfsOffset);
  fakeLinuxX64Elf().copy(header);
  header.set([0x41, 0x49, 2], 8);
  const squashfs = Buffer.alloc(4_096, input.trailingByte ?? 0);
  squashfs.write("hsqs", 0, "ascii");
  squashfs.writeUInt32LE(1, 4);
  squashfs.writeUInt32LE(131_072, 12);
  squashfs.writeUInt16LE(1, 20);
  squashfs.writeUInt16LE(17, 22);
  squashfs.writeUInt16LE(1, 26);
  squashfs.writeUInt16LE(4, 28);
  squashfs.writeUInt16LE(0, 30);
  squashfs.writeBigUInt64LE(BigInt(bytesUsed), 40);
  squashfs.writeBigUInt64LE(160n, 48);
  squashfs.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 56);
  squashfs.writeBigUInt64LE(96n, 64);
  squashfs.writeBigUInt64LE(128n, 72);
  squashfs.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 80);
  squashfs.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 88);
  if (input.trailingByte !== undefined) {
    squashfs.fill(input.trailingByte, bytesUsed);
  }
  return Buffer.concat([header, squashfs]);
}

function linuxLauncherIdentityFixture(): BundledCodexFinalLinuxAppImageReceipt["extractedClosure"]["startup"] {
  const executable = fakeLinuxX64Elf();
  const output = `v${EXPECTED_ELECTRON_RUNTIME_VERSION}`;
  return {
    executableFile: "moss",
    executableSize: executable.length,
    executableSha256: sha256(executable),
    arguments: ["--version"],
    runtimeVersion: EXPECTED_ELECTRON_RUNTIME_VERSION,
    outputBytes: Buffer.byteLength(output),
    outputSha256: sha256(Buffer.from(output)),
    validated: true,
  };
}

function makeExecutableRuntimeFixture(
  prefix: string,
  targetTriple: string,
  relativeExecutables: readonly string[],
): { resourcesDir: string; runtimeRoot: string } {
  const resourcesDir = Path.join(makeTempDir(prefix), "resources");
  const runtimeRoot = Path.join(resourcesDir, "codex-runtime", targetTriple);
  FS.mkdirSync(runtimeRoot, { recursive: true });
  for (const relativePath of relativeExecutables) {
    const filePath = Path.join(runtimeRoot, relativePath);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `fixture ${relativePath}\n`);
    FS.chmodSync(filePath, 0o755);
  }
  return { resourcesDir, runtimeRoot };
}

function makeWindowsSignatureFixture(prefix: string): {
  stageDistDir: string;
  resourcesDir: string;
  runtimeRoot: string;
  mainExecutableName: string;
  installerFileName: string;
} {
  const stageDistDir = Path.join(makeTempDir(prefix), "dist");
  const mainExecutableName = "Moss.exe";
  const installerFileName = "Moss-0.0.0-x64.exe";
  const unpackedRoot = Path.join(stageDistDir, "win-unpacked");
  const resourcesDir = Path.join(unpackedRoot, "resources");
  const runtimeRoot = Path.join(resourcesDir, "codex-runtime", WINDOWS_X64_TARGET);
  FS.mkdirSync(runtimeRoot, { recursive: true });
  for (const relativePath of WINDOWS_RUNTIME_EXECUTABLES) {
    const filePath = Path.join(runtimeRoot, relativePath);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `fixture ${relativePath}\n`);
  }
  FS.writeFileSync(Path.join(unpackedRoot, mainExecutableName), "fixture main executable\n");
  FS.writeFileSync(Path.join(stageDistDir, installerFileName), "fixture installer\n");
  return {
    stageDistDir,
    resourcesDir,
    runtimeRoot,
    mainExecutableName,
    installerFileName,
  };
}

function windowsSignatureEvidence(
  path: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    path,
    status: "Valid",
    signatureType: "Authenticode",
    subjectDn: EXPECTED_WINDOWS_SUBJECT_DN,
    thumbprint: EXPECTED_WINDOWS_THUMBPRINT,
    issuerDn: EXPECTED_WINDOWS_ISSUER_DN,
    serialNumber: EXPECTED_WINDOWS_SERIAL,
    timestampSubjectDn: "CN=Moss Trusted Timestamp",
    timestampThumbprint: "89ABCDEF0123456789ABCDEF0123456789ABCDEF",
    timestampSerialNumber: "1122334455667788",
    timestampNotBeforeUtc: "2026-01-01T00:00:00.0000000Z",
    timestampNotAfterUtc: "2036-01-01T00:00:00.0000000Z",
    signtoolVerified: true,
    signtoolPath: "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe",
    ...overrides,
  };
}

function releaseComplianceEvidence(): Record<string, unknown> {
  const compliance = CANONICAL_COMPLIANCE;
  return {
    bundleRootAlgorithm: compliance.bundleRootAlgorithm,
    bundleEntryCount: compliance.bundleEntryCount,
    bundleFileCount: compliance.bundleFileCount,
    bundleDirectoryCount: compliance.bundleDirectoryCount,
    bundleTotalBytes: compliance.bundleTotalBytes,
    bundleRootSha256: compliance.bundleRootSha256,
    componentCount: compliance.componentCount,
    licenseTextCount: compliance.licenseTextCount,
    payloadFileCount: compliance.payloadFileCount,
    sourceMaterialCount: compliance.sourceMaterialCount,
    releaseDecision: compliance.releaseDecision,
    blockers: compliance.blockers,
  };
}

function releasePayloadEvidence(): Record<string, unknown> {
  return {
    fileCount: 4,
    totalBytes: 1_024,
    finalTreeSha256: "1".repeat(64),
    canonicalContentTreeSha256: "2".repeat(64),
  };
}

function canonicalFilesystemHelperEvidence(
  arch: "arm64" | "x64" | "universal" = "arm64",
): Record<string, unknown> {
  return {
    helperFile: "Contents/Helpers/moss-canonical-filesystem-helper",
    metadataFile: "Contents/Resources/moss-canonical-filesystem-helper.build.json",
    schemaVersion: 1,
    protocolVersion: 2,
    arch,
    architectures: arch === "universal" ? ["arm64", "x64"] : [arch],
    fingerprint: "f".repeat(64),
    sha256: "a".repeat(64),
    size: 4_096,
  };
}

function macPublishVerification(
  artifacts: readonly {
    readonly fileName: string;
    readonly kind: "dmg" | "zip";
    readonly size: number;
    readonly sha256: string;
  }[],
  arch: "arm64" | "x64" | "universal" = "arm64",
): Record<string, unknown> {
  const compliance = releaseComplianceEvidence();
  const payload = releasePayloadEvidence();
  return {
    complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
    bundledClaude: bundledClaudeVerification("mac", arch),
    packagedCompliance: compliance,
    packagedPayload: {
      mode: "signed-canonical-binding",
      ...payload,
    },
    finalInstallable: {
      platform: "mac",
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        installedClosure: {
          compliance,
          payload,
          signature: {
            bundleIdentifier: EXPECTED_MAC_BUNDLE_ID,
            teamIdentifier: EXPECTED_APPLE_TEAM_ID,
            nestedRuntimeExecutableCount: 4,
            notarizationValidated: true,
            canonicalFilesystemHelper: canonicalFilesystemHelperEvidence(arch),
          },
          bundledClaude: bundledClaudeFinalVerification(arch),
        },
      })),
    },
  };
}

function macBuildOnlyVerification(
  input: {
    readonly fileName?: string;
    readonly size?: number;
    readonly sha256?: string;
  } = {},
): Record<string, unknown> {
  const fileName = input.fileName ?? "Moss-1.2.3-arm64.zip";
  const size = input.size ?? Buffer.byteLength("zip bytes\n");
  const artifactSha256 = input.sha256 ?? sha256(Buffer.from("zip bytes\n"));
  return {
    complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
    bundledClaude: bundledClaudeVerification("mac", "arm64"),
    packagedCompliance: releaseComplianceEvidence(),
    packagedPayload: {
      mode: "signed-canonical-binding",
      ...releasePayloadEvidence(),
    },
    macBuildOnlySignature: {
      releaseEligibility: "build-only-only",
      signatureType: "adhoc",
      canonicalFilesystemHelper: canonicalFilesystemHelperEvidence(),
      signatures: [
        {
          logicalFile: "app",
          identifier: EXPECTED_MAC_BUNDLE_ID,
          cdHash: "0123456789abcdef0123456789abcdef01234567",
          signatureType: "adhoc",
          teamIdentifier: null,
          authorities: [],
        },
        {
          logicalFile: `${MAC_ARM64_TARGET}/bin/codex`,
          identifier: "codex-fixture",
          cdHash: "89abcdef0123456789abcdef0123456789abcdef",
          signatureType: "adhoc",
          teamIdentifier: null,
          authorities: [],
        },
      ],
    },
    finalInstallable: {
      platform: "mac",
      artifacts: [
        {
          kind: "zip",
          fileName,
          size,
          sha256: artifactSha256,
          bundledClaude: bundledClaudeFinalVerification("arm64"),
        },
      ],
    },
  };
}

function windowsPublishVerification(input: {
  readonly installerFileName: string;
  readonly installerSize: number;
  readonly installerSha256: string;
}): Record<string, unknown> {
  const compliance = releaseComplianceEvidence();
  const payload = releasePayloadEvidence();
  const executableFiles = [
    "app/Moss.exe",
    `app/resources/codex-runtime/${WINDOWS_X64_TARGET}/bin/codex.exe`,
    `installer/${input.installerFileName}`,
  ];
  return {
    complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
    bundledClaude: bundledClaudeVerification("win", "x64"),
    packagedCompliance: compliance,
    packagedPayload: {
      mode: "signed-canonical-binding",
      ...payload,
    },
    finalInstallable: {
      platform: "win",
      installerFileName: input.installerFileName,
      installerSize: input.installerSize,
      installerSha256: input.installerSha256,
      uninstallValidated: true,
      installedClosure: {
        compliance,
        payload,
        authenticode: {
          executableFiles,
          certificateIdentity: {
            subjectDn: EXPECTED_WINDOWS_SUBJECT_DN,
            thumbprint: EXPECTED_WINDOWS_THUMBPRINT,
            issuerDn: EXPECTED_WINDOWS_ISSUER_DN,
            serialNumber: EXPECTED_WINDOWS_SERIAL,
          },
          signatures: executableFiles.map((file) => ({
            file,
            size:
              file === `installer/${input.installerFileName}` ? input.installerSize : file.length,
            sha256:
              file === `installer/${input.installerFileName}`
                ? input.installerSha256
                : sha256(Buffer.from(file, "utf8")),
            status: "Valid",
            signatureType: "Authenticode",
            timestamp: {
              subjectDn: "CN=Moss Trusted Timestamp",
              thumbprint: "89ABCDEF0123456789ABCDEF0123456789ABCDEF",
              serialNumber: "1122334455667788",
              notBeforeUtc: "2026-01-01T00:00:00.000Z",
              notAfterUtc: "2036-01-01T00:00:00.000Z",
              signtoolVerified: true,
            },
          })),
        },
      },
    },
  };
}

function linuxFinalInstallableFixture(input: {
  readonly appImageFileName: string;
  readonly appImageBytes: Buffer;
}): BundledCodexFinalLinuxAppImageReceipt {
  return {
    platform: "linux",
    appImageFileName: input.appImageFileName,
    appImageSize: input.appImageBytes.length,
    appImageSha256: sha256(input.appImageBytes),
    container: {
      format: "AppImage-type-2",
      elfClass: "ELF64",
      machine: "x86_64",
      squashfsVersion: "4.0",
      squashfsOffset: 4_096,
      squashfsBytesUsed: 512,
      extractor: BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID,
      validated: true,
    },
    extractionValidated: true,
    extractedClosure: {
      compliance: releaseComplianceEvidence() as never,
      payload: {
        mode: "exact-final-payload-hashes",
        targetTriples: [LINUX_X64_TARGET],
        validated: true,
      },
      runtime: {
        targetTriple: LINUX_X64_TARGET,
        maximumGlibcVersion: "2.38",
        neededLibraries: [...LINUX_PROBE_LIBRARIES],
        resolvedLibraries: [...LINUX_PROBE_LIBRARIES],
        commandCount: 5,
        validated: true,
      },
      startup: linuxLauncherIdentityFixture(),
    },
  };
}

const TEST_SIGNATURE_MARKER = Buffer.from("::TEST-SIGNATURE::", "utf8");

function fakeStrippableMachO(
  linkeditVmSize: bigint,
  payload: string,
  linkeditSegmentCount = 1,
  identity: {
    readonly architecture?: "arm64" | "x86_64";
    readonly uuidHex?: string;
  } = {},
): Buffer {
  const headerSize = 32;
  const segmentCommandSize = 72;
  const uuidCommandSize = 24;
  const content = Buffer.from(payload, "utf8");
  const commandBytes = segmentCommandSize * linkeditSegmentCount + uuidCommandSize;
  const bytes = Buffer.alloc(headerSize + commandBytes + content.length);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(identity.architecture === "x86_64" ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(linkeditSegmentCount + 1, 16);
  bytes.writeUInt32LE(commandBytes, 20);
  for (let index = 0; index < linkeditSegmentCount; index += 1) {
    const commandOffset = headerSize + segmentCommandSize * index;
    bytes.writeUInt32LE(0x19, commandOffset);
    bytes.writeUInt32LE(segmentCommandSize, commandOffset + 4);
    bytes.write("__LINKEDIT", commandOffset + 8, "ascii");
    bytes.writeBigUInt64LE(linkeditVmSize, commandOffset + 32);
    bytes.writeBigUInt64LE(BigInt(headerSize + commandBytes), commandOffset + 40);
    bytes.writeBigUInt64LE(BigInt(content.length), commandOffset + 48);
  }
  const uuidCommandOffset = headerSize + segmentCommandSize * linkeditSegmentCount;
  const uuidHex = identity.uuidHex ?? "00112233445566778899aabbccddeeff";
  if (!/^[a-f0-9]{32}$/u.test(uuidHex)) throw new Error("Invalid test Mach-O UUID");
  bytes.writeUInt32LE(0x1b, uuidCommandOffset);
  bytes.writeUInt32LE(uuidCommandSize, uuidCommandOffset + 4);
  Buffer.from(uuidHex, "hex").copy(bytes, uuidCommandOffset + 8);
  content.copy(bytes, headerSize + commandBytes);
  return bytes;
}

function appendTestSignature(content: Buffer, signature: string): Buffer {
  return Buffer.concat([content, TEST_SIGNATURE_MARKER, Buffer.from(signature, "utf8")]);
}

function successfulSignatureStripRunner(): BundledCodexCommandRunner {
  return ({ command, args, env }) => {
    const strippedPath = command.endsWith("/codesign")
      ? args.at(-1)
      : command.toLowerCase().endsWith("powershell.exe")
        ? env?.MOSS_CODEX_SIGNATURE_STRIP_PATH
        : undefined;
    if (!strippedPath) {
      throw new Error(`Unexpected signature-strip command: ${command} ${args.join(" ")}`);
    }
    const bytes = FS.readFileSync(strippedPath);
    const markerIndex = bytes.indexOf(TEST_SIGNATURE_MARKER);
    if (markerIndex < 0) {
      return { status: 1, stdout: "", stderr: "fixture signature missing" };
    }
    FS.writeFileSync(strippedPath, bytes.subarray(0, markerIndex));
    return { status: 0, stdout: "signature removed\n", stderr: "" };
  };
}

const LINUX_PROBE_LIBRARIES = [
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

function successfulLinuxProbeRunner(
  override: Partial<Record<"codex" | "models" | "versionInfo" | "dynamic" | "ldd", string>> = {},
): BundledCodexCommandRunner {
  return ({ command, args }) => {
    let stdout: string;
    if (command.endsWith("/readelf") && args[0] === "--version-info") {
      stdout = override.versionInfo ?? "Name: GLIBC_2.28\nName: GLIBC_2.38\n";
    } else if (command.endsWith("/readelf") && args[0] === "--dynamic") {
      stdout =
        override.dynamic ??
        LINUX_PROBE_LIBRARIES.map((library) => `(NEEDED) Shared library: [${library}]`).join("\n");
    } else if (command.endsWith("/ldd")) {
      stdout =
        override.ldd ??
        LINUX_PROBE_LIBRARIES.map(
          (library, index) => `${library} => /lib/x86_64-linux-gnu/${library} (0x${index + 1})`,
        ).join("\n");
    } else if (command.endsWith(Path.join("bin", "codex")) && args.includes("debug")) {
      stdout = override.models ?? '{"models":[]}\n';
    } else if (command.endsWith(Path.join("bin", "codex"))) {
      stdout = override.codex ?? "codex-cli 0.163.0\n";
    } else {
      throw new Error(`Unexpected test command: ${command} ${args.join(" ")}`);
    }
    return { status: 0, stdout, stderr: "" };
  };
}

function makeMacSignatureFixture(prefix: string): {
  appBundlePath: string;
  helperPath: string;
  helperMetadataPath: string;
  resourcesDir: string;
  runtimeRoot: string;
  targetTriples: readonly [typeof MAC_ARM64_TARGET];
} {
  const appBundlePath = Path.join(makeTempDir(prefix), "Moss.app");
  const resourcesDir = Path.join(appBundlePath, "Contents", "Resources");
  const helperPath = Path.join(
    appBundlePath,
    "Contents",
    "Helpers",
    MAC_CANONICAL_FILESYSTEM_HELPER_NAME,
  );
  const helperMetadataPath = Path.join(
    resourcesDir,
    `${MAC_CANONICAL_FILESYSTEM_HELPER_NAME}.build.json`,
  );
  const runtimeRoot = Path.join(resourcesDir, "codex-runtime", MAC_ARM64_TARGET);
  FS.mkdirSync(runtimeRoot, { recursive: true });
  for (const relativePath of MAC_RUNTIME_EXECUTABLES) {
    const filePath = Path.join(runtimeRoot, relativePath);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `fixture ${relativePath}\n`);
    FS.chmodSync(filePath, 0o755);
  }
  const helperBytes = Buffer.from("fixture signed canonical filesystem helper\n", "utf8");
  FS.mkdirSync(Path.dirname(helperPath), { recursive: true });
  FS.writeFileSync(helperPath, helperBytes, { mode: 0o755 });
  FS.writeFileSync(
    helperMetadataPath,
    `${JSON.stringify({
      schemaVersion: 1,
      helper: MAC_CANONICAL_FILESYSTEM_HELPER_NAME,
      protocolVersion: 2,
      arch: "arm64",
      architectures: ["arm64"],
      fingerprint: "f".repeat(64),
      sha256: sha256(helperBytes),
      size: helperBytes.byteLength,
    })}\n`,
  );
  return {
    appBundlePath,
    helperPath,
    helperMetadataPath,
    resourcesDir,
    runtimeRoot,
    targetTriples: [MAC_ARM64_TARGET],
  };
}

function validateMacHelperFixtureContent(fixture: {
  readonly helperPath: string;
  readonly helperMetadataPath: string;
  readonly targetTriples: readonly string[];
}) {
  const helper = FS.readFileSync(fixture.helperPath);
  return validatePackagedCanonicalFilesystemHelperMetadata({
    metadataBytes: FS.readFileSync(fixture.helperMetadataPath),
    targetTriples: fixture.targetTriples,
    helperSha256: sha256(helper),
    helperSize: helper.byteLength,
  });
}

function successfulMacSignatureRunner(input: {
  readonly appBundlePath: string;
  readonly teamForPath?: Readonly<Record<string, string>>;
  readonly adhocPath?: string;
}): BundledCodexCommandRunner {
  return ({ command, args }) => {
    const signedPath = args.at(-1) ?? "";
    if (command.endsWith("/codesign") && args.includes("--display")) {
      if (signedPath === input.adhocPath) {
        return {
          status: 0,
          stdout: "",
          stderr: [
            "Identifier=com.openai.codex.runtime",
            "CDHash=0123456789abcdef0123456789abcdef01234567",
            "Signature=adhoc",
            "TeamIdentifier=not set",
            'designated => identifier "com.openai.codex.runtime"',
          ].join("\n"),
        };
      }
      const teamIdentifier = input.teamForPath?.[signedPath] ?? EXPECTED_APPLE_TEAM_ID;
      const identifier =
        signedPath === input.appBundlePath ? EXPECTED_MAC_BUNDLE_ID : "com.openai.codex.runtime";
      return {
        status: 0,
        stdout: "",
        stderr: [
          `Identifier=${identifier}`,
          "CDHash=89abcdef0123456789abcdef0123456789abcdef",
          `Authority=Developer ID Application: Moss Software (${teamIdentifier})`,
          `TeamIdentifier=${teamIdentifier}`,
          `designated => identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = ${teamIdentifier}`,
        ].join("\n"),
      };
    }
    if (
      (command.endsWith("/codesign") && args.includes("--verify")) ||
      (command.endsWith("/xcrun") && args[0] === "stapler") ||
      command.endsWith("/spctl")
    ) {
      return { status: 0, stdout: "validated\n", stderr: "" };
    }
    throw new Error(`Unexpected test command: ${command} ${args.join(" ")}`);
  };
}

function successfulMacBuildOnlySignatureRunner(
  input: {
    readonly developerIdPath?: string;
  } = {},
): BundledCodexCommandRunner {
  return ({ command, args }) => {
    const signedPath = args.at(-1) ?? "";
    if (command.endsWith("/codesign") && args.includes("--display")) {
      if (signedPath === input.developerIdPath) {
        return {
          status: 0,
          stdout: "",
          stderr: [
            "Identifier=com.openai.codex.runtime",
            "CDHash=89abcdef0123456789abcdef0123456789abcdef",
            `Authority=Developer ID Application: OpenAI (${EXPECTED_APPLE_TEAM_ID})`,
            `TeamIdentifier=${EXPECTED_APPLE_TEAM_ID}`,
            '# designated => cdhash H"89abcdef0123456789abcdef0123456789abcdef"',
          ].join("\n"),
        };
      }
      return {
        status: 0,
        stdout: "",
        stderr: [
          `Identifier=${signedPath.endsWith(".app") ? EXPECTED_MAC_BUNDLE_ID : "codex-fixture"}`,
          "CDHash=0123456789abcdef0123456789abcdef01234567",
          "Signature=adhoc",
          "TeamIdentifier=not set",
          '# designated => cdhash H"0123456789abcdef0123456789abcdef01234567"',
        ].join("\n"),
      };
    }
    if (command.endsWith("/codesign") && args.includes("--verify")) {
      return { status: 0, stdout: "validated\n", stderr: "" };
    }
    throw new Error(`Unexpected test command: ${command} ${args.join(" ")}`);
  };
}

afterEach(() => {
  for (const directory of tempDirs) FS.rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

describe("bundled Codex release compliance gate", () => {
  it("lets macOS packaging reseal only the Codex executables and voice libraries", () => {
    const payloads = JSON.parse(
      FS.readFileSync(Path.join(CANONICAL_BUNDLE, "PAYLOADS.json"), "utf8"),
    ) as { readonly archives: readonly PayloadArchive[] };
    const copiedFiles = (archiveId: string, targetTriple: string) => {
      const prefix = `vendor/${targetTriple}/`;
      return payloads.archives
        .find((archive) => archive.id === archiveId)!
        .files.filter((file) => file.path.startsWith(prefix))
        .map((file) => ({
          path: file.path.slice(prefix.length),
          size: file.size,
          sha256: file.sha256,
        }));
    };

    const macFiles = copiedFiles("darwin-arm64", "aarch64-apple-darwin");
    const mac = resolveResealedBundledCodexPayloadPaths({
      archiveId: "darwin-arm64",
      files: macFiles,
      platform: "mac",
    });
    const voiceLibraries = macFiles
      .map((file) => file.path)
      .filter((path) => path.endsWith(".dylib"));
    expect(voiceLibraries).toHaveLength(25);
    expect(mac).toEqual([
      "bin/codex",
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/voice/bin/codex-voice-host",
      ...voiceLibraries,
    ]);
    expect(mac).toContain("codex-resources/voice/lib/libffi.8.dylib");
    expect(mac).toContain("codex-resources/voice/plugins/libgstopus.dylib");
    // Licenses, configuration and every other non-Mach-O file stay byte-exact.
    expect(mac.every((path) => !path.startsWith("licenses/"))).toBe(true);

    expect(
      resolveResealedBundledCodexPayloadPaths({
        archiveId: "win32-x64",
        files: copiedFiles("win32-x64", "x86_64-pc-windows-msvc"),
        platform: "win",
      }),
    ).toEqual([
      "bin/codex.exe",
      "bin/codex-code-mode-host.exe",
      "codex-path/rg.exe",
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
      "codex-resources/voice/bin/codex-voice-host.exe",
    ]);
  });

  it.runIf(process.platform === "win32")(
    "refuses native Linux containers and macOS executable identity on Windows",
    () => {
      const root = makeTempDir("moss-native-release-unsupported-");
      const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
      const original = fakeAppImageType2();
      FS.writeFileSync(Path.join(root, appImageFileName), original);
      let commands = 0;
      expect(() =>
        verifyBundledCodexLinuxAppImageContainerLifecycle({
          stageDistDir: root,
          appImageFileName,
          runCommand: () => {
            commands += 1;
            throw new Error("native command must not run");
          },
          validateExtractedApplication: () => {
            throw new Error("application must not be extracted");
          },
        }),
      ).toThrow(/requires a native linux\/x64 host, found win32/i);
      expect(commands).toBe(0);
      expect(FS.readdirSync(root)).toEqual([appImageFileName]);
      expect(FS.readFileSync(Path.join(root, appImageFileName))).toEqual(original);
      const fixture = makeMacSignatureFixture("moss-native-mac-unsupported-");
      const metadata = FS.readFileSync(fixture.helperMetadataPath);
      expect(() => verifyPackagedCanonicalFilesystemHelperBinding(fixture)).toThrow(
        /canonical filesystem helper must be executable/i,
      );
      expect(FS.readFileSync(fixture.helperMetadataPath)).toEqual(metadata);
    },
  );

  it("documents distinct public npm and installed-app reference identities", () => {
    const rebuild = FS.readFileSync(Path.join(CANONICAL_BUNDLE, "REBUILD.md"), "utf8");
    const publicNpmArm64Sha256 = "8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31";
    const installedChatgptReferenceSha256 =
      "a5976fd714dc0801a6f40e0e2b3051f64f1e0468f6c0f279b7d2a7afb7623f43";

    expect(rebuild).toContain("public npm distribution `@openai/codex@0.163.0`");
    expect(rebuild).toContain(publicNpmArm64Sha256);
    expect(rebuild).toContain(installedChatgptReferenceSha256);
    expect(publicNpmArm64Sha256).not.toBe(installedChatgptReferenceSha256);
    expect(rebuild).toMatch(/intentionally distinct/i);
    expect(rebuild).toMatch(/private installed bytes are never copied/i);
  });

  it("keeps audited third-party bytes outside the source formatter", () => {
    const formatterConfig = JSON.parse(
      FS.readFileSync(Path.join(REPO_ROOT, ".oxfmtrc.json"), "utf8"),
    ) as { readonly ignorePatterns?: readonly string[] };

    expect(formatterConfig.ignorePatterns).toContain("third_party/**");
  });

  it("preserves every audited third-party byte in a real core.autocrlf=true checkout", () => {
    const root = makeTempDir("moss-codex-autocrlf-checkout-");
    const sourceRepository = Path.join(root, "source");
    const checkout = Path.join(root, "checkout");
    const relativeBundle = BUNDLED_CODEX_COMPLIANCE_REPOSITORY_RELATIVE_DIRECTORY;
    const sourceBundle = Path.join(sourceRepository, relativeBundle);
    FS.mkdirSync(sourceRepository, { recursive: true });
    const fixtureAttributes = Path.join(sourceRepository, ".gitattributes");
    FS.copyFileSync(Path.join(REPO_ROOT, ".gitattributes"), fixtureAttributes);
    FS.cpSync(CANONICAL_BUNDLE, sourceBundle, { recursive: true });
    const crlfFixturePath = Path.join(sourceBundle, "sources", "autocrlf-checkout-fixture.txt");
    FS.writeFileSync(crlfFixturePath, Buffer.from("first\r\nsecond\r\n", "utf8"));

    const runGit = (cwd: string, args: readonly string[]): void => {
      const result = spawnSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      }
    };
    const snapshotTree = (directory: string): Map<string, string> => {
      const snapshot = new Map<string, string>();
      const visit = (current: string): void => {
        for (const entry of FS.readdirSync(current, { withFileTypes: true })) {
          const absolutePath = Path.join(current, entry.name);
          if (entry.isDirectory()) {
            visit(absolutePath);
          } else if (entry.isFile()) {
            const relativePath = Path.relative(directory, absolutePath).split(Path.sep).join("/");
            snapshot.set(relativePath, sha256(FS.readFileSync(absolutePath)));
          } else {
            throw new Error(`Unexpected checkout fixture entry: ${absolutePath}`);
          }
        }
      };
      visit(directory);
      return snapshot;
    };
    const expected = snapshotTree(sourceBundle);

    runGit(sourceRepository, ["init", "--quiet"]);
    runGit(sourceRepository, ["config", "user.email", "release-test@moss.invalid"]);
    runGit(sourceRepository, ["config", "user.name", "Moss Release Test"]);
    runGit(sourceRepository, ["config", "core.autocrlf", "false"]);
    runGit(sourceRepository, ["add", "--", ".gitattributes", "third_party"]);
    runGit(sourceRepository, ["commit", "--quiet", "-m", "fixture"]);
    const clone = spawnSync(
      "git",
      ["clone", "--quiet", "--no-checkout", sourceRepository, checkout],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    if (clone.status !== 0) {
      throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
    }
    runGit(checkout, ["config", "core.autocrlf", "true"]);
    runGit(checkout, ["checkout", "--quiet", "--force", "HEAD"]);

    expect(snapshotTree(Path.join(checkout, relativeBundle))).toEqual(expected);
    expect(
      FS.readFileSync(
        Path.join(checkout, relativeBundle, "sources", "autocrlf-checkout-fixture.txt"),
      ),
    ).toEqual(Buffer.from("first\r\nsecond\r\n", "utf8"));
  }, 30_000);

  it("validates the exact SBOM, license-evidence, payload-lock, and blocker ledger", () => {
    expect(
      validateBundledCodexReleaseComplianceBundle({
        directory: CANONICAL_BUNDLE,
      }),
    ).toEqual({
      directory: CANONICAL_BUNDLE,
      bundleRootAlgorithm: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM,
      bundleEntryCount: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ENTRY_COUNT,
      bundleFileCount: BUNDLED_CODEX_COMPLIANCE_BUNDLE_FILE_COUNT,
      bundleDirectoryCount: BUNDLED_CODEX_COMPLIANCE_BUNDLE_DIRECTORY_COUNT,
      bundleTotalBytes: BUNDLED_CODEX_COMPLIANCE_BUNDLE_TOTAL_BYTES,
      bundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
      componentCount: BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT,
      licenseTextCount: BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT,
      payloadFileCount: BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT,
      sourceMaterialCount: BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT,
      releaseDecision: "approved",
      blockers: [],
    });
    expect(
      validateRepositoryBundledCodexComplianceBundle({
        repoRoot: REPO_ROOT,
        expectedVersion: "0.163.0",
      }),
    ).toMatchObject({
      directory: CANONICAL_BUNDLE,
      releaseDecision: "approved",
    });
  });

  it("fails closed when runtime and compliance pins drift", () => {
    expect(() => assertBundledCodexComplianceVersion("0.145.0")).toThrow(
      /runtime version 0\.145\.0.*compliance version 0\.163\.0/i,
    );
  });

  it("rechecks shared license bytes after a successful validation of the same directory", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-revalidate-");
    expect(validateBundledCodexReleaseComplianceBundle({ directory }).releaseDecision).toBe(
      "approved",
    );
    const evidence = JSON.parse(
      FS.readFileSync(Path.join(directory, "LICENSE_EVIDENCE.json"), "utf8"),
    ) as { componentEvidence: Array<{ files: Array<{ relativePath: string }> }> };
    const licensePath = Path.join(directory, evidence.componentEvidence[0]!.files[0]!.relativePath);
    FS.appendFileSync(licensePath, "\nchanged after successful validation\n");

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /license evidence SHA-256 mismatch/i,
    );
  });

  it("rejects a later component requiring a different hash for the same shared license", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-shared-hash-");
    const evidencePath = Path.join(directory, "LICENSE_EVIDENCE.json");
    const evidence = JSON.parse(FS.readFileSync(evidencePath, "utf8")) as {
      componentEvidence: Array<{ files: Array<{ relativePath: string; sha256: string }> }>;
    };
    const seen = new Set<string>();
    const duplicate = evidence.componentEvidence
      .flatMap((component) => component.files)
      .find((file) => {
        if (seen.has(file.relativePath)) return true;
        seen.add(file.relativePath);
        return false;
      });
    expect(duplicate).toBeDefined();
    duplicate!.sha256 = "0".repeat(64);
    FS.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /license evidence SHA-256 mismatch/i,
    );
  });

  it("hash-binds the top-level license and exact source provenance", () => {
    const changedLicense = copyCanonicalBundle("moss-codex-compliance-top-license-");
    FS.appendFileSync(Path.join(changedLicense, "LICENSE"), "\ntampered\n");
    expect(() =>
      validateBundledCodexReleaseComplianceBundle({
        directory: changedLicense,
      }),
    ).toThrow(/LICENSE SHA-256 mismatch/i);

    const changedSource = copyCanonicalBundle("moss-codex-compliance-top-source-");
    const sourcePath = Path.join(changedSource, "SOURCE.json");
    const source = JSON.parse(FS.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    FS.writeFileSync(
      sourcePath,
      `${JSON.stringify({ ...source, sourceTag: "rust-v0.145.0" }, null, 2)}\n`,
    );
    expect(() => validateBundledCodexReleaseComplianceBundle({ directory: changedSource })).toThrow(
      /SOURCE\.json does not exactly match/i,
    );
  });

  it("approves production only after the audited engineering ledger has no blockers", () => {
    expect(() => assertBundledCodexReleaseApproved({ directory: CANONICAL_BUNDLE })).not.toThrow();

    const directory = copyCanonicalBundle("moss-codex-compliance-blocker-");
    const obligationsPath = Path.join(directory, "OBLIGATIONS.json");
    const obligations = JSON.parse(FS.readFileSync(obligationsPath, "utf8")) as Record<
      string,
      unknown
    >;
    obligations.releaseDecision = "blocked";
    FS.writeFileSync(obligationsPath, `${JSON.stringify(obligations, null, 2)}\n`);
    expect(() => assertBundledCodexReleaseApproved({ directory })).toThrow(
      /releaseDecision must be approved/i,
    );
  });

  it("rejects a selected Rust strong-copyleft branch", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-selection-");
    const evidencePath = Path.join(directory, "LICENSE_EVIDENCE.json");
    const evidence = JSON.parse(FS.readFileSync(evidencePath, "utf8")) as {
      componentEvidence: Array<{
        bomRef: string;
        selectedLicenseExpression: string;
      }>;
    };
    evidence.componentEvidence[0]!.selectedLicenseExpression = "GPL-3.0-only";
    FS.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const bomPath = Path.join(directory, "COMPONENTS.cdx.json");
    const bom = JSON.parse(FS.readFileSync(bomPath, "utf8")) as {
      components: Array<{
        "bom-ref": string;
        properties: Array<{ name: string; value: string }>;
      }>;
    };
    const component = bom.components.find(
      (item) => item["bom-ref"] === evidence.componentEvidence[0]!.bomRef,
    )!;
    component.properties.find((property) => property.name === "moss:selected-license")!.value =
      "GPL-3.0-only";
    FS.writeFileSync(bomPath, `${JSON.stringify(bom, null, 2)}\n`);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /selected an unapproved or strong-copyleft license/i,
    );
  });

  it("rejects an unreviewed extra SBOM component", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-extra-component-");
    const bomPath = Path.join(directory, "COMPONENTS.cdx.json");
    const bom = JSON.parse(FS.readFileSync(bomPath, "utf8")) as {
      components: unknown[];
    };
    bom.components.push({
      type: "library",
      "bom-ref": "native-unreviewed-1.0.0",
      name: "unreviewed",
      version: "1.0.0",
      licenses: [{ expression: "MIT" }],
      properties: [],
    });
    FS.writeFileSync(bomPath, `${JSON.stringify(bom, null, 2)}\n`);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      new RegExp(`expected exactly ${BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT} components`, "i"),
    );
  });

  it("rejects a changed named native license text", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-license-");
    FS.appendFileSync(Path.join(directory, "licenses/pcre2/LICENCE.md"), "\ntampered\n");

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /named license SHA-256 mismatch.*licenses\/pcre2\/LICENCE\.md/i,
    );
  });

  it("rejects an unreviewed file hidden inside the license tree", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-extra-license-file-");
    FS.writeFileSync(
      Path.join(directory, "licenses/rust/proprietary-gradient.png"),
      "not an audited license\n",
    );

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /license file inventory mismatch/i,
    );
  });

  it("hash-binds the complete payload file lock to the pinned registry archives", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-payload-");
    const payloadsPath = Path.join(directory, "PAYLOADS.json");
    const payloads = JSON.parse(FS.readFileSync(payloadsPath, "utf8")) as {
      archives: Array<{ files: Array<{ sha256: string }> }>;
    };
    payloads.archives[0]!.files[0]!.sha256 = "0".repeat(64);
    FS.writeFileSync(payloadsPath, `${JSON.stringify(payloads, null, 2)}\n`);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /PAYLOADS\.json SHA-256 mismatch/i,
    );
  });

  it("root-binds a changed license text even when its internal evidence hash is updated", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-root-license-");
    const evidencePath = Path.join(directory, "LICENSE_EVIDENCE.json");
    const evidence = JSON.parse(FS.readFileSync(evidencePath, "utf8")) as {
      componentEvidence: Array<{
        files: Array<{ relativePath: string; sha256: string }>;
      }>;
    };
    const originalText = evidence.componentEvidence[0]!.files[0]!;
    const originalRelativePath = originalText.relativePath;
    const originalLicensePath = Path.join(directory, originalRelativePath);
    const changedBytes = Buffer.concat([
      FS.readFileSync(originalLicensePath),
      Buffer.from("\nroot-tampered\n"),
    ]);
    const changedHash = sha256(changedBytes);
    const changedRelativePath = `licenses/rust/${changedHash}.txt`;
    FS.writeFileSync(Path.join(directory, changedRelativePath), changedBytes);
    if (process.platform !== "win32") {
      FS.chmodSync(Path.join(directory, changedRelativePath), 0o644);
    }
    FS.rmSync(originalLicensePath);
    for (const component of evidence.componentEvidence) {
      for (const file of component.files) {
        if (file.relativePath !== originalRelativePath) continue;
        file.relativePath = changedRelativePath;
        file.sha256 = changedHash;
      }
    }
    FS.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /bundle root SHA-256 mismatch/i,
    );
  });

  it("root-binds a changed native license even when OBLIGATIONS reports its new hash", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-root-obligations-");
    const licensePath = Path.join(directory, "licenses/pcre2/LICENCE.md");
    FS.appendFileSync(licensePath, "\nroot-tampered\n");
    const obligationsPath = Path.join(directory, "OBLIGATIONS.json");
    const obligations = JSON.parse(FS.readFileSync(obligationsPath, "utf8")) as {
      licenseAssets: Array<{ path: string; sha256: string }>;
    };
    obligations.licenseAssets.find((asset) => asset.path === "licenses/pcre2/LICENCE.md")!.sha256 =
      sha256(FS.readFileSync(licensePath));
    FS.writeFileSync(obligationsPath, `${JSON.stringify(obligations, null, 2)}\n`);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /bundle root SHA-256 mismatch/i,
    );
  });

  it("root-binds nested empty directories that file-only inventories cannot see", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-root-empty-directory-");
    const emptyDirectory = Path.join(directory, "licenses/rust/unreviewed-empty");
    FS.mkdirSync(emptyDirectory);
    if (process.platform !== "win32") FS.chmodSync(emptyDirectory, 0o755);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /bundle root SHA-256 mismatch.*directories=9/i,
    );
  });

  it.runIf(process.platform !== "win32")("root-binds distribution mode changes", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-root-mode-");
    FS.chmodSync(Path.join(directory, "LICENSE"), 0o755);

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /bundle root SHA-256 mismatch/i,
    );
  });

  it("rejects changed LGPL source material bytes", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-source-");
    FS.appendFileSync(Path.join(directory, "sources/libcap-2.75.tar.xz"), "tampered");

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /source archive SHA-256\/size mismatch.*sources\/libcap-2\.75\.tar\.xz/i,
    );
  });

  it("rejects changed corresponding-source rebuild instructions", () => {
    const directory = copyCanonicalBundle("moss-codex-compliance-rebuild-");
    FS.appendFileSync(Path.join(directory, "REBUILD.md"), "\ntampered\n");

    expect(() => validateBundledCodexReleaseComplianceBundle({ directory })).toThrow(
      /REBUILD\.md SHA-256 mismatch/i,
    );
  });

  it("copies every audited compliance asset into the readable packaged resource tree", () => {
    const stageAppDir = Path.join(makeTempDir("moss-codex-compliance-stage-"), "app");
    FS.mkdirSync(stageAppDir, { recursive: true });
    const result = stageBundledCodexComplianceBundle({
      repoRoot: REPO_ROOT,
      stageAppDir,
      expectedVersion: "0.163.0",
    });
    const staged = Path.join(stageAppDir, BUNDLED_CODEX_COMPLIANCE_PACKAGE_RELATIVE_DIRECTORY);

    expect(result.directory).toBe(staged);
    expect(
      validateStagedBundledCodexComplianceBundle({
        stageAppDir,
        expectedVersion: "0.163.0",
      }),
    ).toEqual(result);
    expect(
      validatePackagedBundledCodexComplianceBundle({
        resourcesDir: stageAppDir,
        expectedVersion: "0.163.0",
      }),
    ).toEqual(result);

    expect(FS.readFileSync(Path.join(staged, "COMPONENTS.cdx.json"))).toEqual(
      FS.readFileSync(Path.join(CANONICAL_BUNDLE, "COMPONENTS.cdx.json")),
    );
    expect(FS.readFileSync(Path.join(staged, "licenses/pcre2/LICENCE.md"))).toEqual(
      FS.readFileSync(Path.join(CANONICAL_BUNDLE, "licenses/pcre2/LICENCE.md")),
    );
    expect(FS.readFileSync(Path.join(staged, "sources/libcap-2.75.tar.xz"))).toEqual(
      FS.readFileSync(Path.join(CANONICAL_BUNDLE, "sources/libcap-2.75.tar.xz")),
    );
    if (process.platform !== "win32") {
      expect(FS.statSync(Path.join(staged, "COMPONENTS.cdx.json")).mode & 0o777).toBe(0o644);
      expect(FS.statSync(Path.join(staged, "licenses")).mode & 0o777).toBe(0o755);
    }
  }, 30_000);

  it("rejects a packaged compliance path that escapes through a parent symlink", () => {
    const root = makeTempDir("moss-codex-compliance-symlink-");
    const resourcesDir = Path.join(root, "resources");
    const realThirdPartyRoot = Path.join(root, "real-third-party-licenses");
    const realBundle = Path.join(realThirdPartyRoot, "openai-codex", "0.163.0");
    FS.mkdirSync(resourcesDir, { recursive: true });
    FS.mkdirSync(Path.dirname(realBundle), { recursive: true });
    FS.cpSync(CANONICAL_BUNDLE, realBundle, { recursive: true });
    createDirectoryAlias(realThirdPartyRoot, Path.join(resourcesDir, "third-party-licenses"));

    expect(() =>
      validatePackagedBundledCodexComplianceBundle({
        resourcesDir,
        expectedVersion: "0.163.0",
      }),
    ).toThrow(/path segment third-party-licenses must be a plain directory/i);
  });

  it("resolves Bun-store optional payload packages beside the real launcher package", () => {
    const root = makeTempDir("moss-codex-compliance-bun-store-");
    const nodeModulesDir = Path.join(root, "node_modules");
    const storeOpenAiRoot = Path.join(
      nodeModulesDir,
      ".bun",
      "@openai+codex@0.163.0",
      "node_modules",
      "@openai",
    );
    const launcherRoot = Path.join(storeOpenAiRoot, "codex");
    const optionalRoot = Path.join(storeOpenAiRoot, "codex-darwin-arm64");
    FS.mkdirSync(launcherRoot, { recursive: true });
    FS.mkdirSync(optionalRoot, { recursive: true });
    FS.mkdirSync(Path.join(nodeModulesDir, "@openai"), { recursive: true });
    createDirectoryAlias(launcherRoot, Path.join(nodeModulesDir, "@openai", "codex"));

    expect(
      resolveBundledCodexPayloadPackageRootCandidates({
        nodeModulesDir,
        archiveId: "darwin-arm64",
      }),
    ).toContain(FS.realpathSync(optionalRoot));
  });

  it("hash-binds every installed package file and rejects later byte changes", () => {
    const packageRoot = Path.join(makeTempDir("moss-codex-payload-bytes-"), "package");
    const packageJson = Buffer.from('{"name":"fixture"}\n');
    const executable = Buffer.from("fixture executable\n");
    FS.mkdirSync(Path.join(packageRoot, "vendor/test/bin"), {
      recursive: true,
    });
    FS.writeFileSync(Path.join(packageRoot, "package.json"), packageJson);
    FS.writeFileSync(Path.join(packageRoot, "vendor/test/bin/codex"), executable);
    const archive: PayloadArchive = {
      id: "launcher",
      npmPackage: "@openai/codex",
      npmVersion: "fixture",
      archive: "fixture.tgz",
      npmIntegrity: "sha512-fixture",
      size: packageJson.length + executable.length,
      sha256: "0".repeat(64),
      files: [
        {
          path: "package.json",
          size: packageJson.length,
          sha256: sha256(packageJson),
        },
        {
          path: "vendor/test/bin/codex",
          size: executable.length,
          sha256: sha256(executable),
        },
      ],
    };

    expect(() => validateBundledCodexRuntimePayload({ packageRoot, archive })).not.toThrow();
    FS.mkdirSync(Path.join(packageRoot, "node_modules/transitive"), {
      recursive: true,
    });
    FS.writeFileSync(Path.join(packageRoot, "node_modules/transitive/package.json"), "{}\n");
    expect(() => validateBundledCodexRuntimePayload({ packageRoot, archive })).not.toThrow();
    FS.appendFileSync(Path.join(packageRoot, "vendor/test/bin/codex"), "tampered");
    expect(() => validateBundledCodexRuntimePayload({ packageRoot, archive })).toThrow(
      /SHA-256\/size mismatch.*vendor\/test\/bin\/codex/i,
    );
  });

  it("hash-binds the copied packaged runtime after build-only npm files are removed", () => {
    const resourcesDir = Path.join(makeTempDir("moss-codex-copied-payload-"), "resources");
    const targetTriple = "fixture-target";
    const copiedRuntimeRoot = Path.join(resourcesDir, "codex-runtime", targetTriple);
    const executable = Buffer.from("fixture packaged executable\n");
    FS.mkdirSync(Path.join(copiedRuntimeRoot, "bin"), { recursive: true });
    FS.writeFileSync(Path.join(copiedRuntimeRoot, "bin/codex"), executable);
    const archive: PayloadArchive = {
      id: "launcher",
      npmPackage: "@openai/codex",
      npmVersion: "fixture",
      archive: "fixture.tgz",
      npmIntegrity: "sha512-fixture",
      size: executable.length,
      sha256: "0".repeat(64),
      files: [
        { path: "package.json", size: 2, sha256: sha256(Buffer.from("{}")) },
        {
          path: `vendor/${targetTriple}/bin/codex`,
          size: executable.length,
          sha256: sha256(executable),
        },
      ],
    };

    expect(() =>
      validateCopiedBundledCodexRuntimePayload({
        resourcesDir,
        targetTriple,
        archive,
      }),
    ).not.toThrow();
    FS.appendFileSync(Path.join(copiedRuntimeRoot, "bin/codex"), "tampered");
    expect(() =>
      validateCopiedBundledCodexRuntimePayload({
        resourcesDir,
        targetTriple,
        archive,
      }),
    ).toThrow(/SHA-256\/size mismatch.*bin\/codex/i);
  });

  it("binds a re-signed macOS executable to its locked unsigned content and final tree receipt", () => {
    const fixtureRoot = makeTempDir("moss-codex-signed-mac-payload-");
    const sourcePackageRoot = Path.join(fixtureRoot, "source");
    const finalPackageRoot = Path.join(fixtureRoot, "final");
    const sourceExecutable = appendTestSignature(
      fakeStrippableMachO(0x1111n, "locked executable content\n"),
      "openai",
    );
    const finalExecutable = appendTestSignature(
      fakeStrippableMachO(0x9999n, "locked executable content\n"),
      "moss",
    );
    const manifest = Buffer.from('{"version":"0.163.0"}\n');
    for (const packageRoot of [sourcePackageRoot, finalPackageRoot]) {
      FS.mkdirSync(Path.join(packageRoot, "bin"), { recursive: true });
      FS.writeFileSync(Path.join(packageRoot, "codex-package.json"), manifest);
    }
    FS.writeFileSync(Path.join(sourcePackageRoot, "bin/codex"), sourceExecutable);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), finalExecutable);
    const archive: PayloadArchive = {
      id: "darwin-arm64",
      npmPackage: "@openai/codex",
      npmVersion: "fixture",
      archive: "fixture.tgz",
      npmIntegrity: "sha512-fixture",
      size: sourceExecutable.length + manifest.length,
      sha256: "0".repeat(64),
      files: [
        {
          path: "codex-package.json",
          size: manifest.length,
          sha256: sha256(manifest),
        },
        {
          path: "bin/codex",
          size: sourceExecutable.length,
          sha256: sha256(sourceExecutable),
        },
      ],
    };

    const receipt = validateSignedBundledCodexRuntimePayload({
      sourcePackageRoot,
      finalPackageRoot,
      archive,
      signedExecutableRelativePaths: ["bin/codex"],
      platform: "mac",
      hostPlatform: "darwin",
      runCommand: successfulSignatureStripRunner(),
    });

    expect(receipt.fileCount).toBe(2);
    expect(receipt.finalTreeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.canonicalContentTreeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.files.find((file) => file.path === "bin/codex")).toMatchObject({
      signedExecutable: true,
      sourceSha256: sha256(sourceExecutable),
      finalSha256: sha256(finalExecutable),
      machO: {
        architecture: "arm64",
        uuid: "00112233-4455-6677-8899-AABBCCDDEEFF",
      },
    });
    expect(receipt.commands).toHaveLength(2);

    const tamperedExecutable = Buffer.from(finalExecutable);
    const payloadOffset = tamperedExecutable.indexOf(Buffer.from("locked executable content\n"));
    expect(payloadOffset).toBeGreaterThan(-1);
    if (payloadOffset < 0) throw new Error("Fixture payload marker is missing.");
    tamperedExecutable.writeUInt8(
      tamperedExecutable.readUInt8(payloadOffset) ^ 0xff,
      payloadOffset,
    );
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), tamperedExecutable);
    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/signature-stripped content mismatch.*bin\/codex/i);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), finalExecutable);

    const wrongUuidExecutable = appendTestSignature(
      fakeStrippableMachO(0x9999n, "locked executable content\n", 1, {
        uuidHex: "ffeeddccbbaa99887766554433221100",
      }),
      "moss",
    );
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), wrongUuidExecutable);
    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/Mach-O UUID mismatch.*bin\/codex/i);

    const wrongArchitectureExecutable = appendTestSignature(
      fakeStrippableMachO(0x9999n, "locked executable content\n", 1, {
        architecture: "x86_64",
      }),
      "moss",
    );
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), wrongArchitectureExecutable);
    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/Mach-O architecture mismatch.*bin\/codex/i);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), finalExecutable);

    const duplicateLinkeditExecutable = appendTestSignature(
      fakeStrippableMachO(0x9999n, "locked executable content\n", 2),
      "moss",
    );
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), duplicateLinkeditExecutable);
    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/duplicate __LINKEDIT/i);

    const fatExecutable = appendTestSignature(Buffer.from(finalExecutable), "fat");
    fatExecutable.writeUInt32BE(0xcafebabe, 0);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), fatExecutable);
    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/little-endian thin 64-bit Mach-O/i);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex"), finalExecutable);

    FS.writeFileSync(Path.join(finalPackageRoot, "codex-package.json"), "tampered\n");
    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/unsigned file.*codex-package\.json.*SHA-256\/size mismatch/i);
  });

  it("fails closed when a final signed payload path is replaced during signature stripping", () => {
    const fixtureRoot = makeTempDir("moss-codex-signed-payload-toctou-");
    const sourcePackageRoot = Path.join(fixtureRoot, "source");
    const finalPackageRoot = Path.join(fixtureRoot, "final");
    const sourceExecutable = appendTestSignature(
      fakeStrippableMachO(0x1111n, "locked executable content\n"),
      "openai",
    );
    const finalExecutable = appendTestSignature(
      fakeStrippableMachO(0x9999n, "locked executable content\n"),
      "moss",
    );
    const sourcePath = Path.join(sourcePackageRoot, "bin/codex");
    const finalPath = Path.join(finalPackageRoot, "bin/codex");
    FS.mkdirSync(Path.dirname(sourcePath), { recursive: true });
    FS.mkdirSync(Path.dirname(finalPath), { recursive: true });
    FS.writeFileSync(sourcePath, sourceExecutable);
    FS.writeFileSync(finalPath, finalExecutable);
    const archive: PayloadArchive = {
      id: "darwin-arm64",
      npmPackage: "@openai/codex",
      npmVersion: "fixture",
      archive: "fixture.tgz",
      npmIntegrity: "sha512-fixture",
      size: sourceExecutable.length,
      sha256: "0".repeat(64),
      files: [
        {
          path: "bin/codex",
          size: sourceExecutable.length,
          sha256: sha256(sourceExecutable),
        },
      ],
    };
    const strip = successfulSignatureStripRunner();
    let stripCount = 0;
    const replaceFinalDuringStrip: BundledCodexCommandRunner = (input) => {
      const result = strip(input);
      if (input.command.endsWith("codesign")) {
        stripCount += 1;
      }
      if (stripCount === 2) {
        stripCount += 1;
        const replacementPath = Path.join(fixtureRoot, "replacement");
        FS.writeFileSync(replacementPath, Buffer.from("attacker replacement\n"));
        FS.renameSync(replacementPath, finalPath);
      }
      return result;
    };

    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex"],
        platform: "mac",
        hostPlatform: "darwin",
        runCommand: replaceFinalDuringStrip,
      }),
    ).toThrow(
      process.platform === "win32"
        ? /EPERM: operation not permitted, rename/
        : /changed while verification was in progress/i,
    );
  });

  it("extracts the final ZIP, mounts the final DMG, and binds both immutable archive bytes", () => {
    const stageDistDir = Path.join(makeTempDir("moss-codex-final-mac-containers-"), "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const dmgFileName = "Moss-1.2.3-arm64.dmg";
    const zipFileName = "Moss-1.2.3-arm64.zip";
    const dmgPath = Path.join(stageDistDir, dmgFileName);
    const zipPath = Path.join(stageDistDir, zipFileName);
    FS.writeFileSync(dmgPath, "fixture dmg bytes\n");
    FS.writeFileSync(zipPath, "fixture zip bytes\n");
    const observedKinds: string[] = [];
    const runCommand: BundledCodexCommandRunner = ({ command, args }) => {
      if (command === "/usr/bin/ditto") {
        const archivePath = args.at(-2)!;
        expect(archivePath).not.toBe(zipPath);
        expect(Path.basename(archivePath)).toBe("mount-zip.zip");
        expect(FS.readFileSync(archivePath, "utf8")).toBe("fixture zip bytes\n");
        const extractDirectory = args.at(-1)!;
        FS.mkdirSync(Path.join(extractDirectory, "Moss.app", "Contents", "Resources"), {
          recursive: true,
        });
      } else if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
        const archivePath = args.at(-1)!;
        expect(archivePath).not.toBe(dmgPath);
        expect(Path.basename(archivePath)).toBe("mount-dmg.dmg");
        expect(FS.readFileSync(archivePath, "utf8")).toBe("fixture dmg bytes\n");
        // hdiutil can update metadata on its disposable attach input even with
        // -readonly. The retained immutable copy must remain untouched while
        // the content digest of this disposable input still stays bound.
        FS.utimesSync(archivePath, new Date(0), new Date(0));
        const mountPoint = args[args.indexOf("-mountpoint") + 1]!;
        FS.mkdirSync(Path.join(mountPoint, "Moss.app", "Contents", "Resources"), {
          recursive: true,
        });
      } else if (!(command === "/usr/bin/hdiutil" && args[0] === "detach")) {
        throw new Error(`Unexpected container command: ${command} ${args.join(" ")}`);
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const receipt = verifyBundledCodexMacArtifactContainerLifecycle({
      stageDistDir,
      dmgFileName,
      zipFileName,
      hostPlatform: "darwin",
      runCommand,
      validateAppBundle: ({ artifactKind, appBundlePath }) => {
        observedKinds.push(artifactKind);
        expect(Path.basename(appBundlePath)).toBe("Moss.app");
        return { closure: "validated", artifactKind };
      },
    });

    expect(observedKinds.toSorted()).toEqual(["dmg", "zip"]);
    expect(receipt.artifacts.map((artifact) => artifact.kind).toSorted()).toEqual(["dmg", "zip"]);
    expect(receipt.artifacts.every((artifact) => !Path.isAbsolute(artifact.fileName))).toBe(true);
    expect(receipt.artifacts.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256))).toBe(
      true,
    );
  });

  it("rejects a final ZIP replaced while its extracted app is being validated", () => {
    const root = makeTempDir("moss-codex-final-mac-container-toctou-");
    const stageDistDir = Path.join(root, "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const zipFileName = "Moss-1.2.3-arm64.zip";
    const zipPath = Path.join(stageDistDir, zipFileName);
    FS.writeFileSync(zipPath, "fixture zip bytes\n");
    const runCommand: BundledCodexCommandRunner = ({ command, args }) => {
      if (command === "/usr/bin/ditto") {
        FS.mkdirSync(Path.join(args.at(-1)!, "Moss.app", "Contents", "Resources"), {
          recursive: true,
        });
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(() =>
      verifyBundledCodexMacArtifactContainerLifecycle({
        stageDistDir,
        zipFileName,
        hostPlatform: "darwin",
        runCommand,
        validateAppBundle: () => {
          const replacement = Path.join(root, "replacement.zip");
          FS.writeFileSync(replacement, "attacker zip bytes\n");
          FS.renameSync(replacement, zipPath);
          return { closure: "forged" };
        },
      }),
    ).toThrow(
      process.platform === "win32"
        ? /EPERM: operation not permitted, rename/
        : /changed while verification was in progress/i,
    );
  });

  it("rejects content changes to the disposable DMG attach copy", () => {
    const stageDistDir = Path.join(makeTempDir("moss-codex-final-mac-mount-content-"), "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const dmgFileName = "Moss-1.2.3-arm64.dmg";
    FS.writeFileSync(Path.join(stageDistDir, dmgFileName), "fixture dmg bytes\n");
    const runCommand: BundledCodexCommandRunner = ({ command, args }) => {
      if (command === "/usr/bin/hdiutil" && args[0] === "attach") {
        const archivePath = args.at(-1)!;
        const descriptor = FS.openSync(archivePath, "r+");
        try {
          const size = FS.statSync(archivePath).size;
          FS.writeSync(descriptor, Buffer.alloc(size, 0x54), 0, size, 0);
          FS.fsyncSync(descriptor);
        } finally {
          FS.closeSync(descriptor);
        }
        const mountPoint = args[args.indexOf("-mountpoint") + 1]!;
        FS.mkdirSync(Path.join(mountPoint, "Moss.app", "Contents", "Resources"), {
          recursive: true,
        });
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(() =>
      verifyBundledCodexMacArtifactContainerLifecycle({
        stageDistDir,
        dmgFileName,
        hostPlatform: "darwin",
        runCommand,
        validateAppBundle: () => ({ closure: "validated" }),
      }),
    ).toThrow(/disposable container input.*content changed/i);
  });

  it.runIf(process.platform !== "win32")(
    "extracts a statically validated immutable AppImage only with trusted unsquashfs",
    () => {
      const stageDistDir = Path.join(makeTempDir("moss-codex-final-appimage-"), "dist");
      FS.mkdirSync(stageDistDir, { recursive: true });
      const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
      const appImagePath = Path.join(stageDistDir, appImageFileName);
      FS.writeFileSync(appImagePath, fakeAppImageType2());
      FS.chmodSync(appImagePath, 0o755);
      let privatePath = "";

      const receipt = verifyBundledCodexLinuxAppImageContainerLifecycle({
        stageDistDir,
        appImageFileName,
        hostPlatform: "linux",
        hostArch: "x64",
        runCommand: ({ command, args, cwd }) => {
          expect(command).toBe(BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH);
          expect(command).not.toBe(appImagePath);
          expect(args.slice(0, 6)).toEqual([
            "-no-progress",
            "-no-xattrs",
            "-d",
            expect.any(String),
            "-o",
            "4096",
          ]);
          expect(cwd).toBeTruthy();
          privatePath = args.at(-1)!;
          expect(privatePath).not.toBe(appImagePath);
          expect(FS.statSync(privatePath).mode & 0o111).toBe(0);
          const appDir = args[3]!;
          FS.mkdirSync(Path.join(appDir, "resources"), {
            recursive: true,
          });
          FS.writeFileSync(Path.join(appDir, "moss"), "extracted executable\n");
          return { status: 0, stdout: "", stderr: "" };
        },
        validateExtractedApplication: ({ appDir, privateAppImagePath }) => {
          expect(privateAppImagePath).toBe(privatePath);
          expect(FS.readFileSync(Path.join(appDir, "moss"), "utf8")).toContain("extracted");
          return { closure: "validated" };
        },
      });

      expect(receipt.appImageFileName).toBe(appImageFileName);
      expect(receipt.container).toMatchObject({
        format: "AppImage-type-2",
        machine: "x86_64",
        squashfsOffset: 4_096,
        squashfsBytesUsed: 512,
        extractor: BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID,
        validated: true,
      });
      expect(receipt.extractedClosure).toEqual({ closure: "validated" });
      expect(receipt.extractionValidated).toBe(true);
      expect(FS.existsSync(privatePath)).toBe(false);
    },
  );

  it("uses the official SquashFS v4 on-disk superblock field order", () => {
    const stageDistDir = Path.join(makeTempDir("moss-codex-squashfs-layout-"), "dist");
    const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
    const appImagePath = Path.join(stageDistDir, appImageFileName);
    const appImage = fakeAppImageType2();
    const superblockOffset = 4_096;
    FS.mkdirSync(stageDistDir, { recursive: true });

    // Independent raw offsets from Linux fs/squashfs/squashfs_fs.h:
    // id, xattr, inode, directory, fragment, and lookup table starts.
    expect(appImage.readBigUInt64LE(superblockOffset + 48)).toBe(160n);
    expect(appImage.readBigUInt64LE(superblockOffset + 56)).toBe(0xffff_ffff_ffff_ffffn);
    expect(appImage.readBigUInt64LE(superblockOffset + 64)).toBe(96n);
    expect(appImage.readBigUInt64LE(superblockOffset + 72)).toBe(128n);
    expect(appImage.readBigUInt64LE(superblockOffset + 80)).toBe(0xffff_ffff_ffff_ffffn);
    expect(appImage.readBigUInt64LE(superblockOffset + 88)).toBe(0xffff_ffff_ffff_ffffn);

    FS.writeFileSync(appImagePath, appImage);
    FS.chmodSync(appImagePath, 0o755);
    expect(() => inspectBundledCodexLinuxAppImageContainer(appImagePath)).not.toThrow();
  });

  it("rejects a shell fake without ever executing the candidate or an extractor", () => {
    const stageDistDir = Path.join(makeTempDir("moss-codex-fake-appimage-"), "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
    const appImagePath = Path.join(stageDistDir, appImageFileName);
    FS.writeFileSync(appImagePath, "not an AppImage\n");
    FS.chmodSync(appImagePath, 0o755);

    expect(() => inspectBundledCodexLinuxAppImageContainer(appImagePath)).toThrow(
      /ELF64|type-2 container/i,
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the fixed trusted extractor is unavailable or fails",
    () => {
      const stageDistDir = Path.join(makeTempDir("moss-codex-missing-unsquashfs-"), "dist");
      const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
      FS.mkdirSync(stageDistDir, { recursive: true });
      FS.writeFileSync(Path.join(stageDistDir, appImageFileName), fakeAppImageType2());
      FS.chmodSync(Path.join(stageDistDir, appImageFileName), 0o755);
      let validationCalls = 0;

      expect(() =>
        verifyBundledCodexLinuxAppImageContainerLifecycle({
          stageDistDir,
          appImageFileName,
          hostPlatform: "linux",
          hostArch: "x64",
          runCommand: ({ command }) => {
            expect(command).toBe(BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH);
            return { status: 127, stdout: "", stderr: "trusted extractor unavailable" };
          },
          validateExtractedApplication: () => {
            validationCalls += 1;
            return { closure: "forged" };
          },
        }),
      ).toThrow(/AppImage extraction failed.*trusted extractor unavailable/i);
      expect(validationCalls).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects changed extracted AppImage content and source-path replacement",
    () => {
      const root = makeTempDir("moss-codex-appimage-replacement-");
      const stageDistDir = Path.join(root, "dist");
      FS.mkdirSync(stageDistDir, { recursive: true });
      const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
      const appImagePath = Path.join(stageDistDir, appImageFileName);
      FS.writeFileSync(appImagePath, fakeAppImageType2());
      FS.chmodSync(appImagePath, 0o755);

      expect(() =>
        verifyBundledCodexLinuxAppImageContainerLifecycle({
          stageDistDir,
          appImageFileName,
          hostPlatform: "linux",
          hostArch: "x64",
          runCommand: ({ args }) => {
            const appDir = args[3]!;
            FS.mkdirSync(appDir, { recursive: true });
            FS.writeFileSync(Path.join(appDir, "payload"), "tampered extracted bytes\n");
            return { status: 0, stdout: "", stderr: "" };
          },
          validateExtractedApplication: ({ appDir }) => {
            if (FS.readFileSync(Path.join(appDir, "payload"), "utf8") !== "expected bytes\n") {
              throw new Error("extracted payload mismatch");
            }
            return { closure: "forged" };
          },
        }),
      ).toThrow(/extracted payload mismatch/i);

      expect(() =>
        verifyBundledCodexLinuxAppImageContainerLifecycle({
          stageDistDir,
          appImageFileName,
          hostPlatform: "linux",
          hostArch: "x64",
          runCommand: ({ args }) => {
            FS.mkdirSync(args[3]!, { recursive: true });
            const replacement = Path.join(root, "replacement.AppImage");
            FS.writeFileSync(replacement, fakeAppImageType2({ bytesUsed: 640 }));
            FS.chmodSync(replacement, 0o755);
            FS.renameSync(replacement, appImagePath);
            return { status: 0, stdout: "", stderr: "" };
          },
          validateExtractedApplication: () => ({ closure: "forged" }),
        }),
      ).toThrow(/changed while verification was in progress/i);
    },
  );

  it("rejects a tampered AppImage marker, SquashFS size, or trailing container bytes", () => {
    const root = makeTempDir("moss-codex-appimage-container-tamper-");
    const stageDistDir = Path.join(root, "dist");
    const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
    const appImagePath = Path.join(stageDistDir, appImageFileName);
    FS.mkdirSync(stageDistDir, { recursive: true });
    const verify = (bytes: Buffer) => {
      FS.writeFileSync(appImagePath, bytes);
      FS.chmodSync(appImagePath, 0o755);
      return () => inspectBundledCodexLinuxAppImageContainer(appImagePath);
    };

    const wrongType = fakeAppImageType2();
    wrongType[10] = 1;
    expect(verify(wrongType)).toThrow(/type-2 marker/i);
    expect(verify(fakeAppImageType2({ bytesUsed: 8_192 }))).toThrow(
      /exactly one unambiguous SquashFS/i,
    );
    expect(verify(fakeAppImageType2({ trailingByte: 0x41 }))).toThrow(
      /exactly one unambiguous SquashFS/i,
    );
  });

  it.runIf(
    process.platform === "linux" &&
      process.arch === "x64" &&
      FS.existsSync("/usr/bin/mksquashfs") &&
      FS.existsSync(BUNDLED_CODEX_TRUSTED_UNSQUASHFS_PATH),
  )("extracts a real type-2 AppImage fixture with trusted unsquashfs", () => {
    const root = makeTempDir("moss-codex-real-appimage-");
    const sourceDir = Path.join(root, "source");
    const squashfsPath = Path.join(root, "fixture.squashfs");
    const stageDistDir = Path.join(root, "dist");
    const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
    FS.mkdirSync(Path.join(sourceDir, "resources"), { recursive: true });
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.writeFileSync(Path.join(sourceDir, "moss"), "real extracted fixture\n");
    const created = spawnSync(
      "/usr/bin/mksquashfs",
      [sourceDir, squashfsPath, "-noappend", "-no-progress", "-all-root"],
      { encoding: "utf8" },
    );
    if (created.status !== 0) {
      throw new Error(`mksquashfs fixture creation failed: ${created.stderr || created.stdout}`);
    }
    const prefix = Buffer.alloc(4_096);
    fakeLinuxX64Elf().copy(prefix);
    prefix.set([0x41, 0x49, 2], 8);
    const appImagePath = Path.join(stageDistDir, appImageFileName);
    FS.writeFileSync(appImagePath, Buffer.concat([prefix, FS.readFileSync(squashfsPath)]));
    FS.chmodSync(appImagePath, 0o755);

    const receipt = verifyBundledCodexLinuxAppImageContainerLifecycle({
      stageDistDir,
      appImageFileName,
      validateExtractedApplication: ({ appDir }) => {
        expect(FS.readFileSync(Path.join(appDir, "moss"), "utf8")).toBe("real extracted fixture\n");
        return { closure: "real-container" };
      },
    });

    expect(receipt.extractedClosure).toEqual({ closure: "real-container" });
    expect(receipt.container.squashfsOffset).toBe(4_096);
  });

  it("binds the launcher ELF bytes and exact Electron runtime version", () => {
    const appDir = Path.join(makeTempDir("moss-codex-launcher-identity-"), "AppDir");
    const launcherPath = Path.join(appDir, "moss");
    FS.mkdirSync(appDir, { recursive: true });
    FS.writeFileSync(launcherPath, fakeLinuxX64Elf());
    FS.chmodSync(launcherPath, 0o755);
    const identity = verifyBundledCodexLinuxLauncherIdentity({
      executablePath: launcherPath,
      expectedExecutableFile: "moss",
      expectedRuntimeVersion: EXPECTED_ELECTRON_RUNTIME_VERSION,
      hostPlatform: "linux",
      hostArch: "x64",
      runCommand: () => ({ status: 0, stdout: "v40.6.0\n", stderr: "" }),
    });

    expect(identity).toEqual(linuxLauncherIdentityFixture());
    expect(() =>
      verifyBundledCodexLinuxLauncherIdentity({
        executablePath: launcherPath,
        expectedExecutableFile: "moss",
        expectedRuntimeVersion: EXPECTED_ELECTRON_RUNTIME_VERSION,
        expectedIdentity: identity,
        hostPlatform: "linux",
        hostArch: "x64",
        runCommand: () => ({ status: 0, stdout: "v40.6.1\n", stderr: "" }),
      }),
    ).toThrow(/runtime version mismatch/i);
  });

  it("rejects valid resources paired with a shell-stub launcher before startup", () => {
    const appDir = Path.join(makeTempDir("moss-codex-stub-launcher-"), "AppDir");
    const resourcesDir = Path.join(appDir, "resources");
    const launcherPath = Path.join(appDir, "moss");
    FS.mkdirSync(resourcesDir, { recursive: true });
    FS.writeFileSync(Path.join(resourcesDir, "fixture"), "valid resource fixture\n");
    FS.writeFileSync(launcherPath, "#!/bin/sh\nprintf 'v40.6.0\\n'\n");
    FS.chmodSync(launcherPath, 0o755);
    let commandCalls = 0;

    expect(() =>
      verifyBundledCodexLinuxLauncherIdentity({
        executablePath: launcherPath,
        expectedExecutableFile: "moss",
        expectedRuntimeVersion: EXPECTED_ELECTRON_RUNTIME_VERSION,
        expectedIdentity: linuxLauncherIdentityFixture(),
        hostPlatform: "linux",
        hostArch: "x64",
        runCommand: () => {
          commandCalls += 1;
          return { status: 0, stdout: "v40.6.0\n", stderr: "" };
        },
      }),
    ).toThrow(/ELF64/i);
    expect(commandCalls).toBe(0);
  });

  it("installs the final NSIS candidate before accepting its installed closure", () => {
    const stageDistDir = Path.join(makeTempDir("moss-codex-final-nsis-"), "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const installerFileName = "Moss-1.2.3-x64.exe";
    const installerPath = Path.join(stageDistDir, installerFileName);
    FS.writeFileSync(installerPath, "fixture nsis bytes\n");
    const receipt = verifyBundledCodexWindowsInstallerLifecycle({
      stageDistDir,
      installerFileName,
      hostPlatform: "win32",
      runCommand: ({ command, env }) => {
        expect(Path.win32.isAbsolute(command)).toBe(true);
        const installDirectory = env?.MOSS_CODEX_NSIS_INSTALL_DIRECTORY;
        if (env?.MOSS_CODEX_NSIS_UNINSTALLER_PATH) {
          FS.rmSync(Path.dirname(env.MOSS_CODEX_NSIS_UNINSTALLER_PATH), {
            recursive: true,
            force: true,
          });
        } else if (installDirectory) {
          expect(env?.MOSS_CODEX_NSIS_INSTALLER_PATH).not.toBe(installerPath);
          expect(FS.readFileSync(env!.MOSS_CODEX_NSIS_INSTALLER_PATH!, "utf8")).toBe(
            "fixture nsis bytes\n",
          );
          FS.mkdirSync(Path.join(installDirectory, "resources"), {
            recursive: true,
          });
          FS.writeFileSync(Path.join(installDirectory, "Moss.exe"), "installed app\n");
          FS.writeFileSync(Path.join(installDirectory, "Uninstall Moss.exe"), "uninstaller\n");
        } else {
          throw new Error("Missing installer lifecycle test directory.");
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      validateInstalledApplication: ({ installDirectory }) => {
        expect(FS.readFileSync(Path.join(installDirectory, "Moss.exe"), "utf8")).toContain(
          "installed app",
        );
        return { closure: "validated" };
      },
    });

    expect(receipt.installerFileName).toBe(installerFileName);
    expect(receipt.installedClosure).toEqual({ closure: "validated" });
    expect(receipt.installerSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not claim NSIS uninstall validation while the installed tree remains", () => {
    const stageDistDir = Path.join(makeTempDir("moss-codex-final-nsis-uninstall-"), "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const installerFileName = "Moss-1.2.3-x64.exe";
    FS.writeFileSync(Path.join(stageDistDir, installerFileName), "fixture nsis bytes\n");

    expect(() =>
      verifyBundledCodexWindowsInstallerLifecycle({
        stageDistDir,
        installerFileName,
        hostPlatform: "win32",
        runCommand: ({ env }) => {
          const installDirectory = env?.MOSS_CODEX_NSIS_INSTALL_DIRECTORY;
          if (installDirectory) {
            FS.mkdirSync(Path.join(installDirectory, "resources"), {
              recursive: true,
            });
            FS.writeFileSync(Path.join(installDirectory, "Moss.exe"), "installed app\n");
            FS.writeFileSync(Path.join(installDirectory, "Uninstall Moss.exe"), "uninstaller\n");
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        validateInstalledApplication: () => ({ closure: "validated" }),
      }),
    ).toThrow(/uninstall.*installed tree remains/i);
  });

  it("accepts canonical re-sign binding only with explicit ad-hoc build-only provenance", () => {
    const root = makeTempDir("moss-codex-build-only-receipt-");
    const stageDistDir = Path.join(root, "dist");
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.writeFileSync(Path.join(stageDistDir, "Moss-1.2.3-arm64.zip"), "zip bytes\n");

    const written = copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir,
      outputDir: Path.join(root, "release"),
      platform: "mac",
      arch: "arm64",
      releaseMode: "build-only",
      signed: false,
      expectedVersion: "0.163.0",
      verification: macBuildOnlyVerification(),
    });
    expect(written.receipt.publishEligible).toBe(false);
    expect(written.receipt.verification.macBuildOnlySignature).toMatchObject({
      releaseEligibility: "build-only-only",
      signatureType: "adhoc",
      canonicalFilesystemHelper: canonicalFilesystemHelperEvidence(),
    });

    const missingHelperBinding = macBuildOnlyVerification();
    delete (missingHelperBinding.macBuildOnlySignature as Record<string, unknown>)
      .canonicalFilesystemHelper;
    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir: Path.join(root, "missing-helper-binding"),
        platform: "mac",
        arch: "arm64",
        releaseMode: "build-only",
        signed: false,
        expectedVersion: "0.163.0",
        verification: missingHelperBinding,
      }),
    ).toThrow(/canonicalFilesystemHelper.*object/i);

    const missingProvenance = macBuildOnlyVerification();
    delete missingProvenance.macBuildOnlySignature;
    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir: Path.join(root, "missing-provenance"),
        platform: "mac",
        arch: "arm64",
        releaseMode: "build-only",
        signed: false,
        expectedVersion: "0.163.0",
        verification: missingProvenance,
      }),
    ).toThrow(/build-only.*ad-hoc.*provenance/i);

    const developerIdProvenance = macBuildOnlyVerification();
    const signature = developerIdProvenance.macBuildOnlySignature as {
      signatures: Array<Record<string, unknown>>;
    };
    signature.signatures[1] = {
      ...signature.signatures[1],
      signatureType: "developer-id",
      teamIdentifier: EXPECTED_APPLE_TEAM_ID,
      authorities: [`Developer ID Application: OpenAI (${EXPECTED_APPLE_TEAM_ID})`],
    };
    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir: Path.join(root, "developer-id-provenance"),
        platform: "mac",
        arch: "arm64",
        releaseMode: "build-only",
        signed: false,
        expectedVersion: "0.163.0",
        verification: developerIdProvenance,
      }),
    ).toThrow(/build-only.*ad-hoc.*provenance/i);
  });

  it("keeps the canonical helper binding in build-desktop-artifact durable verification", () => {
    const buildDriver = FS.readFileSync(
      Path.join(REPO_ROOT, "scripts", "build-desktop-artifact.ts"),
      "utf8",
    );
    expect(buildDriver).toMatch(
      /macBuildOnlySignature:\s*\{[\s\S]{0,1000}canonicalFilesystemHelper:\s*[\s\S]{0,300}\.canonicalFilesystemHelper/u,
    );
  });

  it("feeds the canonical bundle closure into publish eligibility and rejects stale counts", () => {
    const root = makeTempDir("moss-codex-canonical-receipt-closure-");
    const stageDistDir = Path.join(root, "dist");
    const outputDir = Path.join(root, "release");
    const dmgFileName = "Moss-1.2.3-arm64.dmg";
    const dmgBytes = Buffer.from("canonical dmg bytes\n");
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.writeFileSync(Path.join(stageDistDir, dmgFileName), dmgBytes);
    const artifacts = [
      {
        kind: "dmg" as const,
        fileName: dmgFileName,
        size: dmgBytes.length,
        sha256: sha256(dmgBytes),
      },
    ];

    const canonicalVerification = macPublishVerification(artifacts);
    const accepted = copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir,
      outputDir,
      platform: "mac",
      arch: "arm64",
      releaseMode: "publish",
      signed: true,
      expectedVersion: "0.163.0",
      verification: canonicalVerification,
    });
    expect(accepted.receipt.publishEligible).toBe(true);
    expect(accepted.receipt.verification.packagedCompliance).toMatchObject({
      componentCount: CANONICAL_COMPLIANCE.componentCount,
      licenseTextCount: CANONICAL_COMPLIANCE.licenseTextCount,
    });

    const staleVerification = macPublishVerification(artifacts);
    const staleCompliance = staleVerification.packagedCompliance as Record<string, unknown>;
    staleCompliance.componentCount = 1_335;
    staleCompliance.licenseTextCount = 581;
    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir: Path.join(root, "stale-release"),
        platform: "mac",
        arch: "arm64",
        releaseMode: "publish",
        signed: true,
        expectedVersion: "0.163.0",
        verification: staleVerification,
      }),
    ).toThrow(/exact approved closure/i);
  });

  it("copies every release target with no-replace semantics and rehashes a persistent receipt", () => {
    const root = makeTempDir("moss-codex-release-receipt-");
    const stageDistDir = Path.join(root, "dist");
    const outputDir = Path.join(root, "release");
    FS.mkdirSync(stageDistDir, { recursive: true });
    const dmgFileName = "Moss-1.2.3-arm64.dmg";
    const zipFileName = "Moss-1.2.3-arm64.zip";
    const dmgBytes = Buffer.from("dmg bytes\n");
    const zipBytes = Buffer.from("zip bytes\n");
    FS.writeFileSync(Path.join(stageDistDir, dmgFileName), dmgBytes);
    FS.writeFileSync(Path.join(stageDistDir, zipFileName), zipBytes);
    const written = copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir,
      outputDir,
      platform: "mac",
      arch: "arm64",
      releaseMode: "publish",
      signed: true,
      expectedVersion: "0.163.0",
      verification: macPublishVerification([
        {
          kind: "dmg",
          fileName: dmgFileName,
          size: dmgBytes.length,
          sha256: sha256(dmgBytes),
        },
        {
          kind: "zip",
          fileName: zipFileName,
          size: zipBytes.length,
          sha256: sha256(zipBytes),
        },
      ]),
    });

    expect(Path.isAbsolute(written.receiptPath)).toBe(true);
    expect(written.receipt.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "Moss-1.2.3-arm64.dmg",
      "Moss-1.2.3-arm64.zip",
    ]);
    const finalArtifacts = (
      written.receipt.verification.finalInstallable as {
        artifacts: Array<{ installedClosure: { signature: Record<string, unknown> } }>;
      }
    ).artifacts;
    expect(
      finalArtifacts.map(
        (artifact) => artifact.installedClosure.signature.canonicalFilesystemHelper,
      ),
    ).toEqual([canonicalFilesystemHelperEvidence(), canonicalFilesystemHelperEvidence()]);

    const mismatchedHelpers = macPublishVerification([
      {
        kind: "dmg",
        fileName: dmgFileName,
        size: dmgBytes.length,
        sha256: sha256(dmgBytes),
      },
      {
        kind: "zip",
        fileName: zipFileName,
        size: zipBytes.length,
        sha256: sha256(zipBytes),
      },
    ]);
    const mismatchedArtifacts = (
      mismatchedHelpers.finalInstallable as {
        artifacts: Array<{
          installedClosure: { signature: { canonicalFilesystemHelper: { sha256: string } } };
        }>;
      }
    ).artifacts;
    mismatchedArtifacts[1]!.installedClosure.signature.canonicalFilesystemHelper.sha256 =
      "b".repeat(64);
    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir: Path.join(root, "mismatched-helper-release"),
        platform: "mac",
        arch: "arm64",
        releaseMode: "publish",
        signed: true,
        expectedVersion: "0.163.0",
        verification: mismatchedHelpers,
      }),
    ).toThrow(/containers do not contain the same canonical filesystem helper binding/i);
    expect(
      verifyBundledCodexReleaseReceipt({
        outputDir,
        expectedPlatform: "mac",
        expectedArch: "arm64",
        requirePublishEligible: true,
      }),
    ).toEqual(written.receipt);

    const receiptText = FS.readFileSync(written.receiptPath, "utf8");
    const receiptMutations: ReadonlyArray<(receipt: Record<string, unknown>) => void> = [
      (receipt) => {
        delete (receipt.verification as Record<string, unknown>).bundledClaude;
      },
      (receipt) => {
        const bundledClaude = (receipt.verification as Record<string, unknown>)
          .bundledClaude as Record<string, unknown>;
        bundledClaude.schemaVersion = 2;
      },
      (receipt) => {
        const bundledClaude = (receipt.verification as Record<string, unknown>)
          .bundledClaude as Record<string, unknown>;
        bundledClaude.codeVersion = "0.0.0";
      },
      (receipt) => {
        const bundledClaude = (receipt.verification as Record<string, unknown>).bundledClaude as {
          targets: Array<Record<string, unknown>>;
        };
        bundledClaude.targets[0]!.cpu = "x64";
      },
      (receipt) => {
        const bundledClaude = (receipt.verification as Record<string, unknown>).bundledClaude as {
          targets: Array<Record<string, unknown>>;
        };
        bundledClaude.targets[0]!.method = "injected-test";
      },
    ];
    for (const mutate of receiptMutations) {
      const receipt = JSON.parse(receiptText) as Record<string, unknown>;
      mutate(receipt);
      FS.writeFileSync(written.receiptPath, `${JSON.stringify(receipt)}\n`);
      expect(() =>
        verifyBundledCodexReleaseReceipt({
          outputDir,
          expectedPlatform: "mac",
          expectedArch: "arm64",
          requirePublishEligible: true,
        }),
      ).toThrow(/Bundled Claude release verification receipt/);
    }
    FS.writeFileSync(written.receiptPath, receiptText);

    FS.writeFileSync(Path.join(outputDir, "unreceipted-update.yml"), "rogue output\n");
    expect(() =>
      verifyBundledCodexReleaseReceipt({
        outputDir,
        expectedPlatform: "mac",
        expectedArch: "arm64",
        requirePublishEligible: true,
      }),
    ).toThrow(/output inventory.*unreceipted/i);
    FS.rmSync(Path.join(outputDir, "unreceipted-update.yml"));

    FS.appendFileSync(Path.join(outputDir, "Moss-1.2.3-arm64.zip"), "tampered");
    expect(() =>
      verifyBundledCodexReleaseReceipt({
        outputDir,
        expectedPlatform: "mac",
        expectedArch: "arm64",
        requirePublishEligible: true,
      }),
    ).toThrow(/artifact SHA-256\/size mismatch/i);
  });

  it("rejects a publish receipt whose final container proof is not bound to copied bytes", () => {
    const root = makeTempDir("moss-codex-release-receipt-container-binding-");
    const stageDistDir = Path.join(root, "dist");
    const outputDir = Path.join(root, "release");
    const dmgFileName = "Moss-1.2.3-arm64.dmg";
    const dmgBytes = Buffer.from("dmg bytes\n");
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.writeFileSync(Path.join(stageDistDir, dmgFileName), dmgBytes);

    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir,
        platform: "mac",
        arch: "arm64",
        releaseMode: "publish",
        signed: true,
        expectedVersion: "0.163.0",
        verification: macPublishVerification([
          {
            kind: "dmg",
            fileName: dmgFileName,
            size: dmgBytes.length,
            sha256: "f".repeat(64),
          },
        ]),
      }),
    ).toThrow(/final installable.*not bound/i);
    expect(FS.existsSync(Path.join(outputDir, dmgFileName))).toBe(false);
  });

  it("rewrites and re-verifies the receipt in the exact promoted upload directory", () => {
    const root = makeTempDir("moss-codex-release-promotion-");
    const stageDistDir = Path.join(root, "dist");
    const sourceDir = Path.join(root, "release");
    const outputDir = Path.join(root, "release-publish");
    const dmgFileName = "Moss-1.2.3-x64.dmg";
    const dmgBytes = Buffer.from("dmg bytes\n");
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.writeFileSync(Path.join(stageDistDir, dmgFileName), dmgBytes);
    FS.writeFileSync(Path.join(stageDistDir, "latest-mac.yml"), "version: 1.2.3\n");
    FS.writeFileSync(Path.join(stageDistDir, "builder-debug.yml"), "must not publish\n");
    copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir,
      outputDir: sourceDir,
      platform: "mac",
      arch: "x64",
      releaseMode: "publish",
      signed: true,
      expectedVersion: "0.163.0",
      verification: macPublishVerification(
        [
          {
            kind: "dmg",
            fileName: dmgFileName,
            size: dmgBytes.length,
            sha256: sha256(dmgBytes),
          },
        ],
        "x64",
      ),
    });

    const promoted = promoteBundledCodexReleaseArtifacts({
      sourceDir,
      outputDir,
      expectedPlatform: "mac",
      expectedArch: "x64",
      requirePublishEligible: true,
      artifactRenames: { "latest-mac.yml": "latest-mac-x64.yml" },
    });

    expect(promoted.receipt.artifacts.map((artifact) => artifact.fileName)).toEqual([
      dmgFileName,
      "latest-mac-x64.yml",
    ]);
    expect(FS.existsSync(Path.join(outputDir, "builder-debug.yml"))).toBe(false);
    expect(
      verifyBundledCodexReleaseReceipt({
        outputDir,
        expectedPlatform: "mac",
        expectedArch: "x64",
        requirePublishEligible: true,
      }),
    ).toEqual(promoted.receipt);

    const replacementPath = Path.join(root, "replacement.dmg");
    FS.writeFileSync(replacementPath, "replacement bytes\n");
    FS.renameSync(replacementPath, Path.join(outputDir, dmgFileName));
    expect(() =>
      verifyBundledCodexReleaseReceipt({
        outputDir,
        expectedPlatform: "mac",
        expectedArch: "x64",
        requirePublishEligible: true,
      }),
    ).toThrow(/SHA-256\/size mismatch/i);
  });

  it("recomputes Windows and Linux publish eligibility from complete platform evidence", () => {
    const windowsRoot = makeTempDir("moss-codex-release-receipt-windows-");
    const windowsStage = Path.join(windowsRoot, "dist");
    const windowsOutput = Path.join(windowsRoot, "release");
    const installerFileName = "Moss-1.2.3-x64.exe";
    const installerBytes = Buffer.from("nsis installer bytes\n");
    FS.mkdirSync(windowsStage, { recursive: true });
    FS.writeFileSync(Path.join(windowsStage, installerFileName), installerBytes);
    const windows = copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir: windowsStage,
      outputDir: windowsOutput,
      platform: "win",
      arch: "x64",
      releaseMode: "publish",
      signed: true,
      expectedVersion: "0.163.0",
      verification: windowsPublishVerification({
        installerFileName,
        installerSize: installerBytes.length,
        installerSha256: sha256(installerBytes),
      }),
    });
    expect(windows.receipt.publishEligible).toBe(true);
    expect(
      verifyBundledCodexReleaseReceipt({
        outputDir: windowsOutput,
        expectedPlatform: "win",
        expectedArch: "x64",
        requirePublishEligible: true,
      }).publishEligible,
    ).toBe(true);

    const linuxRoot = makeTempDir("moss-codex-release-receipt-linux-");
    const linuxStage = Path.join(linuxRoot, "dist");
    const linuxOutput = Path.join(linuxRoot, "release");
    FS.mkdirSync(linuxStage, { recursive: true });
    const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
    const appImageBytes = fakeAppImageType2();
    FS.writeFileSync(Path.join(linuxStage, appImageFileName), appImageBytes);
    const finalInstallable = linuxFinalInstallableFixture({
      appImageFileName,
      appImageBytes,
    });
    const linuxFinalVerifier = () => finalInstallable;
    const linux = copyBundledCodexReleaseArtifactsAndWriteReceipt({
      stageDistDir: linuxStage,
      outputDir: linuxOutput,
      platform: "linux",
      arch: "x64",
      releaseMode: "publish",
      signed: false,
      expectedVersion: "0.163.0",
      verification: {
        complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
        bundledClaude: bundledClaudeVerification("linux", "x64"),
        packagedCompliance: releaseComplianceEvidence(),
        packagedPayload: {
          mode: "exact-final-payload-hashes",
          validated: true,
        },
        linuxRuntime: {
          targetTriple: LINUX_X64_TARGET,
          maximumGlibcVersion: "2.38",
          neededLibraries: [...LINUX_PROBE_LIBRARIES],
          resolvedLibraries: [...LINUX_PROBE_LIBRARIES],
        },
        linuxLauncher: linuxLauncherIdentityFixture(),
        finalInstallable,
      },
      linuxFinalVerifier,
    });
    expect(linux.receipt.publishEligible).toBe(true);
    expect(
      verifyBundledCodexReleaseReceipt({
        outputDir: linuxOutput,
        expectedPlatform: "linux",
        expectedArch: "x64",
        requirePublishEligible: true,
        linuxFinalVerifier,
      }).publishEligible,
    ).toBe(true);
  });

  it("never grants Linux publish eligibility from fabricated AppImage evidence alone", () => {
    const root = makeTempDir("moss-codex-release-fake-appimage-proof-");
    const stageDistDir = Path.join(root, "dist");
    const outputDir = Path.join(root, "release");
    const appImageFileName = "Moss-1.2.3-x86_64.AppImage";
    const appImageBytes = Buffer.from("fabricated AppImage bytes\n");
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.writeFileSync(Path.join(stageDistDir, appImageFileName), appImageBytes);
    FS.chmodSync(Path.join(stageDistDir, appImageFileName), 0o755);

    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir,
        platform: "linux",
        arch: "x64",
        releaseMode: "publish",
        signed: false,
        expectedVersion: "0.163.0",
        verification: {
          complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
          bundledClaude: bundledClaudeVerification("linux", "x64"),
          packagedCompliance: releaseComplianceEvidence(),
          packagedPayload: {
            mode: "exact-final-payload-hashes",
            validated: true,
          },
          linuxRuntime: {
            targetTriple: LINUX_X64_TARGET,
            maximumGlibcVersion: "2.38",
            neededLibraries: [...LINUX_PROBE_LIBRARIES],
            resolvedLibraries: [...LINUX_PROBE_LIBRARIES],
          },
          linuxLauncher: linuxLauncherIdentityFixture(),
          finalInstallable: linuxFinalInstallableFixture({
            appImageFileName,
            appImageBytes,
          }),
        },
      }),
    ).toThrow(/container proof|native linux\/x64|AppImage extraction failed/i);
  });

  it("never overwrites an existing copied artifact or compliance receipt", () => {
    const root = makeTempDir("moss-codex-release-receipt-no-replace-");
    const stageDistDir = Path.join(root, "dist");
    const outputDir = Path.join(root, "release");
    FS.mkdirSync(stageDistDir, { recursive: true });
    FS.mkdirSync(outputDir, { recursive: true });
    FS.writeFileSync(Path.join(stageDistDir, "Moss-1.2.3-x64.exe"), "new installer\n");
    FS.writeFileSync(Path.join(outputDir, "Moss-1.2.3-x64.exe"), "existing installer\n");

    expect(() =>
      copyBundledCodexReleaseArtifactsAndWriteReceipt({
        stageDistDir,
        outputDir,
        platform: "win",
        arch: "x64",
        releaseMode: "publish",
        signed: true,
        expectedVersion: "0.163.0",
        verification: {
          complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
          bundledClaude: bundledClaudeVerification("win", "x64"),
          finalInstallable: { platform: "win", installed: true },
        },
      }),
    ).toThrow(/already exists/i);
    expect(FS.readFileSync(Path.join(outputDir, "Moss-1.2.3-x64.exe"), "utf8")).toBe(
      "existing installer\n",
    );
  });

  it("rejects a signed Windows executable whose Authenticode-stripped content drifted", () => {
    const fixtureRoot = makeTempDir("moss-codex-signed-win-payload-");
    const sourcePackageRoot = Path.join(fixtureRoot, "source");
    const finalPackageRoot = Path.join(fixtureRoot, "final");
    const sourceExecutable = appendTestSignature(
      Buffer.from("locked executable content\n"),
      "openai",
    );
    const finalExecutable = appendTestSignature(
      Buffer.from("tampered executable content\n"),
      "moss",
    );
    FS.mkdirSync(Path.join(sourcePackageRoot, "bin"), { recursive: true });
    FS.mkdirSync(Path.join(finalPackageRoot, "bin"), { recursive: true });
    FS.writeFileSync(Path.join(sourcePackageRoot, "bin/codex.exe"), sourceExecutable);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex.exe"), finalExecutable);
    const archive: PayloadArchive = {
      id: "win32-x64",
      npmPackage: "@openai/codex",
      npmVersion: "fixture",
      archive: "fixture.tgz",
      npmIntegrity: "sha512-fixture",
      size: sourceExecutable.length,
      sha256: "0".repeat(64),
      files: [
        {
          path: "bin/codex.exe",
          size: sourceExecutable.length,
          sha256: sha256(sourceExecutable),
        },
      ],
    };

    expect(() =>
      validateSignedBundledCodexRuntimePayload({
        sourcePackageRoot,
        finalPackageRoot,
        archive,
        signedExecutableRelativePaths: ["bin/codex.exe"],
        platform: "win",
        hostPlatform: "win32",
        runCommand: successfulSignatureStripRunner(),
      }),
    ).toThrow(/signature-stripped content mismatch.*bin\/codex\.exe/i);
  });

  it("strips Windows signatures only with an absolute Windows Kits signtool", () => {
    const fixtureRoot = makeTempDir("moss-codex-signed-win-tool-path-");
    const sourcePackageRoot = Path.join(fixtureRoot, "source");
    const finalPackageRoot = Path.join(fixtureRoot, "final");
    const sourceExecutable = appendTestSignature(
      Buffer.from("locked executable content\n"),
      "openai",
    );
    const finalExecutable = appendTestSignature(Buffer.from("locked executable content\n"), "moss");
    for (const packageRoot of [sourcePackageRoot, finalPackageRoot]) {
      FS.mkdirSync(Path.join(packageRoot, "bin"), { recursive: true });
    }
    FS.writeFileSync(Path.join(sourcePackageRoot, "bin/codex.exe"), sourceExecutable);
    FS.writeFileSync(Path.join(finalPackageRoot, "bin/codex.exe"), finalExecutable);
    const archive: PayloadArchive = {
      id: "win32-x64",
      npmPackage: "@openai/codex",
      npmVersion: "fixture",
      archive: "fixture.tgz",
      npmIntegrity: "sha512-fixture",
      size: sourceExecutable.length,
      sha256: "0".repeat(64),
      files: [
        {
          path: "bin/codex.exe",
          size: sourceExecutable.length,
          sha256: sha256(sourceExecutable),
        },
      ],
    };
    const strip = successfulSignatureStripRunner();
    const scripts: string[] = [];
    const runCommand: BundledCodexCommandRunner = (input) => {
      scripts.push(input.args.at(-1) ?? "");
      return strip(input);
    };

    validateSignedBundledCodexRuntimePayload({
      sourcePackageRoot,
      finalPackageRoot,
      archive,
      signedExecutableRelativePaths: ["bin/codex.exe"],
      platform: "win",
      hostPlatform: "win32",
      runCommand,
    });

    expect(scripts).toHaveLength(2);
    expect(scripts.every((script) => !script.includes("Get-Command signtool.exe"))).toBe(true);
    expect(
      scripts.every(
        (script) =>
          script.includes("Windows Kits\\10\\bin") &&
          script.includes("[IO.Path]::IsPathFullyQualified($signtool)"),
      ),
    ).toBe(true);
  });

  it("requires public Linux runtime probes only for the supported x64 publication lane", () => {
    expect(
      shouldRunBundledCodexLinuxPublicRuntimeProbes({
        platform: "linux",
        arch: "x64",
        releaseMode: "publish",
        signed: false,
      }),
    ).toBe(true);
    expect(
      shouldRunBundledCodexLinuxPublicRuntimeProbes({
        platform: "linux",
        arch: "arm64",
        releaseMode: "build-only",
        signed: false,
      }),
    ).toBe(false);
    expect(() =>
      shouldRunBundledCodexLinuxPublicRuntimeProbes({
        platform: "linux",
        arch: "arm64",
        releaseMode: "publish",
        signed: false,
      }),
    ).toThrow(/public Linux.*x64/i);
    expect(() =>
      shouldRunBundledCodexLinuxPublicRuntimeProbes({
        platform: "linux",
        arch: "x64",
        releaseMode: "publish",
        signed: true,
      }),
    ).toThrow(/Linux artifacts do not support --signed/i);
  });

  it("executes and records every public Linux x64 runtime obligation", () => {
    const { resourcesDir } = makeExecutableRuntimeFixture(
      "moss-codex-linux-probe-",
      LINUX_X64_TARGET,
      LINUX_RUNTIME_EXECUTABLES,
    );
    const receipt = validateBundledCodexLinuxX64PublicRuntime({
      resourcesDir,
      hostPlatform: "linux",
      hostArch: "x64",
      runCommand: successfulLinuxProbeRunner(),
    });

    expect(receipt.targetTriple).toBe(LINUX_X64_TARGET);
    expect(receipt.commands).toHaveLength(5);
    expect(receipt.maximumGlibcVersion).toBe("2.38");
    expect(receipt.neededLibraries).toEqual([...LINUX_PROBE_LIBRARIES]);
    expect(receipt.resolvedLibraries).toEqual([...LINUX_PROBE_LIBRARIES]);
  });

  it("fails public Linux probing on a foreign host or non-executable payload", () => {
    const { resourcesDir, runtimeRoot } = makeExecutableRuntimeFixture(
      "moss-codex-linux-host-probe-",
      LINUX_X64_TARGET,
      LINUX_RUNTIME_EXECUTABLES,
    );
    expect(() =>
      validateBundledCodexLinuxX64PublicRuntime({
        resourcesDir,
        hostPlatform: "darwin",
        hostArch: "arm64",
        runCommand: successfulLinuxProbeRunner(),
      }),
    ).toThrow(/requires a native linux\/x64 host/i);

    if (process.platform === "win32") return; // Native Windows access(X_OK) cannot measure POSIX execute bits.
    FS.chmodSync(Path.join(runtimeRoot, "codex-resources/voice/bin/codex-voice-host"), 0o644);
    expect(() =>
      validateBundledCodexLinuxX64PublicRuntime({
        resourcesDir,
        hostPlatform: "linux",
        hostArch: "x64",
        runCommand: successfulLinuxProbeRunner(),
      }),
    ).toThrow(/X_OK.*codex-voice-host/i);
  });

  it("fails public Linux probing on version, GLIBC, NEEDED, or loader-resolution drift", () => {
    const { resourcesDir } = makeExecutableRuntimeFixture(
      "moss-codex-linux-drift-probe-",
      LINUX_X64_TARGET,
      LINUX_RUNTIME_EXECUTABLES,
    );
    const probe = (runCommand: BundledCodexCommandRunner) =>
      validateBundledCodexLinuxX64PublicRuntime({
        resourcesDir,
        hostPlatform: "linux",
        hostArch: "x64",
        runCommand,
      });

    expect(() => probe(successfulLinuxProbeRunner({ codex: "codex-cli 0.145.0\n" }))).toThrow(
      /Codex version probe mismatch/i,
    );
    expect(() => probe(successfulLinuxProbeRunner({ versionInfo: "Name: GLIBC_2.39\n" }))).toThrow(
      /GLIBC.*2\.39.*2\.38/i,
    );
    expect(() =>
      probe(
        successfulLinuxProbeRunner({
          dynamic: [
            "(NEEDED) Shared library: [libm.so.6]",
            "(NEEDED) Shared library: [libc.so.6]",
          ].join("\n"),
        }),
      ),
    ).toThrow(/NEEDED.*libgio-2\.0\.so\.0/i);
    expect(() =>
      probe(
        successfulLinuxProbeRunner({
          ldd: [
            "libgio-2.0.so.0 => not found",
            "libm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x2)",
            "libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x3)",
          ].join("\n"),
        }),
      ),
    ).toThrow(/ldd.*libdl\.so\.2.*not resolved/i);
  });

  it("requires Authenticode Valid for every packaged Windows runtime executable", () => {
    const { stageDistDir, resourcesDir, runtimeRoot, mainExecutableName, installerFileName } =
      makeWindowsSignatureFixture("moss-codex-windows-signature-");
    const originalExecutablePaths = [
      Path.join(stageDistDir, installerFileName),
      Path.join(Path.dirname(resourcesDir), mainExecutableName),
      ...WINDOWS_RUNTIME_EXECUTABLES.map((relativePath) => Path.join(runtimeRoot, relativePath)),
    ];
    const runCommand: BundledCodexCommandRunner = ({ env }) => {
      const executablePaths = JSON.parse(
        env?.MOSS_CODEX_AUTHENTICODE_PATHS_JSON ?? "[]",
      ) as string[];
      expect(executablePaths).toHaveLength(originalExecutablePaths.length);
      expect(
        executablePaths.every(
          (executablePath) => !originalExecutablePaths.includes(executablePath),
        ),
      ).toBe(true);
      expect(executablePaths.every((executablePath) => FS.existsSync(executablePath))).toBe(true);
      return {
        status: 0,
        stdout: JSON.stringify({
          signatures: executablePaths.map((path) => windowsSignatureEvidence(path)),
        }),
        stderr: "",
      };
    };
    const receipt = verifyPackagedBundledCodexWindowsAuthenticode({
      stageDistDir,
      resourcesDir,
      targetTriples: [WINDOWS_X64_TARGET],
      expectedMainExecutableName: mainExecutableName,
      expectedInstallerFileName: installerFileName,
      expectedPublisherName: EXPECTED_WINDOWS_PUBLISHER,
      expectedCertificateSubjectDn: EXPECTED_WINDOWS_SUBJECT_DN,
      expectedCertificateThumbprint: EXPECTED_WINDOWS_THUMBPRINT,
      hostPlatform: "win32",
      runCommand,
    });

    expect(receipt.executableFiles).toHaveLength(WINDOWS_RUNTIME_EXECUTABLES.length + 2);
    expect(receipt.mainExecutableFile).toBe(`app/${mainExecutableName}`);
    expect(receipt.installerFile).toBe(`installer/${installerFileName}`);
    expect(receipt.executableFiles.every((file) => !Path.isAbsolute(file))).toBe(true);
    expect(receipt.commands).toHaveLength(1);
    expect(receipt.publisherName).toBe(EXPECTED_WINDOWS_PUBLISHER);
    expect(receipt.certificateIdentity).toEqual({
      subjectDn: EXPECTED_WINDOWS_SUBJECT_DN,
      thumbprint: EXPECTED_WINDOWS_THUMBPRINT,
      issuerDn: EXPECTED_WINDOWS_ISSUER_DN,
      serialNumber: EXPECTED_WINDOWS_SERIAL,
    });
    expect(receipt.signatures).toHaveLength(WINDOWS_RUNTIME_EXECUTABLES.length + 2);
    expect(
      receipt.signatures.every(
        (signature) => signature.size > 0 && /^[a-f0-9]{64}$/u.test(signature.sha256),
      ),
    ).toBe(true);
    expect(receipt.signatures.every((signature) => signature.timestamp.signtoolVerified)).toBe(
      true,
    );
  });

  it("rejects an Authenticode source path replaced while its private snapshot is verified", () => {
    const { stageDistDir, resourcesDir, mainExecutableName, installerFileName } =
      makeWindowsSignatureFixture("moss-codex-windows-signature-swap-");
    const installerPath = Path.join(stageDistDir, installerFileName);
    const heldInstallerPath = `${installerPath}.held`;
    const runCommand: BundledCodexCommandRunner = ({ env }) => {
      const executablePaths = JSON.parse(
        env?.MOSS_CODEX_AUTHENTICODE_PATHS_JSON ?? "[]",
      ) as string[];
      FS.renameSync(installerPath, heldInstallerPath);
      FS.writeFileSync(installerPath, "path replacement during Authenticode verification\n");
      return {
        status: 0,
        stdout: JSON.stringify({
          signatures: executablePaths.map((path) => windowsSignatureEvidence(path)),
        }),
        stderr: "",
      };
    };

    try {
      expect(() =>
        verifyPackagedBundledCodexWindowsAuthenticode({
          stageDistDir,
          resourcesDir,
          targetTriples: [WINDOWS_X64_TARGET],
          expectedMainExecutableName: mainExecutableName,
          expectedInstallerFileName: installerFileName,
          expectedPublisherName: EXPECTED_WINDOWS_PUBLISHER,
          expectedCertificateSubjectDn: EXPECTED_WINDOWS_SUBJECT_DN,
          expectedCertificateThumbprint: EXPECTED_WINDOWS_THUMBPRINT,
          hostPlatform: "win32",
          runCommand,
        }),
      ).toThrow(/changed while verification was in progress/i);
    } finally {
      FS.rmSync(installerPath, { force: true });
      if (FS.existsSync(heldInstallerPath)) FS.renameSync(heldInstallerPath, installerPath);
    }
  });

  it("fails closed on a foreign Authenticode host, missing EXE, or non-Valid status", () => {
    const { stageDistDir, resourcesDir, runtimeRoot, mainExecutableName, installerFileName } =
      makeWindowsSignatureFixture("moss-codex-windows-signature-failure-");
    const baseInput = {
      stageDistDir,
      resourcesDir,
      targetTriples: [WINDOWS_X64_TARGET],
      expectedMainExecutableName: mainExecutableName,
      expectedInstallerFileName: installerFileName,
      expectedPublisherName: EXPECTED_WINDOWS_PUBLISHER,
      expectedCertificateSubjectDn: EXPECTED_WINDOWS_SUBJECT_DN,
      expectedCertificateThumbprint: EXPECTED_WINDOWS_THUMBPRINT,
    } as const;
    const validRunner: BundledCodexCommandRunner = ({ env }) => {
      const executablePaths = JSON.parse(
        env?.MOSS_CODEX_AUTHENTICODE_PATHS_JSON ?? "[]",
      ) as string[];
      return {
        status: 0,
        stdout: JSON.stringify({
          signatures: executablePaths.map((path) => windowsSignatureEvidence(path)),
        }),
        stderr: "",
      };
    };
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "darwin",
        runCommand: validRunner,
      }),
    ).toThrow(/requires a Windows host/i);

    const installerPath = Path.join(stageDistDir, installerFileName);
    FS.rmSync(installerPath);
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "win32",
        runCommand: validRunner,
      }),
    ).toThrow(/installer.*exactly one/i);
    FS.writeFileSync(installerPath, "fixture installer restored\n");

    const mainExecutablePath = Path.join(Path.dirname(resourcesDir), mainExecutableName);
    FS.rmSync(mainExecutablePath);
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "win32",
        runCommand: validRunner,
      }),
    ).toThrow(/missing.*main executable/i);
    FS.writeFileSync(mainExecutablePath, "fixture main executable restored\n");

    FS.rmSync(Path.join(runtimeRoot, "codex-resources/codex-command-runner.exe"));
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "win32",
        runCommand: validRunner,
      }),
    ).toThrow(/runtime EXE inventory mismatch.*codex-command-runner\.exe/i);

    FS.writeFileSync(
      Path.join(runtimeRoot, "codex-resources/codex-command-runner.exe"),
      "fixture restored\n",
    );
    const invalidRunner: BundledCodexCommandRunner = ({ env }) => {
      const executablePaths = JSON.parse(
        env?.MOSS_CODEX_AUTHENTICODE_PATHS_JSON ?? "[]",
      ) as string[];
      return {
        status: 0,
        stdout: JSON.stringify({
          signatures: executablePaths.map((path, index) =>
            windowsSignatureEvidence(path, {
              status: index === 0 ? "HashMismatch" : "Valid",
            }),
          ),
        }),
        stderr: "",
      };
    };
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "win32",
        runCommand: invalidRunner,
      }),
    ).toThrow(/Authenticode.*HashMismatch/i);

    const sameSimpleNameWrongIdentityRunner: BundledCodexCommandRunner = ({ env }) => {
      const executablePaths = JSON.parse(
        env?.MOSS_CODEX_AUTHENTICODE_PATHS_JSON ?? "[]",
      ) as string[];
      return {
        status: 0,
        stdout: JSON.stringify({
          signatures: executablePaths.map((path) =>
            windowsSignatureEvidence(path, {
              subjectDn: "CN=Moss Software, O=Attacker Incorporated, C=US",
              thumbprint: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            }),
          ),
        }),
        stderr: "",
      };
    };
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "win32",
        runCommand: sameSimpleNameWrongIdentityRunner,
      }),
    ).toThrow(/Authenticode certificate identity mismatch/i);

    const missingTrustedTimestampRunner: BundledCodexCommandRunner = ({ env }) => {
      const executablePaths = JSON.parse(
        env?.MOSS_CODEX_AUTHENTICODE_PATHS_JSON ?? "[]",
      ) as string[];
      return {
        status: 0,
        stdout: JSON.stringify({
          signatures: executablePaths.map((path) =>
            windowsSignatureEvidence(path, {
              timestampThumbprint: "BAD",
              signtoolVerified: false,
            }),
          ),
        }),
        stderr: "",
      };
    };
    expect(() =>
      verifyPackagedBundledCodexWindowsAuthenticode({
        ...baseInput,
        hostPlatform: "win32",
        runCommand: missingTrustedTimestampRunner,
      }),
    ).toThrow(/trusted Authenticode timestamp evidence/i);
  });

  it.runIf(process.platform !== "win32")(
    "records ad-hoc app and nested Codex identities as build-only and never publishable",
    () => {
      const { appBundlePath, resourcesDir, runtimeRoot } = makeMacSignatureFixture(
        "moss-codex-mac-build-only-signature-",
      );
      const receipt = verifyPackagedBundledCodexMacBuildOnlySignatures({
        appBundlePath,
        resourcesDir,
        targetTriples: [MAC_ARM64_TARGET],
        hostPlatform: "darwin",
        runCommand: successfulMacBuildOnlySignatureRunner(),
      });

      expect(receipt.releaseEligibility).toBe("build-only-only");
      expect(receipt.signatureType).toBe("adhoc");
      expect(receipt.canonicalFilesystemHelper).toMatchObject({
        helperFile: "Contents/Helpers/moss-canonical-filesystem-helper",
        metadataFile: "Contents/Resources/moss-canonical-filesystem-helper.build.json",
        schemaVersion: 1,
        protocolVersion: 2,
        arch: "arm64",
        architectures: ["arm64"],
      });
      expect(receipt.canonicalFilesystemHelper.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(receipt.signatures).toHaveLength(1 + MAC_RUNTIME_EXECUTABLES.length);
      expect(receipt.signatures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            logicalFile: "app",
            identifier: EXPECTED_MAC_BUNDLE_ID,
            cdHash: "0123456789abcdef0123456789abcdef01234567",
            teamIdentifier: null,
            authorities: [],
            signatureType: "adhoc",
          }),
        ]),
      );
      expect(receipt.commands).toHaveLength(2 + MAC_RUNTIME_EXECUTABLES.length * 2);

      expect(() =>
        verifyPackagedBundledCodexMacBuildOnlySignatures({
          appBundlePath,
          resourcesDir,
          targetTriples: [MAC_ARM64_TARGET],
          hostPlatform: "darwin",
          runCommand: successfulMacBuildOnlySignatureRunner({
            developerIdPath: Path.join(runtimeRoot, "bin/codex"),
          }),
        }),
      ).toThrow(/build-only.*ad-hoc.*bin\/codex/i);
    },
  );

  it("rejects a packaged canonical filesystem helper changed after its metadata was written", () => {
    const fixture = makeMacSignatureFixture("moss-canonical-helper-signed-byte-mismatch-");
    FS.appendFileSync(fixture.helperPath, Buffer.from("signed-byte-delta", "utf8"));

    expect(() => validateMacHelperFixtureContent(fixture)).toThrow(
      /canonical filesystem helper.*(?:SHA-256|size).*metadata/i,
    );
  });

  it("fails closed on invalid canonical helper metadata and paths outside Contents/Resources", () => {
    const fixture = makeMacSignatureFixture("moss-canonical-helper-invalid-metadata-");
    const { appBundlePath, helperMetadataPath } = fixture;
    FS.writeFileSync(
      helperMetadataPath,
      `${JSON.stringify({
        schemaVersion: 1,
        helper: MAC_CANONICAL_FILESYSTEM_HELPER_NAME,
        protocolVersion: 2,
        arch: "arm64",
        architectures: ["x64"],
        fingerprint: "f".repeat(64),
        sha256: "a".repeat(64),
        size: 1,
      })}\n`,
    );

    expect(() => validateMacHelperFixtureContent(fixture)).toThrow(
      /metadata schema or identity fields are invalid/i,
    );
    expect(() =>
      verifyPackagedCanonicalFilesystemHelperBinding({
        appBundlePath,
        resourcesDir: Path.join(appBundlePath, "Resources"),
        targetTriples: [MAC_ARM64_TARGET],
      }),
    ).toThrow(/Contents\/Resources/i);
  });

  it("binds canonical helper metadata architecture to the packaged macOS targets", () => {
    const fixture = makeMacSignatureFixture("moss-canonical-helper-wrong-arch-");
    const metadata = JSON.parse(FS.readFileSync(fixture.helperMetadataPath, "utf8"));
    FS.writeFileSync(
      fixture.helperMetadataPath,
      `${JSON.stringify({ ...metadata, arch: "x64", architectures: ["x64"] })}\n`,
    );
    expect(() => validateMacHelperFixtureContent(fixture)).toThrow(
      /metadata schema or identity fields are invalid/i,
    );

    FS.writeFileSync(
      fixture.helperMetadataPath,
      `${JSON.stringify({
        ...metadata,
        arch: "universal",
        architectures: ["arm64", "x64"],
      })}\n`,
    );
    expect(
      validateMacHelperFixtureContent({
        ...fixture,
        targetTriples: [MAC_ARM64_TARGET, "x86_64-apple-darwin"],
      }),
    ).toMatchObject({ arch: "universal", architectures: ["arm64", "x64"] });
  });

  it("rejects symlinked bundle parents and metadata larger than 64 KiB", () => {
    const symlinkFixture = makeMacSignatureFixture("moss-canonical-helper-parent-symlink-");
    const helpersDir = Path.dirname(symlinkFixture.helperPath);
    const externalHelpersDir = Path.join(
      Path.dirname(symlinkFixture.appBundlePath),
      "external-helpers",
    );
    FS.renameSync(helpersDir, externalHelpersDir);
    createDirectoryAlias(externalHelpersDir, helpersDir);
    expect(() => verifyPackagedCanonicalFilesystemHelperBinding(symlinkFixture)).toThrow(
      /Helpers directory.*plain directory/i,
    );

    const metadataFixture = makeMacSignatureFixture("moss-canonical-helper-large-metadata-");
    FS.truncateSync(metadataFixture.helperMetadataPath, 64 * 1024 + 1);
    expect(() => validateMacHelperFixtureContent(metadataFixture)).toThrow(
      /canonical filesystem helper metadata.*65536-byte/i,
    );
  });

  it("requires the packaged canonical helper and metadata to be plain regular files", () => {
    const helperFixture = makeMacSignatureFixture("moss-canonical-helper-symlink-");
    const helperTarget = Path.join(Path.dirname(helperFixture.appBundlePath), "helper-target");
    FS.renameSync(helperFixture.helperPath, helperTarget);
    createRejectedFileAlias(helperTarget, helperFixture.helperPath);
    expect(() => verifyPackagedCanonicalFilesystemHelperBinding(helperFixture)).toThrow(
      /plain single-link file.*canonical filesystem helper/i,
    );

    const metadataFixture = makeMacSignatureFixture("moss-canonical-helper-metadata-symlink-");
    const metadataTarget = Path.join(
      Path.dirname(metadataFixture.appBundlePath),
      "metadata-target.json",
    );
    FS.renameSync(metadataFixture.helperMetadataPath, metadataTarget);
    createRejectedFileAlias(metadataTarget, metadataFixture.helperMetadataPath);
    expect(() => verifyPackagedCanonicalFilesystemHelperBinding(metadataFixture)).toThrow(
      process.platform === "win32"
        ? /canonical filesystem helper must be executable/i
        : /plain single-link file.*canonical filesystem helper metadata/i,
    );
  });

  it("requires an executable canonical helper no larger than the runtime's 8 MiB limit", () => {
    const nonExecutableFixture = makeMacSignatureFixture("moss-canonical-helper-non-executable-");
    FS.chmodSync(nonExecutableFixture.helperPath, 0o644);
    expect(() => verifyPackagedCanonicalFilesystemHelperBinding(nonExecutableFixture)).toThrow(
      /canonical filesystem helper.*executable/i,
    );

    const oversizedFixture = makeMacSignatureFixture("moss-canonical-helper-oversized-");
    FS.truncateSync(oversizedFixture.helperPath, 8 * 1024 * 1024 + 1);
    expect(() => verifyPackagedCanonicalFilesystemHelperBinding(oversizedFixture)).toThrow(
      /canonical filesystem helper.*8388608-byte/i,
    );
  });

  it.runIf(process.platform !== "win32")(
    "binds a signed macOS app and every nested Codex Mach-O to one Developer ID team",
    () => {
      const { appBundlePath, resourcesDir } = makeMacSignatureFixture("moss-codex-mac-signature-");
      const receipt = verifyPackagedBundledCodexMacCodeSignature({
        appBundlePath,
        resourcesDir,
        targetTriples: [MAC_ARM64_TARGET],
        expectedTeamIdentifier: EXPECTED_APPLE_TEAM_ID,
        expectedBundleIdentifier: EXPECTED_MAC_BUNDLE_ID,
        requireNotarization: false,
        hostPlatform: "darwin",
        runCommand: successfulMacSignatureRunner({ appBundlePath }),
      });

      expect(receipt.bundleIdentifier).toBe(EXPECTED_MAC_BUNDLE_ID);
      expect(receipt.teamIdentifier).toBe(EXPECTED_APPLE_TEAM_ID);
      expect(receipt.runtimeExecutablePaths).toHaveLength(MAC_RUNTIME_EXECUTABLES.length);
      expect(receipt.commands).toHaveLength(2 + MAC_RUNTIME_EXECUTABLES.length * 2);
      expect(receipt.notarizationValidated).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "requires stapler and Gatekeeper proof for publish-mode macOS signatures",
    () => {
      const { appBundlePath, resourcesDir } = makeMacSignatureFixture(
        "moss-codex-mac-notarization-",
      );
      const receipt = verifyPackagedBundledCodexMacCodeSignature({
        appBundlePath,
        resourcesDir,
        targetTriples: [MAC_ARM64_TARGET],
        expectedTeamIdentifier: EXPECTED_APPLE_TEAM_ID,
        expectedBundleIdentifier: EXPECTED_MAC_BUNDLE_ID,
        requireNotarization: true,
        hostPlatform: "darwin",
        runCommand: successfulMacSignatureRunner({ appBundlePath }),
      });

      expect(receipt.notarizationValidated).toBe(true);
      expect(receipt.commands.some((command) => command.includes('"stapler" "validate"'))).toBe(
        true,
      );
      expect(receipt.commands.some((command) => command.startsWith('"/usr/sbin/spctl"'))).toBe(
        true,
      );
    },
  );

  it("fails closed on foreign-host, ad-hoc, or wrong-team macOS signature evidence", () => {
    const { appBundlePath, resourcesDir, runtimeRoot } = makeMacSignatureFixture(
      "moss-codex-mac-signature-failure-",
    );
    const input = {
      appBundlePath,
      resourcesDir,
      targetTriples: [MAC_ARM64_TARGET],
      expectedTeamIdentifier: EXPECTED_APPLE_TEAM_ID,
      expectedBundleIdentifier: EXPECTED_MAC_BUNDLE_ID,
      requireNotarization: false,
    } as const;
    expect(() =>
      verifyPackagedBundledCodexMacCodeSignature({
        ...input,
        hostPlatform: "linux",
        runCommand: successfulMacSignatureRunner({ appBundlePath }),
      }),
    ).toThrow(/requires a macOS host/i);
    expect(() =>
      verifyPackagedBundledCodexMacCodeSignature({
        ...input,
        expectedTeamIdentifier: "",
        hostPlatform: "darwin",
        runCommand: successfulMacSignatureRunner({ appBundlePath }),
      }),
    ).toThrow(/APPLE_TEAM_ID/i);

    const nestedCodexPath = Path.join(runtimeRoot, "bin/codex");
    expect(() =>
      verifyPackagedBundledCodexMacCodeSignature({
        ...input,
        hostPlatform: "darwin",
        runCommand: successfulMacSignatureRunner({
          appBundlePath,
          teamForPath: { [nestedCodexPath]: "ZZ99YY88XX" },
        }),
      }),
    ).toThrow(/TeamIdentifier mismatch/i);
    expect(() =>
      verifyPackagedBundledCodexMacCodeSignature({
        ...input,
        hostPlatform: "darwin",
        runCommand: successfulMacSignatureRunner({
          appBundlePath,
          adhocPath: nestedCodexPath,
        }),
      }),
    ).toThrow(/ad-hoc signature/i);
  });
});
