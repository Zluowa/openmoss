// FILE: bundled-codex-runtime.ts
// Purpose: Selects, validates, copies, and prunes the pinned public Codex runtime.
// Layer: Release/build helper

import * as FS from "node:fs";
import * as Path from "node:path";

import {
  MOSS_BUNDLED_CODEX_VERSION,
  resolveCodexRuntimeTarget,
  type CodexRuntimeTarget,
} from "@synara/shared/codexRuntime";

export const BUNDLED_CODEX_VERSION = MOSS_BUNDLED_CODEX_VERSION;
export const BUNDLED_CODEX_PACKAGE_NAME = "@openai/codex";
export const BUNDLED_CODEX_RUNTIME_DIR = "apps/desktop/codex-runtime";
export const BUNDLED_CODEX_EXTRA_RESOURCE = {
  from: BUNDLED_CODEX_RUNTIME_DIR,
  to: "codex-runtime",
} as const;

type DesktopBuildPlatform = "linux" | "mac" | "win";
type DesktopBuildArch = "arm64" | "x64" | "universal";

export interface BundledCodexInstallTarget {
  readonly os: "darwin" | "linux" | "win32";
  readonly cpu: "arm64" | "x64" | "*";
}

export interface BundledCodexTarget extends CodexRuntimeTarget {
  readonly packageFolder: string;
  readonly executable: string;
  readonly codeModeHost: string;
  readonly ripgrep: string;
}

export interface ResolvedBundledCodexRuntime {
  readonly sourceDir: string;
  readonly target: BundledCodexTarget;
}

export interface PrunedBundledCodexBuildPackages {
  readonly removedPaths: ReadonlyArray<string>;
  readonly preservedRuntimeDir: string;
}

export function resolveBundledCodexInstallTarget(input: {
  readonly platform: DesktopBuildPlatform;
  readonly arch: DesktopBuildArch;
}): BundledCodexInstallTarget {
  const os = input.platform === "mac" ? "darwin" : input.platform === "win" ? "win32" : "linux";
  return {
    os,
    cpu: input.arch === "universal" ? "*" : input.arch,
  };
}

function toBundledCodexTarget(target: CodexRuntimeTarget): BundledCodexTarget {
  const executableSuffix = target.platform === "win32" ? ".exe" : "";
  return {
    ...target,
    packageFolder: target.packageName.slice("@openai/".length),
    executable: target.executableName,
    codeModeHost: `codex-code-mode-host${executableSuffix}`,
    ripgrep: `rg${executableSuffix}`,
  };
}

export function resolveBundledCodexTargets(input: {
  readonly platform: DesktopBuildPlatform;
  readonly arch: DesktopBuildArch;
}): ReadonlyArray<BundledCodexTarget> {
  if (input.arch === "universal" && input.platform !== "mac") {
    throw new Error(`Universal Codex runtime is unsupported for ${input.platform}.`);
  }
  const installTarget = resolveBundledCodexInstallTarget(input);
  const arches = input.arch === "universal" ? (["arm64", "x64"] as const) : [input.arch];
  return arches.map((arch) => {
    const target = resolveCodexRuntimeTarget({ platform: installTarget.os, arch });
    if (!target) {
      throw new Error(
        `No pinned Codex npm runtime target exists for ${input.platform}/${input.arch} (${installTarget.os}/${arch}).`,
      );
    }
    return toBundledCodexTarget(target);
  });
}

export function resolveBundledCodexStageOptionalDependencies(input: {
  readonly platform: DesktopBuildPlatform;
  readonly arch: DesktopBuildArch;
}): Record<string, string> {
  return Object.fromEntries(
    resolveBundledCodexTargets(input).map((target) => [
      target.packageName,
      target.npmAliasSpecifier,
    ]),
  );
}

function allSupportedTargets(): ReadonlyArray<BundledCodexTarget> {
  return [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ].map(([platform, arch]) => {
    const target = resolveCodexRuntimeTarget({
      platform: platform as NodeJS.Platform,
      arch: arch!,
    });
    if (!target) throw new Error(`Missing shared Codex target for ${platform}/${arch}.`);
    return toBundledCodexTarget(target);
  });
}

function packageRoots(nodeModulesDir: string, target: CodexRuntimeTarget): string[] {
  const packageLeaf = target.packageName.slice("@openai/".length);
  const mainPackageRoot = Path.join(nodeModulesDir, "@openai", "codex");
  let bunOptionalPackageRoot: string | null = null;
  try {
    bunOptionalPackageRoot = Path.join(Path.dirname(FS.realpathSync(mainPackageRoot)), packageLeaf);
  } catch {
    // Missing launcher package is reported with the complete candidate list below.
  }
  return [
    Path.join(nodeModulesDir, "@openai", packageLeaf),
    Path.join(mainPackageRoot, "node_modules", "@openai", packageLeaf),
    ...(bunOptionalPackageRoot ? [bunOptionalPackageRoot] : []),
  ];
}

function requirePlainRuntimeDirectory(path: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(path);
  } catch {
    throw new Error(`Staged bundled Codex runtime is incomplete: missing ${label}.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Staged bundled Codex runtime is invalid: ${label} must be a plain directory.`);
  }
}

function requirePlainRuntimeFile(path: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(path);
  } catch {
    throw new Error(`Staged bundled Codex runtime is incomplete: missing ${label}.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Staged bundled Codex runtime is invalid: ${label} must be a plain file.`);
  }
}

interface CodexPackageManifest {
  readonly layoutVersion?: unknown;
  readonly version?: unknown;
  readonly target?: unknown;
  readonly variant?: unknown;
  readonly entrypoint?: unknown;
  readonly resourcesDir?: unknown;
  readonly pathDir?: unknown;
}

function validateVendorRoot(vendorRoot: string, target: CodexRuntimeTarget) {
  // Cross-platform artifact builds may stage a foreign target, so immutable
  // metadata and file shape are verified here without executing that binary.
  // The desktop runtime resolver executes --version on the selected native
  // entrypoint before making it available to the server.
  requirePlainRuntimeDirectory(vendorRoot, target.targetTriple);
  const manifestPath = Path.join(vendorRoot, "codex-package.json");
  requirePlainRuntimeFile(manifestPath, `${target.targetTriple}/codex-package.json`);

  let manifest: CodexPackageManifest;
  try {
    manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as CodexPackageManifest;
  } catch (cause) {
    throw new Error(`Staged bundled Codex manifest for ${target.targetTriple} is not valid JSON.`, {
      cause,
    });
  }
  if (manifest.version !== MOSS_BUNDLED_CODEX_VERSION) {
    throw new Error(
      `Bundled Codex version mismatch: expected ${MOSS_BUNDLED_CODEX_VERSION}, found ${String(manifest.version)}.`,
    );
  }
  if (
    manifest.layoutVersion !== 1 ||
    manifest.target !== target.targetTriple ||
    manifest.variant !== "codex" ||
    manifest.entrypoint !== `bin/${target.executableName}` ||
    manifest.resourcesDir !== "codex-resources" ||
    manifest.pathDir !== "codex-path"
  ) {
    throw new Error(`Bundled Codex manifest does not match target ${target.targetTriple}.`);
  }

  const executableSuffix = target.platform === "win32" ? ".exe" : "";
  const binaryPath = Path.join(vendorRoot, "bin", target.executableName);
  requirePlainRuntimeFile(binaryPath, `${target.targetTriple}/bin/${target.executableName}`);
  requirePlainRuntimeFile(
    Path.join(vendorRoot, "bin", `codex-code-mode-host${executableSuffix}`),
    `${target.targetTriple}/bin/codex-code-mode-host${executableSuffix}`,
  );
  requirePlainRuntimeFile(
    Path.join(vendorRoot, "codex-path", `rg${executableSuffix}`),
    `${target.targetTriple}/codex-path/rg${executableSuffix}`,
  );
  requirePlainRuntimeDirectory(
    Path.join(vendorRoot, "codex-resources"),
    `${target.targetTriple}/codex-resources`,
  );

  return { vendorRoot, binaryPath };
}

function validateTarget(nodeModulesDir: string, target: CodexRuntimeTarget) {
  const packageRoot = packageRoots(nodeModulesDir, target).find((candidate) =>
    FS.existsSync(Path.join(candidate, "vendor", target.targetTriple)),
  );
  if (!packageRoot) {
    throw new Error(
      `Staged bundled Codex runtime is missing ${target.packageName}@${MOSS_BUNDLED_CODEX_VERSION} for ${target.targetTriple}.`,
    );
  }
  const validated = validateVendorRoot(
    Path.join(packageRoot, "vendor", target.targetTriple),
    target,
  );
  return { ...target, packageRoot, ...validated };
}

function validateCopiedTarget(resourcesDir: string, target: CodexRuntimeTarget) {
  const runtimeRoot = Path.join(resourcesDir, "codex-runtime");
  requirePlainRuntimeDirectory(runtimeRoot, "codex-runtime");
  const validated = validateVendorRoot(Path.join(runtimeRoot, target.targetTriple), target);
  return { ...target, packageRoot: runtimeRoot, ...validated };
}

export function resolveBundledCodexRuntime(input: {
  readonly stageAppDir: string;
  readonly target: BundledCodexTarget;
}): ResolvedBundledCodexRuntime {
  const validated = validateTarget(Path.join(input.stageAppDir, "node_modules"), input.target);
  return { sourceDir: validated.vendorRoot, target: input.target };
}

function pathExists(path: string): boolean {
  try {
    FS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readStagedPackageJson(stageAppDir: string): Record<string, unknown> {
  const packageJsonPath = Path.join(stageAppDir, "package.json");
  try {
    return JSON.parse(FS.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error("Could not read the staged package.json while pruning bundled Codex.", {
      cause,
    });
  }
}

export function pruneBundledCodexBuildPackages(input: {
  readonly stageAppDir: string;
}): PrunedBundledCodexBuildPackages {
  const packageJsonPath = Path.join(input.stageAppDir, "package.json");
  const packageJson = readStagedPackageJson(input.stageAppDir);
  const dependencies = packageJson.dependencies;
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    (dependencies as Record<string, unknown>)[BUNDLED_CODEX_PACKAGE_NAME] !==
      MOSS_BUNDLED_CODEX_VERSION
  ) {
    throw new Error(
      `Expected staged ${BUNDLED_CODEX_PACKAGE_NAME} dependency ${MOSS_BUNDLED_CODEX_VERSION} before pruning.`,
    );
  }

  const supportedTargets = allSupportedTargets();
  const optionalDependencies = packageJson.optionalDependencies;
  if (
    typeof optionalDependencies !== "object" ||
    optionalDependencies === null ||
    Array.isArray(optionalDependencies)
  ) {
    throw new Error("Expected staged pinned Codex optional dependencies before pruning.");
  }
  const optionalDependencyRecord = optionalDependencies as Record<string, unknown>;
  const declaredCodexOptionalPackages = Object.keys(optionalDependencyRecord).filter((name) =>
    name.startsWith("@openai/codex-"),
  );
  const expectedTargets = supportedTargets.filter(
    (target) => optionalDependencyRecord[target.packageName] === target.npmAliasSpecifier,
  );
  if (
    expectedTargets.length === 0 ||
    expectedTargets.length !== declaredCodexOptionalPackages.length
  ) {
    throw new Error(
      "Staged Codex optional dependencies do not exactly match the pinned copied runtime targets.",
    );
  }

  const preservedRuntimeDir = Path.join(input.stageAppDir, BUNDLED_CODEX_RUNTIME_DIR);
  const preservedRuntimeTargets = pathExists(preservedRuntimeDir)
    ? FS.readdirSync(preservedRuntimeDir).toSorted()
    : [];
  const expectedRuntimeTargets = expectedTargets.map((target) => target.targetTriple).toSorted();
  if (JSON.stringify(preservedRuntimeTargets) !== JSON.stringify(expectedRuntimeTargets)) {
    throw new Error(
      `Refusing to prune @openai/codex before its validated runtime has been copied to extraResources (expected ${expectedRuntimeTargets.join(", ")}; found ${preservedRuntimeTargets.join(", ") || "none"}).`,
    );
  }
  for (const target of expectedTargets) {
    validateVendorRoot(Path.join(preservedRuntimeDir, target.targetTriple), target);
  }

  const nodeModulesDir = Path.join(input.stageAppDir, "node_modules");
  const candidatePaths = new Set<string>([
    Path.join(nodeModulesDir, "@openai", "codex"),
    ...supportedTargets.map((target) =>
      Path.join(nodeModulesDir, "@openai", target.packageName.slice("@openai/".length)),
    ),
    Path.join(nodeModulesDir, ".bin", "codex"),
    Path.join(nodeModulesDir, ".bin", "codex.cmd"),
    Path.join(nodeModulesDir, ".bin", "codex.ps1"),
  ]);
  const bunStoreDir = Path.join(nodeModulesDir, ".bun");
  if (pathExists(bunStoreDir)) {
    const pinnedBunPackageEntry = `@openai+codex@${MOSS_BUNDLED_CODEX_VERSION}`;
    for (const entry of FS.readdirSync(bunStoreDir)) {
      if (entry === pinnedBunPackageEntry || entry.startsWith(`${pinnedBunPackageEntry}-`)) {
        candidatePaths.add(Path.join(bunStoreDir, entry));
      }
    }
  }

  const removedPaths: string[] = [];
  for (const candidatePath of candidatePaths) {
    if (!pathExists(candidatePath)) continue;
    FS.rmSync(candidatePath, { recursive: true, force: true });
    removedPaths.push(candidatePath);
  }
  const remainingPaths = [...candidatePaths].filter(pathExists);
  if (remainingPaths.length > 0) {
    throw new Error(`Bundled Codex build packages remain staged: ${remainingPaths.join(", ")}.`);
  }

  const nextDependencies = { ...(dependencies as Record<string, unknown>) };
  delete nextDependencies[BUNDLED_CODEX_PACKAGE_NAME];
  const nextOptionalDependencies = { ...optionalDependencyRecord };
  for (const target of supportedTargets) {
    delete nextOptionalDependencies[target.packageName];
  }
  FS.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(
      {
        ...packageJson,
        dependencies: nextDependencies,
        optionalDependencies: nextOptionalDependencies,
      },
      null,
      2,
    )}\n`,
  );

  for (const target of expectedRuntimeTargets) {
    if (!pathExists(Path.join(preservedRuntimeDir, target))) {
      throw new Error(`Pruning build packages removed copied Codex runtime ${target}.`);
    }
  }

  return { preservedRuntimeDir, removedPaths };
}

export function validateStagedBundledCodexRuntime(input: {
  readonly nodeModulesDir: string;
  readonly platform: DesktopBuildPlatform;
  readonly arch: DesktopBuildArch;
}) {
  return {
    version: MOSS_BUNDLED_CODEX_VERSION,
    targets: resolveBundledCodexTargets(input).map((target) =>
      validateTarget(input.nodeModulesDir, target),
    ),
  };
}

export function validatePackagedBundledCodexRuntime(input: {
  readonly resourcesDir: string;
  readonly platform: DesktopBuildPlatform;
  readonly arch: DesktopBuildArch;
}) {
  return {
    version: MOSS_BUNDLED_CODEX_VERSION,
    targets: resolveBundledCodexTargets(input).map((target) =>
      validateCopiedTarget(input.resourcesDir, target),
    ),
  };
}

function findPackagedResourcesDirectories(stageDistDir: string): string[] {
  const resourcesDirectories: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (FS.existsSync(Path.join(directory, "codex-runtime"))) {
      resourcesDirectories.push(directory);
      return;
    }
    if (depth >= 6) return;

    let entries: FS.Dirent[];
    try {
      entries = FS.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(Path.join(directory, entry.name), depth + 1);
    }
  };
  visit(stageDistDir, 0);
  return resourcesDirectories;
}

export function validateBuiltBundledCodexRuntime(input: {
  readonly stageDistDir: string;
  readonly platform: DesktopBuildPlatform;
  readonly arch: DesktopBuildArch;
}) {
  const resourcesDirectories = findPackagedResourcesDirectories(input.stageDistDir);
  if (resourcesDirectories.length !== 1) {
    throw new Error(
      `Expected one packaged copied Codex runtime tree, found ${resourcesDirectories.length}.`,
    );
  }
  const resourcesDir = resourcesDirectories[0]!;
  return {
    ...validatePackagedBundledCodexRuntime({
      resourcesDir,
      platform: input.platform,
      arch: input.arch,
    }),
    resourcesDir,
  };
}
