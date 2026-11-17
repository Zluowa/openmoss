// FILE: windowsKillOnCloseJob.ts
// Purpose: Runs one program on Windows inside its own kill-on-close Job Object, through the
//          native launcher `moss-job-launch.exe`, so every process it starts, at any depth,
//          ends when it ends or when Moss stops it.
// Layer: Server Windows platform runtime
//
// POSIX contains a CLI and everything it starts in a process group. Windows has no such
// group, and libuv's own kill-on-close job sets JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, so it
// holds direct children only: a grandchild outlives the backend.
//
// The launcher (apps/server/native/moss-job-launch) is started as this backend's direct,
// non-detached child, so it lives in libuv's job and dies with the backend. It creates the
// program already inside a new job (PROC_THREAD_ATTRIBUTE_JOB_LIST: no suspended start, no
// gap) and holds that job's only handle: when the launcher exits for any reason the job
// closes and Windows ends the whole tree. The program inherits the launcher's standard
// handles (the backend's pipes) and its exit code becomes the launcher's.
//
// Moss stops the launcher only through Node's own process handle (TerminateProcess on the
// handle libuv holds), and only while that handle is open: never by PID, never `taskkill
// /T`, never after the exit code is known. A PID can be reused once the handle closes.
//
// Whether the launcher can be used is settled once per backend: the file must hold the pinned
// bytes (moss-job-launch.pin.json) and must run a trivial program inside a job here. That
// self-test catches what no error number tells reliably, such as a backend that itself runs
// in a job refusing nested jobs. When the launcher fails any of this, or later will not start
// or reports a failure of its own (exit codes MOSS_JOB_LAUNCH_EXIT_*), that is remembered for
// the life of this backend and every caller sees Windows as unsupported again, exactly as
// before the launcher existed. One log line says why.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess as NodeChildProcess } from "node:child_process";

import * as NodeSink from "@effect/platform-node/NodeSink";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { spawnProcess } from "@moss/shared/processRuntime";
import { Deferred, Duration, Effect, PlatformError, Schedule, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import launcherPin from "../../native/moss-job-launch/moss-job-launch.pin.json" with { type: "json" };

/** Set by the desktop app (packaged: inside resources; development: the local build). */
export const WINDOWS_JOB_LAUNCHER_PATH_ENV = "MOSS_WINDOWS_JOB_LAUNCHER_PATH";
const LAUNCHER_FILE_NAME = "moss-job-launch.exe";

/**
 * Whether auxiliary CLIs on this OS are contained by a Windows job (this module) rather than a
 * POSIX process group. Callers outside the platform layer ask this instead of branching on
 * the OS themselves.
 */
export function usesWindowsJobContainment(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Windows: a folder that a process ended through a job was working in is released a moment
 * after the launcher exits; until then removing it fails with EBUSY. Retries `remove` for up
 * to about five seconds there; elsewhere runs it once.
 */
export function retryWhileWindowsReleasesFolder<A, E, R>(
  remove: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return usesWindowsJobContainment()
    ? remove.pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(100)) }))
    : remove;
}

/** The launcher's exit codes: 0x4D4A4C00 ("MJL") plus the step, never a code Codex uses. */
export const WINDOWS_JOB_LAUNCHER_EXIT_BASE = 0x4d4a4c00;
export const WINDOWS_JOB_LAUNCHER_EXIT_CODES = {
  input: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 1,
  createJob: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 2,
  jobLimits: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 3,
  attributes: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 4,
  /** The program could not be started (missing, blocked, not an executable): its own failure. */
  createProcess: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 5,
  wait: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 6,
  /** Windows refused to create the program inside the job. */
  jobRefused: WINDOWS_JOB_LAUNCHER_EXIT_BASE + 7,
} as const;

/** A failure of the launcher itself (every code but `createProcess`). */
export function isWindowsJobLauncherFailureExitCode(code: number): boolean {
  return (
    code > WINDOWS_JOB_LAUNCHER_EXIT_BASE &&
    code <= WINDOWS_JOB_LAUNCHER_EXIT_CODES.jobRefused &&
    code !== WINDOWS_JOB_LAUNCHER_EXIT_CODES.createProcess
  );
}

const APP_ENV_KEY = "MOSS_JOB_APP";
const COMMAND_LINE_ENV_KEY = "MOSS_JOB_CMDLINE";
/** Windows caps one environment variable, and a command line, at 32,767 characters. */
const MAX_COMMAND_LINE_CHARS = 32_766;

/**
 * One argument as the Microsoft C runtime (and CommandLineToArgvW) parses it back: the
 * quoting libuv uses for `child_process.spawn` on Windows.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument === "") return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      quoted += `${"\\".repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * The environment entries that tell the launcher what to run: `command args` as one command
 * line (no shell reads it). `command` is the final, planned executable (an absolute `.exe`,
 * or `cmd.exe` for a batch shim); with `verbatimArguments` its arguments are already one
 * prequoted command line, as the Windows planner produces for `cmd.exe /d /s /c "…"`.
 */
export function windowsJobLauncherEnv(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly verbatimArguments?: boolean;
}): Readonly<Record<string, string>> {
  const commandLine = [
    quoteWindowsArgument(input.command),
    ...(input.verbatimArguments ? [input.args.join(" ")] : input.args.map(quoteWindowsArgument)),
  ]
    .filter((part) => part !== "")
    .join(" ");
  if (commandLine.length > MAX_COMMAND_LINE_CHARS || commandLine.includes("\0")) {
    throw new Error("The command line cannot be passed to the Windows job launcher.");
  }
  return {
    // An unresolved bare name is left to CreateProcess's own search.
    [APP_ENV_KEY]: path.win32.isAbsolute(input.command) ? input.command : "",
    [COMMAND_LINE_ENV_KEY]: commandLine,
  };
}

// ---------------------------------------------------------------------------------------
// Whether the launcher can be used, decided once per backend.

export type WindowsJobLauncherStatus =
  | { readonly kind: "available"; readonly path: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Development and tests: the build output beside the launcher's source. */
export function developmentWindowsJobLauncherPath(cwd = process.cwd()): string {
  const serverRoot = cwd.endsWith(path.join("apps", "server"))
    ? cwd
    : path.resolve(cwd, "apps", "server");
  return path.join(serverRoot, "native", "moss-job-launch", "build", LAUNCHER_FILE_NAME);
}

export function configuredWindowsJobLauncherPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[WINDOWS_JOB_LAUNCHER_PATH_ENV]?.trim();
  if (configured && env.MOSS_MODE === "desktop") return path.resolve(configured);
  return developmentWindowsJobLauncherPath();
}

let resolvedStatus: Promise<WindowsJobLauncherStatus> | undefined;
let statusLogged = false;
let failure: string | undefined;
let launcherPathForTest: string | undefined;
let skipChecksForTest = false;

/** The launcher's pinned sha256 (the same pin the build and the package audit enforce). */
export const WINDOWS_JOB_LAUNCHER_SHA256: string = launcherPin.sha256;
const SELF_TEST_TIMEOUT_MS = 10_000;

/**
 * Runs the launcher with the launcher itself as the program. The outer one creates its job and
 * the inner one inside it; the inner one finds no MOSS_JOB_* (the outer removes them) and exits
 * with the launcher's own input code, which the outer passes through. So that code back proves
 * the launcher starts, creates a program inside a job here, and returns its exit code, with no
 * shell involved. Resolves to null when it does, or to why not.
 */
export function runWindowsJobLauncherSelfTest(launcherPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: NodeChildProcess;
    try {
      child = spawnProcess(launcherPath, [], {
        env: {
          ...process.env,
          ...windowsJobLauncherEnv({ command: launcherPath, args: [] }),
        },
        detached: false,
        stdio: "ignore",
      });
    } catch (cause) {
      resolve(`self-test did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    const timer = setTimeout(() => {
      // Through Node's handle, only while it is open (see the spawner below).
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve("self-test did not finish in time");
    }, SELF_TEST_TIMEOUT_MS);
    child.once("error", (cause) => {
      clearTimeout(timer);
      resolve(`self-test did not start: ${cause.message}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(
        code === WINDOWS_JOB_LAUNCHER_EXIT_CODES.input
          ? null
          : `self-test exited with ${code === null ? "no code" : `0x${(code >>> 0).toString(16)}`}`,
      );
    });
  });
}

async function probeLauncher(launcherPath: string): Promise<WindowsJobLauncherStatus> {
  if (!usesWindowsJobContainment()) return { kind: "unavailable", reason: "not Windows" };
  try {
    const info = await stat(launcherPath);
    if (!info.isFile()) return { kind: "unavailable", reason: `${launcherPath} is not a file` };
  } catch {
    return { kind: "unavailable", reason: `${launcherPath} is missing` };
  }
  if (skipChecksForTest) return { kind: "available", path: launcherPath };
  const sha256 = createHash("sha256")
    .update(await readFile(launcherPath))
    .digest("hex");
  if (sha256 !== WINDOWS_JOB_LAUNCHER_SHA256) {
    return {
      kind: "unavailable",
      reason: `${launcherPath} has sha256 ${sha256}, not the pinned ${WINDOWS_JOB_LAUNCHER_SHA256}`,
    };
  }
  const selfTestFailure = await runWindowsJobLauncherSelfTest(launcherPath);
  return selfTestFailure === null
    ? { kind: "available", path: launcherPath }
    : { kind: "unavailable", reason: selfTestFailure };
}

/**
 * The launcher's status for this backend; settled once (pin and self-test), then remembered.
 * An unusable launcher on Windows is logged once.
 */
export const windowsJobLauncherStatus: Effect.Effect<WindowsJobLauncherStatus> = Effect.promise(
  () => {
    resolvedStatus ??= probeLauncher(launcherPathForTest ?? configuredWindowsJobLauncherPath());
    return resolvedStatus.then(
      (status): WindowsJobLauncherStatus =>
        failure === undefined ? status : { kind: "unavailable", reason: failure },
    );
  },
).pipe(
  Effect.tap((status) => {
    if (statusLogged || !usesWindowsJobContainment()) return Effect.void;
    statusLogged = true;
    return status.kind === "available"
      ? Effect.logInfo("Windows job launcher ready", { path: status.path })
      : Effect.logWarning(
          "Windows job launcher unusable; auxiliary Codex text generation is refused on Windows as before it existed",
          { reason: status.reason },
        );
  }),
);

/**
 * The launcher would not start or failed on its own: Windows is unsupported again for the
 * rest of this backend's life. Logged once.
 */
export const markWindowsJobLauncherFailed = (reason: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (failure !== undefined) return Effect.void;
    failure = reason;
    return Effect.logWarning(
      "Windows job launcher failed; auxiliary Codex text generation falls back as on a Windows PC without it",
      { reason },
    );
  });

/**
 * Tests only: forget what was looked up and any recorded failure; optionally use
 * `launcherPath`, and with `skipChecks` accept any file there without hashing or running it.
 */
export function resetWindowsJobLauncherStatusForTest(
  launcherPath?: string,
  options: { readonly skipChecks?: boolean } = {},
): void {
  resolvedStatus = undefined;
  statusLogged = false;
  failure = undefined;
  launcherPathForTest = launcherPath;
  skipChecksForTest = options.skipChecks === true;
}

// ---------------------------------------------------------------------------------------
// Spawning through the launcher.

const platformError = (method: string, description: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method,
    description,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * A spawner for commands planned with `windowsJobLauncher` (effectProcessRuntime.ts): starts
 * the launcher with Node directly, so Moss holds the real process handle and can end the
 * launcher (and with it the job) through that handle alone. Spawn errors and the launcher's
 * own exit codes are recorded with {@link markWindowsJobLauncherFailed}.
 */
export const windowsJobLauncherSpawner: Pick<
  ChildProcessSpawner.ChildProcessSpawner["Service"],
  "spawn"
> = {
  spawn: (command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.fail(
          platformError("spawn", "The Windows job launcher runs one command, not a pipeline."),
        );
      }
      const options = command.options;
      const stdinOption = options.stdin;
      const stdinStream =
        stdinOption !== undefined && typeof stdinOption === "object" && "stream" in stdinOption
          ? stdinOption.stream
          : stdinOption;
      const ignoreStdin = stdinStream === "ignore";
      const env = options.extendEnv ? { ...process.env, ...options.env } : options.env;

      const child = yield* Effect.callback<NodeChildProcess, PlatformError.PlatformError>(
        (resume) => {
          let launched: NodeChildProcess;
          try {
            launched = spawnProcess(command.command, [...command.args], {
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...(env ? { env: env as NodeJS.ProcessEnv } : {}),
              // Never detached: the launcher must stay in this backend's job.
              detached: false,
              stdio: [ignoreStdin ? "ignore" : "pipe", "pipe", "pipe"],
            });
          } catch (cause) {
            resume(
              Effect.fail(platformError("spawn", "The Windows job launcher did not start.", cause)),
            );
            return;
          }
          const onError = (cause: Error) => {
            launched.off("spawn", onSpawn);
            resume(
              Effect.fail(
                platformError(
                  "spawn",
                  `The Windows job launcher did not start: ${cause.message}`,
                  cause,
                ),
              ),
            );
          };
          const onSpawn = () => {
            launched.off("error", onError);
            resume(Effect.succeed(launched));
          };
          launched.once("error", onError);
          launched.once("spawn", onSpawn);
        },
      ).pipe(Effect.tapError((error) => markWindowsJobLauncherFailed(error.message)));

      const exited = yield* Deferred.make<number | null>();
      const settle = (code: number | null) => Deferred.doneUnsafe(exited, Effect.succeed(code));
      if (child.exitCode !== null || child.signalCode !== null) settle(child.exitCode);
      else child.once("exit", (code) => settle(code));
      // Errors after a successful start (a failed kill) must not crash the backend.
      child.on("error", () => undefined);

      // Ends the launcher through Node's handle, only while that handle is open. Node's
      // ChildProcess.kill is TerminateProcess on libuv's handle and does nothing once the
      // process has been reaped, so no other process can be hit.
      const terminate = Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      yield* Effect.addFinalizer(() =>
        terminate.pipe(Effect.andThen(Deferred.await(exited)), Effect.ignore),
      );

      let stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain;
      if (child.stdin) {
        stdin = NodeSink.fromWritable({
          evaluate: () => child.stdin!,
          onError: (cause) => platformError("fromWritable(stdin)", String(cause), cause),
          endOnDone: true,
        });
        if (Stream.isStream(stdinStream)) {
          yield* Stream.run(stdinStream as Stream.Stream<Uint8Array>, stdin).pipe(
            Effect.ignore,
            Effect.forkScoped,
          );
        }
      }
      const readable = (name: "stdout" | "stderr") =>
        child[name]
          ? NodeStream.fromReadable({
              evaluate: () => child[name]!,
              onError: (cause) => platformError(`fromReadable(${name})`, String(cause), cause),
            })
          : Stream.empty;
      const stdout = readable("stdout");
      const stderr = readable("stderr");

      const exitCode = Deferred.await(exited).pipe(
        Effect.flatMap((code) =>
          code === null
            ? Effect.fail(platformError("exitCode", "The Windows job launcher was terminated."))
            : isWindowsJobLauncherFailureExitCode(code)
              ? markWindowsJobLauncherFailed(
                  `moss-job-launch.exe exited with its own failure code 0x${code.toString(16)}`,
                ).pipe(Effect.as(ChildProcessSpawner.ExitCode(code)))
              : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        ),
      );

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(Number(child.pid)),
        exitCode,
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => terminate.pipe(Effect.andThen(Deferred.await(exited)), Effect.asVoid),
        stdin,
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
};
