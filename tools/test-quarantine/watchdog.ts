// A Vitest reporter for the CI unit lanes, on only when MOSS_TEST_PROGRESS_FILE is set (the
// test-quarantine plugin adds it). It appends one tab-separated line per test file started and
// finished to that file, so the job summary can name the files still running when a step was
// stopped. With MOSS_TEST_FILE_LIMIT_SECONDS it also fails the run as soon as one file has run
// longer than that, naming the file and the tests still running in it, instead of letting a hung
// file use up the whole job. Per-test limits stay Vitest's own testTimeout and hookTimeout.
import { appendFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Reporter, TestCase, TestModule, Vitest } from "vitest/node";

export const PROGRESS_FILE_ENV = "MOSS_TEST_PROGRESS_FILE";
export const FILE_LIMIT_ENV = "MOSS_TEST_FILE_LIMIT_SECONDS";

export interface WatchdogOptions {
  /** Lines are "start|end|limit <TAB> repo-relative file <TAB> detail". */
  readonly progressFile: string;
  /** Repo-relative paths in the progress file and the messages are relative to this folder. */
  readonly repoRoot: string;
  /** Off when absent. */
  readonly fileLimitMs?: number;
  /** How often running files are compared with the limit. */
  readonly checkEveryMs?: number;
  /** How long a cancelled run may take to stop before the process exits. */
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
  readonly log?: (message: string) => void;
}

interface RunningFile {
  readonly started: number;
  readonly tests: Set<string>;
  flagged: boolean;
}

export class TestFileWatchdog implements Reporter {
  /** Marks instances across separately bundled config files, where instanceof fails. */
  readonly mossTestFileWatchdog = true;
  private vitest: Vitest | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Map<string, RunningFile>();

  private readonly options: WatchdogOptions;

  constructor(options: WatchdogOptions) {
    this.options = options;
  }

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    if (this.options.fileLimitMs === undefined) return;
    this.timer = setInterval(() => this.check(), this.options.checkEveryMs ?? 10_000);
    this.timer.unref();
  }

  onTestModuleQueued(testModule: TestModule): void {
    this.running.set(testModule.moduleId, {
      started: this.now(),
      tests: new Set(),
      flagged: false,
    });
    this.write("start", testModule.moduleId, "");
  }

  onTestCaseReady(testCase: TestCase): void {
    this.running.get(testCase.module.moduleId)?.tests.add(testCase.fullName);
  }

  onTestCaseResult(testCase: TestCase): void {
    this.running.get(testCase.module.moduleId)?.tests.delete(testCase.fullName);
  }

  onTestModuleEnd(testModule: TestModule): void {
    const file = this.running.get(testModule.moduleId);
    this.running.delete(testModule.moduleId);
    this.write("end", testModule.moduleId, file ? `${this.now() - file.started}ms` : "");
  }

  onTestRunEnd(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Compares every running file with the limit; public for tests. */
  check(): void {
    const limit = this.options.fileLimitMs;
    if (limit === undefined) return;
    const now = this.now();
    for (const [moduleId, file] of this.running) {
      if (file.flagged || now - file.started <= limit) continue;
      file.flagged = true;
      const tests = [...file.tests];
      this.write("limit", moduleId, tests.join(" | "));
      const seconds = Math.round((now - file.started) / 1000);
      this.log(
        `\nFILE TIME LIMIT: ${this.relative(moduleId)} still running after ${seconds} s ` +
          `(limit ${Math.round(limit / 1000)} s, ${FILE_LIMIT_ENV}). ` +
          (tests.length > 0
            ? `Running tests: ${tests.join(" | ")}`
            : "No test had started: the file hung while loading or in a hook.") +
          "\nStopping the run.\n",
      );
      process.exitCode = 1;
      // Cancelling waits for running tests, which may never finish; exit after the grace period.
      void this.vitest?.cancelCurrentRun("test-failure");
      const exit = this.options.exit ?? ((code: number) => process.exit(code));
      setTimeout(() => exit(1), this.options.graceMs ?? 30_000).unref();
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(message: string): void {
    (this.options.log ?? ((text: string) => process.stderr.write(text)))(message);
  }

  private relative(moduleId: string): string {
    const path = relative(this.options.repoRoot, moduleId);
    return (path.startsWith("..") || isAbsolute(path) ? moduleId : path).replaceAll("\\", "/");
  }

  private write(kind: "start" | "end" | "limit", moduleId: string, detail: string): void {
    const line = `${kind}\t${this.relative(moduleId)}\t${detail.replace(/[\t\r\n]+/g, " ")}\n`;
    try {
      appendFileSync(this.options.progressFile, line);
    } catch {
      // Progress lines help a person read a stopped run; they never fail a test run.
    }
  }
}

/** The reporter the environment asks for, or undefined when MOSS_TEST_PROGRESS_FILE is unset. */
export function watchdogFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): TestFileWatchdog | undefined {
  const progressFile = env[PROGRESS_FILE_ENV];
  if (!progressFile) return undefined;
  const seconds = Number(env[FILE_LIMIT_ENV]);
  return new TestFileWatchdog({
    progressFile,
    repoRoot,
    ...(Number.isFinite(seconds) && seconds > 0 ? { fileLimitMs: seconds * 1000 } : {}),
  });
}

export function isWatchdog(reporter: unknown): boolean {
  return typeof reporter === "object" && reporter !== null && "mossTestFileWatchdog" in reporter;
}

export interface ProgressReport {
  /** Files that started and never finished, in start order. */
  readonly unfinished: readonly string[];
  /** Files stopped by the per-file limit, with the tests that were running. */
  readonly overLimit: ReadonlyArray<{ readonly file: string; readonly tests: string }>;
}

export function parseProgress(text: string): ProgressReport {
  const open = new Map<string, number>();
  const overLimit: Array<{ file: string; tests: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const [kind, file, detail = ""] = line.split("\t");
    if (!file) continue;
    if (kind === "start") open.set(file, (open.get(file) ?? 0) + 1);
    else if (kind === "end") {
      const count = (open.get(file) ?? 0) - 1;
      if (count > 0) open.set(file, count);
      else open.delete(file);
    } else if (kind === "limit") overLimit.push({ file, tests: detail });
  }
  return { unfinished: [...open.keys()], overLimit };
}
