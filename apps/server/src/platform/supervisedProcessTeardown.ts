// FILE: supervisedProcessTeardown.ts
// Purpose: Owns graceful, forced, and verified teardown for provider/runtime process trees.
// Layer: Server platform runtime

import { Effect, type Scope } from "effect";
import type { ChildProcess } from "node:child_process";
import { didProcessFailToSpawn } from "@synara/shared/processRuntime";

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
}

export interface EffectProcessExitHandle {
  readonly pid: number;
  readonly exitCode: Effect.Effect<unknown, unknown>;
}

export interface SupervisedProcessTeardownResult {
  readonly escalated: boolean;
  readonly signalErrors: ReadonlyArray<Error>;
  /** Only true when the initial descendant snapshot completed before root exit. */
  readonly capturedBeforeRootExit?: boolean;
}

export interface SupervisedProcessTeardownDependencies {
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
// Initialization consumes the provider's existing startup budget, not its exit-proof window.
export const WINDOWS_OBSERVER_STARTUP_TIMEOUT_MS = 10_000;

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
        const observer =
          options.createObserver?.() ??
          createWindowsTeardownProcessSnapshotObserver({ startImmediately: true });
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
      observer =
        options.createObserver?.() ??
        createWindowsTeardownProcessSnapshotObserver({ startImmediately: true });
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

  constructor(input: {
    readonly rootPid: number;
    readonly rootExited: boolean;
    readonly remainingDescendantPids: ReadonlyArray<number> | null;
    readonly captureComplete: boolean;
    readonly snapshotFailure?: WindowsSnapshotFailure;
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
          : "."),
    );
    this.name = "ProviderProcessExitUnprovenError";
    this.rootPid = input.rootPid;
    this.rootExited = input.rootExited;
    this.remainingDescendantPids = input.remainingDescendantPids;
    this.captureComplete = input.captureComplete;
    this.snapshotFailure = input.snapshotFailure;
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

export async function teardownChildProcessTree(
  process: ProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
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
      };
      return await (prepared && teardownProcessTree === teardownProviderProcessTree
        ? teardownProcessTree(input, { windowsSnapshotObserver: prepared.observer })
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

export function teardownEffectProcessTree(
  process: EffectProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
  dependencies: Pick<SupervisedProcessTeardownDependencies, "windowsSnapshotObserver"> = {},
): Promise<SupervisedProcessTeardownResult> {
  return teardownProcessTree(
    {
      rootPid: Number(process.pid),
      rootExited: Effect.runPromise(Effect.exit(process.exitCode)),
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
): Promise<void> {
  const rootPid = Number(process.pid);
  const rootExitedPromise = Effect.runPromise(Effect.exit(process.exitCode));
  if (globalThis.process.platform === "win32") {
    await teardownProviderProcessTree({
      rootPid,
      rootExited: rootExitedPromise,
      termGraceMs: 1,
      forceExitMs,
    });
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

    // Windows must finish its bounded taskkill helper before the grace window
    // starts; spawning the helper has not yet delivered a termination request.
    await signal("SIGTERM", !rootExited);
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
      ...((initialSnapshotFailure ?? windowsObserver?.lastFailure?.())
        ? { snapshotFailure: (initialSnapshotFailure ?? windowsObserver?.lastFailure?.())! }
        : {}),
    });
  } finally {
    if (windowsObserver !== dependencies.windowsSnapshotObserver) windowsObserver?.dispose();
  }
}
