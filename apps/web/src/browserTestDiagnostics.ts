// FILE: browserTestDiagnostics.ts
// Purpose: Shared runtime diagnostics for browser tests with serializable failures.
// Layer: Test infrastructure (Vitest browser mode only).
//
// Asserting on raw `console.error` mock calls is a suite-killer: a single logged
// Event/Error object turns the AssertionError payload into live DOM references that
// @vitest/utils cannot serialize, and the browser runner dies with ws 1009 before
// printing the failure. Always assert on these string summaries instead.

import { expect, vi } from "vitest";

type ConsoleCall = readonly unknown[];

const MAX_SUMMARY_LENGTH = 2000;

function summarizeConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    const json = JSON.stringify(arg);
    if (json !== undefined) {
      return json.length > MAX_SUMMARY_LENGTH ? `${json.slice(0, MAX_SUMMARY_LENGTH)}…` : json;
    }
  } catch {
    // Live DOM objects throw on serialize; fall through to a safe tag.
  }
  try {
    return String(arg);
  } catch {
    return Object.prototype.toString.call(arg);
  }
}

/** Plain-string rendering of a console spy's calls, safe for `toEqual([])` assertions. */
export function summarizeConsoleErrorCalls(calls: readonly ConsoleCall[]): string[] {
  return calls.map((call) => call.map(summarizeConsoleArg).join(" "));
}

/**
 * Capture page errors, unhandled rejections, and console.error output for a test,
 * then assert on sanitized summaries so a failure can never crash the runner.
 */
export function installRuntimeDiagnostics(
  options: { readonly preventDefaultRejection?: boolean } = {},
) {
  const pageErrors: string[] = [];
  const onError = (event: ErrorEvent) => {
    pageErrors.push(
      event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message,
    );
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (options.preventDefaultRejection) event.preventDefault();
    pageErrors.push(
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason),
    );
  };
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return {
    assertHealthy() {
      expect(pageErrors, "Unexpected browser page errors/rejections").toEqual([]);
      expect(
        summarizeConsoleErrorCalls(consoleError.mock.calls),
        "Unexpected browser console.error diagnostics",
      ).toEqual([]);
    },
    dispose() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      consoleError.mockRestore();
    },
  };
}
