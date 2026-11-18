// FILE: windows-native-payload-audit.mjs
// Purpose: Enforces a closed set for every native Windows payload in the packaged app.
// Layer: Release/build hook support

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import path from "node:path";
import asar, { uncache as uncacheFilesystem } from "@electron/asar";

import {
  WINDOWS_LATE_SIGNING_TARGET_PATHS,
  WINDOWS_UNPACKED_SIGNING_TARGET_PATHS,
} from "../windows-esigner-sign.mjs";

const TRACKED_EXTENSIONS = new Set([".dll", ".exe", ".node", ".pdb"]);
/**
 * Reviewed payloads that a `download` build ships as runtime archives instead of in resources/.
 * The installer must then hold none of them, and the archives must hold exactly them.
 */
export const WINDOWS_AGENT_RUNTIME_RESOURCE_PREFIXES = [
  "resources/codex-runtime/",
  "resources/claude-runtime/",
];
const isAgentRuntimePayload = (entryPath) =>
  WINDOWS_AGENT_RUNTIME_RESOURCE_PREFIXES.some((prefix) =>
    entryPath.toLowerCase().startsWith(prefix),
  );
const ELECTRON_BUILDER_WINDOWS_ARCHES = new Map([
  [1, "x64"],
  [3, "arm64"],
]);

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function sha256(filePath) {
  const descriptor = FS.openSync(filePath, "r");
  try {
    return sha256Range(descriptor, 0, FS.fstatSync(descriptor).size);
  } finally {
    FS.closeSync(descriptor);
  }
}

function sha256Range(descriptor, start, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
  let offset = 0;
  while (offset < size) {
    const read = FS.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      start + offset,
    );
    if (read === 0) throw new Error("Packaged Windows native audit encountered a truncated file.");
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

function isPortableExecutableRange(descriptor, start, size) {
  if (size < 64) return false;
  const dosHeader = Buffer.alloc(64);
  if (FS.readSync(descriptor, dosHeader, 0, dosHeader.length, start) !== dosHeader.length) {
    return false;
  }
  if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) return false;
  const peOffset = dosHeader.readUInt32LE(0x3c);
  if (peOffset > size - 4) return false;
  const signature = Buffer.alloc(4);
  if (
    FS.readSync(descriptor, signature, 0, signature.length, start + peOffset) !== signature.length
  ) {
    return false;
  }
  return signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]));
}

function isPortableExecutable(filePath, size) {
  if (size < 64) return false;
  const descriptor = FS.openSync(filePath, "r");
  try {
    return isPortableExecutableRange(descriptor, 0, size);
  } finally {
    FS.closeSync(descriptor);
  }
}

function collectAsarNativeFiles(rootDirectory) {
  const archivePath = path.join(rootDirectory, "resources", "app.asar");
  let archiveStat;
  try {
    archiveStat = FS.lstatSync(archivePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
    throw new Error("Packaged Windows app.asar must be a regular file.");
  }

  // @electron/asar caches parsed headers by archive path. afterPack and
  // afterSign run in the same electron-builder process, so force every audit
  // to read the archive currently present at this path.
  uncacheFilesystem(archivePath);
  const descriptor = FS.openSync(archivePath, "r");
  try {
    const payloadStart = 8 + asar.getRawHeader(archivePath).headerSize;
    const nativeFiles = [];
    for (const rawEntryPath of asar.listPackage(archivePath, { isPack: false })) {
      const entryPath = rawEntryPath.replace(/^[/\\]+/, "").replaceAll("\\", "/");
      if (
        !entryPath ||
        entryPath
          .split("/")
          .some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        throw new Error(
          `Packaged Windows app.asar contains an invalid entry path: ${rawEntryPath}.`,
        );
      }
      // @electron/asar traverses archive headers with the host path separator.
      // listPackage therefore returns backslash-delimited entries on Windows,
      // while the normalized path above is intentionally POSIX-style for
      // validation, manifest comparison, and diagnostics. Convert it back for
      // archive lookups instead of passing a POSIX path to Windows path APIs.
      const archiveLookupPath = entryPath.split("/").join(path.sep);
      const entry = asar.statFile(archivePath, archiveLookupPath, false);
      if ("link" in entry) {
        throw new Error(`Packaged Windows app.asar rejects symbolic links: ${entryPath}.`);
      }
      if ("files" in entry || entry.unpacked === true) continue;
      const offset = Number(entry.offset);
      const start = payloadStart + offset;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !Number.isSafeInteger(start + entry.size) ||
        start + entry.size > archiveStat.size
      ) {
        throw new Error(`Packaged Windows app.asar contains an invalid file range: ${entryPath}.`);
      }
      const trackedExtension = TRACKED_EXTENSIONS.has(path.posix.extname(entryPath).toLowerCase());
      if (!trackedExtension && !isPortableExecutableRange(descriptor, start, entry.size)) continue;
      nativeFiles.push({
        absolutePath: `${archivePath}:${entryPath}`,
        path: `resources/app.asar/${entryPath}`,
        sha256: sha256Range(descriptor, start, entry.size),
      });
    }
    return nativeFiles;
  } finally {
    FS.closeSync(descriptor);
    uncacheFilesystem(archivePath);
  }
}

function collectNativeFiles(rootDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of FS.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDirectory, absolutePath));
      if (entry.isSymbolicLink()) {
        throw new Error(`Packaged Windows native audit rejects symbolic links: ${relativePath}.`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = FS.statSync(absolutePath);
      const trackedExtension = TRACKED_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
      if (!trackedExtension && !isPortableExecutable(absolutePath, stat.size)) continue;
      files.push({
        absolutePath,
        path: relativePath,
        sha256: sha256(absolutePath),
      });
    }
  };
  visit(rootDirectory);
  files.push(...collectAsarNativeFiles(rootDirectory));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertAppOutputDirectory(appOutDir) {
  let stat;
  try {
    stat = FS.lstatSync(appOutDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Windows app output directory does not exist: ${appOutDir}.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Windows app output directory must not be a symbolic link: ${appOutDir}.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Windows app output path must be a directory: ${appOutDir}.`);
  }
}

function assertExpectedPathsAreRegularFiles(appOutDir, expected) {
  for (const entry of expected.values()) {
    const absolutePath = path.join(appOutDir, ...entry.path.split("/"));
    let stat;
    try {
      stat = FS.lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Reviewed Windows native payload must not be a symbolic link: ${entry.path}.`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(`Reviewed Windows native payload must be a regular file: ${entry.path}.`);
    }
  }
}

function validateManifestEntry(entry, category) {
  if (
    typeof entry?.path !== "string" ||
    entry.path.startsWith("/") ||
    entry.path.includes("\\") ||
    entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Windows native payload manifest contains an invalid path: ${String(entry?.path)}.`,
    );
  }
  if (entry.path.toLowerCase().startsWith("resources/app.asar/")) {
    throw new Error(
      `Windows native payloads must never be approved inside app.asar: ${entry.path}.`,
    );
  }
  if (entry.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error(`Windows native payload manifest has an invalid SHA-256 for ${entry.path}.`);
  }
  if (category === "preservedPayloads" && entry.sha256 === undefined) {
    throw new Error(`Preserved Windows payload ${entry.path} must pin SHA-256 bytes.`);
  }
  if (category === "signingTargets" && entry.path !== "Moss.exe" && entry.sha256 === undefined) {
    throw new Error(`Windows signing target ${entry.path} must pin pre-signing SHA-256 bytes.`);
  }
  if (category === "lateSigningTargets" && entry.sha256 === undefined) {
    throw new Error(`Late Windows signing target ${entry.path} must pin SHA-256 bytes.`);
  }
  if (typeof entry.source !== "string" || !entry.source.trim()) {
    throw new Error(`Windows native payload manifest has no source provenance for ${entry.path}.`);
  }
}

function readExpectedEntries(manifest, arch) {
  if (manifest?.schemaVersion !== 2) {
    throw new Error("Windows native payload manifest schemaVersion must be 2.");
  }
  const platformManifest = manifest?.windows?.[arch];
  if (!platformManifest || typeof platformManifest !== "object") {
    throw new Error(`Windows native payload manifest has no reviewed ${arch} entries.`);
  }
  const signingTargets = platformManifest.signingTargets;
  const lateSigningTargets = platformManifest.lateSigningTargets;
  const preservedPayloads = platformManifest.preservedPayloads;
  if (!Array.isArray(signingTargets) || signingTargets.length === 0) {
    throw new Error(`Windows native payload manifest has no ${arch} Moss signing targets.`);
  }
  if (!Array.isArray(preservedPayloads) || preservedPayloads.length === 0) {
    throw new Error(`Windows native payload manifest has no ${arch} preserved payloads.`);
  }
  if (!Array.isArray(lateSigningTargets) || lateSigningTargets.length === 0) {
    throw new Error(`Windows native payload manifest has no ${arch} late signing targets.`);
  }

  const expected = new Map();
  const add = (entry, category) => {
    validateManifestEntry(entry, category);
    const key = entry.path.toLowerCase();
    if (expected.has(key)) {
      throw new Error(`Windows native payload manifest repeats ${entry.path}.`);
    }
    expected.set(key, { ...entry, category });
  };
  for (const entry of signingTargets) add(entry, "signingTargets");
  for (const entry of lateSigningTargets) {
    validateManifestEntry(entry, "lateSigningTargets");
    const key = entry.path.toLowerCase();
    if (expected.has(key)) {
      throw new Error(`Windows native payload manifest repeats ${entry.path}.`);
    }
    expected.set(key, { ...entry, category: "lateSigningTargets" });
  }
  for (const entry of preservedPayloads) add(entry, "preservedPayloads");

  const configuredSigningPaths = signingTargets.map((entry) => entry.path).sort();
  const signerPaths = [...WINDOWS_UNPACKED_SIGNING_TARGET_PATHS].sort();
  if (JSON.stringify(configuredSigningPaths) !== JSON.stringify(signerPaths)) {
    throw new Error("Windows signing hook paths and native payload manifest are out of sync.");
  }
  const configuredLateSigningPaths = lateSigningTargets.map((entry) => entry.path).sort();
  const lateSignerPaths = [...WINDOWS_LATE_SIGNING_TARGET_PATHS].sort();
  if (JSON.stringify(configuredLateSigningPaths) !== JSON.stringify(lateSignerPaths)) {
    throw new Error("Windows late signing hook paths and native payload manifest are out of sync.");
  }
  for (const entry of lateSigningTargets) {
    expected.delete(entry.path.toLowerCase());
  }
  return expected;
}

export function resolveWindowsNativePayloadHookContext(context, env = process.env) {
  if (context?.electronPlatformName !== "win32") {
    throw new Error(
      `Windows native payload hook requires electronPlatformName=win32, got ${context?.electronPlatformName ?? "<missing>"}.`,
    );
  }

  const configuredArch = env.MOSS_WINDOWS_TARGET_ARCH?.trim();
  if (configuredArch !== "x64" && configuredArch !== "arm64") {
    throw new Error(
      `MOSS_WINDOWS_TARGET_ARCH must be x64 or arm64, got ${configuredArch || "<missing>"}.`,
    );
  }

  const contextArch = ELECTRON_BUILDER_WINDOWS_ARCHES.get(context.arch);
  if (contextArch === undefined) {
    throw new Error(
      `Windows native payload hook received unsupported electron-builder arch ${String(context.arch)}.`,
    );
  }
  if (contextArch !== configuredArch) {
    throw new Error(
      `Windows native payload hook arch mismatch: electron-builder=${contextArch}, MOSS_WINDOWS_TARGET_ARCH=${configuredArch}.`,
    );
  }
  if (typeof context.appOutDir !== "string" || !context.appOutDir.trim()) {
    throw new Error("Windows native payload hook received no appOutDir.");
  }

  return { appOutDir: context.appOutDir, arch: configuredArch };
}

export function auditWindowsNativePayloads({
  appOutDir,
  arch,
  manifest,
  phase,
  agentRuntimes = "bundled",
}) {
  if (phase !== "before-sign" && phase !== "after-sign") {
    throw new Error(
      `Windows native payload audit phase must be before-sign or after-sign, got ${phase}.`,
    );
  }
  if (agentRuntimes !== "bundled" && agentRuntimes !== "download") {
    throw new Error(`Windows native payload audit agentRuntimes must be bundled or download.`);
  }
  assertAppOutputDirectory(appOutDir);
  const expected = readExpectedEntries(manifest, arch);
  // A download build must not carry the runtimes: any such file is then "unreviewed".
  if (agentRuntimes === "download") {
    for (const [key, entry] of expected)
      if (isAgentRuntimePayload(entry.path)) expected.delete(key);
  }
  assertExpectedPathsAreRegularFiles(appOutDir, expected);
  const nativeFiles = collectNativeFiles(appOutDir);
  const signingTargets = [];
  const preservedPayloads = [];
  const unexpected = [];

  for (const file of nativeFiles) {
    const approved = expected.get(file.path.toLowerCase());
    if (!approved) {
      unexpected.push(`${file.path}:${file.sha256}`);
      continue;
    }
    if (approved.path !== file.path) {
      throw new Error(
        `Windows native payload path casing changed: expected ${approved.path}, got ${file.path}.`,
      );
    }
    if (
      approved.sha256 !== undefined &&
      (approved.category === "preservedPayloads" || phase === "before-sign") &&
      approved.sha256 !== file.sha256
    ) {
      throw new Error(
        `Windows native payload SHA-256 mismatch for ${file.path}: expected ${approved.sha256}, got ${file.sha256}.`,
      );
    }
    expected.delete(file.path.toLowerCase());
    if (approved.category === "signingTargets") signingTargets.push(file);
    else preservedPayloads.push(file);
  }

  if (unexpected.length > 0) {
    throw new Error(`Unreviewed Windows native payloads:\n${unexpected.join("\n")}`);
  }
  if (expected.size > 0) {
    throw new Error(
      `Reviewed Windows native payloads are missing:\n${[...expected.values()]
        .map((entry) => entry.path)
        .join("\n")}`,
    );
  }

  return { nativeFiles, preservedPayloads, signingTargets };
}

/**
 * Audits the unpacked runtime archives of a `download` build against the same reviewed manifest:
 * `root` holds `resources/codex-runtime` and `resources/claude-runtime` as a person gets them
 * after the download. Every native file there must be a reviewed payload with its pinned bytes,
 * and every reviewed runtime payload must be there.
 */
export function auditWindowsAgentRuntimePayloads({ root, arch, manifest }) {
  assertAppOutputDirectory(root);
  const expected = new Map(
    [...readExpectedEntries(manifest, arch)].filter(([, entry]) =>
      isAgentRuntimePayload(entry.path),
    ),
  );
  const nativeFiles = collectNativeFiles(root);
  const unexpected = [];
  for (const file of nativeFiles) {
    const approved = expected.get(file.path.toLowerCase());
    if (!approved || approved.path !== file.path) {
      unexpected.push(`${file.path}:${file.sha256}`);
      continue;
    }
    if (approved.sha256 !== file.sha256) {
      throw new Error(
        `Windows runtime archive payload SHA-256 mismatch for ${file.path}: expected ${approved.sha256}, got ${file.sha256}.`,
      );
    }
    expected.delete(file.path.toLowerCase());
  }
  if (unexpected.length > 0) {
    throw new Error(`Unreviewed Windows runtime archive payloads:\n${unexpected.join("\n")}`);
  }
  if (expected.size > 0) {
    throw new Error(
      `Reviewed Windows runtime payloads are missing from the archives:\n${[...expected.values()]
        .map((entry) => entry.path)
        .join("\n")}`,
    );
  }
  return { nativeFiles };
}
