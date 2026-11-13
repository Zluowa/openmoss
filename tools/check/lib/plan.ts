// Turns a list of changed files into the steps of `bun run check`. Pure: no I/O.
import { packageOf, type WorkspacePackage } from "./workspace.ts";

export interface ChangedFile {
  /** Repository-relative, forward slashes. */
  readonly path: string;
  /** False for a deleted file. */
  readonly exists: boolean;
}

/** Changes that can affect every test, so only a full run says anything. */
export function isRootConfig(path: string): boolean {
  if (/^(package\.json|bun\.lock|bunfig\.toml|turbo\.json|tsconfig[^/]*\.json)$/.test(path))
    return true;
  if (path.startsWith("patches/")) return true;
  // A tool's own Vitest config only changes that tool's tests, which run anyway.
  if (/^tools\/[^/]+\/vitest\.config\.ts$/.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  // Vitest configs anywhere (apps/web's vite.config.ts is its unit-test config), and setup files.
  if (/^(vitest|vite)(\.[\w-]+)*\.config\.[cm]?[jt]s$/.test(name)) return true;
  if (/^vitest\.(workspace|setup)\.[cm]?[jt]s$/.test(name)) return true;
  if (/^apps\/web\/src\/test\/[^/]*Setup\.ts$/.test(path)) return true;
  return path === "test-quarantine.json" || path.startsWith("tools/test-quarantine/");
}

const FORMATTED =
  /\.(?:[cm]?[jt]sx?|json|jsonc|json5|md|mdx|ya?ml|toml|css|scss|less|html|vue|graphql)$/;
const LINTED = /\.(?:[cm]?[jt]sx?)$/;
/** Files that can change a package's types or test results. */
const CODE = /\.(?:[cm]?[jt]sx?|json|css|svg|html|wasm|node)$/;
const BROWSER_TEST = /\.browser\.[cm]?[jt]sx?$/;

/** Root scripts that run only when a file they read changed. Missing scripts are skipped. */
export const RELEVANT_CHECKS: ReadonlyArray<{
  readonly script: string;
  readonly relevant: (path: string) => boolean;
}> = [
  {
    script: "design:check",
    relevant: (path) =>
      path.startsWith("apps/web/src/") ||
      path === "scripts/check-design-tokens.ts" ||
      path === "scripts/design-check-baseline.json",
  },
  {
    script: "server-sync-fs:check",
    relevant: (path) =>
      path.startsWith("apps/server/src/") ||
      path.startsWith("packages/shared/src/") ||
      path === "scripts/check-server-sync-fs.ts",
  },
  {
    // Public runtime sources, release scripts, brand assets and the root documents it reads.
    script: "brand:check",
    relevant: (path) =>
      /^(apps|packages)\/[^/]+\/(src|scripts|content|public|resources)\//.test(path) ||
      /^apps\/[^/]+\/package\.json$/.test(path) ||
      (path.startsWith("scripts/") && CODE.test(path)) ||
      /^(README|CHANGELOG)\.md$|^LICENSE$/.test(path),
  },
  {
    script: "skills:check",
    relevant: (path) => path.startsWith(".agents/skills/") || path.startsWith(".claude/skills/"),
  },
  {
    script: "test-quarantine:check",
    relevant: (path) =>
      path === "test-quarantine.json" || path.startsWith("tools/test-quarantine/"),
  },
];

export interface Selection {
  readonly rootConfig: string[];
  readonly format: string[];
  readonly lint: string[];
  readonly checks: string[];
  /** Packages with a changed file, in workspace order. */
  readonly changedPackages: string[];
  /** Packages holding a changed file or a file that imports one, directly or not. */
  readonly affectedPackages: string[];
  /** Whether the phone app's own lane (`bun run mobile:check`) has to run. */
  readonly mobile: boolean;
}

/**
 * The phone app: not a workspace package (root `workspaces` lists `!apps/mobile`; it has its
 * own npm install), so it has its own lane. Its tests read the contracts' source.
 */
export const MOBILE_DIR = "apps/mobile";

export function touchesMobile(changed: readonly string[], reached: Iterable<string>): boolean {
  const inApp = (path: string) => path.startsWith(`${MOBILE_DIR}/`);
  return (
    changed.some((path) => inApp(path) || path.startsWith("packages/contracts/src/")) ||
    [...reached].some(inApp)
  );
}

export function select(
  changed: readonly ChangedFile[],
  packages: readonly WorkspacePackage[],
  rootScripts: Readonly<Record<string, string>>,
  /** The changed files and every file that imports one (graph.ts `reach`). */
  reached: Iterable<string> = [],
): Selection {
  const existing = changed.filter((file) => file.exists).map((file) => file.path);
  const changedPackages = new Set<string>();
  for (const file of changed) {
    const pkg = packageOf(file.path, packages);
    if (pkg) changedPackages.add(pkg.name);
  }
  // Only code can change a package's types or tests: a README in scripts/ affects nothing.
  const affected = new Set<string>();
  const reachedFiles = [...reached];
  for (const file of reachedFiles) {
    const pkg = packageOf(file, packages);
    if (pkg && CODE.test(file)) affected.add(pkg.name);
  }
  const inOrder = (names: ReadonlySet<string>) =>
    packages.map((pkg) => pkg.name).filter((name) => names.has(name));
  return {
    rootConfig: changed.map((file) => file.path).filter(isRootConfig),
    format: existing.filter((path) => FORMATTED.test(path)),
    lint: existing.filter((path) => LINTED.test(path)),
    checks: RELEVANT_CHECKS.filter(
      ({ script, relevant }) =>
        rootScripts[script] !== undefined && changed.some((file) => relevant(file.path)),
    ).map(({ script }) => script),
    changedPackages: inOrder(changedPackages),
    affectedPackages: inOrder(affected),
    mobile: touchesMobile(
      changed.map((file) => file.path),
      reachedFiles,
    ),
  };
}

export interface TestGroups {
  /** Package name -> its selected unit test files, relative to the package folder. */
  readonly unit: Map<string, string[]>;
  /** The web app's selected component browser files, relative to apps/web. */
  readonly browser: string[];
  /** Browser files the gate never runs (ChatView alone takes over ten minutes). */
  readonly browserLeft: string[];
}

export const GATE_SKIPS_BROWSER = ["apps/web/src/components/ChatView.browser.tsx"];

export function groupTests(
  tests: readonly string[],
  packages: readonly WorkspacePackage[],
): TestGroups {
  const unit = new Map<string, string[]>();
  const browser: string[] = [];
  const browserLeft: string[] = [];
  for (const test of tests) {
    const pkg = packageOf(test, packages);
    if (!pkg) continue;
    const relative = test.slice(pkg.dir.length + 1);
    if (isBrowserTest(test)) {
      if (pkg.dir !== "apps/web") continue;
      (GATE_SKIPS_BROWSER.includes(test) ? browserLeft : browser).push(relative);
      continue;
    }
    unit.set(pkg.name, [...(unit.get(pkg.name) ?? []), relative]);
  }
  return { unit, browser, browserLeft };
}

/** How a package runs its unit tests, or null when it has none or they are not Vitest. */
export function unitTestCommand(
  pkg: WorkspacePackage,
): { readonly cwd: string; readonly args: string[] } | null {
  if (pkg.kind === "tool") return { cwd: ".", args: ["--config", `${pkg.dir}/vitest.config.ts`] };
  const test = pkg.scripts.test;
  if (!test) return null;
  // `bun run test:vitest` style indirection.
  const target = /^bun run ([\w:-]+)$/.exec(test)?.[1];
  const script = target ? pkg.scripts[target] : test;
  if (!script || !/^vitest run\b/.test(script)) return null;
  const config = /--config[ =](\S+)/.exec(script)?.[1];
  return { cwd: pkg.dir, args: config ? ["--config", config] : [] };
}

export function isBrowserTest(path: string): boolean {
  return BROWSER_TEST.test(path);
}
