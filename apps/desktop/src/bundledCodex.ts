// FILE: bundledCodex.ts
// Purpose: Locates and validates the public Codex runtime shipped with packaged Moss builds.
// Layer: Electron main-process runtime discovery

import * as FS from "node:fs";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { probeBundledRuntimeVersion } from "./bundledRuntimeVersion";

import {
  formatBundledCodexExecutableVersionMismatch,
  MOSS_BUNDLED_CODEX_ERROR_ENV_KEY,
  MOSS_BUNDLED_CODEX_PATH_ENV_KEY,
  MOSS_BUNDLED_CODEX_VERSION,
  parseCodexExecutableVersion,
  resolveCodexRuntimeTarget,
  type CodexRuntimeTarget,
} from "@synara/shared/codexRuntime";

export { MOSS_BUNDLED_CODEX_PATH_ENV_KEY };

interface CodexPackageManifest {
  readonly layoutVersion: number;
  readonly version: string;
  readonly target: string;
  readonly variant: string;
  readonly entrypoint: string;
  readonly resourcesDir: string;
  readonly pathDir: string;
}
type BundledCodexExecutableVersionProbeResult =
  | { readonly ok: true; readonly output: string }
  | {
      readonly ok: false;
      readonly message: string;
      readonly reason?: "timeout" | "access-denied" | "missing" | "spawn-failed" | "nonzero-exit";
    };

interface BundledCodexResolutionDependencies {
  readonly probeExecutableVersion?: (
    binaryPath: string,
  ) => BundledCodexExecutableVersionProbeResult;
}

const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;

function probeExecutableVersion(binaryPath: string): BundledCodexExecutableVersionProbeResult {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      message: result.error.message || String(result.error),
      reason:
        code === "ETIMEDOUT"
          ? "timeout"
          : code === "EACCES" || code === "EPERM"
            ? "access-denied"
            : code === "ENOENT"
              ? "missing"
              : "spawn-failed",
    };
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "nonzero-exit",
      message: stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`,
    };
  }
  return { ok: true, output: `${stdout}\n${stderr}` };
}

export type BundledCodexResolution =
  | {
      readonly ok: true;
      readonly binaryPath: string;
      readonly version: string;
      readonly target: CodexRuntimeTarget;
    }
  | {
      readonly ok: false;
      readonly code:
        | "unsupported-target"
        | "missing-runtime"
        | "invalid-manifest"
        | "version-mismatch"
        | "invalid-layout"
        | "invalid-entrypoint"
        | "executable-version-unavailable"
        | "executable-version-mismatch";
      readonly message: string;
    };

interface BundledCodexVendorCandidate {
  readonly authorityRoot?: string;
  readonly vendorRoot: string;
}

function vendorCandidates(
  resourcesPath: string,
  target: CodexRuntimeTarget,
): BundledCodexVendorCandidate[] {
  const unpackedNodeModules = Path.join(resourcesPath, "app.asar.unpacked", "node_modules");
  const packageLeaf = target.packageName.slice("@openai/".length);
  const copiedRuntimeRoot = Path.join(resourcesPath, "codex-runtime");
  return [
    {
      authorityRoot: copiedRuntimeRoot,
      vendorRoot: Path.join(copiedRuntimeRoot, target.targetTriple),
    },
    {
      vendorRoot: Path.join(
        unpackedNodeModules,
        "@openai",
        packageLeaf,
        "vendor",
        target.targetTriple,
      ),
    },
    {
      vendorRoot: Path.join(
        unpackedNodeModules,
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        packageLeaf,
        "vendor",
        target.targetTriple,
      ),
    },
  ];
}

function pathExists(path: string): boolean {
  try {
    FS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isPlainDirectory(path: string): boolean {
  try {
    const stat = FS.lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPlainFile(path: string): boolean {
  try {
    const stat = FS.lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isExecutablePlainFile(path: string, platform: NodeJS.Platform): boolean {
  if (!isPlainFile(path)) return false;
  try {
    FS.accessSync(path, platform === "win32" ? FS.constants.F_OK : FS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readManifest(manifestPath: string): CodexPackageManifest | null {
  try {
    const parsed = JSON.parse(
      FS.readFileSync(manifestPath, "utf8"),
    ) as Partial<CodexPackageManifest>;
    if (
      parsed.layoutVersion !== 1 ||
      typeof parsed.version !== "string" ||
      typeof parsed.target !== "string" ||
      parsed.variant !== "codex" ||
      typeof parsed.entrypoint !== "string" ||
      typeof parsed.resourcesDir !== "string" ||
      typeof parsed.pathDir !== "string"
    ) {
      return null;
    }
    return parsed as CodexPackageManifest;
  } catch {
    return null;
  }
}

function reinstallMessage(targetLabel: string): string {
  return `Bundled Codex runtime for ${targetLabel} is unavailable. Reinstall Moss with a supported artifact; Moss did not change your Codex configuration.`;
}

function resolveBundledCodexLayout(input: {
  readonly resourcesPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): BundledCodexResolution {
  const target = resolveCodexRuntimeTarget({ platform: input.platform, arch: input.arch });
  if (!target) {
    return {
      ok: false,
      code: "unsupported-target",
      message: `Moss has no bundled Codex runtime for ${input.platform}/${input.arch}. Install a supported Moss build or configure a trusted Codex binary explicitly.`,
    };
  }

  for (const candidate of vendorCandidates(input.resourcesPath, target)) {
    const { vendorRoot } = candidate;
    const manifestPath = Path.join(vendorRoot, "codex-package.json");
    const binaryPath = Path.join(vendorRoot, "bin", target.executableName);
    const candidateExists =
      (candidate.authorityRoot !== undefined && pathExists(candidate.authorityRoot)) ||
      pathExists(vendorRoot) ||
      pathExists(manifestPath) ||
      pathExists(binaryPath);
    if (!candidateExists) continue;

    if (
      (candidate.authorityRoot !== undefined && !isPlainDirectory(candidate.authorityRoot)) ||
      !isPlainDirectory(vendorRoot)
    ) {
      return {
        ok: false,
        code: "invalid-layout",
        message: `${reinstallMessage(`${input.platform}/${input.arch}`)} Its runtime directory is invalid.`,
      };
    }

    if (!isPlainFile(manifestPath)) {
      return {
        ok: false,
        code: "invalid-manifest",
        message: `${reinstallMessage(`${input.platform}/${input.arch}`)} Its version manifest is invalid.`,
      };
    }
    const manifest = readManifest(manifestPath);
    if (!manifest) {
      return {
        ok: false,
        code: "invalid-manifest",
        message: `${reinstallMessage(`${input.platform}/${input.arch}`)} Its version manifest is invalid.`,
      };
    }
    if (manifest.version !== MOSS_BUNDLED_CODEX_VERSION) {
      return {
        ok: false,
        code: "version-mismatch",
        message: `Bundled Codex version mismatch: Moss expected ${MOSS_BUNDLED_CODEX_VERSION} but found ${manifest.version}. Reinstall Moss before using this runtime.`,
      };
    }
    if (
      manifest.target !== target.targetTriple ||
      manifest.entrypoint !== `bin/${target.executableName}` ||
      manifest.resourcesDir !== "codex-resources" ||
      manifest.pathDir !== "codex-path"
    ) {
      return {
        ok: false,
        code: "invalid-manifest",
        message: `${reinstallMessage(`${input.platform}/${input.arch}`)} The runtime manifest does not match this artifact.`,
      };
    }

    if (!isExecutablePlainFile(binaryPath, input.platform)) {
      return {
        ok: false,
        code: "invalid-entrypoint",
        message: `${reinstallMessage(`${input.platform}/${input.arch}`)} The Codex entrypoint is not executable.`,
      };
    }

    const executableSuffix = input.platform === "win32" ? ".exe" : "";
    const requiredExecutableSidecars = [
      Path.join(vendorRoot, "bin", `codex-code-mode-host${executableSuffix}`),
      Path.join(vendorRoot, "codex-path", `rg${executableSuffix}`),
    ];
    const requiredResourcesDirectory = Path.join(vendorRoot, "codex-resources");
    if (
      requiredExecutableSidecars.some(
        (sidecarPath) => !isExecutablePlainFile(sidecarPath, input.platform),
      ) ||
      !isPlainDirectory(requiredResourcesDirectory)
    ) {
      return {
        ok: false,
        code: "invalid-layout",
        message: `${reinstallMessage(`${input.platform}/${input.arch}`)} Its required runtime files are incomplete or invalid.`,
      };
    }

    return {
      ok: true,
      binaryPath,
      version: manifest.version,
      target,
    };
  }

  return {
    ok: false,
    code: "missing-runtime",
    message: reinstallMessage(`${input.platform}/${input.arch}`),
  };
}

function validateExecutableVersion(
  resolution: Extract<BundledCodexResolution, { ok: true }>,
  versionProbe: BundledCodexExecutableVersionProbeResult,
): BundledCodexResolution {
  const label = `${resolution.target.platform}/${resolution.target.arch}`;
  if (!versionProbe.ok) {
    return {
      ok: false,
      code: "executable-version-unavailable",
      message: `${reinstallMessage(label)} The Codex executable version probe failed${
        ["timeout", "access-denied", "missing", "spawn-failed", "nonzero-exit"].includes(
          versionProbe.reason ?? "",
        )
          ? ` (${versionProbe.reason})`
          : ""
      }.`,
    };
  }
  const version = parseCodexExecutableVersion(versionProbe.output);
  if (!version) {
    return {
      ok: false,
      code: "executable-version-unavailable",
      message: `${reinstallMessage(label)} The Codex executable returned an unrecognized version.`,
    };
  }
  return version === MOSS_BUNDLED_CODEX_VERSION
    ? resolution
    : {
        ok: false,
        code: "executable-version-mismatch",
        message: formatBundledCodexExecutableVersionMismatch(version),
      };
}

export function resolveBundledCodexBinary(
  input: Parameters<typeof resolveBundledCodexLayout>[0],
  dependencies: BundledCodexResolutionDependencies = {},
): BundledCodexResolution {
  const resolution = resolveBundledCodexLayout(input);
  return resolution.ok
    ? validateExecutableVersion(
        resolution,
        (dependencies.probeExecutableVersion ?? probeExecutableVersion)(resolution.binaryPath),
      )
    : resolution;
}

export async function resolveBundledCodexBinaryAsync(
  input: Parameters<typeof resolveBundledCodexLayout>[0],
  dependencies: {
    readonly probeExecutableVersion?: (
      binaryPath: string,
    ) => Promise<BundledCodexExecutableVersionProbeResult>;
  } = {},
): Promise<BundledCodexResolution> {
  const resolution = resolveBundledCodexLayout(input);
  if (!resolution.ok) return resolution;
  const probe = await (dependencies.probeExecutableVersion ?? probeBundledRuntimeVersion)(
    resolution.binaryPath,
  );
  // Recheck the package after the asynchronous boundary; no stale path or manifest is accepted.
  const current = resolveBundledCodexLayout(input);
  if (!current.ok) return current;
  if (current.binaryPath !== resolution.binaryPath) {
    return {
      ok: false,
      code: "invalid-layout",
      message: reinstallMessage(`${input.platform}/${input.arch}`),
    };
  }
  return validateExecutableVersion(current, probe);
}

export function toBundledCodexBackendEnv(resolution: BundledCodexResolution): NodeJS.ProcessEnv {
  return resolution.ok
    ? { [MOSS_BUNDLED_CODEX_PATH_ENV_KEY]: resolution.binaryPath }
    : { [MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]: resolution.message };
}
