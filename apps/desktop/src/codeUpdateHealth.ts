// FILE: codeUpdateHealth.ts
// Purpose: Decides when the running code is healthy, for the code-update boot check: the backend
//          answered its readiness probe, the main window finished loading the app, and then a quiet
//          period passed with no renderer crash and no backend exit.
// Layer: Desktop main process (pure; timers injected).
// Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md §4.2.

export const CODE_UPDATE_HEALTHY_QUIET_MS = 15_000;

/** Set by the shell's boot entry (boot.js) before it loads the code; absent without code updates. */
export interface CodeUpdateBootHandle {
  /** The code-update id running, or null for the installed code. */
  readonly id: string | null;
  readonly trial: boolean;
  readonly sequence: number;
  readonly storeDir: string | null;
  readonly installedArchive: string;
  readonly shellCommit: string | null;
  /** What the boot decided, for the desktop log. */
  readonly events: ReadonlyArray<string>;
  reportHealthy(): void;
}

export function readCodeUpdateBootHandle(): CodeUpdateBootHandle | null {
  const handle = (globalThis as { __mossCodeUpdate?: CodeUpdateBootHandle }).__mossCodeUpdate;
  return handle && typeof handle.reportHealthy === "function" ? handle : null;
}

export interface CodeUpdateHealthTracker {
  backendReady(): void;
  windowLoaded(): void;
  /** A renderer crash or backend exit: healthy needs a fresh load after it. */
  problem(reason: string): void;
  readonly healthy: boolean;
}

export function createCodeUpdateHealthTracker(input: {
  readonly onHealthy: () => void;
  readonly onProblem?: (reason: string) => void;
  readonly quietMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}): CodeUpdateHealthTracker {
  const setTimer =
    input.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  let backendReady = false;
  let windowLoaded = false;
  let healthy = false;
  let timer: unknown = null;
  const arm = () => {
    if (healthy || !backendReady || !windowLoaded || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      if (healthy || !backendReady || !windowLoaded) return;
      healthy = true;
      input.onHealthy();
    }, input.quietMs ?? CODE_UPDATE_HEALTHY_QUIET_MS);
  };
  return {
    backendReady() {
      backendReady = true;
      arm();
    },
    windowLoaded() {
      windowLoaded = true;
      arm();
    },
    problem(reason) {
      if (healthy) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      windowLoaded = false;
      input.onProblem?.(reason);
    },
    get healthy() {
      return healthy;
    },
  };
}
