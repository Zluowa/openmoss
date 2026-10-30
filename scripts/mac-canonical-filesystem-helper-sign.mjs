// FILE: mac-canonical-filesystem-helper-sign.mjs
// Purpose: Refreshes the packaged canonical helper metadata immediately before
// the outer macOS app bundle signature is written.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMacBuildOnlySignOptions,
  parseMacBuildOnlySignArgs,
} from "./lib/mac-build-only-sign-options.mjs";
import { bindMacBuildOnlyAsarSigning } from "./lib/mac-asar-integrity.mjs";

const requireFromScriptsWorkspace = createRequire(new URL("./package.json", import.meta.url));
const requireFromElectronBuilder = createRequire(
  requireFromScriptsWorkspace.resolve("electron-builder/package.json"),
);
const { sign: signWithRetry } = requireFromElectronBuilder(
  "app-builder-lib/out/codeSign/macCodeSign",
);

const HELPER_NAME = "moss-canonical-filesystem-helper";
const PROTOCOL_VERSION = 2;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_HELPER_BINARY_BYTES = 8 * 1024 * 1024;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const HELPER_ARCHITECTURE_MAP = new Map([
  ["arm64", ["arm64"]],
  ["x64", ["x64"]],
  ["universal", ["arm64", "x64"]],
]);
const ALLOWED_METADATA_KEYS = new Set([
  "schemaVersion",
  "helper",
  "protocolVersion",
  "arch",
  "architectures",
  "fingerprint",
  "sha256",
  "size",
]);

export const MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH = path.join(
  "Contents",
  "Helpers",
  HELPER_NAME,
);
export const MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_APP_RELATIVE_PATH = path.join(
  "Contents",
  "Resources",
  `${HELPER_NAME}.build.json`,
);

function normalizeMode(mode) {
  return mode & 0o777;
}

function assertSafeContainedRealpath(appRealPath, candidateRealPath, label) {
  const relativePath = path.relative(appRealPath, candidateRealPath);
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} escaped the packaged app boundary: ${candidateRealPath}`);
  }
}

function assertNonSymlinkDirectory(directoryPath, label) {
  const entry = readLstat(directoryPath, label);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${directoryPath}`);
  }
  return realpathSync(directoryPath);
}

function readLstat(filePath, label) {
  try {
    return lstatSync(filePath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new Error(`${label} must be a non-symlink regular file: ${filePath}`);
    }
    throw cause;
  }
}

function readLstatBigint(filePath, label) {
  try {
    return lstatSync(filePath, { bigint: true });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new Error(`${label} must be a non-symlink regular file: ${filePath}`);
    }
    throw cause;
  }
}

function readIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function assertSameIdentity(left, right, label, filePath) {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.nlink !== right.nlink ||
    left.mode !== right.mode ||
    left.size !== right.size ||
    left.mtimeNs !== right.mtimeNs ||
    left.ctimeNs !== right.ctimeNs
  ) {
    throw new Error(`${label} path identity changed during validation: ${filePath}`);
  }
}

function assertExpectedRealpath(filePath, expectedRealPath, label) {
  const realPath = realpathSync(filePath);
  if (realPath !== expectedRealPath) {
    throw new Error(`${label} resolved through an unexpected symlinked parent: ${filePath}`);
  }
}

function assertReadableRegularFileIdentity(stat, label, filePath, maxBytes, requireExecutable) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file: ${filePath}`);
  }
  if (stat.nlink !== 1n) {
    throw new Error(`${label} must keep a single link count: ${filePath}`);
  }
  if (stat.size <= 0 || stat.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeded its size boundary: ${filePath}`);
  }
  if (requireExecutable && (Number(stat.mode) & 0o111) === 0) {
    throw new Error(`${label} must remain executable: ${filePath}`);
  }
}

function openReadonlyNoFollow(filePath, label) {
  const noFollowFlag = fsConstants.O_NOFOLLOW;
  if (typeof noFollowFlag !== "number") {
    throw new Error(`${label} requires O_NOFOLLOW support on this macOS host.`);
  }
  return openSync(filePath, fsConstants.O_RDONLY | noFollowFlag);
}

function resolvePackagedBindingPaths(appPath) {
  const appEntry = lstatSync(appPath);
  if (appEntry.isSymbolicLink() || !appEntry.isDirectory()) {
    throw new Error(`macOS signing app path must be a non-symlink .app directory: ${appPath}`);
  }
  const appRealPath = realpathSync(appPath);
  const helperPath = path.resolve(appPath, MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH);
  const metadataPath = path.resolve(
    appPath,
    MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_APP_RELATIVE_PATH,
  );
  const helperRealPath = resolveContainedRegularFile({
    appRealPath,
    filePath: helperPath,
    expectedRealPath: path.join(
      appRealPath,
      ...MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH.split(path.sep),
    ),
    label: "Canonical filesystem helper",
    requireExecutable: true,
    maxBytes: MAX_HELPER_BINARY_BYTES,
  }).realPath;
  const metadataResolution = resolveContainedRegularFile({
    appRealPath,
    filePath: metadataPath,
    expectedRealPath: path.join(
      appRealPath,
      ...MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_APP_RELATIVE_PATH.split(path.sep),
    ),
    label: "Canonical filesystem helper metadata",
    requireExecutable: false,
    maxBytes: MAX_METADATA_BYTES,
  });
  return {
    appPath,
    appRealPath,
    helperPath,
    helperRealPath,
    metadataPath,
    metadataRealPath: metadataResolution.realPath,
  };
}

function resolveContainedRegularFile({
  appRealPath,
  filePath,
  expectedRealPath,
  label,
  requireExecutable,
  maxBytes,
}) {
  const entry = readLstat(filePath, label);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file: ${filePath}`);
  }
  if (entry.size <= 0 || entry.size > maxBytes) {
    throw new Error(`${label} exceeded its size boundary: ${filePath}`);
  }
  if (requireExecutable && (entry.mode & 0o111) === 0) {
    throw new Error(`${label} must remain executable: ${filePath}`);
  }
  const realPath = realpathSync(filePath);
  assertSafeContainedRealpath(appRealPath, realPath, label);
  if (realPath !== expectedRealPath) {
    throw new Error(`${label} resolved through an unexpected symlinked parent: ${filePath}`);
  }
  return {
    filePath,
    realPath,
    mode: normalizeMode(entry.mode),
  };
}

function readImmutableFile(filePath, expectedRealPath, label, maxBytes, requireExecutable, hooks) {
  const pathBefore = readLstatBigint(filePath, label);
  assertReadableRegularFileIdentity(pathBefore, label, filePath, maxBytes, requireExecutable);
  assertExpectedRealpath(filePath, expectedRealPath, label);
  hooks?.beforeOpen?.(filePath);
  assertExpectedRealpath(filePath, expectedRealPath, label);
  const descriptor = openReadonlyNoFollow(filePath, label);
  try {
    const fdBefore = fstatSync(descriptor, { bigint: true });
    assertReadableRegularFileIdentity(fdBefore, label, filePath, maxBytes, requireExecutable);
    assertSameIdentity(readIdentity(pathBefore), readIdentity(fdBefore), label, filePath);
    const bytes = Buffer.alloc(Number(fdBefore.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.byteLength) {
      throw new Error(`${label} could not be read completely: ${filePath}`);
    }
    const fdAfter = fstatSync(descriptor, { bigint: true });
    assertReadableRegularFileIdentity(fdAfter, label, filePath, maxBytes, requireExecutable);
    assertSameIdentity(readIdentity(fdBefore), readIdentity(fdAfter), label, filePath);
    const pathAfter = readLstatBigint(filePath, label);
    assertReadableRegularFileIdentity(pathAfter, label, filePath, maxBytes, requireExecutable);
    assertSameIdentity(readIdentity(fdAfter), readIdentity(pathAfter), label, filePath);
    assertExpectedRealpath(filePath, expectedRealPath, label);
    return {
      bytes,
      mode: normalizeMode(Number(fdBefore.mode)),
      size: Number(fdBefore.size),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function parseAndValidateMetadata(bytes, metadataPath) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(
      `Canonical filesystem helper metadata is not valid JSON at ${metadataPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Canonical filesystem helper metadata must be a JSON object at ${metadataPath}`,
    );
  }
  const metadata = parsed;
  const keys = Object.keys(metadata);
  if (
    keys.length !== ALLOWED_METADATA_KEYS.size ||
    keys.some((key) => !ALLOWED_METADATA_KEYS.has(key))
  ) {
    throw new Error(
      `Canonical filesystem helper metadata has an unexpected schema at ${metadataPath}`,
    );
  }
  if (
    metadata.schemaVersion !== 1 ||
    metadata.helper !== HELPER_NAME ||
    metadata.protocolVersion !== PROTOCOL_VERSION ||
    typeof metadata.arch !== "string" ||
    !HELPER_ARCHITECTURE_MAP.has(metadata.arch) ||
    !Array.isArray(metadata.architectures) ||
    metadata.architectures.length !== HELPER_ARCHITECTURE_MAP.get(metadata.arch).length ||
    metadata.architectures.some(
      (item, index) => item !== HELPER_ARCHITECTURE_MAP.get(metadata.arch)[index],
    ) ||
    typeof metadata.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(metadata.fingerprint) ||
    typeof metadata.sha256 !== "string" ||
    !FINGERPRINT_PATTERN.test(metadata.sha256) ||
    typeof metadata.size !== "number" ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    metadata.size > MAX_HELPER_BINARY_BYTES
  ) {
    throw new Error(`Canonical filesystem helper metadata is invalid at ${metadataPath}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    helper: HELPER_NAME,
    protocolVersion: PROTOCOL_VERSION,
    arch: metadata.arch,
    architectures: [...metadata.architectures],
    fingerprint: metadata.fingerprint,
    sha256: metadata.sha256,
    size: metadata.size,
  });
}

function readPackagedCanonicalFilesystemHelperBinding(appPath, hooks) {
  const resolved = resolvePackagedBindingPaths(path.resolve(appPath));
  const helper = readImmutableFile(
    resolved.helperPath,
    resolved.helperRealPath,
    "Canonical filesystem helper",
    MAX_HELPER_BINARY_BYTES,
    true,
    hooks?.helper,
  );
  const metadataBytes = readImmutableFile(
    resolved.metadataPath,
    resolved.metadataRealPath,
    "Canonical filesystem helper metadata",
    MAX_METADATA_BYTES,
    false,
    hooks?.metadata,
  );
  const metadata = parseAndValidateMetadata(metadataBytes.bytes, resolved.metadataPath);
  return {
    ...resolved,
    helperMode: helper.mode,
    helperSha256: helper.sha256,
    helperSize: helper.size,
    metadata,
    metadataMode: metadataBytes.mode,
  };
}

export function verifyPackagedCanonicalFilesystemHelperBinding(appPath) {
  const binding = readPackagedCanonicalFilesystemHelperBinding(appPath);
  if (
    binding.metadata.sha256 !== binding.helperSha256 ||
    binding.metadata.size !== binding.helperSize
  ) {
    throw new Error(
      `Canonical filesystem helper metadata does not match the packaged helper bytes at ${binding.appPath}`,
    );
  }
  return binding;
}

export function writeCanonicalFilesystemHelperMetadataAtomically(
  metadataPath,
  expectedRealPath,
  nextMetadata,
  mode,
  hooks = {},
) {
  const metadataDirectory = path.dirname(metadataPath);
  const metadataDirectoryRealPath = assertNonSymlinkDirectory(
    metadataDirectory,
    "Canonical filesystem helper metadata directory",
  );
  const pendingPath =
    hooks.pendingPath ??
    path.join(
      metadataDirectoryRealPath,
      `.${path.basename(metadataPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
  const payload = Buffer.from(`${JSON.stringify(nextMetadata)}\n`, "utf8");
  if (payload.byteLength > MAX_METADATA_BYTES) {
    throw new Error(
      `Canonical filesystem helper metadata exceeded its size boundary: ${metadataPath}`,
    );
  }

  let descriptor;
  try {
    descriptor = openSync(pendingPath, "wx", mode);
    // The process umask can narrow the mode passed to open(2) (the release
    // worker intentionally runs with a private umask).  Restore the exact
    // canonical mode before validating and atomically publishing the sidecar.
    chmodSync(pendingPath, normalizeMode(mode));
    let offset = 0;
    while (offset < payload.byteLength) {
      offset += writeSync(descriptor, payload, offset, payload.byteLength - offset);
    }
    fsyncSync(descriptor);
    const pendingStats = statSync(pendingPath);
    if (!pendingStats.isFile() || normalizeMode(pendingStats.mode) !== normalizeMode(mode)) {
      throw new Error(
        `Canonical filesystem helper metadata temp file has an unexpected mode: ${pendingPath}`,
      );
    }
    hooks.beforeRename?.(pendingPath);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(pendingPath, metadataPath);
    const directoryDescriptor = openSync(metadataDirectoryRealPath, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    const finalStats = statSync(metadataPath);
    if (!finalStats.isFile() || normalizeMode(finalStats.mode) !== normalizeMode(mode)) {
      throw new Error(
        `Canonical filesystem helper metadata mode changed unexpectedly: ${metadataPath}`,
      );
    }
    assertExpectedRealpath(metadataPath, expectedRealPath, "Canonical filesystem helper metadata");
  } catch (cause) {
    try {
      unlinkSync(pendingPath);
    } catch {
      // best effort cleanup
    }
    throw cause;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function refreshPackagedCanonicalFilesystemHelperMetadata(appPath, hooks) {
  const binding = readPackagedCanonicalFilesystemHelperBinding(appPath, hooks?.readHooks);
  const nextMetadata = {
    ...binding.metadata,
    sha256: binding.helperSha256,
    size: binding.helperSize,
  };
  writeCanonicalFilesystemHelperMetadataAtomically(
    binding.metadataPath,
    binding.metadataRealPath,
    nextMetadata,
    binding.metadataMode,
    hooks,
  );
  return {
    helperPath: binding.helperPath,
    metadataPath: binding.metadataPath,
    sha256: binding.helperSha256,
    size: binding.helperSize,
    refreshCount: 1,
  };
}

export function wrapMacSignOptionsForCanonicalFilesystemHelper(options) {
  const appPath = path.resolve(options.app);
  const originalOptionsForFile = options.optionsForFile;
  const state = { refreshCount: 0 };

  return {
    options: {
      ...options,
      optionsForFile(filePath) {
        if (path.resolve(filePath) === appPath) {
          refreshPackagedCanonicalFilesystemHelperMetadata(appPath);
          state.refreshCount += 1;
        }
        return originalOptionsForFile ? originalOptionsForFile(filePath) : undefined;
      },
    },
    state,
  };
}

export async function signMacCanonicalFilesystemHelperAware(
  options,
  signImplementation = signWithRetry,
) {
  const wrapped = wrapMacSignOptionsForCanonicalFilesystemHelper(options);
  await signImplementation(wrapped.options);
  if (wrapped.state.refreshCount < 1) {
    throw new Error(
      "Canonical filesystem helper metadata refresh did not run before the outer macOS app signature.",
    );
  }
  const verified = verifyPackagedCanonicalFilesystemHelperBinding(options.app);
  return {
    refreshCount: wrapped.state.refreshCount,
    helperPath: verified.helperPath,
    metadataPath: verified.metadataPath,
    sha256: verified.helperSha256,
    size: verified.helperSize,
  };
}

export default async function signMacCanonicalFilesystemHelperAwareDefault(options) {
  return await signMacCanonicalFilesystemHelperAware(options);
}

async function runMacBuildOnlySignCli(argv) {
  const options = createMacBuildOnlySignOptions(
    parseMacBuildOnlySignArgs(argv),
    MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH,
  );
  if (process.platform !== "darwin") {
    throw new Error("Build-only macOS application signing must run on macOS.");
  }
  verifyPackagedCanonicalFilesystemHelperBinding(options.app);
  const asar = bindMacBuildOnlyAsarSigning(options.app);
  const originalOptionsForFile = options.optionsForFile;
  await signMacCanonicalFilesystemHelperAware({
    ...options,
    // osx-sign 1.3.3 retains a single predicate but discards ignore arrays.
    ignore: asar.shouldIgnoreFile,
    optionsForFile(filePath) {
      if (path.resolve(filePath) === options.app) asar.refresh();
      return originalOptionsForFile(filePath);
    },
  });
  asar.finish();
  console.log("[mac-build-only-sign] Sealed the application with the explicit ad-hoc identity.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMacBuildOnlySignCli(process.argv.slice(2)).catch(() => {
    console.error("[mac-build-only-sign] Failed to create an ad-hoc application seal.");
    process.exitCode = 1;
  });
}
