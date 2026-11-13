import { describe, expect, it } from "vitest";

import {
  affectedTests,
  importsOf,
  mentionNeedles,
  reach,
  reverseGraph,
  resolveSpecifier,
  specifiersOf,
} from "../lib/graph.ts";
import { groupTests, isRootConfig, select, touchesMobile, unitTestCommand } from "../lib/plan.ts";
import { packageOf, type WorkspacePackage } from "../lib/workspace.ts";

const pkg = (
  name: string,
  dir: string,
  deps: string[] = [],
  scripts: Record<string, string> = {},
): WorkspacePackage => ({
  name,
  dir,
  deps,
  scripts: { typecheck: "tsc", test: "vitest run", ...scripts },
  kind: "package",
});

const packages = [
  pkg("@moss/contracts", "packages/contracts"),
  pkg("@moss/shared", "packages/shared", ["@moss/contracts"]),
  pkg("@moss/web", "apps/web", ["@moss/contracts", "@moss/shared"]),
  pkg("@moss/cli", "apps/server", ["@moss/contracts", "@moss/shared", "@moss/web"], {
    test: "vitest run --maxWorkers=1 --no-file-parallelism",
  }),
  pkg("@moss/desktop", "apps/desktop", ["@moss/shared"], {
    test: "bun run test:vitest",
    "test:vitest": "vitest run",
  }),
  pkg("@moss/sms-relay", "apps/sms-relay", [], { test: "node --test src/server.test.mjs" }),
  { name: "tools/ws", dir: "tools/ws", deps: [], scripts: {}, kind: "tool" as const },
];

const resolver = {
  packageExports: new Map([
    ["@moss/contracts", "packages/contracts/src/index.ts"],
    ["@moss/shared/process", "packages/shared/src/process.ts"],
  ]),
  aliases: [["apps/web", "~/", "apps/web/src"]] as const,
};

// A small repository: contracts <- shared <- web, shared <- server, and a desktop that lists
// shared but imports nothing from it.
const sources = [
  { path: "packages/contracts/src/index.ts", text: 'export * from "./thread";' },
  { path: "packages/contracts/src/thread.ts", text: "export const x = 1;" },
  { path: "packages/shared/src/process.ts", text: 'import { x } from "@moss/contracts";' },
  { path: "packages/shared/src/process.test.ts", text: 'import { run } from "./process";' },
  { path: "apps/web/src/lib/run.ts", text: 'import { run } from "@moss/shared/process";' },
  { path: "apps/web/src/lib/types.ts", text: 'import type { Thread } from "@moss/contracts";' },
  {
    path: "apps/web/src/components/Panel.tsx",
    text: 'import {\n  a,\n  b,\n} from "~/lib/run";\nimport type {\n  T,\n} from "~/lib/types";',
  },
  { path: "apps/web/src/components/Panel.test.tsx", text: 'import { Panel } from "./Panel";' },
  {
    path: "apps/web/src/components/Panel.browser.tsx",
    text: 'const { Panel } = await import("./Panel");',
  },
  { path: "apps/web/src/components/ChatView.browser.tsx", text: 'vi.mock("~/lib/run");' },
  { path: "apps/server/src/run.ts", text: 'import { run } from "@moss/shared/process";' },
  { path: "apps/server/src/run.test.ts", text: 'import "./run";' },
  { path: "apps/desktop/src/main.ts", text: "export {};" },
  { path: "apps/desktop/src/main.test.ts", text: 'import "./main";' },
];
const files = new Set(sources.map((source) => source.path));
const importers = reverseGraph(importsOf(sources, resolver, files));

function selectFor(changed: string[]) {
  const reached = reach(changed, importers);
  return {
    selection: select(
      changed.map((path) => ({ path, exists: true })),
      packages,
      { "design:check": "x", "brand:check": "x", "server-sync-fs:check": "x" },
      reached,
    ),
    tests: affectedTests(reached),
  };
}

describe("the phone app's lane", () => {
  const mobileSources = [
    ...sources,
    { path: "apps/mobile/src/moss/apps.ts", text: 'import "@moss/shared/process";' },
  ];
  const mobileImporters = reverseGraph(
    importsOf(mobileSources, resolver, new Set(mobileSources.map((source) => source.path))),
  );
  const mobileFor = (changed: string[]) =>
    select(
      changed.map((path) => ({ path, exists: true })),
      packages,
      {},
      reach(changed, mobileImporters),
    );

  it("runs for a change in the app, a file the app imports, or the contracts its tests read", () => {
    expect(mobileFor(["apps/mobile/src/app/index.tsx"]).mobile).toBe(true);
    expect(mobileFor(["packages/shared/src/process.ts"]).mobile).toBe(true);
    expect(mobileFor(["packages/contracts/src/thread.ts"]).mobile).toBe(true);
    expect(touchesMobile(["apps/mobile/README.md"], [])).toBe(true);
  });

  it("does not run for a change the app cannot see", () => {
    expect(mobileFor(["apps/web/src/lib/run.ts"]).mobile).toBe(false);
    expect(mobileFor(["apps/desktop/src/main.ts"]).mobile).toBe(false);
  });

  it("is not a package, so its files get no package typecheck or test step", () => {
    const selection = mobileFor(["apps/mobile/src/app/index.tsx"]);
    expect(selection.changedPackages).toEqual([]);
    expect(selection.affectedPackages).toEqual([]);
    expect(selection.format).toEqual(["apps/mobile/src/app/index.tsx"]);
    expect(selection.lint).toEqual(["apps/mobile/src/app/index.tsx"]);
  });
});

describe("file to package", () => {
  it("maps a file to the package whose folder holds it, longest folder first", () => {
    const nested = [...packages, pkg("@moss/web-sub", "apps/web/sub")];
    expect(packageOf("apps/web/src/a.ts", nested)?.name).toBe("@moss/web");
    expect(packageOf("apps/web/sub/a.ts", nested)?.name).toBe("@moss/web-sub");
    expect(packageOf("apps/webby/a.ts", nested)).toBeUndefined();
    expect(packageOf("docs/handbook/quality.md", nested)).toBeUndefined();
    expect(packageOf("tools/ws/lib/run.ts", nested)?.name).toBe("tools/ws");
  });
});

describe("dependents", () => {
  it("affects the packages that import a changed file, directly or not", () => {
    expect(selectFor(["packages/contracts/src/thread.ts"]).selection).toMatchObject({
      changedPackages: ["@moss/contracts"],
      affectedPackages: ["@moss/contracts", "@moss/shared", "@moss/web", "@moss/cli"],
    });
  });

  it("leaves out a package that lists the changed one but imports none of its changed files", () => {
    // desktop lists @moss/shared; the server lists @moss/web only to bundle it.
    expect(selectFor(["packages/shared/src/process.ts"]).selection.affectedPackages).toEqual([
      "@moss/shared",
      "@moss/web",
      "@moss/cli",
    ]);
    expect(selectFor(["apps/web/src/lib/run.ts"]).selection.affectedPackages).toEqual([
      "@moss/web",
    ]);
  });

  it("affects no package for a change to a document inside it", () => {
    const { selection } = selectFor(["apps/web/README.md"]);
    expect(selection.changedPackages).toEqual(["@moss/web"]);
    expect(selection.affectedPackages).toEqual([]);
  });

  it("does not follow type-only imports, which are erased at run time", () => {
    expect(selectFor(["apps/web/src/lib/types.ts"]).tests).toEqual([]);
  });
});

describe("root config", () => {
  it.each([
    "package.json",
    "bun.lock",
    "turbo.json",
    "tsconfig.base.json",
    "vitest.config.ts",
    "apps/server/vitest.config.ts",
    "apps/web/vite.config.ts",
    "apps/web/vitest.browser.ci.config.ts",
    "apps/web/src/test/browserLocaleSetup.ts",
    "patches/@vitest+utils@4.1.10.patch",
    "test-quarantine.json",
  ])("treats %s as root config", (path) => {
    expect(isRootConfig(path)).toBe(true);
  });

  it.each([
    "apps/web/package.json",
    "apps/web/tsconfig.json",
    "apps/web/src/viteConfig.test.ts",
    "apps/web/src/test/browserHarness.ts",
    "docs/handbook/quality.md",
    "scripts/vitest-helpers.ts",
    "tools/ws/vitest.config.ts",
  ])("does not treat %s as root config", (path) => {
    expect(isRootConfig(path)).toBe(false);
  });

  it("reports root config among the changed files", () => {
    expect(selectFor(["bun.lock", "apps/web/src/lib/run.ts"]).selection.rootConfig).toEqual([
      "bun.lock",
    ]);
  });
});

describe("static steps", () => {
  it("formats and lints only the changed files they handle, and runs only the relevant checks", () => {
    const { selection } = selectFor([
      "apps/web/src/lib/run.ts",
      "docs/handbook/quality.md",
      "assets/icon.png",
    ]);
    expect(selection.format).toEqual(["apps/web/src/lib/run.ts", "docs/handbook/quality.md"]);
    expect(selection.lint).toEqual(["apps/web/src/lib/run.ts"]);
    expect(selection.checks).toEqual(["design:check", "brand:check"]);
    expect(selectFor(["docs/handbook/quality.md"]).selection.checks).toEqual([]);
    expect(selectFor(["apps/server/src/run.ts"]).selection.checks).toEqual([
      "server-sync-fs:check",
      "brand:check",
    ]);
  });

  it("skips a relevant check the repository does not define", () => {
    const changed = [{ path: ".agents/skills/open-pr/SKILL.md", exists: true }];
    expect(select(changed, packages, {}).checks).toEqual([]);
    expect(select(changed, packages, { "skills:check": "x" }).checks).toEqual(["skills:check"]);
  });
});

describe("test selection", () => {
  it("selects the tests that import a changed file through any chain, in every package", () => {
    expect(selectFor(["packages/contracts/src/thread.ts"]).tests).toEqual([
      "apps/server/src/run.test.ts",
      "apps/web/src/components/ChatView.browser.tsx",
      "apps/web/src/components/Panel.browser.tsx",
      "apps/web/src/components/Panel.test.tsx",
      "packages/shared/src/process.test.ts",
    ]);
  });

  it("selects a changed test file itself, and nothing for a file no test reaches", () => {
    expect(selectFor(["apps/desktop/src/main.test.ts"]).tests).toEqual([
      "apps/desktop/src/main.test.ts",
    ]);
    expect(selectFor(["apps/web/src/components/Panel.browser.tsx"]).tests).toEqual([
      "apps/web/src/components/Panel.browser.tsx",
    ]);
  });

  it("groups unit tests per package and keeps ChatView out of the gate's browser run", () => {
    const groups = groupTests(selectFor(["packages/shared/src/process.ts"]).tests, packages);
    expect(Object.fromEntries(groups.unit)).toEqual({
      "@moss/shared": ["src/process.test.ts"],
      "@moss/web": ["src/components/Panel.test.tsx"],
      "@moss/cli": ["src/run.test.ts"],
    });
    expect(groups.browser).toEqual(["src/components/Panel.browser.tsx"]);
    expect(groups.browserLeft).toEqual(["src/components/ChatView.browser.tsx"]);
  });

  it("adds tests that name a changed non-code file by path", () => {
    expect(
      mentionNeedles(
        ["apps/web/src/fixtures/a.json", "apps/web/README.md", "package.json", "apps/web/src/a.ts"],
        (path) => packageOf(path, packages)?.dir,
      ),
    ).toEqual(["apps/web/src/fixtures/a.json", "src/fixtures/a.json", "apps/web/README.md"]);
    expect(affectedTests(new Set(), ["scripts/ci.test.ts", "scripts/helper.ts"])).toEqual([
      "scripts/ci.test.ts",
    ]);
  });

  it("knows how each package runs Vitest", () => {
    const byName = (name: string) => packages.find((candidate) => candidate.name === name)!;
    expect(unitTestCommand(byName("@moss/web"))).toEqual({ cwd: "apps/web", args: [] });
    expect(unitTestCommand(byName("@moss/desktop"))).toEqual({ cwd: "apps/desktop", args: [] });
    expect(unitTestCommand(byName("@moss/sms-relay"))).toBeNull();
    expect(unitTestCommand(byName("tools/ws"))).toEqual({
      cwd: ".",
      args: ["--config", "tools/ws/vitest.config.ts"],
    });
  });
});

describe("import parsing", () => {
  it("reads multi-line imports, re-exports, dynamic imports, mocks and requires; skips type-only", () => {
    expect(
      specifiersOf(
        [
          'import a from "./a";',
          "import {",
          "  b,",
          '} from "./b";',
          'import type { C } from "./c";',
          "export type {",
          "  D,",
          '} from "./d";',
          'export * from "./e";',
          'import "./f.css";',
          'const g = await import("./g");',
          'vi.mock("./h", () => ({}));',
          'const i = require("./i");',
          'import { type J, k } from "./jk";',
        ].join("\n"),
      ),
    ).toEqual(["./a", "./b", "./e", "./f.css", "./g", "./h", "./i", "./jk"]);
  });

  it("resolves relative paths, extensions, index files, aliases and package exports", () => {
    const known = new Set([
      "apps/web/src/a.ts",
      "apps/web/src/dir/index.tsx",
      "packages/shared/src/x/y.ts",
      "apps/web/src/c.ts",
    ]);
    const exportsResolver = {
      packageExports: new Map([["@moss/shared/*", "packages/shared/src/*.ts"]]),
      aliases: [["apps/web", "~/", "apps/web/src"]] as const,
    };
    expect(resolveSpecifier("apps/web/src/b.ts", "./a", known, exportsResolver)).toBe(
      "apps/web/src/a.ts",
    );
    expect(resolveSpecifier("apps/web/src/b.ts", "./a.js", known, exportsResolver)).toBe(
      "apps/web/src/a.ts",
    );
    expect(resolveSpecifier("apps/web/src/b.ts", "./dir", known, exportsResolver)).toBe(
      "apps/web/src/dir/index.tsx",
    );
    expect(resolveSpecifier("apps/web/src/x/b.ts", "~/c?raw", known, exportsResolver)).toBe(
      "apps/web/src/c.ts",
    );
    expect(resolveSpecifier("apps/server/src/b.ts", "~/c", known, exportsResolver)).toBeUndefined();
    expect(resolveSpecifier("apps/web/src/b.ts", "@moss/shared/x/y", known, exportsResolver)).toBe(
      "packages/shared/src/x/y.ts",
    );
    expect(resolveSpecifier("apps/web/src/b.ts", "react", known, exportsResolver)).toBeUndefined();
  });
});
