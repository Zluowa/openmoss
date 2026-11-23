// FILE: windows-nsis-archive-cache.d.mts
// Purpose: Type declarations for windows-nsis-archive-cache.mjs.

export const WINDOWS_NSIS_ARCHIVE_CACHE_ENV: "MOSS_WINDOWS_NSIS_ARCHIVE_CACHE";
export const WINDOWS_NSIS_ARCHIVE_CACHE_LEVEL_ENV: "MOSS_WINDOWS_NSIS_ARCHIVE_CACHE_LEVEL";
export const DEFAULT_NSIS_PRECOMPRESSED_EXTENSIONS: ReadonlyArray<string>;

export function resolveWindowsNsisArchiveCacheDir(
  env?: Readonly<Record<string, string | undefined>>,
): string | undefined;

export function resolveSevenZaBinaryPath(): string;

export function parse7zTechnicalListing(
  output: string,
): Map<string, { readonly size: number; readonly crc32: string }>;

export interface PrepareCachedWindowsNsisArchiveResult {
  readonly mode: "cold" | "incremental" | "exact-hit";
  readonly archiveFilePath: string;
  readonly archiveBytes: number;
  readonly totalFiles: number;
  readonly reusedFiles: number;
  readonly reusedBytes: number;
  readonly updatedFiles: number;
  readonly updatedBytes: number;
  readonly durationMs: number;
}

export function prepareCachedWindowsNsisArchive(input: {
  readonly appOutDir: string;
  readonly outDir: string;
  readonly archiveFileName: string;
  readonly arch: string;
  readonly cacheDir: string;
  readonly sevenZaPath?: string;
  readonly compressionLevel?: string;
  readonly coldCompressionLevel?: string;
  readonly preCompressedExtensions?: ReadonlyArray<string>;
}): Promise<PrepareCachedWindowsNsisArchiveResult>;
