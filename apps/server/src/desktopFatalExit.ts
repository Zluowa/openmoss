// FILE: desktopFatalExit.ts
// Purpose: Ends the desktop-owned backend process with an exit code that tells a clean
//          stop from a crash, after writing the reason for a crash to stderr.
// Layer: Server process entry
// Exports: desktopBackendExitCode, formatDesktopFatalExitReport, exitDesktopBackend
// Why: the desktop backend exits from `onExit`, before NodeRuntime's own error report
//      runs, so a failed startup used to leave no trace in any log. The desktop captures
//      stderr into its backend log and quotes the last error line when it gives up.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { describeSchemaIssue, redactSchemaErrorsInCause } from "./persistence/Errors.ts";

const MAX_FATAL_REPORT_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 1_000;
/** If stderr cannot drain (a closed pipe), exit anyway instead of hanging. */
const STDERR_DRAIN_TIMEOUT_MS = 2_000;

/** 0 success, 130 interrupt, 1 failure. */
export function desktopBackendExitCode(exit: Exit.Exit<unknown, unknown>): number {
  if (Exit.isSuccess(exit)) return 0;
  return Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
}

interface ErrorLike {
  readonly message: string;
  readonly name?: unknown;
  readonly _tag?: unknown;
  readonly cause?: unknown;
}

const isErrorLike = (value: unknown): value is ErrorLike =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly message?: unknown }).message === "string";

/**
 * `Tag: message`, followed by the messages of its causes that add something new.
 * Effect's SchemaError is not an `Error`, so causes are read by shape.
 */
function describeErrorChain(error: Error): string {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isErrorLike(current) && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    // A SchemaError's own message quotes the stored value; describe its shape instead.
    const message = Schema.isSchemaError(current)
      ? describeSchemaIssue(current.issue)
      : current.message.trim();
    if (parts.length === 0) {
      const tag = typeof current._tag === "string" ? current._tag : String(current.name ?? "Error");
      parts.push(`${tag}: ${message}`);
    } else if (message.length > 0 && !parts.some((part) => part.includes(message))) {
      parts.push(message);
    }
    current = current.cause;
  }
  return parts.join(" <- ");
}

function errorSummary(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(redactSchemaErrorsInCause(cause));
  const text =
    squashed instanceof Error
      ? describeErrorChain(squashed)
      : typeof squashed === "string"
        ? squashed
        : (() => {
            try {
              return JSON.stringify(squashed) ?? String(squashed);
            } catch {
              return String(squashed);
            }
          })();
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY_CHARS ? `${oneLine.slice(0, MAX_SUMMARY_CHARS)}…` : oneLine;
}

/**
 * The full cause for support, then one closing line that names it. The desktop
 * summarizes a give-up from the last line that mentions an error, so the summary
 * line comes last.
 */
export function formatDesktopFatalExitReport(cause: Cause.Cause<unknown>): string {
  const pretty = Cause.pretty(redactSchemaErrorsInCause(cause));
  const detail =
    pretty.length > MAX_FATAL_REPORT_CHARS
      ? `${pretty.slice(0, MAX_FATAL_REPORT_CHARS)}\n… (truncated)`
      : pretty;
  return `${detail}\n[moss-server] fatal error, stopping: ${errorSummary(cause)}\n`;
}

export interface DesktopBackendExitIo {
  readonly writeStderr: (text: string, done: () => void) => void;
  readonly exitProcess: (code: number) => void;
  readonly setTimer?: (callback: () => void, ms: number) => void;
}

/**
 * Exits the process for its runtime result. A failure that is not only an
 * interrupt is written to stderr first, and the exit waits for that write.
 */
export function exitDesktopBackend(
  exit: Exit.Exit<unknown, unknown>,
  io: DesktopBackendExitIo,
): Effect.Effect<void> {
  const code = desktopBackendExitCode(exit);
  if (code !== 1 || Exit.isSuccess(exit)) {
    return Effect.sync(() => io.exitProcess(code));
  }
  const report = formatDesktopFatalExitReport(exit.cause);
  return Effect.callback<void>(() => {
    let exited = false;
    const exitOnce = () => {
      if (exited) return;
      exited = true;
      io.exitProcess(code);
    };
    (io.setTimer ?? ((callback, ms) => void setTimeout(callback, ms)))(
      exitOnce,
      STDERR_DRAIN_TIMEOUT_MS,
    );
    try {
      io.writeStderr(report, exitOnce);
    } catch {
      exitOnce();
    }
  });
}
