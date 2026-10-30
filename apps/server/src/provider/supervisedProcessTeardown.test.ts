import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "@synara/shared/processRuntime";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import * as windowsSnapshots from "../platform/windowsProcessSnapshot";
import { defaultProcessTreeKiller } from "../platform/processTreeController";

import type {
  CapturedProcess,
  CapturedProcessTree,
  ProcessTreeKiller,
  TerminalKillSignal,
} from "../terminal/processTreeKiller";
import {
  ProviderProcessExitUnprovenError,
  prepareChildProcessTree,
  prepareEffectProcessTree,
  spawnChildWithPreparedTree,
  teardownChildProcessTree,
  teardownEffectProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("child-owned Windows snapshot preparation", () => {
  const child = () =>
    Object.assign(new EventEmitter(), {
      pid: 99123,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
  const observer = (): windowsSnapshots.TeardownProcessChildrenSnapshotObserver => ({
    prepareWithin: vi.fn(async () => {}),
    assertReady: vi.fn(),
    capture: vi.fn(async () => new Map()),
    captureWithin: vi.fn(async () => new Map()),
    retryDelayMs: () => 0,
    dispose: vi.fn(),
  });

  it("prepares an Effect owner's worker before use and releases it after its child finalizer", async () => {
    const ready = deferred<void>();
    const prepared = observer();
    prepared.prepareWithin = vi.fn(() => ready.promise);
    const use = vi.fn();
    const order: string[] = [];
    const teardown = vi.fn<typeof teardownProviderProcessTree>(
      async (_input, dependencies = {}) => {
        expect(dependencies.windowsSnapshotObserver).toBe(prepared);
        expect(prepared.dispose).not.toHaveBeenCalled();
        order.push("child-exit-proven");
        return { escalated: false, signalErrors: [] };
      },
    );
    prepared.dispose = vi.fn(() => order.push("observer-disposed"));
    const owned = { pid: 99123, exitCode: Effect.succeed(0) };
    const program = Effect.runPromise(
      Effect.gen(function* () {
        const windowsSnapshotObserver = yield* prepareEffectProcessTree({
          platform: "win32",
          createObserver: () => prepared,
        });
        use();
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            teardownEffectProcessTree(owned, teardown, {
              ...(windowsSnapshotObserver ? { windowsSnapshotObserver } : {}),
            }),
          ),
        );
      }).pipe(Effect.scoped),
    );
    await Promise.resolve();
    expect(use).not.toHaveBeenCalled();
    expect(prepared.capture).not.toHaveBeenCalled();
    expect(prepared.prepareWithin).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));
    ready.resolve(undefined);
    await program;
    expect(use).toHaveBeenCalledOnce();
    expect(order).toEqual(["child-exit-proven", "observer-disposed"]);
    expect(prepared.dispose).toHaveBeenCalledOnce();
  });

  it.each(["initialization", "spawn", "teardown"])(
    "releases an Effect owner's worker on %s failure and keeps the failure observable",
    async (phase) => {
      const prepared = observer();
      const failure = new Error(phase);
      prepared.prepareWithin = vi.fn(async () => {
        if (phase === "initialization") throw failure;
      });
      const use = vi.fn();
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const windowsSnapshotObserver = yield* prepareEffectProcessTree({
            platform: "win32",
            createObserver: () => prepared,
          });
          use();
          if (phase === "spawn") return yield* Effect.fail(failure);
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              teardownEffectProcessTree(
                { pid: 99123, exitCode: Effect.succeed(0) },
                async () => {
                  throw failure;
                },
                { ...(windowsSnapshotObserver ? { windowsSnapshotObserver } : {}) },
              ),
            ),
          );
        }).pipe(Effect.scoped),
      );
      expect(result._tag).toBe("Failure");
      expect(use).toHaveBeenCalledTimes(phase === "initialization" ? 0 : 1);
      expect(prepared.dispose).toHaveBeenCalledOnce();
      expect(prepared.capture).not.toHaveBeenCalled();
    },
  );

  it("keeps non-Windows and custom Effect teardown owners free of native helpers", async () => {
    const createObserver = vi.fn(observer);
    for (const options of [
      { platform: "linux" as const },
      { platform: "win32" as const, enabled: false },
    ]) {
      await expect(
        Effect.runPromise(
          prepareEffectProcessTree({ ...options, createObserver }).pipe(Effect.scoped),
        ),
      ).resolves.toBeUndefined();
    }
    expect(createObserver).not.toHaveBeenCalled();
  });

  it("waits for initialization before spawning, then binds listeners synchronously without capturing", async () => {
    const ready = deferred<void>();
    const prepared = observer();
    prepared.prepareWithin = vi.fn(() => ready.promise);
    const owned = child();
    const onError = vi.fn();
    const spawn = vi.fn(() => owned);
    const binding = spawnChildWithPreparedTree({
      platform: "win32",
      createObserver: () => prepared,
      spawn,
      beforeSpawn: vi.fn(),
      bind: (process) => {
        process.on("error", onError);
        return process;
      },
    });
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();
    expect(prepared.prepareWithin).toHaveBeenCalledWith(10_000, undefined);
    expect(prepared.capture).not.toHaveBeenCalled();
    ready.resolve(undefined);
    expect(await binding).toBe(owned);
    owned.emit("error", new Error("normal spawn handler"));
    expect(onError).toHaveBeenCalledOnce();
    expect(prepared.dispose).toHaveBeenCalledOnce();
  });

  it.each(["initialization", "cancel", "guard", "spawn"])(
    "releases readiness ownership on %s failure",
    async (mode) => {
      const prepared = observer();
      const abort = new AbortController();
      const spawn = vi.fn(() => {
        if (mode === "spawn") throw new Error(mode);
        return child();
      });
      prepared.prepareWithin = vi.fn(async () => {
        if (mode === "initialization") throw new Error(mode);
        if (mode === "cancel") abort.abort(new Error(mode));
      });
      await expect(
        spawnChildWithPreparedTree({
          platform: "win32",
          signal: abort.signal,
          createObserver: () => prepared,
          spawn,
          beforeSpawn: () => {
            if (mode === "guard") throw new Error(mode);
          },
          bind: () => {
            throw new Error("binding must not run");
          },
        }),
      ).rejects.toThrow(mode);
      expect(spawn).toHaveBeenCalledTimes(mode === "spawn" ? 1 : 0);
      expect(prepared.dispose).toHaveBeenCalledOnce();
      expect(prepared.capture).not.toHaveBeenCalled();
    },
  );

  it("skips preparation for non-Windows and custom teardown owners", async () => {
    const createObserver = vi.fn(observer);
    for (const options of [
      { platform: "linux" as const },
      { platform: "win32" as const, enabled: false },
    ]) {
      const owned = child();
      await expect(
        spawnChildWithPreparedTree({
          ...options,
          createObserver,
          spawn: () => owned,
          beforeSpawn: () => {},
          bind: (process) => process,
        }),
      ).resolves.toBe(owned);
    }
    expect(createObserver).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)(
    "cleans a spawned child after binding fails on %s without using OS signals",
    async (platform) => {
      const owned = child();
      const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
      const bindingError = new Error("binding failed");
      await expect(
        spawnChildWithPreparedTree({
          platform,
          enabled: false,
          teardownProcessTree: teardown,
          spawn: () => owned,
          beforeSpawn: () => {},
          bind: () => {
            throw bindingError;
          },
        }),
      ).rejects.toBe(bindingError);
      expect(teardown).toHaveBeenCalledOnce();
      expect(owned.listenerCount("error")).toBe(0);
    },
  );

  it("keeps binding and unknown-PID cleanup failures without signaling any PID", async () => {
    const owned = Object.assign(child(), { pid: undefined });
    const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
    const bindingError = new Error("binding failed");
    const result = await spawnChildWithPreparedTree({
      enabled: false,
      teardownProcessTree: teardown,
      spawn: () => owned,
      beforeSpawn: () => {},
      bind: () => {
        throw bindingError;
      },
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(bindingError);
    expect(teardown).not.toHaveBeenCalled();
    expect(owned.listenerCount("error")).toBe(0);
  });

  it("observes a real asynchronous spawn error when binding fails, with no PID to signal", async () => {
    const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
    const bindingError = new Error("binding failed");
    const result = await spawnChildWithPreparedTree({
      enabled: false,
      teardownProcessTree: teardown,
      spawn: () =>
        spawnProcess(path.join(os.tmpdir(), `missing-moss-process-${randomUUID()}.exe`), [], {
          stdio: "pipe",
        }),
      beforeSpawn: () => {},
      bind: () => {
        throw bindingError;
      },
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      bindingError,
      expect.objectContaining({ code: "ENOENT" }),
    ]);
    expect(teardown).not.toHaveBeenCalled();
  });

  it.each(["exit", "error"] as const)(
    "owns one observer and releases only that owner on %s",
    (event) => {
      const first = child(),
        second = child();
      first.on("error", () => {});
      const firstObserver = observer(),
        secondObserver = observer();
      const createObserver = vi.fn(() => firstObserver);
      prepareChildProcessTree(first, { platform: "win32", createObserver });
      prepareChildProcessTree(first, { platform: "win32", createObserver });
      prepareChildProcessTree(second, { platform: "win32", createObserver: () => secondObserver });
      expect(createObserver).toHaveBeenCalledOnce();
      expect(firstObserver.capture).not.toHaveBeenCalled();
      first.emit(event);
      expect(firstObserver.dispose).toHaveBeenCalledOnce();
      expect(secondObserver.dispose).not.toHaveBeenCalled();
      second.emit("exit");
      expect(secondObserver.dispose).toHaveBeenCalledOnce();
    },
  );

  it("creates no observer for non-Windows, a failed spawn, or an already exited root", () => {
    const createObserver = vi.fn(observer);
    prepareChildProcessTree(child(), { platform: "linux", createObserver });
    prepareChildProcessTree(Object.assign(child(), { pid: undefined }), {
      platform: "win32",
      createObserver,
    });
    prepareChildProcessTree(Object.assign(child(), { exitCode: 0 }), {
      platform: "win32",
      createObserver,
    });
    expect(createObserver).not.toHaveBeenCalled();
  });

  it("shares overlapping stop ownership and disposes the worker only after teardown settles", async () => {
    const owned = child(),
      prepared = observer();
    prepareChildProcessTree(owned, { platform: "win32", createObserver: () => prepared });
    const finish = deferred<{ escalated: boolean; signalErrors: Error[] }>();
    const teardown = vi.fn(() => finish.promise);
    const first = teardownChildProcessTree(owned, teardown);
    const second = teardownChildProcessTree(owned, teardown);
    owned.emit("exit");
    expect(teardown).toHaveBeenCalledOnce();
    expect(prepared.dispose).not.toHaveBeenCalled();
    finish.resolve({ escalated: false, signalErrors: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { escalated: false, signalErrors: [] },
      { escalated: false, signalErrors: [] },
    ]);
    expect(prepared.dispose).toHaveBeenCalledOnce();
  });

  it("releases the owned worker when teardown rejects without claiming exit proof", async () => {
    const owned = child(),
      prepared = observer();
    prepareChildProcessTree(owned, { platform: "win32", createObserver: () => prepared });
    await expect(
      teardownChildProcessTree(owned, async () => {
        throw new Error("exit unproven");
      }),
    ).rejects.toThrow("exit unproven");
    expect(prepared.dispose).toHaveBeenCalledOnce();
  });

  it("uses a fresh three-second capture from the prepared observer and leaves disposal with its owner", async () => {
    const prepared = observer();
    const rootExit = deferred<void>();
    const createObserver = vi.spyOn(
      windowsSnapshots,
      "createWindowsTeardownProcessSnapshotObserver",
    );
    vi.spyOn(defaultProcessTreeKiller, "signal").mockImplementation(() =>
      rootExit.resolve(undefined),
    );
    try {
      const result = await teardownProviderProcessTree(
        { rootPid: 91, rootExited: rootExit.promise },
        {
          platform: "win32",
          windowsSnapshotObserver: prepared,
          isRootRunning: async () => true,
          ...deterministicClock(),
        },
      );
      expect(result.capturedBeforeRootExit).toBe(true);
      expect(prepared.captureWithin).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(createObserver).not.toHaveBeenCalled();
      expect(prepared.dispose).not.toHaveBeenCalled();
    } finally {
      prepared.dispose();
      vi.restoreAllMocks();
    }
  });
});

describe("teardownProviderProcessTree", () => {
  it("starts the proof budget after the bounded Windows signal helper has completed", async () => {
    const delivered = deferred<void>();
    const rootExit = deferred<void>();
    const clock = deterministicClock();
    const signal = vi.fn(() => delivered.promise);
    const inspect = vi.fn(() => ({ verified: true, survivors: [] }));
    const settled = vi.fn();
    const teardown = teardownProviderProcessTree(
      { rootPid: 91, rootExited: rootExit.promise, termGraceMs: 5, forceExitMs: 5, pollMs: 1 },
      {
        platform: "win32",
        processTreeKiller: {
          capture: () => ({ descendants: [], captureComplete: true }),
          inspect,
          signal,
        },
        isRootRunning: async () => true,
        ...clock,
      },
    ).then((result) => {
      settled();
      return result;
    });
    await vi.waitFor(() => expect(signal).toHaveBeenCalledOnce());
    await clock.sleep(4_000);
    expect(settled).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    rootExit.resolve(undefined);
    delivered.resolve(undefined);
    await expect(teardown).resolves.toMatchObject({
      escalated: false,
      capturedBeforeRootExit: true,
    });
    expect(signal).toHaveBeenCalledOnce();
  });

  it("retains the initial snapshot failure when a later probe changes its diagnostic", async () => {
    const rootExit = deferred<void>();
    let diagnostic: windowsSnapshots.WindowsSnapshotFailure = {
      kind: "query",
      elapsedMs: 40,
      phase: "serialization",
      phaseElapsedMs: 12,
    };
    const observer: windowsSnapshots.TeardownProcessChildrenSnapshotObserver = {
      capture: async () => null,
      captureWithin: async () => null,
      retryDelayMs: () => 0,
      lastFailure: () => diagnostic,
      dispose: vi.fn(),
    };
    vi.spyOn(windowsSnapshots, "createWindowsTeardownProcessSnapshotObserver").mockReturnValue(
      observer,
    );
    vi.spyOn(defaultProcessTreeKiller, "signal").mockImplementation(() =>
      rootExit.resolve(undefined),
    );
    try {
      const error = await teardownProviderProcessTree(
        { rootPid: 91, rootExited: rootExit.promise, termGraceMs: 5, forceExitMs: 5, pollMs: 1 },
        {
          platform: "win32",
          isRootRunning: async () => {
            diagnostic = { kind: "deadline", elapsedMs: 250 };
            return false;
          },
          ...deterministicClock(),
        },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderProcessExitUnprovenError);
      expect(error).toMatchObject({
        rootExited: true,
        captureComplete: false,
        remainingDescendantPids: null,
        snapshotFailure: {
          kind: "query",
          elapsedMs: 40,
          phase: "serialization",
          phaseElapsedMs: 12,
        },
      });
      expect((error as Error).message).toContain("snapshotFailure=query, snapshotElapsedMs=40");
      expect((error as Error).message).toContain(
        "snapshotPhase=serialization, snapshotPhaseElapsedMs=12",
      );
      expect(observer.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(["linux", "win32"] as const)(
    "does not certify cleanup when the OS root is gone before its exit notification on %s",
    async (platform) => {
      const rootExit = deferred<void>();
      const tree: CapturedProcessTree = { descendants: [], captureComplete: true };
      const result = await teardownProviderProcessTree(
        { rootPid: 91, rootExited: rootExit.promise },
        {
          platform,
          isRootRunning: async () => false,
          processTreeKiller: {
            capture: () => tree,
            inspect: () => ({ verified: true, survivors: [] }),
            signal: () => rootExit.resolve(undefined),
          },
          ...deterministicClock(),
        },
      );
      expect(result.capturedBeforeRootExit).toBe(false);
    },
  );

  it("does not certify cleanup if the native liveness probe fails", async () => {
    const rootExit = deferred<void>();
    const result = await teardownProviderProcessTree(
      { rootPid: 91, rootExited: rootExit.promise },
      {
        isRootRunning: async () => {
          throw new Error("process table unavailable");
        },
        processTreeKiller: {
          capture: () => ({ descendants: [], captureComplete: true }),
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => rootExit.resolve(undefined),
        },
        ...deterministicClock(),
      },
    );
    expect(result.capturedBeforeRootExit).toBe(false);
  });

  it.each(["linux", "win32"] as const)(
    "does not certify a pre-exit capture when the root exits during the initial snapshot on %s",
    async (platform) => {
      const tree: CapturedProcessTree = { descendants: [], captureComplete: true };
      const captureStarted = deferred<void>();
      const capturedTree = deferred<CapturedProcessTree>();
      const rootExit = deferred<void>();
      const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> =
        [];
      const clock = deterministicClock();

      const teardown = teardownProviderProcessTree(
        { rootPid: 91, rootExited: rootExit.promise, termGraceMs: 5, forceExitMs: 5, pollMs: 1 },
        {
          platform,
          captureProcessTree: async () => {
            captureStarted.resolve(undefined);
            return capturedTree.promise;
          },
          inspectProcessTree: async () => ({ verified: true, survivors: [] }),
          processTreeKiller: {
            capture: () => tree,
            signal: ({ signal, includeRootTree }) => {
              signals.push({ signal, includeRootTree });
            },
          },
          ...clock,
        },
      );

      await captureStarted.promise;
      rootExit.resolve(undefined);
      await Promise.resolve();
      capturedTree.resolve(tree);

      await expect(teardown).resolves.toEqual({
        escalated: false,
        signalErrors: [],
        capturedBeforeRootExit: false,
      });
      expect(signals).toEqual([{ signal: "SIGTERM", includeRootTree: false }]);
    },
  );

  it("does not certify an empty PPID snapshot collected after root exit", async () => {
    // An orphan can still run under init even though PPID traversal from the
    // former provider root returns an empty, complete snapshot.
    const tree: CapturedProcessTree = { descendants: [], captureComplete: true };
    const result = await teardownProviderProcessTree(
      { rootPid: 91, rootExited: Promise.resolve() },
      {
        platform: "linux",
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        ...deterministicClock(),
      },
    );
    expect(result.capturedBeforeRootExit).toBe(false);
  });

  it("escalates ignored TERM and returns only after root and descendants prove exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 102, command: "provider-worker" }],
      captureComplete: true,
    };
    const runningDescendants = new Map<number, CapturedProcess>([[102, tree.descendants[0]!]]);
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({ verified: true, survivors: [...runningDescendants.values()] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGKILL") {
          runningDescendants.clear();
          resolveRootExit?.();
        }
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 101, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          isRootRunning: async () => true,
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [], capturedBeforeRootExit: true });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: true },
      { signal: "SIGKILL", includeRootTree: true },
    ]);
  });

  it("force-kills captured descendants without re-signalling a root that exited after TERM", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 202, command: "provider-grandchild" }],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({
        verified: true,
        survivors: descendantsRunning ? tree.descendants : [],
      }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 201, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          isRootRunning: async () => true,
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [], capturedBeforeRootExit: true });
    expect(signals.at(-1)).toEqual({ signal: "SIGKILL", includeRootTree: false });
  });

  it("re-verifies Windows descendants before force and signals only current identities", async () => {
    const child: CapturedProcess = {
      pid: 802,
      command: "provider-child.exe",
      startedAt: "20260901100000.000000+000",
    };
    const grandchild: CapturedProcess = {
      pid: 803,
      command: "provider-grandchild.exe",
      startedAt: "20260901100001.000000+000",
    };
    const tree: CapturedProcessTree = {
      descendants: [child, grandchild],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{
      signal: TerminalKillSignal;
      includeRootTree: boolean | undefined;
      verifiedDescendants: boolean | undefined;
      descendants: ReadonlyArray<CapturedProcess>;
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      signal: ({ signal, includeRootTree, verifiedDescendants, tree: signalTree }) => {
        signals.push({
          signal,
          includeRootTree,
          verifiedDescendants,
          descendants: [...signalTree.descendants],
        });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 801, rootExited, termGraceMs: 5, forceExitMs: 5, pollMs: 5 },
        {
          platform: "win32",
          isRootRunning: async () => true,
          processTreeKiller,
          captureProcessTree: async () => tree,
          inspectProcessTree: async () => ({
            verified: true,
            // The child PID was reused during the grace period; only the
            // original grandchild still matches its CIM creation identity.
            survivors: descendantsRunning ? [grandchild] : [],
          }),
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [], capturedBeforeRootExit: true });

    expect(signals.at(-1)).toEqual({
      signal: "SIGKILL",
      includeRootTree: false,
      verifiedDescendants: true,
      descendants: [grandchild],
    });
  });

  it("does not accept root exit as descendant proof when the snapshot failed", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: false };
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 401,
        rootExited: Promise.resolve(),
        termGraceMs: 10,
        forceExitMs: 10,
        pollMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: ({ signal, includeRootTree }) => {
            signals.push({ signal, includeRootTree });
          },
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 401,
      rootExited: true,
      captureComplete: false,
      remainingDescendantPids: null,
    });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: false },
      { signal: "SIGKILL", includeRootTree: false },
    ]);
  });

  it("still fails closed on an incomplete snapshot when the root never proves exit", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: false };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 501, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({ rootPid: 501, rootExited: false, captureComplete: false });
  });

  it("fails closed when forced termination cannot prove process-tree exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 302, command: "stuck-provider" }],
      captureComplete: true,
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 301, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: tree.descendants }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      name: "ProviderProcessExitUnprovenError",
      rootPid: 301,
      rootExited: false,
      remainingDescendantPids: [302],
    });
  });

  it("does not scan descendants before the root proves exit", async () => {
    // Descendant identity cannot end the wait until the root has exited, so
    // scanning beforehand only blocks the event loop. Failure details can use
    // the already captured descendants without another process-table read.
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 602, command: "stuck-provider" }],
      captureComplete: true,
    };
    let inspectCalls = 0;
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 601,
        rootExited: new Promise(() => undefined),
        termGraceMs: 500,
        forceExitMs: 500,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return { verified: true, survivors: tree.descendants };
          },
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(inspectCalls).toBe(0);
    expect(failure).toMatchObject({ remainingDescendantPids: [602] });
  });

  it("throttles descendant scans instead of running one per poll", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 702, command: "provider-worker" }],
      captureComplete: true,
    };
    let inspectCalls = 0;
    let sleepCalls = 0;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    let now = 0;

    await teardownProviderProcessTree(
      {
        rootPid: 701,
        rootExited,
        termGraceMs: 1_000,
        forceExitMs: 1_000,
        pollMs: 25,
        inspectIntervalMs: 250,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return { verified: true, survivors: tree.descendants };
          },
          signal: ({ signal }) => {
            if (signal === "SIGTERM") resolveRootExit?.();
          },
        },
        now: () => now,
        sleep: async (milliseconds: number) => {
          sleepCalls += 1;
          now += milliseconds;
        },
      },
    ).catch(() => undefined);

    // The root exits immediately, so every poll used to trigger its own `ps`.
    expect(sleepCalls).toBeGreaterThan(60);
    expect(inspectCalls).toBeLessThanOrEqual(sleepCalls / 4);
  });

  it("rechecks descendants after the final wait before reporting failure", async () => {
    const descendant = { pid: 902, command: "provider-worker" };
    const tree: CapturedProcessTree = {
      descendants: [descendant],
      captureComplete: true,
    };
    let descendantRunning = true;
    const signals: TerminalKillSignal[] = [];
    let now = 0;

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 901,
          rootExited: Promise.resolve(),
          termGraceMs: 5,
          forceExitMs: 5,
          pollMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => tree,
            inspect: () => ({
              verified: true,
              survivors: descendantRunning ? [descendant] : [],
            }),
            signal: ({ signal }) => {
              signals.push(signal);
            },
          },
          now: () => now,
          sleep: async (milliseconds) => {
            descendantRunning = false;
            now += milliseconds;
          },
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [], capturedBeforeRootExit: false });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("preserves the last verified survivors when the final recheck is unverified", async () => {
    const descendant = { pid: 912, command: "provider-worker" };
    const tree: CapturedProcessTree = {
      descendants: [descendant],
      captureComplete: true,
    };
    let inspectCalls = 0;
    let now = 0;

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 911,
        rootExited: Promise.resolve(),
        termGraceMs: 5,
        forceExitMs: 5,
        pollMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return inspectCalls % 2 === 1
              ? { verified: true, survivors: [descendant] }
              : { verified: false, survivors: [] };
          },
          signal: () => undefined,
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ remainingDescendantPids: [912] });
  });
});
