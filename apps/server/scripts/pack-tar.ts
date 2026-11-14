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

const usesWindowsPathSyntax = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value);

export function createPackTarCommandPlan(input: PackTarCommandPlanInput) {
  // Tests and release tooling can pass Windows paths even when the plan is
  // evaluated on Linux (for example in the public mirror's Linux runner).
  // Select the path flavor from the inputs so drive-letter paths keep their
  // Windows volume semantics without changing how real POSIX paths are packed.
  const pathApi =
    usesWindowsPathSyntax(input.outDir) || usesWindowsPathSyntax(input.stagedPackageDir)
      ? path.win32
      : path.posix;
  const relativeStagedPackageDir = pathApi.relative(input.outDir, input.stagedPackageDir);
  const stagedPackagePath = pathApi.isAbsolute(relativeStagedPackageDir)
    ? input.stagedPackageDir
    : relativeStagedPackageDir;

  return {
    args: [
      ...(pathApi.isAbsolute(relativeStagedPackageDir) ? ["--force-local"] : []),
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
