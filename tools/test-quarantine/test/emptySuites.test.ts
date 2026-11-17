// Collects real fixture files with a nested Vitest (--passWithNoTests, as apps/web and apps/desktop
// run) and checks which suites count as empty, and that the plugin's reporter fails the run.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

import { EmptySuiteReporter, emptySuitesOf } from "../emptySuites.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function run(include: string) {
  const logged: string[] = [];
  const previousExitCode = process.exitCode;
  const vitest = await createVitest("test", {
    root: fixtureRoot,
    config: false,
    watch: false,
    passWithNoTests: true,
    reporters: [new EmptySuiteReporter({ root: fixtureRoot, log: (text) => logged.push(text) })],
    maxWorkers: 1,
    include: [`packages/shared/src/${include}`],
  });
  try {
    const result = await vitest.start();
    const empty = (result?.testModules ?? []).flatMap((module) =>
      emptySuitesOf(module, module.moduleId.split("/").at(-1)!),
    );
    return { empty, logged: logged.join(""), exitCode: process.exitCode };
  } finally {
    await vitest.close();
    process.exitCode = previousExitCode;
  }
}

describe("empty suite check", () => {
  it("names setup-only suites and files without tests, and fails the run", async () => {
    const { empty, logged, exitCode } = await run("*.empty-fixture.ts");
    expect(
      empty.toSorted((a, b) => `${a.file}${a.suite}`.localeCompare(`${b.file}${b.suite}`)),
    ).toEqual([
      { file: "noTests.empty-fixture.ts" },
      { file: "setupOnly.empty-fixture.ts", suite: "kept > nested setup only" },
      { file: "setupOnly.empty-fixture.ts", suite: "setup only, left by a merge" },
    ]);
    expect(exitCode).toBe(1);
    expect(logged).toContain("EMPTY SUITES: 3 suite(s) ran without a single test");
    expect(logged).toContain("packages/shared/src/noTests.empty-fixture.ts (no tests in the file)");
  });

  it("accepts skipped and todo suites and suites whose tests are all skipped", async () => {
    const { empty, logged, exitCode } = await run("fine.empty-fixture.ts");
    expect(empty).toEqual([]);
    expect(logged).toBe("");
    expect(exitCode).not.toBe(1);
  });
});
