// `bun run test:quarantined [--lane <lane>[,<lane>]] [--dry-run]`: runs only the quarantined
// tests that apply on this platform, lane by lane, with no retries, and prints pass or fail per
// entry. Exits 1 when any entry failed or did not run. This is the nightly signal that tells an
// owner an entry can be removed (three passing nights) or still needs work.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalisePath } from "./context.ts";
import {
  LANES,
  QUARANTINE_FILE,
  entriesFor,
  nameCovers,
  type ParsedId,
  type QuarantineEntry,
  type QuarantineLane,
} from "./quarantine.ts";

type Entry = QuarantineEntry & ParsedId;

/** The Vitest invocation for each lane, run from the lane's package folder. */
export const LANE_ARGS: Readonly<Record<QuarantineLane, readonly string[]>> = {
  contracts: ["--maxWorkers=2"],
  shared: ["--maxWorkers=2"],
  desktop: ["--maxWorkers=2"],
  web: ["--maxWorkers=2"],
  server: ["--maxWorkers=2"],
  scripts: ["--maxWorkers=2"],
  components: ["--config", "vitest.browser.ci.config.ts", "--project=components"],
  chat: ["--config", "vitest.browser.ci.config.ts", "--project=chat"],
  geometry: ["--config", "vitest.browser.geometry.config.ts"],
};

export interface LaneRun {
  readonly lane: QuarantineLane;
  readonly cwd: string;
  readonly args: string[];
  readonly entries: Entry[];
}

export function planRuns(
  entries: readonly QuarantineEntry[],
  options: {
    readonly platform: string;
    readonly repoRoot: string;
    readonly lanes?: readonly string[];
  },
): LaneRun[] {
  const byLane = new Map<QuarantineLane, Entry[]>();
  for (const entry of entriesFor(entries, options.platform)) {
    if (options.lanes && !options.lanes.includes(entry.lane)) continue;
    byLane.set(entry.lane, [...(byLane.get(entry.lane) ?? []), entry]);
  }
  return [...byLane].map(([lane, laneEntries]) => {
    const cwd = resolve(options.repoRoot, LANES[lane].dir);
    const files = [...new Set(laneEntries.map((entry) => resolve(options.repoRoot, entry.file)))];
    return {
      lane,
      cwd,
      entries: laneEntries,
      args: [
        "run",
        ...LANE_ARGS[lane],
        "--retry=0",
        "--passWithNoTests",
        ...files.map((file) => file.replace(/\\/g, "/")),
      ],
    };
  });
}

interface JsonAssertion {
  readonly ancestorTitles: readonly string[];
  readonly title: string;
  readonly status: string;
}
interface JsonFile {
  readonly name: string;
  readonly status: string;
  readonly assertionResults: readonly JsonAssertion[];
}
export interface EntryResult {
  readonly id: string;
  readonly result: "pass" | "fail" | "not run";
  readonly passed: number;
  readonly failed: number;
}

/** Maps a Vitest JSON report back to the entries of one lane. */
export function summarise(
  entries: readonly Entry[],
  report: { readonly testResults?: readonly JsonFile[] } | null,
  options: { readonly repoRoot: string; readonly lowerCasePaths: boolean },
): EntryResult[] {
  const files = new Map(
    (report?.testResults ?? []).map((file) => [
      normalisePath(file.name, options.lowerCasePaths),
      file,
    ]),
  );
  return entries.map((entry) => {
    const file = files.get(
      normalisePath(resolve(options.repoRoot, entry.file), options.lowerCasePaths),
    );
    const name = entry.name;
    const covered = (file?.assertionResults ?? []).filter(
      (test) =>
        name === undefined || nameCovers(name, [...test.ancestorTitles, test.title].join(" > ")),
    );
    const passed = covered.filter((test) => test.status === "passed").length;
    const failed = covered.filter((test) => test.status === "failed").length;
    // A file that failed to load has no tests; a whole-file entry then fails.
    const fileError = name === undefined && file?.status === "failed" && failed === 0;
    const result = failed > 0 || fileError ? "fail" : passed > 0 ? "pass" : "not run";
    return { id: entry.id, result, passed, failed: fileError ? 1 : failed };
  });
}

function readReport(path: string): { testResults?: JsonFile[] } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { testResults?: JsonFile[] };
  } catch {
    return null;
  }
}

function main(argv: readonly string[]): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const laneIndex = argv.indexOf("--lane");
  const lanes =
    laneIndex === -1 ? undefined : (argv[laneIndex + 1] ?? "").split(",").filter(Boolean);
  const entries = JSON.parse(
    readFileSync(resolve(repoRoot, QUARANTINE_FILE), "utf8"),
  ) as QuarantineEntry[];
  const runs = planRuns(entries, {
    platform: process.platform,
    repoRoot,
    ...(lanes ? { lanes } : {}),
  });
  const vitest = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
  if (runs.length === 0) {
    console.log(`No quarantined tests apply on ${process.platform}.`);
    return 0;
  }
  const scratch = mkdtempSync(join(tmpdir(), "moss-quarantined-"));
  const results: EntryResult[] = [];
  try {
    for (const run of runs) {
      const output = join(scratch, `${run.lane}.json`);
      const args = [
        vitest,
        ...run.args,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${output}`,
      ];
      console.log(
        `\n== ${run.lane}: ${run.entries.length} entr${run.entries.length === 1 ? "y" : "ies"} (cd ${run.cwd})`,
      );
      if (argv.includes("--dry-run")) {
        console.log(`node ${args.join(" ")}`);
        continue;
      }
      spawnSync(process.execPath, args, {
        cwd: run.cwd,
        stdio: "inherit",
        env: { ...process.env, MOSS_TEST_QUARANTINE: "only" },
      });
      results.push(
        ...summarise(run.entries, readReport(output), {
          repoRoot,
          lowerCasePaths: process.platform === "win32",
        }),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (argv.includes("--dry-run")) return 0;
  console.log(`\nQuarantined tests on ${process.platform}, no retries:`);
  for (const { id, result, passed, failed } of results) {
    console.log(
      `${result.toUpperCase().padEnd(7)} ${String(passed).padStart(3)} passed ${String(failed).padStart(3)} failed  ${id}`,
    );
  }
  const bad = results.filter((entry) => entry.result !== "pass").length;
  console.log(`${results.length - bad}/${results.length} entries passed.`);
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
