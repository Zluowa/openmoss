#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION = 2;
export const CANONICAL_FILESYSTEM_HELPER_NAME = "moss-canonical-filesystem-helper";

const scriptPath = fileURLToPath(import.meta.url);
const serverDirectory = resolve(dirname(scriptPath), "..");
const sourcePath = join(
  serverDirectory,
  "native",
  "moss-canonical-filesystem-helper",
  `${CANONICAL_FILESYSTEM_HELPER_NAME}.c`,
);

export const defaultCanonicalFilesystemHelperPath = join(
  serverDirectory,
  "native",
  "moss-canonical-filesystem-helper",
  "build",
  CANONICAL_FILESYSTEM_HELPER_NAME,
);

const MAX_BINARY_BYTES = 8 * 1024 * 1024;

export function canonicalFilesystemHelperTargetsForArch(arch) {
  switch (arch) {
    case "arm64":
      return [{ arch: "arm64", target: "arm64-apple-macos12.3" }];
    case "x64":
      return [{ arch: "x64", target: "x86_64-apple-macos12.3" }];
    case "universal":
      return [
        { arch: "arm64", target: "arm64-apple-macos12.3" },
        { arch: "x64", target: "x86_64-apple-macos12.3" },
      ];
    default:
      throw new Error(`Unsupported canonical filesystem helper architecture: ${arch}`);
  }
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? serverDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      SOURCE_DATE_EPOCH: "0",
      ...(options.env ?? {}),
    },
  });
  if (result.status === 0) return result.stdout?.trim() ?? "";
  const details = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  throw new Error(
    `Canonical filesystem helper command failed (${command} ${arguments_.join(" ")}): ${result.status ?? "unknown"}${details ? `\n${details}` : ""}`,
  );
}

function sha256File(path) {
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BINARY_BYTES) {
    throw new Error("Canonical filesystem helper binary has an invalid size.");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function setDeterministicMachOUuid(path, fingerprint, arch) {
  const bytes = readFileSync(path);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error("Canonical filesystem helper did not produce a 64-bit Mach-O binary.");
  }
  const commandCount = bytes.readUInt32LE(16);
  let offset = 32;
  const uuid = createHash("sha256")
    .update(`moss-canonical-filesystem-helper-uuid\0${fingerprint}\0${arch}`)
    .digest()
    .subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  let found = false;
  for (let index = 0; index < commandCount; index += 1) {
    const command = bytes.readUInt32LE(offset);
    const commandSize = bytes.readUInt32LE(offset + 4);
    if (commandSize < 8 || offset + commandSize > bytes.byteLength) {
      throw new Error("Canonical filesystem helper Mach-O load command was invalid.");
    }
    if (command === 0x1b) {
      uuid.copy(bytes, offset + 8);
      found = true;
      break;
    }
    offset += commandSize;
  }
  if (!found) throw new Error("Canonical filesystem helper did not contain an LC_UUID command.");
  writeFileSync(path, bytes);
}

export function canonicalFilesystemHelperBuildFingerprint({ arch, sourceBytes, buildScriptBytes }) {
  const hash = createHash("sha256");
  hash.update("moss-canonical-filesystem-helper-build-v1\0");
  hash.update(String(CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION));
  hash.update("\0");
  hash.update(String(arch));
  hash.update("\0");
  hash.update(sourceBytes);
  hash.update("\0");
  hash.update(buildScriptBytes);
  return hash.digest("hex");
}

function metadataPathFor(outputPath) {
  return `${outputPath}.build.json`;
}

function expectedArchitectures(arch) {
  return canonicalFilesystemHelperTargetsForArch(arch).map(({ arch: targetArch }) => targetArch);
}

function architectureReceipt(outputPath, arch) {
  const reported = run("xcrun", ["lipo", "-info", outputPath]);
  const expected = expectedArchitectures(arch);
  const hasAll = expected.every((targetArch) =>
    reported.includes(targetArch === "x64" ? "x86_64" : targetArch),
  );
  if (!hasAll) {
    throw new Error(
      `Canonical filesystem helper architecture mismatch: expected ${expected.join(",")}, got ${reported}`,
    );
  }
  return { reported, architectures: expected };
}

function readMetadata(metadataPath) {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (
      parsed?.protocolVersion !== CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION ||
      typeof parsed?.fingerprint !== "string" ||
      typeof parsed?.sha256 !== "string" ||
      !Array.isArray(parsed?.architectures)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isUsableCachedBuild(outputPath, metadataPath, fingerprint, arch) {
  if (!existsSync(outputPath) || !existsSync(metadataPath)) return false;
  const metadata = readMetadata(metadataPath);
  if (!metadata || metadata.fingerprint !== fingerprint || metadata.arch !== arch) return false;
  try {
    if (sha256File(outputPath) !== metadata.sha256 || statSync(outputPath).size !== metadata.size) {
      return false;
    }
    architectureReceipt(outputPath, arch);
    return true;
  } catch {
    return false;
  }
}

function writeMetadata(metadataPath, metadata) {
  const pending = `${metadataPath}.tmp-${process.pid}`;
  writeFileSync(pending, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  renameSync(pending, metadataPath);
}

export function buildCanonicalFilesystemHelper({
  arch = process.arch,
  outputPath = defaultCanonicalFilesystemHelperPath,
  testHooks = false,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The canonical filesystem helper can only be built on macOS.");
  }
  const targets = canonicalFilesystemHelperTargetsForArch(arch);
  const sourceBytes = readFileSync(sourcePath);
  const buildScriptBytes = readFileSync(scriptPath);
  const fingerprint = canonicalFilesystemHelperBuildFingerprint({
    arch,
    sourceBytes,
    buildScriptBytes,
  });
  const resolvedOutputPath = resolve(outputPath);
  const metadataPath = metadataPathFor(resolvedOutputPath);
  if (isUsableCachedBuild(resolvedOutputPath, metadataPath, fingerprint, arch)) {
    if (!quiet) console.error(`[canonical-fs] Reusing ${arch} helper at ${resolvedOutputPath}`);
    return { path: resolvedOutputPath, metadata: readMetadata(metadataPath) };
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "moss-canonical-fs-helper-"));
  try {
    const thinBinaries = [];
    for (const target of targets) {
      const thinBinary = join(
        temporaryDirectory,
        `${CANONICAL_FILESYSTEM_HELPER_NAME}-${target.arch}`,
      );
      const flags = [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-target",
        target.target,
        "-mmacosx-version-min=12.3",
        ...(testHooks ? ["-DMOSS_CANONICAL_FS_TEST_HOOKS"] : []),
        sourcePath,
        "-o",
        thinBinary,
      ];
      run("xcrun", flags);
      setDeterministicMachOUuid(thinBinary, fingerprint, target.arch);
      thinBinaries.push(thinBinary);
    }

    const unsignedBinary = join(temporaryDirectory, CANONICAL_FILESYSTEM_HELPER_NAME);
    if (thinBinaries.length === 1) copyFileSync(thinBinaries[0], unsignedBinary);
    else run("xcrun", ["lipo", "-create", ...thinBinaries, "-output", unsignedBinary]);
    run("codesign", ["--force", "--sign", "-", "--timestamp=none", unsignedBinary]);

    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    const pendingOutputPath = `${resolvedOutputPath}.tmp-${process.pid}`;
    rmSync(pendingOutputPath, { force: true });
    copyFileSync(unsignedBinary, pendingOutputPath);
    chmodSync(pendingOutputPath, 0o755);
    rmSync(resolvedOutputPath, { force: true });
    renameSync(pendingOutputPath, resolvedOutputPath);

    const architecture = architectureReceipt(resolvedOutputPath, arch);
    const metadata = {
      schemaVersion: 1,
      helper: CANONICAL_FILESYSTEM_HELPER_NAME,
      protocolVersion: CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION,
      arch,
      architectures: architecture.architectures,
      fingerprint,
      sha256: sha256File(resolvedOutputPath),
      size: statSync(resolvedOutputPath).size,
    };
    writeMetadata(metadataPath, metadata);
    if (!quiet) {
      console.error(
        `[canonical-fs] Built ${arch} helper ${metadata.sha256} (${metadata.size} bytes)`,
      );
    }
    return { path: resolvedOutputPath, metadata };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArguments(arguments_) {
  let arch = process.arch;
  let outputPath = defaultCanonicalFilesystemHelperPath;
  let testHooks = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    switch (arguments_[index]) {
      case "--arch":
        arch = arguments_[++index];
        break;
      case "--output":
        outputPath = arguments_[++index];
        break;
      case "--test-hooks":
        testHooks = true;
        break;
      default:
        throw new Error(`Unknown canonical filesystem helper build argument: ${arguments_[index]}`);
    }
  }
  return { arch, outputPath, testHooks };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildCanonicalFilesystemHelper(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
