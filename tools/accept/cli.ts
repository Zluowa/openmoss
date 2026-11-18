// FILE: cli.ts
// Purpose: `bun run accept run --app <packaged Moss> --tour <name|file>`: launch the build in an
//          isolated profile, walk the tour with Moss's own self-report tools, write every answer,
//          screenshot and the verdict to a run folder, exit 0 on pass and 1 on fail.
// Layer: tools/accept

import fs from "node:fs";
import path from "node:path";

import { loadProfile } from "../ws/lib/profile.ts";
import { runCodeUpdatePipeline } from "./lib/codeUpdate.ts";
import { removeInside } from "./lib/safePath.ts";
import { launchMoss } from "./lib/launch.ts";
import { pageActor, pageCaller, runTour } from "./lib/run.ts";
import { parseTour, TourError } from "./lib/tour.ts";

const TOURS_DIR = path.join(import.meta.dirname, "tours");

/** The ws profile's shared checkout, which the pipeline never checks out. */
function sharedCheckout(): string | undefined {
  try {
    return loadProfile().primaryCheckout;
  } catch {
    return undefined;
  }
}

/** The ws profile (~/.moss-ws/profile.json or MOSS_WS_PROFILE): every default folder comes from it. */
function profile(): ReturnType<typeof loadProfile> | undefined {
  try {
    return loadProfile();
  } catch {
    return undefined;
  }
}

/** A default from the ws profile, or a clear refusal naming the flag to pass instead. */
function fromProfile(
  flagName: string,
  pick: (p: ReturnType<typeof loadProfile>) => string,
): string {
  const p = profile();
  if (!p) {
    console.error(
      `accept: no ws profile (MOSS_WS_PROFILE or ~/.moss-ws/profile.json); pass --${flagName}`,
    );
    process.exit(2);
  }
  return pick(p);
}

/** Run folders go to the ws profile's scratch root (D: on the shared PC), never to C:'s TEMP. */
function scratchRoot(): string {
  return fromProfile("out", (p) => p.scratchRoot);
}

function usage(): never {
  console.error(
    [
      "usage: accept run --app <Moss.exe or the app binary> --tour <name|file.json> [--out <dir>] [--on-screen] [--keep-profile]",
      "       accept tours",
      "       accept code-update --commit <sha> --shell-app <packaged shell folder with boot.js> [--work-tree <dir>] [--out <dir>] [--previous-result <file>]",
      "         build, pack (scripts/build-code-update.ts), apply to a copy of the shell and smoke it; never signs or uploads.",
      "         Exit: 0 package (or unchanged), 4 full installer needed, 1 refused or failed. Run it through `ws lane`.",
      "The app starts in its own profile under the run folder (never the owner's), with MOSS_SELF_REPORT=1;",
      "its window is moved off-screen unless --on-screen is given. Exit: 0 pass, 1 fail, 2 usage, 3 could not start.",
    ].join("\n"),
  );
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function tourPath(value: string): string {
  if (value.endsWith(".json")) return path.resolve(value);
  return path.join(TOURS_DIR, `${value}.json`);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "tours") {
    for (const file of fs
      .readdirSync(TOURS_DIR)
      .filter((f) => f.endsWith(".json"))
      .toSorted()) {
      const tour = parseTour(JSON.parse(fs.readFileSync(path.join(TOURS_DIR, file), "utf8")));
      console.log(`${tour.name.padEnd(20)} ${tour.description ?? ""}`);
    }
    return 0;
  }
  if (command === "code-update") {
    const commit = flag(argv, "commit");
    const shellApp = flag(argv, "shell-app");
    if (!commit || !shellApp) usage();
    const workTree = path.resolve(
      flag(argv, "work-tree") ??
        fromProfile("work-tree", (p) => path.join(p.worktreeRoot, "code-update-build")),
    );
    const result = await runCodeUpdatePipeline({
      commit,
      shellApp: path.resolve(shellApp),
      workTree,
      dependencySource: path.resolve(
        flag(argv, "dependency-source") ??
          fromProfile("dependency-source", (p) => p.dependencySource),
      ),
      ...(sharedCheckout() ? { sharedCheckout: sharedCheckout()! } : {}),
      outDir: path.resolve(
        flag(argv, "out") ?? path.join(scratchRoot(), "code-updates", commit.slice(0, 12)),
      ),
      cacheDir: path.resolve(
        flag(argv, "cache-dir") ?? path.join(scratchRoot(), "code-updates", "cache"),
      ),
      ...(flag(argv, "previous-result")
        ? { previousResult: path.resolve(flag(argv, "previous-result")!) }
        : {}),
      log: (line) => console.log(`[code-update] ${line}`),
    });
    for (const s of result.steps)
      console.log(
        `[code-update]   ${s.name.padEnd(10)} ${(s.ms / 1000).toFixed(1).padStart(7)} s ${s.ok ? "ok" : `FAILED ${s.detail ?? ""}`}`,
      );
    return result.decision === "package" || result.decision === "unchanged"
      ? 0
      : result.decision === "full-installer"
        ? 4
        : 1;
  }
  if (command !== "run") usage();
  const app = flag(argv, "app");
  const tourArg = flag(argv, "tour");
  if (!app || !tourArg) usage();
  let tour;
  try {
    tour = parseTour(JSON.parse(fs.readFileSync(tourPath(tourArg), "utf8")));
  } catch (error) {
    console.error(error instanceof TourError ? `tour: ${error.message}` : String(error));
    return 2;
  }
  const runId = `${tour.name}-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}-${process.pid}`;
  const outDir = path.resolve(flag(argv, "out") ?? path.join(scratchRoot(), "accept-runs", runId));
  fs.mkdirSync(outDir, { recursive: true });
  const log = (line: string) => console.log(`[accept] ${line}`);
  log(`run ${runId} -> ${outDir}`);
  let moss;
  try {
    moss = await launchMoss({
      app: path.resolve(app),
      runDir: outDir,
      onScreen: argv.includes("--on-screen"),
      log,
    });
  } catch (error) {
    console.error(
      `[accept] could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 3;
  }
  try {
    const result = await runTour(tour, {
      call: pageCaller(moss.page),
      actor: pageActor(moss.page),
      guard: moss.assertOffScreen,
      outDir,
      runId,
      log,
    });
    log(`${result.pass ? "PASS" : "FAIL"} ${tour.name} in ${(result.ms / 1000).toFixed(1)} s`);
    for (const p of result.problems) log(`  ${p.kind} at "${p.step}": ${p.detail}`);
    log(`answers and screenshots: ${outDir}`);
    return result.pass ? 0 : 1;
  } finally {
    await moss.close();
    if (!argv.includes("--keep-profile")) {
      try {
        removeInside(outDir, moss.profileRoot);
      } catch (error) {
        // Cleanup never changes the verdict.
        log(
          `could not remove the profile (${String(error).split("\n")[0]}); left at ${moss.profileRoot}`,
        );
      }
    }
  }
}

// A run that has not ended after this long is stuck: it must give the heavy lane back.
const HARD_LIMIT_MS = Number(process.env.MOSS_ACCEPT_HARD_LIMIT_MS ?? 30 * 60_000);
setTimeout(() => {
  console.error(`[accept] still running after ${HARD_LIMIT_MS / 60_000} min; stopping (exit 5)`);
  process.exit(5);
}, HARD_LIMIT_MS).unref();

process.exit(await main(process.argv.slice(2)));
