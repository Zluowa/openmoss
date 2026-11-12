// FILE: rerun.ts
// Purpose: Tells a test file that failed under load from one that fails alone. `bun run check`
//          reruns each failing test file once, by itself and one after another, before it
//          reports; only "failed alone" makes the gate fail.
// Layer: tools/check (pure apart from the injected runner)
// Exports: RERUN_LIMIT, failedTestFiles, aloneCommand, rerunAlone, RerunFailure, RerunOutcome

import path from "node:path";

/** At most this many files are rerun; the rest count as failed and are named as not rerun. */
export const RERUN_LIMIT = 20;

/**
 * The test files a Vitest JSON report marks as failed, relative to `cwd`, forward slashes.
 * Undefined when the report is missing or unreadable: the failure cannot be pinned on a file.
 * `pathApi` is the path flavour of the paths in the report (`path.win32` or `path.posix`).
 */
export function failedTestFiles(
  reportText: string | undefined,
  cwd: string,
  pathApi: path.PlatformPath = path,
): string[] | undefined {
  if (!reportText) return undefined;
  let report: { testResults?: Array<{ name?: unknown; status?: unknown }> };
  try {
    report = JSON.parse(reportText) as typeof report;
  } catch {
    return undefined;
  }
  if (!Array.isArray(report.testResults)) return undefined;
  const files = report.testResults
    .filter((result) => result.status === "failed" && typeof result.name === "string")
    .map((result) =>
      pathApi
        .relative(cwd, pathApi.resolve(cwd, result.name as string))
        .split(pathApi.sep)
        .join("/"),
    );
  return [...new Set(files)].toSorted();
}

/** The command to run one file alone: one worker, no file parallelism. */
export function aloneCommand(prefix: readonly string[], file: string): string[] {
  const command = prefix.filter((arg) => !/^--maxWorkers(=|$)/.test(arg));
  return [...command, "--maxWorkers=1", file];
}

export interface RerunFailure {
  /** The step the file failed in, e.g. `tests apps/web`. */
  readonly step: string;
  /** Repository-relative folder the step runs in. */
  readonly cwd: string;
  /** The step's command without its test files. */
  readonly prefix: readonly string[];
  readonly file: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RerunResult {
  readonly failure: RerunFailure;
  readonly ok: boolean;
  readonly seconds: number;
  readonly output: string;
}

export interface RerunOutcome {
  readonly passedAlone: RerunResult[];
  readonly failedAlone: RerunResult[];
  /** Over the limit: not rerun, counted as failed. */
  readonly notRerun: RerunFailure[];
}

/** Reruns each failure alone, one after another, up to `limit` files. */
export async function rerunAlone(
  failures: readonly RerunFailure[],
  run: (failure: RerunFailure) => Promise<RerunResult>,
  limit = RERUN_LIMIT,
): Promise<RerunOutcome> {
  const passedAlone: RerunResult[] = [];
  const failedAlone: RerunResult[] = [];
  for (const failure of failures.slice(0, limit)) {
    const result = await run(failure);
    (result.ok ? passedAlone : failedAlone).push(result);
  }
  return { passedAlone, failedAlone, notRerun: failures.slice(limit) };
}
