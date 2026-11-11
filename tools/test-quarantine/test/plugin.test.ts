// Runs a real nested Vitest over the fixtures with the plugin and a fixture quarantine list,
// so the exclusion, the setup-file skip and the platform filter are exercised end to end.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

import { testQuarantine } from "../vitest.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "moss-test-quarantine-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SAMPLE = "shared:packages/shared/src/sample.fixture.ts";
const WHOLE = "shared:packages/shared/src/whole.fixture.ts";

function listWith(entries: ReadonlyArray<{ id: string; platform: string }>): string {
  const file = join(scratch, `list-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      entries.map((entry) => ({
        ...entry,
        reason: "fixture",
        owner: "shared",
        added: "2026-11-11",
        expires: "2026-11-25",
        evidence: "fixture",
      })),
    ),
  );
  return file;
}

async function run(list: string, platform: string, mode?: "on" | "off" | "only") {
  const previousExitCode = process.exitCode;
  const vitest = await createVitest(
    "test",
    {
      root: fixtureRoot,
      config: false,
      watch: false,
      reporters: [{}],
      maxWorkers: 1,
      include: ["packages/shared/src/*.fixture.ts"],
      ...(mode ? { env: { MOSS_TEST_QUARANTINE: mode } } : {}),
    },
    { plugins: [testQuarantine({ repoRoot: fixtureRoot, file: list, platform })] },
  );
  try {
    const result = await vitest.start();
    const tests = (result?.testModules ?? []).flatMap((module) =>
      [...module.children.allTests()].map((test) => ({
        file: module.moduleId.split("/").at(-1)!,
        name: test.fullName,
        state: test.result().state,
      })),
    );
    return Object.fromEntries(tests.map(({ file, name, state }) => [`${file} > ${name}`, state]));
  } finally {
    await vitest.close();
    // The whole-file fixture fails on purpose when it runs.
    process.exitCode = previousExitCode;
  }
}

const quarantined = listWith([
  { id: WHOLE, platform: "win32" },
  { id: `${SAMPLE} > sample > is quarantined by name`, platform: "win32" },
  { id: `${SAMPLE} > sample > block > fits the bar`, platform: "linux" },
]);

describe("testQuarantine plugin", () => {
  it("leaves out whole files and skips named tests on the entry's platform", async () => {
    expect(await run(quarantined, "win32")).toEqual({
      "sample.fixture.ts > sample > keeps running": "passed",
      "sample.fixture.ts > sample > is quarantined by name": "skipped",
      "sample.fixture.ts > sample > block > fits the bar (light)": "passed",
      "sample.fixture.ts > sample > block > fits the bar (dark)": "passed",
    });
  }, 60_000);

  it("applies another platform's entries only on that platform", async () => {
    expect(await run(quarantined, "linux")).toEqual({
      "sample.fixture.ts > sample > keeps running": "passed",
      "sample.fixture.ts > sample > is quarantined by name": "passed",
      "sample.fixture.ts > sample > block > fits the bar (light)": "skipped",
      "sample.fixture.ts > sample > block > fits the bar (dark)": "skipped",
      "whole.fixture.ts > would fail if it ran": "failed",
    });
  }, 60_000);

  it("runs everything with MOSS_TEST_QUARANTINE=off", async () => {
    expect(await run(quarantined, "win32", "off")).toEqual({
      "sample.fixture.ts > sample > keeps running": "passed",
      "sample.fixture.ts > sample > is quarantined by name": "passed",
      "sample.fixture.ts > sample > block > fits the bar (light)": "passed",
      "sample.fixture.ts > sample > block > fits the bar (dark)": "passed",
      "whole.fixture.ts > would fail if it ran": "failed",
    });
  }, 60_000);

  it("runs only the quarantined tests with MOSS_TEST_QUARANTINE=only", async () => {
    expect(await run(quarantined, "win32", "only")).toEqual({
      "sample.fixture.ts > sample > keeps running": "skipped",
      "sample.fixture.ts > sample > is quarantined by name": "passed",
      "sample.fixture.ts > sample > block > fits the bar (light)": "skipped",
      "sample.fixture.ts > sample > block > fits the bar (dark)": "skipped",
      "whole.fixture.ts > would fail if it ran": "failed",
    });
  }, 60_000);

  it("keeps stdout clean, so `vitest list --json` still prints only JSON", () => {
    const vitest = resolve(fixtureRoot, "../../../../node_modules/vitest/vitest.mjs");
    const list = (env: Record<string, string>) =>
      spawnSync(process.execPath, [vitest, "list", "--json", "--config", "vitest.config.ts"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: { ...process.env, MOSS_QUARANTINE_FIXTURE_LIST: quarantined, ...env },
      });
    const quiet = list({});
    expect(quiet.status, quiet.stderr).toBe(0);
    const files = (JSON.parse(quiet.stdout) as Array<{ file: string }>).map(({ file }) =>
      file.split("/").at(-1),
    );
    expect(new Set(files)).toEqual(new Set(["sample.fixture.ts"]));
    expect(quiet.stderr).not.toMatch(/test-quarantine:/);
    const verbose = list({ MOSS_TEST_QUARANTINE_VERBOSE: "1" });
    expect(() => JSON.parse(verbose.stdout)).not.toThrow();
    expect(verbose.stderr).toMatch(/test-quarantine: 1 quarantined file\(s\) left out on win32/);
  }, 60_000);
});
