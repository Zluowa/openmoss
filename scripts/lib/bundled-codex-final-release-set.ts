// FILE: bundled-codex-final-release-set.ts
// Purpose: Atomically derives and attests the exact multi-platform GitHub release upload set.
// Layer: Release/build helper

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
  BUNDLED_CODEX_COMPLIANCE_VERSION,
  type BundledCodexLinuxFinalInstallableVerifier,
  type BundledCodexReleaseArtifactReceipt,
  verifyBundledCodexReleaseReceipt,
} from "./bundled-codex-release-compliance.ts";
import { channelManifestNames } from "./release-update-policy.ts";
import {
  mergeMacUpdateManifests,
  parseMacUpdateManifest,
  serializeMacUpdateManifest,
} from "./mac-update-manifest.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
export const BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE =
  "moss-bundled-codex-final-release-set-receipt.json";

const COMPONENTS = [
  { platform: "mac", arch: "arm64", directoryName: "desktop-mac-arm64" },
  { platform: "mac", arch: "x64", directoryName: "desktop-mac-x64" },
  { platform: "linux", arch: "x64", directoryName: "desktop-linux-x64" },
  { platform: "win", arch: "x64", directoryName: "desktop-win-x64" },
] as const;

type ComponentSpec = (typeof COMPONENTS)[number];

interface ImmutableDigest {
  readonly filePath: string;
  readonly descriptor: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
}

interface EmbeddedArtifact {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

interface RetainedArtifact {
  readonly sourceFileName: string;
  readonly finalFileName: string;
  readonly size: number;
  readonly sha256: string;
}

interface ComponentAttestation {
  readonly platform: ComponentSpec["platform"];
  readonly arch: ComponentSpec["arch"];
  readonly directoryName: ComponentSpec["directoryName"];
  readonly receiptFileName: string;
  readonly receiptSize: number;
  readonly receiptSha256: string;
  readonly receiptBase64: string;
  readonly retainedArtifacts: readonly RetainedArtifact[];
  readonly embeddedArtifacts: readonly EmbeddedArtifact[];
}

export interface BundledCodexFinalReleaseSetReceipt {
  readonly schemaVersion: 1;
  readonly kind: "moss-bundled-codex-final-release-set-receipt";
  readonly bundledCodexVersion: string;
  readonly complianceBundleRootSha256: string;
  readonly updateChannel: string;
  readonly publishEligible: true;
  readonly components: readonly ComponentAttestation[];
  readonly manifestDerivation: {
    readonly algorithm: "moss-final-update-manifests-v1";
    readonly macArm64SourceSha256: string;
    readonly macX64SourceSha256: string;
    readonly mergedMacSha256: string;
    readonly channelAliases: readonly {
      readonly sourceFileName: string;
      readonly finalFileName: string;
      readonly sha256: string;
    }[];
  };
  readonly artifacts: readonly BundledCodexReleaseArtifactReceipt[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes: Buffer): string {
  return Crypto.createHash("sha256").update(bytes).digest("hex");
}

function safeFileName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Path.basename(value) !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error(`Bundled Codex final release set has invalid ${label}.`);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Bundled Codex final release set has invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function numberValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Bundled Codex final release set has invalid ${label}.`);
  }
  return Number(value);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Bundled Codex final release set has invalid ${label}.`);
  }
  return value;
}

function requirePlainDirectory(directory: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(directory);
  } catch {
    throw new Error(`Bundled Codex final release set is missing ${label}.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Bundled Codex final release set ${label} must be a plain directory.`);
  }
}

function hashDescriptor(descriptor: number, size: number): string {
  const hash = Crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const read = FS.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read === 0) {
      throw new Error("Bundled Codex final release set source ended while hashing.");
    }
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

function openImmutableDigest(filePath: string, label: string): ImmutableDigest {
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = FS.openSync(filePath, FS.constants.O_RDONLY | noFollow);
    const descriptorStat = FS.fstatSync(descriptor, { bigint: true });
    const pathStat = FS.lstatSync(filePath, { bigint: true });
    if (
      !descriptorStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      descriptorStat.size < 0n ||
      descriptorStat.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(`Bundled Codex final release set ${label} must be a plain immutable file.`);
    }
    const size = Number(descriptorStat.size);
    return {
      filePath,
      descriptor,
      dev: descriptorStat.dev,
      ino: descriptorStat.ino,
      mode: descriptorStat.mode,
      size,
      mtimeNs: descriptorStat.mtimeNs,
      ctimeNs: descriptorStat.ctimeNs,
      sha256: hashDescriptor(descriptor, size),
    };
  } catch (cause) {
    if (descriptor !== undefined) FS.closeSync(descriptor);
    throw new Error(`Bundled Codex final release set could not snapshot ${label}.`, { cause });
  }
}

function assertImmutableDigestCurrent(snapshot: ImmutableDigest): void {
  const descriptorStat = FS.fstatSync(snapshot.descriptor, { bigint: true });
  const pathStat = FS.lstatSync(snapshot.filePath, { bigint: true });
  if (
    !descriptorStat.isFile() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    descriptorStat.dev !== snapshot.dev ||
    descriptorStat.ino !== snapshot.ino ||
    pathStat.dev !== snapshot.dev ||
    pathStat.ino !== snapshot.ino ||
    descriptorStat.mode !== snapshot.mode ||
    descriptorStat.size !== BigInt(snapshot.size) ||
    descriptorStat.mtimeNs !== snapshot.mtimeNs ||
    descriptorStat.ctimeNs !== snapshot.ctimeNs ||
    hashDescriptor(snapshot.descriptor, snapshot.size) !== snapshot.sha256
  ) {
    throw new Error(
      `Bundled Codex final release set detected ${Path.basename(snapshot.filePath)} changed during verification.`,
    );
  }
}

function readDigestBytes(snapshot: ImmutableDigest): Buffer {
  const bytes = Buffer.alloc(snapshot.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = FS.readSync(snapshot.descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) {
      throw new Error("Bundled Codex final release set source ended while reading.");
    }
    offset += read;
  }
  assertImmutableDigestCurrent(snapshot);
  return bytes;
}

function fsyncDirectory(directory: string): void {
  const descriptor = FS.openSync(directory, FS.constants.O_RDONLY);
  try {
    FS.fsyncSync(descriptor);
  } finally {
    FS.closeSync(descriptor);
  }
}

function writeNoReplace(input: {
  readonly outputDirectory: string;
  readonly targetPath: string;
  readonly bytes: Buffer;
  readonly mode: number;
}): void {
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  const temporaryPath = Path.join(
    input.outputDirectory,
    `.moss-final-release-${process.pid}-${Crypto.randomUUID()}.tmp`,
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
    FS.linkSync(temporaryPath, input.targetPath);
    FS.unlinkSync(temporaryPath);
    fsyncDirectory(input.outputDirectory);
  } finally {
    if (descriptor !== undefined) FS.closeSync(descriptor);
    FS.rmSync(temporaryPath, { force: true });
  }
}

function copyDigestNoReplace(input: {
  readonly source: ImmutableDigest;
  readonly outputDirectory: string;
  readonly targetPath: string;
}): void {
  const noFollow = FS.constants.O_NOFOLLOW ?? 0;
  const temporaryPath = Path.join(
    input.outputDirectory,
    `.moss-final-copy-${process.pid}-${Crypto.randomUUID()}.tmp`,
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
      if (read === 0)
        throw new Error("Bundled Codex final release set source ended while copying.");
      let written = 0;
      while (written < read) {
        written += FS.writeSync(descriptor, buffer, written, read - written);
      }
      offset += read;
    }
    FS.fsyncSync(descriptor);
    FS.fchmodSync(descriptor, Number(input.source.mode & 0o777n));
    FS.closeSync(descriptor);
    descriptor = undefined;
    FS.linkSync(temporaryPath, input.targetPath);
    FS.unlinkSync(temporaryPath);
    fsyncDirectory(input.outputDirectory);
    assertImmutableDigestCurrent(input.source);
    const target = openImmutableDigest(input.targetPath, "copied final artifact");
    try {
      if (target.size !== input.source.size || target.sha256 !== input.source.sha256) {
        throw new Error("Bundled Codex final release set copied artifact digest mismatch.");
      }
    } finally {
      FS.closeSync(target.descriptor);
    }
  } finally {
    if (descriptor !== undefined) FS.closeSync(descriptor);
    FS.rmSync(temporaryPath, { force: true });
  }
}

function strictBase64(value: unknown, label: string): Buffer {
  const encoded = stringValue(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error(`Bundled Codex final release set has invalid ${label}.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`Bundled Codex final release set has non-canonical ${label}.`);
  }
  return bytes;
}

function receiptFileName(platform: string, arch: string): string {
  return `moss-bundled-codex-release-receipt-${platform}-${arch}.json`;
}

function transformedManifestName(spec: ComponentSpec): string | null {
  if (spec.platform !== "mac") return null;
  return spec.arch === "arm64" ? "latest-mac.yml" : "latest-mac-x64.yml";
}

function artifactReceipt(fileName: string, bytes: Buffer): BundledCodexReleaseArtifactReceipt {
  return { fileName, size: bytes.length, sha256: sha256(bytes) };
}

function componentDirectory(root: string, spec: ComponentSpec): string {
  return Path.join(root, spec.directoryName);
}

export function assembleBundledCodexFinalReleaseSet(input: {
  readonly componentRoot: string;
  readonly outputDir: string;
  readonly updateChannel: string;
  readonly linuxFinalVerifier?: BundledCodexLinuxFinalInstallableVerifier;
}): BundledCodexFinalReleaseSetReceipt {
  requirePlainDirectory(input.componentRoot, "component download root");
  channelManifestNames(input.updateChannel);
  if (FS.existsSync(input.outputDir)) {
    requirePlainDirectory(input.outputDir, "final upload directory");
    if (FS.readdirSync(input.outputDir).length !== 0) {
      throw new Error("Bundled Codex final upload directory must be empty.");
    }
  } else {
    FS.mkdirSync(input.outputDir, { recursive: true, mode: 0o755 });
  }

  const openDigests: ImmutableDigest[] = [];
  const createdTargets: string[] = [];
  const componentAttestations: ComponentAttestation[] = [];
  const finalArtifacts = new Map<string, BundledCodexReleaseArtifactReceipt>();
  const manifestSources = new Map<string, Buffer>();
  try {
    for (const spec of COMPONENTS) {
      const directory = componentDirectory(input.componentRoot, spec);
      const componentReceipt = verifyBundledCodexReleaseReceipt({
        outputDir: directory,
        expectedPlatform: spec.platform,
        expectedArch: spec.arch,
        requirePublishEligible: true,
        ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
      });
      const componentReceiptFileName = receiptFileName(spec.platform, spec.arch);
      const receiptDigest = openImmutableDigest(
        Path.join(directory, componentReceiptFileName),
        `${spec.directoryName} receipt`,
      );
      openDigests.push(receiptDigest);
      const receiptBytes = readDigestBytes(receiptDigest);
      if (!isDeepStrictEqual(JSON.parse(receiptBytes.toString("utf8")), componentReceipt)) {
        throw new Error(`Bundled Codex ${spec.directoryName} receipt changed after verification.`);
      }
      const retainedArtifacts: RetainedArtifact[] = [];
      const embeddedArtifacts: EmbeddedArtifact[] = [];
      const transformedName = transformedManifestName(spec);
      for (const artifact of componentReceipt.artifacts) {
        const source = openImmutableDigest(
          Path.join(directory, artifact.fileName),
          `${spec.directoryName}/${artifact.fileName}`,
        );
        openDigests.push(source);
        if (source.size !== artifact.size || source.sha256 !== artifact.sha256) {
          throw new Error(
            `Bundled Codex ${spec.directoryName}/${artifact.fileName} changed after verification.`,
          );
        }
        if (artifact.fileName === transformedName) {
          const bytes = readDigestBytes(source);
          manifestSources.set(`${spec.platform}-${spec.arch}`, bytes);
          embeddedArtifacts.push({
            ...artifact,
            contentBase64: bytes.toString("base64"),
          });
          continue;
        }
        if (finalArtifacts.has(artifact.fileName)) {
          throw new Error(
            `Bundled Codex final release set has duplicate artifact ${artifact.fileName}.`,
          );
        }
        const targetPath = Path.join(input.outputDir, artifact.fileName);
        copyDigestNoReplace({
          source,
          outputDirectory: input.outputDir,
          targetPath,
        });
        createdTargets.push(targetPath);
        finalArtifacts.set(artifact.fileName, artifact);
        retainedArtifacts.push({
          sourceFileName: artifact.fileName,
          finalFileName: artifact.fileName,
          size: artifact.size,
          sha256: artifact.sha256,
        });
        if (artifact.fileName === "latest.yml" || artifact.fileName === "latest-linux.yml") {
          manifestSources.set(artifact.fileName, readDigestBytes(source));
        }
      }
      if (transformedName && embeddedArtifacts.length !== 1) {
        throw new Error(
          `Bundled Codex ${spec.directoryName} must contain exactly ${transformedName}.`,
        );
      }
      componentAttestations.push({
        ...spec,
        receiptFileName: componentReceiptFileName,
        receiptSize: receiptBytes.length,
        receiptSha256: sha256(receiptBytes),
        receiptBase64: receiptBytes.toString("base64"),
        retainedArtifacts: retainedArtifacts.toSorted((left, right) =>
          compareUtf8(left.sourceFileName, right.sourceFileName),
        ),
        embeddedArtifacts,
      });
    }

    const macArm64Bytes = manifestSources.get("mac-arm64");
    const macX64Bytes = manifestSources.get("mac-x64");
    const windowsManifestBytes = manifestSources.get("latest.yml");
    const linuxManifestBytes = manifestSources.get("latest-linux.yml");
    if (!macArm64Bytes || !macX64Bytes || !windowsManifestBytes || !linuxManifestBytes) {
      throw new Error("Bundled Codex final release set is missing required update manifests.");
    }
    const mergedMacBytes = Buffer.from(
      serializeMacUpdateManifest(
        mergeMacUpdateManifests(
          parseMacUpdateManifest(macArm64Bytes.toString("utf8"), "mac-arm64/latest-mac.yml"),
          parseMacUpdateManifest(macX64Bytes.toString("utf8"), "mac-x64/latest-mac-x64.yml"),
        ),
      ),
      "utf8",
    );
    const derivedManifests = new Map<string, Buffer>([["latest-mac.yml", mergedMacBytes]]);
    const aliases = channelManifestNames(input.updateChannel);
    const aliasSources = [
      { sourceFileName: "latest-mac.yml", bytes: mergedMacBytes },
      { sourceFileName: "latest.yml", bytes: windowsManifestBytes },
      { sourceFileName: "latest-linux.yml", bytes: linuxManifestBytes },
    ] as const;
    for (const [index, finalFileName] of aliases.entries()) {
      derivedManifests.set(finalFileName, aliasSources[index]!.bytes);
    }
    for (const [fileName, bytes] of derivedManifests) {
      if (finalArtifacts.has(fileName)) {
        throw new Error(`Bundled Codex final release manifest collision for ${fileName}.`);
      }
      const targetPath = Path.join(input.outputDir, fileName);
      writeNoReplace({
        outputDirectory: input.outputDir,
        targetPath,
        bytes,
        mode: 0o644,
      });
      createdTargets.push(targetPath);
      finalArtifacts.set(fileName, artifactReceipt(fileName, bytes));
    }

    for (const digest of openDigests) assertImmutableDigestCurrent(digest);
    const artifacts = [...finalArtifacts.values()].toSorted((left, right) =>
      compareUtf8(left.fileName, right.fileName),
    );
    const receipt: BundledCodexFinalReleaseSetReceipt = {
      schemaVersion: 1,
      kind: "moss-bundled-codex-final-release-set-receipt",
      bundledCodexVersion: BUNDLED_CODEX_COMPLIANCE_VERSION,
      complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
      updateChannel: input.updateChannel,
      publishEligible: true,
      components: componentAttestations,
      manifestDerivation: {
        algorithm: "moss-final-update-manifests-v1",
        macArm64SourceSha256: sha256(macArm64Bytes),
        macX64SourceSha256: sha256(macX64Bytes),
        mergedMacSha256: sha256(mergedMacBytes),
        channelAliases: aliases.map((finalFileName, index) => ({
          sourceFileName: aliasSources[index]!.sourceFileName,
          finalFileName,
          sha256: sha256(aliasSources[index]!.bytes),
        })),
      },
      artifacts,
    };
    const finalReceiptPath = Path.join(
      input.outputDir,
      BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE,
    );
    writeNoReplace({
      outputDirectory: input.outputDir,
      targetPath: finalReceiptPath,
      bytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
      mode: 0o644,
    });
    createdTargets.push(finalReceiptPath);
    const verified = verifyBundledCodexFinalReleaseSet({
      outputDir: input.outputDir,
      requirePublishEligible: true,
      ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
    });
    if (!isDeepStrictEqual(verified, receipt)) {
      throw new Error("Bundled Codex final release set receipt changed after persistence.");
    }
    return receipt;
  } catch (cause) {
    for (const target of createdTargets.toReversed()) FS.rmSync(target, { force: true });
    throw cause;
  } finally {
    for (const digest of openDigests) FS.closeSync(digest.descriptor);
  }
}

export function verifyBundledCodexFinalReleaseSet(input: {
  readonly outputDir: string;
  readonly requirePublishEligible: boolean;
  readonly linuxFinalVerifier?: BundledCodexLinuxFinalInstallableVerifier;
}): BundledCodexFinalReleaseSetReceipt {
  requirePlainDirectory(input.outputDir, "final upload directory");
  const receiptDigest = openImmutableDigest(
    Path.join(input.outputDir, BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE),
    "final release set receipt",
  );
  const artifactDigests = new Map<string, ImmutableDigest>();
  const reconstructionRoots: string[] = [];
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readDigestBytes(receiptDigest).toString("utf8"));
    } catch (cause) {
      throw new Error("Bundled Codex final release set receipt is not valid JSON.", { cause });
    }
    const value = objectValue(parsed, "receipt");
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "moss-bundled-codex-final-release-set-receipt" ||
      value.bundledCodexVersion !== BUNDLED_CODEX_COMPLIANCE_VERSION ||
      value.complianceBundleRootSha256 !== BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256 ||
      typeof value.updateChannel !== "string" ||
      value.publishEligible !== true ||
      !Array.isArray(value.components) ||
      !Array.isArray(value.artifacts)
    ) {
      throw new Error("Bundled Codex final release set receipt metadata is invalid.");
    }
    channelManifestNames(value.updateChannel);
    if (input.requirePublishEligible && value.publishEligible !== true) {
      throw new Error("Bundled Codex final release set is not publish eligible.");
    }

    const artifacts: BundledCodexReleaseArtifactReceipt[] = [];
    for (const [index, rawArtifact] of value.artifacts.entries()) {
      const artifact = objectValue(rawArtifact, `artifacts[${index}]`);
      const fileName = safeFileName(artifact.fileName, `artifacts[${index}].fileName`);
      const size = numberValue(artifact.size, `artifacts[${index}].size`);
      const artifactSha256 = stringValue(artifact.sha256, `artifacts[${index}].sha256`);
      if (!SHA256.test(artifactSha256) || artifactDigests.has(fileName)) {
        throw new Error(`Bundled Codex final release set has invalid artifact ${fileName}.`);
      }
      const digest = openImmutableDigest(
        Path.join(input.outputDir, fileName),
        `final artifact ${fileName}`,
      );
      artifactDigests.set(fileName, digest);
      if (digest.size !== size || digest.sha256 !== artifactSha256) {
        throw new Error(
          `Bundled Codex final release set artifact SHA-256/size mismatch for ${fileName}.`,
        );
      }
      artifacts.push({ fileName, size, sha256: artifactSha256 });
    }
    const sortedNames = artifacts.map((artifact) => artifact.fileName).toSorted(compareUtf8);
    if (
      !isDeepStrictEqual(
        artifacts.map((artifact) => artifact.fileName),
        sortedNames,
      )
    ) {
      throw new Error("Bundled Codex final release set artifact inventory is not sorted.");
    }
    const actualNames = FS.readdirSync(input.outputDir, { withFileTypes: true })
      .map((entry) => {
        if (!entry.isFile()) {
          throw new Error(`Bundled Codex final release set contains non-file entry ${entry.name}.`);
        }
        return entry.name;
      })
      .toSorted(compareUtf8);
    const expectedNames = [BUNDLED_CODEX_FINAL_RELEASE_SET_RECEIPT_FILE, ...sortedNames].toSorted(
      compareUtf8,
    );
    if (!isDeepStrictEqual(actualNames, expectedNames)) {
      throw new Error(
        "Bundled Codex final release set contains unreceipted or missing upload files.",
      );
    }

    if (value.components.length !== COMPONENTS.length) {
      throw new Error("Bundled Codex final release set component inventory is incomplete.");
    }
    const retainedFinalNames = new Set<string>();
    const transformedBytes = new Map<string, Buffer>();
    const normalizedComponents: ComponentAttestation[] = [];
    for (const [index, spec] of COMPONENTS.entries()) {
      const rawComponent = objectValue(value.components[index], `components[${index}]`);
      if (
        rawComponent.platform !== spec.platform ||
        rawComponent.arch !== spec.arch ||
        rawComponent.directoryName !== spec.directoryName ||
        !Array.isArray(rawComponent.retainedArtifacts) ||
        !Array.isArray(rawComponent.embeddedArtifacts)
      ) {
        throw new Error(
          `Bundled Codex final release set component ${spec.directoryName} is invalid.`,
        );
      }
      const expectedReceiptFileName = receiptFileName(spec.platform, spec.arch);
      if (rawComponent.receiptFileName !== expectedReceiptFileName) {
        throw new Error(
          `Bundled Codex final release set component ${spec.directoryName} receipt name is invalid.`,
        );
      }
      const receiptBytes = strictBase64(
        rawComponent.receiptBase64,
        `components[${index}].receiptBase64`,
      );
      const embeddedReceiptSize = numberValue(
        rawComponent.receiptSize,
        `components[${index}].receiptSize`,
      );
      const embeddedReceiptSha256 = stringValue(
        rawComponent.receiptSha256,
        `components[${index}].receiptSha256`,
      );
      if (
        receiptBytes.length !== embeddedReceiptSize ||
        sha256(receiptBytes) !== embeddedReceiptSha256
      ) {
        throw new Error(
          `Bundled Codex final release set component ${spec.directoryName} receipt digest mismatch.`,
        );
      }
      const embeddedReceipt = objectValue(
        JSON.parse(receiptBytes.toString("utf8")),
        `${spec.directoryName} embedded receipt`,
      );
      if (
        embeddedReceipt.platform !== spec.platform ||
        embeddedReceipt.arch !== spec.arch ||
        !Array.isArray(embeddedReceipt.artifacts)
      ) {
        throw new Error(
          `Bundled Codex final release set component ${spec.directoryName} embedded receipt is invalid.`,
        );
      }
      const retainedArtifacts: RetainedArtifact[] = rawComponent.retainedArtifacts.map(
        (rawRetained, retainedIndex) => {
          const retained = objectValue(
            rawRetained,
            `components[${index}].retainedArtifacts[${retainedIndex}]`,
          );
          const sourceFileName = safeFileName(
            retained.sourceFileName,
            `components[${index}].retainedArtifacts[${retainedIndex}].sourceFileName`,
          );
          const finalFileName = safeFileName(
            retained.finalFileName,
            `components[${index}].retainedArtifacts[${retainedIndex}].finalFileName`,
          );
          const size = numberValue(
            retained.size,
            `components[${index}].retainedArtifacts[${retainedIndex}].size`,
          );
          const retainedSha256 = stringValue(
            retained.sha256,
            `components[${index}].retainedArtifacts[${retainedIndex}].sha256`,
          );
          if (
            sourceFileName !== finalFileName ||
            !SHA256.test(retainedSha256) ||
            retainedFinalNames.has(finalFileName)
          ) {
            throw new Error(
              `Bundled Codex final release set retained artifact ${finalFileName} is invalid.`,
            );
          }
          const finalDigest = artifactDigests.get(finalFileName);
          if (!finalDigest || finalDigest.size !== size || finalDigest.sha256 !== retainedSha256) {
            throw new Error(
              `Bundled Codex final release retained artifact ${finalFileName} digest mismatch.`,
            );
          }
          retainedFinalNames.add(finalFileName);
          return {
            sourceFileName,
            finalFileName,
            size,
            sha256: retainedSha256,
          };
        },
      );
      const embeddedArtifacts: EmbeddedArtifact[] = rawComponent.embeddedArtifacts.map(
        (rawEmbedded, embeddedIndex) => {
          const embedded = objectValue(
            rawEmbedded,
            `components[${index}].embeddedArtifacts[${embeddedIndex}]`,
          );
          const fileName = safeFileName(
            embedded.fileName,
            `components[${index}].embeddedArtifacts[${embeddedIndex}].fileName`,
          );
          const size = numberValue(
            embedded.size,
            `components[${index}].embeddedArtifacts[${embeddedIndex}].size`,
          );
          const embeddedSha256 = stringValue(
            embedded.sha256,
            `components[${index}].embeddedArtifacts[${embeddedIndex}].sha256`,
          );
          const bytes = strictBase64(
            embedded.contentBase64,
            `components[${index}].embeddedArtifacts[${embeddedIndex}].contentBase64`,
          );
          if (
            bytes.length !== size ||
            sha256(bytes) !== embeddedSha256 ||
            transformedBytes.has(`${spec.platform}-${spec.arch}/${fileName}`)
          ) {
            throw new Error(
              `Bundled Codex final release embedded artifact ${spec.directoryName}/${fileName} is invalid.`,
            );
          }
          transformedBytes.set(`${spec.platform}-${spec.arch}/${fileName}`, bytes);
          return {
            fileName,
            size,
            sha256: embeddedSha256,
            contentBase64: bytes.toString("base64"),
          };
        },
      );
      const expectedTransformedName = transformedManifestName(spec);
      if (
        (expectedTransformedName === null && embeddedArtifacts.length !== 0) ||
        (expectedTransformedName !== null &&
          (embeddedArtifacts.length !== 1 ||
            embeddedArtifacts[0]!.fileName !== expectedTransformedName))
      ) {
        throw new Error(
          `Bundled Codex final release set transformed inventory for ${spec.directoryName} is invalid.`,
        );
      }
      const componentArtifactNames = embeddedReceipt.artifacts.map((rawArtifact, artifactIndex) => {
        const artifact = objectValue(
          rawArtifact,
          `${spec.directoryName} receipt artifacts[${artifactIndex}]`,
        );
        const fileName = safeFileName(
          artifact.fileName,
          `${spec.directoryName} receipt artifacts[${artifactIndex}].fileName`,
        );
        const matching =
          retainedArtifacts.find((entry) => entry.sourceFileName === fileName) ??
          embeddedArtifacts.find((entry) => entry.fileName === fileName);
        if (!matching || matching.size !== artifact.size || matching.sha256 !== artifact.sha256) {
          throw new Error(
            `Bundled Codex final release component artifact ${spec.directoryName}/${fileName} has no exact provenance.`,
          );
        }
        return fileName;
      });
      if (
        new Set(componentArtifactNames).size !== componentArtifactNames.length ||
        componentArtifactNames.length !== retainedArtifacts.length + embeddedArtifacts.length
      ) {
        throw new Error(
          `Bundled Codex final release component ${spec.directoryName} provenance is incomplete.`,
        );
      }

      const reconstructionRoot = FS.mkdtempSync(
        Path.join(OS.tmpdir(), `moss-final-${spec.platform}-${spec.arch}-`),
      );
      reconstructionRoots.push(reconstructionRoot);
      writeNoReplace({
        outputDirectory: reconstructionRoot,
        targetPath: Path.join(reconstructionRoot, expectedReceiptFileName),
        bytes: receiptBytes,
        mode: 0o644,
      });
      for (const retained of retainedArtifacts) {
        copyDigestNoReplace({
          source: artifactDigests.get(retained.finalFileName)!,
          outputDirectory: reconstructionRoot,
          targetPath: Path.join(reconstructionRoot, retained.sourceFileName),
        });
      }
      for (const embedded of embeddedArtifacts) {
        writeNoReplace({
          outputDirectory: reconstructionRoot,
          targetPath: Path.join(reconstructionRoot, embedded.fileName),
          bytes: Buffer.from(embedded.contentBase64, "base64"),
          mode: 0o644,
        });
      }
      verifyBundledCodexReleaseReceipt({
        outputDir: reconstructionRoot,
        expectedPlatform: spec.platform,
        expectedArch: spec.arch,
        requirePublishEligible: true,
        ...(input.linuxFinalVerifier ? { linuxFinalVerifier: input.linuxFinalVerifier } : {}),
      });
      normalizedComponents.push({
        ...spec,
        receiptFileName: expectedReceiptFileName,
        receiptSize: receiptBytes.length,
        receiptSha256: embeddedReceiptSha256,
        receiptBase64: receiptBytes.toString("base64"),
        retainedArtifacts,
        embeddedArtifacts,
      });
    }

    const macArm64Bytes = transformedBytes.get("mac-arm64/latest-mac.yml");
    const macX64Bytes = transformedBytes.get("mac-x64/latest-mac-x64.yml");
    if (!macArm64Bytes || !macX64Bytes) {
      throw new Error("Bundled Codex final release set is missing macOS manifest provenance.");
    }
    const mergedMacBytes = Buffer.from(
      serializeMacUpdateManifest(
        mergeMacUpdateManifests(
          parseMacUpdateManifest(macArm64Bytes.toString("utf8"), "mac-arm64/latest-mac.yml"),
          parseMacUpdateManifest(macX64Bytes.toString("utf8"), "mac-x64/latest-mac-x64.yml"),
        ),
      ),
      "utf8",
    );
    const latestMacDigest = artifactDigests.get("latest-mac.yml");
    if (
      !latestMacDigest ||
      latestMacDigest.size !== mergedMacBytes.length ||
      latestMacDigest.sha256 !== sha256(mergedMacBytes) ||
      !readDigestBytes(latestMacDigest).equals(mergedMacBytes)
    ) {
      throw new Error("Bundled Codex final merged macOS manifest does not match its sources.");
    }
    const aliases = channelManifestNames(value.updateChannel);
    const aliasSources = [
      { sourceFileName: "latest-mac.yml", digest: latestMacDigest },
      {
        sourceFileName: "latest.yml",
        digest: artifactDigests.get("latest.yml"),
      },
      {
        sourceFileName: "latest-linux.yml",
        digest: artifactDigests.get("latest-linux.yml"),
      },
    ] as const;
    const normalizedAliases = aliases.map((finalFileName, index) => {
      const source = aliasSources[index]!;
      const alias = artifactDigests.get(finalFileName);
      if (
        !source.digest ||
        !alias ||
        source.digest.size !== alias.size ||
        source.digest.sha256 !== alias.sha256 ||
        !readDigestBytes(source.digest).equals(readDigestBytes(alias))
      ) {
        throw new Error(
          `Bundled Codex final channel manifest ${finalFileName} does not match ${source.sourceFileName}.`,
        );
      }
      return {
        sourceFileName: source.sourceFileName,
        finalFileName,
        sha256: alias.sha256,
      };
    });
    const expectedFinalArtifactNames = [
      ...retainedFinalNames,
      "latest-mac.yml",
      ...aliases,
    ].toSorted(compareUtf8);
    if (!isDeepStrictEqual(sortedNames, expectedFinalArtifactNames)) {
      throw new Error("Bundled Codex final release set provenance does not cover every artifact.");
    }
    const normalizedDerivation = {
      algorithm: "moss-final-update-manifests-v1" as const,
      macArm64SourceSha256: sha256(macArm64Bytes),
      macX64SourceSha256: sha256(macX64Bytes),
      mergedMacSha256: sha256(mergedMacBytes),
      channelAliases: normalizedAliases,
    };
    if (!isDeepStrictEqual(value.manifestDerivation, normalizedDerivation)) {
      throw new Error("Bundled Codex final release manifest derivation receipt is invalid.");
    }
    for (const digest of artifactDigests.values()) assertImmutableDigestCurrent(digest);
    assertImmutableDigestCurrent(receiptDigest);
    return {
      schemaVersion: 1,
      kind: "moss-bundled-codex-final-release-set-receipt",
      bundledCodexVersion: BUNDLED_CODEX_COMPLIANCE_VERSION,
      complianceBundleRootSha256: BUNDLED_CODEX_COMPLIANCE_BUNDLE_ROOT_SHA256,
      updateChannel: value.updateChannel,
      publishEligible: true,
      components: normalizedComponents,
      manifestDerivation: normalizedDerivation,
      artifacts,
    };
  } finally {
    for (const digest of artifactDigests.values()) FS.closeSync(digest.descriptor);
    FS.closeSync(receiptDigest.descriptor);
    for (const root of reconstructionRoots) FS.rmSync(root, { recursive: true, force: true });
  }
}
