// `bun run check`: the one-minute pre-push gate. See tools/check/README.md.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { affectedTests, importsOf, mentionNeedles, reach, reverseGraph } from "./lib/graph.ts";
import { groupTests, select, unitTestCommand } from "./lib/plan.ts";
import {
  buildResolver,
  changedFiles,
  readSources,
  repoRootOf,
  testsMentioning,
} from "./lib/repo.ts";
import { packageOf, readWorkspace } from "./lib/workspace.ts";

const USAGE = `usage: bun run check [--base <ref>] [--json] [--no-tests] [--allow-root]

  --base <ref>   compare with the merge base of HEAD and <ref> (default origin/main)
  --json         print one JSON report instead of lines
  --no-tests     format, lint, checks and types only
  --allow-root   run the selection even when root configuration changed
  --dry-run      print the selected steps and their commands without running them`;

const BROWSER_LIMIT = 20;

interface Options {
  base: string;
  json: boolean;
  tests: boolean;
  allowRoot: boolean;
  dryRun: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    base: "origin/main",
    json: false,
    tests: true,
    allowRoot: false,
    dryRun: false,
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
    else if (arg === "--help" || arg === "-h") {
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
}

interface StepResult {
  readonly name: string;
  readonly status: "ok" | "fail" | "left" | "skipped" | "plan";
  readonly seconds: number;
  readonly detail: string;
  readonly reproduce?: string;
  readonly output?: string;
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
    const child = spawn(step.command[0]!, step.command.slice(1), {
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
      resolve(
        code === 0
          ? { name: step.name, status: "ok", seconds, detail: step.detail }
          : {
              name: step.name,
              status: "fail",
              seconds,
              detail: step.detail,
              reproduce: reproduceOf(step),
              output,
            },
      );
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

/** Runs groups one after another; the steps of a group run at once, at most `limit` at a time. */
async function runAll(
  repoRoot: string,
  lanes: ReadonlyArray<ReadonlyArray<{ steps: readonly Step[]; limit: number }>>,
  report: (result: StepResult) => void,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  await Promise.all(
    lanes.map(async (groups) => {
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
      if (result.status === "fail" && result.reproduce) {
        console.log(`    reproduce: ${result.reproduce}`);
        console.log(tail(result.output ?? "", 25));
      }
    }
  };

  if (selection.rootConfig.length > 0 && !options.allowRoot) {
    emit({
      name: "root config",
      status: "fail",
      seconds: 0,
      detail: `full run required: ${list(selection.rootConfig, 8)} changed. The full lanes are the coordinator's; --allow-root runs the selection anyway.`,
    });
    return finish(
      options,
      started,
      mergeBase,
      files.map((file) => file.path),
      selection,
      groups,
      results,
      2,
    );
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
    testSteps.push({
      name: `tests ${pkg.dir}`,
      cwd,
      command: [
        bun,
        "x",
        "vitest",
        "run",
        "--passWithNoTests",
        "--maxWorkers=4",
        ...config,
        ...testFiles,
      ],
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
    testSteps.push({
      name: "browser",
      cwd: "apps/web",
      command: [
        bun,
        "x",
        "vitest",
        "run",
        "--config",
        "vitest.browser.ci.config.ts",
        "--project=components",
        ...groups.browser,
      ],
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
    for (const step of [...staticSteps, ...typeSteps, ...testSteps]) {
      emit({
        name: step.name,
        status: "plan",
        seconds: 0,
        detail: `${step.detail}${step.detail ? "; " : ""}${reproduceOf(step)}`,
      });
    }
    return finish(
      options,
      started,
      mergeBase,
      files.map((file) => file.path),
      selection,
      groups,
      results,
      0,
    );
  }
  await runAll(
    repoRoot,
    [
      [
        { steps: staticSteps, limit: 1 },
        { steps: typeSteps, limit: 2 },
      ],
      [{ steps: testSteps, limit: 1 }],
    ],
    emit,
  );
  const failed = results.some((result) => result.status === "fail");
  return finish(
    options,
    started,
    mergeBase,
    files.map((file) => file.path),
    selection,
    groups,
    results,
    failed ? 1 : 0,
  );
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
): number {
  const seconds = (performance.now() - started) / 1000;
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
          seconds: Number(seconds.toFixed(1)),
        },
        null,
        2,
      ),
    );
  } else {
    const verdict = code === 0 ? "ok" : code === 2 ? "full run required" : "failed";
    console.log(`total ${seconds.toFixed(1)}s  ${verdict}`);
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
