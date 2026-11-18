import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestCase, TestModule, Vitest } from "vitest/node";

import { renderProgressSummary } from "../failures.ts";
import { TestFileWatchdog, isWatchdog, parseProgress, watchdogFromEnv } from "../watchdog.ts";

const root = "/repo";
const module = (file: string) => ({ moduleId: `${root}/${file}` }) as TestModule;
const testCase = (file: string, fullName: string) =>
  ({ module: module(file), fullName }) as unknown as TestCase;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  process.exitCode = undefined;
});

function setup(fileLimitMs?: number) {
  dir = mkdtempSync(join(tmpdir(), "moss-watchdog-"));
  const progressFile = join(dir, "progress.tsv");
  let clock = 0;
  const exits: number[] = [];
  const messages: string[] = [];
  const cancels: string[] = [];
  const watchdog = new TestFileWatchdog({
    progressFile,
    repoRoot: root,
    ...(fileLimitMs === undefined ? {} : { fileLimitMs }),
    checkEveryMs: 60_000,
    graceMs: 0,
    now: () => clock,
    exit: (code) => exits.push(code),
    log: (message) => messages.push(message),
  });
  watchdog.onInit({
    cancelCurrentRun: async (reason: string) => {
      cancels.push(reason);
    },
  } as unknown as Vitest);
  return {
    watchdog,
    progress: () => readFileSync(progressFile, "utf8"),
    advance: (ms: number) => {
      clock += ms;
    },
    exits,
    messages,
    cancels,
  };
}

describe("TestFileWatchdog", () => {
  it("records each file's start and end with repository paths", () => {
    const run = setup();
    run.watchdog.onTestModuleQueued(module("apps/server/src/a.test.ts"));
    run.watchdog.onTestModuleQueued(module("apps/server/src/b.test.ts"));
    run.advance(1500);
    run.watchdog.onTestModuleEnd(module("apps/server/src/a.test.ts"));
    run.watchdog.onTestRunEnd();
    expect(run.progress()).toBe(
      [
        "start\tapps/server/src/a.test.ts\t",
        "start\tapps/server/src/b.test.ts\t",
        "end\tapps/server/src/a.test.ts\t1500ms",
        "",
      ].join("\n"),
    );
    expect(parseProgress(run.progress())).toEqual({
      unfinished: ["apps/server/src/b.test.ts"],
      overLimit: [],
    });
  });

  it("stops the run once a file passes the limit, naming the file and its running tests", async () => {
    const run = setup(60_000);
    const file = "apps/server/src/persistence/Lock.integration.test.ts";
    run.watchdog.onTestModuleQueued(module(file));
    run.watchdog.onTestCaseReady(testCase(file, "lock > done"));
    run.watchdog.onTestCaseResult(testCase(file, "lock > done"));
    run.watchdog.onTestCaseReady(testCase(file, "lock > waits for the holder"));
    run.advance(60_000);
    run.watchdog.check();
    expect(run.messages).toEqual([]);
    run.advance(1);
    run.watchdog.check();
    run.watchdog.check();
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).toContain(`FILE TIME LIMIT: ${file} still running after 60 s`);
    expect(run.messages[0]).toContain("Running tests: lock > waits for the holder");
    expect(process.exitCode).toBe(1);
    expect(run.cancels).toEqual(["test-failure"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(run.exits).toEqual([1]);
    expect(parseProgress(run.progress()).overLimit).toEqual([
      { file, tests: "lock > waits for the holder" },
    ]);
  });

  it("is off without a progress file and recognised across config bundles", () => {
    expect(watchdogFromEnv({}, root)).toBeUndefined();
    const watchdog = watchdogFromEnv(
      { MOSS_TEST_PROGRESS_FILE: "p.tsv", MOSS_TEST_FILE_LIMIT_SECONDS: "abc" },
      root,
    );
    expect(isWatchdog(watchdog)).toBe(true);
    expect(isWatchdog({ ...watchdog })).toBe(true);
    expect(isWatchdog(["default", {}])).toBe(false);
  });
});

describe("renderProgressSummary", () => {
  it("names files stopped by the limit and files still running", () => {
    const summary = renderProgressSummary(
      [
        "start\tapps/server/src/a.test.ts\t",
        "start\tapps/server/src/b.test.ts\t",
        "start\tapps/server/src/c.test.ts\t",
        "limit\tapps/server/src/c.test.ts\t",
        "end\tapps/server/src/c.test.ts\t300000ms",
        "end\tapps/server/src/a.test.ts\t20ms",
      ].join("\n"),
    );
    expect(summary).toContain("### Stopped by the per-file time limit (1)");
    expect(summary).toContain(
      "| `apps/server/src/c.test.ts` | (none started: hung while loading or in a hook) |",
    );
    expect(summary).toContain("### Test files still running when the run stopped (1)");
    expect(summary).toContain("- `apps/server/src/b.test.ts`");
    expect(renderProgressSummary("start\ta.test.ts\t\nend\ta.test.ts\t1ms\n")).toBe("");
  });
});
