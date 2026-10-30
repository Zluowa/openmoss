// Exercises the installed Effect patch, including its compiled runtime entrypoint.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { makeEffectProcessCommand } from "./effectProcessRuntime";

const nodeChildProcess = createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");

describe("Effect process signal guards", () => {
  const invalidPids = [undefined, 0, 1, -1, 1.5, NaN, Infinity, 2 ** 32 + 1];
  const cases = [...new Set([process.platform, "win32"])]
    .flatMap((platform) => invalidPids.map((pid) => ({ platform, pid })))
    .concat([{ platform: "win32", pid: 32123 }]);

  // The spy on node:child_process.spawn can only reach the externalized
  // effect-smol spawner under Node (CJS require-cache patching). Under Bun the
  // builtin namespace is frozen, so the mock never lands and the real spawn
  // runs. The PID guard itself is covered by the two non-mocked tests below.
  (typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? it : it.skip).each(cases)(
    "Windows console policy and PID guard: $platform pid=$pid",
    async ({ platform, pid }) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const fake = Object.assign(new EventEmitter(), {
        pid,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: null,
        stdout: null,
        stderr: null,
        stdio: [],
        kill: vi.fn(() => true),
      });
      // No OS signals may leave this test, even against an unpatched runtime.
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const spawn = vi.spyOn(nodeChildProcess, "spawn").mockImplementation(() => {
        queueMicrotask(() => fake.emit("spawn"));
        return fake as unknown as import("node:child_process").ChildProcess;
      });
      const complete = (...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") callback(null, "", "");
        return fake as unknown as import("node:child_process").ChildProcess;
      };
      const exec = vi.spyOn(nodeChildProcess, "exec").mockImplementation(complete);
      const execFile = vi.spyOn(nodeChildProcess, "execFile").mockImplementation(complete);
      Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
      syncBuiltinESMExports();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const child = yield* spawner.spawn(
                makeEffectProcessCommand("fake-signal-test", [], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              );
              fake.exitCode = 1;
              fake.emit("exit", 1, null);
              expect(yield* child.exitCode).toBe(1);
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
        if (platform === "win32") {
          expect(spawn).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Array),
            expect.objectContaining({ windowsHide: true }),
          );
        }
        expect(execFile).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
        spawn.mockRestore();
        exec.mockRestore();
        execFile.mockRestore();
        kill.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );
});

it.runIf(process.platform === "win32")(
  "interrupts a real running Windows Effect child and its owned descendant before settling",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-effect-owned-cancel-"));
    const ready = join(directory, "owned-pids.json");
    const descendant = "process.send('ready'); setTimeout(() => process.exit(0), 30000)";
    const leader = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      child.once('message', () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid, child.pid])));
      setTimeout(() => process.exit(0), 30000);
    `;
    const running = Effect.runFork(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.spawn(
          makeEffectProcessCommand(process.execPath, ["-e", leader], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* Effect.never;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    try {
      let ownedPids: number[] = [];
      await vi.waitFor(
        () => {
          ownedPids = JSON.parse(readFileSync(ready, "utf8"));
          expect(ownedPids).toHaveLength(2);
          expect(
            ownedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid),
          ).toBe(true);
          for (const pid of ownedPids) expect(() => process.kill(pid, 0)).not.toThrow();
        },
        { timeout: 5_000 },
      );
      await Effect.runPromise(Fiber.interrupt(running));
      await vi.waitFor(
        () => {
          for (const pid of ownedPids)
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        },
        { timeout: 2_000 },
      );
    } finally {
      await Effect.runPromise(Fiber.interrupt(running));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("does not replace the process-wide signal function when the controller is imported", async () => {
  const originalKill = process.kill;
  await import("./processTreeController");
  expect(process.kill).toBe(originalKill);
});

it.skipIf(process.platform === "win32")(
  "cleans an owned group after its leader exits nonzero",
  async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-group-exit-"));
    const marker = path.join(directory, "descendant-stopped");
    const descendant = `
    process.on('SIGTERM', () => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped');
      process.exit(0);
    });
    process.send('ready');
    setTimeout(() => process.exit(0), 4000);
  `;
    const leader = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', () => { child.disconnect(); process.exit(1); });
    setTimeout(() => process.exit(1), 3000);
  `;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const child = yield* spawner.spawn(
              makeEffectProcessCommand(process.execPath, ["-e", leader], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            );
            expect(yield* child.exitCode).toBe(1);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      await vi.waitFor(async () => expect(await fs.readFile(marker, "utf8")).toBe("stopped"), {
        timeout: 2000,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
