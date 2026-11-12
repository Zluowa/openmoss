// `bun run check`: the one-minute pre-push gate. See tools/check/README.md.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { affectedTests, importsOf, mentionNeedles, reach, reverseGraph } from "./lib/graph.ts";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  describeLoad,
  heavyLane,
  laneName,
  loadSettings,
  ownerName,
  takeSlot,
  waitForHeavyLane,
  type LoadReport,
} from "./lib/load.ts";
import { groupTests, select, unitTestCommand } from "./lib/plan.ts";
import {
  buildResolver,
  changedFiles,
  readSources,
  repoRootOf,
  testsMentioning,
} from "./lib/repo.ts";
import {
  aloneCommand,
  failedTestFiles,
  RERUN_LIMIT,
  rerunAlone,
  type RerunFailure,
  type RerunOutcome,
  type RerunResult,
} from "./lib/rerun.ts";
import { packageOf, readWorkspace } from "./lib/workspace.ts";

const USAGE = `usage: bun run check [--base <ref>] [--json] [--no-tests] [--allow-root] [--dry-run]
                     [--no-wait] [--max-wait <minutes>]

  --base <ref>          compare with the merge base of HEAD and <ref> (default origin/main)
  --json                print one JSON report instead of lines
  --no-tests            format, lint, checks and types only
  --allow-root          run the selection even when root configuration changed
  --dry-run             print the selected steps and their commands without running them
  --no-wait             run the tests even while another owner's heavy lane runs
  --max-wait <minutes>  wait at most this long for a heavy lane, then test anyway (default ${DEFAULT_MAX_WAIT_MINUTES})`;

const BROWSER_LIMIT = 20;

interface Options {
  base: string;
  json: boolean;
  tests: boolean;
  allowRoot: boolean;
  dryRun: boolean;
  wait: boolean;
  maxWaitMinutes: number;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    base: "origin/main",
    json: false,
    tests: true,
    allowRoot: false,
    dryRun: false,
    wait: true,
    maxWaitMinutes: DEFAULT_MAX_WAIT_MINUTES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      const value = argv[(index += 1)];
      if (!value) throw new Error("--base needs a ref");
      options.base = value;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--no-tests") options.tests = false;
    else if (arg === "--allow-root") options.allowRoot = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-wait") options.wait = false;
    else if (arg === "--max-wait") {
      const value = Number(argv[(index += 1)]);
      if (!Number.isFinite(value) || value < 0) throw new Error("--max-wait needs minutes");
      options.maxWaitMinutes = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  return options;
}

interface Step {
  readonly name: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly detail: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Test steps: the command without its files, so each file can be rerun alone. */
  readonly testPrefix?: readonly string[];
  /** Arguments added when running but left out of the reproduce command (the JSON report). */
  readonly extraArgs?: readonly string[];
  /** Where the step's Vitest JSON report is written. */
  readonly report?: string;
}

interface StepResult {
  readonly name: string;
  readonly status: "ok" | "fail" | "left" | "skipped" | "plan";
  readonly seconds: number;
  readonly detail: string;
  readonly reproduce?: string;
  readonly output?: string;
  /** A failed test step: the files its report marks failed; undefined when it names none. */
  readonly failedFiles?: readonly string[];
}

const bun = process.versions.bun ? process.execPath : "bun";

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function reproduceOf(step: Step): string {
  const env = Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${quote(value)} `);
  const command = ["bun", ...step.command.slice(1)].map(quote).join(" ");
  return step.cwd === "."
    ? `${env.join("")}${command}`
    : `(cd ${step.cwd} && ${env.join("")}${command})`;
}

function runStep(repoRoot: string, step: Step): Promise<StepResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(step.command[0]!, [...step.command.slice(1), ...(step.extraArgs ?? [])], {
      cwd: join(repoRoot, step.cwd),
      env: { ...process.env, ...step.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finish = (code: number | null, error?: Error) => {
      const seconds = (performance.now() - started) / 1000;
      const output = Buffer.concat(chunks).toString("utf8") + (error ? `\n${error.message}` : "");
      if (code === 0) {
        resolve({ name: step.name, status: "ok", seconds, detail: step.detail });
        return;
      }
      const failedFiles = step.report
        ? failedTestFiles(readText(step.report), join(repoRoot, step.cwd))
        : undefined;
      resolve({
        name: step.name,
        status: "fail",
        seconds,
        detail: step.detail,
        reproduce: reproduceOf(step),
        output,
        ...(failedFiles?.length ? { failedFiles } : {}),
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

interface Lane {
  /** Awaited before the lane's first step: the tests wait here for a heavy lane. */
  readonly before?: () => Promise<void>;
  readonly groups: ReadonlyArray<{ steps: readonly Step[]; limit: number }>;
}

/**
 * Runs the lanes at once. In a lane, groups run one after another; the steps of a group run at
 * once, at most `limit` at a time.
 */
async function runAll(
  repoRoot: string,
  lanes: readonly Lane[],
  report: (result: StepResult) => void,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  await Promise.all(
    lanes.map(async ({ before, groups }) => {
      if (groups.some(({ steps }) => steps.length > 0)) await before?.();
      for (const { steps, limit } of groups) {
        const queue = [...steps];
        await Promise.all(
          Array.from({ length: Math.min(limit, queue.length) }, async () => {
            for (let step = queue.shift(); step; step = queue.shift()) {
              const result = await runStep(repoRoot, step);
              results.push(result);
              report(result);
            }
          }),
        );
      }
    }),
  );
  return results;
}

function line(result: StepResult): string {
  const time = ["left", "skipped", "plan"].includes(result.status)
    ? "-"
    : `${result.seconds.toFixed(1)}s`;
  return `${result.name.padEnd(28)} ${time.padStart(7)}  ${result.status.padEnd(4)}  ${result.detail}`;
}

function tail(text: string, lines: number): string {
  return text
    .trimEnd()
    .split(/\r?\n/)
    .slice(-lines)
    .map((row) => `    ${row}`)
    .join("\n");
}

function list(files: readonly string[], max = 4): string {
  return files.length <= max
    ? files.join(", ")
    : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

async function main(argv: readonly string[]): Promise<number> {
  const started = performance.now();
  const options = parseOptions(argv);
  const repoRoot = repoRootOf(process.cwd());
  const say = (text: string) => {
    if (!options.json) console.log(text);
  };
  // Waiting and load lines: on stderr with --json, so stdout stays one JSON object.
  const note = (text: string) => (options.json ? console.error(text) : console.log(text));
  const rootScripts =
    (
      JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {};

  const { mergeBase, files } = changedFiles(repoRoot, options.base);
  const packages = readWorkspace(repoRoot);
  const { all, sources } = readSources(repoRoot);
  const imports = importsOf(sources, buildResolver(repoRoot, packages), all);
  const reached = reach(
    files.map((file) => file.path),
    reverseGraph(imports),
  );
  const selection = select(files, packages, rootScripts, reached);
  const existing = files.filter((file) => file.exists).map((file) => file.path);
  const deleted = new Set(files.filter((file) => !file.exists).map((file) => file.path));
  const tests = options.tests
    ? affectedTests(
        new Set([...reached].filter((path) => !deleted.has(path))),
        testsMentioning(
          repoRoot,
          mentionNeedles(existing, (path) => packageOf(path, packages)?.dir),
        ),
      )
    : [];
  const groups = groupTests(tests, packages);
  const planSeconds = (performance.now() - started) / 1000;
  const changed = files.map((file) => file.path);

  say(
    `check: ${files.length} changed file(s) since ${mergeBase.slice(0, 9)} (merge base with ${options.base}); planned in ${planSeconds.toFixed(1)}s`,
  );
  say(
    `  changed packages: ${selection.changedPackages.join(", ") || "none"}; affected: ${selection.affectedPackages.join(", ") || "none"}`,
  );
  const unaffected = packages.filter(
    (pkg) =>
      !selection.affectedPackages.includes(pkg.name) &&
      pkg.deps.some((dep) => selection.changedPackages.includes(dep)),
  );
  if (unaffected.length > 0) {
    say(
      `  not affected (they list a changed package but import none of the changed files): ${unaffected.map((pkg) => pkg.name).join(", ")}`,
    );
  }

  const results: StepResult[] = [];
  const emit = (result: StepResult) => {
    results.push(result);
    if (!options.json) {
      console.log(line(result));
      if (result.status === "fail" && result.failedFiles) {
        console.log(
          `    ${result.failedFiles.length} file(s) failed; each is rerun alone after the other steps`,
        );
      } else if (result.status === "fail" && result.reproduce) {
        console.log(`    reproduce: ${result.reproduce}`);
        console.log(tail(result.output ?? "", 25));
      }
    }
  };
  const done = (code: number, extra: Partial<Summary> = {}) =>
    finish(options, started, mergeBase, changed, selection, groups, results, code, extra);

  if (selection.rootConfig.length > 0 && !options.allowRoot) {
    emit({
      name: "root config",
      status: "fail",
      seconds: 0,
      detail: `full run required: ${list(selection.rootConfig, 8)} changed. The full lanes are the coordinator's; --allow-root runs the selection anyway.`,
    });
    return done(2);
  }

  const staticSteps: Step[] = [];
  if (selection.format.length > 0) {
    staticSteps.push({
      name: "format",
      cwd: ".",
      command: [
        bun,
        "x",
        "oxfmt",
        "--check",
        "--no-error-on-unmatched-pattern",
        ...selection.format,
      ],
      detail: `${selection.format.length} file(s)`,
    });
  }
  if (selection.lint.length > 0) {
    staticSteps.push({
      name: "lint",
      cwd: ".",
      command: [bun, "x", "oxlint", "--report-unused-disable-directives", ...selection.lint],
      detail: `${selection.lint.length} file(s)`,
    });
  }
  for (const script of selection.checks)
    staticSteps.push({ name: script, cwd: ".", command: [bun, "run", script], detail: "" });

  const typeSteps: Step[] = selection.affectedPackages.flatMap((name) => {
    const pkg = packages.find((candidate) => candidate.name === name)!;
    if (pkg.kind === "tool") {
      if (!existsSync(join(repoRoot, pkg.dir, "tsconfig.json"))) return [];
      return [
        {
          name: `types ${pkg.dir}`,
          cwd: ".",
          command: [bun, "x", "tsc", "-p", `${pkg.dir}/tsconfig.json`],
          detail: "",
        },
      ];
    }
    if (!pkg.scripts.typecheck) return [];
    return [
      {
        name: `types ${pkg.dir}`,
        cwd: ".",
        command: [bun, "run", "--cwd", pkg.dir, "typecheck"],
        detail: "",
      },
    ];
  });

  // Each test step writes a Vitest JSON report, so a failure can be pinned on its files.
  const reportDir = mkdtempSync(join(tmpdir(), "moss-check-"));
  const jsonReport = (id: string) => {
    const report = join(reportDir, `${id}.json`);
    return {
      report,
      extraArgs: ["--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
    };
  };
  const testSteps: Step[] = [];
  for (const [name, testFiles] of groups.unit) {
    const pkg = packages.find((candidate) => candidate.name === name)!;
    const command = unitTestCommand(pkg);
    if (!command) {
      emit({
        name: `tests ${pkg.dir}`,
        status: "skipped",
        seconds: 0,
        detail: `${testFiles.length} file(s) selected, but the package does not test with Vitest`,
      });
      continue;
    }
    const cwd = pkg.kind === "tool" ? pkg.dir : command.cwd;
    const config = pkg.kind === "tool" ? ["--config", "vitest.config.ts"] : command.args;
    const prefix = [bun, "x", "vitest", "run", "--passWithNoTests", "--maxWorkers=4", ...config];
    testSteps.push({
      name: `tests ${pkg.dir}`,
      cwd,
      command: [...prefix, ...testFiles],
      testPrefix: prefix,
      ...jsonReport(`unit-${testSteps.length}`),
      detail: `${testFiles.length} file(s): ${list(testFiles)}`,
    });
  }
  if (groups.browserLeft.length > 0) {
    emit({
      name: "browser (chat)",
      status: "left",
      seconds: 0,
      detail: `${list(groups.browserLeft)} is left to the coordinator's lane`,
    });
  }
  if (groups.browser.length > BROWSER_LIMIT) {
    emit({
      name: "browser",
      status: "left",
      seconds: 0,
      detail: `${groups.browser.length} component files selected (over ${BROWSER_LIMIT}): left to the coordinator's lane`,
    });
  } else if (groups.browser.length > 0) {
    const offset = Number(process.env.MOSS_PORT_OFFSET);
    const port =
      process.env.VITEST_BROWSER_API_PORT ??
      (Number.isInteger(offset) && offset > 0 ? String(52_000 + offset) : undefined);
    const prefix = [
      bun,
      "x",
      "vitest",
      "run",
      "--config",
      "vitest.browser.ci.config.ts",
      "--project=components",
    ];
    testSteps.push({
      name: "browser",
      cwd: "apps/web",
      command: [...prefix, ...groups.browser],
      testPrefix: prefix,
      ...jsonReport("browser"),
      detail: `${groups.browser.length} component file(s): ${list(groups.browser)}`,
      ...(port ? { env: { VITEST_BROWSER_API_PORT: port } } : {}),
    });
  }
  if (options.tests && tests.length === 0) {
    emit({
      name: "tests",
      status: "skipped",
      seconds: 0,
      detail: "no test imports a changed file",
    });
  }

  if (options.dryRun) {
    rmSync(reportDir, { recursive: true, force: true });
    for (const step of [...staticSteps, ...typeSteps, ...testSteps]) {
      emit({
        name: step.name,
        status: "plan",
        seconds: 0,
        detail: `${step.detail}${step.detail ? "; " : ""}${reproduceOf(step)}`,
      });
    }
    return done(0);
  }

  // Machine load: one of two quick-gate slots, and tests held while another owner's heavy lane runs.
  const settings = loadSettings();
  const self = ownerName(process.env, repoRoot);
  const load: LoadReport = { slotWaitMs: 0, testWaits: [], noWait: !options.wait };
  let waitBudgetMs = options.maxWaitMinutes * 60_000;
  // What a heavy lane seen now overlaps: the static steps and types, nothing (the tests are
  // waiting for it), or the tests and their reruns.
  let phase: "before tests" | "waiting" | "tests" = "before tests";
  const sample = () => {
    if (phase === "waiting") return;
    const holder = heavyLane(settings, self);
    if (!holder) return;
    if (phase === "tests") load.heavyDuringTests ??= laneName(holder);
    else load.heavyBeforeTests ??= laneName(holder);
  };
  /** Holds the tests (or the reruns) while another owner's heavy lane runs, then samples. */
  const testWhenFree = async () => {
    if (options.wait && waitBudgetMs > 0) {
      phase = "waiting";
      const wait = await waitForHeavyLane({ settings, self, maxWaitMs: waitBudgetMs, log: note });
      waitBudgetMs -= wait.waitedMs;
      if (wait.lane) {
        load.testWaits.push(wait);
        note(
          wait.gaveUp
            ? `check: heavy lane ${wait.lane} still runs after the ${options.maxWaitMinutes} min ceiling; testing anyway`
            : `check: heavy lane ${wait.lane} ended; testing`,
        );
      }
    }
    phase = "tests";
    sample();
  };
  const slotStarted = Date.now();
  const slot = await takeSlot(settings, { owner: self, sha: headSha(repoRoot) }, note);
  load.slotWaitMs = Date.now() - slotStarted;
  const releaseSlot = () => slot.release();
  process.once("exit", releaseSlot);
  sample();
  const sampler = setInterval(sample, Math.min(settings.pollMs, 5000));
  try {
    await runAll(
      repoRoot,
      [
        {
          groups: [
            { steps: staticSteps, limit: 1 },
            { steps: typeSteps, limit: 2 },
          ],
        },
        {
          before: testWhenFree,
          groups: [{ steps: testSteps, limit: 1 }],
        },
      ],
      emit,
    );

    const failures: RerunFailure[] = results.flatMap((result) => {
      const step = testSteps.find((candidate) => candidate.name === result.name);
      if (result.status !== "fail" || !result.failedFiles || !step?.testPrefix) return [];
      return result.failedFiles.map((file) => ({
        step: result.name,
        cwd: step.cwd,
        prefix: step.testPrefix!,
        file,
        ...(step.env ? { env: step.env } : {}),
      }));
    });
    let rerun: RerunOutcome | undefined;
    if (failures.length > 0) {
      await testWhenFree();
      say(
        `rerun alone: ${Math.min(failures.length, RERUN_LIMIT)} failing file(s), one at a time` +
          (failures.length > RERUN_LIMIT
            ? `; ${failures.length - RERUN_LIMIT} more over the limit of ${RERUN_LIMIT} are not rerun`
            : ""),
      );
      rerun = await rerunAlone(failures, async (failure) => {
        const result = await runStep(repoRoot, {
          name: "alone",
          cwd: failure.cwd,
          command: aloneCommand(failure.prefix, failure.file),
          detail: "",
          ...(failure.env ? { env: failure.env } : {}),
        });
        const outcome: RerunResult = {
          failure,
          ok: result.status === "ok",
          seconds: result.seconds,
          output: result.output ?? "",
        };
        say(
          `  ${outcome.ok ? "passed alone" : "failed alone"}  ${`${outcome.seconds.toFixed(1)}s`.padStart(7)}  ${filePath(failure)}`,
        );
        if (!outcome.ok) {
          say(`    reproduce: ${result.reproduce}`);
          say(tail(outcome.output, 25));
        }
        return outcome;
      });
      const names = (rows: ReadonlyArray<RerunResult | RerunFailure>) =>
        rows.map((row) => filePath("failure" in row ? row.failure : row));
      if (rerun.passedAlone.length)
        say(
          `failed under load, passed alone: ${rerun.passedAlone.length} file(s): ${list(names(rerun.passedAlone), 8)}`,
        );
      if (rerun.failedAlone.length)
        say(
          `failed alone: ${rerun.failedAlone.length} file(s): ${list(names(rerun.failedAlone), 8)}`,
        );
      if (rerun.notRerun.length)
        say(
          `not rerun (over ${RERUN_LIMIT}), counted as failed: ${rerun.notRerun.length} file(s): ${list(names(rerun.notRerun), 8)}`,
        );
    }

    const failed =
      results.some((result) => result.status === "fail" && !result.failedFiles) ||
      (rerun?.failedAlone.length ?? 0) > 0 ||
      (rerun?.notRerun.length ?? 0) > 0;
    return done(failed ? 1 : 0, { load, ...(rerun ? { rerun } : {}) });
  } finally {
    clearInterval(sampler);
    releaseSlot();
    process.off("exit", releaseSlot);
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function headSha(repoRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

const filePath = (failure: RerunFailure) =>
  failure.cwd === "." ? failure.file : `${failure.cwd}/${failure.file}`;

interface Summary {
  readonly load: LoadReport;
  readonly rerun: RerunOutcome;
}

function finish(
  options: Options,
  started: number,
  mergeBase: string,
  changed: readonly string[],
  selection: ReturnType<typeof select>,
  groups: ReturnType<typeof groupTests>,
  results: readonly StepResult[],
  code: number,
  { load, rerun }: Partial<Summary> = {},
): number {
  const seconds = (performance.now() - started) / 1000;
  const files = (rows: ReadonlyArray<RerunResult | RerunFailure>) =>
    rows.map((row) => filePath("failure" in row ? row.failure : row));
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: code === 0,
          exitCode: code,
          base: options.base,
          mergeBase,
          changed,
          selection: {
            ...selection,
            unitTests: Object.fromEntries(groups.unit),
            browser: groups.browser,
            browserLeft: groups.browserLeft,
          },
          steps: results.map(({ output, ...rest }) =>
            rest.status === "fail" ? { ...rest, output: output?.slice(-8000) } : rest,
          ),
          ...(rerun
            ? {
                rerun: {
                  failedUnderLoadPassedAlone: files(rerun.passedAlone),
                  failedAlone: files(rerun.failedAlone),
                  notRerun: files(rerun.notRerun),
                },
              }
            : {}),
          ...(load ? { load: { ...load, summary: describeLoad(load) } } : {}),
          seconds: Number(seconds.toFixed(1)),
        },
        null,
        2,
      ),
    );
  } else {
    const verdict =
      code === 2
        ? "full run required"
        : code !== 0
          ? "failed"
          : rerun?.passedAlone.length
            ? `ok, but ${rerun.passedAlone.length} file(s) failed under load and passed alone`
            : "ok";
    console.log(`total ${seconds.toFixed(1)}s  ${verdict}${load ? `; ${describeLoad(load)}` : ""}`);
  }
  return code;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
