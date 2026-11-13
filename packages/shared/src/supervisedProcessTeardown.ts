// FILE: supervisedProcessTeardown.ts
// Purpose: Owns graceful, forced, and verified teardown for provider/runtime process trees.
// Layer: Shared platform runtime

import { Duration, Effect, type Scope } from "effect";
import type { ChildProcess } from "node:child_process";
import { didProcessFailToSpawn } from "@moss/shared/processRuntime";

import {
  captureProcessTree,
  defaultProcessTreeKiller,
  inspectProcessTree,
  isProcessRunning,
  signalOwnedChildProcess,
  signalProcessTree,
  type CapturedProcess,
  type CapturedProcessTree,
  type CapturedProcessTreeInspection,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "./processTreeController";
import {
  createWindowsTeardownProcessSnapshotObserver,
  WINDOWS_PROCESS_TREE_CAPTURE_TIMEOUT_MS,
  type TeardownProcessChildrenSnapshotObserver,
  type WindowsSnapshotFailure,
} from "./windowsProcessSnapshot";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;
const DEFAULT_INSPECT_INTERVAL_MS = 250;
const FINAL_PROOF_INSPECTION_MAX_MS = 250;

export interface SupervisedProcessTeardownInput {
  readonly rootPid: number;
  /** Must resolve only after the owned root process has emitted its terminal exit. */
  readonly rootExited: Promise<unknown>;
  /**
   * Terminates the root through the caller's own process handle. Node holds that
   * handle open until the exit is reaped, so this cannot reach a reused PID. On
   * Windows the tree helper (taskkill) is otherwise the only thing that stops the
   * root, and on a busy machine it can time out without delivering anything.
   */
  readonly terminateRoot?: () => void;
  readonly termGraceMs?: number;
  readonly forceExitMs?: number;
  readonly pollMs?: number;
  readonly inspectIntervalMs?: number;
}

export interface ProcessExitHandle {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface EffectProcessExitHandle {
  readonly pid: number;
  readonly exitCode: Effect.Effect<unknown, unknown>;
  /**
   * The spawner's own kill. On Windows it runs its tree kill and, when that
   * fails, terminates the child through the spawner's handle, never by a PID
   * this module chose.
   */
  kill?(options?: { readonly killSignal?: "SIGKILL" }): Effect.Effect<void, unknown>;
}

export interface SupervisedProcessTeardownResult {
  readonly escalated: boolean;
  readonly signalErrors: ReadonlyArray<Error>;
  /** Only true when the initial descendant snapshot completed before root exit. */
  readonly capturedBeforeRootExit?: boolean;
}

export interface SupervisedProcessTeardownDependencies {
  /** Observe/veto the ownership snapshot before any process is signalled. */
  readonly onCapturedTree?: (tree: CapturedProcessTree, capturedBeforeRootExit: boolean) => void;
  readonly platform: NodeJS.Platform;
  readonly processTreeKiller: ProcessTreeKiller;
  readonly captureProcessTree: (rootPid: number) => Promise<CapturedProcessTree>;
  readonly inspectProcessTree: (
    tree: CapturedProcessTree,
  ) => Promise<CapturedProcessTreeInspection>;
  /** Fresh native liveness observation, taken after the descendant snapshot. */
  readonly isRootRunning: (rootPid: number) => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Borrowed from this child's owner; the caller disposes it after teardown. */
  readonly windowsSnapshotObserver?: TeardownProcessChildrenSnapshotObserver;
}

interface PreparedChildObserver {
  readonly observer: TeardownProcessChildrenSnapshotObserver;
  readonly detach: () => void;
  teardown?: Promise<SupervisedProcessTeardownResult>;
}
const preparedChildObservers = new WeakMap<ProcessExitHandle, PreparedChildObserver>();
// Bound cold PowerShell/CIM initialization separately from fresh query and exit-proof windows.
export const WINDOWS_OBSERVER_STARTUP_TIMEOUT_MS = 30_000;

// Each agent launch waits for its own observer (a PowerShell worker with CIM loaded) before it
// spawns. On a busy PC that wait measured 0.8–6.9 s, so the server keeps one observer warmed in
// advance: a launch takes it ready, and a replacement starts a few seconds later, off the
// critical path. Only the server process turns this on, and it disposes the spare on exit.
const WARM_OBSERVER_REFILL_DELAY_MS = 5_000;
let warmObserversEnabled = false;
let warmObserver: TeardownProcessChildrenSnapshotObserver | null = null;
let warmRefillTimer: ReturnType<typeof setTimeout> | null = null;

function startWarmObserver(): TeardownProcessChildrenSnapshotObserver {
  const observer = createWindowsTeardownProcessSnapshotObserver({ startImmediately: true });
  observer.prepareWithin?.(WINDOWS_OBSERVER_STARTUP_TIMEOUT_MS).catch(() => {
    // A launch that already took it handles readiness itself; only a parked spare is dropped.
    if (warmObserver !== observer) return;
    warmObserver = null;
    observer.dispose();
  });
  return observer;
}

function scheduleWarmObserverRefill(): void {
  if (!warmObserversEnabled || warmObserver !== null || warmRefillTimer !== null) return;
  warmRefillTimer = setTimeout(() => {
    warmRefillTimer = null;
    if (!warmObserversEnabled || warmObserver !== null) return;
    warmObserver = startWarmObserver();
  }, WARM_OBSERVER_REFILL_DELAY_MS);
  warmRefillTimer.unref?.();
}

/** The observer for a child about to spawn: the warmed spare when one is parked. */
function takeWindowsTeardownObserver(): TeardownProcessChildrenSnapshotObserver {
  const spare = warmObserver;
  warmObserver = null;
  scheduleWarmObserverRefill();
  return spare ?? createWindowsTeardownProcessSnapshotObserver({ startImmediately: true });
}

/** Server startup on Windows: keep one launch observer warmed from now on. */
export function enableWarmWindowsTeardownObservers(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  warmObserversEnabled = true;
  scheduleWarmObserverRefill();
}

/** Server exit: stop refilling and close the parked observer's PowerShell worker. */
export function disposeWarmWindowsTeardownObservers(): void {
  warmObserversEnabled = false;
  if (warmRefillTimer !== null) clearTimeout(warmRefillTimer);
  warmRefillTimer = null;
  const spare = warmObserver;
  warmObserver = null;
  spare?.dispose();
}

/** Test seam: whether a warmed observer is parked. */
export function hasWarmWindowsTeardownObserver(): boolean {
  return warmObserver !== null;
}

/** Initialize a child owner's worker before spawn; capture only fresh rows during teardown. */
export function prepareEffectProcessTree(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly enabled?: boolean;
    readonly createObserver?: () => TeardownProcessChildrenSnapshotObserver;
  } = {},
): Effect.Effect<TeardownProcessChildrenSnapshotObserver | undefined, Error, Scope.Scope> {
  if (options.enabled === false || (options.platform ?? process.platform) !== "win32")
    return Effect.succeed(undefined);
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async (signal) => {
        const observer = options.createObserver?.() ?? takeWindowsTeardownObserver();
        try {
          if (!observer.prepareWithin || !observer.assertReady)
            throw new Error("Windows process observer cannot establish readiness.");
          await observer.prepareWithin(WINDOWS_OBSERVER_STARTUP_TIMEOUT_MS, signal);
          signal.throwIfAborted();
          observer.assertReady();
          return observer;
        } catch (error) {
          observer.dispose();
          throw error;
        }
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
    (observer) => Effect.sync(() => observer.dispose()),
  );
}

/** Bind normal process listeners in the same stack as spawn, before yielding the child. */
export async function spawnChildWithPreparedTree<TChild extends ChildProcess, T>(options: {
  readonly spawn: () => TChild;
  readonly bind: (child: TChild) => T;
  readonly beforeSpawn: () => void;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly enabled?: boolean;
  readonly createObserver?: () => TeardownProcessChildrenSnapshotObserver;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
}): Promise<T> {
  let observer: TeardownProcessChildrenSnapshotObserver | undefined;
  let child: TChild | undefined;
  let transferred = false;
  try {
    options.signal?.throwIfAborted();
    if (options.enabled !== false && (options.platform ?? process.platform) === "win32") {
      observer = options.createObserver?.() ?? takeWindowsTeardownObserver();
      if (!observer.prepareWithin || !observer.assertReady)
        throw new Error("Windows process observer cannot establish readiness.");
      await observer.prepareWithin(WINDOWS_OBSERVER_STARTUP_TIMEOUT_MS, options.signal);
    }
    options.signal?.throwIfAborted();
    options.beforeSpawn();
    observer?.assertReady?.();
    child = options.spawn();
    if (observer) {
      const prepared = observer;
      prepareChildProcessTree(child, { platform: "win32", createObserver: () => prepared });
      transferred = preparedChildObservers.get(child)?.observer === observer;
    }
    // No await between spawn and bind: Node's asynchronous spawn-error event
    // must reach the regular owner handler, not an error-swallowing placeholder.
    return options.bind(child);
  } catch (error) {
    if (child) {
      // bind failed before the regular owner's listeners could be guaranteed.
      // Keep the original failure, and observe (rather than swallow) a possible
      // asynchronous Node spawn error while retiring this exact owned handle.
      let spawnError: Error | undefined;
      const onError = (cause: Error) => {
        spawnError = cause;
      };
      child.on("error", onError);
      try {
        if (child.pid === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
        await teardownChildProcessTree(child, options.teardownProcessTree);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, ...(spawnError ? [spawnError] : []), cleanupError],
          "Codex process binding failed and owned cleanup could not be proven.",
        );
      } finally {
        child.removeListener("error", onError);
      }
      if (spawnError)
        throw new AggregateError([error, spawnError], "Codex process binding and spawn failed.");
    }
    throw error;
  } finally {
    if (!transferred) observer?.dispose();
  }
}

/** Prepare only a worker, never a cached process tree or an exit-proof result. */
export function prepareChildProcessTree(
  child: ChildProcess,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly createObserver?: () => TeardownProcessChildrenSnapshotObserver;
  } = {},
): void {
  if (
    (options.platform ?? process.platform) !== "win32" ||
    child.pid === undefined ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 1 ||
    child.pid === process.pid ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    preparedChildObservers.has(child)
  )
    return;
  const observer =
    options.createObserver?.() ??
    createWindowsTeardownProcessSnapshotObserver({ startImmediately: true });
  const detach = () => {
    child.removeListener("exit", release);
    child.removeListener("error", release);
  };
  const entry: PreparedChildObserver = { observer, detach };
  const release = () => {
    if (preparedChildObservers.get(child) !== entry || entry.teardown) return;
    preparedChildObservers.delete(child);
    detach();
    observer.dispose();
  };
  preparedChildObservers.set(child, entry);
  child.once("exit", release);
  child.once("error", release);
}

export class ProviderProcessExitUnprovenError extends Error {
  readonly rootPid: number;
  readonly rootExited: boolean;
  readonly remainingDescendantPids: ReadonlyArray<number> | null;
  readonly captureComplete: boolean;
  readonly snapshotFailure: WindowsSnapshotFailure | undefined;
  readonly signalErrors: ReadonlyArray<Error>;

  constructor(input: {
    readonly rootPid: number;
    readonly rootExited: boolean;
    readonly remainingDescendantPids: ReadonlyArray<number> | null;
    readonly captureComplete: boolean;
    readonly snapshotFailure?: WindowsSnapshotFailure;
    readonly signalErrors?: ReadonlyArray<Error>;
  }) {
    const descendantDetail =
      input.remainingDescendantPids === null
        ? "descendant state could not be verified"
        : input.remainingDescendantPids.length > 0
          ? `descendants still running: ${input.remainingDescendantPids.join(", ")}`
          : "no captured descendants remain";
    super(
      `Provider process tree ${input.rootPid} did not prove exit ` +
        `(rootExited=${String(input.rootExited)}, captureComplete=${String(input.captureComplete)}; ${descendantDetail})` +
        (input.snapshotFailure
          ? `; snapshotFailure=${input.snapshotFailure.kind}, snapshotElapsedMs=${input.snapshotFailure.elapsedMs}` +
            (input.snapshotFailure.phase
              ? `, snapshotPhase=${input.snapshotFailure.phase}, snapshotPhaseElapsedMs=${input.snapshotFailure.phaseElapsedMs}.`
              : ".")
          : ".") +
        // Which signal did not land (a timed-out taskkill, a denied PID) is the
        // first thing to know about a tree that would not stop.
        (input.signalErrors && input.signalErrors.length > 0
          ? ` Signal errors (${input.signalErrors.length}): ${input.signalErrors[0]!.message.replace(
              /\s+/g,
              " ",
            ).slice(0, 200)}`
          : ""),
    );
    this.name = "ProviderProcessExitUnprovenError";
    this.rootPid = input.rootPid;
    this.rootExited = input.rootExited;
    this.remainingDescendantPids = input.remainingDescendantPids;
    this.captureComplete = input.captureComplete;
    this.snapshotFailure = input.snapshotFailure;
    this.signalErrors = input.signalErrors ?? [];
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function waitForOwnedProcessExit(process: ProcessExitHandle): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => resolve();
    process.once("exit", onExit);
    if (process.exitCode !== null || process.signalCode !== null) {
      process.removeListener("exit", onExit);
      resolve();
    }
  });
}

function terminateOwnedRoot(process: ProcessExitHandle): void {
  // An exited handle has nothing to terminate (Node reports a late kill as ESRCH).
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill?.("SIGKILL");
}

export async function teardownChildProcessTree(
  process: ProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
  options: Pick<Partial<SupervisedProcessTeardownDependencies>, "onCapturedTree"> = {},
): Promise<SupervisedProcessTeardownResult> {
  const prepared = preparedChildObservers.get(process);
  if (prepared?.teardown) return prepared.teardown;
  prepared?.detach();
  const teardown = (async () => {
    try {
      if (process.pid === undefined) {
        // A witnessed Node spawn error proves there was no process tree to retire.
        // Unknown PID-less handles still fail closed.
        if (didProcessFailToSpawn(process)) return { escalated: false, signalErrors: [] };
        throw new Error("Cannot prove process exit because the spawned process has no PID.");
      }
      const input = {
        rootPid: process.pid,
        rootExited: waitForOwnedProcessExit(process),
        ...(typeof process.kill === "function"
          ? { terminateRoot: () => terminateOwnedRoot(process) }
          : {}),
      };
      const preparedObserver = prepared
        ? { windowsSnapshotObserver: prepared.observer }
        : undefined;
      // Hand the worker prepared at spawn to every teardown, not only this module's
      // own: the server's wrapper otherwise starts a cold PowerShell/CIM observer
      // inside the proof window, which is slowest exactly when the PC is busy.
      return await (teardownProcessTree === teardownProviderProcessTree
        ? teardownProcessTree(input, { ...options, ...preparedObserver })
        : preparedObserver
          ? teardownProcessTree(input, preparedObserver)
          : teardownProcessTree(input));
    } finally {
      if (prepared) {
        if (preparedChildObservers.get(process) === prepared)
          preparedChildObservers.delete(process);
        prepared.observer.dispose();
      }
    }
  })();
  if (prepared) prepared.teardown = teardown;
  return teardown;
}

/** Release only after tree proof where required; retain the direct POSIX SIGTERM order. */
export async function disposeOwnedChildProcess(
  child: ChildProcess,
  releaseResources: () => void,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly teardownProcessTree?: typeof teardownProviderProcessTree;
    readonly signalOwnedChildProcess?: typeof signalOwnedChildProcess;
  } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) === "win32") {
    await teardownChildProcessTree(child, options.teardownProcessTree);
    releaseResources();
    return;
  }
  releaseResources();
  (options.signalOwnedChildProcess ?? signalOwnedChildProcess)(child, "SIGTERM");
}

/** A native root exit still needs the owner's tree proof on platforms without POSIX signalling. */
export function completeObservedChildProcessExit<A, E, R>(
  ownerDisposal: Effect.Effect<A, E, R>,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<void, E, R> {
  return platform === "win32" ? ownerDisposal.pipe(Effect.asVoid) : Effect.void;
}

/** A last-resort root terminator through the Effect owner's kill, bounded so it never hangs. */
function effectRootTerminator(
  process: EffectProcessExitHandle,
  boundMs: number,
): { readonly terminateRoot?: () => void } {
  const kill = process.kill;
  if (typeof kill !== "function") return {};
  return {
    terminateRoot: () => {
      Effect.runFork(
        kill
          .call(process, { killSignal: "SIGKILL" })
          .pipe(Effect.timeoutOption(Duration.millis(boundMs)), Effect.ignore),
      );
    },
  };
}

export function teardownEffectProcessTree(
  process: EffectProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
  dependencies: Pick<SupervisedProcessTeardownDependencies, "windowsSnapshotObserver"> = {},
): Promise<SupervisedProcessTeardownResult> {
  return teardownProcessTree(
    {
      rootPid: Number(process.pid),
      rootExited: Effect.runPromise(Effect.exit(process.exitCode)),
      ...effectRootTerminator(process, DEFAULT_FORCE_EXIT_MS),
    },
    dependencies,
  );
}

/**
 * Force-stops an Effect child that owns its POSIX process group. Captured
 * descendants are killed first so a waiting shell can reap them before the
 * root/group is forced, then the captured identities are verified as gone.
 */
export async function forceTeardownEffectProcessTree(
  process: EffectProcessExitHandle,
  forceExitMs = DEFAULT_FORCE_EXIT_MS,
  /** Test seam for the Windows path. */
  dependencies: Partial<SupervisedProcessTeardownDependencies> = {},
): Promise<void> {
  const rootPid = Number(process.pid);
  const rootExitedPromise = Effect.runPromise(Effect.exit(process.exitCode));
  if ((dependencies.platform ?? globalThis.process.platform) === "win32") {
    // As in the main teardown: when taskkill did not end the root, the owner's
    // own kill does, as a last resort.
    await teardownProviderProcessTree(
      {
        rootPid,
        rootExited: rootExitedPromise,
        ...effectRootTerminator(process, forceExitMs),
        termGraceMs: 1,
        forceExitMs,
      },
      dependencies,
    );
    return;
  }

  const tree = await captureProcessTree(rootPid);
  const signalErrors: Error[] = [];
  signalProcessTree({
    rootPid,
    signal: "SIGKILL",
    tree,
    includeRootTree: false,
    onError: (error) => signalErrors.push(error),
  });

  let rootExited = false;
  void rootExitedPromise.then(() => {
    rootExited = true;
  });

  // A shell blocked in `wait` can now reap its killed child and exit itself.
  const reapDeadline = Date.now() + Math.min(100, forceExitMs);
  while (!rootExited && Date.now() < reapDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
  }

  if (!rootExited) {
    try {
      globalThis.process.kill(-rootPid, "SIGKILL");
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        signalErrors.push(cause instanceof Error ? cause : new Error(String(cause)));
      }
      try {
        globalThis.process.kill(rootPid, "SIGKILL");
      } catch (fallbackCause) {
        if ((fallbackCause as NodeJS.ErrnoException).code !== "ESRCH") {
          signalErrors.push(
            fallbackCause instanceof Error ? fallbackCause : new Error(String(fallbackCause)),
          );
        }
      }
    }
  }

  const deadline = Date.now() + forceExitMs;
  let remainingDescendants: ReadonlyArray<CapturedProcess> | null =
    tree.captureComplete === false ? null : tree.descendants;
  do {
    await Promise.resolve();
    const inspection = await inspectProcessTree(tree);
    remainingDescendants = inspection.verified ? inspection.survivors : null;
    if (rootExited && remainingDescendants?.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
  } while (Date.now() < deadline);

  throw new ProviderProcessExitUnprovenError({
    rootPid,
    rootExited,
    remainingDescendantPids: remainingDescendants?.map((descendant) => descendant.pid) ?? null,
    captureComplete: tree.captureComplete !== false,
  });
}

/**
 * Owns the complete process-tree stop sequence. Success means the exact root
 * emitted exit and every identity-matched descendant captured before TERM is gone.
 */
export async function teardownProviderProcessTree(
  input: SupervisedProcessTeardownInput,
  dependencies: Partial<SupervisedProcessTeardownDependencies> = {},
): Promise<SupervisedProcessTeardownResult> {
  if (!Number.isInteger(input.rootPid) || input.rootPid <= 0) {
    throw new TypeError(
      `Provider process root PID must be a positive integer, got ${input.rootPid}.`,
    );
  }

  const platform = dependencies.platform ?? process.platform;
  const processTreeKiller = dependencies.processTreeKiller ?? defaultProcessTreeKiller;
  const windowsObserver =
    platform === "win32" &&
    dependencies.captureProcessTree === undefined &&
    dependencies.inspectProcessTree === undefined &&
    dependencies.processTreeKiller === undefined
      ? (dependencies.windowsSnapshotObserver ?? createWindowsTeardownProcessSnapshotObserver())
      : null;
  const captureTree =
    dependencies.captureProcessTree ??
    (dependencies.processTreeKiller
      ? async (rootPid: number) => processTreeKiller.capture(rootPid)
      : async (rootPid: number) =>
          captureProcessTree(rootPid, {
            platform,
            ...(windowsObserver
              ? {
                  captureWindowsChildren: () =>
                    windowsObserver.captureWithin(WINDOWS_PROCESS_TREE_CAPTURE_TIMEOUT_MS),
                }
              : {}),
          }));
  const inspectTree = async (
    tree: CapturedProcessTree,
    timeoutMs: number,
  ): Promise<CapturedProcessTreeInspection> => {
    if (dependencies.inspectProcessTree) return dependencies.inspectProcessTree(tree);
    if (dependencies.processTreeKiller) {
      return (
        processTreeKiller.inspect?.(tree) ?? {
          verified: false,
          survivors: [...tree.descendants],
        }
      );
    }
    return inspectProcessTree(tree, {
      platform,
      ...(windowsObserver
        ? {
            captureWindowsChildren: () => windowsObserver.captureWithin(timeoutMs),
            ...(windowsObserver.capturePidsWithin
              ? {
                  captureWindowsPids: (pids: readonly number[]) =>
                    windowsObserver.capturePidsWithin!(pids, timeoutMs),
                }
              : {}),
          }
        : {}),
    });
  };
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  let rootExited = false;
  void input.rootExited.then(
    () => {
      rootExited = true;
    },
    () => {
      // A rejected watcher is not evidence that the owned process exited.
    },
  );
  // Let an already-settled root-exit promise update the observation before
  // deciding whether a numeric root PID may still be signalled. This matters
  // for retries after the root has exited: only retained descendants may be
  // considered, never a potentially reused root.
  await Promise.resolve();

  try {
    const tree = await captureTree(input.rootPid);
    // Preserve initial capture diagnostics before a later liveness probe replaces them.
    const initialSnapshotFailure =
      tree.captureComplete === false ? windowsObserver?.lastFailure?.() : null;
    // PPID traversal after root exit can miss reparented descendants. Cleanup
    // can still retire the observed tree, but callers must not treat that as
    // proof that an interrupted provider command had no surviving side effects.
    // The exit promise alone is insufficient: native exit can precede its callback.
    const rootRunningAfterCapture =
      !rootExited &&
      (await (
        dependencies.isRootRunning?.(input.rootPid) ??
        isProcessRunning(input.rootPid, {
          platform,
          ...(windowsObserver
            ? {
                captureWindowsChildren: () =>
                  windowsObserver.captureWithin(FINAL_PROOF_INSPECTION_MAX_MS),
                ...(windowsObserver.capturePidsWithin
                  ? {
                      captureWindowsPids: (pids: readonly number[]) =>
                        windowsObserver.capturePidsWithin!(pids, FINAL_PROOF_INSPECTION_MAX_MS),
                    }
                  : {}),
              }
            : {}),
        })
      ).catch(() => false));
    const capturedBeforeRootExit = rootRunningAfterCapture && !rootExited;
    dependencies.onCapturedTree?.(tree, capturedBeforeRootExit);
    const signalErrors: Error[] = [];

    const signal = (
      killSignal: TerminalKillSignal,
      includeRootTree: boolean,
      signalTree: CapturedProcessTree = tree,
      verifiedDescendants = false,
    ): void | Promise<void> => {
      return processTreeKiller.signal({
        rootPid: input.rootPid,
        signal: killSignal,
        tree: signalTree,
        verifiedDescendants,
        includeRootTree,
        onError: (error) => signalErrors.push(error),
      });
    };

    const inspectDescendants = async (
      timeoutMs: number,
    ): Promise<ReadonlyArray<CapturedProcess> | null> => {
      if (tree.captureComplete === false) return null;
      const inspection = await inspectTree(tree, timeoutMs);
      return inspection.verified ? inspection.survivors : null;
    };

    const waitForExitProof = async (timeoutMs: number) => {
      const deadline = now() + timeoutMs;
      const inspectIntervalMs = positiveDuration(
        input.inspectIntervalMs,
        DEFAULT_INSPECT_INTERVAL_MS,
      );
      let remainingDescendants: ReadonlyArray<CapturedProcess> | null =
        tree.captureComplete === false ? null : tree.descendants;
      let lastInspectedAt: number | null = null;
      do {
        await Promise.resolve();
        let remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        const sinceLastInspect = lastInspectedAt === null ? null : now() - lastInspectedAt;
        if (rootExited && (sinceLastInspect === null || sinceLastInspect >= inspectIntervalMs)) {
          lastInspectedAt = now();
          remainingDescendants = await inspectDescendants(remainingMs);
          if (remainingDescendants !== null && remainingDescendants.length === 0) {
            return { proven: true as const, remainingDescendants };
          }
        }
        remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(positiveDuration(input.pollMs, DEFAULT_POLL_MS), remainingMs));
      } while (now() <= deadline);

      if (rootExited) {
        const finalInspection = await inspectDescendants(
          Math.min(
            positiveDuration(input.inspectIntervalMs, DEFAULT_INSPECT_INTERVAL_MS),
            FINAL_PROOF_INSPECTION_MAX_MS,
          ),
        );
        if (finalInspection !== null) {
          remainingDescendants = finalInspection;
        }
        if (finalInspection !== null && finalInspection.length === 0) {
          return { proven: true as const, remainingDescendants: finalInspection };
        }
      }
      return { proven: false as const, remainingDescendants };
    };

    // When the root already exited, revalidate descendants before TERM. A
    // stale descendant PID may have been reused; never signal it by number.
    let termTree = tree;
    let termDescendantsVerified = false;
    if (rootExited && tree.captureComplete !== false) {
      const termInspection = await inspectTree(
        tree,
        Math.min(
          positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS),
          FINAL_PROOF_INSPECTION_MAX_MS,
        ),
      );
      if (termInspection.verified) {
        termTree = { descendants: termInspection.survivors, captureComplete: true };
        termDescendantsVerified = true;
      } else {
        termTree = { descendants: [], captureComplete: false };
      }
    }

    // The tree helper (taskkill /T on Windows) goes first: it can only walk the
    // tree from a live root. When it has not ended the root (it timed out or
    // failed on a busy machine), end the root through the owned handle, so the
    // root's exit never depends on the helper alone.
    const terminateRootIfHelperDidNot = (): void => {
      if (platform !== "win32" || rootExited || !input.terminateRoot) return;
      try {
        input.terminateRoot();
      } catch (error) {
        signalErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    };

    // Windows must finish its bounded taskkill helper before the grace window
    // starts; spawning the helper has not yet delivered a termination request.
    await signal("SIGTERM", !rootExited, termTree, termDescendantsVerified);
    terminateRootIfHelperDidNot();
    const graceful = await waitForExitProof(
      positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS),
    );
    if (graceful.proven) return { escalated: false, signalErrors, capturedBeforeRootExit };

    let forceTree = tree;
    let forceDescendantsVerified = false;
    if (platform === "win32" && rootExited && tree.captureComplete !== false) {
      // When the Windows root is already gone, taskkill /T can no longer own
      // traversal. Re-snapshot through CIM immediately before escalation and
      // pass only descendants whose PID, command, and creation identity match.
      const forceInspection = await inspectTree(
        tree,
        positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS),
      );
      if (forceInspection.verified) {
        forceTree = {
          descendants: forceInspection.survivors,
          captureComplete: true,
        };
        forceDescendantsVerified = true;
      } else {
        // The root PID may already have been reused and descendant identities
        // are unknown. Do not target stale numeric PIDs; the proof step below
        // will fail closed with ProviderProcessExitUnprovenError.
        forceTree = { descendants: [], captureComplete: false };
      }
    }

    // Once the root has exited, never signal its numeric PID again: it may have
    // been reused. Force only descendants verified immediately before escalation.
    await signal("SIGKILL", !rootExited, forceTree, forceDescendantsVerified);
    terminateRootIfHelperDidNot();
    const forced = await waitForExitProof(
      positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS),
    );
    if (forced.proven) return { escalated: true, signalErrors, capturedBeforeRootExit };

    throw new ProviderProcessExitUnprovenError({
      rootPid: input.rootPid,
      rootExited,
      remainingDescendantPids:
        forced.remainingDescendants?.map((descendant) => descendant.pid) ?? null,
      captureComplete: tree.captureComplete !== false,
      signalErrors,
      ...((initialSnapshotFailure ?? windowsObserver?.lastFailure?.())
        ? { snapshotFailure: (initialSnapshotFailure ?? windowsObserver?.lastFailure?.())! }
        : {}),
    });
  } finally {
    if (windowsObserver !== dependencies.windowsSnapshotObserver) windowsObserver?.dispose();
  }
}
