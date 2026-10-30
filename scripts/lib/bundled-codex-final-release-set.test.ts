import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assembleBundledCodexFinalReleaseSet,
  BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE,
  verifyBundledCodexFinalReleaseSet,
} from "./bundled-codex-final-release-set.ts";
import {
  BUNDLED_CODEX_COMPLIANCE_COMPONENT_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_DIRECTORY_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ENTRY_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_FILE_COUNT,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_ALGORITHM,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_TOTAL_BYTES,
  BUNDLED_CODEX_COMPLIANCE_LICENSE_TEXT_COUNT,
  BUNDLED_CODEX_COMPLIANCE_PAYLOAD_FILE_COUNT,
  BUNDLED_CODEX_COMPLIANCE_SOURCE_MATERIAL_COUNT,
  BUNDLED_CODEX_TRUSTED_UNSQUASHFS_RECEIPT_ID,
  type BundledCodexFinalLinuxAppImageReceipt,
  copyBundledCodexReleaseArtifactsAndWriteReceipt,
} from "./bundled-codex-release-compliance.ts";
import {
  BUNDLED_CLAUDE_AGENT_SDK_VERSION,
  BUNDLED_CLAUDE_CODE_VERSION,
  resolveBundledClaudeTargets,
  type BundledClaudeReleaseVerificationReceipt,
} from "./bundled-claude-runtime.ts";

const tempRoots = new Set<string>();
const LINUX_TARGET = "x86_64-unknown-linux-musl";
const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const WINDOWS_SUBJECT = "CN=Moss Software, O=Moss Software, C=CN";
const WINDOWS_THUMBPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";

function tempRoot(): string {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-final-release-set-test-"));
  tempRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots) FS.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function sha256(bytes: Buffer): string {
  return Crypto.createHash("sha256").update(bytes).digest("hex");
}

function complianceEvidence(): Record<string, unknown> {
  return {
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
  };
}

function payloadEvidence(): Record<string, unknown> {
  return {
    fileCount: 4,
    totalBytes: 1_024,
    finalTreeSha256: "1".repeat(64),
    canonicalContentTreeSha256: "2".repeat(64),
  };
}

function bundledClaudeVerification(input: {
  readonly platform: "linux" | "mac" | "win";
  readonly arch: "arm64" | "x64";
}): BundledClaudeReleaseVerificationReceipt {
  const target = resolveBundledClaudeTargets(input)[0];
  if (!target) throw new Error(`Missing Claude target for ${input.platform}/${input.arch}.`);
  return {
    schemaVersion: 1,
    kind: "moss-bundled-claude-runtime-verification",
    agentSdkVersion: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
    codeVersion: BUNDLED_CLAUDE_CODE_VERSION,
    runner: {
      platform: target.os,
      arch: target.cpu,
    },
    targets: [
      {
        resourceFolder: target.resourceFolder,
        os: target.os,
        cpu: target.cpu,
        executable: target.executable,
        method: "direct-exec",
        argv: ["--version"],
        reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
      },
    ],
  };
}

function bundledClaudeFinalVerification(arch: "arm64" | "x64"): Record<string, unknown> {
  const target = resolveBundledClaudeTargets({ platform: "mac", arch })[0]!;
  return {
    schemaVersion: 1,
    kind: "moss-bundled-claude-final-artifact-verification",
    platform: "mac",
    arch,
    targets: [
      {
        resourceFolder: target.resourceFolder,
        cpu: target.cpu,
        executable: target.executable,
        relativePath: `claude-runtime/${target.resourceFolder}/${target.executable}`,
        fileSize: 1_024,
        fileSha256: "c".repeat(64),
        executableVerified: true,
        method: "direct-exec",
        argv: ["--version"],
        reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
      },
    ],
  };
}

function canonicalFilesystemHelperEvidence(arch: "arm64" | "x64"): Record<string, unknown> {
  return {
    helperFile: "Contents/Helpers/moss-canonical-filesystem-helper",
    metadataFile: "Contents/Resources/moss-canonical-filesystem-helper.build.json",
    schemaVersion: 1,
    protocolVersion: 2,
    arch,
    architectures: [arch],
    fingerprint: "f".repeat(64),
    sha256: arch === "arm64" ? "a".repeat(64) : "b".repeat(64),
    size: 4_096,
  };
}

function macVerification(input: {
  readonly fileName: string;
  readonly bytes: Buffer;
  readonly arch: "arm64" | "x64";
}): Record<string, unknown> {
  const compliance = complianceEvidence();
  const payload = payloadEvidence();
  return {
    complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
    bundledClaude: bundledClaudeVerification({ platform: "mac", arch: input.arch }),
    packagedCompliance: compliance,
    packagedPayload: { mode: "signed-canonical-binding", ...payload },
    finalInstallable: {
      platform: "mac",
      artifacts: [
        {
          kind: "dmg",
          fileName: input.fileName,
          size: input.bytes.length,
          sha256: sha256(input.bytes),
          installedClosure: {
            compliance,
            payload,
            signature: {
              bundleIdentifier: "com.moss.desktop",
              teamIdentifier: "AB12CD34EF",
              nestedRuntimeExecutableCount: 4,
              notarizationValidated: true,
              canonicalFilesystemHelper: canonicalFilesystemHelperEvidence(input.arch),
            },
            bundledClaude: bundledClaudeFinalVerification(input.arch),
          },
        },
      ],
    },
  };
}

function windowsVerification(input: {
  readonly fileName: string;
  readonly bytes: Buffer;
}): Record<string, unknown> {
  const compliance = complianceEvidence();
  const payload = payloadEvidence();
  const executableFiles = [
    "app/Moss.exe",
    `app/resources/codex-runtime/${WINDOWS_TARGET}/bin/codex.exe`,
    `installer/${input.fileName}`,
  ];
  return {
    complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
    bundledClaude: bundledClaudeVerification({ platform: "win", arch: "x64" }),
    packagedCompliance: compliance,
    packagedPayload: { mode: "signed-canonical-binding", ...payload },
    finalInstallable: {
      platform: "win",
      installerFileName: input.fileName,
      installerSize: input.bytes.length,
      installerSha256: sha256(input.bytes),
      uninstallValidated: true,
      installedClosure: {
        compliance,
        payload,
        authenticode: {
          executableFiles,
          certificateIdentity: {
            subjectDn: WINDOWS_SUBJECT,
            thumbprint: WINDOWS_THUMBPRINT,
            issuerDn: "CN=Microsoft ID Verified CS AOC CA 02",
            serialNumber: "0102030405060708",
          },
          signatures: executableFiles.map((file) => ({
            file,
            size: file.startsWith("installer/") ? input.bytes.length : 64,
            sha256: file.startsWith("installer/") ? sha256(input.bytes) : "3".repeat(64),
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

function linuxFinalReceipt(input: {
  readonly fileName: string;
  readonly bytes: Buffer;
}): BundledCodexFinalLinuxAppImageReceipt {
  return {
    platform: "linux",
    appImageFileName: input.fileName,
    appImageSize: input.bytes.length,
    appImageSha256: sha256(input.bytes),
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
      compliance: complianceEvidence() as never,
      payload: {
        mode: "exact-final-payload-hashes",
        targetTriples: [LINUX_TARGET],
        validated: true,
      },
      runtime: {
        targetTriple: LINUX_TARGET,
        maximumGlibcVersion: "2.38",
        neededLibraries: [
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
        ],
        resolvedLibraries: [
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
        ],
        commandCount: 5,
        validated: true,
      },
      startup: {
        executableFile: "moss",
        executableSize: 128,
        executableSha256: "3".repeat(64),
        arguments: ["--version"],
        runtimeVersion: "40.6.0",
        outputBytes: Buffer.byteLength("v40.6.0"),
        outputSha256: sha256(Buffer.from("v40.6.0")),
        validated: true,
      },
    },
  };
}

function updateManifest(url: string): string {
  return [
    "version: 1.2.3",
    "files:",
    `  - url: ${url}`,
    `    sha512: ${Buffer.from(url).toString("base64")}`,
    "    size: 42",
    "releaseDate: '2026-07-17T00:00:00.000Z'",
    "",
  ].join("\n");
}

function writeComponent(input: {
  readonly componentRoot: string;
  readonly directoryName: string;
  readonly platform: "linux" | "mac" | "win";
  readonly arch: "arm64" | "x64";
  readonly files: Readonly<Record<string, Buffer | string>>;
  readonly verification: Record<string, unknown>;
  readonly signed: boolean;
  readonly linuxFinalVerifier?: () => BundledCodexFinalLinuxAppImageReceipt;
}): void {
  const stage = Path.join(input.componentRoot, `${input.directoryName}-stage`);
  const output = Path.join(input.componentRoot, input.directoryName);
  FS.mkdirSync(stage, { recursive: true });
  for (const [fileName, value] of Object.entries(input.files)) {
    FS.writeFileSync(Path.join(stage, fileName), value);
  }
  copyBundledCodexReleaseArtifactsAndWriteReceipt({
    stageDistDir: stage,
    outputDir: output,
    platform: input.platform,
    arch: input.arch,
    releaseMode: "publish",
    signed: input.signed,
    expectedVersion: "0.163.0",
    verification: input.verification,
    ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
  });
}

describe("bundled Codex final release set", () => {
  it("reconstructs every platform receipt and binds merged/aliased manifests to final bytes", () => {
    const root = tempRoot();
    const componentRoot = Path.join(root, "components");
    const outputDir = Path.join(root, "release-assets");
    FS.mkdirSync(componentRoot);
    const armDmg = Buffer.from("arm64 dmg\n");
    const x64Dmg = Buffer.from("x64 dmg\n");
    const installer = Buffer.from("windows installer\n");
    const appImage = Buffer.alloc(8_192);
    const appImageFileName = "Moss-1.2.3-x64.AppImage";
    const linuxReceipt = linuxFinalReceipt({
      fileName: appImageFileName,
      bytes: appImage,
    });
    const linuxFinalVerifier = () => linuxReceipt;

    writeComponent({
      componentRoot,
      directoryName: "desktop-mac-arm64",
      platform: "mac",
      arch: "arm64",
      files: {
        "Moss-1.2.3-arm64.dmg": armDmg,
        "latest-mac.yml": updateManifest("Moss-1.2.3-arm64.zip"),
      },
      verification: macVerification({
        fileName: "Moss-1.2.3-arm64.dmg",
        bytes: armDmg,
        arch: "arm64",
      }),
      signed: true,
    });
    writeComponent({
      componentRoot,
      directoryName: "desktop-mac-x64",
      platform: "mac",
      arch: "x64",
      files: {
        "Moss-1.2.3-x64.dmg": x64Dmg,
        "latest-mac-x64.yml": updateManifest("Moss-1.2.3-x64.zip"),
      },
      verification: macVerification({
        fileName: "Moss-1.2.3-x64.dmg",
        bytes: x64Dmg,
        arch: "x64",
      }),
      signed: true,
    });
    writeComponent({
      componentRoot,
      directoryName: "desktop-linux-x64",
      platform: "linux",
      arch: "x64",
      files: {
        [appImageFileName]: appImage,
        "latest-linux.yml": "version: 1.2.3\nlinux: exact\n",
      },
      verification: {
        complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
        bundledClaude: bundledClaudeVerification({ platform: "linux", arch: "x64" }),
        packagedCompliance: complianceEvidence(),
        packagedPayload: {
          mode: "exact-final-payload-hashes",
          validated: true,
        },
        linuxRuntime: {
          targetTriple: LINUX_TARGET,
          maximumGlibcVersion: "2.38",
          neededLibraries: [
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
          ],
          resolvedLibraries: [
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
          ],
        },
        linuxLauncher: linuxReceipt.extractedClosure.startup,
        finalInstallable: linuxReceipt,
      },
      signed: false,
      linuxFinalVerifier,
    });
    writeComponent({
      componentRoot,
      directoryName: "desktop-win-x64",
      platform: "win",
      arch: "x64",
      files: {
        "Moss-1.2.3-x64.exe": installer,
        "latest.yml": "version: 1.2.3\nwindows: exact\n",
      },
      verification: windowsVerification({
        fileName: "Moss-1.2.3-x64.exe",
        bytes: installer,
      }),
      signed: true,
    });

    if (process.platform === "win32") {
      expect(() =>
        assembleBundledCodexFinalReleaseSet({
          componentRoot,
          outputDir,
          updateChannel: "moss",
          linuxFinalVerifier,
        }),
      ).toThrow(expect.objectContaining({ code: "EPERM" }));
      expect(
        FS.existsSync(Path.join(outputDir, BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE)),
      ).toBe(false);
      expect(() =>
        verifyBundledCodexFinalReleaseSet({
          outputDir,
          requirePublishEligible: true,
          linuxFinalVerifier,
        }),
      ).toThrow();
      return;
    }
    const receipt = assembleBundledCodexFinalReleaseSet({
      componentRoot,
      outputDir,
      updateChannel: "moss",
      linuxFinalVerifier,
    });
    expect(receipt.publishEligible).toBe(true);
    expect(receipt.components).toHaveLength(4);
    expect(FS.existsSync(Path.join(outputDir, BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE))).toBe(
      true,
    );
    expect(FS.readFileSync(Path.join(outputDir, "latest-mac.yml"), "utf8")).toContain(
      "Moss-1.2.3-arm64.zip",
    );
    expect(FS.readFileSync(Path.join(outputDir, "latest-mac.yml"), "utf8")).toContain(
      "Moss-1.2.3-x64.zip",
    );
    expect(FS.readFileSync(Path.join(outputDir, "moss-mac.yml"))).toEqual(
      FS.readFileSync(Path.join(outputDir, "latest-mac.yml")),
    );
    expect(FS.readFileSync(Path.join(outputDir, "moss.yml"))).toEqual(
      FS.readFileSync(Path.join(outputDir, "latest.yml")),
    );
    expect(
      verifyBundledCodexFinalReleaseSet({
        outputDir,
        requirePublishEligible: true,
        linuxFinalVerifier,
      }),
    ).toEqual(receipt);

    const replacementPath = Path.join(root, "replacement-installer.exe");
    FS.writeFileSync(replacementPath, "replacement installer\n");
    FS.renameSync(replacementPath, Path.join(outputDir, "Moss-1.2.3-x64.exe"));
    expect(() =>
      verifyBundledCodexFinalReleaseSet({
        outputDir,
        requirePublishEligible: true,
        linuxFinalVerifier,
      }),
    ).toThrow(/SHA-256\/size mismatch/i);
  });
});
