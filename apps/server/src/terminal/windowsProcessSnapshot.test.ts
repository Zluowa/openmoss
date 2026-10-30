import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessChildrenMap } from "./processTreeKiller";
import {
  createPowerShellProcessSnapshotWorker,
  createWindowsProcessSnapshotObserver,
  createWindowsTeardownProcessSnapshotObserver,
  parseWindowsProcessSnapshotLine,
  WINDOWS_PROCESS_TREE_CAPTURE_TIMEOUT_MS,
  type ProcessChildrenSnapshotWorker,
} from "./windowsProcessSnapshot";

function snapshot(
  entries: Array<{ ppid: number; pid: number; command: string }>,
): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const entry of entries) {
    const siblings = childrenByParentPid.get(entry.ppid) ?? [];
    siblings.push({ pid: entry.pid, command: entry.command });
    childrenByParentPid.set(entry.ppid, siblings);
  }
  return childrenByParentPid;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Windows process snapshots", () => {
  it.runIf(process.platform === "win32")(
    "matches native creation identities to a fresh real CIM discovery",
    async () => {
      const observer = createWindowsTeardownProcessSnapshotObserver({ startImmediately: true });
      try {
        await observer.prepareWithin!(10_000);
        const discovery = await observer.captureWithin(WINDOWS_PROCESS_TREE_CAPTURE_TIMEOUT_MS);
        expect(discovery).not.toBeNull();
        const discovered = [...discovery!.values()].flat().find((row) => row.pid === process.pid);
        expect(discovered?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        const identities = await observer.capturePidsWithin!([process.pid], 250);
        expect(identities).not.toBeNull();
        const observed = [...identities!.values()].flat().find((row) => row.pid === process.pid);
        expect(observed?.startedAt).toBe(discovered?.startedAt);
        expect(observed?.identityKind).toBe("windows-start-time");
      } finally {
        observer.dispose();
      }
    },
  );

  it("sends only normalized numeric identities for a targeted native snapshot", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const input = vi.spyOn(child.stdin, "write");
    const worker = createPowerShellProcessSnapshotWorker({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    for (const pids of [[1], [NaN], [Infinity], [-1], [0x80000000], Array(4_097).fill(7)]) {
      await expect(worker.capture(pids)).rejects.toThrow("request");
    }
    expect(input).not.toHaveBeenCalled();
    const capture = worker.capture([701, 700, 701]);
    expect(input).toHaveBeenCalledWith("pids:700,701\n", expect.any(Function));
    child.stdout.write(
      `@snapshot\n701\t700\tfresh-identity\t${Buffer.from("child.exe").toString("base64")}\n@end\n`,
    );
    await expect(capture).resolves.toEqual(
      new Map([
        [
          700,
          [
            {
              pid: 701,
              command: "child.exe",
              startedAt: "fresh-identity",
              identityKind: "windows-start-time",
            },
          ],
        ],
      ]),
    );
    worker.dispose();
  });

  it("does not let a partial response satisfy a full capture or another identity query", async () => {
    const rootCapture = deferred<ProcessChildrenMap>();
    const full = snapshot([{ ppid: 700, pid: 701, command: "child.exe" }]);
    const capture = vi
      .fn<(pids?: readonly number[]) => Promise<ProcessChildrenMap>>()
      .mockImplementationOnce(() => rootCapture.promise)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(full);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker: () => ({ capture, dispose: vi.fn() }),
    });
    const root = observer.capture([700]);
    const fullCapture = observer.capture();
    const descendants = observer.capture([701]);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledExactlyOnceWith([700]);
    rootCapture.resolve(new Map());
    await expect(root).resolves.toEqual(new Map());
    await expect(fullCapture).resolves.toBe(full);
    await expect(descendants).resolves.toBe(full);
    expect(capture.mock.calls).toEqual([[[700]], [], [[701]]]);
    observer.dispose();
  });

  it("keeps an expired root query from proving that a different descendant exited", async () => {
    vi.useFakeTimers();
    const rootCapture = deferred<ProcessChildrenMap>();
    const child = snapshot([{ ppid: 700, pid: 701, command: "child.exe" }]);
    const capture = vi
      .fn<(pids?: readonly number[]) => Promise<ProcessChildrenMap>>()
      .mockImplementationOnce(() => rootCapture.promise)
      .mockResolvedValueOnce(child);
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker: () => ({ capture, dispose: vi.fn() }),
    });
    const root = observer.capturePidsWithin!([700], 250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(root).resolves.toBeNull();
    const descendant = observer.capturePidsWithin!([701], 1_500);
    rootCapture.resolve(new Map());
    await expect(descendant).resolves.toBe(child);
    expect(capture.mock.calls).toEqual([[[700]], [[701]]]);
    observer.dispose();
  });

  it("does not let a ready marker outlive its worker or create an unhandled lazy failure", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const worker = createPowerShellProcessSnapshotWorker({
      prepareCim: true,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker,
      startImmediately: true,
    });
    const preparing = observer.prepareWithin!(10_000);
    child.stdout.write("@phase:ready\n");
    await preparing;
    observer.assertReady!();
    child.emit("close", 1);
    expect(() => observer.assertReady!()).toThrow("closed");
    await expect(worker.ready!()).rejects.toThrow("worker-exit");
    expect(createWorker).toHaveBeenCalledOnce();
    observer.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("requires the ready marker within a separate startup deadline without sending a snapshot request", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const input = vi.spyOn(child.stdin, "write");
    const worker = createPowerShellProcessSnapshotWorker({
      prepareCim: true,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
      startImmediately: true,
    });
    const ready = vi.fn();
    const preparation = observer.prepareWithin!(10_000).then(ready);
    child.stdout.write("@phase:module-loading\n");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ready).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    child.stdout.write("@phase:provider-initializing\n@phase:ready\n");
    await preparation;
    expect(ready).toHaveBeenCalledOnce();
    expect(input).not.toHaveBeenCalled();
    const capture = observer.captureWithin(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await capture).toBeNull();
    expect(observer.lastFailure?.()?.kind).toBe("deadline");
    observer.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "abort", "initialization", "exit"])(
    "fails readiness closed on %s and disposes the worker",
    async (mode) => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const worker = createPowerShellProcessSnapshotWorker({
        prepareCim: true,
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      });
      const observer = createWindowsTeardownProcessSnapshotObserver({
        createWorker: () => worker,
        startImmediately: true,
      });
      const controller = new AbortController();
      const result = observer.prepareWithin!(10_000, controller.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (mode === "abort") controller.abort(new Error("cancelled"));
      else if (mode === "initialization") child.stdout.write("@warmup-error\n");
      else if (mode === "exit") child.emit("close", 1);
      else await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBeInstanceOf(Error);
      observer.dispose();
      child.stdout.write("@phase:ready\n");
      expect(child.kill).toHaveBeenCalledOnce();
      expect(await observer.capture()).toBeNull();
    },
  );
  it("records preparation phases before capture without accepting initialization as a snapshot", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const worker = createPowerShellProcessSnapshotWorker({
      prepareCim: true,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    child.stdout.write(
      "@phase:worker-ready\n@phase:module-loading\n@phase:provider-initializing\n",
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(worker.phase?.()).toEqual({ phase: "provider-initializing", phaseElapsedMs: 400 });
    child.stdout.write("@phase:ready\n");
    const settled = vi.fn();
    const capture = worker.capture().then((value) => {
      settled();
      return value;
    });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    // The descendant appears after initialization, and only the fresh response
    // can prove its identity. Preparation emits no process-table rows.
    child.stdout.write(
      `@snapshot\n@phase:query\n@phase:serialization\n701\t700\tfresh-created-at\t${Buffer.from("new-child.exe").toString("base64")}\n@end\n`,
    );
    await expect(capture).resolves.toEqual(
      new Map([[700, [{ pid: 701, command: "new-child.exe", startedAt: "fresh-created-at" }]]]),
    );
    worker.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("permanently rejects an initialization failure received before the first request", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const worker = createPowerShellProcessSnapshotWorker({
      prepareCim: true,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    child.stdout.write("@phase:provider-initializing\n@warmup-error\n");
    await expect(worker.capture()).rejects.toThrow("(initialization)");
    child.stdout.write("@phase:ready\n@snapshot\n@end\n");
    await expect(worker.capture()).rejects.toThrow("(initialization)");
    expect(worker.phase?.().phase).toBe("provider-initializing");
    worker.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("retains the fresh query phase when it exceeds the unchanged three-second deadline", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const worker = createPowerShellProcessSnapshotWorker({
      prepareCim: true,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
      startImmediately: true,
    });
    child.stdout.write("@phase:ready\n");
    await vi.advanceTimersByTimeAsync(5_000);
    const capture = observer.captureWithin(3_000);
    await Promise.resolve();
    child.stdout.write("@snapshot\n@phase:query\n");
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(capture).resolves.toBeNull();
    expect(observer.lastFailure?.()).toEqual({
      kind: "deadline",
      elapsedMs: 3_000,
      phase: "query",
      phaseElapsedMs: 3_000,
    });
    observer.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("starts an owned worker while the child is alive without reusing a stale capture at teardown", async () => {
    vi.useFakeTimers();
    const fresh = snapshot([{ ppid: 400, pid: 401, command: "new-descendant.exe" }]);
    const captureWorker = vi.fn<() => Promise<ProcessChildrenMap>>();
    const createWorker = vi.fn(() => {
      const readyAt = Date.now() + 4_000;
      captureWorker.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(fresh), Math.max(0, readyAt - Date.now()));
          }),
      );
      return { capture: captureWorker, dispose: vi.fn() };
    });
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker,
      startImmediately: true,
    });
    try {
      // The application child runs normally while PowerShell starts. No snapshot
      // exists yet; teardown must request fresh descendants with its original budget.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(captureWorker).not.toHaveBeenCalled();
      const capture = observer.captureWithin(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(capture).resolves.toBe(fresh);
      expect(createWorker).toHaveBeenCalledTimes(1);
      expect(captureWorker).toHaveBeenCalledTimes(1);
    } finally {
      observer.dispose();
    }
  });

  it("does not create a queued capture worker after its owner is disposed", async () => {
    const capture = vi.fn<ProcessChildrenSnapshotWorker["capture"]>(() =>
      Promise.reject(new Error("A disposed owner must never start a capture")),
    );
    const createWorker = vi.fn(() => ({ capture, dispose: vi.fn() }));
    const observer = createWindowsProcessSnapshotObserver({ createWorker });
    const pending = observer.capture([700]);
    observer.dispose();
    await expect(pending).resolves.toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not start a prepared worker when its short-lived owner has already disposed it", async () => {
    const createWorker = vi.fn(() => ({ capture: vi.fn(), dispose: vi.fn() }));
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker,
      startImmediately: true,
    });
    observer.dispose();
    await Promise.resolve();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("still rejects a slow CIM query within three seconds after the worker is prepared", async () => {
    vi.useFakeTimers();
    const worker = {
      capture: vi.fn(() => new Promise<ProcessChildrenMap>(() => {})),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker,
      startImmediately: true,
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(worker.capture).not.toHaveBeenCalled();
      const capture = observer.captureWithin(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(capture).resolves.toBeNull();
      expect(observer.lastFailure?.()).toEqual({ kind: "deadline", elapsedMs: 3_000 });
      expect(createWorker).toHaveBeenCalledTimes(1);
    } finally {
      observer.dispose();
    }
  });

  it.each([
    { event: "query", output: "@snapshot\n@error\n", kind: "query" },
    { event: "row", output: "@snapshot\nprivate-command-secret\n", kind: "malformed-row" },
    { event: "end", output: "@end\n", kind: "protocol" },
    { event: "spawn", output: "", kind: "spawn" },
    { event: "close", output: "", kind: "worker-exit" },
    { event: "phase", output: "@phase:private-command-secret\n", kind: "protocol" },
  ])(
    "retains only a safe $kind diagnostic and still rejects the snapshot",
    async ({ event, output, kind }) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const worker = createPowerShellProcessSnapshotWorker({
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      });
      const observer = createWindowsProcessSnapshotObserver({ createWorker: () => worker });
      const capture = observer.capture();
      await Promise.resolve();
      if (event === "spawn") child.emit("error", new Error("private-command-secret"));
      else if (event === "close") child.emit("close", 1, null);
      else child.stdout.write(output);
      await expect(capture).resolves.toBeNull();
      expect(observer.lastFailure?.()).toEqual({
        kind,
        elapsedMs: expect.any(Number),
        phase: "worker-starting",
        phaseElapsedMs: expect.any(Number),
      });
      expect(JSON.stringify(observer.lastFailure?.())).not.toContain("private-command-secret");
      expect(child.kill).toHaveBeenCalledOnce();
      observer.dispose();
    },
  );

  it("does not expose unclassified worker exception content", async () => {
    const observer = createWindowsProcessSnapshotObserver({
      createWorker: () => ({
        capture: () => Promise.reject(new Error("private-command-secret")),
        dispose: vi.fn(),
      }),
    });
    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.lastFailure?.()).toEqual({ kind: "unknown", elapsedMs: expect.any(Number) });
    expect(JSON.stringify(observer.lastFailure?.())).not.toContain("private-command-secret");
    observer.dispose();
  });

  it("parses base64-delimited rows without corrupting Windows command lines", () => {
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo';
    const encoded = Buffer.from(command, "utf8").toString("base64");

    expect(parseWindowsProcessSnapshotLine(`42\t7\t${encoded}`)).toEqual({
      pid: 42,
      ppid: 7,
      command,
    });
    expect(parseWindowsProcessSnapshotLine(`bad\t7\t${encoded}`)).toBeNull();
    expect(parseWindowsProcessSnapshotLine("42\t7\tnot-base64")).toBeNull();
  });

  it("accepts the Windows System Idle Process row", () => {
    const idleProcess = "System Idle Process";
    const startedAt = "20260903100453.000000+120";
    expect(
      parseWindowsProcessSnapshotLine(
        `0\t0\t${startedAt}\t${Buffer.from(idleProcess, "utf8").toString("base64")}`,
      ),
    ).toEqual({
      pid: 0,
      ppid: 0,
      command: idleProcess,
      startedAt,
    });
  });

  it("coalesces concurrent terminal requests and reuses one worker across snapshots", async () => {
    const firstCapture = deferred<ProcessChildrenMap>();
    const firstSnapshot = snapshot([
      { ppid: 100, pid: 101, command: "codex.exe" },
      { ppid: 200, pid: 201, command: "node.exe build.js" },
    ]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn<() => Promise<ProcessChildrenMap>>()
        .mockImplementationOnce(() => firstCapture.promise)
        .mockResolvedValue(firstSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsProcessSnapshotObserver({ createWorker });

    const terminalOne = observer.capture();
    const terminalTwo = observer.capture();
    const terminalThree = observer.capture();
    await Promise.resolve();

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(1);

    firstCapture.resolve(firstSnapshot);
    await expect(Promise.all([terminalOne, terminalTwo, terminalThree])).resolves.toEqual([
      firstSnapshot,
      firstSnapshot,
      firstSnapshot,
    ]);

    await expect(observer.capture()).resolves.toBe(firstSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("times out a stalled worker and does not create another process during backoff", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const stalledCapture = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => stalledCapture.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker,
      now: () => now,
      probeTimeoutMs: 50,
      retryBackoffBaseMs: 200,
      retryBackoffMaxMs: 800,
    });

    const capture = observer.capture();
    await vi.advanceTimersByTimeAsync(50);

    await expect(capture).resolves.toBeNull();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(observer.lastFailure?.()).toEqual({ kind: "timeout", elapsedMs: 0 });
    expect(observer.retryDelayMs()).toBe(200);

    await expect(observer.capture()).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);

    now += 199;
    await expect(observer.capture()).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("backs off repeated failures and resets after a successful recovery", async () => {
    let now = 5_000;
    const recoveredSnapshot = snapshot([{ ppid: 300, pid: 301, command: "claude.exe" }]);
    const failedWorker = (): ProcessChildrenSnapshotWorker => ({
      capture: vi.fn().mockRejectedValue(new Error("WMI unavailable")),
      dispose: vi.fn(),
    });
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(recoveredSnapshot),
      dispose: vi.fn(),
    };
    const workers = [failedWorker(), failedWorker(), recoveredWorker];
    const createWorker = vi.fn(() => workers.shift() ?? recoveredWorker);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker,
      now: () => now,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 400,
    });

    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.retryDelayMs()).toBe(100);

    now += 100;
    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.retryDelayMs()).toBe(200);

    now += 200;
    await expect(observer.capture()).resolves.toBe(recoveredSnapshot);
    expect(observer.retryDelayMs()).toBe(0);
    expect(observer.lastFailure?.()).toBeNull();

    await expect(observer.capture()).resolves.toBe(recoveredSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(3);
    expect(recoveredWorker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("retries teardown snapshots within the process-exit proof window", async () => {
    vi.useFakeTimers();
    const recoveredSnapshot = snapshot([{ ppid: 400, pid: 401, command: "provider.exe" }]);
    const failedWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("CIM unavailable")),
      dispose: vi.fn(),
    };
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(recoveredSnapshot),
      dispose: vi.fn(),
    };
    const workers = [failedWorker, recoveredWorker];
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker: () => workers.shift() ?? recoveredWorker,
    });

    const capture = observer.captureWithin(1_500);
    await vi.advanceTimersByTimeAsync(100);

    await expect(capture).resolves.toBe(recoveredSnapshot);
    expect(failedWorker.capture).toHaveBeenCalledTimes(1);
    expect(recoveredWorker.capture).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("does not start a fallback probe after the teardown snapshot budget expires", async () => {
    vi.useFakeTimers();
    const stalledCapture = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => stalledCapture.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsTeardownProcessSnapshotObserver({ createWorker });

    const capture = observer.captureWithin(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(capture).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(observer.lastFailure?.()).toEqual({ kind: "deadline", elapsedMs: 500 });
    observer.dispose();
  });
});
