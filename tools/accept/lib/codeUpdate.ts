// FILE: codeUpdate.ts
// Purpose: The code-update pipeline as one command (lead's decision 2026-11-18, CLOUD-PACKAGING.md
//          §8.5): a main commit in, a smoked code-update package (or "full installer needed") out,
//          with the time of each step. It builds with the fast-refresh caches, packs with
//          moss-code-updates' packer (scripts/build-code-update.ts in the commit itself: it owns the
//          rule, the format and the apply step), applies the package to a COPY of a packaged shell,
//          and smoke-starts that copy in an isolated profile with the self-report tools.
//          It never signs and never uploads. Run it through the heavy lane.
// Layer: tools/accept

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchMoss } from "./launch.ts";
import { assertInside, removeInside } from "./safePath.ts";
import { pageActor, pageCaller, runTour } from "./run.ts";
import { parseTour, type Tour } from "./tour.ts";

export const PACKER = "scripts/build-code-update.ts";
/** Exit codes of the packer (moss-code-updates, 2026-11-18). */
export const PACKER_EXIT = { written: 0, error: 1, fullInstaller: 3, unchanged: 4 } as const;

export interface PipelineOptions {
  readonly commit: string;
  /** A packaged shell folder (Moss.exe + resources/app.asar) built from a commit with boot.js. */
  readonly shellApp: string;
  /** A clean worktree whose node_modules match the commit's bun.lock; checked out detached here. */
  readonly workTree: string;
  /** The checkout whose node_modules the work tree links to (its bun.lock must equal the commit's). */
  readonly dependencySource: string;
  /** The shared checkout (ws profile primaryCheckout); never checked out by the pipeline. */
  readonly sharedCheckout?: string;
  readonly outDir: string;
  readonly cacheDir: string;
  readonly previousResult?: string;
  readonly log?: (line: string) => void;
}

export type StepName = "checkout" | "build" | "copy-shell" | "pack" | "smoke";

export interface PipelineResult {
  readonly commit: string;
  readonly decision: "package" | "full-installer" | "unchanged" | "refused" | "failed";
  readonly reason?: string;
  readonly steps: { name: StepName; ms: number; ok: boolean; detail?: string }[];
  readonly packer?: unknown;
  readonly smoke?: { pass: boolean; problems: unknown[]; dir: string };
  readonly totalMs: number;
  readonly machine: { cpus: number; load?: number; freeMemGB: number };
}

/** A home screen a person sees: it loads, the backend answers, no console error, no layout finding. */
export const SMOKE_TOUR: Tour = parseTour({
  name: "code-update-smoke",
  description: "The new code on the packaged shell: first screen at two sizes",
  steps: [
    { do: "waitFor", selector: "#root > *", timeoutMs: 60_000 },
    { do: "wait", ms: 3000 },
    {
      do: "report",
      label: "home",
      tools: ["console_report", "screen_report", "layout_report", "screenshot"],
      sizes: [
        { width: 1101, height: 782 },
        { width: 1375, height: 886 },
      ],
    },
  ],
});

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 300_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** CPU load in percent when the run starts (measurements on the shared PC record it). */
function cpuLoad(): number | undefined {
  if (process.platform !== "win32") return Math.round((os.loadavg()[0]! / os.cpus().length) * 100);
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  const n = Number.parseFloat(r.stdout ?? "");
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<number> {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, "a");
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", fd, fd],
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      fs.closeSync(fd);
      resolve(code ?? 1);
    });
    child.on("error", () => resolve(1));
  });
}

/** Refuses a checkout of the public mirror: its source is not the product (CLOUD-PACKAGING.md §6). */
export function refuseMirror(remoteUrl: string): string | undefined {
  return /openmoss/i.test(remoteUrl)
    ? `the checkout's origin is the public mirror (${remoteUrl}); code updates are built from the private source`
    : undefined;
}

export const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Why `workTree` must not be checked out here (the pipeline runs `git checkout --detach` in it): the
 * dependency source, the shared checkout, or the main worktree of its repository. Undefined: fine.
 */
export function workTreeRefusal(
  workTree: string,
  dependencySource: string,
  sharedCheckout?: string,
): string | undefined {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p).toLowerCase();
    } catch {
      return path.resolve(p).toLowerCase();
    }
  };
  const wt = real(workTree);
  if (wt === real(dependencySource)) return `${workTree} is the dependency source`;
  if (sharedCheckout && wt === real(sharedCheckout)) return `${workTree} is the shared checkout`;
  const gitDir = git(workTree, "rev-parse", "--absolute-git-dir");
  const common = git(workTree, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (gitDir.code !== 0) return `${workTree} is not a git work tree`;
  if (common.code === 0 && real(gitDir.out) === real(common.out))
    return `${workTree} is the main worktree of its repository; use a worktree of its own`;
  return undefined;
}

export async function runCodeUpdatePipeline(o: PipelineOptions): Promise<PipelineResult> {
  const log = o.log ?? (() => {});
  // Checked before anything is spawned (commands run with shell: true on Windows).
  if (!COMMIT_PATTERN.test(o.commit))
    throw new Error(`--commit must be 7-40 hex digits, not ${JSON.stringify(o.commit)}`);
  const started = Date.now();
  const steps: PipelineResult["steps"] = [];
  fs.mkdirSync(o.outDir, { recursive: true });
  const logFile = path.join(o.outDir, "pipeline.log");
  const load = cpuLoad();
  const machine = {
    cpus: os.cpus().length,
    freeMemGB: Math.round(os.freemem() / 1024 ** 3),
    ...(load === undefined ? {} : { load }),
  };
  const finish = (
    r: Omit<PipelineResult, "steps" | "totalMs" | "machine" | "commit">,
  ): PipelineResult => {
    const result: PipelineResult = {
      commit: o.commit,
      ...r,
      steps,
      totalMs: Date.now() - started,
      machine,
    };
    fs.writeFileSync(path.join(o.outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    log(
      `${result.decision}${result.reason ? `: ${result.reason}` : ""} in ${(result.totalMs / 1000).toFixed(1)} s`,
    );
    return result;
  };
  const step = async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    log(`${name}...`);
    try {
      const value = await fn();
      steps.push({ name, ms: Date.now() - t, ok: true });
      return value;
    } catch (error) {
      steps.push({
        name,
        ms: Date.now() - t,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  // 1. Checkout, with the refusals that keep the build honest.
  try {
    await step("checkout", async () => {
      const refusal = workTreeRefusal(o.workTree, o.dependencySource, o.sharedCheckout);
      if (refusal) throw new Error(refusal);
      const origin = git(o.workTree, "remote", "get-url", "origin").out;
      const mirror = refuseMirror(origin);
      if (mirror) throw new Error(mirror);
      if (git(o.workTree, "status", "--porcelain", "--untracked-files=no").out)
        throw new Error(`${o.workTree} has uncommitted changes`);
      if (git(o.workTree, "cat-file", "-e", `${o.commit}^{commit}`).code !== 0)
        git(o.workTree, "fetch", "-q", "origin");
      const co = git(o.workTree, "checkout", "-q", "--detach", o.commit);
      if (co.code !== 0) throw new Error(`checkout failed: ${co.out}`);
      const lock = (dir: string) => sha256File(path.join(dir, "bun.lock"));
      if (lock(o.workTree) !== lock(o.dependencySource))
        throw new Error(
          `the commit's bun.lock differs from ${o.dependencySource}'s, whose node_modules the work tree uses; relink first`,
        );
      if (!fs.existsSync(path.join(o.workTree, PACKER)))
        throw new Error(
          `${PACKER} is not in this commit (code updates start with moss-code-updates' merge)`,
        );
    });
  } catch (error) {
    return finish({
      decision: "refused",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // 2. Build: the installer's build:desktop, forced, with the fast-refresh codec and compiler caches.
    await step("build", async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TURBO_CONCURRENCY: "4",
        MOSS_WEB_PRECOMPRESS_CACHE: path.join(o.cacheDir, "precompress"),
        MOSS_WEB_TRANSFORM_CACHE: path.join(o.cacheDir, "transform"),
      };
      const code = await run(
        "bun",
        ["run", "build:desktop", "--cache=local:,remote:"],
        o.workTree,
        env,
        logFile,
      );
      if (code !== 0) throw new Error(`build:desktop exited ${code} (see pipeline.log)`);
    });

    // 3. A private copy of the packaged shell: the packer applies the package to it, never to an install.
    const appCopy = path.join(o.outDir, "app");
    await step("copy-shell", async () => {
      removeInside(o.outDir, appCopy);
      assertInside(o.outDir, appCopy);
      fs.cpSync(o.shellApp, appCopy, { recursive: true, verbatimSymlinks: true });
    });

    // 4. Pack, decide, apply.
    const packOut = path.join(o.outDir, "pack");
    const exit = await step("pack", async () => {
      const args = [
        PACKER,
        "--repo",
        o.workTree,
        "--out",
        packOut,
        "--base-archive",
        o.shellApp,
        "--apply-to",
        appCopy,
        ...(o.previousResult ? ["--previous-result", o.previousResult] : []),
      ];
      const code = await run("bun", args, o.workTree, process.env, logFile);
      if (
        code !== PACKER_EXIT.written &&
        code !== PACKER_EXIT.fullInstaller &&
        code !== PACKER_EXIT.unchanged
      )
        throw new Error(`the packer exited ${code} (see pipeline.log)`);
      return code;
    });
    const packerResultFile = path.join(packOut, "result.json");
    const packer = fs.existsSync(packerResultFile)
      ? JSON.parse(fs.readFileSync(packerResultFile, "utf8"))
      : undefined;
    if (exit === PACKER_EXIT.fullInstaller)
      return finish({
        decision: "full-installer",
        reason: "the packer's rule refused a code update",
        packer,
      });
    if (exit === PACKER_EXIT.unchanged)
      return finish({ decision: "unchanged", reason: "same code as the previous result", packer });

    // 5. Smoke: the patched copy, isolated profile, self-report tools.
    const smokeDir = path.join(o.outDir, "smoke");
    const smoke = await step("smoke", async () => {
      const exe = path.join(appCopy, process.platform === "win32" ? "Moss.exe" : "Moss");
      const moss = await launchMoss({ app: exe, runDir: smokeDir, log });
      try {
        const r = await runTour(SMOKE_TOUR, {
          call: pageCaller(moss.page),
          actor: pageActor(moss.page),
          guard: moss.assertOffScreen,
          outDir: smokeDir,
          runId: `code-update-${o.commit.slice(0, 12)}`,
          log,
        });
        return { pass: r.pass, problems: r.problems, dir: smokeDir };
      } finally {
        await moss.close();
        try {
          removeInside(o.outDir, moss.profileRoot);
        } catch (error) {
          log(`could not remove the smoke profile: ${String(error).split("\n")[0]}`);
        }
      }
    });
    return finish({
      decision: smoke.pass ? "package" : "failed",
      ...(smoke.pass ? {} : { reason: "the smoke failed" }),
      packer,
      smoke,
    });
  } catch (error) {
    return finish({
      decision: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
