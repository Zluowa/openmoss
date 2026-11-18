// FILE: codeUpdateBoot.ts
// Purpose: Decides which code a packaged start runs: the installed archive's, or a verified code
//          update from the store; and reverts a new code update that does not become healthy.
//          With the switch off it loads the installed main.js and does nothing else. Any fault in
//          here starts the installed code (startMoss).
// Layer: Desktop shell. It always runs from the installed archive (entry codeUpdateBootEntry.ts,
//        built as dist-electron/boot.js) and is never replaced by a code update: a change to it
//        needs a full installer (scripts/lib/code-update-policy.ts). No package imports.
// Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md §2.3 and §4.2.

import * as Path from "node:path";

import {
  CODE_UPDATE_ARCHIVE_FILE,
  CODE_UPDATE_HEALTHY_DEADLINE_MS,
  decideCodeUpdateBoot,
  inspectCodeUpdateStateSync,
  inspectCodeUpdateSync,
  isCodeUpdateEnabled,
  markCodeUpdateCleanExit,
  markCodeUpdateHealthy,
  prunableCodeUpdateIds,
  prunablePackageFiles,
  readCodeUpdateStateSync,
  rejectCodeUpdate,
  resolveCodeUpdateStoreDir,
  writeCodeUpdateStateSync,
  type CodeUpdateRejectionReason,
  type CodeUpdateSyncFs,
} from "@moss/shared/codeUpdateState";

import type { CodeUpdateBootHandle } from "./codeUpdateHealth";

export interface CodeUpdateBootFs extends CodeUpdateSyncFs {
  appendFileSync(file: string, data: string): void;
  readdirSync(dir: string): string[];
  rmSync(target: string, options: { recursive: true; force: true }): void;
}

export interface CodeUpdateBootApp {
  relaunch(): void;
  exit(code: number): void;
  once(event: "will-quit", listener: () => void): unknown;
}

export interface CodeUpdateBootDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly pid: number;
  /** The installed archive's root (…/resources/app.asar) and its main.js. */
  readonly installedRoot: string;
  readonly installedMain: string;
  /** Store files (Electron's original-fs: it reads .asar files as files). */
  readonly fs: () => CodeUpdateBootFs;
  /** Reads the installed archive's package.json (Electron's asar-aware fs). */
  readonly readInstalledPackageJson: () => string;
  readonly loadModule: (file: string) => unknown;
  readonly app: () => CodeUpdateBootApp | null;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly now: () => string;
  readonly setTimer: (callback: () => void, ms: number) => { unref?: () => void };
  readonly clearTimer: (timer: unknown) => void;
  readonly setHandle: (handle: CodeUpdateBootHandle | null) => void;
  readonly logError: (message: string, error: unknown) => void;
}

function appendBootLog(fs: CodeUpdateBootFs, storeDir: string, pid: number, lines: string[]) {
  if (lines.length === 0) return;
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(
      Path.join(storeDir, "boot.log"),
      lines.map((line) => `${stamp} pid=${pid} ${line}\n`).join(""),
    );
  } catch {
    // The log is a convenience; the state file is what matters.
  }
}

function readShellCommit(deps: CodeUpdateBootDeps): string | null {
  try {
    const parsed = JSON.parse(deps.readInstalledPackageJson()) as { mossCommitHash?: unknown };
    return typeof parsed.mossCommitHash === "string" ? parsed.mossCommitHash : null;
  } catch {
    return null;
  }
}

/**
 * The boot proper. Returns once a main.js has been loaded. Throws only before any code was
 * loaded (startMoss then loads the installed code) or when the installed code itself throws.
 */
export function runCodeUpdateBoot(deps: CodeUpdateBootDeps, loaded: { started: boolean }): void {
  const loadInstalled = (handle: CodeUpdateBootHandle | null) => {
    deps.setHandle(handle);
    loaded.started = true;
    deps.loadModule(deps.installedMain);
  };
  if (!isCodeUpdateEnabled(deps.env, deps.platform)) {
    loadInstalled(null);
    return;
  }
  const fs = deps.fs();
  const storeDir = resolveCodeUpdateStoreDir({
    env: deps.env,
    platform: deps.platform,
    homeDir: deps.homeDir,
  });
  const shellCommit = readShellCommit(deps);
  const { state, problem } = inspectCodeUpdateStateSync(fs, storeDir);
  const decided = decideCodeUpdateBoot({
    state,
    inspect: (id) => inspectCodeUpdateSync({ fs, storeDir, id, shellCommit }),
    isProcessAlive: deps.isProcessAlive,
    pid: deps.pid,
    now: deps.now(),
  });
  const decision = problem
    ? {
        ...decided,
        events: [`code-update ${problem}; starting the installed code`, ...decided.events],
      }
    : decided;
  // A damaged state file is not rewritten here: the next healthy write replaces it.
  if (decision.state !== state) writeCodeUpdateStateSync(fs, storeDir, decision.state);
  appendBootLog(fs, storeDir, deps.pid, [...decision.events]);
  const choice = decision.choice;

  const reject = (id: string, reason: CodeUpdateRejectionReason, detail: string) => {
    writeCodeUpdateStateSync(
      fs,
      storeDir,
      rejectCodeUpdate(readCodeUpdateStateSync(fs, storeDir), id, {
        reason,
        detail,
        at: deps.now(),
      }),
    );
    appendBootLog(fs, storeDir, deps.pid, [
      `code-update rejected id=${id} reason=${reason} detail=${detail}`,
    ]);
  };
  const relaunch = () => {
    const app = deps.app();
    if (!app) return;
    app.relaunch();
    app.exit(0);
  };

  let healthy = false;
  let watchdog: unknown = null;
  const id = choice.kind === "code" ? choice.id : null;
  let sequence = 0;
  if (id) {
    try {
      const installed = JSON.parse(
        fs.readFileSync(Path.join(storeDir, id, "installed.json"), "utf8"),
      ) as { sequence?: number };
      sequence = installed.sequence ?? 0;
    } catch {
      // inspect() read it a moment ago; a sequence of 0 only means "any newer one".
    }
  }
  const handle: CodeUpdateBootHandle = {
    id,
    trial: choice.kind === "code" && choice.trial,
    sequence,
    storeDir,
    installedArchive: deps.installedRoot,
    shellCommit,
    events: decision.events,
    reportHealthy() {
      if (healthy) return;
      healthy = true;
      if (watchdog) deps.clearTimer(watchdog);
      try {
        const current = readCodeUpdateStateSync(fs, storeDir);
        const next = id ? markCodeUpdateHealthy(current, id) : current;
        if (next !== current) {
          writeCodeUpdateStateSync(fs, storeDir, next);
          appendBootLog(fs, storeDir, deps.pid, [`code-update healthy id=${id}`]);
        }
        // Healthy: archives no state field names go, and packages beyond the kept ones.
        for (const stale of prunableCodeUpdateIds(next, fs.readdirSync(storeDir))) {
          fs.rmSync(Path.join(storeDir, stale), { recursive: true, force: true });
        }
        const packagesDir = Path.join(storeDir, "packages");
        for (const stale of prunablePackageFiles(next, safeReaddir(fs, packagesDir))) {
          fs.rmSync(Path.join(packagesDir, stale), { recursive: true, force: true });
        }
      } catch {
        // Retried at the next healthy start.
      }
    },
  };

  if (choice.kind === "installed") {
    loadInstalled(handle);
    return;
  }
  if (choice.trial) {
    const timer = deps.setTimer(() => {
      if (healthy) return;
      reject(
        choice.id,
        "timeout",
        `not healthy within ${CODE_UPDATE_HEALTHY_DEADLINE_MS / 1000} s`,
      );
      relaunch();
    }, CODE_UPDATE_HEALTHY_DEADLINE_MS);
    timer.unref?.();
    watchdog = timer;
    deps.app()?.once("will-quit", () => {
      if (healthy) return;
      try {
        const current = readCodeUpdateStateSync(fs, storeDir);
        const next = markCodeUpdateCleanExit(current, choice.id, deps.pid);
        if (next !== current) writeCodeUpdateStateSync(fs, storeDir, next);
      } catch {
        // An unrecorded clean quit counts as one unclean start; the limit is two.
      }
    });
  }
  deps.setHandle(handle);
  const entry = Path.join(
    storeDir,
    choice.id,
    CODE_UPDATE_ARCHIVE_FILE,
    "apps",
    "desktop",
    "dist-electron",
    "main.js",
  );
  try {
    loaded.started = true;
    deps.loadModule(entry);
  } catch (error) {
    if (watchdog) deps.clearTimer(watchdog);
    reject(
      choice.id,
      "load-error",
      error instanceof Error ? error.message.slice(0, 300) : "unknown",
    );
    relaunch();
  }
}

function safeReaddir(fs: CodeUpdateBootFs, dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The packaged entry: runs the boot, and whatever goes wrong in it before any code was loaded,
 * the installed code starts. Only a throw from the installed code itself reaches Electron, as
 * it does today.
 */
export function startMoss(deps: CodeUpdateBootDeps): void {
  const loaded = { started: false };
  try {
    runCodeUpdateBoot(deps, loaded);
  } catch (error) {
    if (loaded.started) throw error;
    deps.logError("[code-update] boot failed; starting the installed code", error);
    deps.setHandle(null);
    deps.loadModule(deps.installedMain);
  }
}
