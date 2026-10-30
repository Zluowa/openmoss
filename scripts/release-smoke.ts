// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MOSS_DESKTOP_UPDATE_CHANNEL,
  MOSS_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import { DESKTOP_STAGE_LOCK_DIRECTORY } from "./lib/desktop-stage-lock.ts";
import { assertStagedDiffDependencies } from "./lib/staged-diff-dependencies.ts";
import {
  readReleaseUpdatePolicyConfig,
  resolveReleaseUpdatePolicy,
} from "./lib/release-update-policy.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedPierreDiffsDependency = "^1.3.5";
const expectedPierreDiffsVersion = "1.3.5";

export const RELEASE_SMOKE_PROCESS_PLAN = Object.freeze({
  updatePackageVersions: Object.freeze({
    label: "Release package-version fixture update",
    timeoutMs: 60_000,
  }),
  refreshLockfile: Object.freeze({
    label: "Release fixture lockfile refresh",
    timeoutMs: 300_000,
  }),
  mergeMacManifests: Object.freeze({
    label: "macOS update-manifest fixture merge",
    timeoutMs: 60_000,
  }),
  installDesktopStage: Object.freeze({
    label: "Frozen desktop-stage production install",
    timeoutMs: 600_000,
  }),
});

export type ReleaseSmokeProcessOperation = keyof typeof RELEASE_SMOKE_PROCESS_PLAN;

export const RELEASE_SMOKE_PROCESS_TIMEOUTS_MS = Object.freeze({
  updatePackageVersions: RELEASE_SMOKE_PROCESS_PLAN.updatePackageVersions.timeoutMs,
  refreshLockfile: RELEASE_SMOKE_PROCESS_PLAN.refreshLockfile.timeoutMs,
  mergeMacManifests: RELEASE_SMOKE_PROCESS_PLAN.mergeMacManifests.timeoutMs,
  installDesktopStage: RELEASE_SMOKE_PROCESS_PLAN.installDesktopStage.timeoutMs,
});

const RELEASE_SMOKE_GRACEFUL_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";
const RELEASE_SMOKE_FORCE_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const RELEASE_SMOKE_PROCESS_KILL_GRACE_MS = 2_000;
const RELEASE_SMOKE_PROCESS_FORCE_SETTLE_MS = 100;
const RELEASE_SMOKE_SUPERVISOR_ANCHOR_TIMEOUT_MS = 250;
const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;
const WINDOWS_TASKKILL_MAX_BUFFER_BYTES = 64 * 1024;

export interface WindowsReleaseSmokeTerminationStep {
  readonly mode: "graceful-tree" | "forced-tree";
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly killSignal: NodeJS.Signals;
  readonly maxBuffer: number;
}

export const WINDOWS_RELEASE_SMOKE_TERMINATION_PLAN = Object.freeze([
  Object.freeze({
    mode: "graceful-tree",
    arguments: Object.freeze(["/PID", "<pid>", "/T"]),
    timeoutMs: WINDOWS_TASKKILL_TIMEOUT_MS,
    killSignal: RELEASE_SMOKE_FORCE_KILL_SIGNAL,
    maxBuffer: WINDOWS_TASKKILL_MAX_BUFFER_BYTES,
  }),
  Object.freeze({
    mode: "forced-tree",
    arguments: Object.freeze(["/PID", "<pid>", "/T", "/F"]),
    timeoutMs: WINDOWS_TASKKILL_TIMEOUT_MS,
    killSignal: RELEASE_SMOKE_FORCE_KILL_SIGNAL,
    maxBuffer: WINDOWS_TASKKILL_MAX_BUFFER_BYTES,
  }),
] as const satisfies readonly WindowsReleaseSmokeTerminationStep[]);

export function assertWindowsReleaseSmokeTerminationPlan(plan: unknown): void {
  const expected = [
    {
      mode: "graceful-tree",
      arguments: ["/PID", "<pid>", "/T"],
    },
    {
      mode: "forced-tree",
      arguments: ["/PID", "<pid>", "/T", "/F"],
    },
  ] as const;
  if (!Array.isArray(plan) || plan.length !== expected.length) {
    throw new Error(
      "Windows release-smoke termination plan must contain graceful and forced tree steps.",
    );
  }
  for (const [index, expectedStep] of expected.entries()) {
    const step = plan[index] as Partial<WindowsReleaseSmokeTerminationStep> | undefined;
    if (
      step?.mode !== expectedStep.mode ||
      !Array.isArray(step.arguments) ||
      step.arguments.length !== expectedStep.arguments.length ||
      !step.arguments.every((argument, argumentIndex) => {
        return argument === expectedStep.arguments[argumentIndex];
      }) ||
      step.timeoutMs !== WINDOWS_TASKKILL_TIMEOUT_MS ||
      step.killSignal !== RELEASE_SMOKE_FORCE_KILL_SIGNAL ||
      step.maxBuffer !== WINDOWS_TASKKILL_MAX_BUFFER_BYTES
    ) {
      throw new Error(
        `Windows release-smoke termination plan step ${index + 1} must retain exact tree scope, timeout, buffer bound, and force semantics.`,
      );
    }
  }
}

interface WindowsReleaseSmokeSpawnSyncResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
}

interface WindowsReleaseSmokeSpawnSyncOptions {
  readonly encoding: "utf8";
  readonly killSignal: NodeJS.Signals;
  readonly maxBuffer: number;
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly timeout: number;
  readonly windowsHide: true;
}

export type WindowsReleaseSmokeSpawnSync = (
  command: string,
  args: readonly string[],
  options: WindowsReleaseSmokeSpawnSyncOptions,
) => WindowsReleaseSmokeSpawnSyncResult;

export interface ExecuteWindowsReleaseSmokeTerminationInput {
  readonly pid: number;
  readonly force: boolean;
  readonly plan?: unknown;
  readonly spawnSync?: WindowsReleaseSmokeSpawnSync;
  readonly directKill: (signal: NodeJS.Signals) => boolean;
}

function defaultWindowsReleaseSmokeSpawnSync(
  command: string,
  args: readonly string[],
  options: WindowsReleaseSmokeSpawnSyncOptions,
): WindowsReleaseSmokeSpawnSyncResult {
  const result = spawnSync(command, [...args], options);
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stderr: result.stderr,
  };
}

export function executeWindowsReleaseSmokeTermination({
  pid,
  force,
  plan = WINDOWS_RELEASE_SMOKE_TERMINATION_PLAN,
  spawnSync: spawnSyncProcess = defaultWindowsReleaseSmokeSpawnSync,
  directKill,
}: ExecuteWindowsReleaseSmokeTerminationInput): string | null {
  assertWindowsReleaseSmokeTerminationPlan(plan);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return `invalid child PID ${String(pid)}`;
  }
  const [gracefulStep, forcedStep] = plan as typeof WINDOWS_RELEASE_SMOKE_TERMINATION_PLAN;
  const steps = force ? [forcedStep] : [gracefulStep, forcedStep];
  const failures: string[] = [];

  for (const step of steps) {
    const args = step.arguments.map((argument) => (argument === "<pid>" ? String(pid) : argument));
    let result: WindowsReleaseSmokeSpawnSyncResult;
    try {
      result = spawnSyncProcess("taskkill.exe", args, {
        encoding: "utf8",
        killSignal: step.killSignal,
        maxBuffer: step.maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: step.timeoutMs,
        windowsHide: true,
      });
    } catch (error) {
      result = {
        error: error instanceof Error ? error : new Error(String(error)),
        status: null,
        stderr: "",
      };
    }
    if (!result.error && result.status === 0) {
      return failures.length === 0 ? null : `${failures.join("; ")}; ${step.mode} succeeded`;
    }
    const failure = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    failures.push(`${step.mode} failed (${failure})`);
  }

  try {
    const killed = directKill(RELEASE_SMOKE_FORCE_KILL_SIGNAL);
    return `${failures.join("; ")}; direct-child ${RELEASE_SMOKE_FORCE_KILL_SIGNAL} fallback ${killed ? "succeeded" : "reported no process"}`;
  } catch (error) {
    return `${failures.join("; ")}; direct-child ${RELEASE_SMOKE_FORCE_KILL_SIGNAL} fallback failed (${String(error)})`;
  }
}

export type ReleaseSmokeSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunBoundedReleaseSmokeProcessInput {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  readonly stdio?: "ignore" | "inherit";
  readonly spawnProcess?: ReleaseSmokeSpawnProcess;
  readonly platform?: NodeJS.Platform;
  readonly signalPosixProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly terminateWindowsProcessTree?: (child: ChildProcess) => string | null;
}

export interface ReleaseSmokeProcessInvocation extends Omit<
  RunBoundedReleaseSmokeProcessInput,
  | "killGraceMs"
  | "platform"
  | "signalPosixProcessGroup"
  | "spawnProcess"
  | "stdio"
  | "terminateWindowsProcessTree"
> {
  readonly operation: ReleaseSmokeProcessOperation;
  readonly stdio: "inherit";
}

export type ReleaseSmokeProcessRunner = (
  invocation: ReleaseSmokeProcessInvocation,
) => Promise<void>;

function assertFiniteProcessDuration(name: string, value: number, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a finite integer of at least ${minimum}ms.`);
  }
}

function renderProcessCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((value) => JSON.stringify(value)).join(" ");
}

const RELEASE_SMOKE_SUPERVISOR_ANCHOR_REQUEST = "release-smoke-supervisor-anchor";
const RELEASE_SMOKE_SUPERVISOR_ANCHORED = "release-smoke-supervisor-anchored";

const RELEASE_SMOKE_POSIX_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(1);
let anchored = false;
let completed = false;

process.on("SIGTERM", () => {});
process.on("message", (message) => {
  if (message !== ${JSON.stringify(RELEASE_SMOKE_SUPERVISOR_ANCHOR_REQUEST)} || completed) return;
  anchored = true;
  if (process.send) process.send(${JSON.stringify(RELEASE_SMOKE_SUPERVISOR_ANCHORED)});
});

const finish = (code) => {
  if (anchored || completed) return;
  completed = true;
  if (process.connected) process.disconnect();
  process.exitCode = code;
};

const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
child.once("error", () => finish(1));
child.once("close", (code) => finish(code === null ? 1 : code));
`;

function signalReleaseSmokePosixProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  signalProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
): string | null {
  const pid = child.pid;
  if (!pid) return "child PID was unavailable";

  try {
    // detached: true creates an isolated POSIX process group whose id is the
    // spawned process id. A negative pid signals the full descendant group.
    signalProcessGroup(-pid, signal);
    return null;
  } catch (groupError) {
    if ((groupError as NodeJS.ErrnoException).code === "ESRCH") return null;
    try {
      child.kill(signal);
      return `process-group ${signal} failed; used direct-child fallback`;
    } catch (childError) {
      return `process-group ${signal} failed (${String(groupError)}); direct child failed (${String(childError)})`;
    }
  }
}

function terminateWindowsReleaseSmokeProcessTree(child: ChildProcess): string | null {
  const pid = child.pid;
  if (!pid) return "child PID was unavailable";
  return executeWindowsReleaseSmokeTermination({
    pid,
    force: false,
    directKill: (fallbackSignal) => child.kill(fallbackSignal),
  });
}

function anchorReleaseSmokeSupervisor(child: ChildProcess): Promise<boolean> {
  if (!child.connected || typeof child.send !== "function") return Promise.resolve(false);
  return new Promise((resolveAnchor) => {
    let settled = false;
    const settle = (anchored: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      child.off("message", onMessage);
      child.off("close", onClose);
      resolveAnchor(anchored);
    };
    const onMessage = (message: unknown): void => {
      if (message === RELEASE_SMOKE_SUPERVISOR_ANCHORED) settle(true);
    };
    const onClose = (): void => settle(false);
    const timeoutHandle = setTimeout(
      () => settle(false),
      RELEASE_SMOKE_SUPERVISOR_ANCHOR_TIMEOUT_MS,
    );
    child.on("message", onMessage);
    child.once("close", onClose);
    try {
      child.send(RELEASE_SMOKE_SUPERVISOR_ANCHOR_REQUEST, (error) => {
        if (error) settle(false);
      });
    } catch {
      settle(false);
    }
  });
}

export function runBoundedReleaseSmokeProcess({
  label,
  command,
  args,
  cwd,
  timeoutMs,
  killGraceMs = RELEASE_SMOKE_PROCESS_KILL_GRACE_MS,
  stdio = "inherit",
  platform = process.platform,
  spawnProcess = (spawnCommand, spawnArgs, spawnOptions) =>
    spawn(spawnCommand, [...spawnArgs], spawnOptions),
  signalPosixProcessGroup = (pid, signal) => process.kill(pid, signal),
  terminateWindowsProcessTree = terminateWindowsReleaseSmokeProcessTree,
}: RunBoundedReleaseSmokeProcessInput): Promise<void> {
  if (label.trim().length === 0) throw new Error("Release smoke process label must not be empty.");
  if (command.trim().length === 0) {
    throw new Error("Release smoke process command must not be empty.");
  }
  assertFiniteProcessDuration("Release smoke process timeout", timeoutMs);
  assertFiniteProcessDuration("Release smoke process kill grace", killGraceMs, true);

  const renderedCommand = renderProcessCommand(command, args);
  return new Promise((resolveProcess, rejectProcess) => {
    const usePosixSupervisor = platform !== "win32";
    const child = spawnProcess(
      usePosixSupervisor ? process.execPath : command,
      usePosixSupervisor ? ["-e", RELEASE_SMOKE_POSIX_SUPERVISOR_SOURCE, command, ...args] : args,
      {
        cwd,
        detached: true,
        killSignal: RELEASE_SMOKE_GRACEFUL_KILL_SIGNAL,
        stdio: usePosixSupervisor ? [stdio, stdio, stdio, "ipc"] : stdio,
        windowsHide: true,
      },
    );
    const terminationDiagnostics: string[] = [];
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;
    let timeoutSettlementHandle: NodeJS.Timeout | undefined;
    let forceKillIssued = false;

    const settleTimeout = (terminationSummary: string): void => {
      const diagnostics =
        terminationDiagnostics.length === 0
          ? ""
          : ` Termination diagnostics: ${terminationDiagnostics.join("; ")}.`;
      settle(
        new Error(
          `${label} timed out after ${timeoutMs}ms while running ${renderedCommand}; ${terminationSummary}.${diagnostics}`,
        ),
      );
    };

    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (timeoutSettlementHandle) clearTimeout(timeoutSettlementHandle);
      if (error) rejectProcess(error);
      else resolveProcess();
    };

    child.once("error", (error) => {
      if (timedOut) {
        terminationDiagnostics.push(`child error after timeout: ${error.message}`);
        return;
      }
      settle(new Error(`${label} failed to start ${renderedCommand}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        if (forceKillIssued) {
          settleTimeout(
            `terminated its isolated process tree with ${RELEASE_SMOKE_GRACEFUL_KILL_SIGNAL} followed by ${RELEASE_SMOKE_FORCE_KILL_SIGNAL}`,
          );
          return;
        }
        if (forceKillHandle) clearTimeout(forceKillHandle);
        terminationDiagnostics.push(
          "supervised leader closed before forced escalation; cancelled the cached process-group identity",
        );
        settleTimeout("stopped termination without signaling a stale process identity");
        return;
      }
      if (code === 0) {
        settle();
        return;
      }
      settle(
        new Error(
          `${label} failed: ${renderedCommand} exited with ${code === null ? `signal ${signal ?? "<unknown>"}` : `code ${code}`}.`,
        ),
      );
    });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (platform === "win32") {
        const diagnostic = terminateWindowsProcessTree(child);
        if (diagnostic) terminationDiagnostics.push(diagnostic);
        settleTimeout("ran its authoritative Windows tree-first termination sequence once");
        return;
      }

      void anchorReleaseSmokeSupervisor(child).then((anchored) => {
        if (settled) return;
        if (!anchored) {
          terminationDiagnostics.push(
            "supervisor identity could not be anchored before termination",
          );
          settleTimeout("stopped termination without signaling an unanchored process identity");
          return;
        }

        const gracefulDiagnostic = signalReleaseSmokePosixProcessTree(
          child,
          RELEASE_SMOKE_GRACEFUL_KILL_SIGNAL,
          signalPosixProcessGroup,
        );
        if (gracefulDiagnostic) terminationDiagnostics.push(gracefulDiagnostic);

        forceKillHandle = setTimeout(() => {
          forceKillIssued = true;
          const forceDiagnostic = signalReleaseSmokePosixProcessTree(
            child,
            RELEASE_SMOKE_FORCE_KILL_SIGNAL,
            signalPosixProcessGroup,
          );
          if (forceDiagnostic) terminationDiagnostics.push(forceDiagnostic);

          timeoutSettlementHandle = setTimeout(() => {
            settleTimeout(
              `terminated its isolated process tree with ${RELEASE_SMOKE_GRACEFUL_KILL_SIGNAL} followed by ${RELEASE_SMOKE_FORCE_KILL_SIGNAL}`,
            );
          }, RELEASE_SMOKE_PROCESS_FORCE_SETTLE_MS);
        }, killGraceMs);
      });
    }, timeoutMs);
  });
}

function runReleaseSmokeProcess(
  operation: ReleaseSmokeProcessOperation,
  command: string,
  args: readonly string[],
  cwd: string,
  processRunner: ReleaseSmokeProcessRunner,
): Promise<void> {
  const operationPlan = RELEASE_SMOKE_PROCESS_PLAN[operation];
  return processRunner(
    Object.freeze({
      operation,
      label: operationPlan.label,
      command,
      args: Object.freeze([...args]),
      cwd,
      timeoutMs: operationPlan.timeoutMs,
      stdio: "inherit",
    }),
  );
}

const defaultReleaseSmokeProcessRunner: ReleaseSmokeProcessRunner = (invocation) => {
  return runBoundedReleaseSmokeProcess({
    label: invocation.label,
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs,
    stdio: invocation.stdio,
  });
};

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Moss-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: Moss-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: Moss-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Moss-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: Moss-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: Moss-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function readWorkflowStep(workflow: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Expected workflow step: ${stepName}.`);
  }
  const nextStep = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, nextStep === -1 ? workflow.length : nextStep);
}

interface LocatedWorkflowStep {
  readonly index: number;
  readonly step: Record<string, unknown>;
}

function readWorkflowRunScript(step: Record<string, unknown>, stepName: string): string {
  if (typeof step.run !== "string" || step.run.trim().length === 0) {
    throw new Error(`Expected ${stepName} to use a shell run block.`);
  }
  return step.run.replace(/\r\n/gu, "\n").replace(/\n$/u, "");
}

function readSingleWorkflowCommand(step: Record<string, unknown>, stepName: string): string {
  return readWorkflowRunScript(step, stepName)
    .replace(/\\\r?\n[ \t]*/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function assertUnconditionalFailClosedStep(step: Record<string, unknown>, stepName: string): void {
  if (Object.hasOwn(step, "if")) {
    throw new Error(`Expected ${stepName} to be unconditional on its job execution path.`);
  }
  if (Object.hasOwn(step, "continue-on-error")) {
    throw new Error(`Expected ${stepName} to fail closed without continue-on-error.`);
  }
}

interface ConfiguredRunSetting {
  readonly scope: string;
  readonly value: unknown;
}

function readDefaultRunSetting(
  owner: Record<string, unknown>,
  scope: string,
  setting: "shell" | "working-directory",
): ConfiguredRunSetting | null {
  if (!Object.hasOwn(owner, "defaults")) return null;
  const defaults = owner.defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error(`Expected ${scope} defaults to be an object.`);
  }
  if (!Object.hasOwn(defaults, "run")) return null;
  const run = (defaults as Record<string, unknown>).run;
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`Expected ${scope} defaults.run to be an object.`);
  }
  if (!Object.hasOwn(run, setting)) return null;
  return {
    scope: `${scope} defaults.run.${setting}`,
    value: (run as Record<string, unknown>)[setting],
  };
}

function readDefaultRunShell(
  owner: Record<string, unknown>,
  scope: string,
): ConfiguredRunSetting | null {
  return readDefaultRunSetting(owner, scope, "shell");
}

function assertNoWorkingDirectoryOverride(
  workflow: Record<string, unknown>,
  job: Record<string, unknown>,
  step: Record<string, unknown>,
  stepName: string,
  jobName = "release",
): void {
  const configuredWorkingDirectory = [
    ...(Object.hasOwn(step, "working-directory")
      ? [
          {
            scope: `${stepName} working-directory`,
            value: step["working-directory"],
          } satisfies ConfiguredRunSetting,
        ]
      : []),
    readDefaultRunSetting(job, `${jobName} job`, "working-directory"),
    readDefaultRunSetting(workflow, "workflow", "working-directory"),
  ].find((value): value is ConfiguredRunSetting => value !== null);
  if (configuredWorkingDirectory) {
    throw new Error(
      `Expected ${stepName} to run from the repository root without working-directory; ${configuredWorkingDirectory.scope} was ${JSON.stringify(configuredWorkingDirectory.value)}.`,
    );
  }
}

function assertNoBashStartupOverride(
  scopes: readonly {
    readonly label: string;
    readonly owner: Record<string, unknown>;
  }[],
): void {
  for (const scope of scopes) {
    if (!Object.hasOwn(scope.owner, "env")) continue;
    const environment = scope.owner.env;
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new Error(`Expected ${scope.label} env to be an object.`);
    }
    if (Object.hasOwn(environment, "BASH_ENV")) {
      throw new Error(
        `Expected ${scope.label} to leave BASH_ENV unset so Bash cannot run a startup override.`,
      );
    }
  }
}

function assertExecutableGithubBashShell(
  workflow: Record<string, unknown>,
  job: Record<string, unknown>,
  step: Record<string, unknown>,
  stepName: string,
): void {
  if (job["runs-on"] !== "ubuntu-24.04") {
    throw new Error(
      `Expected release job to use ubuntu-24.04 for the default executable GitHub bash shell.`,
    );
  }
  if (Object.hasOwn(job, "container")) {
    throw new Error(
      `Expected release job to run directly on ubuntu-24.04 without a shell-changing container.`,
    );
  }
  const effectiveShell = [
    ...(Object.hasOwn(step, "shell")
      ? [{ scope: `${stepName} shell`, value: step.shell } satisfies ConfiguredRunSetting]
      : []),
    readDefaultRunShell(job, "release job"),
    readDefaultRunShell(workflow, "workflow"),
  ].find((value): value is ConfiguredRunSetting => value !== null);
  if (effectiveShell && effectiveShell.value !== "bash") {
    throw new Error(
      `Expected ${stepName} to use the executable GitHub bash shell; ${effectiveShell.scope} was ${JSON.stringify(effectiveShell.value)}.`,
    );
  }
  assertNoWorkingDirectoryOverride(workflow, job, step, stepName);
  assertNoBashStartupOverride([
    { label: "workflow", owner: workflow },
    { label: "release job", owner: job },
    { label: stepName, owner: step },
  ]);
}

const STABLE_UPDATER_ALIAS_PIPELINE = [
  {
    stepName: "Assemble attested final release set",
    command: [
      "node scripts/assemble-bundled-codex-final-release-set.ts",
      "release-components",
      "release-assets",
      '--channel "${{ needs.preflight.outputs.update_channel }}"',
    ].join(" "),
    error: "Expected the alias-producing assembly command for stable updater assets.",
  },
  {
    stepName: "Gate exact final release upload set",
    command: [
      "node scripts/verify-bundled-codex-final-release-set.ts",
      "release-assets",
      "--require-publish-eligible",
    ].join(" "),
    error: "Expected the publish-eligible verification command for assembled updater aliases.",
  },
  {
    stepName: "Validate and attest exact release assets",
    command: [
      "node scripts/prepare-release-asset-bundle.ts",
      "--asset-directory release-assets",
      '--index-path "$RUNNER_TEMP/release-asset-index.json"',
      '--version "${{ needs.preflight.outputs.version }}"',
      '--channel "${{ needs.preflight.outputs.update_channel }}"',
      '--source-repository "$GITHUB_REPOSITORY"',
      '--source-commit "$GITHUB_SHA"',
      '--lockfile-sha256 "${{ needs.preflight.outputs.lockfile_sha256 }}"',
      '--workflow-run-id "$GITHUB_RUN_ID"',
      '--workflow-run-attempt "$GITHUB_RUN_ATTEMPT"',
      '--event "$GITHUB_EVENT_NAME"',
      '--ref "$GITHUB_REF"',
    ].join(" "),
    error: "Expected the exact alias-attestation command for the final release asset set.",
  },
] as const;

export function assertStableUpdaterAliasPipeline(workflow: string): void {
  const parsedWorkflow = readWorkflowDocument(workflow);
  const releaseJob = readWorkflowJobFromDocument(parsedWorkflow, "release");
  const releaseSteps = readWorkflowJobSteps(releaseJob, "release");
  let previousStepIndex = -1;
  for (const expectation of STABLE_UPDATER_ALIAS_PIPELINE) {
    const located = readUniqueWorkflowStep(releaseSteps, "release", expectation.stepName);
    assertUnconditionalFailClosedStep(located.step, expectation.stepName);
    assertExecutableGithubBashShell(parsedWorkflow, releaseJob, located.step, expectation.stepName);
    if (located.index <= previousStepIndex) {
      throw new Error("Expected updater alias assembly, verification, and attestation in order.");
    }
    previousStepIndex = located.index;
    if (readSingleWorkflowCommand(located.step, expectation.stepName) !== expectation.command) {
      throw new Error(expectation.error);
    }
  }
}

const MAC_SIGNING_INPUTS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_TEAM_ID",
] as const;

const MAC_SIGNING_GATE = `  if has_all ${MAC_SIGNING_INPUTS.map((name) => `"$${name}"`).join(" ")}; then`;

const MAC_SIGNING_PREAMBLE = [
  "args=(",
  '  --platform "${{ matrix.platform }}"',
  '  --target "${{ matrix.target }}"',
  '  --arch "${{ matrix.arch }}"',
  '  --build-version "${{ needs.preflight.outputs.version }}"',
  '  --source-commit "${{ steps.source_provenance.outputs.source_commit }}"',
  '  --lockfile-sha256 "${{ steps.source_provenance.outputs.lockfile_sha256 }}"',
  "  --verbose",
  ")",
  "",
  'if [[ "$PUBLISH_RELEASE" == "true" ]]; then',
  "  args+=(--release-mode publish --production-config-mode strict)",
  '  echo "Public release policy enabled: production configuration and platform signing fail closed."',
  "else",
  "  args+=(--release-mode build-only --production-config-mode strict)",
  '  echo "Build-only/internal QA policy enabled: production configuration is strict, unsigned artifacts are allowed, and nothing will be published."',
  "fi",
  "",
] as const;

const HAS_ALL_FUNCTION = [
  "has_all() {",
  '  for value in "$@"; do',
  '    if [[ -z "$value" ]]; then',
  "      return 1",
  "    fi",
  "  done",
  "  return 0",
  "}",
] as const;

function staticallyDequoteShellFragments(line: string): string {
  return line.replace(/'([^'\s]*)'/gu, "$1").replace(/"([^"$`\\\s]*)"/gu, "$1");
}

function isDynamicShellStateLoader(line: string): boolean {
  const trimmed = staticallyDequoteShellFragments(line).trim();
  return (
    /^(?:(?:builtin|command)[ \t]+)?(?:eval|source)(?:[ \t]|<|$)/u.test(trimmed) ||
    /^\.[ \t]+/u.test(trimmed)
  );
}

function isBashFunctionDefinition(line: string): boolean {
  const trimmed = staticallyDequoteShellFragments(line).trimStart();
  return (
    /^function(?:[ \t]|$)/u.test(trimmed) || /^[^#\s=;]+[ \t]*\(\)[ \t]*(?:\{|$)/u.test(trimmed)
  );
}

function isPotentialIndirectFunctionOverride(line: string): boolean {
  const dequoted = staticallyDequoteShellFragments(line);
  const trimmed = dequoted.trim();
  if (
    isDynamicShellStateLoader(line) ||
    /^(?:(?:builtin|command)[ \t]+)?trap(?:[ \t]|$)/u.test(trimmed)
  ) {
    return true;
  }
  return (
    /^(?:(?:builtin|command)[ \t]+)?unset(?:[ \t]|$)/u.test(trimmed) &&
    ![...MAC_SIGNING_INPUTS, "PUBLISH_RELEASE"].some((name) =>
      new RegExp(`\\b${name}\\b`, "u").test(dequoted),
    )
  );
}

function assertHasAllChecksEveryArgument(scriptLines: readonly string[]): number {
  const definitions = scriptLines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) =>
      /^(?:function[ \t]+)?has_all(?:[ \t]*\(\))?[ \t]*(?:\{|$)/u.test(
        staticallyDequoteShellFragments(line).trimStart(),
      ),
    );
  const definition = definitions[0];
  if (definitions.length !== 1 || !definition) {
    throw new Error("Expected has_all to have one canonical definition without a later override.");
  }
  const functionStart = definition.index;
  const implementation = scriptLines.slice(functionStart, functionStart + HAS_ALL_FUNCTION.length);
  if (
    implementation.length !== HAS_ALL_FUNCTION.length ||
    implementation.some((line, index) => line !== HAS_ALL_FUNCTION[index])
  ) {
    throw new Error(
      "Expected has_all to iterate all arguments, return 1 for empty values, and return 0 only after checking every argument.",
    );
  }
  const allowedReferences = new Set([
    HAS_ALL_FUNCTION[0],
    MAC_SIGNING_GATE.trim(),
    "if has_all \\",
  ]);
  for (const line of scriptLines) {
    const dequoted = staticallyDequoteShellFragments(line);
    const trimmed = line.trim();
    if (isBashFunctionDefinition(line) && trimmed !== HAS_ALL_FUNCTION[0]) {
      throw new Error(
        "Expected has_all to remain canonical without any later Bash function definition.",
      );
    }
    if (/\bhas_all\b/u.test(dequoted) && !allowedReferences.has(trimmed)) {
      throw new Error(
        "Expected has_all to remain canonical without reassignment, removal, or override.",
      );
    }
    if (isPotentialIndirectFunctionOverride(line)) {
      throw new Error(
        "Expected has_all to remain canonical without dynamic or indirect overrides.",
      );
    }
  }
  return functionStart;
}

function assertSigningInputsUntampered(
  scriptLines: readonly string[],
  signingGateIndex: number,
): void {
  const beforeSigningGate = scriptLines.slice(0, signingGateIndex);
  const allowedPublishReleaseReferences = new Set([
    'if [[ "$PUBLISH_RELEASE" == "true" ]]; then',
    'elif [[ "$PUBLISH_RELEASE" == "true" ]]; then',
  ]);
  for (const line of beforeSigningGate) {
    const dequoted = staticallyDequoteShellFragments(line);
    const trimmed = line.trim();
    if (/\bPUBLISH_RELEASE\b/u.test(dequoted) && !allowedPublishReleaseReferences.has(trimmed)) {
      throw new Error(
        "Expected PUBLISH_RELEASE to remain bound to the preflight env mapping without run-block tampering.",
      );
    }
    for (const name of MAC_SIGNING_INPUTS) {
      if (new RegExp(`\\b${name}\\b`, "u").test(dequoted)) {
        throw new Error(
          `Expected ${name} to remain bound to its gated env mapping without run-block tampering.`,
        );
      }
    }
    if (
      /^(?:(?:builtin|command)[ \t]+)?(?:unset|readonly|declare|typeset|export|local|read|readarray|mapfile|getopts|let)(?:[ \t]|$)/u.test(
        dequoted.trim(),
      ) ||
      /^(?:(?:builtin|command)[ \t]+)?printf\b.*(?:^|[ \t])-v(?:[ \t]|$)/u.test(dequoted.trim())
    ) {
      throw new Error(
        "Expected the signing environment to remain bound without indirect run-block tampering.",
      );
    }
  }
}

function assertCanonicalSigningPreamble(
  scriptLines: readonly string[],
  hasAllFunctionIndex: number,
  signingGateIndex: number,
): void {
  const preamble = scriptLines.slice(0, hasAllFunctionIndex);
  const betweenFunctionAndPlatformGate = scriptLines.slice(
    hasAllFunctionIndex + HAS_ALL_FUNCTION.length,
    signingGateIndex - 1,
  );
  if (
    preamble.length !== MAC_SIGNING_PREAMBLE.length ||
    preamble.some((line, index) => line !== MAC_SIGNING_PREAMBLE[index]) ||
    betweenFunctionAndPlatformGate.length !== 1 ||
    betweenFunctionAndPlatformGate[0] !== ""
  ) {
    throw new Error(
      "Expected Build desktop artifact to retain the exact canonical signing preamble without extra executable shell text.",
    );
  }
}

const MAC_BUILD_MATRIX_CONTRACTS = [
  {
    label: "macOS arm64",
    runner: "macos-14",
    platform: "mac",
    target: "dmg",
    arch: "arm64",
  },
  {
    label: "macOS x64",
    runner: "macos-15-intel",
    platform: "mac",
    target: "dmg",
    arch: "x64",
  },
] as const;

function assertMacBuildRunnerContract(buildJob: Record<string, unknown>): void {
  if (Object.hasOwn(buildJob, "container")) {
    throw new Error("Expected build job to run on the reviewed GitHub host without a container.");
  }
  if (Object.hasOwn(buildJob, "continue-on-error")) {
    throw new Error("Expected build job to fail the workflow without job-level continue-on-error.");
  }
  if (Object.hasOwn(buildJob, "if")) {
    throw new Error("Expected build job to execute without a job-level if condition.");
  }
  if (buildJob["runs-on"] !== "${{ matrix.runner }}") {
    throw new Error("Expected build job runs-on to be exactly ${{ matrix.runner }}.");
  }

  const strategy = buildJob.strategy;
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    throw new Error("Expected build job to define its reviewed runner matrix.");
  }
  const matrix = (strategy as Record<string, unknown>).matrix;
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("Expected build job strategy.matrix to be an object.");
  }
  if (
    Object.keys(matrix).length !== 1 ||
    !Object.hasOwn(matrix, "include") ||
    !Array.isArray((matrix as Record<string, unknown>).include)
  ) {
    throw new Error("Expected build job matrix to use only the reviewed literal include rows.");
  }

  const includeRows = ((matrix as Record<string, unknown>).include as unknown[]).map(
    (row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Expected build job matrix include row ${index + 1} to be an object.`);
      }
      return row as Record<string, unknown>;
    },
  );
  const allowedPlatforms = new Set(["mac", "linux", "win"]);
  for (const row of includeRows) {
    if (typeof row.platform !== "string" || !allowedPlatforms.has(row.platform)) {
      throw new Error("Expected every build matrix platform to be a reviewed literal value.");
    }
  }

  const macRows = includeRows.filter((row) => row.platform === "mac");
  const hasExactContract = (row: Record<string, unknown>) =>
    MAC_BUILD_MATRIX_CONTRACTS.some((contract) =>
      Object.entries(contract).every(([key, value]) => row[key] === value),
    );
  if (
    macRows.length !== MAC_BUILD_MATRIX_CONTRACTS.length ||
    macRows.some((row) => !hasExactContract(row)) ||
    MAC_BUILD_MATRIX_CONTRACTS.some(
      (contract) =>
        macRows.filter((row) =>
          Object.entries(contract).every(([key, value]) => row[key] === value),
        ).length !== 1,
    )
  ) {
    throw new Error(
      "Expected macOS build matrix rows to preserve the reviewed runner contract for arm64 and x64.",
    );
  }
}

export function assertMacSigningFailsClosed(workflow: string): void {
  const stepName = "Build desktop artifact";
  const parsedWorkflow = readWorkflowDocument(workflow);
  const buildJob = readWorkflowJobFromDocument(parsedWorkflow, "build");
  assertMacBuildRunnerContract(buildJob);
  const located = readUniqueWorkflowStep(
    readWorkflowJobSteps(buildJob, "build"),
    "build",
    stepName,
  );
  assertUnconditionalFailClosedStep(located.step, stepName);
  if (located.step.shell !== "bash") {
    throw new Error(`Expected ${stepName} to use the explicit GitHub bash shell.`);
  }
  assertNoBashStartupOverride([
    { label: "workflow", owner: parsedWorkflow },
    { label: "build job", owner: buildJob },
    { label: stepName, owner: located.step },
  ]);
  assertNoWorkingDirectoryOverride(parsedWorkflow, buildJob, located.step, stepName, "build");
  const environment = located.step.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error(`Expected ${stepName} to map the macOS signing environment.`);
  }
  for (const name of MAC_SIGNING_INPUTS) {
    const expected =
      `\${{ needs.preflight.outputs.publish_release == 'true' && ` +
      `matrix.platform == 'mac' && secrets.${name} || '' }}`;
    if ((environment as Record<string, unknown>)[name] !== expected) {
      throw new Error(`Expected ${stepName} to map ${name} from its gated repository secret.`);
    }
  }
  if (
    (environment as Record<string, unknown>).PUBLISH_RELEASE !==
    "${{ needs.preflight.outputs.publish_release }}"
  ) {
    throw new Error(
      `Expected ${stepName} to map PUBLISH_RELEASE from the trusted preflight output.`,
    );
  }

  const scriptLines = readWorkflowRunScript(located.step, stepName).split("\n");
  const macPlatformBranch = 'if [[ "${{ matrix.platform }}" == "mac" ]]; then';
  const signingGateIndex = scriptLines.indexOf(MAC_SIGNING_GATE);
  if (signingGateIndex < 1 || scriptLines[signingGateIndex - 1] !== macPlatformBranch) {
    throw new Error("Expected macOS signing to require all six Apple signing inputs.");
  }
  const hasAllFunctionIndex = assertHasAllChecksEveryArgument(scriptLines);
  if (hasAllFunctionIndex >= signingGateIndex) {
    throw new Error("Expected has_all to be defined before the macOS signing gate uses it.");
  }
  assertSigningInputsUntampered(scriptLines, signingGateIndex);
  assertCanonicalSigningPreamble(scriptLines, hasAllFunctionIndex, signingGateIndex);

  const nextPeerBranchIndex = scriptLines.findIndex(
    (line, index) =>
      index > signingGateIndex &&
      (line.startsWith("  elif ") || line === "  else" || line === "  fi"),
  );
  if (
    nextPeerBranchIndex === -1 ||
    scriptLines[nextPeerBranchIndex] !== '  elif [[ "$PUBLISH_RELEASE" == "true" ]]; then'
  ) {
    throw new Error("Expected incomplete macOS signing inputs in publish mode to fail closed.");
  }

  if (
    scriptLines[nextPeerBranchIndex + 1] !==
      '    echo "Public macOS releases require complete Apple signing/notarization credentials and APPLE_TEAM_ID." >&2' ||
    scriptLines[nextPeerBranchIndex + 2] !== "    exit 1"
  ) {
    throw new Error("Expected the incomplete macOS publish branch to report an error and exit 1.");
  }
}

const RELEASE_GATE_NEEDS = [
  "preflight",
  "build",
  "gate8_fresh_packaged_user",
  "plugin_gate7_release_database",
  "windows_acceptance",
  "plugin_gate9_release",
  "plugin_parity_final",
] as const;

function readWorkflowDocument(workflow: string): Record<string, unknown> {
  const parsed = parse(workflow) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected release workflow to be a YAML object.");
  }
  return parsed as Record<string, unknown>;
}

function readWorkflowJobFromDocument(
  workflow: Record<string, unknown>,
  jobName: string,
): Record<string, unknown> {
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error("Expected release workflow jobs to be a YAML object.");
  }
  const job = (jobs as Record<string, unknown>)[jobName];
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error(`Expected release workflow job: ${jobName}.`);
  }
  return job as Record<string, unknown>;
}

function readWorkflowJob(workflow: string, jobName: string): Record<string, unknown> {
  return readWorkflowJobFromDocument(readWorkflowDocument(workflow), jobName);
}

function readWorkflowJobSteps(
  job: Record<string, unknown>,
  jobName: string,
): readonly Record<string, unknown>[] {
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`Expected release workflow job ${jobName} to contain steps.`);
  }
  return steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`Expected ${jobName} workflow step ${index + 1} to be an object.`);
    }
    return step as Record<string, unknown>;
  });
}

function readUniqueWorkflowStep(
  steps: readonly Record<string, unknown>[],
  jobName: string,
  stepName: string,
): LocatedWorkflowStep {
  const matches = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.name === stepName);
  const match = matches[0];
  if (matches.length !== 1 || !match) {
    throw new Error(`Expected unique ${jobName} job step: ${stepName}; found ${matches.length}.`);
  }
  return match;
}

const CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME =
  "Verify committed source version and lockfile provenance";

const CROSS_PLATFORM_SOURCE_PROVENANCE_COMMAND = [
  "node scripts/verify-release-source-provenance.ts",
  '"$RELEASE_VERSION"',
  '"$RELEASE_TAG"',
  '"$PUBLISH_RELEASE"',
  '"$SOURCE_COMMIT"',
  '"$SOURCE_REF_TYPE"',
  '"$SOURCE_REF_NAME"',
].join(" ");

const CROSS_PLATFORM_SOURCE_PROVENANCE_ENVIRONMENT = {
  RELEASE_VERSION: "${{ needs.preflight.outputs.version }}",
  RELEASE_TAG: "${{ needs.preflight.outputs.tag }}",
  PUBLISH_RELEASE: "${{ needs.preflight.outputs.publish_release }}",
  SOURCE_COMMIT: "${{ needs.preflight.outputs.ref }}",
  SOURCE_REF_TYPE: "${{ github.ref_type }}",
  SOURCE_REF_NAME: "${{ github.ref_name }}",
} as const;

const CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_KEYS = new Set(["id", "name", "shell", "env", "run"]);

export function assertCrossPlatformSourceProvenanceStep(workflow: string): void {
  const parsedWorkflow = readWorkflowDocument(workflow);
  const buildJob = readWorkflowJobFromDocument(parsedWorkflow, "build");
  if (buildJob["runs-on"] !== "${{ matrix.runner }}") {
    throw new Error("Expected the build job to run on the reviewed cross-platform runner matrix.");
  }

  const strategy = buildJob.strategy;
  const matrix =
    strategy && typeof strategy === "object" && !Array.isArray(strategy)
      ? (strategy as Record<string, unknown>).matrix
      : null;
  const includeRows =
    matrix && typeof matrix === "object" && !Array.isArray(matrix)
      ? (matrix as Record<string, unknown>).include
      : null;
  if (!Array.isArray(includeRows)) {
    throw new Error("Expected the build job to define a literal cross-platform runner matrix.");
  }
  const windowsRows = includeRows.filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>).label === "Windows x64" &&
      (row as Record<string, unknown>).runner === "windows-2022" &&
      (row as Record<string, unknown>).platform === "win" &&
      (row as Record<string, unknown>).target === "nsis" &&
      (row as Record<string, unknown>).arch === "x64",
  );
  if (windowsRows.length !== 1) {
    throw new Error(
      "Expected the cross-platform build matrix to contain the reviewed Windows x64 runner exactly once.",
    );
  }

  const steps = readWorkflowJobSteps(buildJob, "build");
  const idMatches = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.id === "source_provenance");
  const nameMatches = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.name === CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME);
  const located = idMatches[0];
  if (
    idMatches.length !== 1 ||
    nameMatches.length !== 1 ||
    !located ||
    located.index !== nameMatches[0]?.index
  ) {
    throw new Error(
      "Expected one unique build job provenance step identity with id source_provenance and the exact reviewed name.",
    );
  }

  assertUnconditionalFailClosedStep(located.step, CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME);
  const unexpectedStepKeys = Object.keys(located.step).filter(
    (key) => !CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_KEYS.has(key),
  );
  if (unexpectedStepKeys.length > 0) {
    throw new Error(
      `Expected ${CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME} to use the closed reviewed key set; unexpected keys: ${unexpectedStepKeys.join(", ")}.`,
    );
  }
  if (located.step.shell !== "bash") {
    throw new Error(
      `Expected ${CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME} to use the explicit GitHub bash shell.`,
    );
  }
  if (
    readSingleWorkflowCommand(located.step, CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME) !==
    CROSS_PLATFORM_SOURCE_PROVENANCE_COMMAND
  ) {
    throw new Error(
      `Expected ${CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME} to run the exact committed-source provenance command with every reviewed argument.`,
    );
  }

  const environment = located.step.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error(
      `Expected ${CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME} to map its reviewed environment.`,
    );
  }
  const actualEnvironment = environment as Record<string, unknown>;
  if (
    Object.keys(actualEnvironment).length !==
      Object.keys(CROSS_PLATFORM_SOURCE_PROVENANCE_ENVIRONMENT).length ||
    Object.entries(CROSS_PLATFORM_SOURCE_PROVENANCE_ENVIRONMENT).some(
      ([name, value]) => actualEnvironment[name] !== value,
    )
  ) {
    throw new Error(
      `Expected ${CROSS_PLATFORM_SOURCE_PROVENANCE_STEP_NAME} to map only the reviewed preflight and GitHub source values.`,
    );
  }
}

function hasExactStringMembers(value: unknown, expected: readonly string[]): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item) => typeof item !== "string")
  ) {
    return false;
  }
  const actual = new Set(value as string[]);
  return actual.size === expected.length && expected.every((item) => actual.has(item));
}

function normalizedCondition(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim();
}

function expressionBody(condition: string): string | null {
  const match = /^\$\{\{ (.*) \}\}$/u.exec(condition);
  return match?.[1] ?? null;
}

export function assertReleaseGateGraph(workflow: string): void {
  const release = readWorkflowJob(workflow, "release");
  const cleanup = readWorkflowJob(workflow, "cleanup_failed_build_artifacts");
  if (Object.hasOwn(release, "continue-on-error")) {
    throw new Error("Expected release job to fail closed without job-level continue-on-error.");
  }
  if (!hasExactStringMembers(release.needs, RELEASE_GATE_NEEDS)) {
    throw new Error("Expected publication dependencies to include every required release gate.");
  }
  if (!hasExactStringMembers(cleanup.needs, RELEASE_GATE_NEEDS)) {
    throw new Error(
      "Expected failed-run cleanup dependencies to match every required release gate.",
    );
  }

  const releaseCondition = expressionBody(normalizedCondition(release.if));
  const expectedReleaseClauses = [
    "needs.preflight.outputs.publish_release == 'true'",
    ...RELEASE_GATE_NEEDS.filter((name) => name !== "preflight").map(
      (name) => `needs.${name}.result == 'success'`,
    ),
  ];
  const releaseClauses = releaseCondition?.split(" && ") ?? [];
  if (!hasExactStringMembers(releaseClauses, expectedReleaseClauses)) {
    throw new Error(
      "Expected publication success condition to require explicit intent and every release gate.",
    );
  }

  const cleanupCondition = normalizedCondition(cleanup.if);
  const cleanupPrefix =
    "${{ always() && needs.preflight.result == 'success' && (needs.build.result != 'success' || (needs.preflight.outputs.publish_release == 'true' && (";
  const cleanupSuffix = "))) }}";
  if (!cleanupCondition.startsWith(cleanupPrefix) || !cleanupCondition.endsWith(cleanupSuffix)) {
    throw new Error("Expected the failed-run cleanup condition to preserve its fail-closed shape.");
  }
  const cleanupFailureClauses = cleanupCondition
    .slice(cleanupPrefix.length, -cleanupSuffix.length)
    .split(" || ");
  const expectedCleanupFailureClauses = RELEASE_GATE_NEEDS.filter(
    (name) => name !== "preflight" && name !== "build",
  ).map((name) => `needs.${name}.result != 'success'`);
  if (!hasExactStringMembers(cleanupFailureClauses, expectedCleanupFailureClauses)) {
    throw new Error(
      "Expected the failed-run cleanup condition to cover every required release gate.",
    );
  }
}

function readWorkflowStepById(workflow: string, stepId: string): string {
  const marker = `      - id: ${stepId}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Expected workflow step id: ${stepId}.`);
  }
  const nextStep = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, nextStep === -1 ? workflow.length : nextStep);
}

export interface CanonicalCliPackageIdentity {
  readonly name?: unknown;
  readonly bin?: unknown;
}

export function assertCanonicalCliBinaryIdentity(serverPackage: CanonicalCliPackageIdentity): void {
  if (serverPackage.name !== "@synara/cli") {
    throw new Error(
      `Expected the Moss-first CLI package @synara/cli, got ${serverPackage.name ?? "<missing>"}.`,
    );
  }
  const expectedBinaries: Readonly<Record<string, string>> = {
    moss: "dist/index.mjs",
    "moss-restore-migration-backup": "dist/restoreMigrationBackup.mjs",
  };
  const binaries = serverPackage.bin;
  const hasExactBinaryContract =
    binaries !== null &&
    typeof binaries === "object" &&
    !Array.isArray(binaries) &&
    Object.keys(binaries).length === Object.keys(expectedBinaries).length &&
    Object.keys(binaries).every(
      (name) =>
        Object.hasOwn(expectedBinaries, name) &&
        (binaries as Readonly<Record<string, unknown>>)[name] === expectedBinaries[name],
    );
  if (!hasExactBinaryContract) {
    throw new Error(
      "Expected the native Moss CLI binary contract: moss must be the primary dist/index.mjs entry and moss-restore-migration-backup must be the only recovery binary at dist/restoreMigrationBackup.mjs.",
    );
  }
}

function verifyCanonicalIdentity(): void {
  const serverPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"),
  ) as CanonicalCliPackageIdentity;
  assertCanonicalCliBinaryIdentity(serverPackage);
  if (MOSS_PRODUCTION_BUNDLE_ID !== "com.moss.desktop") {
    throw new Error(`Unexpected production bundle ID: ${MOSS_PRODUCTION_BUNDLE_ID}.`);
  }
  if (MOSS_DESKTOP_UPDATE_CHANNEL !== "moss") {
    throw new Error(`Unexpected desktop update channel: ${MOSS_DESKTOP_UPDATE_CHANNEL}.`);
  }

  const releasePolicy = readReleaseUpdatePolicyConfig(repoRoot);
  const resolvedPolicy = resolveReleaseUpdatePolicy("9.9.9", releasePolicy);
  if (
    resolvedPolicy.lane !== "clean" ||
    !resolvedPolicy.makeLatest ||
    resolvedPolicy.mirrorToStableChannel ||
    resolvedPolicy.channel !== MOSS_DESKTOP_UPDATE_CHANNEL
  ) {
    throw new Error(
      "Expected stable Moss releases to publish on GitHub Latest with the dedicated Moss alias.",
    );
  }
}

export function normalizeReleaseSmokeSourceText(source: string): string {
  return source.replace(/\r\n?/gu, "\n");
}

function verifyReleaseWorkflowSafety(): void {
  const workflow = normalizeReleaseSmokeSourceText(
    readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8"),
  );
  const buildScript = normalizeReleaseSmokeSourceText(
    readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8"),
  );
  const finalPublicationScript = normalizeReleaseSmokeSourceText(
    readFileSync(resolve(repoRoot, "scripts/publish-github-release-final.ts"), "utf8"),
  );
  const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assertContains(
    workflow,
    "\npermissions: {}\n",
    "Expected the release workflow to deny GITHUB_TOKEN permissions by default.",
  );
  assertNotContains(
    workflow,
    "permissions:\n  contents: write\n  id-token: write",
    "Release-wide publication permissions must not be inherited by every job.",
  );
  assertContains(
    workflow,
    "  preflight:\n    name: Preflight\n    runs-on: ubuntu-24.04",
    "Expected preflight to receive read-only repository access.",
  );
  assertContains(
    workflow,
    "    timeout-minutes: 20\n    permissions:\n      contents: read\n    outputs:",
    "Expected preflight to use a bounded timeout with read-only repository access.",
  );
  assertContains(
    workflow,
    "  build:\n    name: Build ${{ matrix.label }}\n",
    "Expected artifact builds to receive read-only repository access.",
  );
  assertContains(
    workflow,
    "    timeout-minutes: 45\n    permissions:\n      contents: read\n    strategy:",
    "Expected artifact builds to use a bounded timeout with read-only repository access.",
  );
  assertContains(
    workflow,
    "    environment:\n      name: moss-release-publish\n    timeout-minutes: 20\n    permissions:\n      contents: read",
    "Expected release publication to keep the source token read-only.",
  );
  assertContains(
    workflow,
    "  build_server_tarball:\n    name: Build server tarball\n    if: ${{ needs.preflight.outputs.publish_release == 'true' }}\n    needs: [preflight, build]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      contents: read",
    "Expected server tarball builds to receive read-only repository access.",
  );
  assertContains(
    workflow,
    "owner: ${{ env.MOSS_RELEASE_REPOSITORY_OWNER }}\n          repositories: ${{ env.MOSS_RELEASE_REPOSITORY_NAME }}\n          permission-contents: write",
    "Expected release publication to mint a repository-scoped public-repository token.",
  );
  const workflowDocument = readWorkflowDocument(workflow);
  for (const jobName of [
    "preflight",
    "signed_codex_exact_56",
    "build",
    "gate8_linux_packaged_user",
    "gate8_windows_packaged_user",
    "gate8_fresh_packaged_user",
    "windows_acceptance",
    "plugin_formal_candidate_56",
    "plugin_accessibility_release",
    "release",
  ]) {
    const job = readWorkflowJobFromDocument(workflowDocument, jobName);
    const permissions = job.permissions;
    if (
      !permissions ||
      typeof permissions !== "object" ||
      Array.isArray(permissions) ||
      Object.keys(permissions).length !== 1 ||
      (permissions as Record<string, unknown>).contents !== "read"
    ) {
      throw new Error(`Expected ${jobName} to have only contents: read permissions.`);
    }
  }
  assertContains(
    workflow,
    'publish_release:\n        description: "Publish the verified desktop release from exact current main"',
    "Expected manual release runs to expose explicit publication intent.",
  );
  assertContains(
    workflow,
    "default: false\n        type: boolean",
    "Expected manual release runs to default to build-only mode.",
  );
  assertContains(
    workflow,
    "publish_release: ${{ steps.trusted_ref.outputs.publish_release }}",
    "Expected preflight to expose the resolved publication mode.",
  );
  assertContains(
    workflow,
    'if [[ "$EVENT_NAME" != "workflow_dispatch" || "$EVENT_REF" != "refs/heads/main" ]]',
    "Expected every release run to require a current-main manual dispatch.",
  );
  assertContains(
    workflow,
    "name: Verify owner dispatch and fresh current main",
    "Expected secret-bearing validation to establish exact current main before repository code.",
  );
  assertContains(
    workflow,
    'if [[ "$ACTOR" != "Zluowa" || "$TRIGGERING_ACTOR" != "Zluowa" || "$REPOSITORY_OWNER" != "Zluowa" ]]',
    "Expected Free-plan secret-bearing runs to require the sole owner for initial and rerun actors.",
  );
  assertNotContains(
    workflow,
    "\n  push:\n",
    "Release publication must not accept source tag pushes.",
  );
  assertContains(
    workflow,
    "MOSS_RELEASE_REPOSITORY: Zluowa/moss-releases",
    "Expected desktop publication to target the dedicated public release repository.",
  );
  assertContains(
    workflow,
    "if: ${{ needs.preflight.outputs.publish_release == 'true' }}",
    "Expected GitHub publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "# CLI publication is intentionally not coupled to the desktop transaction.",
    "Expected immutable npm publication to remain outside the desktop release transaction.",
  );
  assertContains(
    workflow,
    "name: Create empty draft release",
    "Expected the desktop release to remain private until its assets verify.",
  );
  assertContains(
    workflow,
    "name: Revalidate owner dispatch and fresh source main before repository code",
    "Expected publication to re-check owner dispatch and authoritative main before repository code runs.",
  );
  assertContains(
    workflow,
    "PUBLISH_RELEASE: ${{ needs.preflight.outputs.publish_release }}",
    "Expected artifact builds to receive explicit release intent.",
  );
  assertStableUpdaterAliasPipeline(workflow);
  assertCrossPlatformSourceProvenanceStep(workflow);
  assertNotContains(
    workflow,
    "name: Align package versions to release version",
    "Release builds must not rewrite package versions after checkout.",
  );
  assertContains(
    workflow,
    '--source-commit "${{ steps.source_provenance.outputs.source_commit }}"',
    "Expected the artifact builder to re-check the attested source commit.",
  );
  assertContains(
    workflow,
    '--lockfile-sha256 "${{ steps.source_provenance.outputs.lockfile_sha256 }}"',
    "Expected the artifact builder to re-check the attested bun.lock digest.",
  );
  assertNotContains(
    workflow,
    "--source-tag",
    "Current-main publication into the separate updater repository must not invent a source tag.",
  );
  assertContains(
    workflow,
    "node scripts/assemble-bundled-codex-final-release-set.ts",
    "Expected stable releases to assemble both Latest and Moss updater aliases.",
  );
  assertContains(
    workflow,
    '--index-path "$RUNNER_TEMP/release-asset-index.json"',
    "Expected release assets to produce an external immutable index.",
  );
  assertContains(
    workflow,
    "EXPECTED_ASSET_INDEX_SHA256: ${{ steps.asset_bundle.outputs.asset_index_sha256 }}",
    "Expected upload and final publication to pin the attested index digest.",
  );
  assertContains(
    workflow,
    "name: Revalidate source, draft, and indexed assets then publish idempotently",
    "Expected source, public tag, draft, and remote index to be revalidated before PATCH.",
  );
  const releaseResolverStep = readWorkflowStepById(workflow, "resolve_release");
  assertContains(
    releaseResolverStep,
    "release_state=$release_state",
    "Expected exact existing drafts and public releases to be resolved for recovery.",
  );
  assertContains(
    releaseResolverStep,
    '.target_commitish == "main"',
    "Expected reusable releases to retain the exact public target identity.",
  );
  assertContains(
    releaseResolverStep,
    ".prerelease == $prerelease",
    "Expected reusable releases to retain the exact prerelease identity.",
  );
  const createDraftStep = readWorkflowStepById(workflow, "create_draft");
  assertContains(
    createDraftStep,
    "steps.resolve_release.outputs.release_state == 'reserved'",
    "Expected draft creation to recover an exact tag reservation after runner interruption.",
  );
  const releaseAssetsStep = readWorkflowStepById(workflow, "release_assets");
  assertContains(
    releaseAssetsStep,
    "provenance-described-core-assets.json",
    "Expected recovery to verify the remote provenance against the immutable core inventory.",
  );
  assertContains(
    releaseAssetsStep,
    "Published release recovery requires the complete attested asset set.",
    "Expected public recovery to fail closed on partial assets.",
  );
  const uploadDraftStep = readWorkflowStep(workflow, "Upload draft assets without overwrite");
  assertContains(
    uploadDraftStep,
    "if: ${{ steps.resolve_release.outputs.release_state != 'published' }}",
    "Expected exact published releases to skip duplicate uploads.",
  );
  assertContains(
    uploadDraftStep,
    "pre-upload-release-assets.json",
    "Expected reusable drafts to validate existing assets before resuming missing uploads.",
  );
  assertContains(
    workflow,
    'node scripts/assert-release-version-monotonic.ts "$RELEASE_VERSION"',
    "Expected stable publication to reject non-increasing public versions.",
  );
  assertContains(
    workflow,
    "pre-patch-remote-assets.json",
    "Expected all authoritative identities and the indexed inventory to be refreshed adjacent to PATCH.",
  );
  const finalPublicationStep = readWorkflowStepById(workflow, "publish_release");
  assertContains(
    finalPublicationStep,
    "node scripts/publish-github-release-final.ts",
    "Expected the sole public mutation to use the idempotent recovery helper.",
  );
  assertContains(
    finalPublicationStep,
    "expected-release-assets.json",
    "Expected final publication to use the exact validated fresh or reusable inventory.",
  );
  assertNotContains(
    finalPublicationStep,
    "post-publish",
    "The final public mutation must not contain fallible post-publication audits.",
  );
  const finalMutation = "node scripts/publish-github-release-final.ts";
  const afterFinalMutation = finalPublicationStep.slice(
    finalPublicationStep.lastIndexOf(finalMutation) + finalMutation.length,
  );
  if (
    afterFinalMutation
      .split("\n")
      .some((line) => line.startsWith("          ") && line.trim().length > 0)
  ) {
    throw new Error("The idempotent public mutation helper must remain the final step command.");
  }
  const postPublicationObservation = readWorkflowStep(
    workflow,
    "Observe published release without changing publication result",
  );
  assertContains(
    postPublicationObservation,
    "continue-on-error: true",
    "Redundant post-publication observation must not fail a confirmed release.",
  );
  assertContains(
    finalPublicationScript,
    "releases/latest",
    "Expected stable make_latest publication to read GitHub's official latest endpoint.",
  );
  assertContains(
    finalPublicationScript,
    "revalidateBeforePublish",
    "Expected every publication attempt to cross the production provenance boundary immediately before PATCH.",
  );
  assertContains(
    finalPublicationScript,
    "Source main moved before a GitHub release publication attempt.",
    "Expected every publication attempt to reject source-main drift.",
  );
  assertContains(
    finalPublicationScript,
    "Public release tag moved before a GitHub release publication attempt.",
    "Expected every publication attempt to reject public-tag drift.",
  );
  assertContains(
    finalPublicationScript,
    "Remote release assets drifted from the immutable asset index.",
    "Expected every publication attempt to reject remote-asset drift.",
  );
  assertContains(
    workflow,
    "secrets[format('MOSS_KEY_E2E_KEY_{0}', needs.preflight.outputs.key_secret_suffix)]",
    "Expected the acceptance Key secret to be bound to the fresh current-main SHA.",
  );
  assertContains(
    workflow,
    "name: Windows installed-app Key acceptance",
    "Expected the Windows installer gate to require a real no-account Key chat.",
  );
  const acceptanceDependencyStep = readWorkflowStep(
    workflow,
    "Install Windows acceptance driver dependencies",
  );
  assertContains(
    acceptanceDependencyStep,
    "run: bun install --frozen-lockfile --ignore-scripts",
    "Expected the Windows acceptance driver install to remain frozen and lifecycle-script-free.",
  );
  assertContains(
    workflow,
    "scripts/smoke-windows-installer.ps1",
    "Expected Windows artifacts to run through the installed-app lifecycle gate.",
  );
  assertContains(
    workflow,
    "-RequireRealChat",
    "Expected the Windows lifecycle gate to forward the real-chat requirement.",
  );
  assertContains(
    workflow,
    '"Moss Installer Gate $env:GITHUB_RUN_ID $env:GITHUB_RUN_ATTEMPT"',
    "Expected the Windows lifecycle gate to exercise a selectable install path containing spaces.",
  );
  const macAcceptanceStep = readWorkflowStep(
    workflow,
    "Exercise current-run macOS DMG on its native build host",
  );
  for (const [needle, message] of [
    ["runner: macos-14", "Expected arm64 builds and acceptance to run on native macOS."],
    ["runner: macos-15-intel", "Expected x64 builds and acceptance to run on native Intel macOS."],
    ["vars.APPLE_TEAM_ID", "Expected publish acceptance to pin the Apple Team ID."],
    [
      "vars.APPLE_DEVELOPER_IDENTITY",
      "Expected publish acceptance to pin the Developer ID identity.",
    ],
    [
      '--expected-apple-team-id "$EXPECTED_APPLE_TEAM_ID"',
      "Expected the Apple Team ID pin to reach the macOS acceptance driver.",
    ],
    [
      '--expected-apple-developer-identity "$EXPECTED_APPLE_DEVELOPER_IDENTITY"',
      "Expected the Developer ID pin to reach the macOS acceptance driver.",
    ],
  ] as const) {
    assertContains(workflow, needle, message);
  }
  for (const [needle, message] of [
    [
      "if: ${{ matrix.platform == 'mac' }}",
      "Expected macOS acceptance to run inside both already-paid native build legs.",
    ],
    [
      "dmgs=(release-publish/Moss-*-${{ matrix.arch }}.dmg)",
      "Expected each native build leg to accept only its own freshly collected DMG.",
    ],
    [
      "node scripts/smoke-mac-installed-app.ts",
      "Expected each macOS build leg to exercise the packaged application.",
    ],
  ] as const) {
    assertContains(macAcceptanceStep, needle, message);
  }
  assertNotContains(
    workflow,
    "\n  macos_acceptance:\n",
    "macOS acceptance must reuse native build runners instead of starting duplicate paid jobs.",
  );
  assertNotContains(
    workflow,
    "Mirror Moss artifacts onto the pinned updater feed",
    "Stable Moss releases must keep their own Latest and moss aliases instead of overwriting the historical bridge.",
  );
  assertContains(
    workflow,
    "args+=(--release-mode publish --production-config-mode strict)",
    "Expected public artifacts to use fail-closed release mode and strict production config.",
  );
  assertContains(
    workflow,
    "args+=(--release-mode build-only --production-config-mode strict)",
    "Expected internal QA artifacts to use explicit build-only mode with strict production config.",
  );
  assertMacSigningFailsClosed(workflow);
  assertContains(
    workflow,
    "Public Windows releases require complete SSL.com eSigner credentials, exact publisher subject, and certificate thumbprint.",
    "Expected public Windows artifacts to fail when SSL.com eSigner is unavailable.",
  );
  assertContains(
    workflow,
    "node scripts/verify-packaged-desktop-startup.ts",
    "Expected every native payload to pass isolated packaged startup before upload.",
  );
  assertContains(
    workflow,
    "node scripts/prepare-release-asset-bundle.ts",
    "Expected the assembled release to produce exact source and asset provenance.",
  );
  assertContains(
    workflow,
    '--source-commit "$GITHUB_SHA"',
    "Expected final release provenance to bind the verified current-main commit.",
  );
  assertContains(
    workflow,
    '--lockfile-sha256 "${{ needs.preflight.outputs.lockfile_sha256 }}"',
    "Expected final release provenance to bind the verified committed bun.lock digest.",
  );
  assertContains(
    workflow,
    "and .source.lockfileSha256 == $lockfile_sha256",
    "Expected final publication to reject provenance with a different lockfile digest.",
  );
  assertContains(
    workflow,
    "release-provenance.json",
    "Expected release notes to identify the exact provenance artifact.",
  );
  assertNotContains(
    workflow,
    "node scripts/write-release-artifact-provenance.ts",
    "Moss must not claim per-platform source-tag provenance for public tags reserved in the updater repository.",
  );
  assertContains(
    workflow,
    '"repos/${MOSS_RELEASE_REPOSITORY}/releases"',
    "Expected GitHub Release publication to use the public updater repository API.",
  );
  assertNotContains(
    workflow,
    "AZURE_CLIENT_SECRET:",
    "Azure credentials must not enter the release workflow while that provider is disabled.",
  );
  assertReleaseGateGraph(workflow);
  assertNotContains(
    workflow,
    "Windows signing is optional; building an unsigned installer",
    "Public workflow must not retain the legacy unsigned Windows release fallback.",
  );
  if (rootPackage.devDependencies?.["electron-builder"] !== "26.8.1") {
    throw new Error("Expected electron-builder to remain pinned exactly to 26.8.1.");
  }
  if (rootPackage.devDependencies?.["@electron/rebuild"] !== "4.2.0") {
    throw new Error("Expected the controlled native rebuild tool to remain pinned to 4.2.0.");
  }
  assertContains(
    buildScript,
    "ChildProcess.make(\n      process.execPath,",
    "Expected artifact builds to invoke the installed pinned electron-builder with Node.",
  );
  assertContains(
    buildScript,
    'electronBuilderCliPath,\n        "--projectDir",',
    "Expected artifact builds to use the resolved electron-builder CLI and staged project directory.",
  );
  assertNotContains(
    buildScript,
    '"bunx"',
    "Expected artifact builds to avoid package-runner downloads.",
  );
  assertContains(
    buildScript,
    '"--frozen-lockfile",',
    "Expected staged production dependencies to install only from the reviewed desktop lockfile.",
  );
  assertContains(
    buildScript,
    "...builderTargets",
    "Expected artifact builds to forward every resolved platform target to electron-builder.",
  );
  assertContains(
    buildScript,
    "validateDesktopReleaseBuildPolicy",
    "Expected the artifact script to enforce release requirements independently of workflow shell logic.",
  );
  assertContains(
    buildScript,
    "timeoutMs: NODE_PTY_SMOKE_TIMEOUT_MS",
    "Expected staged node-pty execution to have a bounded outer timeout.",
  );
  assertContains(
    buildScript,
    "child.kill({ forceKillAfter: 2_000 })",
    "Expected timed-out artifact subprocesses to be terminated instead of consuming the full CI job timeout.",
  );

  const cliScript = readFileSync(resolve(repoRoot, "apps/server/scripts/cli.ts"), "utf8");
  assertContains(
    cliScript,
    "makeTempDirectoryScoped",
    "Expected CLI publication to build an exclusively owned temporary package tree.",
  );
  assertContains(
    cliScript,
    "cwd: stagedPackageDir",
    "Expected npm publication to run only from the isolated CLI stage.",
  );
  assertContains(
    cliScript,
    "Staged CLI bin target is missing its Node shebang",
    "Expected staged CLI commands to remain executable npm bin entries.",
  );
  assertNotContains(
    cliScript,
    ".publish-bak",
    "CLI publication must not mutate and restore source-tree assets.",
  );

  const desktopBuildConfig = readFileSync(
    resolve(repoRoot, "apps/desktop/tsdown.config.mts"),
    "utf8",
  );
  assertContains(
    desktopBuildConfig,
    "__MOSS_WINDOWS_UPDATER_PUBLISHER__",
    "Expected the Windows updater publisher identity to be compiled into the main bundle.",
  );

  const updaterSecurity = readFileSync(
    resolve(repoRoot, "apps/desktop/src/electronUpdaterSecurity.ts"),
    "utf8",
  );
  assertNotContains(
    updaterSecurity,
    "return feedPublisherNames",
    "Runtime signature verification must not trust publisher names from mutable updater config.",
  );
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8");
  const gitAttributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  assertContains(
    gitAttributes,
    "bun.lock text eol=lf",
    "Expected bun.lock to retain byte-identical LF endings on every release runner.",
  );
  assertContains(
    buildScript,
    "DESKTOP_STAGE_LOCK_DIRECTORY",
    "Expected desktop staging to use the dedicated reviewed lock directory.",
  );
  assertContains(
    buildScript,
    "assertDesktopStageInstallPackageMatches",
    "Expected desktop staging to reject a stale dependency-only manifest.",
  );
  assertContains(
    buildScript,
    'createRequire(new URL("./package.json", import.meta.url))',
    "Expected desktop packaging to resolve dependencies from the owning scripts workspace.",
  );
  assertContains(
    buildScript,
    'requireFromScriptsWorkspace.resolve("electron-builder/cli.js")',
    "Expected desktop packaging to resolve electron-builder across Bun hoisting layouts.",
  );
  assertNotContains(
    buildScript,
    "electron-builder.cmd",
    "Desktop packaging must not depend on a Windows bin shim.",
  );
  assertContains(
    buildScript,
    "mossCommitHash: commitHash",
    "Expected the staged package to carry its exact source commit.",
  );
  assertContains(
    buildScript,
    "mossLockfileSha256: resolvedLockfileSha256",
    "Expected the staged package to carry its repository lockfile digest.",
  );
  assertContains(
    buildScript,
    "mossWindowsPublisherSubject: resolvedBuildConfig.windowsPublisherSubject",
    "Expected signed Windows packages to carry the independently configured certificate subject DN.",
  );

  const lockfile = readFileSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), "utf8");
  const packagesSectionOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesSectionOffset < 0) {
    throw new Error("Expected bun.lock to contain a packages section.");
  }
  const workspaceImporters = lockfile.slice(0, packagesSectionOffset);
  for (const manifestPath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const workspacePath = manifestPath === "package.json" ? "" : dirname(manifestPath);
    if (!workspaceImporters.includes(`${JSON.stringify(workspacePath)}: {`)) {
      throw new Error(`Expected ${manifestPath} to have a matching importer in bun.lock.`);
    }
  }
}

async function verifyDesktopStageProductionInstall(
  targetRoot: string,
  processRunner: ReleaseSmokeProcessRunner,
): Promise<void> {
  const stageInstallRoot = resolve(targetRoot, "desktop-stage-install");
  cpSync(resolve(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY), stageInstallRoot, { recursive: true });

  const stagePackageJson = JSON.parse(
    readFileSync(resolve(stageInstallRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  const stagedPierreDiffsDependency = stagePackageJson.dependencies?.["@pierre/diffs"];
  if (stagedPierreDiffsDependency !== expectedPierreDiffsDependency) {
    throw new Error(
      `Expected desktop stage @pierre/diffs dependency ${expectedPierreDiffsDependency}, got ${stagedPierreDiffsDependency ?? "<missing>"}.`,
    );
  }
  const stagedPierreDiffsOverride = stagePackageJson.overrides?.["@pierre/diffs"];
  if (stagedPierreDiffsOverride !== expectedPierreDiffsVersion) {
    throw new Error(
      `Expected desktop stage @pierre/diffs override ${expectedPierreDiffsVersion}, got ${stagedPierreDiffsOverride ?? "<missing>"}.`,
    );
  }

  await runReleaseSmokeProcess(
    "installDesktopStage",
    "bun",
    ["install", "--production", "--frozen-lockfile", "--ignore-scripts"],
    stageInstallRoot,
    processRunner,
  );

  assertStagedDiffDependencies(stageInstallRoot);

  const diffsPackageJson = JSON.parse(
    readFileSync(resolve(stageInstallRoot, "node_modules/@pierre/diffs/package.json"), "utf8"),
  ) as { version?: string; dependencies?: Record<string, string> };
  if (diffsPackageJson.version !== expectedPierreDiffsVersion) {
    throw new Error(
      `Expected frozen desktop stage install to resolve @pierre/diffs ${expectedPierreDiffsVersion}, got ${diffsPackageJson.version ?? "<missing>"}.`,
    );
  }
  const themePackageJson = JSON.parse(
    readFileSync(resolve(stageInstallRoot, "node_modules/@pierre/theme/package.json"), "utf8"),
  ) as { version?: string };
  const expectedThemeVersion = diffsPackageJson.dependencies?.["@pierre/theme"];
  if (!expectedThemeVersion || themePackageJson.version !== expectedThemeVersion) {
    throw new Error(
      `Expected @pierre/theme ${expectedThemeVersion ?? "<missing>"} for @pierre/diffs, got ${themePackageJson.version ?? "<missing>"}.`,
    );
  }

  const patchedSpawner = readFileSync(
    resolve(
      stageInstallRoot,
      "node_modules/@effect/platform-node-shared/dist/NodeChildProcessSpawner.js",
    ),
    "utf8",
  );
  assertContains(
    patchedSpawner,
    "windowsVerbatimArguments: cmd.options.windowsVerbatimArguments",
    "Expected the frozen desktop stage install to apply the required Effect child-process patch.",
  );
}

export interface RunReleaseSmokeOptions {
  readonly createTempRoot?: () => string;
  readonly processRunner?: ReleaseSmokeProcessRunner;
  readonly log?: (message: string) => void;
}

export async function runReleaseSmoke({
  createTempRoot = () => mkdtempSync(join(tmpdir(), "moss-release-smoke-")),
  processRunner = defaultReleaseSmokeProcessRunner,
  log = console.log,
}: RunReleaseSmokeOptions = {}): Promise<void> {
  const tempRoot = createTempRoot();

  try {
    verifyCanonicalIdentity();
    verifyReleaseWorkflowSafety();
    verifyDesktopStageLockAuthority();
    copyWorkspaceManifestFixture(tempRoot);

    await runReleaseSmokeProcess(
      "updatePackageVersions",
      process.execPath,
      [
        resolve(repoRoot, "scripts/update-release-package-versions.ts"),
        "9.9.9-smoke.0",
        "--root",
        tempRoot,
      ],
      repoRoot,
      processRunner,
    );

    await runReleaseSmokeProcess(
      "refreshLockfile",
      "bun",
      ["install", "--lockfile-only", "--ignore-scripts"],
      tempRoot,
      processRunner,
    );

    const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
    assertContains(
      lockfile,
      `"version": "9.9.9-smoke.0"`,
      "Expected bun.lock to contain the smoke version.",
    );

    const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
    await runReleaseSmokeProcess(
      "mergeMacManifests",
      process.execPath,
      [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
      repoRoot,
      processRunner,
    );

    const mergedManifest = readFileSync(arm64Path, "utf8");
    assertContains(
      mergedManifest,
      "Moss-9.9.9-smoke.0-arm64.zip",
      "Merged manifest is missing the arm64 asset.",
    );
    assertContains(
      mergedManifest,
      "Moss-9.9.9-smoke.0-x64.zip",
      "Merged manifest is missing the x64 asset.",
    );
    assertNotContains(
      mergedManifest,
      ".dmg",
      "macOS updater manifests must describe only the finalized ZIP artifacts.",
    );

    await verifyDesktopStageProductionInstall(tempRoot, processRunner);

    log("Release smoke checks passed.");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runReleaseSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
}
