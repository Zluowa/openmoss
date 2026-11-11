import { BetterWright, NetworkPolicy, type CredentialVault } from "betterwright";
import { BrowserAutomationErrorMessages } from "@moss/contracts";
import type { WebContents } from "electron";
import { mossHostTarget } from "./betterwrightHostTarget";
import { describeScriptFailure } from "./scriptErrorDiagnostic";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserAutomationHostError } from "./hostErrors";

const UNAVAILABLE_SCRIPT_API_ERRORS = new Set([
  ...[
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "locator",
    "document",
    "window",
    "location",
    "waitForTimeout",
  ].map((name) => `${name} is not defined`),
  "page.snapshot is not a function",
]);

export interface BetterwrightRunOptions {
  readonly home: string;
  readonly contents: WebContents;
  readonly code: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly vault?: CredentialVault;
  readonly uploadFiles?: readonly string[];
  readonly expectAgentInput?: BrowserAutomationVisibleRuntime["expectAgentInput"];
  /**
   * Runs after the script finishes, while the agent still holds the tab, so
   * the result can reflect what the script started (see pageSettle.ts).
   * Only cancellation propagates.
   */
  readonly afterScript?: () => Promise<void>;
}

/**
 * Longest a finished run's worker stays up to serve requests still flowing
 * through its guard proxy; anything longer is cut when it exits.
 */
export const GUARDED_REQUEST_KEEPALIVE_MAX_MS = 60_000;

const diagnosticDetail = (error: unknown, code: string): { detail?: string } => {
  const detail = describeScriptFailure(error, code);
  return detail === undefined ? {} : { detail };
};

interface LingeringWorker {
  close(): Promise<void>;
}

/** Workers whose run has returned but whose guard still serves requests. */
const lingeringWorkers = new Set<LingeringWorker>();

/** Closes every lingering worker now, for host shutdown. */
export async function closeLingeringBrowserWorkers(): Promise<void> {
  await Promise.allSettled([...lingeringWorkers].map((worker) => worker.close()));
}

function lingerUntilDrained(
  close: () => Promise<void>,
  drain: (signal: AbortSignal) => Promise<void>,
): void {
  const controller = new AbortController();
  let done: Promise<void> = Promise.resolve();
  const worker: LingeringWorker = {
    close: async () => {
      controller.abort();
      await done;
    },
  };
  done = (async () => {
    await drain(controller.signal).catch(() => {});
    await close().catch(() => {});
    lingeringWorkers.delete(worker);
  })();
  lingeringWorkers.add(worker);
}

/** The caller must hold Moss's tab, human-control and download-denial leases. */
export async function runBetterwright<T>(options: BetterwrightRunOptions): Promise<T> {
  options.signal.throwIfAborted();
  const throttled = options.contents.getBackgroundThrottling();
  // Locator stability checks require animation frames even when the agent's
  // native view is parked behind the composer. Restore the idle policy after
  // the worker and its CDP connection have both drained.
  if (throttled) options.contents.setBackgroundThrottling(false);
  try {
    return await runConnectedBetterwright<T>(options);
  } finally {
    if (throttled && !options.contents.isDestroyed()) {
      options.contents.setBackgroundThrottling(true);
    }
  }
}

async function runConnectedBetterwright<T>(options: BetterwrightRunOptions): Promise<T> {
  const hostTarget = mossHostTarget(options.contents, {
    uploadFiles: options.uploadFiles,
    expectAgentInput: options.expectAgentInput,
    signal: options.signal,
  });
  let onAbortRace: (() => void) | undefined;
  const aborting = new Promise<never>((_, reject) => {
    onAbortRace = () => reject(options.signal.reason ?? new Error("Browser run cancelled."));
    options.signal.addEventListener("abort", onAbortRace, { once: true });
  });
  let browser: BetterWright | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (cancel: boolean): Promise<void> => {
    // Revoke synchronously before requesting worker shutdown. Neither completion
    // nor cancellation releases the host's tab lock until both have drained.
    stopping ??= Promise.allSettled([hostTarget.revokeAll(cancel), browser?.close()]).then(
      (results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
    );
    return stopping;
  };
  // Input authority and the session's guard proxy end before the run returns,
  // exactly as with a full stop, so new requests in every tab connect directly
  // again. Only the worker process lingers: requests any tab sent through its
  // guard during the run still flow through it, and its exit would cut them off.
  const releaseAfterScript = async (cancel: boolean): Promise<void> => {
    try {
      await hostTarget.revokeAll(cancel);
    } catch (error) {
      // The guard's next lease recovers a failed restore; never leave the
      // worker running behind it.
      await browser?.close().catch(() => {});
      throw error;
    }
    if (hostTarget.guardedRequestCount() === 0) {
      await stop(false);
      return;
    }
    lingerUntilDrained(
      () => stop(false),
      (signal) => hostTarget.drainGuardedRequests(GUARDED_REQUEST_KEEPALIVE_MAX_MS, signal),
    );
  };
  const onAbort = () => {
    void stop(true).catch(() => {});
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let succeeded = false;
  let scriptFinished = false;
  try {
    options.signal.throwIfAborted();
    browser = new BetterWright({
      home: options.home,
      hostTarget,
      ...(options.uploadFiles ? { hostUploadFiles: options.uploadFiles } : {}),
      downloadPolicy: "deny",
      vault: options.vault ?? false,
      credentialCapture: false,
      headless: false,
      adBlock: false,
      parkBackgroundPages: false,
      policy: new NetworkPolicy({ allowLoopback: true }),
    });
    const result = await Promise.race([
      browser.run<T>(options.code, {
        timeout: options.timeoutMs / 1000,
        signal: options.signal,
        // Shared tabs never consume the automatic UI catalog; opting out keeps
        // worker traffic to the evaluated script.
        automaticUI: false,
      }),
      aborting,
    ]);
    scriptFinished = true;
    options.signal.throwIfAborted();
    if (options.afterScript) {
      try {
        await Promise.race([options.afterScript(), aborting]);
      } catch (error) {
        options.signal.throwIfAborted();
        // Settling is an observation aid; the script's own outcome stands.
        void error;
      }
      options.signal.throwIfAborted();
    }
    if (!result.ok) {
      // Only fixed host-owned guidance crosses the boundary, never worker error
      // text. Ordinary script failures add a host-authored `detail` (which API
      // failed and how) that quotes nothing beyond the agent's own script.
      const credentialTarget =
        typeof result.error === "string" &&
        /^credential form (?:not-found:|ambiguous:|detection found no password field\.|submit detection failed:)/u.test(
          result.error,
        );
      const code =
        result.error === BrowserAutomationErrorMessages.BrowserCredentialUseUnavailable
          ? "BrowserCredentialUseUnavailable"
          : typeof result.error === "string" && UNAVAILABLE_SCRIPT_API_ERRORS.has(result.error)
            ? "BrowserScriptApiUnavailable"
            : credentialTarget
              ? "BrowserCredentialTargetRequired"
              : "BrowserEvaluationFailed";
      throw new BrowserAutomationHostError({
        code,
        retryable: false,
        phase: "evaluate",
        effectMayHaveCommitted: true,
        ...(code === "BrowserEvaluationFailed" ? diagnosticDetail(result.error, options.code) : {}),
      });
    }
    succeeded = true;
    return result.result as T;
  } finally {
    if (onAbortRace) options.signal.removeEventListener("abort", onAbortRace);
    options.signal.removeEventListener("abort", onAbort);
    await (scriptFinished && !options.signal.aborted && !options.contents.isDestroyed()
      ? releaseAfterScript(!succeeded)
      : stop(!succeeded));
  }
}
