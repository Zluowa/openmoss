// FILE: windowsKillOnCloseJob.test.ts
// Purpose: What moss-job-launch.exe does to real process trees on Windows, and what Moss does
//          when the launcher is missing or fails. Builds on the launcher built by
//          apps/server/scripts/build-windows-job-launcher.mjs (CI builds it first).
// Layer: Server Windows platform runtime (real processes on Windows; status logic everywhere)

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Scope, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { makeEffectProcessCommand } from "./effectProcessRuntime.ts";
import {
  developmentWindowsJobLauncherPath,
  isWindowsJobLauncherFailureExitCode,
  markWindowsJobLauncherFailed,
  quoteWindowsArgument,
  resetWindowsJobLauncherStatusForTest,
  runWindowsJobLauncherSelfTest,
  WINDOWS_JOB_LAUNCHER_SHA256,
  WINDOWS_JOB_LAUNCHER_EXIT_CODES,
  windowsJobLauncherEnv,
  windowsJobLauncherSpawner,
  windowsJobLauncherStatus,
} from "./windowsKillOnCloseJob.ts";

/** How CommandLineToArgvW / the MSVC runtime split a command line back into arguments. */
function parseWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\") {
      let count = 0;
      while (line[index] === "\\") {
        count += 1;
        index += 1;
      }
      if (line[index] === '"') {
        current += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else inQuotes = !inQuotes;
      } else {
        current += "\\".repeat(count);
        index -= 1;
      }
      started = true;
    } else if (character === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (/\s/u.test(character) && !inQuotes) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

const TRICKY = [
  "",
  "plain",
  "two words",
  'model_reasoning_effort="low"',
  "C:\\Program Files\\Moss\\",
  'a\\"b',
  "trailing\\\\",
  "中文 参数",
  "-",
];

describe("quoteWindowsArgument", () => {
  it.each(TRICKY)("round-trips %j through the Windows parser", (argument) => {
    expect(parseWindowsCommandLine(`app ${quoteWindowsArgument(argument)}`)).toEqual([
      "app",
      argument,
    ]);
  });
});

describe("the launcher's exit codes", () => {
  it("count as the launcher's own failure except when the program could not be started", () => {
    for (const [name, code] of Object.entries(WINDOWS_JOB_LAUNCHER_EXIT_CODES)) {
      expect(isWindowsJobLauncherFailureExitCode(code), name).toBe(name !== "createProcess");
    }
    for (const code of [
      0,
      1,
      2,
      7,
      255,
      -1,
      0xc0000005,
      WINDOWS_JOB_LAUNCHER_EXIT_CODES.input - 1,
    ]) {
      expect(isWindowsJobLauncherFailureExitCode(code)).toBe(false);
    }
  });
});

describe("whether the launcher can be used", () => {
  afterEach(() => resetWindowsJobLauncherStatusForTest());

  it.runIf(process.platform !== "win32")(
    "never on other platforms (POSIX keeps its process group)",
    async () => {
      resetWindowsJobLauncherStatusForTest(process.execPath);
      expect(await Effect.runPromise(windowsJobLauncherStatus)).toEqual({
        kind: "unavailable",
        reason: "not Windows",
      });
    },
  );

  it.runIf(process.platform === "win32")("not when the file is missing", async () => {
    const missing = join(tmpdir(), "moss-job-launch-missing", "moss-job-launch.exe");
    resetWindowsJobLauncherStatusForTest(missing);
    expect(await Effect.runPromise(windowsJobLauncherStatus)).toEqual({
      kind: "unavailable",
      reason: `${missing} is missing`,
    });
  });

  it.runIf(process.platform === "win32")(
    "no longer, for the rest of the backend's life, once it has failed (one log line)",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "moss-job-status-"));
      try {
        const launcher = join(directory, "moss-job-launch.exe");
        writeFileSync(launcher, "");
        resetWindowsJobLauncherStatusForTest(launcher, { skipChecks: true });
        expect(await Effect.runPromise(windowsJobLauncherStatus)).toEqual({
          kind: "available",
          path: launcher,
        });
        // The first failure is kept (and is the only one logged); later ones change nothing.
        await Effect.runPromise(markWindowsJobLauncherFailed("first"));
        await Effect.runPromise(markWindowsJobLauncherFailed("second"));
        expect(await Effect.runPromise(windowsJobLauncherStatus)).toEqual({
          kind: "unavailable",
          reason: "first",
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LAUNCHER = developmentWindowsJobLauncherPath();
// CI builds the launcher before this suite; a Windows developer without the pinned LLVM
// skips the real-process part here.
const launcherReady = existsSync(LAUNCHER) || process.env.CI === "true";

// Real processes on Windows: the claim is about what Windows does to a process tree.
describe.runIf(process.platform === "win32" && launcherReady)(
  "moss-job-launch.exe on Windows",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-job-test-"));
    const started: ChildProcess[] = [];
    // Children are ended through their Node handles only, never by a pid kept after its process
    // ended: Windows gives a freed pid to the next process it starts, which in the CI step can be
    // the Codex CLI that CodexTextGeneration.windowsJob.test.ts runs beside this file.
    afterAll(() => {
      for (const child of started) child.kill();
      rmSync(directory, { recursive: true, force: true });
    });

    // A stand-in for `codex exec`: echoes stdin, starts a grandchild that starts a
    // great-grandchild (through Node, so through libuv's own job) and a detached
    // grandchild, and records every pid.
    const TREE = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const [statePath, mode] = process.argv.slice(1);
      const grandchild = spawn(process.execPath, ["-e", "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); process.stdout.write(String(g.pid)); setTimeout(() => {}, 120000);"], { stdio: ["ignore", "pipe", "ignore"] });
      const detached = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: true });
      detached.unref();
      let great = "", input = "";
      grandchild.stdout.on("data", (chunk) => (great += chunk));
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const ready = () => {
          if (!great) return setTimeout(ready, 20);
          writeFileSync(statePath, JSON.stringify({ child: process.pid, grandchild: grandchild.pid, great: Number(great), detached: detached.pid }));
          process.stdout.write("echo:" + input);
          if (mode === "exit") { grandchild.unref(); grandchild.stdout.destroy(); process.exit(7); }
        };
        ready();
      });
      setTimeout(() => {}, 120000);
    `;

    const launchEnv = (args: ReadonlyArray<string>) =>
      windowsJobLauncherEnv({ command: process.execPath, args });

    const startLauncher = (env: Readonly<Record<string, string>>) => {
      const child = spawn(LAUNCHER, [], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      started.push(child);
      return child;
    };

    const readState = async (statePath: string) => {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        if (existsSync(statePath)) {
          try {
            return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>;
          } catch {}
        }
        await sleep(25);
      }
      throw new Error("the process tree never started");
    };
    /** The pids still alive after `ms`. */
    const survivorsAfter = async (state: Record<string, number>, ms: number) => {
      const until = Date.now() + ms;
      let survivors = Object.values(state).filter(alive);
      while (survivors.length > 0 && Date.now() < until) {
        await sleep(25);
        survivors = survivors.filter(alive);
      }
      return survivors;
    };
    const output = (child: ChildProcess) => {
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk) => (stdout += chunk));
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      return {
        exit: new Promise<number | null>((resolve) => child.once("exit", resolve)),
        get stdout() {
          return stdout;
        },
        get stderr() {
          return stderr;
        },
      };
    };

    it("passes arguments, stdin, stdout and the exit code through unchanged", async () => {
      const child = startLauncher(
        launchEnv([
          "-e",
          "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:s,env:[process.env.MOSS_JOB_APP,process.env.MOSS_JOB_CMDLINE]}));process.exit(3)})",
          ...TRICKY,
        ]),
      );
      const result = output(child);
      child.stdin!.end("提示词 prompt\n");
      expect(await result.exit).toBe(3);
      expect(result.stderr).toBe("");
      // The program never sees the launcher's own variables.
      expect(JSON.parse(result.stdout)).toEqual({
        argv: TRICKY,
        stdin: "提示词 prompt\n",
        env: [null, null],
      });
    }, 30_000);

    it("ends every descendant when the program exits and leaves them behind", async () => {
      const statePath = join(directory, "exit.json");
      const child = startLauncher(launchEnv(["-e", TREE, statePath, "exit"]));
      const result = output(child);
      child.stdin!.end("hello");
      expect(await result.exit).toBe(7);
      expect(result.stdout).toBe("echo:hello");
      expect(await survivorsAfter(await readState(statePath), 3_000)).toEqual([]);
    }, 40_000);

    it("ends every descendant when Moss stops the launcher (timeout or abort)", async () => {
      const statePath = join(directory, "kill.json");
      const child = startLauncher(launchEnv(["-e", TREE, statePath, "stay"]));
      child.stdin!.end("x");
      const state = await readState(statePath);
      child.kill();
      expect(await survivorsAfter({ ...state, launcher: child.pid! }, 3_000)).toEqual([]);
    }, 40_000);

    const backendScript = (env: Readonly<Record<string, string>>) => `
      const { spawn } = require("node:child_process");
      const child = spawn(${JSON.stringify(LAUNCHER)}, [], { env: { ...process.env, ...${JSON.stringify(env)} }, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.stdin.end("x");
      process.stdout.write(String(child.pid) + "\\n");
      process.stdin.on("data", () => { child.kill(); child.once("exit", () => process.stdout.write("stopped\\n")); });
      setTimeout(() => {}, 120000);`;

    it("ends every descendant when the backend that started it is killed", async () => {
      const statePath = join(directory, "backend.json");
      const backend = spawn(
        process.execPath,
        ["-e", backendScript(launchEnv(["-e", TREE, statePath, "stay"]))],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      started.push(backend);
      let launcherPid = "";
      backend.stdout!.on("data", (chunk) => (launcherPid += chunk));
      const state = await readState(statePath);
      backend.kill("SIGKILL");
      expect(
        await survivorsAfter({ ...state, launcher: Number.parseInt(launcherPid, 10) }, 3_000),
      ).toEqual([]);
    }, 40_000);

    // A backend that itself runs inside a job (a terminal, a service host, a CI runner): the
    // launcher's job nests inside it, and stopping the launcher ends only its own tree.
    it("works nested inside an outer job, and stops only its own tree", async () => {
      const statePath = join(directory, "nested.json");
      const outer = startLauncher(
        launchEnv(["-e", backendScript(launchEnv(["-e", TREE, statePath, "stay"]))]),
      );
      let lines = "";
      outer.stdout!.on("data", (chunk) => (lines += chunk));
      const state = await readState(statePath);
      const innerLauncher = Number.parseInt(lines, 10);
      // The backend stops its own launcher: the tree goes, the backend stays.
      outer.stdin!.write("stop\n");
      expect(await survivorsAfter({ ...state, launcher: innerLauncher }, 3_000)).toEqual([]);
      const until = Date.now() + 5_000;
      while (!lines.includes("stopped") && Date.now() < until) await sleep(25);
      expect(lines).toContain("stopped");
      expect(outer.exitCode).toBeNull();
      outer.kill();
    }, 40_000);

    it("reports its own failures in its own code range, in UTF-8", async () => {
      const missingInput = spawn(LAUNCHER, [], {
        env: { ...process.env, MOSS_JOB_CMDLINE: "" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const input = output(missingInput);
      expect(await input.exit).toBe(WINDOWS_JOB_LAUNCHER_EXIT_CODES.input);
      // An empty value: ERROR_INVALID_DATA, not whatever a later lookup left behind.
      expect(input.stderr).toBe(
        "moss-job-launch: reading MOSS_JOB_CMDLINE failed (Windows error 13)\n",
      );
      const { MOSS_JOB_CMDLINE: _unset, ...withoutCommandLine } = process.env;
      const absent = spawn(LAUNCHER, [], {
        env: withoutCommandLine,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const missing = output(absent);
      expect(await missing.exit).toBe(WINDOWS_JOB_LAUNCHER_EXIT_CODES.input);
      // ERROR_ENVVAR_NOT_FOUND.
      expect(missing.stderr).toBe(
        "moss-job-launch: reading MOSS_JOB_CMDLINE failed (Windows error 203)\n",
      );

      // A program that cannot be started is the program's failure, not the launcher's.
      const missingProgram = startLauncher(
        windowsJobLauncherEnv({ command: join(directory, "no-such-program.exe"), args: [] }),
      );
      const program = output(missingProgram);
      missingProgram.stdin!.end();
      const code = await program.exit;
      expect(code).toBe(WINDOWS_JOB_LAUNCHER_EXIT_CODES.createProcess);
      expect(isWindowsJobLauncherFailureExitCode(code!)).toBe(false);
      expect(program.stderr).toBe("moss-job-launch: CreateProcess failed (Windows error 2)\n");
    }, 30_000);

    // Why the launcher exists: a detached spawn leaves part of the tree running.
    it("control: without the job a killed program leaves descendants running", async () => {
      const statePath = join(directory, "control.json");
      const child = spawn(process.execPath, ["-e", TREE, statePath, "stay"], {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
        windowsHide: true,
      });
      started.push(child);
      child.stdin!.end("x");
      const state = await readState(statePath);
      child.kill();
      expect((await survivorsAfter(state, 1_500)).length).toBeGreaterThan(0);
      // Of this tree only the detached grandchild outlives the killed program, and nothing else
      // ends it (it sleeps for 120 s), so while it is alive its pid is still its own.
      if (alive(state.detached!)) process.kill(state.detached!, "SIGKILL");
    }, 40_000);

    describe("settling once per backend whether the launcher is usable", () => {
      afterEach(() => resetWindowsJobLauncherStatusForTest());

      it("accepts the pinned launcher that runs a program inside a job here", async () => {
        expect(createHash("sha256").update(readFileSync(LAUNCHER)).digest("hex")).toBe(
          WINDOWS_JOB_LAUNCHER_SHA256,
        );
        resetWindowsJobLauncherStatusForTest(LAUNCHER);
        expect(await Effect.runPromise(windowsJobLauncherStatus)).toEqual({
          kind: "available",
          path: LAUNCHER,
        });
      }, 30_000);

      it("refuses a launcher whose bytes are not the pinned ones, without running it", async () => {
        const changed = join(directory, "moss-job-launch-changed.exe");
        const bytes = readFileSync(LAUNCHER);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        writeFileSync(changed, bytes);
        resetWindowsJobLauncherStatusForTest(changed);
        const status = await Effect.runPromise(windowsJobLauncherStatus);
        expect(status.kind).toBe("unavailable");
        expect(status.kind === "unavailable" ? status.reason : "").toContain("not the pinned");
      });

      it("fails the self-test for a program that does not pass the exit code through", async () => {
        // Stands in for a launcher that cannot create its job here: anything but 7 back.
        const failure = await runWindowsJobLauncherSelfTest(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
        );
        expect(failure).toBe("self-test exited with 0x0");
        expect(await runWindowsJobLauncherSelfTest(LAUNCHER)).toBeNull();
      }, 30_000);
    });

    describe("windowsJobLauncherSpawner", () => {
      afterEach(() => resetWindowsJobLauncherStatusForTest());

      const command = (args: ReadonlyArray<string>, stdin?: string) =>
        makeEffectProcessCommand(process.execPath, args, {
          env: process.env as Record<string, string>,
          windowsJobLauncher: LAUNCHER,
          ...(stdin === undefined
            ? { stdin: "ignore" as const }
            : { stdin: { stream: Stream.make(new TextEncoder().encode(stdin)) } }),
        });
      const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
        stream.pipe(Stream.decodeText(), Stream.mkString);

      it("runs the program through the launcher with stdin, stdout and the exit code", async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* windowsJobLauncherSpawner.spawn(
                command(
                  [
                    "-e",
                    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('got:'+s);process.exit(5)})",
                  ],
                  "提示词",
                ),
              );
              const [stdout, exitCode] = yield* Effect.all([text(child.stdout), child.exitCode], {
                concurrency: "unbounded",
              });
              return { stdout, exitCode: Number(exitCode) };
            }),
          ),
        );
        expect(result).toEqual({ stdout: "got:提示词", exitCode: 5 });
      }, 30_000);

      it("stops the tree through the handle, and does nothing once the launcher has exited", async () => {
        const statePath = join(directory, "spawner.json");
        const scope = Effect.runSync(Scope.make());
        const child = await Effect.runPromise(
          windowsJobLauncherSpawner
            .spawn(command(["-e", TREE, statePath, "stay"], "x"))
            .pipe(Scope.provide(scope)),
        );
        const state = await readState(statePath);
        await Effect.runPromise(child.kill());
        expect(await survivorsAfter({ ...state, launcher: Number(child.pid) }, 3_000)).toEqual([]);
        expect(await Effect.runPromise(child.isRunning)).toBe(false);
        // Exit known: a second stop signals nothing (no PID is ever used).
        await Effect.runPromise(child.kill());
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }, 40_000);

      it("records a launcher that will not start", async () => {
        const notAProgram = join(directory, "moss-job-launch-broken.exe");
        writeFileSync(notAProgram, "not a program");
        resetWindowsJobLauncherStatusForTest(notAProgram);
        const broken = makeEffectProcessCommand(process.execPath, ["-e", "0"], {
          env: process.env as Record<string, string>,
          windowsJobLauncher: notAProgram,
          stdin: "ignore",
        });
        const exit = await Effect.runPromiseExit(
          Effect.scoped(windowsJobLauncherSpawner.spawn(broken)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect((await Effect.runPromise(windowsJobLauncherStatus)).kind).toBe("unavailable");
      }, 30_000);
    });
  },
);
