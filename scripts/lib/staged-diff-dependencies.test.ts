import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertStagedDiffDependencies } from "./staged-diff-dependencies.ts";

function writePackage(
  stageAppDir: string,
  packageName: string,
  manifest: Record<string, unknown>,
): string {
  const packageRoot = path.join(stageAppDir, "node_modules", ...packageName.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  return packageRoot;
}

function withFixture(run: (stageAppDir: string) => void): void {
  const stageAppDir = mkdtempSync(path.join(tmpdir(), "moss-stage-diff-"));
  writeFileSync(path.join(stageAppDir, "package.json"), JSON.stringify({ name: "moss-desktop" }));
  const pierreRoot = writePackage(stageAppDir, "@pierre/diffs", {
    name: "@pierre/diffs",
    dependencies: { diff: "8.0.3" },
  });
  writePackage(stageAppDir, "diff", { name: "diff", version: "8.0.4" });
  writePackage(pierreRoot, "diff", { name: "diff", version: "8.0.3" });

  try {
    run(stageAppDir);
  } finally {
    rmSync(stageAppDir, { force: true, recursive: true });
  }
}

describe("staged diff dependency consistency", () => {
  it("resolves the exact nested diff version beside a hoisted one", () => {
    withFixture((stageAppDir) => {
      assert.deepStrictEqual(
        assertStagedDiffDependencies(stageAppDir).map(({ consumer, diffVersion }) => ({
          consumer,
          diffVersion,
        })),
        [{ consumer: "@pierre/diffs", diffVersion: "8.0.3" }],
      );
    });
  });

  it("rejects a flattened install that violates an exact consumer dependency", () => {
    withFixture((stageAppDir) => {
      rmSync(path.join(stageAppDir, "node_modules", "@pierre", "diffs", "node_modules", "diff"), {
        recursive: true,
      });
      assert.throws(
        () => assertStagedDiffDependencies(stageAppDir),
        /@pierre\/diffs declares diff 8\.0\.3 but resolves 8\.0\.4/,
      );
    });
  });

  it("requires consumers to declare exact versions", () => {
    withFixture((stageAppDir) => {
      writePackage(stageAppDir, "@pierre/diffs", {
        name: "@pierre/diffs",
        dependencies: { diff: "^8.0.3" },
      });
      assert.throws(
        () => assertStagedDiffDependencies(stageAppDir),
        /must declare an exact diff dependency version/,
      );
    });
  });
});
