// FILE: backendStartupBlockPresentation.ts
// Purpose: Turns a backend startup block into the state the window draws, and decides
//          whether a window is there to draw it before main falls back to a native dialog.
// Layer: Desktop backend supervision
// Why: on 2026-11-17 a database lock block was shown only as a parentless native dialog
//      that sat behind the window; the window itself spun on "正在加载项目…" for ever.

import type { DesktopBackendStartupFailure } from "@moss/contracts";

import { summarizeBackendFailureOutput } from "./backendSupervisionPolicy";

/** How long main waits for a window to take over a startup block before a native dialog. */
export const STARTUP_BLOCK_RENDERER_WAIT_MS = 10_000;

export function databaseLockedStartupFailure(input: {
  readonly ownerPid: number | null;
  readonly appVersion: string;
  readonly platform: string;
  readonly output: string;
  readonly logFilePath: string;
}): DesktopBackendStartupFailure {
  const summary = summarizeBackendFailureOutput(input.output);
  return {
    kind: "database-locked",
    failures: 1,
    ownerPid: input.ownerPid,
    logFilePath: input.logFilePath,
    details: [
      `Moss ${input.appVersion} (${input.platform})`,
      input.ownerPid === null
        ? "The local data folder is locked and the lock's owner could not be verified."
        : `The local data folder is in use by process ${input.ownerPid}.`,
      summary.length > 0 ? `Last error:\n${summary}` : "The local service wrote no error.",
      `Log file: ${input.logFilePath}`,
    ].join("\n\n"),
  };
}

/**
 * Resolves true as soon as a window has asked for the startup failure (and so draws
 * it), false once `timeoutMs` passes or `signal` aborts without one.
 */
export function waitForStartupFailureRenderer(options: {
  readonly isPresent: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (options.isPresent()) return Promise.resolve(true);
  if (options.signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (present: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      resolve(present);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(options.isPresent()), options.timeoutMs);
    const unsubscribe = options.subscribe(() => {
      if (options.isPresent()) finish(true);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
