// FILE: pack-tar.ts
// Purpose: Build the portable tar invocation used for server package archives.
// Layer: Release/build helper
// Exports: createPackTarCommandPlan

import path from "node:path";

export interface PackTarCommandPlanInput {
  readonly stagedPackageDir: string;
  readonly outDir: string;
  readonly tarballName: string;
  readonly patchedRuntimeDirectory?: string;
}

export function createPackTarCommandPlan(input: PackTarCommandPlanInput) {
  const relativeStagedPackageDir = path.relative(input.outDir, input.stagedPackageDir);
  const stagedPackagePath = path.isAbsolute(relativeStagedPackageDir)
    ? input.stagedPackageDir
    : relativeStagedPackageDir;

  return {
    args: [
      ...(path.isAbsolute(relativeStagedPackageDir) ? ["--force-local"] : []),
      "-czf",
      input.tarballName,
      "-C",
      stagedPackagePath,
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
      ...(input.patchedRuntimeDirectory ? [input.patchedRuntimeDirectory] : []),
    ],
    cwd: input.outDir,
  } as const;
}
