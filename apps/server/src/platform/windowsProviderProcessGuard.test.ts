import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWindowsProviderProcessGuard,
  installWindowsProviderProcessGuard,
  spawnGuardedProviderChild,
  trackOwnedProviderProcess,
  windowsProviderProcessGuardLaunch,
} from "./windowsProviderProcessGuard.ts";

function fakeGuardProcess() {
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(...chunk.toString().trim().split("\n")));
  const emitter = new EventEmitter();
  const unref = vi.fn();
  const process = Object.assign(emitter, { stdin, unref }) as unknown as ChildProcess;
  return { process, written, unref, emitter };
}

describe("windows provider process guard", () => {
  afterEach(() => installWindowsProviderProcessGuard(null));

  it("does not start until a provider exists and never keeps the backend alive", () => {
    const worker = fakeGuardProcess();
    const spawnGuard = vi.fn(() => worker.process);
    const guard = createWindowsProviderProcessGuard({ spawnGuard });
    expect(spawnGuard).not.toHaveBeenCalled();

    guard.track(4242, 1_000);
    guard.track(4343, 2_000);

    expect(spawnGuard).toHaveBeenCalledTimes(1);
    expect(worker.unref).toHaveBeenCalledTimes(1);
    expect(worker.written).toEqual(["+4242 1000", "+4343 2000"]);
  });

  it("releases once, and only the process it registered", () => {
    const worker = fakeGuardProcess();
    const guard = createWindowsProviderProcessGuard({ spawnGuard: () => worker.process });

    const release = guard.track(4242, 1_000);
    guard.track(4343, 2_000);
    release();
    release();

    expect(worker.written).toEqual(["+4242 1000", "+4343 2000", "-4242"]);
  });

  it("re-registers live providers with a new guard after the old one is lost", () => {
    const first = fakeGuardProcess();
    const second = fakeGuardProcess();
    const spawnGuard = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(first.process)
      .mockReturnValueOnce(second.process);
    const guard = createWindowsProviderProcessGuard({ spawnGuard });

    const releaseFirst = guard.track(4242, 1_000);
    guard.track(4343, 2_000);
    releaseFirst();
    first.emitter.emit("exit");
    guard.track(4444, 3_000);

    expect(spawnGuard).toHaveBeenCalledTimes(2);
    expect(second.written).toEqual(["+4343 2000", "+4444 3000"]);
  });

  it("keeps working when the guard cannot start, and tries again for the next provider", () => {
    const worker = fakeGuardProcess();
    const spawnGuard = vi
      .fn<() => ChildProcess>()
      .mockImplementationOnce(() => {
        throw new Error("spawn EPERM");
      })
      .mockReturnValueOnce(worker.process);
    const guard = createWindowsProviderProcessGuard({ spawnGuard });

    expect(() => guard.track(4242, 1_000)).not.toThrow();
    guard.track(4343, 2_000);

    expect(worker.written).toEqual(["+4242 1000", "+4343 2000"]);
  });

  it.each([0, 1, -5, 1.5, Number.NaN, 0x80000000])("refuses to register pid %s", (pid) => {
    const spawnGuard = vi.fn(() => fakeGuardProcess().process);
    const guard = createWindowsProviderProcessGuard({ spawnGuard });
    guard.track(pid, 1_000)();
    expect(spawnGuard).not.toHaveBeenCalled();
  });

  it("registers nothing until the server entry point installs a guard", () => {
    const worker = fakeGuardProcess();
    expect(() => trackOwnedProviderProcess(4242, 1_000)()).not.toThrow();

    installWindowsProviderProcessGuard(
      createWindowsProviderProcessGuard({ spawnGuard: () => worker.process }),
    );
    trackOwnedProviderProcess(4242, 1_000);

    expect(worker.written).toEqual(["+4242 1000"]);
  });

  it("keeps a Node child registered until that child exits", () => {
    const worker = fakeGuardProcess();
    installWindowsProviderProcessGuard(
      createWindowsProviderProcessGuard({ spawnGuard: () => worker.process }),
    );
    const child = Object.assign(new EventEmitter(), { pid: 4242 });

    expect(spawnGuardedProviderChild(() => child)).toBe(child);
    expect(worker.written).toEqual([expect.stringMatching(/^\+4242 \d+$/)]);

    child.emit("exit");
    expect(worker.written.at(-1)).toBe("-4242");
  });

  it("ignores a Node child that never got a pid", () => {
    const spawnGuard = vi.fn(() => fakeGuardProcess().process);
    installWindowsProviderProcessGuard(createWindowsProviderProcessGuard({ spawnGuard }));
    const child = Object.assign(new EventEmitter(), { pid: undefined });

    spawnGuardedProviderChild(() => child);

    expect(spawnGuard).not.toHaveBeenCalled();
  });
});

describe("windows provider process guard launch", () => {
  it("fits within what cmd.exe accepts on one command line", () => {
    const { command, args } = windowsProviderProcessGuardLaunch();
    expect([command, ...args].join(" ").length).toBeLessThan(8_191);
  });

  it("never starts PowerShell directly or detached, where it exits before running", () => {
    const { command, args } = windowsProviderProcessGuardLaunch();
    expect(path.win32.basename(command).toLowerCase()).toBe("cmd.exe");
    expect(args.slice(0, 2)).toEqual(["/d", "/c"]);
    expect(path.win32.basename(args[2]!).toLowerCase()).toBe("powershell.exe");
  });
});

// Runs the real launch from a real owner, then terminates that owner the way the desktop's
// forced stop and an uninstaller do. libuv's job only acts when its owner actually dies.
const OWNER_FIXTURE = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [launchJson, runner, directory] = process.argv.slice(2);
const launch = JSON.parse(launchJson);
const out = (name) => require("node:path").join(directory, name);
const guard = spawn(launch.command, launch.args, {
  cwd: launch.cwd,
  stdio: ["pipe", "ignore", "ignore"],
  windowsHide: true,
});
// The same shape as opencode.cmd: cmd.exe stays as the parent of the real CLI.
const notBeforeMs = Date.now();
const registered = spawn(
  "cmd.exe",
  ["/d", "/s", "/c", '""' + process.execPath + '" "' + runner + '" "' + out("registered.pid") + '""'],
  { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true },
);
// Something Moss opened for the user, such as an editor. It is not a provider.
const unregistered = spawn(process.execPath, [runner, out("unregistered.pid")], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
unregistered.unref();
guard.stdin.write("+" + registered.pid + " " + notBeforeMs + "\\n", () => {
  writeFileSync(out("owner.json"), JSON.stringify({ shim: registered.pid, guard: guard.pid }));
});
setInterval(() => undefined, 1000);
`;

describe.runIf(process.platform === "win32")("windows provider process guard script", () => {
  const LONG_RUNNER = `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => undefined, 1000);`;

  function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return predicate();
  }

  function startGuard(): ChildProcess {
    const { command, args, cwd } = windowsProviderProcessGuardLaunch();
    return spawn(command, args, { cwd, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  }

  function cleanupPids(pids: Array<number | undefined>): void {
    for (const pid of pids) {
      if (pid === undefined) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is what most of these tests expect.
      }
    }
  }

  it.each([
    ["after the guard has started", 4_000],
    ["while the guard is still starting", 0],
  ])(
    "stops a registered tree when its owner is terminated %s, and nothing else",
    async (_label, settleMs) => {
      const directory = mkdtempSync(path.join(tmpdir(), "moss-provider-guard-"));
      const runner = path.join(directory, "runner.cjs");
      const fixture = path.join(directory, "owner.cjs");
      writeFileSync(runner, LONG_RUNNER);
      writeFileSync(fixture, OWNER_FIXTURE);
      const ownerFile = path.join(directory, "owner.json");
      const registeredFile = path.join(directory, "registered.pid");
      const unregisteredFile = path.join(directory, "unregistered.pid");
      const owner = spawn(
        process.execPath,
        [fixture, JSON.stringify(windowsProviderProcessGuardLaunch()), runner, directory],
        { stdio: "ignore", windowsHide: true, detached: true },
      );
      let registeredPid: number | undefined;
      let unregisteredPid: number | undefined;
      try {
        expect(await waitFor(() => existsSync(ownerFile), 30_000)).toBe(true);
        expect(await waitFor(() => existsSync(registeredFile), 30_000)).toBe(true);
        expect(await waitFor(() => existsSync(unregisteredFile), 30_000)).toBe(true);
        registeredPid = Number(readFileSync(registeredFile, "utf8"));
        unregisteredPid = Number(readFileSync(unregisteredFile, "utf8"));
        const { shim } = JSON.parse(readFileSync(ownerFile, "utf8")) as { shim: number };
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

        process.kill(owner.pid!, "SIGKILL");

        // libuv's job takes the shim's cmd.exe with the owner. The CLI it started is the leak.
        expect(await waitFor(() => !isRunning(shim), 15_000)).toBe(true);
        expect(await waitFor(() => !isRunning(registeredPid!), 60_000)).toBe(true);
        expect(isRunning(unregisteredPid)).toBe(true);
      } finally {
        cleanupPids([owner.pid, registeredPid, unregisteredPid]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("leaves a provider alone once its owner released it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "moss-provider-guard-"));
    const runner = path.join(directory, "runner.cjs");
    writeFileSync(runner, LONG_RUNNER);
    const pidFile = path.join(directory, "released.pid");
    const guard = startGuard();
    const notBeforeMs = Date.now();
    const provider = spawn(process.execPath, [runner, pidFile], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      expect(await waitFor(() => existsSync(pidFile), 30_000)).toBe(true);
      guard.stdin?.write(`+${provider.pid} ${notBeforeMs}\n-${provider.pid}\n`);
      guard.stdin?.end();

      expect(await waitFor(() => guard.exitCode !== null, 60_000)).toBe(true);
      expect(isRunning(provider.pid!)).toBe(true);
    } finally {
      cleanupPids([provider.pid, guard.pid]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a pid whose process started before Moss could have started it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "moss-provider-guard-"));
    const runner = path.join(directory, "runner.cjs");
    writeFileSync(runner, LONG_RUNNER);
    const pidFile = path.join(directory, "older.pid");
    const older = spawn(process.execPath, [runner, pidFile], {
      stdio: "ignore",
      windowsHide: true,
    });
    const guard = startGuard();
    try {
      expect(await waitFor(() => existsSync(pidFile), 30_000)).toBe(true);
      // A reused PID looks exactly like this: alive, but older than the claimed spawn.
      guard.stdin?.write(`+${older.pid} ${Date.now() + 60_000}\n`);
      guard.stdin?.end();

      expect(await waitFor(() => guard.exitCode !== null, 60_000)).toBe(true);
      expect(isRunning(older.pid!)).toBe(true);
    } finally {
      cleanupPids([older.pid, guard.pid]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
