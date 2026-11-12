import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  aloneCommand,
  failedTestFiles,
  rerunAlone,
  type RerunFailure,
  type RerunResult,
} from "../lib/rerun.ts";

const report = (results: Array<{ name: string; status: string }>) =>
  JSON.stringify({ numFailedTestSuites: 1, testResults: results });

describe("failed test files from a Vitest JSON report", () => {
  it("returns the failed files relative to the step folder, Windows paths", () => {
    const text = report([
      { name: "C:/w/repo/apps/web/src/b.test.ts", status: "failed" },
      { name: "C:\\w\\repo\\apps\\web\\src\\lib\\a.test.ts", status: "failed" },
      { name: "C:/w/repo/apps/web/src/c.test.ts", status: "passed" },
      // Drive letters differ in case between tools; Windows paths compare without case.
      { name: "c:/w/repo/apps/web/src/d.test.ts", status: "failed" },
    ]);
    expect(failedTestFiles(text, "C:\\w\\repo\\apps\\web", path.win32)).toEqual([
      "src/b.test.ts",
      "src/d.test.ts",
      "src/lib/a.test.ts",
    ]);
  });

  it("returns the failed files relative to the step folder, POSIX paths", () => {
    const text = report([
      { name: "/w/repo/tools/ws/test/lock.test.ts", status: "failed" },
      { name: "/w/repo/tools/ws/test/lock.test.ts", status: "failed" },
      { name: "/w/repo/tools/ws/test/pure.test.ts", status: "passed" },
    ]);
    expect(failedTestFiles(text, "/w/repo/tools/ws", path.posix)).toEqual(["test/lock.test.ts"]);
  });

  it("cannot pin a failure on a file without a readable report", () => {
    expect(failedTestFiles(undefined, "/w", path.posix)).toBeUndefined();
    expect(failedTestFiles("{not json", "/w", path.posix)).toBeUndefined();
    expect(failedTestFiles("{}", "/w", path.posix)).toBeUndefined();
    expect(failedTestFiles(report([]), "/w", path.posix)).toEqual([]);
  });
});

describe("rerunning alone", () => {
  it("runs one file with one worker, keeping the rest of the command", () => {
    expect(
      aloneCommand(
        ["bun", "x", "vitest", "run", "--passWithNoTests", "--maxWorkers=4", "--config", "c.ts"],
        "src/a.test.ts",
      ),
    ).toEqual([
      "bun",
      "x",
      "vitest",
      "run",
      "--passWithNoTests",
      "--config",
      "c.ts",
      "--maxWorkers=1",
      "src/a.test.ts",
    ]);
  });

  it("reruns serially, separates passed alone from failed alone, and stops at the limit", async () => {
    const failures: RerunFailure[] = ["a", "b", "c", "d"].map((name) => ({
      step: "tests apps/web",
      cwd: "apps/web",
      prefix: ["vitest", "run"],
      file: `src/${name}.test.ts`,
    }));
    const order: string[] = [];
    let running = 0;
    const outcome = await rerunAlone(
      failures,
      async (failure): Promise<RerunResult> => {
        running += 1;
        expect(running).toBe(1);
        order.push(failure.file);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { failure, ok: failure.file !== "src/b.test.ts", seconds: 0, output: "" };
      },
      3,
    );
    expect(order).toEqual(["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"]);
    expect(outcome.passedAlone.map((row) => row.failure.file)).toEqual([
      "src/a.test.ts",
      "src/c.test.ts",
    ]);
    expect(outcome.failedAlone.map((row) => row.failure.file)).toEqual(["src/b.test.ts"]);
    expect(outcome.notRerun.map((row) => row.file)).toEqual(["src/d.test.ts"]);
  });
});
