// FILE: windows-nsis-archive-cache-after-sign.mjs
// Purpose: Optional electron-builder afterSign hook that populates the NSIS .nsis.7z archive
//          incrementally from MOSS_WINDOWS_NSIS_ARCHIVE_CACHE with full CRC32/size verification.

import {
  DEFAULT_NSIS_PRECOMPRESSED_EXTENSIONS,
  prepareCachedWindowsNsisArchive,
  resolveWindowsNsisArchiveCacheDir,
  WINDOWS_NSIS_ARCHIVE_CACHE_LEVEL_ENV,
} from "./lib/windows-nsis-archive-cache.mjs";

const ARCH_NAMES = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

function resolveArchName(arch) {
  if (typeof arch === "string" && arch.trim()) return arch.trim();
  const mapped = ARCH_NAMES[arch];
  if (!mapped) throw new Error(`Unsupported electron-builder arch value: ${String(arch)}`);
  return mapped;
}

export default async function windowsNsisArchiveCacheAfterSign(context) {
  const cacheDir = resolveWindowsNsisArchiveCacheDir(process.env);
  if (!cacheDir) return;
  if (context?.electronPlatformName !== "win32") return;

  const packager = context.packager;
  if (!packager || packager.compression === "store") return;

  const targets = Array.isArray(context.targets) ? context.targets : [];
  const nsisTarget = targets.find((target) => target?.name === "nsis");
  if (!nsisTarget) return;
  if (nsisTarget.isBuildDifferentialAware === false || nsisTarget.options?.useZip) return;

  const archName = resolveArchName(context.arch);
  const sanitizedName = packager.appInfo?.sanitizedName;
  const version = packager.appInfo?.version;
  if (!sanitizedName || !version) return;

  const archiveFileName = `${sanitizedName}-${version}-${archName}.nsis.7z`;
  const preCompressedExtensions =
    typeof nsisTarget.getPreCompressedFileExtensions === "function"
      ? (nsisTarget.getPreCompressedFileExtensions() ?? [])
      : DEFAULT_NSIS_PRECOMPRESSED_EXTENSIONS;

  try {
    const result = await prepareCachedWindowsNsisArchive({
      appOutDir: context.appOutDir,
      outDir: context.outDir,
      archiveFileName,
      arch: archName,
      cacheDir,
      compressionLevel: process.env[WINDOWS_NSIS_ARCHIVE_CACHE_LEVEL_ENV],
      coldCompressionLevel: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL,
      preCompressedExtensions,
    });
    const toMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    console.log(
      `[nsis-archive-cache] ${result.mode} archive ready in ${(result.durationMs / 1000).toFixed(1)}s: ${result.archiveFilePath} (${toMb(result.archiveBytes)}; reused ${result.reusedFiles} files / ${toMb(result.reusedBytes)}, updated ${result.updatedFiles} files / ${toMb(result.updatedBytes)}, verified ${result.totalFiles}/${result.totalFiles} CRC32).`,
    );
  } catch (error) {
    // Never fail or emit a half-written archive: fall back cleanly to electron-builder's own 7za pass.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[nsis-archive-cache] Falling back to full electron-builder archive build: ${message}`,
    );
  }
}
