/**
 * Bounded waits for discovery reads (plugin and skill lists, composer capabilities).
 *
 * These reads can wait on a CLI process that never starts. Without a limit the page
 * shows "Loading…" forever (acceptance 2026-11-11: Settings › Plugins stayed loading for
 * over 3 minutes after a cold start). A timed-out read fails like any other, so the
 * query cache reports it and the page offers Retry.
 */
export class RequestTimeoutError extends Error {
  override readonly name = "TimeoutError";
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} did not answer within ${Math.ceil(timeoutMs / 1000)} s.`);
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** Longer than the server's own limits, so the server's answer normally arrives first. */
export const PLUGIN_LIST_REQUEST_TIMEOUT_MS = 60_000;
export const SKILL_LIST_REQUEST_TIMEOUT_MS = 45_000;
export const COMPOSER_CAPABILITIES_REQUEST_TIMEOUT_MS = 30_000;

export function withRequestTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RequestTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
