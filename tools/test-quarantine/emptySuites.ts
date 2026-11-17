// A Vitest reporter that fails the run when a test file that ran holds a suite without tests, or no
// tests at all. `--passWithNoTests` (apps/web and apps/desktop use it, so a filter may match no
// files) also silences Vitest's own "No test found in suite" error: on 2026-11-18 two files on main
// kept setup-only describe blocks after a merge and every run passed. The test-quarantine plugin
// adds this reporter to every project it is in.
//
// A skipped or todo suite is fine (it states why it has no running tests), and so is a suite whose
// tests are all skipped: they are still tests. A file that could not be collected fails on its own.
import type { Reporter, TestModule, TestSuite } from "vitest/node";

export interface EmptySuite {
  /** Repository-relative when the root is known, else the module id. */
  readonly file: string;
  /** Describe names joined by " > "; absent when the whole file has no tests. */
  readonly suite?: string;
}

function suitePath(suite: TestSuite): string {
  const names: string[] = [];
  for (let current: TestSuite | TestModule = suite; current.type === "suite"; ) {
    names.unshift(current.name);
    current = current.parent;
  }
  return names.join(" > ");
}

/** The empty suites of one collected module (none for a module that failed or was skipped). */
export function emptySuitesOf(module: TestModule, file = module.moduleId): EmptySuite[] {
  const state = module.state();
  if (state === "skipped" || state === "failed" || state === "pending" || state === "queued") {
    return [];
  }
  if ([...module.children.allTests()].length === 0) return [{ file }];
  const empty: EmptySuite[] = [];
  for (const suite of module.children.allSuites()) {
    const mode = suite.options.mode;
    if (mode === "skip" || mode === "todo") continue;
    if ([...suite.children.allTests()].length === 0) empty.push({ file, suite: suitePath(suite) });
  }
  return empty;
}

export class EmptySuiteReporter implements Reporter {
  /** Marks instances across separately bundled config files, where instanceof fails. */
  readonly mossEmptySuiteReporter = true;
  private readonly root: string;
  private readonly log: (text: string) => void;

  constructor(options: { root?: string; log?: (text: string) => void } = {}) {
    this.root = (options.root ?? "").replaceAll("\\", "/").replace(/\/?$/u, "/");
    this.log = options.log ?? ((text) => process.stderr.write(text));
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const relative = (id: string) => {
      const normal = id.replaceAll("\\", "/");
      return this.root !== "/" && normal.toLowerCase().startsWith(this.root.toLowerCase())
        ? normal.slice(this.root.length)
        : normal;
    };
    const empty = modules.flatMap((module) => emptySuitesOf(module, relative(module.moduleId)));
    if (empty.length === 0) return;
    this.log(
      `\nEMPTY SUITES: ${empty.length} suite(s) ran without a single test. Add the tests back, ` +
        "or remove the suite (a setup-only describe block left by a merge passes silently under " +
        "--passWithNoTests):\n" +
        empty
          .map(
            (entry) =>
              `  ${entry.file}${entry.suite ? ` > ${entry.suite}` : " (no tests in the file)"}`,
          )
          .join("\n") +
        "\n",
    );
    process.exitCode = 1;
  }
}

export function isEmptySuiteReporter(reporter: unknown): boolean {
  return typeof reporter === "object" && reporter !== null && "mossEmptySuiteReporter" in reporter;
}
