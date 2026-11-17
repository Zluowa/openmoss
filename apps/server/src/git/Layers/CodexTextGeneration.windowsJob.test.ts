// FILE: CodexTextGeneration.windowsJob.test.ts
// Purpose: The isolated `codex exec` route on Windows, end to end through the real layer:
//          it runs, and nothing it starts outlives it.
// Layer: Git text generation, Windows integration test (real processes)
// Why: auxiliary Codex generation was refused on Windows because a CLI's descendants
//      could not be contained. moss-job-launch.exe now runs the CLI in a kill-on-close Job
//      Object; without a working launcher Windows is refused exactly as before.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Clock, Duration, Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  developmentWindowsJobLauncherPath,
  resetWindowsJobLauncherStatusForTest,
} from "../../platform/windowsKillOnCloseJob.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive, makeCodexTextGenerationLive } from "./CodexTextGeneration.ts";

// CI builds moss-job-launch.exe before this suite; a Windows developer without the pinned
// LLVM skips it here.
const runOnWindows =
  process.platform === "win32" &&
  (existsSync(developmentWindowsJobLauncherPath()) || process.env.CI === "true");

/** Real time: the request's own timeout must fire, which the test clock never lets it. */
// Moved forward by a test to expire a remembered version check; sleeping stays real.
let clockOffsetMs = 0;
const realClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now() + clockOffsetMs,
  currentTimeMillis: Effect.sync(() => Date.now() + clockOffsetMs),
  currentTimeNanosUnsafe: () => process.hrtime.bigint(),
  currentTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  sleep: (duration) =>
    Effect.callback<void>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
      return Effect.sync(() => clearTimeout(timer));
    }),
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const survivorsAfter = (pids: ReadonlyArray<number>, ms: number) =>
  Effect.promise(async () => {
    const until = Date.now() + ms;
    let survivors = pids.filter(alive);
    while (survivors.length > 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      survivors = survivors.filter(alive);
    }
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    return survivors;
  });

/**
 * An npm-style `codex.cmd` shim over a Node script. `exec` reads the prompt from stdin,
 * starts a grandchild that is left running (detached, as a tool a CLI starts would be),
 * records the pids, and either answers through `--output-last-message` or hangs.
 */
function writeFakeCodex(root: string, mode: "answer" | "hang") {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = path.join(root, "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    const pidsPath = path.join(root, "pids.json");
    const probesPath = path.join(root, "version-probes.log");
    const script = path.join(bin, "fake-codex.js");
    yield* fs.writeFileString(
      script,
      `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { fs.appendFileSync(${JSON.stringify(probesPath)}, "probe\\n"); process.stdout.write("codex-cli 0.166.0\\n"); process.exit(0); }
const output = args[args.indexOf("--output-last-message") + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: true });
  grandchild.unref();
  fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ codex: process.pid, grandchild: grandchild.pid, promptChars: prompt.length }));
  if (${JSON.stringify(mode)} === "hang") { setInterval(() => {}, 1000); return; }
  fs.writeFileSync(output, JSON.stringify({ title: "Fix the flaky build" }));
  process.exit(0);
});
`,
    );
    const shim = path.join(bin, "codex.cmd");
    yield* fs.writeFileString(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    return { shim, pidsPath, probesPath };
  });
}

const readPids = (pidsPath: string): ReadonlyArray<number> => {
  if (!existsSync(pidsPath)) return [];
  const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as Record<string, number>;
  return [pids.codex!, pids.grandchild!];
};

const layer = (live: typeof CodexTextGenerationLive) =>
  live.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "moss-codex-win-job-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const titleRequest = (root: string, shim: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = path.join(root, "project");
    const home = path.join(root, "account");
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* fs.makeDirectory(home, { recursive: true });
    // A person's own account: no direct endpoint with a key, so the CLI must run.
    yield* fs.writeFileString(path.join(home, "config.toml"), 'model = "gpt-6-astra"\n');
    const service = yield* TextGeneration;
    return yield* service
      .generateThreadTitle({
        cwd,
        message: "the build fails on Windows, fix it",
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-6-astra" },
        providerOptions: { codex: { homePath: home, binaryPath: shim } },
      })
      .pipe(Effect.result);
  });

it.layer(layer(CodexTextGenerationLive))("isolated Codex on Windows", (it) => {
  it.effect.runIf(runOnWindows)(
    "titles a chat through the CLI and ends what the CLI left running",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "moss-codex-win-job-" });
        const { shim, pidsPath, probesPath } = yield* writeFakeCodex(root, "answer");
        const result = yield* titleRequest(root, shim);
        expect(result._tag === "Success" ? result.success.title : String(result)).toBe(
          "Fix the flaky build",
        );
        const pids = readPids(pidsPath);
        expect(pids).toHaveLength(2);
        expect(yield* survivorsAfter(pids, 3_000)).toEqual([]);
        // The version probe ran once, and is remembered for the same binary.
        const second = yield* titleRequest(root, shim);
        expect(second._tag).toBe("Success");
        expect(readFileSync(probesPath, "utf8").trim().split("\n")).toEqual(["probe"]);
        // A changed binary is probed again.
        appendFileSync(shim, "@rem changed\r\n");
        yield* titleRequest(root, shim);
        expect(readFileSync(probesPath, "utf8").trim().split("\n")).toEqual(["probe", "probe"]);
        // This shim is not an npm shim leading to a real codex.exe, so its target could change
        // behind it: the check expires after ten minutes.
        clockOffsetMs = 11 * 60_000;
        yield* titleRequest(root, shim);
        clockOffsetMs = 0;
        expect(readFileSync(probesPath, "utf8").trim().split("\n")).toEqual([
          "probe",
          "probe",
          "probe",
        ]);
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, realClock)),
    90_000,
  );

  it.effect.runIf(process.platform === "win32")(
    "refuses as before, and keeps refusing without spawning, once the launcher fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "moss-codex-win-job-" });
        const { shim, pidsPath, probesPath } = yield* writeFakeCodex(root, "answer");
        // Present but not a program: Windows will not start it (as when policy blocks it).
        const broken = path.join(root, "moss-job-launch.exe");
        yield* fs.writeFileString(broken, "not a program");
        resetWindowsJobLauncherStatusForTest(broken);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = yield* titleRequest(root, shim);
          expect(result._tag).toBe("Failure");
          expect(result._tag === "Failure" ? result.failure.detail : "").toMatch(
            /Windows.*descendant process containment.*fallback/i,
          );
        }
        expect(existsSync(probesPath)).toBe(false);
        expect(existsSync(pidsPath)).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.sync(() => resetWindowsJobLauncherStatusForTest())),
        Effect.provideService(Clock.Clock, realClock),
      ),
    60_000,
  );
});

it.layer(
  layer(
    makeCodexTextGenerationLive({
      // Long enough for the version check and the fake CLI to start through cmd.exe and Node
      // (two Node starts) on a loaded machine: the test is about what happens on timeout.
      requestTimeoutMs: 20_000,
      killGraceMs: 200,
      outputDrainMs: 100,
      finalOutputDrainMs: 200,
    }),
  ),
)("isolated Codex on Windows, on timeout", (it) => {
  it.effect.runIf(runOnWindows)(
    "ends the CLI and everything it started when the request times out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "moss-codex-win-job-" });
        const { shim, pidsPath } = yield* writeFakeCodex(root, "hang");
        const result = yield* titleRequest(root, shim);
        expect(result._tag).toBe("Failure");
        const pids = readPids(pidsPath);
        expect(pids).toHaveLength(2);
        expect(yield* survivorsAfter(pids, 3_000)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, realClock)),
    60_000,
  );
});
