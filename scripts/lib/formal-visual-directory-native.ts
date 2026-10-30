// FILE: formal-visual-directory-native.ts
// Purpose: Provides descriptor-relative no-follow filesystem mutations unavailable in Node fs.
// Layer: Release verification native boundary

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface NativeDirectoryAddon {
  readonly openAt: (
    directoryDescriptor: number,
    entryName: string,
    flags: number,
    mode: number,
  ) => number;
  readonly readDirectoryNames: (directoryDescriptor: number) => readonly string[];
  readonly renameAtExclusiveVerified: (
    directoryDescriptor: number,
    sourceDescriptor: number,
    sourceName: string,
    targetName: string,
    quarantineName: string,
    afterSourcePrecheck: (() => void) | undefined,
  ) => number;
}

interface NativeCompileOptions {
  readonly sourcePath?: string;
  readonly compilerPath?: string;
  readonly afterSourceSnapshot?: () => void;
  readonly onBuildDirectory?: (path: string) => void;
  readonly beforeAddonLoad?: (path: string) => void;
  readonly afterAddonLoadAttempt?: (path: string) => void;
}

const SOURCE_PATH = fileURLToPath(new URL("./formal-visual-directory-native.c", import.meta.url));
const NAPI_HEADERS = [
  "node_api.h",
  "js_native_api.h",
  "node_api_types.h",
  "js_native_api_types.h",
] as const;
const NATIVE_TEMP_PREFIX = "moss-formal-native-";
const COMPILER_MAX_BUFFER = 1024 * 1024;
const NATIVE_ADDON_MAX_BYTES = 8 * 1024 * 1024;
const POSIX_WRITABLE_BY_GROUP_OR_OTHER = 0o022n;
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
let loadedAddon: NativeDirectoryAddon | undefined;

export function assertFormalVisualDirectoryPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(
      `Formal evidence native directory operations are unsupported on ${platform}; supported platforms are darwin and linux.`,
    );
  }
}

function safeEntryName(value: string, label: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    basename(value) !== value
  ) {
    throw new Error(`${label} must be one safe native directory-entry name.`);
  }
  return value;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid
  );
}

function assertAuditedRegularFile(
  metadata: BigIntStats,
  path: string,
  label: string,
  options: { readonly allowRootOwnedHardlinks?: boolean } = {},
): void {
  const effectiveUser = BigInt(process.geteuid?.() ?? Number(metadata.uid));
  const rootOwnedHardlink =
    options.allowRootOwnedHardlinks === true && metadata.uid === 0n && metadata.nlink >= 1n;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.nlink !== 1n && !rootOwnedHardlink) ||
    (metadata.uid !== 0n && metadata.uid !== effectiveUser) ||
    (metadata.mode & POSIX_WRITABLE_BY_GROUP_OR_OTHER) !== 0n
  ) {
    throw new Error(
      `${label} failed audited regular-file ownership, link-count, or write-permission checks: ${path}`,
    );
  }
}

function readAuditedStableFile(
  pathInput: string,
  label: string,
  options: { readonly allowRootOwnedHardlinks?: boolean } = {},
): Buffer {
  const path = realpathSync(pathInput);
  const before = lstatSync(path, { bigint: true });
  assertAuditedRegularFile(before, path, label, options);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(before, openedBefore)) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(openedBefore, openedAfter)) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nodeIncludeCandidates(): readonly string[] {
  const version = process.versions.node;
  const prefix = String(process.config.variables.node_prefix ?? "").trim();
  return [
    resolve(dirname(realpathSync(process.execPath)), "../include/node"),
    ...(prefix ? [resolve(prefix, "include/node")] : []),
    resolve(homedir(), `.local/share/mise/installs/node/${version}/include/node`),
    resolve(homedir(), `.volta/tools/image/node/${version}/include/node`),
    resolve(homedir(), `.nvm/versions/node/v${version}/include/node`),
    "/usr/include/node",
    "/usr/local/include/node",
    "/opt/homebrew/include/node",
  ];
}

function findNodeIncludeDirectory(): string {
  for (const candidate of nodeIncludeCandidates()) {
    try {
      for (const header of NAPI_HEADERS) {
        readAuditedStableFile(join(candidate, header), `Node N-API header ${header}`);
      }
      return realpathSync(candidate);
    } catch {
      // Continue through deterministic absolute candidates; no PATH program is executed.
    }
  }
  throw new Error(
    `Formal evidence native directory operations require audited, unpacked Node N-API headers matching Node ${process.versions.node}; packaged ASAR contents are not a substitute for a verification-host toolchain.`,
  );
}

function trustedCompilerPath(override?: string): string {
  const candidates = override
    ? [resolve(override)]
    : process.platform === "darwin"
      ? ["/usr/bin/clang"]
      : ["/usr/bin/cc", "/usr/bin/clang", "/usr/bin/gcc"];
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      readAuditedStableFile(path, "Native C compiler", { allowRootOwnedHardlinks: true });
      return path;
    } catch {
      // Only audited absolute compiler candidates are eligible.
    }
  }
  throw new Error(
    "Formal evidence native directory operations require an audited host C compiler at a fixed system path; the packaged Moss runtime does not provide or invoke this verification-only compiler.",
  );
}

function writePrivateSnapshot(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function assertPrivateSnapshot(path: string, expected: Buffer, label: string): void {
  const metadata = lstatSync(path, { bigint: true });
  if (Number(metadata.mode & 0o777n) !== 0o600) {
    throw new Error(`${label} must use private mode 0600.`);
  }
  const actual = readAuditedStableFile(path, label);
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  const actualHash = createHash("sha256").update(actual).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${label} changed after its private snapshot was written.`);
  }
}

function validateLoadedAddon(value: unknown): NativeDirectoryAddon {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Partial<NativeDirectoryAddon>).openAt !== "function" ||
    typeof (value as Partial<NativeDirectoryAddon>).readDirectoryNames !== "function" ||
    typeof (value as Partial<NativeDirectoryAddon>).renameAtExclusiveVerified !== "function"
  ) {
    throw new Error("Formal evidence native directory addon exports an invalid shape.");
  }
  return value as NativeDirectoryAddon;
}

function descriptorSha256(
  descriptor: number,
  metadata: Pick<BigIntStats, "size">,
  label: string,
): string {
  if (metadata.size < 1n || metadata.size > BigInt(NATIVE_ADDON_MAX_BYTES)) {
    throw new Error(`${label} has an invalid audited byte length.`);
  }
  const bytes = Buffer.alloc(Number(metadata.size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) throw new Error(`${label} ended before its audited byte length.`);
    offset += read;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function loadAddonFromDescriptor(descriptor: number): unknown {
  const descriptorPath =
    process.platform === "darwin" ? `/dev/fd/${descriptor}` : `/proc/self/fd/${descriptor}`;
  const nativeModule: { exports: unknown } = { exports: {} };
  const dlopen = process.dlopen as unknown as (
    module: { exports: unknown },
    filename: string,
  ) => void;
  dlopen(nativeModule, descriptorPath);
  return nativeModule.exports;
}

/**
 * Compiles a verification-host-only helper. This is deliberately not a packaged Moss runtime
 * dependency: the host must provide the unpacked audited C source, a fixed-path compiler, and
 * N-API headers matching the executing Node version. Missing assets fail before publication.
 */
function compileAndLoadAddon(options: NativeCompileOptions = {}): NativeDirectoryAddon {
  assertFormalVisualDirectoryPlatformSupported();
  const compilerPath = trustedCompilerPath(options.compilerPath);
  const includeDirectory = findNodeIncludeDirectory();
  let sourceBytes: Buffer;
  try {
    sourceBytes = readAuditedStableFile(
      options.sourcePath ?? SOURCE_PATH,
      "Native directory boundary source",
    );
  } catch (cause) {
    throw new Error(
      `Formal evidence native directory operations require the unpacked audited source asset at ${options.sourcePath ?? SOURCE_PATH}; packaged ASAR execution is unsupported for this verification-only helper.`,
      { cause },
    );
  }
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex").slice(0, 16);
  const buildDirectory = mkdtempSync(
    join(realpathSync(tmpdir()), `${NATIVE_TEMP_PREFIX}${sourceHash}-`),
  );
  const sourceSnapshotPath = join(buildDirectory, "formal-visual-directory-native.c");
  const addonPath = join(buildDirectory, "formal-visual-directory-native.node");
  const snapshotPaths = [sourceSnapshotPath, addonPath];
  const expectedSnapshots: {
    readonly path: string;
    readonly bytes: Buffer;
    readonly label: string;
  }[] = [];
  let result: NativeDirectoryAddon | undefined;
  let failure: unknown;
  try {
    chmodSync(buildDirectory, 0o700);
    options.onBuildDirectory?.(buildDirectory);
    writePrivateSnapshot(sourceSnapshotPath, sourceBytes);
    expectedSnapshots.push({
      path: sourceSnapshotPath,
      bytes: sourceBytes,
      label: "Native directory boundary source snapshot",
    });
    for (const header of NAPI_HEADERS) {
      const headerPath = join(buildDirectory, header);
      const headerBytes = readAuditedStableFile(
        join(includeDirectory, header),
        `Node N-API header ${header}`,
      );
      writePrivateSnapshot(headerPath, headerBytes);
      snapshotPaths.push(headerPath);
      expectedSnapshots.push({
        path: headerPath,
        bytes: headerBytes,
        label: `Node N-API header ${header} snapshot`,
      });
    }
    options.afterSourceSnapshot?.();
    for (const snapshot of expectedSnapshots) {
      assertPrivateSnapshot(snapshot.path, snapshot.bytes, snapshot.label);
    }
    const platformFlags =
      process.platform === "darwin"
        ? ["-bundle", "-undefined", "dynamic_lookup"]
        : ["-shared", "-D_GNU_SOURCE"];
    const compiler = spawnSync(
      compilerPath,
      [
        "-std=c11",
        "-Werror=implicit-function-declaration",
        "-O2",
        "-fPIC",
        ...platformFlags,
        "-I",
        buildDirectory,
        sourceSnapshotPath,
        "-o",
        addonPath,
      ],
      {
        cwd: buildDirectory,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        maxBuffer: COMPILER_MAX_BUFFER,
      },
    );
    if (compiler.error || compiler.status !== 0) {
      throw new Error(
        `Unable to compile formal evidence native directory operations: ${
          compiler.stderr.trim() || compiler.error?.message || "compiler failed"
        }`,
      );
    }
    chmodSync(addonPath, 0o700);
    const addonMetadata = lstatSync(addonPath, { bigint: true });
    assertAuditedRegularFile(addonMetadata, addonPath, "Compiled native directory addon");
    if (addonMetadata.nlink !== 1n) {
      throw new Error("Compiled native directory addon must have exactly one directory entry.");
    }
    let addonDescriptor: number | undefined;
    let loadAttemptStarted = false;
    try {
      addonDescriptor = openSync(addonPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const openedBefore = fstatSync(addonDescriptor, { bigint: true });
      if (!sameStableFile(addonMetadata, openedBefore)) {
        throw new Error("Compiled native directory addon changed while its handle was opened.");
      }
      const expectedAddonHash = descriptorSha256(
        addonDescriptor,
        openedBefore,
        "Compiled native directory addon",
      );
      loadAttemptStarted = true;
      options.beforeAddonLoad?.(addonPath);
      const openedAfter = fstatSync(addonDescriptor, { bigint: true });
      if (
        !sameStableFile(openedBefore, openedAfter) ||
        descriptorSha256(addonDescriptor, openedAfter, "Compiled native directory addon") !==
          expectedAddonHash
      ) {
        throw new Error("Compiled native directory addon handle changed before it was loaded.");
      }
      result = validateLoadedAddon(loadAddonFromDescriptor(addonDescriptor));
    } finally {
      if (loadAttemptStarted) options.afterAddonLoadAttempt?.(addonPath);
      if (addonDescriptor !== undefined) closeSync(addonDescriptor);
    }
  } catch (cause) {
    failure = cause;
  } finally {
    for (const path of snapshotPaths.toReversed()) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (cause) {
        failure ??= new Error(`Unable to clean native directory build artifact: ${path}`, {
          cause,
        });
      }
    }
    try {
      rmdirSync(buildDirectory);
    } catch (cause) {
      failure ??= new Error(`Unable to clean native directory build root: ${buildDirectory}`, {
        cause,
      });
    }
  }
  if (failure !== undefined) throw failure;
  if (!result) throw new Error("Native directory addon compilation produced no loaded result.");
  return result;
}

function nativeAddon(): NativeDirectoryAddon {
  loadedAddon ??= compileAndLoadAddon();
  return loadedAddon;
}

function nativeFailure(operation: string, result: number): Error {
  const errno = -result;
  return new Error(`${operation} failed in the native directory boundary (errno ${errno}).`);
}

export function openNativeDirectoryEntry(
  directoryDescriptor: number,
  entryName: string,
  flags: number,
  mode: number,
  label: string,
): number {
  const result = nativeAddon().openAt(
    directoryDescriptor,
    safeEntryName(entryName, label),
    flags,
    mode,
  );
  if (result < 0) throw nativeFailure(`${label} openat`, result);
  return result;
}

export function readNativeDirectoryNames(
  directoryDescriptor: number,
  label: string,
): readonly string[] {
  const names = nativeAddon().readDirectoryNames(directoryDescriptor);
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    throw new Error(`${label} native descriptor-relative readdir returned an invalid result.`);
  }
  return names;
}

export function renameNativeDirectoryEntryExclusiveVerified(
  directoryDescriptor: number,
  sourceDescriptor: number,
  sourceName: string,
  targetName: string,
  quarantineName: string,
  label: string,
  afterSourcePrecheck?: () => void,
): void {
  const result = nativeAddon().renameAtExclusiveVerified(
    directoryDescriptor,
    sourceDescriptor,
    safeEntryName(sourceName, `${label} source`),
    safeEntryName(targetName, `${label} target`),
    safeEntryName(quarantineName, `${label} rejected quarantine`),
    afterSourcePrecheck,
  );
  if (result === 1) {
    throw new Error(
      `${label} verified source identity changed inside the native rename boundary; the rejected canonical entry was atomically quarantined.`,
    );
  }
  if (result === 2) {
    throw new Error(
      `${label} verified source identity changed inside the native rename boundary and the rejected canonical entry could not be quarantined; no publication receipt was committed.`,
    );
  }
  if (-result === osConstants.errno.ESTALE) {
    throw new Error(`${label} verified source directory identity changed before publication.`);
  }
  if (result < 0) throw nativeFailure(`${label} verified renameat exclusive`, result);
  if (result !== 0) throw new Error(`${label} native verified rename returned an invalid status.`);
}

/** @internal Exercises a fresh compile boundary without mutating the production addon singleton. */
export function compileFormalVisualDirectoryNativeForTest(
  options: NativeCompileOptions = {},
): void {
  compileAndLoadAddon(options);
}
