#!/usr/bin/env node
// FILE: build-desktop-artifact.ts
// Purpose: Stages and builds packaged desktop artifacts plus updater metadata for GitHub releases.
// Layer: Release/build script
// Depends on: apps/desktop package metadata, electron-builder, and GitHub release config.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import committedDesktopStageInstallPackageJson from "./desktop-stage-lock/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import {
  BUNDLED_CLAUDE_EXTRA_RESOURCE,
  BUNDLED_CLAUDE_AGENT_SDK_VERSION,
  BUNDLED_CLAUDE_CODE_VERSION,
  BUNDLED_CLAUDE_RUNTIME_DIR,
  createBundledClaudeReleaseVerificationReceipt,
  pruneBundledClaudeNativePackages,
  resolveBundledClaudeRuntime,
  resolveBundledClaudeTargets,
  type ResolvedBundledClaudeRuntime,
} from "./lib/bundled-claude-runtime.ts";
import {
  BUNDLED_CODEX_EXTRA_RESOURCE,
  BUNDLED_CODEX_PACKAGE_NAME,
  BUNDLED_CODEX_RUNTIME_DIR,
  pruneBundledCodexBuildPackages,
  resolveBundledCodexInstallTarget,
  resolveBundledCodexRuntime,
  resolveBundledCodexStageOptionalDependencies,
  resolveBundledCodexTargets,
  validateBuiltBundledCodexRuntime,
  validateStagedBundledCodexRuntime,
} from "./lib/bundled-codex-runtime.ts";
import { MOSS_CANVAS_BUNDLE_DIR, MOSS_CANVAS_EXTRA_RESOURCE } from "./lib/bundled-moss-canvas.ts";
import { verifyPackagedAsarIntegrity } from "./lib/mac-asar-integrity.mjs";
import {
  readMossCanvasSourcePin,
  validatePinnedMossCanvasBundle,
} from "./lib/moss-canvas-source-pin.ts";
import {
  assertBundledCodexReleaseApproved,
  BUNDLED_CODEX_COMPLIANCE_EXTRA_RESOURCE,
  BUNDLED_CODEX_COMPLIANCE_STAGE_ASAR_EXCLUSION,
  copyBundledCodexReleaseArtifactsAndWriteReceipt,
  shouldRunBundledCodexLinuxPublicRuntimeProbes,
  stageBundledCodexComplianceBundle,
  validateBundledCodexLinuxX64PublicRuntime,
  verifyFinalBundledCodexLinuxAppImage,
  verifyFinalBundledClaudeMacArtifacts,
  verifyFinalBundledCodexMacArtifacts,
  verifyFinalBundledCodexWindowsInstaller,
  validatePackagedBundledCodexComplianceBundle,
  validateSignedBundledCodexPayloadIntegrity,
  validateStagedBundledCodexPayloadIntegrity,
  verifyBundledCodexLinuxLauncherIdentity,
  verifyBundledCodexReleaseReceipt,
  verifyPackagedBundledCodexMacBuildOnlySignatures,
  verifyPackagedBundledCodexMacCodeSignature,
  verifyPackagedBundledCodexWindowsAuthenticode,
} from "./lib/bundled-codex-release-compliance.ts";
import {
  DESKTOP_RELEASE_MODES,
  type DesktopReleaseMode,
  requiresMacUpdateManifest,
  validateWindowsSigningEnvironment,
  validateDesktopReleaseBuildPolicy,
} from "./lib/desktop-release-build-policy.ts";
import {
  createElectronBuilderEnvironment,
  createMacBuildOnlySigningEnvironment,
  createDesktopBuildSubprocessEnvironment,
  createNonSigningSubprocessEnvironment,
} from "./lib/desktop-signing-environment.ts";
import {
  assertDesktopStageInstallPackageMatches,
  createDesktopStageInstallPackageJson,
  DESKTOP_STAGE_LOCK_DIRECTORY,
} from "./lib/desktop-stage-lock.ts";
import {
  AUTH_CALLBACK_PROTOCOL_CONFIG,
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH,
  resolveDesktopBuilderCliTargets,
  MAC_DEVICE_HELPER_RESOURCE_PATH,
  validateDesktopNativeBuildHost,
} from "./lib/desktop-platform-build-config.ts";
import {
  MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY,
  MOSS_DESKTOP_UPDATE_REPOSITORY_DISABLED,
  MOSS_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import { MOSS_BUNDLED_CODEX_VERSION } from "@synara/shared/codexRuntime";
import { parseBooleanEnvValue } from "./lib/env-bool.ts";
import { finalizeSignedMacDmg } from "./lib/mac-dmg-finalize.ts";
import { createMacBuildOnlySignCommand } from "./lib/mac-build-only-signing.ts";
import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
import {
  createMossProductionPublicConfigExtraResource,
  createMossProductionPublicConfigResource,
  stageMossProductionPublicConfigResource,
  MOSS_PRODUCTION_CONFIG_MODES,
  type MossProductionConfigMode,
} from "./lib/moss-production-public-config.ts";
import { pruneStagedWindowsNativeDependencies } from "./lib/staged-windows-native-dependencies.ts";
import { assertStagedDiffDependencies } from "./lib/staged-diff-dependencies.ts";
import {
  assertPatchPostImage,
  parsePatchFileExpectations,
} from "./lib/staged-patch-verification.ts";
import {
  createStagedLinuxNodePtyRebuildArgs,
  resolveElectronRebuildCli,
} from "./lib/staged-linux-node-pty.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Schema,
  Stream,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
const ProductionConfigMode = Schema.Literals(MOSS_PRODUCTION_CONFIG_MODES);
const ReleaseMode = Schema.Literals(DESKTOP_RELEASE_MODES);
const requireFromScriptsWorkspace = createRequire(new URL("./package.json", import.meta.url));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
const ProductionMacLegacyIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacLegacyIconPng),
);
const ProductionLinuxIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionLinuxIconPng),
);
const ProductionWindowsIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco),
);
const NodePtySmokeScript = Effect.zipWith(RepoRoot, Effect.service(Path.Path), (repoRoot, path) =>
  path.join(repoRoot, "scripts/node-pty-smoke.mjs"),
);
const NODE_PTY_SMOKE_TIMEOUT_MS = 15_000;
const AppSnapHelperBuildScript = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, "apps/desktop/scripts/build-appsnap-helper.mjs"),
);
const CanonicalFilesystemHelperBuildScript = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) =>
    path.join(repoRoot, "apps/server/scripts/build-canonical-filesystem-helper.mjs"),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly sourceCommit: Option.Option<string>;
  readonly sourceTag: Option.Option<string>;
  readonly lockfileSha256: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<string>;
  readonly productionConfigMode: Option.Option<MossProductionConfigMode>;
  readonly releaseMode: Option.Option<DesktopReleaseMode>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

export const BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES = 16 * 1024;
/** Per-stream retained sanitized UTF-8 output ring cap. */
export const BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES = 64 * 1024;
/** @deprecated Use BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES. */
export const BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES =
  BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES;
/** Fixed scratch cap used for every input chunk and bounded parser stage. */
export const BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES = 4 * 1024;
/** Bounded decoder/parser input and output stage caps. */
export const BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES = 64 * 1024;
export const BUILD_COMMAND_FAILURE_SANITIZER_INPUT_CAP_BYTES =
  BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES;
export const BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES =
  BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES;
export const BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES = 32;
export const BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES = 8 * 1024;
export const BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES = 64 * 1024;
export const BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED = "<capture-suppressed>";
export const BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES = 8 * 1024;
const BUILD_COMMAND_FAILURE_UTF16_BYTES_PER_CODE_UNIT = 2;
const BUILD_COMMAND_FAILURE_METADATA_CAP_BYTES = 48 * 1024;
const BUILD_COMMAND_FAILURE_FIXED_SANITIZER_STAGE_COUNT = 2;
const BUILD_COMMAND_FAILURE_POLICY_REF_BYTES = 8;
const BUILD_COMMAND_FAILURE_POLICY_REF_ARRAY_HEADER_BYTES = 64;
const BUILD_COMMAND_FAILURE_POLICY_REF_ARRAY_COUNT = 4;
const BUILD_COMMAND_FAILURE_POLICY_REF_STORAGE_BYTES =
  BUILD_COMMAND_FAILURE_POLICY_REF_ARRAY_COUNT *
  (BUILD_COMMAND_FAILURE_POLICY_REF_ARRAY_HEADER_BYTES +
    BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES * BUILD_COMMAND_FAILURE_POLICY_REF_BYTES);
/** A fixed code-unit slice keeps string encoding scratch bounded. */
const BUILD_COMMAND_FAILURE_CAPTURE_STRING_SCRATCH_CODE_UNITS = 1 * 1024;
/** Conservative cap for both stdout and stderr capture/finish transient state. */
export const BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES = 1 * 1024 * 1024;
export const BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_UPPER_BOUND_BYTES =
  BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES * 2 +
  BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES +
  BUILD_COMMAND_FAILURE_UTF16_BYTES_PER_CODE_UNIT *
    BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES +
  2 *
    BUILD_COMMAND_FAILURE_UTF16_BYTES_PER_CODE_UNIT *
    BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES +
  2 * BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES +
  2 *
    BUILD_COMMAND_FAILURE_UTF16_BYTES_PER_CODE_UNIT *
    BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES +
  BUILD_COMMAND_FAILURE_UTF16_BYTES_PER_CODE_UNIT *
    BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES +
  2 *
    BUILD_COMMAND_FAILURE_UTF16_BYTES_PER_CODE_UNIT *
    BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES +
  4 * BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES +
  BUILD_COMMAND_FAILURE_POLICY_REF_STORAGE_BYTES +
  BUILD_COMMAND_FAILURE_METADATA_CAP_BYTES;
if (
  BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_UPPER_BOUND_BYTES >
  BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES
) {
  throw new Error("Build command failure capture transient bound exceeds its budget");
}
const BUILD_COMMAND_FAILURE_COMMAND_MAX_BYTES = 2 * 1024;
const BUILD_COMMAND_FAILURE_CAUSE_MAX_BYTES = 4 * 1024;
const BUILD_COMMAND_FAILURE_CAPTURE_METADATA_MAX_BYTES = 128;
const BUILD_COMMAND_FAILURE_REDACTION = "<redacted>";

export type BuildCommandFailureSanitizerOptions = {
  readonly sensitiveValues?: ReadonlyArray<string>;
  readonly additionalEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Override the ambient process environment for hermetic callers/tests. */
  readonly processEnvironment?: BuildCommandFailureEnvironment;
};

export type BuildCommandFailureDiagnostics = {
  readonly category: "spawn" | "process" | "unknown";
  readonly code: string | null;
  readonly errno: number | null;
  readonly syscall: string | null;
};

export type BuildCommandFailureReceipt = {
  readonly command: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cause: string;
  readonly diagnostics: BuildCommandFailureDiagnostics;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
};

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly failureReceipt?: BuildCommandFailureReceipt;
}> {}

function resolveGitCommitHash(repoRoot: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: createNonSigningSubprocessEnvironment(process.env),
  });
  if (result.status !== 0) {
    return undefined;
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    return undefined;
  }
  return hash.toLowerCase();
}

function resolveLockfileSha256(repoRoot: string): string {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, "bun.lock")))
    .digest("hex");
}

function resolvePythonForNodeGyp(): string | undefined {
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = join(localAppData, "Programs", "Python", version, "python.exe");
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = spawnSync("python", ["-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
    env: createNonSigningSubprocessEnvironment(process.env),
  });
  if (probe.status !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !existsSync(executable)) {
    return undefined;
  }

  return executable;
}

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly electronDist: string | undefined;
  readonly version: string | undefined;
  readonly sourceCommit: string | undefined;
  readonly sourceTag: string | undefined;
  readonly lockfileSha256: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: string | undefined;
  readonly productionConfigMode: MossProductionConfigMode;
  readonly releaseMode: DesktopReleaseMode;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly mossCommitHash: string;
  readonly mossLockfileSha256: string;
  readonly mossSourceTag: string | null;
  readonly mossWindowsPublisherSubject: string | null;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly optionalDependencies: Record<string, string>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, unknown>;
  readonly patchedDependencies: Record<string, unknown>;
}

export interface ElectronDistProvenance {
  readonly sourceRealpath: string;
  readonly realpath: string;
  readonly version: string;
  readonly arch: "arm64";
  readonly mainBinarySha256: string;
  readonly treeFingerprint: string;
}

export interface ElectronDistStage {
  readonly sourceRealpath: string;
  readonly realpath: string;
}

export interface ElectronDistInspectionCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

type ElectronDistInspectionCommand = (input: ElectronDistInspectionCommandInput) => string;

type ElectronDistStageInput = {
  readonly rawPath: string | undefined;
  readonly stageRoot: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
};

type ElectronDistResolutionInput = {
  readonly distPath: string;
  readonly sourceRealpath: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly expectedVersion: string;
  readonly inspectionEnv?: NodeJS.ProcessEnv;
  readonly runInspectionCommand?: ElectronDistInspectionCommand;
};

export interface ElectronDistReceiptUpdateInput {
  readonly receiptPath: string;
  readonly provenance: ElectronDistProvenance | undefined;
  readonly verifyUpdatedReceipt?: () => void;
  readonly beforeRename?: (tempPath: string) => void;
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function hashRegularFile(filePath: string): string {
  const descriptor = openSync(filePath, fsConstants.O_RDONLY);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function collectElectronDistTreeEntries(
  rootPath: string,
  currentPath: string,
  entries: string[],
): void {
  const children = readdirSync(currentPath, { withFileTypes: true }).toSorted((left, right) =>
    compareUtf8(left.name, right.name),
  );
  for (const child of children) {
    const childPath = join(currentPath, child.name);
    const relativePath = relative(rootPath, childPath).split(sep).join("/");
    const childStat = lstatSync(childPath);
    if (childStat.isSymbolicLink()) {
      const target = readlinkSync(childPath);
      if (isAbsolute(target) || !pathIsWithin(rootPath, resolve(dirname(childPath), target))) {
        throw new Error(`Electron dist symlink escapes its private stage: ${relativePath}.`);
      }
      const targetRealpath = realpathSync(childPath);
      if (!pathIsWithin(rootPath, targetRealpath)) {
        throw new Error(
          `Electron dist symlink resolves outside its private stage: ${relativePath}.`,
        );
      }
      entries.push(`symlink\0${relativePath}\0${target}`);
      continue;
    }
    if (childStat.isDirectory()) {
      entries.push(`directory\0${relativePath}`);
      collectElectronDistTreeEntries(rootPath, childPath, entries);
      continue;
    }
    if (childStat.isFile()) {
      entries.push(`file\0${relativePath}\0${childStat.size}\0${hashRegularFile(childPath)}`);
      continue;
    }
    throw new Error(`Electron dist contains unsupported file type: ${relativePath}.`);
  }
}

export function computeElectronDistTreeFingerprint(rootPath: string): string {
  const resolvedRoot = realpathSync(rootPath);
  if (!statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Electron dist fingerprint root is not a directory: ${rootPath}.`);
  }
  const entries: string[] = [];
  collectElectronDistTreeEntries(resolvedRoot, resolvedRoot, entries);
  entries.sort(compareUtf8);
  return createHash("sha256")
    .update("moss-electron-dist-tree-v1\0")
    .update(entries.join("\n"))
    .digest("hex");
}

export function stageElectronDist(input: ElectronDistStageInput): ElectronDistStage | undefined {
  if (input.rawPath === undefined) return undefined;
  if (input.platform !== "mac" || input.arch !== "arm64") {
    throw new Error("MOSS_DESKTOP_ELECTRON_DIST is only supported for mac/arm64 build targets.");
  }

  const requestedPath = input.rawPath.trim();
  if (!isAbsolute(requestedPath)) {
    throw new Error("MOSS_DESKTOP_ELECTRON_DIST must be an absolute path.");
  }
  const sourceRealpath = realpathSync(requestedPath);
  if (!statSync(sourceRealpath).isDirectory()) {
    throw new Error(`MOSS_DESKTOP_ELECTRON_DIST must resolve to a directory: ${sourceRealpath}.`);
  }
  const stageRoot = realpathSync(input.stageRoot);
  if (!statSync(stageRoot).isDirectory()) {
    throw new Error(`Electron dist private stage root is not a directory: ${stageRoot}.`);
  }
  chmodSync(stageRoot, 0o700);
  if (pathIsWithin(stageRoot, sourceRealpath)) {
    throw new Error("MOSS_DESKTOP_ELECTRON_DIST cannot point inside its private stage.");
  }

  const stagePath = mkdtempSync(join(stageRoot, "electron-dist-"));
  chmodSync(stagePath, 0o700);
  try {
    cpSync(sourceRealpath, stagePath, {
      recursive: true,
      dereference: false,
      force: false,
      verbatimSymlinks: true,
    });
    chmodSync(stagePath, 0o700);
    return {
      sourceRealpath,
      realpath: realpathSync(stagePath),
    };
  } catch (cause) {
    rmSync(stagePath, { recursive: true, force: true });
    throw new Error(`Could not stage MOSS_DESKTOP_ELECTRON_DIST privately.`, { cause });
  }
}

function createElectronInspectionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = createNonSigningSubprocessEnvironment(env);
  delete sanitized.MOSS_DESKTOP_ELECTRON_DIST;
  return sanitized;
}

function runElectronInspectionCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly label: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runInspectionCommand: ElectronDistInspectionCommand | undefined;
}): string {
  const commandInput: ElectronDistInspectionCommandInput = {
    command: input.command,
    args: input.args,
    env: createElectronInspectionEnvironment(input.env),
  };
  if (input.runInspectionCommand) return input.runInspectionCommand(commandInput).trim();

  const result = spawnSync(commandInput.command, [...commandInput.args], {
    encoding: "utf8",
    env: commandInput.env,
    shell: false,
  });
  if (result.error) {
    throw new Error(`${input.label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${input.label} failed: ${(result.stderr || result.stdout || "").trim() || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

export function resolveElectronDistProvenance(
  input: ElectronDistResolutionInput,
): ElectronDistProvenance {
  if (input.platform !== "mac" || input.arch !== "arm64") {
    throw new Error("MOSS_DESKTOP_ELECTRON_DIST is only supported for mac/arm64 build targets.");
  }

  const distPath = realpathSync(input.distPath);
  if (!statSync(distPath).isDirectory()) {
    throw new Error(`MOSS_DESKTOP_ELECTRON_DIST must resolve to a directory: ${distPath}.`);
  }
  const appPath = join(distPath, "Electron.app");
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
    throw new Error(`MOSS_DESKTOP_ELECTRON_DIST is missing Electron.app: ${appPath}.`);
  }
  const infoPlistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPlistPath) || !statSync(infoPlistPath).isFile()) {
    throw new Error(
      `MOSS_DESKTOP_ELECTRON_DIST is missing Electron.app Info.plist: ${infoPlistPath}.`,
    );
  }
  const version = runElectronInspectionCommand({
    command: "/usr/bin/plutil",
    args: ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlistPath],
    label: "Electron.app Info.plist version inspection",
    env: input.inspectionEnv ?? process.env,
    runInspectionCommand: input.runInspectionCommand,
  });
  if (version !== input.expectedVersion) {
    throw new Error(
      `MOSS_DESKTOP_ELECTRON_DIST Electron.app version ${version} does not match package Electron ${input.expectedVersion}.`,
    );
  }

  const mainBinaryPath = join(appPath, "Contents", "MacOS", "Electron");
  if (!existsSync(mainBinaryPath) || !statSync(mainBinaryPath).isFile()) {
    throw new Error(
      `MOSS_DESKTOP_ELECTRON_DIST is missing the Electron main binary: ${mainBinaryPath}.`,
    );
  }
  const fileDescription = runElectronInspectionCommand({
    command: "/usr/bin/file",
    args: [mainBinaryPath],
    label: "Electron main binary file inspection",
    env: input.inspectionEnv ?? process.env,
    runInspectionCommand: input.runInspectionCommand,
  });
  if (!/Mach-O/iu.test(fileDescription) || !/\barm64\b/iu.test(fileDescription)) {
    throw new Error(
      `MOSS_DESKTOP_ELECTRON_DIST main binary is not a macOS arm64 Mach-O executable: ${fileDescription}.`,
    );
  }
  const lipoArchitectures = runElectronInspectionCommand({
    command: "/usr/bin/lipo",
    args: ["-archs", mainBinaryPath],
    label: "Electron main binary lipo architecture inspection",
    env: input.inspectionEnv ?? process.env,
    runInspectionCommand: input.runInspectionCommand,
  });
  if (lipoArchitectures !== "arm64") {
    throw new Error(
      `MOSS_DESKTOP_ELECTRON_DIST main binary architectures must be exactly arm64, got ${lipoArchitectures || "none"}.`,
    );
  }

  return {
    sourceRealpath: input.sourceRealpath,
    realpath: distPath,
    version,
    arch: "arm64",
    mainBinarySha256: hashRegularFile(mainBinaryPath),
    treeFingerprint: computeElectronDistTreeFingerprint(distPath),
  };
}

export function assertElectronDistProvenanceUnchanged(provenance: ElectronDistProvenance): void {
  const currentRealpath = realpathSync(provenance.realpath);
  if (currentRealpath !== provenance.realpath) {
    throw new Error("Staged Electron dist realpath changed during the build.");
  }
  const mainBinaryPath = join(currentRealpath, "Electron.app/Contents/MacOS/Electron");
  const currentMainBinarySha256 = hashRegularFile(mainBinaryPath);
  if (currentMainBinarySha256 !== provenance.mainBinarySha256) {
    throw new Error("Staged Electron dist main binary SHA-256 changed during the build.");
  }
  const currentTreeFingerprint = computeElectronDistTreeFingerprint(currentRealpath);
  if (currentTreeFingerprint !== provenance.treeFingerprint) {
    throw new Error("Staged Electron dist tree fingerprint changed during the build.");
  }
}

export function electronDistBuildConfig(
  provenance: ElectronDistProvenance | undefined,
): Record<string, unknown> {
  return provenance ? { electronDist: provenance.realpath } : {};
}

export function electronDistReceiptProvenance(
  provenance: ElectronDistProvenance | undefined,
): Record<string, unknown> | undefined {
  if (!provenance) return undefined;
  return {
    source: "MOSS_DESKTOP_ELECTRON_DIST",
    sourceRealpath: provenance.sourceRealpath,
    stagedDuringBuild: true,
    realpath: provenance.realpath,
    version: provenance.version,
    arch: provenance.arch,
    mainBinarySha256: provenance.mainBinarySha256,
    treeFingerprint: provenance.treeFingerprint,
    hashMeaning: "SHA-256 of Electron.app/Contents/MacOS/Electron; not a signature",
  };
}

function fsyncDirectory(directoryPath: string): void {
  const directoryFd = openSync(directoryPath, fsConstants.O_RDONLY);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export interface CopiedDesktopRelease {
  readonly receiptPath: string;
  readonly receipt: {
    readonly artifacts: ReadonlyArray<{
      readonly fileName: string;
    }>;
  };
}

export interface CopyAndFinalizeDesktopReleaseInput {
  readonly outputDir: string;
  readonly copy: () => CopiedDesktopRelease;
  readonly finalize: (copied: CopiedDesktopRelease) => void;
  readonly removeFile?: (filePath: string) => void;
  readonly syncOutputDir?: (outputDir: string) => void;
}

function resolveCopiedReleaseFilePath(outputDir: string, fileName: string, label: string): string {
  if (
    !fileName ||
    basename(fileName) !== fileName ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    fileName.includes("\r") ||
    fileName.includes("\n")
  ) {
    throw new Error(`Post-copy cleanup received an unsafe ${label} file name: ${fileName}.`);
  }
  const outputRoot = resolve(outputDir);
  const filePath = resolve(outputRoot, fileName);
  if (dirname(filePath) !== outputRoot) {
    throw new Error(`Post-copy cleanup ${label} is outside the release output directory.`);
  }
  return filePath;
}

function resolveCopiedReleaseReceiptPath(outputDir: string, receiptPath: string): string {
  if (!isAbsolute(receiptPath)) {
    throw new Error("Post-copy cleanup receipt path must be absolute.");
  }
  const outputRoot = resolve(outputDir);
  const resolvedReceiptPath = resolve(receiptPath);
  if (dirname(resolvedReceiptPath) !== outputRoot) {
    throw new Error("Post-copy cleanup receipt path is outside the release output directory.");
  }
  return resolvedReceiptPath;
}

function cleanupCopiedDesktopReleaseFiles(input: {
  readonly outputDir: string;
  readonly copied: CopiedDesktopRelease;
  readonly removeFile: (filePath: string) => void;
  readonly syncOutputDir: (outputDir: string) => void;
}): void {
  const cleanupErrors: unknown[] = [];
  const createdFiles: string[] = [];
  try {
    createdFiles.push(
      ...input.copied.receipt.artifacts.map((artifact) =>
        resolveCopiedReleaseFilePath(input.outputDir, artifact.fileName, "artifact"),
      ),
      resolveCopiedReleaseReceiptPath(input.outputDir, input.copied.receiptPath),
    );
  } catch (cause) {
    cleanupErrors.push(cause);
  }

  for (const filePath of createdFiles.toReversed()) {
    try {
      const fileStat = lstatSync(filePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`Post-copy cleanup refused to remove non-plain file: ${filePath}.`);
      }
      input.removeFile(filePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(cause);
    }
  }

  try {
    input.syncOutputDir(input.outputDir);
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Post-copy release cleanup failed.");
  }
}

export function copyAndFinalizeDesktopRelease(
  input: CopyAndFinalizeDesktopReleaseInput,
): CopiedDesktopRelease {
  const copied = input.copy();
  try {
    input.finalize(copied);
    return copied;
  } catch (cause) {
    try {
      cleanupCopiedDesktopReleaseFiles({
        outputDir: input.outputDir,
        copied,
        removeFile: input.removeFile ?? unlinkSync,
        syncOutputDir: input.syncOutputDir ?? fsyncDirectory,
      });
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Post-copy release finalization failed and cleanup also failed.",
      );
    }
    throw cause;
  }
}

function writeReceiptAtomically(
  receiptPath: string,
  bytes: Buffer,
  beforeRename?: (tempPath: string) => void,
): void {
  const directoryPath = dirname(receiptPath);
  const tempPath = join(
    directoryPath,
    `.${receiptPath.split(sep).at(-1) ?? "receipt"}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tempPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforeRename?.(tempPath);
    renameSync(tempPath, receiptPath);
    fsyncDirectory(directoryPath);
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(tempPath);
    } catch (cleanupCause) {
      if ((cleanupCause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Could not clean temporary receipt ${tempPath}.`, { cause: cleanupCause });
      }
    }
    throw cause;
  }
}

export function appendElectronDistReceiptProvenance(update: ElectronDistReceiptUpdateInput): void {
  const electronDistReceipt = electronDistReceiptProvenance(update.provenance);
  if (!electronDistReceipt) return;

  const originalBytes = readFileSync(update.receiptPath);
  const receipt = JSON.parse(originalBytes.toString("utf8")) as Record<string, unknown>;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Electron dist provenance requires a JSON object receipt.");
  }
  const updatedReceipt = {
    ...receipt,
    electronDist: electronDistReceipt,
  };
  const updatedBytes = Buffer.from(`${JSON.stringify(updatedReceipt, null, 2)}\n`, "utf8");

  try {
    writeReceiptAtomically(update.receiptPath, updatedBytes, update.beforeRename);
    const persisted = JSON.parse(readFileSync(update.receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      !persisted ||
      typeof persisted !== "object" ||
      Array.isArray(persisted) ||
      JSON.stringify(persisted.electronDist) !== JSON.stringify(electronDistReceipt)
    ) {
      throw new Error(
        "Persisted receipt electronDist provenance does not match the verified stage.",
      );
    }
    update.verifyUpdatedReceipt?.();
  } catch (cause) {
    try {
      writeReceiptAtomically(update.receiptPath, originalBytes);
    } catch (restoreCause) {
      throw new Error("Receipt update failed and the previous receipt could not be restored.", {
        cause: restoreCause,
      });
    }
    throw cause;
  }
}

const SslComESignerOptionsConfig = Config.all({
  publisherName: Config.string("SSL_COM_PUBLISHER_NAME"),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "MOSS_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("MOSS_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "MOSS_DESKTOP_ARCH").pipe(Config.option),
  electronDist: Config.string("MOSS_DESKTOP_ELECTRON_DIST").pipe(Config.option),
  version: Config.string("MOSS_DESKTOP_VERSION").pipe(Config.option),
  sourceCommit: Config.string("MOSS_SOURCE_COMMIT").pipe(Config.option),
  sourceTag: Config.string("MOSS_SOURCE_TAG").pipe(Config.option),
  lockfileSha256: Config.string("MOSS_LOCKFILE_SHA256").pipe(Config.option),
  outputDir: Config.string("MOSS_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.string("MOSS_DESKTOP_SKIP_BUILD").pipe(Config.option),
  keepStage: Config.string("MOSS_DESKTOP_KEEP_STAGE").pipe(Config.option),
  signed: Config.string("MOSS_DESKTOP_SIGNED").pipe(Config.option),
  verbose: Config.string("MOSS_DESKTOP_VERBOSE").pipe(Config.option),
  mockUpdates: Config.string("MOSS_DESKTOP_MOCK_UPDATES").pipe(Config.option),
  mockUpdateServerPort: Config.string("MOSS_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  productionConfigMode: Config.schema(
    ProductionConfigMode,
    "MOSS_DESKTOP_PRODUCTION_CONFIG_MODE",
  ).pipe(Config.option),
  releaseMode: Config.schema(ReleaseMode, "MOSS_DESKTOP_RELEASE_MODE").pipe(Config.option),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));
const resolveBooleanEnv = (name: string, value: Option.Option<string>) =>
  Effect.try({
    try: () =>
      Option.match(value, {
        onNone: () => false,
        onSome: (rawValue) => parseBooleanEnvValue(name, rawValue),
      }),
    catch: (cause) =>
      new BuildScriptError({
        message: cause instanceof Error ? cause.message : `Could not parse ${name}.`,
        cause,
      }),
  });

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const electronDist = Option.getOrElse(env.electronDist, () => undefined);
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const sourceCommit = mergeOptions(input.sourceCommit, env.sourceCommit, undefined);
  const sourceTag = mergeOptions(input.sourceTag, env.sourceTag, undefined);
  const lockfileSha256 = mergeOptions(input.lockfileSha256, env.lockfileSha256, undefined);
  const envSkipBuild = yield* resolveBooleanEnv("MOSS_DESKTOP_SKIP_BUILD", env.skipBuild);
  const envKeepStage = yield* resolveBooleanEnv("MOSS_DESKTOP_KEEP_STAGE", env.keepStage);
  const envSigned = yield* resolveBooleanEnv("MOSS_DESKTOP_SIGNED", env.signed);
  const envVerbose = yield* resolveBooleanEnv("MOSS_DESKTOP_VERBOSE", env.verbose);
  const envMockUpdates = yield* resolveBooleanEnv("MOSS_DESKTOP_MOCK_UPDATES", env.mockUpdates);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, envMockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, envSkipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, envKeepStage);
  const signed = resolveBooleanFlag(input.signed, envSigned);
  const verbose = resolveBooleanFlag(input.verbose, envVerbose);
  const mockUpdates = resolveBooleanFlag(input.mockUpdates, envMockUpdates);
  const mockUpdateServerPort = mergeOptions(
    input.mockUpdateServerPort,
    env.mockUpdateServerPort,
    undefined,
  );
  const productionConfigMode = mergeOptions(
    input.productionConfigMode,
    env.productionConfigMode,
    "off",
  );
  const releaseMode = mergeOptions(input.releaseMode, env.releaseMode, "build-only");

  return {
    platform,
    target,
    arch,
    electronDist,
    version,
    sourceCommit,
    sourceTag,
    lockfileSha256,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
    productionConfigMode,
    releaseMode,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const builderCommandOutputOptions = () =>
  ({
    stdout: "pipe",
    stderr: "pipe",
  }) as const;

const SAFE_FAILURE_SIGNAL_NAMES: ReadonlySet<string> = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGBREAK",
  "SIGLOST",
  "SIGINFO",
]);

function utf8BytesForCodePoint(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    bytes += utf8BytesForCodePoint(codePoint);
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number, fromEnd = false): string {
  if (maxBytes <= 0) return "";

  if (!fromEnd) {
    let end = 0;
    let bytes = 0;
    while (end < value.length) {
      const codePoint = value.codePointAt(end);
      if (codePoint === undefined) break;
      const codePointBytes = utf8BytesForCodePoint(codePoint);
      if (bytes + codePointBytes > maxBytes) break;
      bytes += codePointBytes;
      end += codePoint > 0xffff ? 2 : 1;
    }
    return end === value.length ? value : value.slice(0, end);
  }

  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let codePointStart = start - 1;
    const lastUnit = value.charCodeAt(codePointStart);
    if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && codePointStart > 0) {
      const precedingUnit = value.charCodeAt(codePointStart - 1);
      if (precedingUnit >= 0xd800 && precedingUnit <= 0xdbff) codePointStart -= 1;
    }
    const codePoint = value.codePointAt(codePointStart);
    if (codePoint === undefined) break;
    const codePointBytes = utf8BytesForCodePoint(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    start = codePointStart;
  }
  return start === 0 ? value : value.slice(start);
}

type BuildCommandFailureEnvironment = Readonly<Record<string, string | undefined>>;

export type BuildCommandFailureCaptureMode = "normal" | "suppressed";

export type BuildCommandFailureCapturePolicy = {
  readonly mode: BuildCommandFailureCaptureMode;
  readonly values: readonly string[];
  readonly reason: string;
  readonly acceptedValueUtf8Bytes: number;
};

type NormalizedBuildCommandFailurePolicy = BuildCommandFailureCapturePolicy;

const SENSITIVE_ENVIRONMENT_KEY_EXACT = new Set([
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
]);

const SENSITIVE_ENVIRONMENT_KEY_SUFFIXES = [
  "CSC_LINK",
  "API_KEY",
  "ACCESS_KEY",
  "ACCESS_TOKEN",
  "CLIENT_SECRET",
  "PRIVATE_KEY",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "SECRET",
  "AUTHORIZATION",
  "AUTH",
  "COOKIE",
  "CREDENTIAL",
  "BEARER",
  "SIGNATURE",
  "SIG",
  "SESSION",
  "SESSION_TOKEN",
  "SESSION_KEY",
] as const;

function normalizeSensitiveKey(key: string): string {
  let normalized = key.trim();
  while (normalized.startsWith("-")) normalized = normalized.slice(1);
  return normalized.toUpperCase().replaceAll("-", "_");
}

export function isSensitiveAssignmentKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  if (SENSITIVE_ENVIRONMENT_KEY_EXACT.has(normalized)) return true;
  return SENSITIVE_ENVIRONMENT_KEY_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`),
  );
}

function utf8ByteCountUpTo(value: string, limit: number): number {
  let bytes = 0;
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    bytes += utf8BytesForCodePoint(codePoint);
    if (bytes > limit) return limit + 1;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

function suppressedCapturePolicy(reason: string): NormalizedBuildCommandFailurePolicy {
  return Object.freeze({
    mode: "suppressed",
    values: Object.freeze([] as string[]),
    reason,
    acceptedValueUtf8Bytes: 0,
  });
}

function normalizeBuildCommandFailureCapturePolicy(
  policy: unknown,
): NormalizedBuildCommandFailurePolicy {
  try {
    if (typeof policy !== "object" || policy === null) {
      return suppressedCapturePolicy("capture-policy-invalid");
    }
    const candidate = policy as {
      readonly mode?: unknown;
      readonly reason?: unknown;
      readonly values?: unknown;
      readonly acceptedValueUtf8Bytes?: unknown;
    };
    if (candidate.mode === "suppressed") {
      return suppressedCapturePolicy("capture-policy-suppressed");
    }
    if (candidate.mode !== "normal" || candidate.reason !== "within-bounds") {
      return suppressedCapturePolicy("capture-policy-invalid");
    }
    if (!Array.isArray(candidate.values)) {
      return suppressedCapturePolicy("capture-policy-invalid");
    }
    if (candidate.values.length > BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES) {
      return suppressedCapturePolicy("capture-policy-invalid");
    }
    const values: string[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const value of candidate.values) {
      if (typeof value !== "string" || value.length === 0) {
        return suppressedCapturePolicy("capture-policy-invalid");
      }
      if (seen.has(value)) continue;
      const valueBytes = utf8ByteCountUpTo(
        value,
        BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES,
      );
      if (valueBytes > BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES) {
        return suppressedCapturePolicy("capture-policy-invalid");
      }
      if (totalBytes + valueBytes > BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES) {
        return suppressedCapturePolicy("capture-policy-invalid");
      }
      seen.add(value);
      values.push(value);
      totalBytes += valueBytes;
    }
    if (
      typeof candidate.acceptedValueUtf8Bytes !== "number" ||
      !Number.isSafeInteger(candidate.acceptedValueUtf8Bytes) ||
      candidate.acceptedValueUtf8Bytes !== totalBytes
    ) {
      return suppressedCapturePolicy("capture-policy-invalid");
    }
    return {
      mode: "normal",
      values,
      reason: "within-bounds",
      acceptedValueUtf8Bytes: totalBytes,
    };
  } catch {
    return suppressedCapturePolicy("capture-policy-invalid");
  }
}

export function createBuildCommandFailureCapturePolicy(
  options?: BuildCommandFailureSanitizerOptions,
  processEnvironment: BuildCommandFailureEnvironment = options?.processEnvironment ?? process.env,
): BuildCommandFailureCapturePolicy {
  const values: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let suppressedReason: string | undefined;

  const addValue = (value: unknown): void => {
    if (suppressedReason !== undefined || typeof value !== "string" || value.length === 0) return;
    if (seen.has(value)) return;
    const valueBytes = utf8ByteCountUpTo(
      value,
      BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES,
    );
    if (valueBytes > BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES) {
      suppressedReason = "sensitive-value-too-large";
      values.length = 0;
      seen.clear();
      return;
    }
    if (values.length >= BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES) {
      suppressedReason = "sensitive-value-count-too-large";
      values.length = 0;
      seen.clear();
      return;
    }
    if (totalBytes + valueBytes > BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES) {
      suppressedReason = "sensitive-value-total-too-large";
      values.length = 0;
      seen.clear();
      return;
    }
    seen.add(value);
    values.push(value);
    totalBytes += valueBytes;
  };

  const addEnvironment = (environment: BuildCommandFailureEnvironment): void => {
    for (const key in environment) {
      if (!Object.prototype.hasOwnProperty.call(environment, key)) continue;
      if (!isSensitiveAssignmentKey(key)) continue;
      addValue(environment[key]);
      if (suppressedReason !== undefined) return;
    }
  };

  try {
    if (options?.sensitiveValues !== undefined) {
      for (const value of options.sensitiveValues) {
        addValue(value);
        if (suppressedReason !== undefined) return suppressedCapturePolicy(suppressedReason);
      }
    }
    if (options?.additionalEnvironment !== undefined) addEnvironment(options.additionalEnvironment);
    if (suppressedReason !== undefined) return suppressedCapturePolicy(suppressedReason);
    addEnvironment(processEnvironment);
  } catch {
    values.length = 0;
    seen.clear();
    return suppressedCapturePolicy("capture-policy-error");
  }

  if (suppressedReason !== undefined) return suppressedCapturePolicy(suppressedReason);
  values.sort(
    (left, right) =>
      utf8ByteCountUpTo(right, Number.MAX_SAFE_INTEGER) -
      utf8ByteCountUpTo(left, Number.MAX_SAFE_INTEGER),
  );
  return {
    mode: "normal",
    values,
    reason: "within-bounds",
    acceptedValueUtf8Bytes: totalBytes,
  };
}

export type BuildCommandFailureSanitizerStageAccounting = {
  readonly name: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly outputCapBytes: number;
};

export type BuildCommandFailureCaptureAccounting = {
  readonly mode: BuildCommandFailureCaptureMode;
  readonly reason: string;
  readonly sanitizedOutputRingCapBytes: number;
  readonly sanitizedOutputRingStartBytes: number;
  readonly sanitizedOutputRingLengthBytes: number;
  readonly sanitizedOutputRingWrapped: boolean;
  readonly rawRingCapBytes: number;
  readonly rawRingStartBytes: number;
  readonly rawRingLengthBytes: number;
  readonly rawRingWrapped: boolean;
  readonly fixedScratchCapBytes: number;
  readonly sanitizerInputCapBytes: number;
  readonly sanitizerOutputCapBytes: number;
  readonly receiptStreamCapBytes: number;
  readonly parserPendingCapBytes: number;
  readonly acceptedSensitiveValueCount: number;
  readonly acceptedSensitiveValueUtf8Bytes: number;
  readonly sanitizerStageCount: number;
  readonly sanitizerStageMaxCount: number;
  readonly transientUpperBoundBytes: number;
  readonly transientBudgetBytes: number;
  readonly stages: readonly BuildCommandFailureSanitizerStageAccounting[];
};

type BoundedUtf8RingResult = {
  readonly text: string;
  readonly byteLength: number;
  readonly ringStartBytes: number;
  readonly ringLengthBytes: number;
  readonly wrapped: boolean;
};

type BoundedUtf8Ring = {
  readonly appendBytes: (chunk: Uint8Array) => void;
  readonly appendText: (chunk: string) => void;
  readonly appendTextRange: (text: string, start: number, end: number) => void;
  readonly finish: () => BoundedUtf8RingResult;
};

function createBoundedUtf8Ring(capBytes: number, scratchBytes: number): BoundedUtf8Ring {
  let ring: Uint8Array | undefined = new Uint8Array(capBytes);
  const encoder = new TextEncoder();
  let ringStart = 0;
  let ringLength = 0;
  let pendingHighSurrogate = "";
  let finished = false;

  const appendBytes = (chunk: Uint8Array): void => {
    const target = ring;
    if (finished || target === undefined) return;
    for (let offset = 0; offset < chunk.byteLength; ) {
      const chunkEnd = Math.min(chunk.byteLength, offset + scratchBytes);
      let sourceOffset = offset;
      while (sourceOffset < chunkEnd) {
        const writeOffset = (ringStart + ringLength) % target.byteLength;
        const copyLength = Math.min(chunkEnd - sourceOffset, target.byteLength - writeOffset);
        target.set(chunk.subarray(sourceOffset, sourceOffset + copyLength), writeOffset);
        if (ringLength < target.byteLength) {
          ringLength += copyLength;
        } else {
          ringStart = (ringStart + copyLength) % target.byteLength;
        }
        sourceOffset += copyLength;
      }
      offset = chunkEnd;
    }
  };

  const appendTextRange = (text: string, start: number, end: number): void => {
    if (finished || start >= end) return;
    let offset = start;
    if (pendingHighSurrogate.length > 0) {
      if (text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff) {
        appendBytes(encoder.encode(`${pendingHighSurrogate}${text[offset]}`));
        offset += 1;
      } else {
        appendBytes(encoder.encode(pendingHighSurrogate));
      }
      pendingHighSurrogate = "";
    }
    while (offset < end) {
      let pieceEnd = Math.min(
        end,
        offset + BUILD_COMMAND_FAILURE_CAPTURE_STRING_SCRATCH_CODE_UNITS,
      );
      if (
        pieceEnd > offset &&
        text.charCodeAt(pieceEnd - 1) >= 0xd800 &&
        text.charCodeAt(pieceEnd - 1) <= 0xdbff
      ) {
        if (
          pieceEnd < end &&
          text.charCodeAt(pieceEnd) >= 0xdc00 &&
          text.charCodeAt(pieceEnd) <= 0xdfff
        ) {
          pieceEnd -= 1;
        } else if (pieceEnd === end) {
          pendingHighSurrogate = text.slice(pieceEnd - 1, pieceEnd);
          pieceEnd -= 1;
        }
      }
      if (pieceEnd === offset) break;
      const piece = text.slice(offset, pieceEnd);
      appendBytes(encoder.encode(piece));
      offset = pieceEnd;
    }
  };

  const finish = (): BoundedUtf8RingResult => {
    if (finished)
      return {
        text: "",
        byteLength: 0,
        ringStartBytes: ringStart,
        ringLengthBytes: ringLength,
        wrapped: ringStart > 0,
      };
    if (pendingHighSurrogate.length > 0) {
      appendBytes(encoder.encode(pendingHighSurrogate));
      pendingHighSurrogate = "";
    }
    finished = true;
    const target = ring;
    if (target === undefined)
      return {
        text: "",
        byteLength: 0,
        ringStartBytes: ringStart,
        ringLengthBytes: ringLength,
        wrapped: ringStart > 0,
      };
    const snapshotLength = ringLength;
    let snapshot: Uint8Array | undefined = new Uint8Array(snapshotLength);
    if (snapshotLength > 0) {
      const firstLength = Math.min(snapshotLength, target.byteLength - ringStart);
      snapshot.set(target.subarray(ringStart, ringStart + firstLength), 0);
      if (firstLength < snapshotLength)
        snapshot.set(target.subarray(0, snapshotLength - firstLength), firstLength);
    }
    const observedRingStart = ringStart;
    const observedRingLength = ringLength;
    const observedWrapped = ringStart > 0;
    ring = undefined;
    let decodeStart = 0;
    while (decodeStart < snapshot.byteLength && (snapshot[decodeStart]! & 0xc0) === 0x80)
      decodeStart += 1;
    const text = (() => {
      const snapshotBytes = snapshot;
      if (snapshotBytes === undefined) return "";
      let decoded = new TextDecoder().decode(snapshotBytes.subarray(decodeStart, capBytes));
      const boundedText = truncateUtf8(decoded, capBytes, true);
      decoded = "";
      return boundedText;
    })();
    snapshot = undefined;
    return {
      text,
      byteLength: utf8ByteLength(text),
      ringStartBytes: observedRingStart,
      ringLengthBytes: observedRingLength,
      wrapped: observedWrapped,
    };
  };

  return {
    appendBytes,
    appendText: (chunk) => appendTextRange(chunk, 0, chunk.length),
    appendTextRange,
    finish,
  };
}

type SanitizerParserStateName =
  | "Plain"
  | "PendingLiteral"
  | "PendingQueryEscape"
  | "PendingStandaloneToken"
  | "PendingValue"
  | "RedactingQuoted"
  | "RedactingUnquoted"
  | "UrlAuthority"
  | "UrlQueryValue"
  | "Suppressed";

type BuildCommandFailureSanitizerStateResult = {
  readonly mode: BuildCommandFailureCaptureMode;
  readonly reason: string;
  readonly sanitizedText: string;
  readonly ring: BoundedUtf8RingResult | undefined;
};

type BuildCommandFailureSanitizerCallbacks = {
  readonly onOutputText?: (text: string) => void;
  readonly onSuppressed?: (reason: string) => void;
};

type BuildCommandFailureCaptureController = {
  readonly mode: () => BuildCommandFailureCaptureMode;
  readonly reason: () => string;
  readonly releasePolicyReference: () => void;
  readonly isReleased: () => boolean;
  readonly suppress: (reason: string) => void;
  readonly registerCleanup: (cleanup: () => void) => () => void;
  readonly listenerCount: () => number;
  readonly hasSuppressionCallback: () => boolean;
  readonly dispose: () => void;
};

function boundCaptureMetadata(value: string, capBytes: number): string {
  return truncateUtf8(value, capBytes, true);
}

function createBuildCommandFailureCaptureController(
  policy: unknown,
  onSuppressed?: (reason: string) => void,
): BuildCommandFailureCaptureController {
  const normalizedPolicy = normalizeBuildCommandFailureCapturePolicy(policy);
  let mode = normalizedPolicy.mode;
  let reason = boundCaptureMetadata(
    normalizedPolicy.reason,
    BUILD_COMMAND_FAILURE_CAPTURE_METADATA_MAX_BYTES,
  );
  let suppressionNotified = false;
  let policyReferenceReleased = false;
  let disposed = false;
  let suppressionCallback = onSuppressed;
  const cleanups = new Set<() => void>();

  const notifySuppressed = (): void => {
    if (suppressionNotified) return;
    suppressionNotified = true;
    suppressionCallback?.(reason);
  };

  const suppress = (suppressionReason: string): void => {
    if (disposed || mode === "suppressed") return;
    mode = "suppressed";
    reason = boundCaptureMetadata(
      suppressionReason,
      BUILD_COMMAND_FAILURE_CAPTURE_METADATA_MAX_BYTES,
    );
    for (const cleanup of [...cleanups]) cleanup();
    notifySuppressed();
  };

  const releasePolicyReference = (): void => {
    policyReferenceReleased = true;
  };

  const registerCleanup = (cleanup: () => void): (() => void) => {
    if (disposed) {
      cleanup();
      return () => undefined;
    }
    cleanups.add(cleanup);
    if (mode === "suppressed") cleanup();
    return () => cleanups.delete(cleanup);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    policyReferenceReleased = true;
    for (const cleanup of [...cleanups]) cleanup();
    cleanups.clear();
    suppressionCallback = undefined;
  };

  if (mode === "suppressed") {
    notifySuppressed();
  }

  return {
    mode: () => mode,
    reason: () => reason,
    releasePolicyReference,
    isReleased: () => policyReferenceReleased || disposed,
    suppress,
    registerCleanup,
    listenerCount: () => cleanups.size,
    hasSuppressionCallback: () => suppressionCallback !== undefined,
    dispose,
  };
}

export type BuildCommandFailureSanitizerState = {
  readonly consumeSanitizedChunk: (chunk: string | Uint8Array) => void;
  readonly finishSanitizedCapture: () => BuildCommandFailureSanitizerStateResult;
  readonly dispose: () => void;
  readonly mode: () => BuildCommandFailureCaptureMode;
  readonly retainedBytes: number;
  readonly localSensitiveValueCount: number;
  readonly listenerCount: number;
  readonly hasSuppressionCallback: boolean;
};

function isAsciiKeyCharacter(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    char === "_" ||
    char === "-" ||
    char === "." ||
    char === "+"
  );
}

function isWhitespaceOrCredentialDelimiter(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\r" ||
    char === "\n" ||
    char === "," ||
    char === ";" ||
    char === "&" ||
    char === "#"
  );
}

function isUrlScheme(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.charCodeAt(0);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) {
    return false;
  }
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        value[index] === "+" ||
        value[index] === "." ||
        value[index] === "-"
      )
    ) {
      return false;
    }
  }
  return true;
}

type BuildCommandFailureCaptureAccountingInput = {
  readonly mode: BuildCommandFailureCaptureMode;
  readonly reason: string;
  readonly acceptedSensitiveValueCount: number;
  readonly acceptedSensitiveValueUtf8Bytes: number;
};

function normalizeCaptureStageAccountingInput(
  input: BuildCommandFailureCaptureAccountingInput,
): BuildCommandFailureCaptureAccountingInput {
  const validCount =
    Number.isSafeInteger(input.acceptedSensitiveValueCount) &&
    input.acceptedSensitiveValueCount >= 0 &&
    input.acceptedSensitiveValueCount <= BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES;
  const validBytes =
    Number.isSafeInteger(input.acceptedSensitiveValueUtf8Bytes) &&
    input.acceptedSensitiveValueUtf8Bytes >= 0 &&
    input.acceptedSensitiveValueUtf8Bytes <= BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES;
  const count = validCount ? input.acceptedSensitiveValueCount : 0;
  const bytes = validBytes ? input.acceptedSensitiveValueUtf8Bytes : 0;
  const validRelationship = (count === 0 && bytes === 0) || (count > 0 && bytes > 0);
  if (
    input.mode === "normal" &&
    validCount &&
    validBytes &&
    validRelationship &&
    typeof input.reason === "string"
  ) {
    return {
      mode: "normal",
      reason: boundCaptureMetadata(input.reason, BUILD_COMMAND_FAILURE_CAPTURE_METADATA_MAX_BYTES),
      acceptedSensitiveValueCount: count,
      acceptedSensitiveValueUtf8Bytes: bytes,
    };
  }
  return {
    mode: "suppressed",
    reason: "capture-accounting-invalid",
    acceptedSensitiveValueCount: 0,
    acceptedSensitiveValueUtf8Bytes: 0,
  };
}

function createCaptureStageAccounting(
  input: BuildCommandFailureCaptureAccountingInput,
  ring: BoundedUtf8RingResult | undefined,
  stages: readonly BuildCommandFailureSanitizerStageAccounting[],
): BuildCommandFailureCaptureAccounting {
  const normalizedInput = normalizeCaptureStageAccountingInput(input);
  const start = ring?.ringStartBytes ?? 0;
  const length = ring?.ringLengthBytes ?? 0;
  const wrapped = ring?.wrapped ?? false;
  return {
    mode: normalizedInput.mode,
    reason: normalizedInput.reason,
    sanitizedOutputRingCapBytes: BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES,
    sanitizedOutputRingStartBytes: start,
    sanitizedOutputRingLengthBytes: length,
    sanitizedOutputRingWrapped: wrapped,
    rawRingCapBytes: BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES,
    rawRingStartBytes: start,
    rawRingLengthBytes: length,
    rawRingWrapped: wrapped,
    fixedScratchCapBytes: BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
    sanitizerInputCapBytes: BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES,
    sanitizerOutputCapBytes: BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES,
    receiptStreamCapBytes: BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    parserPendingCapBytes: BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES,
    acceptedSensitiveValueCount: normalizedInput.acceptedSensitiveValueCount,
    acceptedSensitiveValueUtf8Bytes: normalizedInput.acceptedSensitiveValueUtf8Bytes,
    sanitizerStageCount: stages.length,
    sanitizerStageMaxCount: BUILD_COMMAND_FAILURE_FIXED_SANITIZER_STAGE_COUNT,
    transientUpperBoundBytes: BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_UPPER_BOUND_BYTES,
    transientBudgetBytes: BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES,
    stages,
  };
}

function createBuildCommandFailureSanitizerStateWithController(
  controller: BuildCommandFailureCaptureController,
  policy: NormalizedBuildCommandFailurePolicy,
  callbacks: BuildCommandFailureSanitizerCallbacks = {},
  ownsController = false,
): BuildCommandFailureSanitizerState {
  let localPolicy: NormalizedBuildCommandFailurePolicy | undefined = policy;
  let mode: BuildCommandFailureCaptureMode =
    controller.mode() === "suppressed" || policy.mode === "suppressed" ? "suppressed" : "normal";
  let reason = controller.mode() === "suppressed" ? controller.reason() : policy.reason;
  let state: SanitizerParserStateName = mode === "suppressed" ? "Suppressed" : "Plain";
  let outputRing: BoundedUtf8Ring | undefined =
    mode === "normal"
      ? createBoundedUtf8Ring(
          BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES,
          BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
        )
      : undefined;
  let decoder: TextDecoder | undefined = mode === "normal" ? new TextDecoder() : undefined;
  let sensitiveCandidate = "";
  let sensitiveCandidateBytes = 0;
  let pending = "";
  let pendingBytes = 0;
  let queryEscape = "";
  let pendingValueKey = "";
  let standalonePrefix = "";
  let standaloneNeedsScheme = false;
  let quote = "";
  let escaped = false;
  let authorizationTokensRemaining = 0;
  let inQuery = false;
  let urlBuffer = "";
  let urlBufferBytes = 0;
  let urlSlashCount = 0;
  let urlQuote = "";
  let urlEscaped = false;
  let finished = false;
  let disposed = false;
  let onOutputText = callbacks.onOutputText;
  let memoizedResult: BuildCommandFailureSanitizerStateResult | undefined;
  const currentSensitiveValues = (): readonly string[] => localPolicy?.values ?? [];

  const clearLocalState = (): void => {
    mode = "suppressed";
    reason = controller.reason();
    state = "Suppressed";
    finished = true;
    localPolicy = undefined;
    memoizedResult = undefined;
    outputRing = undefined;
    decoder = undefined;
    sensitiveCandidate = "";
    sensitiveCandidateBytes = 0;
    pending = "";
    pendingBytes = 0;
    queryEscape = "";
    pendingValueKey = "";
    standalonePrefix = "";
    standaloneNeedsScheme = false;
    quote = "";
    escaped = false;
    authorizationTokensRemaining = 0;
    urlBuffer = "";
    urlBufferBytes = 0;
    onOutputText = undefined;
  };

  const unregisterCleanup = controller.registerCleanup(clearLocalState);

  const suppress = (suppressionReason: string): void => {
    controller.suppress(suppressionReason);
    mode = controller.mode();
    reason = controller.reason();
  };

  const emitText = (text: string): void => {
    if (mode === "suppressed" || text.length === 0) return;
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(
        text.length,
        offset + BUILD_COMMAND_FAILURE_CAPTURE_STRING_SCRATCH_CODE_UNITS,
      );
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      )
        end -= 1;
      if (end === offset) end += 1;
      const piece = text.slice(offset, end);
      outputRing?.appendText(piece);
      onOutputText?.(piece);
      offset = end;
    }
  };

  const emitRange = (text: string, start: number, end: number): void => {
    if (start < end) emitText(text.slice(start, end));
  };

  const appendPending = (char: string): boolean => {
    const bytes = utf8ByteCountUpTo(char, BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES);
    if (pendingBytes + bytes > BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES) return false;
    if (currentPendingBytes() + bytes > BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES) {
      suppress("parser-pending-budget-exceeded");
      return false;
    }
    pending += char;
    pendingBytes += bytes;
    return true;
  };

  const findTrailingSensitiveKey = (
    value: string,
  ): { readonly prefix: string; readonly key: string; readonly suffix: string } | undefined => {
    let end = value.length;
    while (end > 0 && (value[end - 1] === " " || value[end - 1] === "\t")) end -= 1;
    for (let start = end - 1; start >= 0; start -= 1) {
      const candidate = value.slice(start, end);
      if (isSensitiveAssignmentKey(candidate)) {
        return {
          prefix: value.slice(0, start),
          key: candidate,
          suffix: value.slice(end),
        };
      }
    }
    return undefined;
  };

  const clearPending = (): void => {
    pending = "";
    pendingBytes = 0;
  };

  const pendingMetadataBytes = (value: string): number =>
    utf8ByteCountUpTo(value, BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES);

  const currentPendingBytes = (): number =>
    pendingBytes +
    sensitiveCandidateBytes +
    urlBufferBytes +
    pendingMetadataBytes(queryEscape) +
    pendingMetadataBytes(pendingValueKey) +
    pendingMetadataBytes(standalonePrefix);

  const reservePendingBytes = (additionalBytes: number): boolean => {
    if (currentPendingBytes() + additionalBytes > BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES) {
      suppress("parser-pending-budget-exceeded");
      return false;
    }
    return true;
  };

  const setPendingValueKey = (value: string): boolean => {
    const previousBytes = pendingMetadataBytes(pendingValueKey);
    const nextBytes = pendingMetadataBytes(value);
    if (
      currentPendingBytes() - previousBytes + nextBytes >
      BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES
    ) {
      suppress("parser-pending-budget-exceeded");
      return false;
    }
    pendingValueKey = value;
    return true;
  };

  const setStandalonePrefix = (value: string): boolean => {
    const previousBytes = pendingMetadataBytes(standalonePrefix);
    const nextBytes = pendingMetadataBytes(value);
    if (
      currentPendingBytes() - previousBytes + nextBytes >
      BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES
    ) {
      suppress("parser-pending-budget-exceeded");
      return false;
    }
    standalonePrefix = value;
    return true;
  };

  const appendQueryEscape = (char: string): boolean => {
    const bytes = pendingMetadataBytes(char);
    if (!reservePendingBytes(bytes)) return false;
    queryEscape += char;
    return true;
  };

  const appendUrl = (char: string): boolean => {
    const bytes = utf8ByteCountUpTo(char, BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES);
    if (!reservePendingBytes(bytes)) return false;
    urlBuffer += char;
    urlBufferBytes += bytes;
    return true;
  };

  const flushUrl = (): void => {
    if (urlBuffer.length === 0) return;
    const buffer = urlBuffer;
    urlBuffer = "";
    urlBufferBytes = 0;
    const schemeEnd = buffer.indexOf("://");
    let lastAt = -1;
    let scanQuote = "";
    let scanEscaped = false;
    for (let index = schemeEnd < 0 ? 0 : schemeEnd + 3; index < buffer.length; index += 1) {
      const char = buffer[index]!;
      if (scanEscaped) {
        scanEscaped = false;
        continue;
      }
      if (char === "\\") {
        scanEscaped = true;
        continue;
      }
      if (scanQuote.length > 0) {
        if (char === scanQuote) scanQuote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        scanQuote = char;
        continue;
      }
      if (char === "@") lastAt = index;
    }
    if (scanQuote.length > 0 || (lastAt < 0 && (buffer.includes('"') || buffer.includes("'")))) {
      suppress("url-authority-boundary-unproven");
      return;
    }
    if (lastAt >= 0 && schemeEnd >= 0) {
      emitRange(buffer, 0, schemeEnd + 3);
      emitText(BUILD_COMMAND_FAILURE_REDACTION);
      emitText("@");
      emitRange(buffer, lastAt + 1, buffer.length);
    } else {
      emitText(buffer);
    }
    urlSlashCount = 0;
    urlQuote = "";
    urlEscaped = false;
  };

  const enterUnquotedRedaction = (): void => {
    emitText(BUILD_COMMAND_FAILURE_REDACTION);
    authorizationTokensRemaining =
      normalizeSensitiveKey(pendingValueKey) === "AUTHORIZATION" ? 1 : 0;
    state = inQuery ? "UrlQueryValue" : "RedactingUnquoted";
  };

  const isStandaloneAuthPrefix = (value: string): boolean => {
    const normalized = normalizeSensitiveKey(value);
    return normalized === "AUTHORIZATION" || normalized === "BEARER" || normalized === "BASIC";
  };

  const isStandaloneAuthScheme = (value: string): boolean => {
    const normalized = normalizeSensitiveKey(value);
    return normalized === "BEARER" || normalized === "BASIC";
  };

  const processPlainChar = (char: string): void => {
    if (char === "?") inQuery = true;
    if (char === "#") inQuery = false;
    if (isAsciiKeyCharacter(char)) {
      if (!appendPending(char)) return;
      state = "PendingLiteral";
    } else {
      emitText(char);
    }
  };

  const processChar = (char: string): void => {
    if (state === "Suppressed") return;
    if (state === "Plain") {
      processPlainChar(char);
      return;
    }
    if (state === "PendingQueryEscape") {
      if (queryEscape === "%" && char === "3") {
        appendQueryEscape(char);
        return;
      }
      if (queryEscape === "%3" && (char === "d" || char === "D")) {
        const key = pending;
        const encodedEquals = `${queryEscape}${char}`;
        clearPending();
        queryEscape = "";
        emitText(key);
        emitText(encodedEquals);
        if (isSensitiveAssignmentKey(key)) {
          if (!setPendingValueKey(key)) return;
          enterUnquotedRedaction();
        } else {
          state = "Plain";
        }
        return;
      }
      const unfinishedEscape = queryEscape;
      const unfinishedKey = pending;
      clearPending();
      queryEscape = "";
      emitText(unfinishedKey);
      emitText(unfinishedEscape);
      state = "Plain";
      processPlainChar(char);
      return;
    }
    if (state === "PendingStandaloneToken") {
      if (char === ":" || char === "=") {
        const key = standalonePrefix;
        standalonePrefix = "";
        standaloneNeedsScheme = false;
        if (!setPendingValueKey(key)) return;
        emitText(char);
        state = "PendingValue";
        return;
      }
      if (isWhitespaceOrCredentialDelimiter(char)) {
        if (pending.length === 0) {
          emitText(char);
          return;
        }
        if (standaloneNeedsScheme && isStandaloneAuthScheme(pending)) {
          emitText(pending);
          emitText(char);
          const prefix = standalonePrefix;
          clearPending();
          standalonePrefix = "";
          standaloneNeedsScheme = false;
          if (!setPendingValueKey(prefix)) return;
          enterUnquotedRedaction();
          return;
        }
        emitText(pending);
        emitText(char);
        clearPending();
        standalonePrefix = "";
        standaloneNeedsScheme = false;
        state = "Plain";
        return;
      }
      if (standaloneNeedsScheme) {
        if (!appendPending(char)) return;
        return;
      }
      const prefix = standalonePrefix;
      standalonePrefix = "";
      standaloneNeedsScheme = false;
      if (!setPendingValueKey(prefix)) return;
      enterUnquotedRedaction();
      processChar(char);
      return;
    }
    if (state === "PendingLiteral") {
      if (isAsciiKeyCharacter(char)) {
        if (!appendPending(char)) {
          emitText(pending);
          clearPending();
          state = "Plain";
          processPlainChar(char);
        }
        return;
      }
      if (char === ":" || char === "=") {
        if (char === ":" && isUrlScheme(pending)) {
          const scheme = pending;
          const schemeBytes = pendingBytes;
          clearPending();
          if (!reservePendingBytes(schemeBytes)) return;
          urlBuffer = scheme;
          urlBufferBytes = schemeBytes;
          appendUrl(char);
          state = "UrlAuthority";
          urlSlashCount = 0;
          return;
        }
        const sensitiveKey = isSensitiveAssignmentKey(pending)
          ? { prefix: "", key: pending, suffix: "" }
          : findTrailingSensitiveKey(pending);
        if (sensitiveKey !== undefined) {
          const key = sensitiveKey.key;
          emitText(sensitiveKey.prefix);
          emitText(sensitiveKey.key);
          emitText(sensitiveKey.suffix);
          emitText(char);
          clearPending();
          if (!setPendingValueKey(key)) return;
          state = "PendingValue";
          return;
        }
        emitText(pending);
        clearPending();
        emitText(char);
        state = "Plain";
        return;
      }
      if (inQuery && char === "%") {
        if (!appendQueryEscape("%")) return;
        state = "PendingQueryEscape";
        return;
      }
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        if (isStandaloneAuthPrefix(pending)) {
          emitText(pending);
          emitText(char);
          const prefix = normalizeSensitiveKey(pending);
          clearPending();
          if (!setStandalonePrefix(prefix)) return;
          standaloneNeedsScheme = prefix === "AUTHORIZATION";
          state = "PendingStandaloneToken";
          return;
        }
        if (pending.startsWith("--") && isSensitiveAssignmentKey(pending)) {
          emitText(pending);
          emitText(char);
          const key = pending;
          clearPending();
          if (!setPendingValueKey(key)) return;
          enterUnquotedRedaction();
          return;
        }
        if (isSensitiveAssignmentKey(pending)) {
          appendPending(char);
          return;
        }
        emitText(pending);
        clearPending();
        emitText(char);
        state = "Plain";
        return;
      }
      emitText(pending);
      clearPending();
      state = "Plain";
      processPlainChar(char);
      return;
    }
    if (state === "PendingValue") {
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        emitText(char);
        return;
      }
      if (char === '"' || char === "'") {
        emitText(BUILD_COMMAND_FAILURE_REDACTION);
        quote = char;
        escaped = false;
        state = "RedactingQuoted";
        return;
      }
      enterUnquotedRedaction();
      processChar(char);
      return;
    }
    if (state === "RedactingQuoted") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        emitText(char);
        quote = "";
        state = "Plain";
        pendingValueKey = "";
      }
      return;
    }
    if (state === "RedactingUnquoted" || state === "UrlQueryValue") {
      if (!isWhitespaceOrCredentialDelimiter(char)) return;
      if ((char === " " || char === "\t") && authorizationTokensRemaining > 0) {
        authorizationTokensRemaining -= 1;
        return;
      }
      emitText(char);
      if (char === "#") inQuery = false;
      state = "Plain";
      pendingValueKey = "";
      return;
    }
    if (state === "UrlAuthority") {
      if (urlSlashCount < 2) {
        if (char === "/") {
          if (!appendUrl(char)) return;
          urlSlashCount += 1;
        } else {
          const candidate = urlBuffer;
          const wasAssignmentColon = urlSlashCount === 0 && candidate.endsWith(":");
          urlBuffer = "";
          urlBufferBytes = 0;
          urlSlashCount = 0;
          if (wasAssignmentColon) {
            const key = candidate.slice(0, -1);
            emitText(key);
            emitText(":");
            if (isSensitiveAssignmentKey(key)) {
              if (!setPendingValueKey(key)) return;
              state = "PendingValue";
              processChar(char);
            } else {
              state = "Plain";
              processPlainChar(char);
            }
          } else {
            emitText(candidate);
            state = "Plain";
            processPlainChar(char);
          }
        }
        return;
      }
      if (urlEscaped) {
        appendUrl(char);
        urlEscaped = false;
        return;
      }
      if (char === "\\") {
        appendUrl(char);
        urlEscaped = true;
        return;
      }
      if (urlQuote.length > 0) {
        appendUrl(char);
        if (char === urlQuote) urlQuote = "";
        return;
      }
      if (char === '"' || char === "'") {
        appendUrl(char);
        urlQuote = char;
        return;
      }
      if (char === "/" || char === "?" || char === "#" || isWhitespaceOrCredentialDelimiter(char)) {
        flushUrl();
        if (controller.mode() === "suppressed") return;
        state = "Plain";
        processPlainChar(char);
        return;
      }
      appendUrl(char);
      return;
    }
  };

  const processText = (text: string): void => {
    for (let index = 0; index < text.length; ) {
      const first = text.charCodeAt(index);
      const width =
        first >= 0xd800 &&
        first <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
          ? 2
          : 1;
      processChar(text.slice(index, index + width));
      index += width;
    }
  };

  const clearSensitiveCandidate = (): void => {
    sensitiveCandidate = "";
    sensitiveCandidateBytes = 0;
  };

  const flushSensitiveCandidate = (): boolean => {
    while (mode === "normal" && sensitiveCandidate.length > 0) {
      const codePoint = sensitiveCandidate.codePointAt(0);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      const first = sensitiveCandidate.slice(0, width);
      sensitiveCandidate = sensitiveCandidate.slice(width);
      sensitiveCandidateBytes -= utf8BytesForCodePoint(codePoint);
      processText(first);
    }
    if (mode === "suppressed") {
      clearSensitiveCandidate();
      return false;
    }
    return true;
  };

  const consumeSensitiveCodePoint = (char: string): void => {
    if (mode === "suppressed") return;
    const charBytes = utf8ByteCountUpTo(char, BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES);
    if (
      sensitiveCandidateBytes + charBytes >
      BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES
    ) {
      if (!flushSensitiveCandidate()) return;
    }
    const hasPendingMetadata =
      pendingValueKey.length > 0 ||
      urlBufferBytes > 0 ||
      queryEscape.length > 0 ||
      standalonePrefix.length > 0;
    if (
      !hasPendingMetadata &&
      pendingBytes > 0 &&
      currentPendingBytes() + charBytes > BUILD_COMMAND_FAILURE_PARSER_PENDING_CAP_BYTES
    ) {
      const safePending = pending;
      clearPending();
      state = "Plain";
      emitText(safePending);
    }
    if (hasPendingMetadata && !reservePendingBytes(charBytes)) {
      return;
    }
    sensitiveCandidate += char;
    sensitiveCandidateBytes += charBytes;
    for (const value of currentSensitiveValues()) {
      if (value === sensitiveCandidate) {
        clearSensitiveCandidate();
        processText(BUILD_COMMAND_FAILURE_REDACTION);
        return;
      }
    }
    if (!currentSensitiveValues().some((value) => value.startsWith(sensitiveCandidate))) {
      flushSensitiveCandidate();
    }
  };

  const consumeTextChunk = (text: string): void => {
    if (mode === "suppressed") return;
    if (currentSensitiveValues().length === 0) {
      processText(text);
      return;
    }
    for (let index = 0; index < text.length; ) {
      const first = text.charCodeAt(index);
      const width =
        first >= 0xd800 &&
        first <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
          ? 2
          : 1;
      consumeSensitiveCodePoint(text.slice(index, index + width));
      index += width;
    }
  };

  const finishParser = (): void => {
    if (state === "PendingLiteral") {
      emitText(pending);
      clearPending();
      state = "Plain";
    } else if (state === "PendingQueryEscape") {
      emitText(pending);
      emitText(queryEscape);
      clearPending();
      queryEscape = "";
      state = "Plain";
    } else if (state === "PendingStandaloneToken") {
      emitText(pending);
      clearPending();
      standalonePrefix = "";
      standaloneNeedsScheme = false;
      state = "Plain";
    } else if (state === "UrlAuthority") {
      flushUrl();
      state = "Plain";
    }
  };

  return {
    consumeSanitizedChunk: (chunk) => {
      if (finished || mode === "suppressed") return;
      try {
        if (chunk instanceof Uint8Array) {
          for (let offset = 0; offset < chunk.byteLength; ) {
            const end = Math.min(
              chunk.byteLength,
              offset + BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
            );
            const text = decoder?.decode(chunk.subarray(offset, end), { stream: true }) ?? "";
            consumeTextChunk(text);
            offset = end;
          }
        } else {
          for (let offset = 0; offset < chunk.length; ) {
            const end = Math.min(
              chunk.length,
              offset + BUILD_COMMAND_FAILURE_CAPTURE_STRING_SCRATCH_CODE_UNITS,
            );
            consumeTextChunk(chunk.slice(offset, end));
            offset = end;
          }
        }
      } catch {
        suppress("sanitizer-internal-error");
      }
    },
    finishSanitizedCapture: () => {
      if (memoizedResult !== undefined) return memoizedResult;
      if (finished)
        return (memoizedResult = {
          mode,
          reason,
          sanitizedText: mode === "suppressed" ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED : "",
          ring: undefined,
        });
      try {
        if (mode === "normal") {
          const flushed = decoder?.decode() ?? "";
          if (flushed.length > 0) consumeTextChunk(flushed);
          flushSensitiveCandidate();
          finishParser();
        }
      } catch {
        suppress("sanitizer-internal-error");
      }
      finished = true;
      if (mode === "suppressed") {
        outputRing = undefined;
        localPolicy = undefined;
        return (memoizedResult = {
          mode,
          reason,
          sanitizedText: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
          ring: undefined,
        });
      }
      const ring = outputRing;
      outputRing = undefined;
      const result = ring?.finish();
      localPolicy = undefined;
      return (memoizedResult = { mode, reason, sanitizedText: result?.text ?? "", ring: result });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      finished = true;
      unregisterCleanup();
      localPolicy = undefined;
      memoizedResult = undefined;
      sensitiveCandidate = "";
      sensitiveCandidateBytes = 0;
      pending = "";
      pendingBytes = 0;
      queryEscape = "";
      pendingValueKey = "";
      standalonePrefix = "";
      standaloneNeedsScheme = false;
      urlBuffer = "";
      urlBufferBytes = 0;
      outputRing = undefined;
      decoder = undefined;
      onOutputText = undefined;
      if (ownsController) controller.dispose();
    },
    mode: () => mode,
    get retainedBytes() {
      return finished || controller.mode() === "suppressed"
        ? 0
        : BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES;
    },
    get localSensitiveValueCount() {
      return finished || mode === "suppressed" ? 0 : (localPolicy?.values.length ?? 0);
    },
    get listenerCount() {
      return controller.listenerCount();
    },
    get hasSuppressionCallback() {
      return controller.hasSuppressionCallback();
    },
  };
}

export function createBuildCommandFailureSanitizerState(
  policy: BuildCommandFailureCapturePolicy,
  callbacks: BuildCommandFailureSanitizerCallbacks = {},
): BuildCommandFailureSanitizerState {
  const normalizedPolicy = normalizeBuildCommandFailureCapturePolicy(policy);
  const controller = createBuildCommandFailureCaptureController(
    normalizedPolicy,
    callbacks.onSuppressed,
  );
  return createBuildCommandFailureSanitizerStateWithController(
    controller,
    normalizedPolicy,
    {
      ...(callbacks.onOutputText === undefined ? {} : { onOutputText: callbacks.onOutputText }),
    },
    true,
  );
}

type BuildCommandFailureTextSanitizer = ((text: string) => string) & {
  dispose: () => void;
};

function createBuildCommandFailureTextSanitizer(
  options?: BuildCommandFailureSanitizerOptions,
  policyOverride?: BuildCommandFailureCapturePolicy,
  controllerOverride?: BuildCommandFailureCaptureController,
): BuildCommandFailureTextSanitizer {
  let policy: NormalizedBuildCommandFailurePolicy | undefined =
    normalizeBuildCommandFailureCapturePolicy(
      policyOverride ?? createBuildCommandFailureCapturePolicy(options),
    );
  const controller = controllerOverride ?? createBuildCommandFailureCaptureController(policy);
  const ownsController = controllerOverride === undefined;
  let disposed = false;
  const sanitizer = ((text: string): string => {
    if (disposed || policy === undefined) return BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED;
    const state = createBuildCommandFailureSanitizerStateWithController(controller, policy);
    state.consumeSanitizedChunk(text);
    const result = state.finishSanitizedCapture();
    state.dispose();
    return result.sanitizedText;
  }) as BuildCommandFailureTextSanitizer;
  sanitizer.dispose = (): void => {
    if (disposed) return;
    disposed = true;
    policy = releaseBuildCommandFailurePolicyValues(policy);
    if (ownsController) controller.dispose();
  };
  return sanitizer;
}

export function sanitizeBuildCommandFailureText(
  text: string,
  options?: BuildCommandFailureSanitizerOptions,
): string {
  const sanitizer = createBuildCommandFailureTextSanitizer(options);
  try {
    return sanitizer(text);
  } finally {
    sanitizer.dispose();
  }
}

type BuildCommandFailureTailChunk = string | Uint8Array;

type BuildCommandFailureCaptureResult = {
  readonly sanitizedText: string;
  readonly receiptText: string;
  readonly accounting: BuildCommandFailureCaptureAccounting;
};

type BuildCommandFailureFinalCaptureResult = {
  readonly receiptText: string;
  readonly accounting: BuildCommandFailureCaptureAccounting;
};

type BuildCommandFailureCapture = {
  readonly append: (chunk: BuildCommandFailureTailChunk) => void;
  readonly finish: () => string;
  readonly finishDetailed: () => BuildCommandFailureCaptureResult;
  readonly finishAndDispose: () => BuildCommandFailureFinalCaptureResult;
  readonly retainedBytes: number;
  readonly localSensitiveValueCount: number;
  readonly scratchBytes: number;
  readonly temporaryBudgetBytes: number;
  readonly accounting: () => BuildCommandFailureCaptureAccounting;
};

export type BuildCommandFailureCaptureLifecycleEvent = {
  readonly stream: "stdout" | "stderr";
  readonly phase: "before-finish" | "after-dispose";
  readonly retainedBytes: number;
  readonly localSensitiveValueCount: number;
  readonly hasSuppressionCallback: boolean;
  readonly listenerCount: number;
  readonly repeatFinalResultEqual: boolean;
  readonly snapshotMode: BuildCommandFailureCaptureMode;
  readonly snapshotAcceptedSensitiveValueCount: number;
  readonly snapshotAcceptedSensitiveValueUtf8Bytes: number;
  readonly accountingMode: BuildCommandFailureCaptureMode;
  readonly accountingAcceptedSensitiveValueCount: number;
  readonly accountingAcceptedSensitiveValueUtf8Bytes: number;
};

function createBuildCommandFailureCapture(
  policy: BuildCommandFailureCapturePolicy,
  callbacks: BuildCommandFailureSanitizerCallbacks = {},
  controllerOverride?: BuildCommandFailureCaptureController,
): BuildCommandFailureCapture {
  const normalizedPolicy = normalizeBuildCommandFailureCapturePolicy(policy);
  const initialSensitiveValueCount = normalizedPolicy.values.length;
  const initialSensitiveValueUtf8Bytes = normalizedPolicy.acceptedValueUtf8Bytes;
  const ownsController = controllerOverride === undefined;
  const controller =
    controllerOverride ??
    createBuildCommandFailureCaptureController(normalizedPolicy, callbacks.onSuppressed);
  let state: BuildCommandFailureSanitizerState | undefined;
  let finished = false;
  let result: BuildCommandFailureCaptureResult | undefined;
  let finalResultMemo: BuildCommandFailureFinalCaptureResult | undefined;
  let accounting = createCaptureStageAccounting(
    {
      mode: controller.mode(),
      reason: controller.reason(),
      acceptedSensitiveValueCount: controller.mode() === "normal" ? initialSensitiveValueCount : 0,
      acceptedSensitiveValueUtf8Bytes:
        controller.mode() === "normal" ? initialSensitiveValueUtf8Bytes : 0,
    },
    undefined,
    [],
  );
  if (controller.mode() === "normal") {
    state = createBuildCommandFailureSanitizerStateWithController(controller, normalizedPolicy, {
      ...(callbacks.onOutputText === undefined ? {} : { onOutputText: callbacks.onOutputText }),
    });
  }
  const finishDetailed = (): BuildCommandFailureCaptureResult => {
    if (result !== undefined) return result;
    if (finished)
      return (
        result ?? {
          sanitizedText: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
          receiptText: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
          accounting,
        }
      );
    finished = true;
    const stateResult = state?.finishSanitizedCapture();
    const mode = controller.mode();
    const sanitizedText =
      mode === "suppressed"
        ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED
        : (stateResult?.sanitizedText ?? "");
    const receiptText =
      mode === "suppressed"
        ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED
        : truncateUtf8(sanitizedText, BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES, true);
    const stages: BuildCommandFailureSanitizerStageAccounting[] =
      mode === "suppressed"
        ? []
        : [
            {
              name: "parser-input",
              inputBytes: BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES,
              outputBytes: Math.min(
                utf8ByteLength(sanitizedText),
                BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES,
              ),
              outputCapBytes: BUILD_COMMAND_FAILURE_IO_STAGE_CAP_BYTES,
            },
            {
              name: "sanitized-output-ring",
              inputBytes: Math.min(
                utf8ByteLength(sanitizedText),
                BUILD_COMMAND_FAILURE_SANITIZER_INPUT_CAP_BYTES,
              ),
              outputBytes: utf8ByteLength(sanitizedText),
              outputCapBytes: BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES,
            },
          ];
    accounting = createCaptureStageAccounting(
      {
        mode,
        reason: controller.reason(),
        acceptedSensitiveValueCount: mode === "normal" ? initialSensitiveValueCount : 0,
        acceptedSensitiveValueUtf8Bytes: mode === "normal" ? initialSensitiveValueUtf8Bytes : 0,
      },
      stateResult?.ring,
      stages,
    );
    result = { sanitizedText, receiptText, accounting };
    state?.dispose();
    state = undefined;
    if (ownsController) controller.dispose();
    return result;
  };
  const finishAndDispose = (): BuildCommandFailureFinalCaptureResult => {
    if (finalResultMemo !== undefined) return finalResultMemo;
    const detailed = finishDetailed();
    const finalResult = Object.freeze({
      receiptText: detailed.receiptText,
      accounting: detailed.accounting,
    });
    result = undefined;
    finalResultMemo = finalResult;
    return finalResultMemo;
  };
  return {
    append: (chunk) => {
      if (!finished) state?.consumeSanitizedChunk(chunk);
    },
    finish: () => finishDetailed().receiptText,
    finishDetailed,
    finishAndDispose,
    get retainedBytes() {
      return finished || controller.mode() === "suppressed"
        ? 0
        : BUILD_COMMAND_FAILURE_SANITIZED_OUTPUT_RING_CAP_BYTES;
    },
    get localSensitiveValueCount() {
      return state?.localSensitiveValueCount ?? 0;
    },
    scratchBytes: BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
    temporaryBudgetBytes: BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES,
    accounting: () => accounting,
  };
}

export function sanitizeBuildCommandFailureTail(
  chunks: Iterable<BuildCommandFailureTailChunk>,
  options?: BuildCommandFailureSanitizerOptions,
): string {
  const capture = createBuildCommandFailureCapture(createBuildCommandFailureCapturePolicy(options));
  for (const chunk of chunks) capture.append(chunk);
  return capture.finish();
}

export function inspectBuildCommandFailureTail(
  chunks: Iterable<BuildCommandFailureTailChunk>,
  options?: BuildCommandFailureSanitizerOptions,
): {
  readonly tail: string;
  readonly retainedBytes: number;
  readonly scratchBytes: number;
  readonly temporaryBudgetBytes: number;
  readonly accounting: BuildCommandFailureCaptureAccounting;
} {
  const capture = createBuildCommandFailureCapture(createBuildCommandFailureCapturePolicy(options));
  for (const chunk of chunks) capture.append(chunk);
  const result = capture.finishAndDispose();
  return {
    tail: result.receiptText,
    retainedBytes: capture.retainedBytes,
    scratchBytes: capture.scratchBytes,
    temporaryBudgetBytes: capture.temporaryBudgetBytes,
    accounting: result.accounting,
  };
}

export function inspectBuildCommandFailureSanitization(
  text: string,
  options?: BuildCommandFailureSanitizerOptions,
): {
  readonly sanitized: string;
  readonly receiptTail: string;
  readonly stages: readonly BuildCommandFailureSanitizerStageAccounting[];
  readonly accounting: BuildCommandFailureCaptureAccounting;
} {
  const capture = createBuildCommandFailureCapture(createBuildCommandFailureCapturePolicy(options));
  capture.append(text);
  const result = capture.finishDetailed();
  return {
    sanitized: result.sanitizedText,
    receiptTail: result.receiptText,
    stages: result.accounting.stages,
    accounting: result.accounting,
  };
}

function safeCommandPresentation(
  command: ChildProcess.Command,
  sanitizer: BuildCommandFailureTextSanitizer,
): string {
  if (command._tag === "PipedCommand") return "<piped command>";
  let rawCommand = "";
  for (const token of [command.command, ...command.args]) {
    const boundedToken = truncateUtf8(String(token), BUILD_COMMAND_FAILURE_COMMAND_MAX_BYTES);
    const candidate = rawCommand.length === 0 ? boundedToken : `${rawCommand} ${boundedToken}`;
    rawCommand = truncateUtf8(candidate, BUILD_COMMAND_FAILURE_COMMAND_MAX_BYTES);
  }
  return truncateUtf8(sanitizer(rawCommand), BUILD_COMMAND_FAILURE_COMMAND_MAX_BYTES);
}

function resolveFailureSignal(cause: unknown): string | null {
  try {
    const message =
      cause instanceof Error
        ? cause.message
        : typeof cause === "object" && cause !== null && "message" in cause
          ? typeof cause.message === "string"
            ? cause.message
            : ""
          : "";
    const boundedMessage = truncateUtf8(message, BUILD_COMMAND_FAILURE_CAPTURE_METADATA_MAX_BYTES);
    const match = /signal:\s*['"]?([A-Z][A-Z0-9]*)/iu.exec(boundedMessage);
    const signal = match?.[1]?.toUpperCase();
    return signal !== undefined && SAFE_FAILURE_SIGNAL_NAMES.has(signal) ? signal : null;
  } catch {
    return null;
  }
}

const BUILD_COMMAND_FAILURE_DIAGNOSTIC_FIELD_MAX_BYTES = 128;
const SAFE_BUILD_COMMAND_CODE_PATTERN = /^(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/u;
const SAFE_BUILD_COMMAND_SYSCALL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SAFE_BUILD_COMMAND_DIAGNOSTIC_CATEGORIES = new Set<
  BuildCommandFailureDiagnostics["category"]
>(["spawn", "process"]);

function readFailureCauseField(cause: unknown, field: "code" | "errno" | "syscall"): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  try {
    return (cause as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function normalizeBuildCommandFailureDiagnosticText(
  value: unknown,
  pattern: RegExp,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = truncateUtf8(value, BUILD_COMMAND_FAILURE_DIAGNOSTIC_FIELD_MAX_BYTES).trim();
  pattern.lastIndex = 0;
  if (pattern.test(trimmed)) {
    pattern.lastIndex = 0;
    return truncateUtf8(trimmed, BUILD_COMMAND_FAILURE_DIAGNOSTIC_FIELD_MAX_BYTES);
  }
  pattern.lastIndex = 0;
  return null;
}

function sanitizeFailureDiagnosticErrno(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 1_000_000_000
    ? value
    : null;
}

export function normalizeBuildCommandFailureDiagnostics(input: {
  readonly category?: unknown;
  readonly cause?: unknown;
}): BuildCommandFailureDiagnostics {
  const category =
    typeof input?.category === "string" &&
    SAFE_BUILD_COMMAND_DIAGNOSTIC_CATEGORIES.has(
      input.category as BuildCommandFailureDiagnostics["category"],
    )
      ? (input.category as "spawn" | "process")
      : "unknown";
  return {
    category,
    code: normalizeBuildCommandFailureDiagnosticText(
      readFailureCauseField(input.cause, "code"),
      SAFE_BUILD_COMMAND_CODE_PATTERN,
    ),
    errno: sanitizeFailureDiagnosticErrno(readFailureCauseField(input.cause, "errno")),
    syscall: normalizeBuildCommandFailureDiagnosticText(
      readFailureCauseField(input.cause, "syscall"),
      SAFE_BUILD_COMMAND_SYSCALL_PATTERN,
    ),
  };
}

function makeBuildCommandFailureReceipt(input: {
  readonly captureMode: BuildCommandFailureCaptureMode;
  readonly command: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cause: string;
  readonly diagnostics: BuildCommandFailureDiagnostics;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAtMs: number;
}): BuildCommandFailureReceipt {
  const endedAtMs = Date.now();
  const suppressed = input.captureMode === "suppressed";
  return {
    command: suppressed
      ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED
      : truncateUtf8(input.command, BUILD_COMMAND_FAILURE_COMMAND_MAX_BYTES),
    pid: input.pid,
    exitCode: input.exitCode,
    signal: input.signal,
    cause: suppressed
      ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED
      : truncateUtf8(input.cause, BUILD_COMMAND_FAILURE_CAUSE_MAX_BYTES),
    diagnostics: input.diagnostics,
    stdout: suppressed
      ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED
      : truncateUtf8(input.stdout, BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES, true),
    stderr: suppressed
      ? BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED
      : truncateUtf8(input.stderr, BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES, true),
    startedAt: new Date(input.startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - input.startedAtMs),
  };
}

function releaseBuildCommandFailurePolicyValues(
  _policy: unknown,
): NormalizedBuildCommandFailurePolicy {
  return Object.freeze({
    mode: "suppressed" as const,
    values: Object.freeze([] as string[]),
    reason: "capture-policy-released",
    acceptedValueUtf8Bytes: 0,
  });
}

function snapshotBuildCommandFailurePolicy(
  controller: BuildCommandFailureCaptureController,
): BuildCommandFailureCapturePolicy {
  const reason = controller.isReleased() ? "capture-policy-released" : "capture-policy-snapshot";
  return suppressedCapturePolicy(
    boundCaptureMetadata(reason, BUILD_COMMAND_FAILURE_CAPTURE_METADATA_MAX_BYTES),
  );
}

export const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options?: {
    readonly timeoutMs?: number;
    readonly timeoutMessage?: string;
    readonly captureOutput?: boolean;
    readonly verbose?: boolean;
    readonly onCaptureLifecycleForTest?:
      | ((event: BuildCommandFailureCaptureLifecycleEvent) => void)
      | undefined;
  },
) {
  const startedAtMs = Date.now();
  const captureOutput = options?.captureOutput === true;
  let suppressionNoticeWritten = false;
  const writeSuppressionNotice = (): void => {
    if (suppressionNoticeWritten) return;
    if (options?.verbose !== true && !captureOutput) return;
    suppressionNoticeWritten = true;
    const output = BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED;
    if (options?.verbose === true) process.stdout.write(output);
    else process.stderr.write(output);
  };
  const commandEnvironment =
    command._tag === "StandardCommand" && command.options.env !== undefined
      ? command.options.env
      : undefined;
  let capturePolicy = createBuildCommandFailureCapturePolicy(
    commandEnvironment === undefined ? undefined : { additionalEnvironment: commandEnvironment },
  );
  const sharedController = createBuildCommandFailureCaptureController(capturePolicy, () => {
    writeSuppressionNotice();
  });
  const sanitizer = createBuildCommandFailureTextSanitizer(
    undefined,
    capturePolicy,
    sharedController,
  );
  const commandPresentation = safeCommandPresentation(command, sanitizer);
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnResult = yield* commandSpawner.spawn(command).pipe(
    Effect.match({
      onFailure: (cause) => ({ _tag: "failure" as const, cause }),
      onSuccess: (child) => ({ _tag: "success" as const, child }),
    }),
  );

  if (spawnResult._tag === "failure") {
    const receiptCaptureMode = sharedController.mode();
    sanitizer.dispose();
    capturePolicy = releaseBuildCommandFailurePolicyValues(capturePolicy);
    sharedController.releasePolicyReference();
    sharedController.dispose();
    const failureReceipt = makeBuildCommandFailureReceipt({
      captureMode: receiptCaptureMode,
      command: commandPresentation,
      pid: null,
      exitCode: null,
      signal: null,
      cause: "spawn-failed",
      diagnostics: normalizeBuildCommandFailureDiagnostics({
        category: "spawn",
        cause: spawnResult.cause,
      }),
      stdout: "",
      stderr: "",
      startedAtMs,
    });
    return yield* new BuildScriptError({
      message:
        receiptCaptureMode === "suppressed"
          ? `Failed to spawn command: ${BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED}`
          : `Failed to spawn command: ${commandPresentation}`,
      cause: failureReceipt.cause,
      failureReceipt,
    });
  }

  const child = spawnResult.child;
  const stdoutCallbacks: BuildCommandFailureSanitizerCallbacks =
    options?.verbose === true
      ? {
          onOutputText: (text: string) => process.stdout.write(text),
        }
      : {};
  const stderrCallbacks: BuildCommandFailureSanitizerCallbacks = {
    onOutputText: (text: string) => process.stderr.write(text),
  };
  const stdoutCapture = captureOutput
    ? createBuildCommandFailureCapture(capturePolicy, stdoutCallbacks, sharedController)
    : undefined;
  const stderrCapture = captureOutput
    ? createBuildCommandFailureCapture(capturePolicy, stderrCallbacks, sharedController)
    : undefined;
  sanitizer.dispose();
  capturePolicy = releaseBuildCommandFailurePolicyValues(capturePolicy);
  sharedController.releasePolicyReference();
  let stdoutFiber;
  let stderrFiber;
  if (captureOutput) {
    stdoutFiber = yield* child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stdoutCapture?.append(chunk);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    stderrFiber = yield* child.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrCapture?.append(chunk);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  const exitEffect =
    options?.timeoutMs === undefined
      ? child.exitCode
      : child.exitCode.pipe(
          Effect.timeoutOrElse({
            duration: options.timeoutMs,
            onTimeout: () =>
              child.kill({ forceKillAfter: 2_000 }).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(
                    new BuildScriptError({
                      message:
                        options.timeoutMessage ?? `Command timed out after ${options.timeoutMs}ms`,
                      cause: "timeout",
                    }),
                  ),
                ),
              ),
          }),
        );
  const exitResult = yield* exitEffect.pipe(
    Effect.match({
      onFailure: (cause) => ({ exitCode: null, cause }),
      onSuccess: (exitCode) => ({ exitCode: Number(exitCode), cause: null }),
    }),
  );

  if (stdoutFiber) yield* Fiber.join(stdoutFiber);
  if (stderrFiber) yield* Fiber.join(stderrFiber);

  const finishCapture = (
    capture: BuildCommandFailureCapture | undefined,
    stream: "stdout" | "stderr",
  ): BuildCommandFailureFinalCaptureResult | undefined => {
    if (capture === undefined) return undefined;
    const beforeSnapshot = snapshotBuildCommandFailurePolicy(sharedController);
    const beforeAccounting = capture.accounting();
    options?.onCaptureLifecycleForTest?.({
      stream,
      phase: "before-finish",
      retainedBytes: capture.retainedBytes,
      localSensitiveValueCount: capture.localSensitiveValueCount,
      hasSuppressionCallback: sharedController.hasSuppressionCallback(),
      listenerCount: sharedController.listenerCount(),
      repeatFinalResultEqual: false,
      snapshotMode: beforeSnapshot.mode,
      snapshotAcceptedSensitiveValueCount: beforeSnapshot.values.length,
      snapshotAcceptedSensitiveValueUtf8Bytes: beforeSnapshot.acceptedValueUtf8Bytes,
      accountingMode: beforeAccounting.mode,
      accountingAcceptedSensitiveValueCount: beforeAccounting.acceptedSensitiveValueCount,
      accountingAcceptedSensitiveValueUtf8Bytes: beforeAccounting.acceptedSensitiveValueUtf8Bytes,
    });
    const result = capture.finishAndDispose();
    const repeated =
      options?.onCaptureLifecycleForTest === undefined ? undefined : capture.finishAndDispose();
    if (stream === "stderr") sharedController.dispose();
    const afterSnapshot = snapshotBuildCommandFailurePolicy(sharedController);
    const afterAccounting = result.accounting;
    options?.onCaptureLifecycleForTest?.({
      stream,
      phase: "after-dispose",
      retainedBytes: capture.retainedBytes,
      localSensitiveValueCount: capture.localSensitiveValueCount,
      hasSuppressionCallback: sharedController.hasSuppressionCallback(),
      listenerCount: sharedController.listenerCount(),
      repeatFinalResultEqual:
        repeated === undefined || JSON.stringify(result) === JSON.stringify(repeated),
      snapshotMode: afterSnapshot.mode,
      snapshotAcceptedSensitiveValueCount: afterSnapshot.values.length,
      snapshotAcceptedSensitiveValueUtf8Bytes: afterSnapshot.acceptedValueUtf8Bytes,
      accountingMode: afterAccounting.mode,
      accountingAcceptedSensitiveValueCount: afterAccounting.acceptedSensitiveValueCount,
      accountingAcceptedSensitiveValueUtf8Bytes: afterAccounting.acceptedSensitiveValueUtf8Bytes,
    });
    return result;
  };
  const stdoutResult = finishCapture(stdoutCapture, "stdout");
  const stderrResult = finishCapture(stderrCapture, "stderr");
  const stdout = stdoutResult?.receiptText ?? "";
  const stderr = stderrResult?.receiptText ?? "";
  const receiptCaptureMode =
    stderrResult?.accounting.mode ?? stdoutResult?.accounting.mode ?? sharedController.mode();
  if (!captureOutput) sharedController.dispose();

  if (exitResult.cause !== null || exitResult.exitCode !== 0) {
    const signal = resolveFailureSignal(exitResult.cause);
    const causeText =
      signal !== null
        ? `signal:${signal}`
        : exitResult.exitCode !== null
          ? `exit-code:${exitResult.exitCode}`
          : exitResult.cause instanceof BuildScriptError && exitResult.cause.cause === "timeout"
            ? "timeout"
            : "process-failed";
    const failureReceipt = makeBuildCommandFailureReceipt({
      captureMode: receiptCaptureMode,
      command: commandPresentation,
      pid: Number(child.pid),
      exitCode: exitResult.exitCode,
      signal,
      cause: causeText,
      diagnostics: normalizeBuildCommandFailureDiagnostics({
        category: "process",
        cause: exitResult.cause,
      }),
      stdout,
      stderr,
      startedAtMs,
    });
    return yield* new BuildScriptError({
      message:
        receiptCaptureMode === "suppressed"
          ? `Command failed: ${BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED}`
          : exitResult.cause === null
            ? `Command exited with non-zero exit code (${exitResult.exitCode})`
            : signal === null
              ? causeText === "timeout"
                ? "Command timed out"
                : `Command failed: ${commandPresentation}`
              : `Command terminated by signal (${signal})`,
      cause: failureReceipt.cause,
      failureReceipt,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          env: createNonSigningSubprocessEnvironment(process.env),
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          env: createNonSigningSubprocessEnvironment(process.env),
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        env: createNonSigningSubprocessEnvironment(process.env),
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modernIconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(modernIconSource))) {
      return yield* new BuildScriptError({
        message: `Production macOS icon source is missing at ${modernIconSource}`,
      });
    }
    const legacyIconSource = yield* ProductionMacLegacyIconSource;
    if (!(yield* fs.exists(legacyIconSource))) {
      return yield* new BuildScriptError({
        message: `Production legacy macOS icon source is missing at ${legacyIconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "moss-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");
    const dockIconPngPath = path.join(stageResourcesDir, "dock-icon.png");

    yield* runCommand(
      ChildProcess.make({
        env: createNonSigningSubprocessEnvironment(process.env),
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${modernIconSource} --out ${iconPngPath}`,
    );

    // The solid ICNS is the bundle icon on every macOS release; Icon Composer glass alters the mark.
    yield* runCommand(
      ChildProcess.make({
        env: createNonSigningSubprocessEnvironment(process.env),
        ...commandOutputOptions(verbose),
      })`sips -z 1024 1024 ${legacyIconSource} --out ${dockIconPngPath}`,
    );

    yield* generateMacIconSet(legacyIconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionLinuxIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionWindowsIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

interface GitHubPublishConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly releaseType: "release";
}

// The public release repository is the default so every packaged Moss ships
// with app-update.yml and can discover newer releases. `GITHUB_REPOSITORY` is
// deliberately not consulted: in CI it names the private source repository,
// which must never be embedded as an updater feed.
export function resolveGitHubPublishConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<GitHubPublishConfig | undefined, BuildScriptError> {
  const rawRepo =
    env.MOSS_DESKTOP_UPDATE_REPOSITORY?.trim() || MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY;
  const disabled = rawRepo.toLowerCase() === MOSS_DESKTOP_UPDATE_REPOSITORY_DISABLED;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!disabled && (!owner || !repo || rest.length > 0)) {
    return Effect.fail(
      new BuildScriptError({
        message: `MOSS_DESKTOP_UPDATE_REPOSITORY must be "owner/repo" or "${MOSS_DESKTOP_UPDATE_REPOSITORY_DISABLED}", received "${rawRepo}".`,
      }),
    );
  }

  const config: GitHubPublishConfig | undefined =
    disabled || !owner || !repo
      ? undefined
      : { provider: "github", owner, repo, releaseType: "release" };
  return Effect.succeed(config);
}

const verifyStagedNodePty = Effect.fn("verifyStagedNodePty")(function* (
  stageAppDir: string,
  verbose: boolean,
) {
  const smokeScript = yield* NodePtySmokeScript;
  yield* Effect.log("[desktop-artifact] Verifying staged node-pty native PTY...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: {
        ...createNonSigningSubprocessEnvironment(process.env),
        MOSS_NODE_PTY_SMOKE_REQUIRE_ROOT: stageAppDir,
      },
      ...commandOutputOptions(verbose),
      shell: process.platform === "win32",
    })`node ${smokeScript}`,
    {
      timeoutMs: NODE_PTY_SMOKE_TIMEOUT_MS,
      timeoutMessage: `Staged node-pty smoke did not exit within ${NODE_PTY_SMOKE_TIMEOUT_MS}ms`,
    },
  );
});

// Package managers can silently skip tracked patches when the staged install
// diverges from the repo setup (that shipped broken Windows provider updates
// in v0.5.2–v0.5.5), so fail the build unless every exact patched hunk is present
// at its expected post-image location.
const verifyStagedPatchedDependencies = Effect.fn("verifyStagedPatchedDependencies")(function* (
  repoRoot: string,
  stageAppDir: string,
  patchedDependencies: Readonly<Record<string, string>>,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.log("[desktop-artifact] Verifying staged patched dependencies...");
  for (const [dependency, patchRelativePath] of Object.entries(patchedDependencies)) {
    const versionDelimiter = dependency.indexOf("@", 1);
    const packageName =
      versionDelimiter === -1 ? dependency : dependency.slice(0, versionDelimiter);
    const patchContents = yield* fs.readFileString(
      path.join(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, patchRelativePath),
    );
    const expectations = parsePatchFileExpectations(patchContents);
    if (expectations.length === 0) {
      return yield* new BuildScriptError({
        message: `Tracked patch ${patchRelativePath} contains no verifiable file hunks.`,
      });
    }
    for (const expectation of expectations) {
      const relativePath = expectation.targetFile ?? expectation.sourceFile;
      if (!relativePath) {
        return yield* new BuildScriptError({
          message: `Tracked patch ${patchRelativePath} has no source or target path.`,
        });
      }
      const stagedFilePath = path.join(stageAppDir, "node_modules", packageName, relativePath);
      if (expectation.targetFile === null) {
        if (yield* fs.exists(stagedFilePath)) {
          return yield* new BuildScriptError({
            message: `Deleted patched dependency file is still present in the stage: ${stagedFilePath} (expected by ${patchRelativePath}).`,
          });
        }
        continue;
      }
      const stagedContents = yield* fs.readFileString(stagedFilePath).pipe(
        Effect.mapError(
          (cause) =>
            new BuildScriptError({
              message: `Patched dependency file is missing from the stage: ${stagedFilePath} (expected by ${patchRelativePath}).`,
              cause,
            }),
        ),
      );
      yield* Effect.try({
        try: () => assertPatchPostImage(expectation, stagedContents),
        catch: (cause) =>
          new BuildScriptError({
            message: `Staged dependency ${packageName} does not match ${patchRelativePath}. The tracked patch was not applied at its expected hunk: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
    }
  }
});

const rebuildStagedLinuxNodePty = Effect.fn("rebuildStagedLinuxNodePty")(function* (
  stageAppDir: string,
  arch: "arm64" | "x64",
  electronVersion: string,
  verbose: boolean,
) {
  const repoRoot = yield* RepoRoot;
  const rebuildInput = yield* Effect.try({
    try: () => ({
      cliPath: resolveElectronRebuildCli(repoRoot),
      args: createStagedLinuxNodePtyRebuildArgs({
        arch,
        electronVersion,
        stageAppDir,
      }),
    }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Could not prepare the staged Linux node-pty rebuild: ${cause.message}`
            : "Could not prepare the staged Linux node-pty rebuild.",
        cause,
      }),
  });

  yield* Effect.log(
    `[desktop-artifact] Rebuilding staged node-pty ${arch} for Electron ${electronVersion}...`,
  );
  yield* runCommand(
    ChildProcess.make("node", [rebuildInput.cliPath, ...rebuildInput.args], {
      cwd: stageAppDir,
      env: createNonSigningSubprocessEnvironment(process.env),
      ...commandOutputOptions(verbose),
    }),
  );
});

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
  releaseMode: DesktopReleaseMode,
  mockUpdates: boolean,
  mockUpdateServerPort: string | undefined,
  includeProductionPublicConfig: boolean,
  electronDist: ElectronDistProvenance | undefined,
  includeMossCanvasBundle: boolean,
) {
  const buildConfig: Record<string, unknown> = {
    appId: MOSS_PRODUCTION_BUNDLE_ID,
    productName,
    protocols: [AUTH_CALLBACK_PROTOCOL_CONFIG],
    artifactName: "Moss-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
    extraResources: [
      BUNDLED_CODEX_EXTRA_RESOURCE,
      BUNDLED_CODEX_COMPLIANCE_EXTRA_RESOURCE,
      BUNDLED_CLAUDE_EXTRA_RESOURCE,
      ...(includeProductionPublicConfig ? [createMossProductionPublicConfigExtraResource()] : []),
      ...(includeMossCanvasBundle ? [MOSS_CANVAS_EXTRA_RESOURCE] : []),
    ],
    forceCodeSigning: signed,
  };
  // Mock feeds win so the local update smoke never talks to the real release
  // repository; every other build embeds the resolved GitHub feed.
  if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: `http://localhost:${mockUpdateServerPort ?? 3000}`,
      },
    ];
  } else {
    const publishConfig = yield* resolveGitHubPublishConfig();
    if (publishConfig) {
      buildConfig.publish = [publishConfig];
    }
  }

  const windowsSigningProvider =
    platform === "win" && signed
      ? yield* Effect.try({
          try: () => validateWindowsSigningEnvironment(process.env),
          catch: (cause) =>
            new BuildScriptError({
              message:
                cause instanceof Error
                  ? `Windows signing configuration failed: ${cause.message}`
                  : "Windows signing configuration failed.",
              cause,
            }),
        })
      : undefined;
  const windowsSslComSignOptions =
    windowsSigningProvider === "sslcom" ? yield* SslComESignerOptionsConfig : undefined;
  const macBuildOnlyPostPackagingSign =
    releaseMode === "build-only" && platform === "mac" && target === "zip" && !signed;

  const platformBuildConfigInput = {
    hostPlatform: process.platform,
    platform,
    target,
    signed,
    macBuildOnlyPostPackagingSign,
    ...(windowsSslComSignOptions ? { windowsSslComSignOptions } : {}),
  } as const;

  const platformBuildConfig = createDesktopPlatformBuildConfig(platformBuildConfigInput);
  Object.assign(buildConfig, platformBuildConfig);
  Object.assign(buildConfig, electronDistBuildConfig(electronDist));
  buildConfig.files = [
    ...(platformBuildConfig.files ?? []),
    BUNDLED_CODEX_COMPLIANCE_STAGE_ASAR_EXCLUSION,
  ];

  return {
    buildConfig,
    macBuildOnlyPostPackagingSign,
    windowsPublisherSubject: windowsSslComSignOptions?.publisherName ?? null,
  };
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir);
    return;
  }
});

const stageMacAppSnapHelper = Effect.fn("stageMacAppSnapHelper")(function* (
  stageAppDir: string,
  arch: typeof BuildArch.Type,
  verbose: boolean,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const buildScript = yield* AppSnapHelperBuildScript;
  const outputPath = path.join(stageAppDir, MAC_APPSNAP_HELPER_STAGE_PATH);

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* Effect.log(`[desktop-artifact] Building native AppSnap helper (${arch})...`);
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: createNonSigningSubprocessEnvironment(process.env),
      ...commandOutputOptions(verbose),
    })`node ${buildScript} --arch ${arch} --release --output ${outputPath}`,
  );

  if (!(yield* fs.exists(outputPath))) {
    return yield* new BuildScriptError({
      message: `AppSnap helper build completed but output was not found at ${outputPath}`,
    });
  }
});

const stageMacCanonicalFilesystemHelper = Effect.fn("stageMacCanonicalFilesystemHelper")(function* (
  stageAppDir: string,
  arch: typeof BuildArch.Type,
  verbose: boolean,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const buildScript = yield* CanonicalFilesystemHelperBuildScript;
  const outputPath = path.join(stageAppDir, MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH);

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* Effect.log(`[desktop-artifact] Building canonical filesystem helper (${arch})...`);
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: createNonSigningSubprocessEnvironment(process.env),
      ...commandOutputOptions(verbose),
    })`node ${buildScript} --arch ${arch} --output ${outputPath}`,
  );

  const metadataPath = path.join(stageAppDir, MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH);
  if (!(yield* fs.exists(outputPath)) || !(yield* fs.exists(metadataPath))) {
    return yield* new BuildScriptError({
      message: `Canonical filesystem helper build completed without binary or metadata at ${outputPath}`,
    });
  }
});

function isFileSystemNotFoundError(cause: unknown): cause is PlatformError.PlatformError {
  return (
    cause instanceof PlatformError.PlatformError &&
    cause.reason instanceof PlatformError.SystemError &&
    cause.reason._tag === "NotFound"
  );
}

function statIfPresent(
  fs: FileSystem.FileSystem,
  candidatePath: string,
): Effect.Effect<Option.Option<FileSystem.File.Info>, PlatformError.PlatformError> {
  return fs.stat(candidatePath).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isFileSystemNotFoundError, () => Effect.succeed(Option.none())),
  );
}

export const assertPackagedMacDeviceHelper = Effect.fn("assertPackagedMacDeviceHelper")(function* (
  stageDistDir: string,
  productName: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(stageDistDir);
  for (const entry of entries) {
    const entryPath = path.join(stageDistDir, entry);
    const entryInfo = yield* fs.stat(entryPath);
    if (entryInfo.type !== "Directory") {
      continue;
    }

    const appPath = path.join(entryPath, `${productName}.app`);
    const appInfo = Option.getOrUndefined(yield* statIfPresent(fs, appPath));
    if (appInfo?.type !== "Directory") {
      continue;
    }

    const helperRoot = path.join(appPath, "Contents", MAC_DEVICE_HELPER_RESOURCE_PATH);

    const buildScript = Option.getOrUndefined(
      yield* statIfPresent(fs, path.join(helperRoot, "build.sh")),
    );
    const mainSource = Option.getOrUndefined(
      yield* statIfPresent(fs, path.join(helperRoot, "Sources/main.swift")),
    );
    if (buildScript?.type === "File" && mainSource?.type === "File") {
      return;
    }
  }
  return yield* new BuildScriptError({
    message: `Packaged macOS app is missing physical device helper sources under Contents/${MAC_DEVICE_HELPER_RESOURCE_PATH}`,
  });
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const bundledClaudeRuntimes: ResolvedBundledClaudeRuntime[] = [];
  yield* Effect.try({
    try: () =>
      validateDesktopReleaseBuildPolicy({
        env: process.env,
        platform: options.platform,
        productionConfigMode: options.productionConfigMode,
        releaseMode: options.releaseMode,
        signed: options.signed,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Desktop release build policy failed: ${cause.message}`
            : "Desktop release build policy failed.",
        cause,
      }),
  });
  const requiresLinuxPublicRuntimeProbes = yield* Effect.try({
    try: () =>
      shouldRunBundledCodexLinuxPublicRuntimeProbes({
        platform: options.platform,
        arch: options.arch,
        releaseMode: options.releaseMode,
        signed: options.signed,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Bundled Codex platform release policy failed: ${cause.message}`
            : "Bundled Codex platform release policy failed.",
        cause,
      }),
  });
  const expectedAppleTeamIdentifier =
    options.platform === "mac" && options.signed ? process.env.APPLE_TEAM_ID?.trim() : undefined;
  if (options.platform === "mac" && options.signed && !expectedAppleTeamIdentifier) {
    return yield* new BuildScriptError({
      message: "Signed macOS artifacts require trusted APPLE_TEAM_ID release input.",
    });
  }
  const electronVersion = desktopPackageJson.dependencies.electron;
  const expectedWindowsPublisherName =
    options.platform === "win" && options.signed
      ? process.env.SSL_COM_PUBLISHER_NAME?.trim()
      : undefined;
  if (options.platform === "win" && options.signed && !expectedWindowsPublisherName) {
    return yield* new BuildScriptError({
      message: "Signed Windows artifacts require trusted SSL_COM_PUBLISHER_NAME release input.",
    });
  }
  const expectedWindowsCertificateSubjectDn =
    options.platform === "win" && options.signed
      ? process.env.SSL_COM_PUBLISHER_NAME?.trim()
      : undefined;
  const expectedWindowsCertificateThumbprint =
    options.platform === "win" && options.signed
      ? process.env.SSL_COM_CERTIFICATE_THUMBPRINT?.trim()
      : undefined;
  if (
    options.platform === "win" &&
    options.signed &&
    (!expectedWindowsCertificateSubjectDn || !expectedWindowsCertificateThumbprint)
  ) {
    return yield* new BuildScriptError({
      message:
        "Signed Windows artifacts require exact SSL_COM_PUBLISHER_NAME subject DN and SSL_COM_CERTIFICATE_THUMBPRINT release inputs.",
    });
  }
  const productionPublicConfigResource = yield* Effect.try({
    try: () =>
      createMossProductionPublicConfigResource({
        env: process.env,
        mode: options.productionConfigMode,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Strict production public configuration validation failed: ${cause.message}`
            : "Strict production public configuration validation failed.",
        cause,
      }),
  });

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }
  const nativeBuildHostIssue = validateDesktopNativeBuildHost({
    platform: options.platform,
    arch: options.arch,
    hostPlatform: process.platform,
    hostArch: process.arch,
  });
  if (nativeBuildHostIssue) {
    return yield* new BuildScriptError({
      message: nativeBuildHostIssue,
    });
  }

  const desktopStageInstallPackage = yield* Effect.try({
    try: () => {
      const expected = createDesktopStageInstallPackageJson({
        rootPackageJson,
        serverPackageJson,
        desktopPackageJson,
      });
      assertDesktopStageInstallPackageMatches(committedDesktopStageInstallPackageJson, expected);
      return expected;
    },
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Could not validate the frozen desktop stage dependency manifest: ${cause.message}`
            : "Could not validate the frozen desktop stage dependency manifest.",
        cause,
      }),
  });
  if (
    desktopStageInstallPackage.dependencies[BUNDLED_CODEX_PACKAGE_NAME] !==
    MOSS_BUNDLED_CODEX_VERSION
  ) {
    return yield* new BuildScriptError({
      message: `Desktop packaging requires ${BUNDLED_CODEX_PACKAGE_NAME}@${MOSS_BUNDLED_CODEX_VERSION}.`,
    });
  }

  const appVersion = options.version ?? serverPackageJson.version;
  const hasSourceCommit = options.sourceCommit !== undefined;
  const hasLockfileSha256 = options.lockfileSha256 !== undefined;
  const exactProvenanceRequested =
    hasSourceCommit || hasLockfileSha256 || options.sourceTag !== undefined;
  if (exactProvenanceRequested && (!hasSourceCommit || !hasLockfileSha256 || !options.version)) {
    return yield* new BuildScriptError({
      message:
        "Exact release provenance requires an explicit build version, source commit, and lockfile SHA-256 together.",
    });
  }

  const resolvedCommitHash = resolveGitCommitHash(repoRoot);
  if (options.sourceCommit && !/^[0-9a-f]{40}$/i.test(options.sourceCommit)) {
    return yield* new BuildScriptError({
      message: `Expected a full 40-character source commit, got '${options.sourceCommit}'.`,
    });
  }
  if (options.sourceCommit && resolvedCommitHash !== options.sourceCommit.toLowerCase()) {
    return yield* new BuildScriptError({
      message: `Release source commit mismatch: expected ${options.sourceCommit}, got ${resolvedCommitHash ?? "unknown"}.`,
    });
  }
  const commitHash = resolvedCommitHash ?? "unknown";
  const resolvedLockfileSha256 = resolveLockfileSha256(repoRoot);
  if (options.lockfileSha256 && !/^[0-9a-f]{64}$/i.test(options.lockfileSha256)) {
    return yield* new BuildScriptError({
      message: `Expected a 64-character lockfile SHA-256, got '${options.lockfileSha256}'.`,
    });
  }
  if (options.lockfileSha256 && resolvedLockfileSha256 !== options.lockfileSha256.toLowerCase()) {
    return yield* new BuildScriptError({
      message: `Release lockfile digest mismatch: expected ${options.lockfileSha256}, got ${resolvedLockfileSha256}.`,
    });
  }
  if (options.sourceTag && options.sourceTag !== `v${appVersion}`) {
    return yield* new BuildScriptError({
      message: `Release source tag ${options.sourceTag} does not match artifact version ${appVersion}.`,
    });
  }
  if (exactProvenanceRequested) {
    const gitStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: createNonSigningSubprocessEnvironment(process.env),
    });
    if (gitStatus.status !== 0) {
      return yield* new BuildScriptError({
        message: `Unable to inspect release worktree: ${gitStatus.stderr.trim() || "git failed"}.`,
      });
    }
    if (gitStatus.stdout.trim().length > 0) {
      return yield* new BuildScriptError({
        message: "Release source worktree is not clean; refusing to stage uncommitted bytes.",
      });
    }
  }
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `moss-desktop-${options.platform}-stage-`,
  });
  const stagedElectronDist = yield* Effect.try({
    try: () =>
      stageElectronDist({
        rawPath: options.electronDist,
        stageRoot,
        platform: options.platform,
        arch: options.arch,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Offline Electron dist staging failed: ${cause.message}`
            : "Offline Electron dist staging failed.",
        cause,
      }),
  });
  const electronDistProvenance = stagedElectronDist
    ? yield* Effect.try({
        try: () =>
          resolveElectronDistProvenance({
            distPath: stagedElectronDist.realpath,
            sourceRealpath: stagedElectronDist.sourceRealpath,
            platform: options.platform,
            arch: options.arch,
            expectedVersion: electronVersion,
          }),
        catch: (cause) =>
          new BuildScriptError({
            message:
              cause instanceof Error
                ? `Offline Electron dist validation failed: ${cause.message}`
                : "Offline Electron dist validation failed.",
            cause,
          }),
      })
    : undefined;

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const buildScopedBunCacheDir =
    options.platform === "mac" && !options.signed && !options.keepStage
      ? path.join(stageRoot, "bun-install-cache")
      : undefined;
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        env: createDesktopBuildSubprocessEnvironment(process.env),
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
        // Release artifacts must be rebuilt from the requested source commit.
        // A normal Turbo cache hit can otherwise restore a server bundle that
        // does not include root-level build inputs (for example scripts/lib
        // helpers).
      })`bun run build:desktop --force`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  const thirdPartyNoticesSource = path.join(repoRoot, "THIRD_PARTY_NOTICES.md");
  if (!(yield* fs.exists(thirdPartyNoticesSource))) {
    return yield* new BuildScriptError({
      message: "Missing THIRD_PARTY_NOTICES.md required by the Moss provider-channel build.",
    });
  }
  yield* fs.copyFile(thirdPartyNoticesSource, path.join(stageAppDir, "THIRD_PARTY_NOTICES.md"));
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

  // The complete Canvas workspace ships as a prepared, self-contained bundle.
  // The source pin and receipt bind the renderer and durable backend modules
  // to one reviewed Canvas commit. Missing or stale bundles fail the build.
  const mossCanvasBundleSource = path.join(repoRoot, MOSS_CANVAS_BUNDLE_DIR);
  const stagedMossCanvasBundle = yield* Effect.try({
    try: () =>
      validatePinnedMossCanvasBundle(mossCanvasBundleSource, readMossCanvasSourcePin(repoRoot)),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Prepared Moss Canvas bundle is incomplete: ${cause.message}`
            : "Prepared Moss Canvas bundle is incomplete.",
        cause,
      }),
  });
  if (stagedMossCanvasBundle) {
    yield* fs.copy(mossCanvasBundleSource, path.join(stageAppDir, MOSS_CANVAS_BUNDLE_DIR));
    yield* Effect.log(
      `[desktop-artifact] Staged Moss Canvas workspace bundle (${stagedMossCanvasBundle.fileCount} files, sha256 ${stagedMossCanvasBundle.sha256}).`,
    );
  }

  const stagedCodexComplianceBundle = yield* Effect.try({
    try: () => {
      const bundle = stageBundledCodexComplianceBundle({
        repoRoot,
        stageAppDir,
        expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
      });
      assertBundledCodexReleaseApproved({ directory: bundle.directory });
      return bundle;
    },
    catch: (cause) =>
      new BuildScriptError({
        message: "Repository-owned bundled Codex compliance staging failed.",
        cause,
      }),
  });
  yield* Effect.log(
    `[desktop-artifact] Staged approved Codex ${MOSS_BUNDLED_CODEX_VERSION} source and license closure (${stagedCodexComplianceBundle.componentCount} components, ${stagedCodexComplianceBundle.licenseTextCount} license texts).`,
  );

  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);

  yield* stageMossProductionPublicConfigResource(stageResourcesDir, productionPublicConfigResource);
  if (productionPublicConfigResource) {
    yield* Effect.log("[desktop-artifact] Staged validated Moss production public configuration.");
  }

  if (options.platform === "mac") {
    yield* stageMacAppSnapHelper(stageAppDir, options.arch, options.verbose);
    yield* stageMacCanonicalFilesystemHelper(stageAppDir, options.arch, options.verbose);
  }

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));
  if (!productionPublicConfigResource) {
    // Copy can merge an existing mirror. Neither runtime lookup location may
    // retain a checked-in production config when this build explicitly opts out.
    yield* stageMossProductionPublicConfigResource(
      path.join(stageAppDir, "apps/desktop/prod-resources"),
      null,
    );
  }

  const resolvedBuildConfig = yield* createBuildConfig(
    options.platform,
    options.target,
    desktopPackageJson.productName ?? "Moss",
    options.signed,
    options.releaseMode,
    options.mockUpdates,
    options.mockUpdateServerPort,
    productionPublicConfigResource !== null,
    electronDistProvenance,
    stagedMossCanvasBundle !== null,
  );

  const stagePackageJson: StagePackageJson = {
    name: "moss-desktop",
    version: appVersion,
    buildVersion: appVersion,
    mossCommitHash: commitHash,
    mossLockfileSha256: resolvedLockfileSha256,
    mossSourceTag: options.sourceTag ?? null,
    mossWindowsPublisherSubject: resolvedBuildConfig.windowsPublisherSubject,
    private: true,
    description: "Moss desktop build",
    author: "Emanuele Di Pietro",
    main: "apps/desktop/dist-electron/main.js",
    build: resolvedBuildConfig.buildConfig,
    dependencies: {
      ...desktopStageInstallPackage.dependencies,
    },
    optionalDependencies: resolveBundledCodexStageOptionalDependencies({
      platform: options.platform,
      arch: options.arch,
    }),
    devDependencies: {
      ...desktopStageInstallPackage.devDependencies,
    },
    overrides: {
      ...desktopStageInstallPackage.overrides,
    },
    patchedDependencies: {
      ...desktopStageInstallPackage.patchedDependencies,
    },
  };

  const stageInstallPackageJsonString = yield* encodeJsonString(desktopStageInstallPackage);
  yield* fs.writeFileString(
    path.join(stageAppDir, "package.json"),
    `${stageInstallPackageJsonString}\n`,
  );
  const stageLockSource = path.join(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, "bun.lock");
  if (!(yield* fs.exists(stageLockSource))) {
    return yield* new BuildScriptError({
      message: `Frozen desktop stage lockfile does not exist at ${stageLockSource}.`,
    });
  }
  yield* fs.copy(stageLockSource, path.join(stageAppDir, "bun.lock"));
  for (const patchPath of Object.values(desktopStageInstallPackage.patchedDependencies)) {
    if (
      path.isAbsolute(patchPath) ||
      patchPath.split(/[\\/]/).includes("..") ||
      !patchPath.startsWith("patches/")
    ) {
      return yield* new BuildScriptError({
        message: `Frozen desktop stage patch path is unsafe: ${patchPath}.`,
      });
    }
    const patchSource = path.join(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, patchPath);
    if (!(yield* fs.exists(patchSource))) {
      return yield* new BuildScriptError({
        message: `Frozen desktop stage patch does not exist at ${patchSource}.`,
      });
    }
    yield* fs.makeDirectory(path.dirname(path.join(stageAppDir, patchPath)), {
      recursive: true,
    });
    yield* fs.copyFile(patchSource, path.join(stageAppDir, patchPath));
  }

  const codexInstallTarget = resolveBundledCodexInstallTarget({
    platform: options.platform,
    arch: options.arch,
  });
  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make(
      "bun",
      [
        "install",
        "--production",
        "--linker=hoisted",
        "--frozen-lockfile",
        "--ignore-scripts",
        `--os=${codexInstallTarget.os}`,
        `--cpu=${codexInstallTarget.cpu}`,
        ...(buildScopedBunCacheDir ? [`--cache-dir=${buildScopedBunCacheDir}`] : []),
      ],
      {
        cwd: stageAppDir,
        env: createNonSigningSubprocessEnvironment(process.env),
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      },
    ),
  );

  yield* verifyStagedPatchedDependencies(
    repoRoot,
    stageAppDir,
    desktopStageInstallPackage.patchedDependencies,
  );

  const stagedDiffResolutions = yield* Effect.try({
    try: () => assertStagedDiffDependencies(stageAppDir),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Staged dependency consistency check failed: ${cause.message}`
            : "Staged dependency consistency check failed.",
        cause,
      }),
  });
  yield* Effect.log(
    `[desktop-artifact] Verified exact staged diff resolutions: ${stagedDiffResolutions
      .map(({ consumer, diffVersion }) => `${consumer}=${diffVersion}`)
      .join(", ")}.`,
  );

  // The fixed dependency-only package.json is what the reviewed lock protects.
  // After installation, replace it with the release metadata/build config;
  // dependency fields remain byte-for-byte equivalent to the locked manifest.
  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  const stagedBundledCodexRuntime = yield* Effect.try({
    try: () => {
      const runtime = validateStagedBundledCodexRuntime({
        nodeModulesDir: path.join(stageAppDir, "node_modules"),
        platform: options.platform,
        arch: options.arch,
      });
      validateStagedBundledCodexPayloadIntegrity({
        nodeModulesDir: path.join(stageAppDir, "node_modules"),
        complianceDirectory: stagedCodexComplianceBundle.directory,
        targetTriples: runtime.targets.map((target) => target.targetTriple),
      });
      return runtime;
    },
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Installed bundled Codex validation failed: ${cause.message}`
            : "Installed bundled Codex validation failed.",
        cause,
      }),
  });

  yield* Effect.log("[desktop-artifact] Validating and staging bundled Codex runtime...");
  for (const target of resolveBundledCodexTargets({
    platform: options.platform,
    arch: options.arch,
  })) {
    const runtime = yield* Effect.try({
      try: () => resolveBundledCodexRuntime({ stageAppDir, target }),
      catch: (cause) =>
        new BuildScriptError({
          message:
            cause instanceof Error
              ? `Bundled Codex validation failed: ${cause.message}`
              : "Bundled Codex validation failed.",
          cause,
        }),
    });
    const destination = path.join(stageAppDir, BUNDLED_CODEX_RUNTIME_DIR, target.targetTriple);
    yield* fs.copy(runtime.sourceDir, destination);
    if (options.platform !== "win") {
      yield* fs.chmod(path.join(destination, "bin", target.executable), 0o755);
      yield* fs.chmod(path.join(destination, "bin", target.codeModeHost), 0o755);
      yield* fs.chmod(path.join(destination, "codex-path", target.ripgrep), 0o755);
    }
  }

  const stagedLinuxRuntimeReceipt = yield* Effect.try({
    try: () => {
      validateStagedBundledCodexPayloadIntegrity({
        packagedResourcesDir: path.join(stageAppDir, "apps/desktop"),
        complianceDirectory: stagedCodexComplianceBundle.directory,
        targetTriples: stagedBundledCodexRuntime.targets.map((target) => target.targetTriple),
      });
      return requiresLinuxPublicRuntimeProbes
        ? validateBundledCodexLinuxX64PublicRuntime({
            resourcesDir: path.join(stageAppDir, "apps/desktop"),
          })
        : null;
    },
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Copied bundled Codex payload validation failed: ${cause.message}`
            : "Copied bundled Codex payload validation failed.",
        cause,
      }),
  });
  if (stagedLinuxRuntimeReceipt) {
    yield* Effect.log(
      `[desktop-artifact] Staged public Linux Codex runtime probes passed (${stagedLinuxRuntimeReceipt.commands.length} commands, GLIBC<=${stagedLinuxRuntimeReceipt.maximumGlibcVersion}).`,
    );
  }

  const prunedCodexBuildPackages = yield* Effect.try({
    try: () => pruneBundledCodexBuildPackages({ stageAppDir }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Bundled Codex staging cleanup failed: ${cause.message}`
            : "Bundled Codex staging cleanup failed.",
        cause,
      }),
  });
  yield* Effect.log(
    `[desktop-artifact] Removed ${prunedCodexBuildPackages.removedPaths.length} build-only Codex package paths; copied runtime remains in extraResources.`,
  );

  yield* Effect.log("[desktop-artifact] Validating and staging bundled Claude runtime...");
  for (const target of resolveBundledClaudeTargets({
    platform: options.platform,
    arch: options.arch,
  })) {
    const runtime = yield* Effect.try({
      try: () => resolveBundledClaudeRuntime({ stageAppDir, target }),
      catch: (cause) =>
        new BuildScriptError({
          message:
            cause instanceof Error
              ? `Bundled Claude validation failed: ${cause.message}`
              : "Bundled Claude validation failed.",
          cause,
        }),
    });
    bundledClaudeRuntimes.push(runtime);
    const destination = path.join(
      stageAppDir,
      BUNDLED_CLAUDE_RUNTIME_DIR,
      target.resourceFolder,
      target.executable,
    );
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copy(runtime.sourcePath, destination);
    if (options.platform !== "win") {
      yield* fs.chmod(destination, 0o755);
    }
  }

  const bundledClaudeReleaseVerification = yield* Effect.try({
    try: () => createBundledClaudeReleaseVerificationReceipt(bundledClaudeRuntimes),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Bundled Claude release verification receipt failed: ${cause.message}`
            : "Bundled Claude release verification receipt failed.",
        cause,
      }),
  });
  yield* Effect.log(
    `[desktop-artifact] Bundled Claude ${BUNDLED_CLAUDE_AGENT_SDK_VERSION}/${BUNDLED_CLAUDE_CODE_VERSION} target execution probes passed.`,
  );

  const prunedClaudeNativePackages = yield* Effect.try({
    try: () => pruneBundledClaudeNativePackages({ stageAppDir }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Bundled Claude staging cleanup failed: ${cause.message}`
            : "Bundled Claude staging cleanup failed.",
        cause,
      }),
  });
  yield* Effect.log(
    `[desktop-artifact] Removed ${prunedClaudeNativePackages.removedPaths.length} build-only Claude native package paths; copied runtime remains in extraResources.`,
  );

  if (options.platform === "win") {
    const windowsArch = options.arch;
    if (windowsArch === "universal") {
      return yield* new BuildScriptError({
        message: "Windows node-pty staging does not support universal architecture.",
      });
    }
    const prunedNativeDependencies = yield* Effect.try({
      try: () =>
        pruneStagedWindowsNativeDependencies({
          stageAppDir,
          arch: windowsArch,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message:
            cause instanceof Error
              ? `Windows native dependency staging cleanup failed: ${cause.message}`
              : "Windows native dependency staging cleanup failed.",
          cause,
        }),
    });
    yield* Effect.log(
      `[desktop-artifact] Removed ${prunedNativeDependencies.removedPaths.length} non-target Windows native paths and retained ${prunedNativeDependencies.retainedNativeFiles.length} reviewed dependency payloads.`,
    );
  }

  if (options.platform === "linux") {
    if (options.arch === "universal") {
      return yield* new BuildScriptError({
        message: "Linux node-pty rebuild does not support universal architecture.",
      });
    }
    yield* rebuildStagedLinuxNodePty(
      stageAppDir,
      options.arch,
      desktopStageInstallPackage.devDependencies.electron,
      options.verbose,
    );
    yield* verifyStagedNodePty(stageAppDir, options.verbose);
  } else if (options.platform === "win" && process.platform === "win32") {
    yield* verifyStagedNodePty(stageAppDir, options.verbose);
  } else if (options.platform === "win") {
    yield* Effect.log(
      "[desktop-artifact] Skipping host execution of target Windows node-pty; static payload inventory and hashes remain enforced.",
    );
  }

  const buildEnv = createElectronBuilderEnvironment({
    env: resolvedBuildConfig.macBuildOnlyPostPackagingSign
      ? createMacBuildOnlySigningEnvironment(process.env)
      : process.env,
    platform: options.platform,
    signed: options.signed,
  });
  delete buildEnv.MOSS_DESKTOP_ELECTRON_DIST;

  if (process.platform === "win32") {
    const python = resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }
  if (options.platform === "win") {
    buildEnv.MOSS_WINDOWS_TARGET_ARCH = options.arch;
    buildEnv.MOSS_WINDOWS_SIGNED_BUILD = options.signed ? "1" : "0";
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderTargets = resolveDesktopBuilderCliTargets({
    platform: options.platform,
    target: options.target,
  });
  const electronBuilderCliPath = requireFromScriptsWorkspace.resolve("electron-builder/cli.js");
  yield* runCommand(
    ChildProcess.make(
      process.execPath,
      [
        ...(process.versions.bun ? ["--no-env-file"] : []),
        electronBuilderCliPath,
        "--projectDir",
        stageAppDir,
        platformConfig.cliFlag,
        ...builderTargets,
        `--${options.arch}`,
        "--publish",
        "never",
      ],
      {
        cwd: repoRoot,
        env: buildEnv,
        // Keep the scrubbed signing and executable-injection environment
        // explicit at this process boundary.
        extendEnv: false,
        ...builderCommandOutputOptions(),
      },
    ),
    { captureOutput: true, verbose: options.verbose },
  );

  if (electronDistProvenance) {
    yield* Effect.try({
      try: () => assertElectronDistProvenanceUnchanged(electronDistProvenance),
      catch: (cause) =>
        new BuildScriptError({
          message:
            cause instanceof Error
              ? `Offline Electron dist changed during electron-builder: ${cause.message}`
              : "Offline Electron dist changed during electron-builder.",
          cause,
        }),
    });
  }

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  if (resolvedBuildConfig.macBuildOnlyPostPackagingSign) {
    const runtimeForSigning = yield* Effect.try({
      try: () =>
        validateBuiltBundledCodexRuntime({
          stageDistDir,
          platform: options.platform,
          arch: options.arch,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: "Could not resolve the packaged application for build-only signing.",
          cause,
        }),
    });
    const appBundlePath = path.resolve(runtimeForSigning.resourcesDir, "..", "..");
    yield* runCommand(
      createMacBuildOnlySignCommand({
        executable: process.execPath,
        isBun: Boolean(process.versions.bun),
        appBundlePath,
        electronVersion,
        repoRoot,
        env: buildEnv,
      }),
      { captureOutput: true, verbose: options.verbose },
    );
  }

  const packagedBundledCodexValidation = yield* Effect.try({
    try: () => {
      const runtime = validateBuiltBundledCodexRuntime({
        stageDistDir,
        platform: options.platform,
        arch: options.arch,
      });
      const compliance = validatePackagedBundledCodexComplianceBundle({
        resourcesDir: runtime.resourcesDir,
        expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
      });
      const signedPayloadReceipt =
        options.platform === "mac" || options.signed
          ? validateSignedBundledCodexPayloadIntegrity({
              sourceResourcesDir: path.join(stageAppDir, "apps/desktop"),
              finalResourcesDir: runtime.resourcesDir,
              complianceDirectory: compliance.directory,
              targetTriples: runtime.targets.map((target) => target.targetTriple),
              platform: options.platform === "mac" ? "mac" : "win",
            })
          : null;
      if (!options.signed && options.platform !== "mac") {
        validateStagedBundledCodexPayloadIntegrity({
          packagedResourcesDir: runtime.resourcesDir,
          complianceDirectory: compliance.directory,
          targetTriples: runtime.targets.map((target) => target.targetTriple),
        });
      }
      const linuxRuntimeReceipt = requiresLinuxPublicRuntimeProbes
        ? validateBundledCodexLinuxX64PublicRuntime({ resourcesDir: runtime.resourcesDir })
        : null;
      const linuxLauncherIdentity = requiresLinuxPublicRuntimeProbes
        ? verifyBundledCodexLinuxLauncherIdentity({
            executablePath: path.join(runtime.resourcesDir, "..", "moss"),
            expectedExecutableFile: "moss",
            expectedRuntimeVersion: electronVersion,
          })
        : null;
      const windowsAuthenticodeReceipt =
        options.platform === "win" && options.signed
          ? verifyPackagedBundledCodexWindowsAuthenticode({
              stageDistDir,
              resourcesDir: runtime.resourcesDir,
              targetTriples: runtime.targets.map((target) => target.targetTriple),
              expectedMainExecutableName: `${desktopPackageJson.productName ?? "Moss"}.exe`,
              expectedInstallerFileName: `Moss-${appVersion}-${options.arch}.exe`,
              expectedPublisherName: expectedWindowsPublisherName!,
              expectedCertificateSubjectDn: expectedWindowsCertificateSubjectDn!,
              expectedCertificateThumbprint: expectedWindowsCertificateThumbprint!,
            })
          : null;
      const macBuildOnlySignatureReceipt =
        options.platform === "mac" && !options.signed
          ? verifyPackagedBundledCodexMacBuildOnlySignatures({
              appBundlePath: path.resolve(runtime.resourcesDir, "..", ".."),
              resourcesDir: runtime.resourcesDir,
              targetTriples: runtime.targets.map((target) => target.targetTriple),
            })
          : null;
      const macAsarIntegrityReceipt = resolvedBuildConfig.macBuildOnlyPostPackagingSign
        ? verifyPackagedAsarIntegrity(path.resolve(runtime.resourcesDir, "..", ".."))
        : null;
      return {
        runtime,
        compliance,
        signedPayloadReceipt,
        linuxRuntimeReceipt,
        linuxLauncherIdentity,
        windowsAuthenticodeReceipt,
        macBuildOnlySignatureReceipt,
        macAsarIntegrityReceipt,
      };
    },
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Packaged bundled Codex validation failed: ${cause.message}`
            : "Packaged bundled Codex validation failed.",
        cause,
      }),
  });
  if (packagedBundledCodexValidation.linuxRuntimeReceipt) {
    yield* Effect.log(
      `[desktop-artifact] Final public Linux Codex runtime probes passed (${packagedBundledCodexValidation.linuxRuntimeReceipt.commands.length} commands).`,
    );
  }
  if (packagedBundledCodexValidation.signedPayloadReceipt) {
    yield* Effect.log(
      `[desktop-artifact] Bound ${packagedBundledCodexValidation.signedPayloadReceipt.fileCount} final signed Codex payload files to the locked source (raw tree ${packagedBundledCodexValidation.signedPayloadReceipt.finalTreeSha256}, canonical tree ${packagedBundledCodexValidation.signedPayloadReceipt.canonicalContentTreeSha256}).`,
    );
  }
  if (packagedBundledCodexValidation.windowsAuthenticodeReceipt) {
    yield* Effect.log(
      `[desktop-artifact] Verified ${packagedBundledCodexValidation.windowsAuthenticodeReceipt.executableFiles.length} signed Windows runtime, app, and installer executables for ${packagedBundledCodexValidation.windowsAuthenticodeReceipt.certificateIdentity.subjectDn}.`,
    );
  }
  if (packagedBundledCodexValidation.macBuildOnlySignatureReceipt) {
    yield* Effect.log(
      `[desktop-artifact] Verified ${packagedBundledCodexValidation.macBuildOnlySignatureReceipt.signatures.length} ad-hoc macOS signature identities. This build-only candidate is not release eligible.`,
    );
  }

  if (options.platform === "mac") {
    yield* assertPackagedMacDeviceHelper(stageDistDir, desktopPackageJson.productName ?? "Moss");
  }

  if (buildScopedBunCacheDir) {
    yield* fs.remove(path.join(stageAppDir, "node_modules"), {
      recursive: true,
      force: true,
    });
    yield* fs.remove(buildScopedBunCacheDir, { recursive: true, force: true });
    yield* Effect.log(
      "[desktop-artifact] Released staged dependencies and build-scoped Bun cache before macOS archive verification.",
    );
  }

  if (options.platform === "mac" && options.target === "dmg" && options.signed) {
    yield* Effect.log("[desktop-artifact] Notarizing and validating signed macOS DMG...");
    const finalizedDmg = yield* Effect.tryPromise({
      try: () =>
        finalizeSignedMacDmg({
          stageDistDir,
          appleApiKey: buildEnv.APPLE_API_KEY,
          appleApiKeyId: buildEnv.APPLE_API_KEY_ID,
          appleApiIssuer: buildEnv.APPLE_API_ISSUER,
          verbose: options.verbose,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: "macOS DMG signing/notarization finalization failed.",
          cause,
        }),
    });
    yield* Effect.log(
      `[desktop-artifact] Signed and notarized macOS DMG (${finalizedDmg.dmgFileName}).`,
    );
  }

  if (options.platform === "mac") {
    yield* Effect.log("[desktop-artifact] Repacking and validating macOS update zip...");
    const finalizedZip = yield* Effect.tryPromise({
      try: () =>
        finalizeMacUpdateZip({
          stageDistDir,
          signed: options.signed,
          requireUpdateManifest: requiresMacUpdateManifest(options.releaseMode),
          verbose: options.verbose,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: "macOS update zip finalization failed.",
          cause,
        }),
    });
    if (finalizedZip.removedZipBlockmapPath) {
      yield* Effect.log(
        `[desktop-artifact] Removed stale macOS zip blockmap (${path.basename(finalizedZip.removedZipBlockmapPath)}).`,
      );
    }
    if (finalizedZip.updatedManifestPaths.length === 0) {
      yield* Effect.log(
        "[desktop-artifact] No macOS update manifest was emitted; retaining the build-only internal candidate without updater metadata.",
      );
    }
  }

  if (options.platform === "mac" && options.signed) {
    const macCodeSignatureReceipt = yield* Effect.try({
      try: () =>
        verifyPackagedBundledCodexMacCodeSignature({
          appBundlePath: path.resolve(
            packagedBundledCodexValidation.runtime.resourcesDir,
            "..",
            "..",
          ),
          resourcesDir: packagedBundledCodexValidation.runtime.resourcesDir,
          targetTriples: packagedBundledCodexValidation.runtime.targets.map(
            (target) => target.targetTriple,
          ),
          expectedTeamIdentifier: expectedAppleTeamIdentifier!,
          expectedBundleIdentifier: MOSS_PRODUCTION_BUNDLE_ID,
          requireNotarization: options.releaseMode === "publish",
        }),
      catch: (cause) =>
        new BuildScriptError({
          message:
            cause instanceof Error
              ? `Packaged macOS Codex signature verification failed: ${cause.message}`
              : "Packaged macOS Codex signature verification failed.",
          cause,
        }),
    });
    yield* Effect.log(
      `[desktop-artifact] Verified outer app and ${macCodeSignatureReceipt.runtimeExecutablePaths.length} nested Codex signatures for Apple team ${macCodeSignatureReceipt.teamIdentifier}${macCodeSignatureReceipt.notarizationValidated ? " with stapler/Gatekeeper proof" : ""}.`,
    );
  }

  const finalPackagedArtifactReceipt = yield* Effect.try({
    try: () => {
      if (options.platform === "mac" && !options.signed) {
        return verifyFinalBundledClaudeMacArtifacts({
          stageDistDir,
          arch: options.arch,
          ...(resolvedBuildConfig.macBuildOnlyPostPackagingSign
            ? { verifyAsarIntegrity: true }
            : {}),
          ...(builderTargets.includes("dmg")
            ? { dmgFileName: `Moss-${appVersion}-${options.arch}.dmg` }
            : {}),
          ...(builderTargets.includes("zip")
            ? { zipFileName: `Moss-${appVersion}-${options.arch}.zip` }
            : {}),
        });
      }
      if (options.platform === "mac" && options.signed) {
        return verifyFinalBundledCodexMacArtifacts({
          stageDistDir,
          sourceResourcesDir: path.join(stageAppDir, "apps/desktop"),
          expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
          arch: options.arch,
          targetTriples: packagedBundledCodexValidation.runtime.targets.map(
            (target) => target.targetTriple,
          ),
          expectedPayloadReceipt: packagedBundledCodexValidation.signedPayloadReceipt!,
          expectedTeamIdentifier: expectedAppleTeamIdentifier!,
          expectedBundleIdentifier: MOSS_PRODUCTION_BUNDLE_ID,
          requireNotarization: options.releaseMode === "publish",
          ...(builderTargets.includes("dmg")
            ? { dmgFileName: `Moss-${appVersion}-${options.arch}.dmg` }
            : {}),
          ...(builderTargets.includes("zip")
            ? { zipFileName: `Moss-${appVersion}-${options.arch}.zip` }
            : {}),
        });
      }
      if (options.platform === "win" && options.signed) {
        return verifyFinalBundledCodexWindowsInstaller({
          stageDistDir,
          sourceResourcesDir: path.join(stageAppDir, "apps/desktop"),
          expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
          targetTriples: packagedBundledCodexValidation.runtime.targets.map(
            (target) => target.targetTriple,
          ),
          expectedPayloadReceipt: packagedBundledCodexValidation.signedPayloadReceipt!,
          expectedMainExecutableName: `${desktopPackageJson.productName ?? "Moss"}.exe`,
          expectedInstallerFileName: `Moss-${appVersion}-${options.arch}.exe`,
          expectedPublisherName: expectedWindowsPublisherName!,
          expectedCertificateSubjectDn: expectedWindowsCertificateSubjectDn!,
          expectedCertificateThumbprint: expectedWindowsCertificateThumbprint!,
        });
      }
      if (options.platform === "linux" && options.releaseMode === "publish") {
        return verifyFinalBundledCodexLinuxAppImage({
          stageDistDir,
          expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
          targetTriples: packagedBundledCodexValidation.runtime.targets.map(
            (target) => target.targetTriple,
          ),
          expectedMainExecutableName: "moss",
          expectedAppImageFileName: `Moss-${appVersion}-${options.arch}.AppImage`,
          expectedLauncher: packagedBundledCodexValidation.linuxLauncherIdentity!,
        });
      }
      return null;
    },
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Final installable bundled Codex artifact verification failed: ${cause.message}`
            : "Final installable bundled Codex artifact verification failed.",
        cause,
      }),
  });
  if (finalPackagedArtifactReceipt?.platform === "mac") {
    yield* Effect.log(
      `[desktop-artifact] Extracted/mounted and fully re-verified ${finalPackagedArtifactReceipt.artifacts.length} final macOS installable artifacts.`,
    );
  } else if (finalPackagedArtifactReceipt?.platform === "win") {
    yield* Effect.log(
      `[desktop-artifact] Installed, fully re-verified, and uninstalled final NSIS artifact ${finalPackagedArtifactReceipt.installerFileName}.`,
    );
  } else if (finalPackagedArtifactReceipt?.platform === "linux") {
    yield* Effect.log(
      `[desktop-artifact] Privately extracted and fully re-verified final AppImage ${finalPackagedArtifactReceipt.appImageFileName}.`,
    );
  }

  if (electronDistProvenance) {
    yield* Effect.try({
      try: () => assertElectronDistProvenanceUnchanged(electronDistProvenance),
      catch: (cause) =>
        new BuildScriptError({
          message:
            cause instanceof Error
              ? `Offline Electron dist changed before artifact publication: ${cause.message}`
              : "Offline Electron dist changed before artifact publication.",
          cause,
        }),
    });
  }

  const copiedRelease = yield* Effect.try({
    try: () =>
      copyAndFinalizeDesktopRelease({
        outputDir: options.outputDir,
        copy: () =>
          copyBundledCodexReleaseArtifactsAndWriteReceipt({
            stageDistDir,
            outputDir: options.outputDir,
            platform: options.platform,
            arch: options.arch,
            releaseMode: options.releaseMode,
            signed: options.signed,
            expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
            verification: {
              complianceBundleRootSha256:
                packagedBundledCodexValidation.compliance.bundleRootSha256,
              packagedCompliance: {
                bundleRootAlgorithm: packagedBundledCodexValidation.compliance.bundleRootAlgorithm,
                bundleEntryCount: packagedBundledCodexValidation.compliance.bundleEntryCount,
                bundleFileCount: packagedBundledCodexValidation.compliance.bundleFileCount,
                bundleDirectoryCount:
                  packagedBundledCodexValidation.compliance.bundleDirectoryCount,
                bundleTotalBytes: packagedBundledCodexValidation.compliance.bundleTotalBytes,
                bundleRootSha256: packagedBundledCodexValidation.compliance.bundleRootSha256,
                componentCount: packagedBundledCodexValidation.compliance.componentCount,
                licenseTextCount: packagedBundledCodexValidation.compliance.licenseTextCount,
                payloadFileCount: packagedBundledCodexValidation.compliance.payloadFileCount,
                sourceMaterialCount: packagedBundledCodexValidation.compliance.sourceMaterialCount,
                releaseDecision: packagedBundledCodexValidation.compliance.releaseDecision,
                blockers: packagedBundledCodexValidation.compliance.blockers,
              },
              packagedPayload: packagedBundledCodexValidation.signedPayloadReceipt
                ? {
                    mode: "signed-canonical-binding",
                    fileCount: packagedBundledCodexValidation.signedPayloadReceipt.fileCount,
                    totalBytes: packagedBundledCodexValidation.signedPayloadReceipt.totalBytes,
                    finalTreeSha256:
                      packagedBundledCodexValidation.signedPayloadReceipt.finalTreeSha256,
                    canonicalContentTreeSha256:
                      packagedBundledCodexValidation.signedPayloadReceipt
                        .canonicalContentTreeSha256,
                  }
                : { mode: "exact-final-payload-hashes", validated: true },
              ...(packagedBundledCodexValidation.linuxRuntimeReceipt
                ? {
                    linuxRuntime: {
                      targetTriple: packagedBundledCodexValidation.linuxRuntimeReceipt.targetTriple,
                      maximumGlibcVersion:
                        packagedBundledCodexValidation.linuxRuntimeReceipt.maximumGlibcVersion,
                      neededLibraries:
                        packagedBundledCodexValidation.linuxRuntimeReceipt.neededLibraries,
                      resolvedLibraries:
                        packagedBundledCodexValidation.linuxRuntimeReceipt.resolvedLibraries,
                    },
                  }
                : {}),
              ...(packagedBundledCodexValidation.linuxLauncherIdentity
                ? { linuxLauncher: packagedBundledCodexValidation.linuxLauncherIdentity }
                : {}),
              ...(packagedBundledCodexValidation.macBuildOnlySignatureReceipt
                ? {
                    macBuildOnlySignature: {
                      releaseEligibility: "build-only-only",
                      signatureType: "adhoc",
                      signatures:
                        packagedBundledCodexValidation.macBuildOnlySignatureReceipt.signatures,
                      canonicalFilesystemHelper:
                        packagedBundledCodexValidation.macBuildOnlySignatureReceipt
                          .canonicalFilesystemHelper,
                    },
                  }
                : {}),
              ...(packagedBundledCodexValidation.macAsarIntegrityReceipt
                ? { macAsarIntegrity: packagedBundledCodexValidation.macAsarIntegrityReceipt }
                : {}),
              finalInstallable: finalPackagedArtifactReceipt,
              bundledClaude: bundledClaudeReleaseVerification,
            },
          }),
        finalize: (copied) => {
          appendElectronDistReceiptProvenance({
            receiptPath: copied.receiptPath,
            provenance: electronDistProvenance,
            ...(electronDistProvenance
              ? {
                  verifyUpdatedReceipt: () => {
                    verifyBundledCodexReleaseReceipt({
                      outputDir: options.outputDir,
                      expectedPlatform: options.platform,
                      expectedArch: options.arch,
                      requirePublishEligible: options.releaseMode === "publish",
                    });
                  },
                }
              : {}),
          });
        },
      }),
    catch: (cause) =>
      new BuildScriptError({
        message:
          cause instanceof Error
            ? `Copying and receipting final artifacts failed: ${cause.message}`
            : "Copying and receipting final artifacts failed.",
        cause,
      }),
  });
  const copiedArtifacts = [
    ...copiedRelease.receipt.artifacts.map((artifact) =>
      path.join(options.outputDir, artifact.fileName),
    ),
    copiedRelease.receiptPath,
  ];

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: MOSS_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: MOSS_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: MOSS_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: MOSS_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  sourceCommit: Flag.string("source-commit").pipe(
    Flag.withDescription("Expected full source commit (env: MOSS_SOURCE_COMMIT)."),
    Flag.optional,
  ),
  sourceTag: Flag.string("source-tag").pipe(
    Flag.withDescription("Exact source tag when building a release (env: MOSS_SOURCE_TAG)."),
    Flag.optional,
  ),
  lockfileSha256: Flag.string("lockfile-sha256").pipe(
    Flag.withDescription("Expected bun.lock SHA-256 (env: MOSS_LOCKFILE_SHA256)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: MOSS_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: MOSS_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: MOSS_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses the provider selected by WINDOWS_SIGNING_PROVIDER (env: MOSS_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: MOSS_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: MOSS_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.string("mock-update-server-port").pipe(
    Flag.withDescription("Mock update server port (env: MOSS_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
  productionConfigMode: Flag.choice("production-config-mode", ProductionConfigMode.literals).pipe(
    Flag.withDescription(
      "Production public config mode: strict validates and embeds allowlisted service routing; off omits packaged managed cloud routing (env: MOSS_DESKTOP_PRODUCTION_CONFIG_MODE).",
    ),
    Flag.optional,
  ),
  releaseMode: Flag.choice("release-mode", ReleaseMode.literals).pipe(
    Flag.withDescription(
      "Release intent: publish fails closed on production config and platform signing; build-only permits explicit unsigned internal QA artifacts (env: MOSS_DESKTOP_RELEASE_MODE).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Moss."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
