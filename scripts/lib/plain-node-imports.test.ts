import { spawnSync } from "node:child_process";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = Path.resolve(import.meta.dirname, "..", "..");

// The installer build runs `node scripts/build-desktop-artifact.ts` with Node's own type
// stripping, not a bundler. Node then resolves every import literally, so one extensionless
// relative import anywhere in the graph it loads (for example in @moss/shared/codexRuntime)
// fails every release build with ERR_MODULE_NOT_FOUND. `--help` loads the whole graph and
// exits before building anything.
const nodeStripsTypes = Boolean((process.features as { typescript?: unknown }).typescript);

describe("desktop artifact build under plain Node", () => {
  it.skipIf(!nodeStripsTypes)("loads its whole module graph", () => {
    const result = spawnSync(process.execPath, ["scripts/build-desktop-artifact.ts", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED|SyntaxError/u);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("build-desktop-artifact");
  });
});
