import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { parse } from "yaml";

import {
  BROWSER_PHASE_RESERVE_BYTES,
  browserDiskContext,
  initializeBrowserCaches,
  releaseBrowserCache,
  requireBrowserDiskReserve,
} from "./ci-browser-disk.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    assert.equal(fs.realpathSync(root), root);
    assert.ok(path.basename(root).startsWith("moss-browser-disk-test-"));
    fs.rmSync(root, { recursive: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moss-browser-disk-test-")));
  fixtures.push(root);
  const workspace = path.join(root, "workspace");
  const temporary = path.join(root, "temp");
  fs.mkdirSync(workspace);
  fs.mkdirSync(temporary);
  const env = {
    MOSS_CI_RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "browser",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    MOSS_CI_BROWSER_PROJECT: "components",
    MOSS_CI_BROWSER_LANE: "1/2",
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
  };
  return { root, env, context: browserDiskContext(env, "linux") };
}

function sentinel(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "sentinel.txt");
  fs.writeFileSync(file, "retain");
  return file;
}

describe("hosted component browser cache lifetime", () => {
  it("releases only an inactive phase and preserves next caches, dependencies and tools", () => {
    const { context } = fixture();
    initializeBrowserCaches(context);
    const retained = [
      sentinel(context.phases.compiler),
      sentinel(context.phases.geometry),
      sentinel(path.join(context.workspace, "node_modules/live-tool")),
      sentinel(path.join(context.workspace, "apps/web/node_modules/.vite")),
      sentinel(path.join(context.temporary, "unrelated-cache")),
    ];
    sentinel(context.phases.stable);
    releaseBrowserCache(context, "stable");
    assert.equal(fs.existsSync(context.phases.stable), false);
    for (const file of retained) assert.ok(fs.existsSync(file));
    releaseBrowserCache(context, "compiler");
    assert.ok(fs.existsSync(retained[1]!));
    assert.throws(() => releaseBrowserCache(context, "geometry" as never), /Only completed/);
    assert.ok(fs.existsSync(retained[1]!));
  });

  it("refuses to adopt an existing path or clean a different run, shard or worker", () => {
    const { env, context } = fixture();
    initializeBrowserCaches(context);
    const file = sentinel(context.phases.stable);
    assert.throws(() => initializeBrowserCaches(context));
    for (const change of [
      { GITHUB_RUN_ID: "456" },
      { GITHUB_RUN_ATTEMPT: "3" },
      { MOSS_CI_BROWSER_LANE: "2/2" },
    ]) {
      assert.throws(() =>
        releaseBrowserCache(browserDiskContext({ ...env, ...change }, "linux"), "stable"),
      );
      assert.ok(fs.existsSync(file));
    }
    for (const change of [
      { GITHUB_JOB: "unit_tests" },
      { MOSS_CI_RUNNER_ENVIRONMENT: "self-hosted" },
      { RUNNER_OS: "Windows" },
      { GITHUB_ACTIONS: "false" },
      { MOSS_CI_BROWSER_PROJECT: "chat" },
      { MOSS_CI_BROWSER_LANE: "3/2" },
    ]) {
      assert.throws(() => browserDiskContext({ ...env, ...change }, "linux"), /requires a hosted/);
      assert.ok(fs.existsSync(file));
    }
    assert.throws(() => browserDiskContext(env, "win32"), /requires a hosted/);
  });

  it("preserves caches when owner content or the directory identity changes", () => {
    const { context } = fixture();
    initializeBrowserCaches(context);
    const marker = path.join(context.root, ".moss-browser-ci-owner.json");
    const original = fs.readFileSync(marker, "utf8");
    const owner = JSON.parse(original);
    fs.writeFileSync(marker, JSON.stringify({ ...owner, run: "foreign" }));
    const file = sentinel(context.phases.stable);
    assert.throws(() => releaseBrowserCache(context, "stable"), /another worker/);
    assert.ok(fs.existsSync(file));
    fs.writeFileSync(marker, original);
    fs.renameSync(context.phases.stable, path.join(context.root, "original-stable"));
    const replacement = sentinel(context.phases.stable);
    assert.throws(() => releaseBrowserCache(context, "stable"), /identity changed/);
    assert.ok(fs.existsSync(replacement));
    assert.ok(fs.existsSync(path.join(context.root, "original-stable/sentinel.txt")));
  });

  it("rejects a replaced phase symlink and never follows its foreign target", () => {
    const { root, context } = fixture();
    initializeBrowserCaches(context);
    fs.renameSync(context.phases.stable, path.join(context.root, "original-stable"));
    const target = path.join(root, "foreign");
    const file = sentinel(target);
    fs.symlinkSync(
      target,
      context.phases.stable,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() => releaseBrowserCache(context, "stable"), /noncanonical/);
    assert.equal(fs.readFileSync(file, "utf8"), "retain");
  });

  it("rejects a replacement root even with the original owner and phase directories", () => {
    const { context } = fixture();
    initializeBrowserCaches(context);
    const file = sentinel(context.phases.stable);
    const marker = ".moss-browser-ci-owner.json";
    const owner = fs.readFileSync(path.join(context.root, marker));
    const moved = `${context.root}-original`;
    fs.renameSync(context.root, moved);
    fs.mkdirSync(context.root);
    for (const phase of ["stable", "compiler", "geometry"] as const) {
      fs.renameSync(path.join(moved, phase), context.phases[phase]);
    }
    fs.writeFileSync(path.join(context.root, marker), owner);
    assert.throws(() => releaseBrowserCache(context, "stable"), /identity changed/);
    assert.ok(fs.existsSync(file));
  });

  it("fails below the explicit operational reserve without calling it a measured peak", () => {
    assert.throws(
      () => requireBrowserDiskReserve(BROWSER_PHASE_RESERVE_BYTES - 1n),
      /not a measured peak/,
    );
    requireBrowserDiskReserve(BROWSER_PHASE_RESERVE_BYTES);
  });

  it("orders cache release after successful phases without changing browser coverage contracts", () => {
    const workflow = parse(
      fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const steps = workflow.jobs.browser.steps as Array<{
      name: string;
      if?: string;
      run?: string;
      env?: Record<string, string>;
      "timeout-minutes"?: number;
      "continue-on-error"?: boolean;
    }>;
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    for (const [phase, previous, next] of [
      ["stable", "Browser test (stable)", "Browser test (compiled transcript render scope)"],
      [
        "compiler",
        "Browser test (compiled transcript render scope)",
        "Browser test (Linux geometry quarantine)",
      ],
    ]) {
      const release = steps[index(`Release completed ${phase} browser phase cache`)]!;
      assert.ok(index(previous!) < steps.indexOf(release) && steps.indexOf(release) < index(next!));
      assert.match(release.if!, /success\(\).*github-hosted.*components/);
      assert.equal(release["continue-on-error"], undefined);
      assert.equal(release.run, `node scripts/ci-browser-disk.ts release-${phase}`);
    }
    const geometry = steps[index("Browser test (Linux geometry quarantine)")]!;
    assert.equal(geometry.run, "bun run --cwd apps/web test:browser:geometry");
    assert.equal(geometry["timeout-minutes"], 10);
    assert.equal(geometry["continue-on-error"], true);
    assert.equal(geometry.if, "${{ matrix.project == 'components' && matrix.lane == '1/2' }}");
    for (const [name, phase] of [
      ["Browser test (stable)", "STABLE"],
      ["Browser test (compiled transcript render scope)", "COMPILER"],
      ["Browser test (Linux geometry quarantine)", "GEOMETRY"],
    ]) {
      assert.equal(
        steps[index(name!)]!.env!.MOSS_BROWSER_VITE_CACHE_DIR,
        `\${{ env.MOSS_BROWSER_${phase}_CACHE_DIR }}`,
      );
    }
  });
});
