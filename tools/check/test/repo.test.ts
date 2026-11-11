// Runs against a real temporary git repository: the changed-file list (committed, staged,
// unstaged, untracked, deleted) and the import lines read from git's index plus the working tree.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importsOf, reach, reverseGraph } from "../lib/graph.ts";
import { buildResolver, changedFiles, readSources, testsMentioning } from "../lib/repo.ts";
import { readWorkspace } from "../lib/workspace.ts";

let repo = "";
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "moss-check-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "check@example.invalid");
  git("config", "user.name", "check");
  git("config", "core.autocrlf", "false");
  write("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  write(
    "packages/a/package.json",
    JSON.stringify({ name: "@x/a", exports: { "./*": "./src/*.ts" } }),
  );
  write("packages/a/src/core.ts", "export const core = 1;\n");
  write("packages/a/src/gone.ts", "export const gone = 1;\n");
  write(
    "packages/b/package.json",
    JSON.stringify({ name: "@x/b", dependencies: { "@x/a": "workspace:*" } }),
  );
  write(
    "packages/b/src/use.ts",
    'import {\n  core,\n} from "@x/a/core";\nimport { gone } from "@x/a/gone";\n',
  );
  write("packages/b/src/use.test.ts", 'import "./use";\n');
  write("packages/b/src/data.test.ts", 'const file = "packages/b/fixtures/data.json";\n');
  write("packages/b/fixtures/data.json", "{}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("branch", "base");
  write("packages/a/src/core.ts", "export const core = 2;\n");
  git("commit", "-q", "-am", "committed change");
  write("packages/b/fixtures/data.json", '{"staged":true}\n');
  git("add", "packages/b/fixtures/data.json");
  write("packages/b/src/new.ts", 'import { core } from "@x/a/core";\n');
  unlinkSync(join(repo, "packages/a/src/gone.ts"));
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("repository reading", () => {
  it("lists committed, staged, untracked and deleted changes against the merge base", () => {
    const { mergeBase, files } = changedFiles(repo, "base");
    expect(mergeBase).toBe(git("rev-parse", "base"));
    expect(files).toEqual([
      { path: "packages/a/src/core.ts", exists: true },
      { path: "packages/a/src/gone.ts", exists: false },
      { path: "packages/b/fixtures/data.json", exists: true },
      { path: "packages/b/src/new.ts", exists: true },
    ]);
  });

  it("builds the import graph from the index and the working tree, keeping deleted targets", () => {
    const packages = readWorkspace(repo);
    expect(packages.map(({ name, dir, deps }) => ({ name, dir, deps }))).toEqual([
      { name: "@x/a", dir: "packages/a", deps: [] },
      { name: "@x/b", dir: "packages/b", deps: ["@x/a"] },
    ]);
    const { all, sources } = readSources(repo);
    const importers = reverseGraph(importsOf(sources, buildResolver(repo, packages), all));
    expect([...reach(["packages/a/src/core.ts"], importers)].toSorted()).toEqual([
      "packages/a/src/core.ts",
      "packages/b/src/new.ts",
      "packages/b/src/use.test.ts",
      "packages/b/src/use.ts",
    ]);
    // The deleted module's importer is still found, so its package is typechecked.
    expect([...reach(["packages/a/src/gone.ts"], importers)]).toContain("packages/b/src/use.ts");
  });

  it("finds tests that name a changed file by path", () => {
    expect(testsMentioning(repo, ["packages/b/fixtures/data.json"])).toEqual([
      "packages/b/src/data.test.ts",
    ]);
    expect(testsMentioning(repo, [])).toEqual([]);
  });
});
