// FILE: windows-nsis-archive-cache.mjs
// Purpose: Opt-in content-verified incremental 7z cache for Windows NSIS non-solid archives.
// Layer: Release/build helper

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import * as Path from "node:path";
import { promisify } from "node:util";
import * as Zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export const WINDOWS_NSIS_ARCHIVE_CACHE_ENV = "MOSS_WINDOWS_NSIS_ARCHIVE_CACHE";
export const WINDOWS_NSIS_ARCHIVE_CACHE_LEVEL_ENV = "MOSS_WINDOWS_NSIS_ARCHIVE_CACHE_LEVEL";
export const DEFAULT_NSIS_PRECOMPRESSED_EXTENSIONS = [
  ".avi",
  ".mov",
  ".m4v",
  ".mp4",
  ".m4p",
  ".qt",
  ".mkv",
  ".webm",
  ".vmdk",
];

const CACHE_FORMAT_VERSION = "moss-nsis-7z-cache-v2";
const HASH_CONCURRENCY = 16;
const SMALL_HASH_READ_LIMIT_BYTES = 4 * 1024 * 1024;
const FULL_REBUILD_RATIO = 0.75;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function updateCrc32(chunk, previous) {
  if (typeof Zlib.crc32 === "function") {
    return Zlib.crc32(chunk, previous);
  }
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatCrc32Hex(value) {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function normalizeArchivePath(relPath) {
  return relPath.replaceAll("\\", "/");
}

/**
 * Files whose bytes change on virtually every code release (the Electron host exe after ASAR
 * integrity stamping, app.asar, and the bundled ssh-runtime tarball). Keeping them out of the
 * cached stable base eliminates `7za d` and cache rewrites on warm builds.
 */
function isVolatileArchivePath(relPath) {
  if (relPath === "resources/app.asar" || relPath === "resources/ssh-runtime.tar.gz") {
    return true;
  }
  return !relPath.includes("/") && relPath.toLowerCase().endsWith(".exe");
}

function validateCompressionDigit(raw, fallback) {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^[1-9]$/u.test(value)) {
    throw new Error(`Invalid 7z compression level "${value}"; expected a digit 1-9.`);
  }
  return value;
}

export function resolveWindowsNsisArchiveCacheDir(env = process.env) {
  const raw = env[WINDOWS_NSIS_ARCHIVE_CACHE_ENV]?.trim();
  return raw ? Path.resolve(raw) : undefined;
}

export function resolveSevenZaBinaryPath() {
  let sevenZipBin;
  try {
    sevenZipBin = requireFromHere("7zip-bin");
  } catch {
    const ebPkg = requireFromHere.resolve("electron-builder/package.json");
    const abPkg = createRequire(ebPkg).resolve("app-builder-lib/package.json");
    sevenZipBin = createRequire(abPkg)("7zip-bin");
  }
  if (!sevenZipBin?.path7za || typeof sevenZipBin.path7za !== "string") {
    throw new Error("Could not resolve 7zip-bin path7za executable.");
  }
  return sevenZipBin.path7za;
}

async function run7za(sevenZaPath, args, cwd) {
  const { stdout } = await execFileAsync(sevenZaPath, args, {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function detectSevenZaVersion(sevenZaPath) {
  try {
    const out = await run7za(sevenZaPath, ["i"], undefined);
    const firstLine = out
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ?? "7za-unknown";
  } catch {
    return "7za-unknown";
  }
}

async function hashFileSha256AndCrc32(filePath) {
  const fileStat = await stat(filePath);
  if (fileStat.size <= SMALL_HASH_READ_LIMIT_BYTES) {
    const buffer = await readFile(filePath);
    return {
      size: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      crc32: formatCrc32Hex(updateCrc32(buffer, 0)),
    };
  }
  const sha = createHash("sha256");
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sha.update(buffer);
    crc = updateCrc32(buffer, crc);
    size += buffer.byteLength;
  }
  return {
    size,
    sha256: sha.digest("hex"),
    crc32: formatCrc32Hex(crc),
  };
}

async function copyFileAndSha256(sourcePath, targetPath) {
  const sha = createHash("sha256");
  const reader = createReadStream(sourcePath, { highWaterMark: 4 * 1024 * 1024 });
  const writer = createWriteStream(targetPath, { highWaterMark: 4 * 1024 * 1024 });
  await new Promise((resolveDone, rejectDone) => {
    reader.on("data", (chunk) => {
      sha.update(chunk);
    });
    reader.on("error", rejectDone);
    writer.on("error", rejectDone);
    writer.on("finish", resolveDone);
    reader.pipe(writer);
  });
  return sha.digest("hex");
}

async function sha256File(filePath) {
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) {
    sha.update(chunk);
  }
  return sha.digest("hex");
}

async function scanAppOutDir(appOutDir, preCompressedExtensions) {
  const excludedExts = new Set(
    preCompressedExtensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()),
  );
  const filePaths = [];
  const emptyDirs = [];

  const walk = async (dirPath, relPrefix) => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let hasIncludedChild = false;
    for (const entry of entries) {
      const abs = Path.join(dirPath, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hasIncludedChild = true;
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const ext = Path.extname(entry.name).toLowerCase();
        if (excludedExts.has(ext)) continue;
        hasIncludedChild = true;
        filePaths.push({ abs, rel });
      }
    }
    if (relPrefix && !hasIncludedChild) {
      emptyDirs.push(relPrefix);
    }
  };

  await walk(appOutDir, "");

  /** @type {Map<string, { size: number, sha256: string, crc32: string }>} */
  const files = new Map();
  let totalBytes = 0;
  let next = 0;
  const worker = async () => {
    while (next < filePaths.length) {
      const item = filePaths[next];
      next += 1;
      const digest = await hashFileSha256AndCrc32(item.abs);
      files.set(item.rel, digest);
      totalBytes += digest.size;
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, filePaths.length) }, worker));

  return { files, emptyDirs: emptyDirs.toSorted(), totalBytes };
}

/** Parses `7za l -slt` output into a Map<normalizedPath, { size: number, crc32: string }>. */
export function parse7zTechnicalListing(output) {
  const entries = new Map();
  const blocks = output.split(/\r?\n\r?\n/u);
  let pastSeparator = false;
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    let isFolder = false;
    let entryPath = null;
    let size = null;
    let crc = "";
    for (const line of lines) {
      if (line === "----------") {
        pastSeparator = true;
        continue;
      }
      if (!pastSeparator) continue;
      if (line.startsWith("Path = ")) entryPath = normalizeArchivePath(line.slice(7));
      else if (line.startsWith("Folder = ")) isFolder = line.slice(9).trim() === "+";
      else if (line.startsWith("Attributes = ")) {
        const attrs = line.slice(13).trim();
        if (attrs.startsWith("D")) isFolder = true;
      } else if (line.startsWith("Size = ")) size = Number(line.slice(7));
      else if (line.startsWith("CRC = ")) crc = line.slice(6).trim().toUpperCase();
    }
    if (!pastSeparator || !entryPath || isFolder) continue;
    if (size === null || !Number.isFinite(size)) {
      throw new Error(`7z listing entry missing numeric Size for ${entryPath}`);
    }
    entries.set(entryPath, { size, crc32: crc });
  }
  return entries;
}

async function verifyArchiveMatchesFiles(sevenZaPath, archivePath, expectedFiles) {
  const listing = await run7za(sevenZaPath, ["l", "-slt", "-sccUTF-8", archivePath], undefined);
  const actualFiles = parse7zTechnicalListing(listing);

  if (actualFiles.size !== expectedFiles.size) {
    const missing = [...expectedFiles.keys()].filter((p) => !actualFiles.has(p)).slice(0, 5);
    const extra = [...actualFiles.keys()].filter((p) => !expectedFiles.has(p)).slice(0, 5);
    throw new Error(
      `7z archive file count mismatch (archive=${actualFiles.size}, expected=${expectedFiles.size}; missing=${missing.join(",")}; extra=${extra.join(",")}).`,
    );
  }

  for (const [relPath, expected] of expectedFiles.entries()) {
    const actual = actualFiles.get(relPath);
    if (!actual) {
      throw new Error(`7z archive is missing expected file: ${relPath}`);
    }
    if (actual.size !== expected.size) {
      throw new Error(
        `7z archive size mismatch for ${relPath} (archive=${actual.size}, expected=${expected.size}).`,
      );
    }
    if (expected.size > 0 && actual.crc32 !== expected.crc32) {
      throw new Error(
        `7z archive CRC32 mismatch for ${relPath} (archive=${actual.crc32}, expected=${expected.crc32}).`,
      );
    }
  }
}

async function loadCachedBase(slotDir, arch, sevenZaVersion) {
  const baseArchivePath = Path.join(slotDir, "base.nsis.7z");
  const manifestPath = Path.join(slotDir, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest?.formatVersion !== CACHE_FORMAT_VERSION ||
      manifest?.arch !== arch ||
      manifest?.sevenZaVersion !== sevenZaVersion ||
      typeof manifest?.archiveSha256 !== "string" ||
      typeof manifest?.files !== "object" ||
      manifest.files === null
    ) {
      return null;
    }
    const actualArchiveSha = await sha256File(baseArchivePath);
    if (actualArchiveSha !== manifest.archiveSha256) {
      return null;
    }
    return { baseArchivePath, manifest };
  } catch {
    return null;
  }
}

function toSevenZipListPath(relPath) {
  return process.platform === "win32" ? relPath.replaceAll("/", "\\") : relPath;
}

async function saveStableBaseCache(input) {
  await mkdir(input.slotDir, { recursive: true });
  const cachedTmpArchive = Path.join(input.slotDir, `base.nsis.7z.${process.pid}.tmp`);
  const cachedFinalArchive = Path.join(input.slotDir, "base.nsis.7z");
  const cachedTmpManifest = Path.join(input.slotDir, `manifest.json.${process.pid}.tmp`);
  const cachedFinalManifest = Path.join(input.slotDir, "manifest.json");
  const archiveSha256 = await copyFileAndSha256(input.sourceArchivePath, cachedTmpArchive);
  const manifestObj = {
    formatVersion: CACHE_FORMAT_VERSION,
    arch: input.arch,
    sevenZaVersion: input.sevenZaVersion,
    archiveSha256,
    savedAt: new Date().toISOString(),
    emptyDirs: input.emptyDirs,
    files: Object.fromEntries(
      [...input.stableFiles.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await writeFile(cachedTmpManifest, `${JSON.stringify(manifestObj, null, 2)}\n`, "utf8");
  await rename(cachedTmpArchive, cachedFinalArchive);
  await rename(cachedTmpManifest, cachedFinalManifest);
}

async function addListedPathsToArchive(input) {
  if (input.paths.length === 0) return;
  const listPath = Path.join(input.workDir, input.listFileName);
  await writeFile(listPath, `${input.paths.map(toSevenZipListPath).join("\n")}\n`, "utf8");
  await run7za(
    input.sevenZaPath,
    [
      "a",
      "-bd",
      "-sccUTF-8",
      `-mx=${input.level}`,
      "-md=1m",
      "-mtc=off",
      "-ms=off",
      "-mtm=off",
      "-mta=off",
      input.archivePath,
      `@${listPath}`,
    ],
    input.appOutDir,
  );
}

export async function prepareCachedWindowsNsisArchive(input) {
  const startedAt = performance.now();
  const sevenZaPath = input.sevenZaPath ?? resolveSevenZaBinaryPath();
  const preCompressedExtensions =
    input.preCompressedExtensions ?? DEFAULT_NSIS_PRECOMPRESSED_EXTENSIONS;
  const incrementalLevel = validateCompressionDigit(input.compressionLevel, "1");
  const coldLevel = validateCompressionDigit(input.coldCompressionLevel, "5");
  const archKey = String(input.arch);
  const slotDir = Path.join(input.cacheDir, archKey);
  const archiveFilePath = Path.join(input.outDir, input.archiveFileName);
  const workDir = Path.join(input.outDir, `.moss-nsis-cache-${process.pid}-${Date.now()}`);
  const workArchivePath = Path.join(workDir, "work.nsis.7z");

  await mkdir(workDir, { recursive: true });
  try {
    const sevenZaVersion = await detectSevenZaVersion(sevenZaPath);
    const [scan, cached] = await Promise.all([
      scanAppOutDir(input.appOutDir, preCompressedExtensions),
      loadCachedBase(slotDir, archKey, sevenZaVersion),
    ]);

    /** @type {Map<string, { size: number, sha256: string, crc32: string }>} */
    const stableFiles = new Map();
    /** @type {Map<string, { size: number, sha256: string, crc32: string }>} */
    const volatileFiles = new Map();
    let stableTotalBytes = 0;
    let volatileTotalBytes = 0;

    for (const [relPath, info] of scan.files.entries()) {
      if (isVolatileArchivePath(relPath)) {
        volatileFiles.set(relPath, info);
        volatileTotalBytes += info.size;
      } else {
        stableFiles.set(relPath, info);
        stableTotalBytes += info.size;
      }
    }

    let mode = "cold";
    let reusedFiles = 0;
    let reusedBytes = 0;
    let updatedFiles = scan.files.size;
    let updatedBytes = scan.totalBytes;

    const hasStableEntries = stableFiles.size > 0 || scan.emptyDirs.length > 0;
    if (cached && hasStableEntries) {
      const prevFiles = cached.manifest.files;
      const removed = [];
      const changed = [];
      const added = [];
      let deltaStableBytes = 0;

      for (const prevPath of Object.keys(prevFiles)) {
        if (!stableFiles.has(prevPath)) {
          removed.push(prevPath);
        }
      }
      for (const [relPath, info] of stableFiles.entries()) {
        const prev = prevFiles[relPath];
        if (!prev) {
          added.push(relPath);
          deltaStableBytes += info.size;
        } else if (prev.size !== info.size || prev.sha256 !== info.sha256) {
          changed.push(relPath);
          deltaStableBytes += info.size;
        } else {
          reusedFiles += 1;
          reusedBytes += info.size;
        }
      }

      const prevEmptyDirs = new Set(
        Array.isArray(cached.manifest.emptyDirs) ? cached.manifest.emptyDirs : [],
      );
      const addedEmptyDirs = scan.emptyDirs.filter((dir) => !prevEmptyDirs.has(dir));
      const removedEmptyDirs = [...prevEmptyDirs].filter((dir) => !scan.emptyDirs.includes(dir));

      const shouldUseIncremental =
        stableTotalBytes === 0 || deltaStableBytes <= stableTotalBytes * FULL_REBUILD_RATIO;

      if (shouldUseIncremental) {
        await copyFile(cached.baseArchivePath, workArchivePath);
        const toDeleteStable = [...removed, ...changed, ...removedEmptyDirs];
        const toAddStable = [...changed, ...added, ...addedEmptyDirs];
        const stableMutated = toDeleteStable.length > 0 || toAddStable.length > 0;

        if (toDeleteStable.length > 0) {
          const deleteListPath = Path.join(workDir, "delete-stable.list");
          await writeFile(
            deleteListPath,
            `${toDeleteStable.map(toSevenZipListPath).join("\n")}\n`,
            "utf8",
          );
          await run7za(
            sevenZaPath,
            ["d", "-bd", "-sccUTF-8", workArchivePath, `@${deleteListPath}`],
            undefined,
          );
        }
        if (toAddStable.length > 0) {
          await addListedPathsToArchive({
            sevenZaPath,
            workDir,
            listFileName: "add-stable.list",
            paths: toAddStable,
            level: incrementalLevel,
            archivePath: workArchivePath,
            appOutDir: input.appOutDir,
          });
        }
        if (stableMutated) {
          await saveStableBaseCache({
            slotDir,
            arch: archKey,
            sevenZaVersion,
            sourceArchivePath: workArchivePath,
            emptyDirs: scan.emptyDirs,
            stableFiles,
          });
        }

        if (volatileFiles.size > 0) {
          await addListedPathsToArchive({
            sevenZaPath,
            workDir,
            listFileName: "add-volatile.list",
            paths: [...volatileFiles.keys()].toSorted(),
            level: incrementalLevel,
            archivePath: workArchivePath,
            appOutDir: input.appOutDir,
          });
        }

        updatedFiles = changed.length + added.length + volatileFiles.size;
        updatedBytes = deltaStableBytes + volatileTotalBytes;
        mode = !stableMutated && volatileFiles.size === 0 ? "exact-hit" : "incremental";
      } else {
        reusedFiles = 0;
        reusedBytes = 0;
      }
    }

    if (mode === "cold") {
      if (hasStableEntries) {
        await addListedPathsToArchive({
          sevenZaPath,
          workDir,
          listFileName: "cold-stable.list",
          paths: [...[...stableFiles.keys()].toSorted(), ...scan.emptyDirs],
          level: coldLevel,
          archivePath: workArchivePath,
          appOutDir: input.appOutDir,
        });
        await saveStableBaseCache({
          slotDir,
          arch: archKey,
          sevenZaVersion,
          sourceArchivePath: workArchivePath,
          emptyDirs: scan.emptyDirs,
          stableFiles,
        });
      }
      if (volatileFiles.size > 0) {
        await addListedPathsToArchive({
          sevenZaPath,
          workDir,
          listFileName: "cold-volatile.list",
          paths: [...volatileFiles.keys()].toSorted(),
          level: incrementalLevel,
          archivePath: workArchivePath,
          appOutDir: input.appOutDir,
        });
      }
    }

    await verifyArchiveMatchesFiles(sevenZaPath, workArchivePath, scan.files);

    const archiveStat = await stat(workArchivePath);
    const appDirStat = await stat(input.appOutDir);
    await rm(archiveFilePath, { force: true });
    await rename(workArchivePath, archiveFilePath);

    // app-builder-lib skips re-archiving when archiveFile.mtime > appOutDir.mtime.
    const freshTime = new Date(Math.max(Date.now(), appDirStat.mtimeMs) + 5_000);
    await utimes(archiveFilePath, freshTime, freshTime);

    return {
      mode,
      archiveFilePath,
      archiveBytes: archiveStat.size,
      totalFiles: scan.files.size,
      reusedFiles,
      reusedBytes,
      updatedFiles,
      updatedBytes,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
