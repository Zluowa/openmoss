export type CanonicalFilesystemHelperTestArch = "arm64" | "x64";

export function resolveCanonicalFilesystemHelperTestArch(
  platform: NodeJS.Platform,
  arch: string,
): CanonicalFilesystemHelperTestArch | null {
  if (platform !== "darwin") return null;
  return arch === "arm64" || arch === "x64" ? arch : null;
}

export const canonicalFilesystemHelperTestArch = resolveCanonicalFilesystemHelperTestArch(
  process.platform,
  process.arch,
);
