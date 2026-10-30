// FILE: bundled-claude-runtime.ts
// Purpose: Locates and validates the platform Claude Code executable staged into desktop resources.
// Layer: Release/build helper

import * as FS from "node:fs";
import { spawnSync } from "node:child_process";
import * as Crypto from "node:crypto";
import * as Path from "node:path";

export const BUNDLED_CLAUDE_AGENT_SDK_VERSION = "0.3.285" as const;
export const BUNDLED_CLAUDE_CODE_VERSION = "2.1.285" as const;
export const BUNDLED_CLAUDE_RUNTIME_DIR = "apps/desktop/claude-runtime";
const BUNDLED_CLAUDE_VERSION_ARGS = ["--version"] as const;
const MACOS_ARCH_COMMAND = "/usr/bin/arch";
// A freshly mounted macOS artifact can spend more than ten seconds in the
// platform's first-execution checks before Claude prints its version. Keep the
// probe fail-closed, but allow that cold-start work to complete.
const VERSION_PROBE_TIMEOUT_MS = 30_000;
export const BUNDLED_CLAUDE_EXTRA_RESOURCE = {
  from: BUNDLED_CLAUDE_RUNTIME_DIR,
  to: "claude-runtime",
} as const;

export interface BundledClaudeTarget {
  readonly npmPackageName: string;
  readonly resourceFolder: string;
  readonly executable: "claude" | "claude.exe";
  readonly os: "darwin" | "linux" | "win32";
  readonly cpu: "arm64" | "x64";
}

const TARGETS = {
  "mac-arm64": {
    npmPackageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    resourceFolder: "darwin-arm64",
    executable: "claude",
    os: "darwin",
    cpu: "arm64",
  },
  "mac-x64": {
    npmPackageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    resourceFolder: "darwin-x64",
    executable: "claude",
    os: "darwin",
    cpu: "x64",
  },
  "linux-arm64": {
    npmPackageName: "@anthropic-ai/claude-agent-sdk-linux-arm64",
    resourceFolder: "linux-arm64",
    executable: "claude",
    os: "linux",
    cpu: "arm64",
  },
  "linux-x64": {
    npmPackageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
    resourceFolder: "linux-x64",
    executable: "claude",
    os: "linux",
    cpu: "x64",
  },
  "win-arm64": {
    npmPackageName: "@anthropic-ai/claude-agent-sdk-win32-arm64",
    resourceFolder: "win32-arm64",
    executable: "claude.exe",
    os: "win32",
    cpu: "arm64",
  },
  "win-x64": {
    npmPackageName: "@anthropic-ai/claude-agent-sdk-win32-x64",
    resourceFolder: "win32-x64",
    executable: "claude.exe",
    os: "win32",
    cpu: "x64",
  },
} as const satisfies Record<string, BundledClaudeTarget>;

export function resolveBundledClaudeTargets(input: {
  readonly platform: "mac" | "linux" | "win";
  readonly arch: "arm64" | "x64" | "universal";
}): ReadonlyArray<BundledClaudeTarget> {
  if (input.arch === "universal") {
    if (input.platform !== "mac") {
      throw new Error(`Universal Claude runtime is unsupported for ${input.platform}.`);
    }
    return [TARGETS["mac-arm64"], TARGETS["mac-x64"]];
  }

  const key = `${input.platform}-${input.arch}` as keyof typeof TARGETS;
  const target = TARGETS[key];
  if (!target)
    throw new Error(`Claude runtime is unsupported for ${input.platform}/${input.arch}.`);
  return [target];
}

export interface ResolvedBundledClaudeRuntime {
  readonly sourcePath: string;
  readonly packageRoot: string;
  readonly target: BundledClaudeTarget;
  readonly verification: BundledClaudeRuntimeVerification;
}

export interface BundledClaudeExecutableVersionProbeInput {
  readonly sourcePath: string;
  readonly target: BundledClaudeTarget;
}

export type BundledClaudeExecutableVersionProbe = (
  input: BundledClaudeExecutableVersionProbeInput,
) => string;

export type BundledClaudeProbeMethod = "direct-exec" | "macos-arch-exec" | "injected-test";

export interface BundledClaudeProbeExecution {
  readonly method: Exclude<BundledClaudeProbeMethod, "injected-test">;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface BundledClaudeRuntimeVerification {
  readonly method: BundledClaudeProbeMethod;
  readonly reportedVersion: string;
}

export interface BundledClaudeReleaseVerificationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "moss-bundled-claude-runtime-verification";
  readonly agentSdkVersion: typeof BUNDLED_CLAUDE_AGENT_SDK_VERSION;
  readonly codeVersion: typeof BUNDLED_CLAUDE_CODE_VERSION;
  readonly runner: {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly targets: ReadonlyArray<{
    readonly resourceFolder: string;
    readonly os: BundledClaudeTarget["os"];
    readonly cpu: BundledClaudeTarget["cpu"];
    readonly executable: BundledClaudeTarget["executable"];
    readonly method: Exclude<BundledClaudeProbeMethod, "injected-test">;
    readonly argv: ReadonlyArray<string>;
    readonly reportedVersion: typeof BUNDLED_CLAUDE_CODE_VERSION;
  }>;
}

export interface PrunedBundledClaudeNativePackages {
  readonly preservedRuntimeDir: string;
  readonly removedPaths: ReadonlyArray<string>;
}

function packageFolderName(packageName: string): string {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

function pathExists(path: string): boolean {
  try {
    FS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function parseBundledClaudeCodeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null;
}

export function resolveBundledClaudeProbeExecution(input: {
  readonly sourcePath: string;
  readonly target: BundledClaudeTarget;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}): BundledClaudeProbeExecution {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const hostArch = input.hostArch ?? process.arch;
  if (input.target.os === hostPlatform && input.target.cpu === hostArch) {
    return {
      method: "direct-exec",
      command: input.sourcePath,
      args: [...BUNDLED_CLAUDE_VERSION_ARGS],
    };
  }

  // macOS arm64 runners can execute the x64 Claude binary through Rosetta. Use the
  // system arch launcher so the proof is an actual target-binary invocation rather
  // than a manifest or binary-string inspection.
  if (
    hostPlatform === "darwin" &&
    hostArch === "arm64" &&
    input.target.os === "darwin" &&
    input.target.cpu === "x64"
  ) {
    return {
      method: "macos-arch-exec",
      command: MACOS_ARCH_COMMAND,
      args: ["-x86_64", input.sourcePath, ...BUNDLED_CLAUDE_VERSION_ARGS],
    };
  }

  const host = `${hostPlatform}/${hostArch}`;
  const target = `${input.target.os}/${input.target.cpu}`;
  throw new Error(
    `Claude runtime ${input.target.resourceFolder} cannot be executed from host ${host} for target ${target}; native target runner evidence is required, so manifest-only validation is refused.`,
  );
}

function runBundledClaudeVersionProbe(input: {
  readonly target: BundledClaudeTarget;
  readonly execution: BundledClaudeProbeExecution;
}): string {
  const result = spawnSync(input.execution.command, input.execution.args, {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  if (result.error) {
    throw new Error(
      `Claude Code ${input.target.resourceFolder} --version failed: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Claude Code ${input.target.resourceFolder} --version exited with ${String(result.status)}: ${output.trim()}`,
    );
  }
  return output;
}

export function probeBundledClaudeExecutableVersion(
  input: BundledClaudeExecutableVersionProbeInput,
): string {
  return runBundledClaudeVersionProbe({
    target: input.target,
    execution: resolveBundledClaudeProbeExecution(input),
  });
}

export function assertBundledClaudeExecutableVersion(input: {
  readonly sourcePath: string;
  readonly target: BundledClaudeTarget;
  readonly probeExecutableVersion?: BundledClaudeExecutableVersionProbe;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}): BundledClaudeRuntimeVerification {
  const execution = input.probeExecutableVersion
    ? null
    : resolveBundledClaudeProbeExecution({
        sourcePath: input.sourcePath,
        target: input.target,
        ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
        ...(input.hostArch ? { hostArch: input.hostArch } : {}),
      });
  const output = input.probeExecutableVersion
    ? input.probeExecutableVersion({
        sourcePath: input.sourcePath,
        target: input.target,
      })
    : runBundledClaudeVersionProbe({ target: input.target, execution: execution! });
  const reportedVersion = parseBundledClaudeCodeVersion(output);
  if (reportedVersion !== BUNDLED_CLAUDE_CODE_VERSION) {
    throw new Error(
      `Claude Code ${input.target.resourceFolder} --version reported ${reportedVersion ?? "an unparseable version"}; expected ${BUNDLED_CLAUDE_CODE_VERSION}.`,
    );
  }
  return {
    method: execution?.method ?? "injected-test",
    reportedVersion,
  };
}

export interface BundledClaudeFinalArtifactVerificationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "moss-bundled-claude-final-artifact-verification";
  readonly platform: "mac";
  readonly arch: "arm64" | "x64" | "universal";
  readonly targets: ReadonlyArray<{
    readonly resourceFolder: string;
    readonly cpu: BundledClaudeTarget["cpu"];
    readonly executable: BundledClaudeTarget["executable"];
    readonly relativePath: string;
    readonly fileSize: number;
    readonly fileSha256: string;
    readonly executableVerified: true;
    readonly method: Exclude<BundledClaudeProbeMethod, "injected-test">;
    readonly argv: ReadonlyArray<"--version">;
    readonly reportedVersion: typeof BUNDLED_CLAUDE_CODE_VERSION;
  }>;
}

function finalArtifactTargetRelativePath(target: BundledClaudeTarget): string {
  return Path.posix.join("claude-runtime", target.resourceFolder, target.executable);
}

function readFinalArtifactExecutableDigest(
  sourcePath: string,
  target: BundledClaudeTarget,
): {
  readonly fileSize: number;
  readonly fileSha256: string;
} {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(sourcePath);
  } catch (cause) {
    throw new Error(`Final macOS Claude runtime ${target.resourceFolder} is missing.`, { cause });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Final macOS Claude runtime ${target.resourceFolder} must be a plain file.`);
  }
  if (target.os !== "win32") {
    try {
      FS.accessSync(sourcePath, FS.constants.X_OK);
    } catch (cause) {
      throw new Error(`Final macOS Claude runtime ${target.resourceFolder} is not executable.`, {
        cause,
      });
    }
  }
  const bytes = FS.readFileSync(sourcePath);
  return {
    fileSize: stat.size,
    fileSha256: Crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Revalidates the Claude executable copied into an extracted macOS DMG/ZIP.
 * This deliberately does not trust the build-stage receipt: it resolves the
 * final resource path, checks a plain executable file, and invokes --version
 * against the extracted bytes on the native target runner.
 */
export function verifyFinalBundledClaudeMacRuntime(input: {
  readonly resourcesDir: string;
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}): BundledClaudeFinalArtifactVerificationReceipt {
  if (!pathExists(input.resourcesDir)) {
    throw new Error("Final macOS application is missing its Resources directory.");
  }
  const resourcesStat = FS.lstatSync(input.resourcesDir);
  if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink()) {
    throw new Error("Final macOS application Resources must be a plain directory.");
  }
  const targets = resolveBundledClaudeTargets({ platform: "mac", arch: input.arch });
  const verifiedTargets = targets.map((target) => {
    const relativePath = finalArtifactTargetRelativePath(target);
    const sourcePath = Path.join(input.resourcesDir, ...relativePath.split("/"));
    const digest = readFinalArtifactExecutableDigest(sourcePath, target);
    const verification = assertBundledClaudeExecutableVersion({
      sourcePath,
      target,
      ...(input.hostPlatform ? { hostPlatform: input.hostPlatform } : {}),
      ...(input.hostArch ? { hostArch: input.hostArch } : {}),
    });
    if (verification.method === "injected-test") {
      throw new Error(
        `Final macOS Claude runtime ${target.resourceFolder} cannot use an injected version probe.`,
      );
    }
    return {
      resourceFolder: target.resourceFolder,
      cpu: target.cpu,
      executable: target.executable,
      relativePath,
      fileSize: digest.fileSize,
      fileSha256: digest.fileSha256,
      executableVerified: true as const,
      method: verification.method,
      argv: ["--version"] as const,
      reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
    };
  });
  return {
    schemaVersion: 1,
    kind: "moss-bundled-claude-final-artifact-verification",
    platform: "mac",
    arch: input.arch,
    targets: verifiedTargets,
  };
}

function assertFinalArtifactReceiptKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Bundled Claude final artifact verification receipt is invalid at ${label}.`);
  }
}

/** Validates final DMG/ZIP Claude proof persisted inside the release receipt. */
export function assertBundledClaudeFinalArtifactVerificationReceipt(input: {
  readonly value: unknown;
  readonly expectedArch: "arm64" | "x64" | "universal";
}): BundledClaudeFinalArtifactVerificationReceipt {
  const receipt = releaseReceiptRecord(input.value, "final artifact root");
  assertFinalArtifactReceiptKeys(
    receipt,
    ["schemaVersion", "kind", "platform", "arch", "targets"],
    "root",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "moss-bundled-claude-final-artifact-verification" ||
    receipt.platform !== "mac" ||
    receipt.arch !== input.expectedArch ||
    !Array.isArray(receipt.targets)
  ) {
    throw new Error("Bundled Claude final artifact verification receipt metadata is invalid.");
  }
  const expectedTargets = resolveBundledClaudeTargets({
    platform: "mac",
    arch: input.expectedArch,
  });
  if (receipt.targets.length !== expectedTargets.length) {
    throw new Error("Bundled Claude final artifact verification target inventory is invalid.");
  }
  for (const [index, expectedTarget] of expectedTargets.entries()) {
    const target = releaseReceiptRecord(receipt.targets[index], `targets[${index}]`);
    assertFinalArtifactReceiptKeys(
      target,
      [
        "resourceFolder",
        "cpu",
        "executableVerified",
        "relativePath",
        "fileSize",
        "fileSha256",
        "executable",
        "method",
        "argv",
        "reportedVersion",
      ],
      `targets[${index}]`,
    );
    const expectedRelativePath = finalArtifactTargetRelativePath(expectedTarget);
    if (
      target.resourceFolder !== expectedTarget.resourceFolder ||
      target.cpu !== expectedTarget.cpu ||
      target.executable !== expectedTarget.executable ||
      target.relativePath !== expectedRelativePath ||
      target.executableVerified !== true ||
      !Number.isSafeInteger(target.fileSize) ||
      Number(target.fileSize) <= 0 ||
      typeof target.fileSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(target.fileSha256) ||
      (target.method !== "direct-exec" && target.method !== "macos-arch-exec") ||
      !Array.isArray(target.argv) ||
      target.argv.length !== 1 ||
      target.argv[0] !== "--version" ||
      target.reportedVersion !== BUNDLED_CLAUDE_CODE_VERSION
    ) {
      throw new Error(
        `Bundled Claude final artifact verification target ${expectedTarget.resourceFolder} is invalid.`,
      );
    }
  }
  return receipt as unknown as BundledClaudeFinalArtifactVerificationReceipt;
}

export function resolveBundledClaudeRuntime(input: {
  readonly stageAppDir: string;
  readonly target: BundledClaudeTarget;
  /** Override the native probe for deterministic tests or a platform runner. */
  readonly probeExecutableVersion?: BundledClaudeExecutableVersionProbe;
}): ResolvedBundledClaudeRuntime {
  const packageFolder = packageFolderName(input.target.npmPackageName);
  const mainPackageRoot = Path.join(
    input.stageAppDir,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
  );
  let bunOptionalPackageRoot: string | null = null;
  try {
    bunOptionalPackageRoot = Path.join(
      Path.dirname(FS.realpathSync(mainPackageRoot)),
      packageFolder,
    );
  } catch {
    // The missing main package is reported with the complete candidate list below.
  }
  const packageRoots = [
    Path.join(input.stageAppDir, "node_modules", "@anthropic-ai", packageFolder),
    Path.join(mainPackageRoot, "node_modules", "@anthropic-ai", packageFolder),
    ...(bunOptionalPackageRoot ? [bunOptionalPackageRoot] : []),
  ];
  const packageRoot = packageRoots.find((candidate) => FS.existsSync(candidate));
  if (!packageRoot) {
    throw new Error(`Missing ${input.target.npmPackageName} for ${input.target.resourceFolder}.`);
  }

  const mainManifestPath = Path.join(mainPackageRoot, "package.json");
  if (!FS.existsSync(mainManifestPath)) {
    throw new Error("Claude Agent SDK main manifest is missing from the staged runtime.");
  }
  let mainManifest: unknown;
  try {
    mainManifest = JSON.parse(FS.readFileSync(mainManifestPath, "utf8"));
  } catch (cause) {
    throw new Error("Claude Agent SDK main manifest is unreadable.", { cause });
  }
  const mainRecord = mainManifest as Record<string, unknown>;
  if (
    mainRecord.name !== "@anthropic-ai/claude-agent-sdk" ||
    mainRecord.version !== BUNDLED_CLAUDE_AGENT_SDK_VERSION ||
    mainRecord.claudeCodeVersion !== BUNDLED_CLAUDE_CODE_VERSION
  ) {
    throw new Error(
      `Claude Agent SDK main manifest must pin ${BUNDLED_CLAUDE_AGENT_SDK_VERSION} with claudeCodeVersion ${BUNDLED_CLAUDE_CODE_VERSION}.`,
    );
  }

  const manifestPath = Path.join(packageRoot, "package.json");
  const sourcePath = Path.join(packageRoot, input.target.executable);
  if (!FS.existsSync(manifestPath) || !FS.existsSync(sourcePath)) {
    throw new Error(
      `Claude runtime ${input.target.resourceFolder} is missing its manifest or entrypoint.`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(`Claude runtime ${input.target.resourceFolder} has an unreadable manifest.`, {
      cause,
    });
  }
  const record = manifest as Record<string, unknown>;
  if (
    record.name !== input.target.npmPackageName ||
    record.version !== BUNDLED_CLAUDE_AGENT_SDK_VERSION ||
    !Array.isArray(record.os) ||
    !record.os.includes(input.target.os) ||
    !Array.isArray(record.cpu) ||
    !record.cpu.includes(input.target.cpu)
  ) {
    throw new Error(
      `Claude runtime manifest does not match ${BUNDLED_CLAUDE_AGENT_SDK_VERSION}/${input.target.resourceFolder}.`,
    );
  }

  if (input.target.os !== "win32") {
    try {
      FS.accessSync(sourcePath, FS.constants.X_OK);
    } catch (cause) {
      throw new Error(`Claude runtime ${input.target.resourceFolder} is not executable.`, {
        cause,
      });
    }
  }

  const verification = assertBundledClaudeExecutableVersion({
    sourcePath,
    target: input.target,
    ...(input.probeExecutableVersion
      ? { probeExecutableVersion: input.probeExecutableVersion }
      : {}),
  });

  return { sourcePath, packageRoot, target: input.target, verification };
}

export function createBundledClaudeReleaseVerificationReceipt(
  runtimes: ReadonlyArray<ResolvedBundledClaudeRuntime>,
): BundledClaudeReleaseVerificationReceipt {
  if (runtimes.length === 0) {
    throw new Error("Bundled Claude release verification requires at least one target.");
  }

  const targets = runtimes.map(({ target, verification }) => {
    if (verification.method === "injected-test") {
      throw new Error(
        `Bundled Claude ${target.resourceFolder} release receipt cannot use an injected test probe.`,
      );
    }
    if (verification.reportedVersion !== BUNDLED_CLAUDE_CODE_VERSION) {
      throw new Error(
        `Bundled Claude ${target.resourceFolder} release receipt has an unexpected reported version.`,
      );
    }
    return {
      resourceFolder: target.resourceFolder,
      os: target.os,
      cpu: target.cpu,
      executable: target.executable,
      method: verification.method,
      argv: [...BUNDLED_CLAUDE_VERSION_ARGS],
      reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
    };
  });

  return {
    schemaVersion: 1,
    kind: "moss-bundled-claude-runtime-verification",
    agentSdkVersion: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
    codeVersion: BUNDLED_CLAUDE_CODE_VERSION,
    runner: {
      platform: process.platform,
      arch: process.arch,
    },
    targets,
  };
}

type BundledClaudeReleasePlatform = "linux" | "mac" | "win";
type BundledClaudeReleaseArch = "arm64" | "x64" | "universal";

function releaseReceiptRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Bundled Claude release verification receipt is invalid at ${label}.`);
  }
  return value as Record<string, unknown>;
}

function assertReleaseReceiptKeys(
  record: Record<string, unknown>,
  expectedKeys: ReadonlyArray<string>,
  label: string,
): void {
  const actual = Object.keys(record).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Bundled Claude release verification receipt is invalid at ${label}.`);
  }
}

/**
 * Revalidates the persisted Claude sub-receipt against the release target.
 * This is intentionally independent of the build-time executable probe so a
 * stale or modified aggregate receipt cannot inherit trust from an earlier run.
 */
export function assertBundledClaudeReleaseVerificationReceipt(input: {
  readonly value: unknown;
  readonly expectedPlatform: BundledClaudeReleasePlatform;
  readonly expectedArch: BundledClaudeReleaseArch;
}): BundledClaudeReleaseVerificationReceipt {
  const receipt = releaseReceiptRecord(input.value, "root");
  assertReleaseReceiptKeys(
    receipt,
    ["schemaVersion", "kind", "agentSdkVersion", "codeVersion", "runner", "targets"],
    "root",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "moss-bundled-claude-runtime-verification" ||
    receipt.agentSdkVersion !== BUNDLED_CLAUDE_AGENT_SDK_VERSION ||
    receipt.codeVersion !== BUNDLED_CLAUDE_CODE_VERSION ||
    !Array.isArray(receipt.targets)
  ) {
    throw new Error("Bundled Claude release verification receipt metadata is invalid.");
  }

  const runner = releaseReceiptRecord(receipt.runner, "runner");
  assertReleaseReceiptKeys(runner, ["platform", "arch"], "runner");
  const runnerPlatform = runner.platform;
  const runnerArch = runner.arch;
  if (typeof runnerPlatform !== "string" || typeof runnerArch !== "string") {
    throw new Error("Bundled Claude release verification receipt runner is invalid.");
  }

  const expectedTargets = resolveBundledClaudeTargets({
    platform: input.expectedPlatform,
    arch: input.expectedArch,
  });
  if (receipt.targets.length !== expectedTargets.length) {
    throw new Error("Bundled Claude release verification receipt target inventory is invalid.");
  }

  for (const [index, expectedTarget] of expectedTargets.entries()) {
    const target = releaseReceiptRecord(receipt.targets[index], `targets[${index}]`);
    assertReleaseReceiptKeys(
      target,
      ["resourceFolder", "os", "cpu", "executable", "method", "argv", "reportedVersion"],
      `targets[${index}]`,
    );
    const expectedMethod =
      runnerPlatform === expectedTarget.os && runnerArch === expectedTarget.cpu
        ? "direct-exec"
        : runnerPlatform === "darwin" &&
            runnerArch === "arm64" &&
            expectedTarget.os === "darwin" &&
            expectedTarget.cpu === "x64"
          ? "macos-arch-exec"
          : null;
    if (
      expectedMethod === null ||
      target.resourceFolder !== expectedTarget.resourceFolder ||
      target.os !== expectedTarget.os ||
      target.cpu !== expectedTarget.cpu ||
      target.executable !== expectedTarget.executable ||
      target.method !== expectedMethod ||
      !Array.isArray(target.argv) ||
      target.argv.length !== BUNDLED_CLAUDE_VERSION_ARGS.length ||
      target.argv.some(
        (argument, argumentIndex) => argument !== BUNDLED_CLAUDE_VERSION_ARGS[argumentIndex],
      ) ||
      target.reportedVersion !== BUNDLED_CLAUDE_CODE_VERSION
    ) {
      throw new Error(
        `Bundled Claude release verification receipt target ${expectedTarget.resourceFolder} is invalid.`,
      );
    }
  }

  return receipt as unknown as BundledClaudeReleaseVerificationReceipt;
}

export function pruneBundledClaudeNativePackages(input: {
  readonly stageAppDir: string;
}): PrunedBundledClaudeNativePackages {
  const preservedRuntimeDir = Path.join(input.stageAppDir, BUNDLED_CLAUDE_RUNTIME_DIR);
  const preservedRuntimeTargets = pathExists(preservedRuntimeDir)
    ? FS.readdirSync(preservedRuntimeDir)
    : [];
  if (preservedRuntimeTargets.length === 0) {
    throw new Error(
      "Refusing to prune Claude native packages before the validated runtime has been copied to extraResources.",
    );
  }

  const nodeModulesDir = Path.join(input.stageAppDir, "node_modules");
  const candidatePaths = new Set<string>();
  for (const target of Object.values(TARGETS)) {
    candidatePaths.add(
      Path.join(nodeModulesDir, "@anthropic-ai", packageFolderName(target.npmPackageName)),
    );
  }

  const mainPackageRoot = Path.join(nodeModulesDir, "@anthropic-ai", "claude-agent-sdk");
  try {
    const realMainPackageRoot = FS.realpathSync(mainPackageRoot);
    const dependencyScopeDir = Path.dirname(realMainPackageRoot);
    for (const entry of FS.readdirSync(dependencyScopeDir)) {
      if (entry.startsWith("claude-agent-sdk-")) {
        candidatePaths.add(Path.join(dependencyScopeDir, entry));
      }
    }
  } catch {
    // resolveBundledClaudeRuntime already reports a missing main SDK before cleanup.
  }

  const bunStoreDir = Path.join(nodeModulesDir, ".bun");
  if (pathExists(bunStoreDir)) {
    for (const entry of FS.readdirSync(bunStoreDir)) {
      if (entry.startsWith("@anthropic-ai+claude-agent-sdk-")) {
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
    throw new Error(`Claude native packages remain staged: ${remainingPaths.join(", ")}.`);
  }

  for (const target of preservedRuntimeTargets) {
    if (!pathExists(Path.join(preservedRuntimeDir, target))) {
      throw new Error(`Pruning native packages removed copied Claude runtime ${target}.`);
    }
  }

  return { preservedRuntimeDir, removedPaths };
}
