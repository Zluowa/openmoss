// FILE: effectProcessRuntime.test.ts
// Purpose: Verifies shared Windows launch decisions reach Effect child-process commands.
// Layer: Server platform runtime test

import { afterEach, describe, expect, it, vi } from "vitest";
import * as executable from "@moss/shared/executable";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerSettingsService } from "../serverSettings";

import {
  makeEffectProcessCommand,
  settleProviderStartupPriority,
  spawnProviderProcess,
} from "./effectProcessRuntime";
import { installWindowsProviderProcessGuard } from "./windowsProviderProcessGuard";

afterEach(() => vi.restoreAllMocks());

describe("spawnProviderProcess", () => {
  it.runIf(process.platform === "win32")(
    "keeps a deferred agent at normal priority until its session is ready",
    async () => {
      const serverPriority = os.getPriority();
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawnProviderProcess(
            spawner,
            process.execPath,
            ["-e", "setTimeout(() => {}, 10000)"],
            { deferPriorityUntilReady: true },
          );
          const pid = Number(child.pid);
          const atStart = os.getPriority(pid);
          yield* settleProviderStartupPriority(child);
          const afterReady = os.getPriority(pid);
          yield* child.kill();
          return { atStart, afterReady };
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.provide(ServerSettingsService.layerTest({ lowerProviderProcessPriority: true })),
        ),
      );
      expect(observed.atStart).toBe(serverPriority);
      expect(observed.afterReady).toBe(
        Math.max(serverPriority, os.constants.priority.PRIORITY_BELOW_NORMAL),
      );
    },
  );

  it("keeps a provider registered with the guard until its owner's teardown has run", async () => {
    const events: string[] = [];
    installWindowsProviderProcessGuard({
      track: (pid, notBeforeMs) => {
        events.push(`track ${pid === Number(pid) && notBeforeMs <= Date.now()}`);
        return () => void events.push("release");
      },
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawnProviderProcess(spawner, process.execPath, [
            "-e",
            "process.exit(0)",
          ]);
          yield* Effect.addFinalizer(() => Effect.sync(() => void events.push("owner teardown")));
          yield* child.exitCode;
          expect(events).toEqual(["track true"]);
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.provide(ServerSettingsService.layerTest({ lowerProviderProcessPriority: false })),
        ),
      );
    } finally {
      installWindowsProviderProcessGuard(null);
    }
    expect(events).toEqual(["track true", "owner teardown", "release"]);
  });

  it.each([false, true])(
    "reports unsafe Windows batch arguments as typed launch failure (priority=%s)",
    async (enabled) => {
      const spawn = vi.fn(() => Effect.die("unsafe command must not reach spawn"));
      const exit = await Effect.runPromiseExit(
        spawnProviderProcess({ spawn }, "C:\\tools\\provider.cmd", ["one&two"], {
          platform: "win32",
          env: { PATH: "", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        }).pipe(
          Effect.scoped,
          Effect.provide(
            ServerSettingsService.layerTest({ lowerProviderProcessPriority: enabled }),
          ),
        ),
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: {
            _tag: "PlatformError",
            reason: { _tag: "BadArgument", module: "ChildProcess", method: "spawn" },
          },
        });
        expect(Cause.pretty(exit.cause)).toContain("Cannot safely execute Windows batch argument");
      }
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each(["unresolved executable", "missing POSIX shell"] as const)(
    "applies post-spawn priority for a successful direct Effect launch (%s)",
    async (reason) => {
      const resolveExecutable = executable.resolveExecutable;
      vi.spyOn(executable, "resolveExecutable").mockImplementation((command, options) =>
        reason === "unresolved executable" || command === "/bin/sh"
          ? null
          : resolveExecutable(command, options),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(os, "getPriority").mockReturnValue(0);
      const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
      const pid = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawnProviderProcess(spawner, process.execPath, [
            "-e",
            "process.exit(0)",
          ]);
          yield* child.exitCode;
          return child.pid;
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.provide(ServerSettingsService.layerTest({ lowerProviderProcessPriority: true })),
        ),
      );
      expect(setPriority).toHaveBeenCalledWith(pid, 5);
      if (reason === "missing POSIX shell") {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("/bin/sh is unavailable"));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it.runIf(process.platform !== "win32").each(["bare", "absolute"] as const)(
    "preserves the Effect spawn error with priority enabled for a missing %s executable",
    async (kind) => {
      const command =
        kind === "bare"
          ? "synara-missing-priority-test-executable"
          : path.join(os.tmpdir(), "synara-missing-priority-test-executable");
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawnProviderProcess(spawner, command, [], {
            env: { ...process.env, PATH: "" },
          });
          return yield* child.exitCode;
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.provide(ServerSettingsService.layerTest({ lowerProviderProcessPriority: true })),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain("ENOENT");
        expect(Cause.pretty(result.cause)).toContain(command);
      }
    },
  );

  it.each([false, true])(
    "wires the server setting into a real Effect child (enabled=%s)",
    async (enabled) => {
      const serverPriority = os.getPriority();
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawnProviderProcess(spawner, process.execPath, [
            "-e",
            `
              const os = require('node:os');
              const report = () => {
              const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())']);
              const threads = process.platform === 'linux'
                ? require('node:fs').readdirSync('/proc/self/task').map(tid => {
                    const stat = require('node:fs').readFileSync('/proc/self/task/' + tid + '/stat', 'utf8');
                    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]);
                  })
                : [os.getPriority()];
              console.log(JSON.stringify({ parent: os.getPriority(), descendant: Number(child.stdout), threads }));
              };
              // Windows remains post-spawn; this probe does not prove the shim race absent.
              if (process.platform === 'win32') setTimeout(report, 100);
              else report();
            `,
          ]);
          return yield* Stream.mkString(Stream.decodeText(child.stdout));
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.provide(
            ServerSettingsService.layerTest({ lowerProviderProcessPriority: enabled }),
          ),
        ),
      );
      const expected = enabled
        ? Math.max(serverPriority, process.platform === "win32" ? 10 : 5)
        : serverPriority;
      const priorities = JSON.parse(observed);
      expect(priorities.parent).toBe(expected);
      expect(priorities.descendant).toBe(expected);
      expect(priorities.threads.length).toBeGreaterThan(0);
      expect(priorities.threads.every((priority: number) => priority === expected)).toBe(true);
      expect(os.getPriority()).toBe(serverPriority);
    },
  );
});

describe("makeEffectProcessCommand", () => {
  it("keeps PowerShell provider probes hidden on Windows", () => {
    const command = makeEffectProcessCommand("cursor-agent.ps1", ["--version"], {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(command).toMatchObject({
      _tag: "StandardCommand",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "cursor-agent.ps1", "--version"],
      options: {
        shell: false,
        windowsHide: true,
      },
    });
  });
});
