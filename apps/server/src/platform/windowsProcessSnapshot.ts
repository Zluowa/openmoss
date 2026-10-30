// FILE: windowsProcessSnapshot.ts
// Purpose: Maintains one bounded Windows process-table observer shared by runtime owners.
// Layer: Server Windows platform runtime

import { type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveWindowsSystemRoot } from "@synara/shared/platformEnvironment";

import type { ProcessChildrenMap } from "./processTreeController";

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
// Complete discovery enumerates every process; identity rechecks keep their
// caller's short deadline and use direct native process handles instead.
export const WINDOWS_PROCESS_TREE_CAPTURE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 30_000;
const TEARDOWN_RETRY_BACKOFF_BASE_MS = 100;
const TEARDOWN_RETRY_BACKOFF_MAX_MS = 250;
const MAX_SNAPSHOT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TARGETED_SNAPSHOT_PIDS = 4_096;

const SNAPSHOT_START_MARKER = "@snapshot";
const SNAPSHOT_END_MARKER = "@end";
const SNAPSHOT_ERROR_MARKER = "@error";
const SNAPSHOT_WARMUP_ERROR_MARKER = "@warmup-error";
const SNAPSHOT_PHASE_PREFIX = "@phase:";

export type WindowsSnapshotPhase =
  | "worker-starting"
  | "worker-ready"
  | "module-loading"
  | "provider-initializing"
  | "ready"
  | "query"
  | "serialization";

interface WindowsSnapshotPhaseObservation {
  readonly phase: WindowsSnapshotPhase;
  readonly phaseElapsedMs: number;
}

const WINDOWS_CIM_PREPARATION_SCRIPT = `
try {
  [Console]::Out.WriteLine('${SNAPSHOT_PHASE_PREFIX}module-loading')
  [Console]::Out.Flush()
  Import-Module CimCmdlets -ErrorAction Stop
  [Console]::Out.WriteLine('${SNAPSHOT_PHASE_PREFIX}provider-initializing')
  [Console]::Out.Flush()
  $empty = @(Get-CimInstance Win32_Process -Filter 'ProcessId < 0' -Property ProcessId -ErrorAction Stop)
  if ($empty.Count -ne 0) { throw 'Unexpected initialization result' }
  $empty = $null
} catch {
  [Console]::Out.WriteLine('${SNAPSHOT_WARMUP_ERROR_MARKER}')
  [Console]::Out.Flush()
  exit 1
}
`.trim();

// EncodedCommand leaves stdin available for the request loop. CreationDate is
// included so delayed teardown never mistakes a reused Windows PID for the
// provider child that was originally captured.
function windowsProcessSnapshotScript(prepareCim: boolean): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('${SNAPSHOT_PHASE_PREFIX}worker-ready')
[Console]::Out.Flush()
${prepareCim ? WINDOWS_CIM_PREPARATION_SCRIPT : ""}
[Console]::Out.WriteLine('${SNAPSHOT_PHASE_PREFIX}ready')
[Console]::Out.Flush()
while (($request = [Console]::In.ReadLine()) -ne $null) {
  try {
    [Console]::Out.WriteLine('${SNAPSHOT_START_MARKER}')
    [Console]::Out.WriteLine('${SNAPSHOT_PHASE_PREFIX}query')
    [Console]::Out.Flush()
    $targetIds = $null
    if ($request -ne 'snapshot') {
      if ($request.Length -gt 45056 -or $request -notmatch '^pids:[1-9][0-9]*(,[1-9][0-9]*)*$') { throw 'Invalid snapshot request' }
      $ids = @($request.Substring(5).Split(','))
      if ($ids.Count -gt ${MAX_TARGETED_SNAPSHOT_PIDS}) { throw 'Too many snapshot identities' }
      $targetIds = @($ids | ForEach-Object {
        $processId = [long]$_
        if ($processId -le 1 -or $processId -gt 2147483647) { throw 'Invalid process identity' }
        [int]$processId
      })
    }
    $rows = if ($null -eq $targetIds) {
      @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine,Name -ErrorAction Stop)
    } else {
      @(foreach ($targetId in $targetIds) {
        $observed = $null
        try { $observed = [Diagnostics.Process]::GetProcessById($targetId) }
        catch [ArgumentException] { continue }
        try {
          [pscustomobject]@{
            ProcessId = $targetId
            ParentProcessId = 0
            CreationDate = $observed.StartTime
            CommandLine = $observed.ProcessName
            Name = $observed.ProcessName
          }
        } catch [InvalidOperationException] {
          if (-not $observed.HasExited) { throw }
        } finally { $observed.Dispose() }
      })
    }
    [Console]::Out.WriteLine('${SNAPSHOT_PHASE_PREFIX}serialization')
    [Console]::Out.Flush()
    foreach ($row in $rows) {
      $command = if ($row.CommandLine) { [string]$row.CommandLine } else { [string]$row.Name }
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
      $created = if ($null -eq $row.CreationDate) { '' } else { $row.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffK', [Globalization.CultureInfo]::InvariantCulture) }
      [Console]::Out.WriteLine(("{0}\t{1}\t{2}\t{3}" -f $row.ProcessId, $row.ParentProcessId, $created, $encoded))
    }
    $rows = $null
    [Console]::Out.WriteLine('${SNAPSHOT_END_MARKER}')
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('${SNAPSHOT_ERROR_MARKER}')
    [Console]::Out.Flush()
  }
}
`.trim();
}

export interface ProcessChildrenSnapshotWorker {
  capture(pids?: readonly number[]): Promise<ProcessChildrenMap>;
  /** Initialization only; never captures or caches process rows. */
  ready?(): Promise<void>;
  isReady?(): boolean;
  phase?(): WindowsSnapshotPhaseObservation;
  dispose(): void;
}

export type WindowsSnapshotFailureKind =
  | "spawn"
  | "worker-exit"
  | "request"
  | "initialization"
  | "query"
  | "malformed-row"
  | "protocol"
  | "output-limit"
  | "closed"
  | "timeout"
  | "deadline"
  | "unknown";

export interface WindowsSnapshotFailure {
  readonly kind: WindowsSnapshotFailureKind;
  readonly elapsedMs: number;
  readonly phase?: WindowsSnapshotPhase;
  readonly phaseElapsedMs?: number;
}

class WindowsSnapshotError extends Error {
  constructor(readonly kind: WindowsSnapshotFailureKind) {
    super(`Windows process snapshot failed (${kind}).`);
  }
}

export interface ProcessChildrenSnapshotObserver {
  capture(pids?: readonly number[]): Promise<ProcessChildrenMap | null>;
  retryDelayMs(): number;
  /** Safe category only: never includes process rows, command lines, or worker stderr. */
  lastFailure?(): WindowsSnapshotFailure | null;
  phase?(): WindowsSnapshotPhaseObservation | undefined;
  dispose(): void;
}

export interface TeardownProcessChildrenSnapshotObserver extends ProcessChildrenSnapshotObserver {
  captureWithin(timeoutMs: number): Promise<ProcessChildrenMap | null>;
  capturePidsWithin?(
    pids: readonly number[],
    timeoutMs: number,
  ): Promise<ProcessChildrenMap | null>;
  prepareWithin?(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  assertReady?(): void;
}

interface PendingSnapshot {
  childrenByParentPid: ProcessChildrenMap;
  outputBytes: number;
  sawStartMarker: boolean;
  readonly targeted: boolean;
  resolve: (snapshot: ProcessChildrenMap) => void;
  reject: (error: Error) => void;
}

interface PowerShellProcessSnapshotWorkerOptions {
  spawnProcess?: (script: string) => ChildProcessWithoutNullStreams;
  prepareCim?: boolean;
}

export interface WindowsProcessSnapshotObserverOptions {
  createWorker?: () => ProcessChildrenSnapshotWorker;
  /** Start the worker during its owner's lifetime; snapshots remain on demand. */
  startImmediately?: boolean;
  now?: () => number;
  probeTimeoutMs?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
}

type WindowsTeardownProcessSnapshotObserverOptions = Omit<
  WindowsProcessSnapshotObserverOptions,
  "retryBackoffBaseMs" | "retryBackoffMaxMs"
>;

function powershellExecutablePath(): string {
  return path.win32.join(
    resolveWindowsSystemRoot(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function normalizedSnapshotPids(pids: readonly number[] | undefined): number[] | undefined {
  if (pids === undefined) return undefined;
  if (
    pids.length > MAX_TARGETED_SNAPSHOT_PIDS ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff)
  ) {
    throw new WindowsSnapshotError("request");
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

function spawnPowerShellSnapshotProcess(script: string): ChildProcessWithoutNullStreams {
  return spawnProcess(
    powershellExecutablePath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedPowerShellCommand(script),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      platform: "win32",
    },
  );
}

function decodeSnapshotCommand(encodedCommand: string): string | null {
  if (encodedCommand.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCommand)) {
    return null;
  }
  try {
    const command = Buffer.from(encodedCommand, "base64").toString("utf8").trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

/** Parses one base64-delimited worker row without trusting command-line contents as separators. */
export function parseWindowsProcessSnapshotLine(
  line: string,
): { pid: number; ppid: number; command: string; startedAt?: string } | null {
  const fields = line.split("\t");
  if (fields.length !== 3 && fields.length !== 4) return null;
  const [pidRaw, ppidRaw] = fields;
  const startedAtRaw = fields.length === 4 ? fields[2] : undefined;
  const encodedCommand = fields.at(-1);
  if (!encodedCommand) return null;
  const pid = Number(pidRaw);
  const ppid = Number(ppidRaw);
  // Win32_Process includes the System Idle Process as PID 0. Root process-tree
  // APIs still require a positive PID, but rejecting this row invalidates every snapshot.
  if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  const command = decodeSnapshotCommand(encodedCommand);
  if (command === null) return null;
  const startedAt = startedAtRaw?.trim();
  return {
    pid,
    ppid,
    command,
    ...(startedAt ? { startedAt } : {}),
  };
}

class PowerShellProcessSnapshotWorker implements ProcessChildrenSnapshotWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutCarry = "";
  private pending: PendingSnapshot | null = null;
  private terminalError: Error | null = null;
  private disposed = false;
  private currentPhase: WindowsSnapshotPhase = "worker-starting";
  private phaseStartedAt = Date.now();
  private initialized = false;
  private readonly readinessWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  constructor(options: PowerShellProcessSnapshotWorkerOptions = {}) {
    this.child = (options.spawnProcess ?? spawnPowerShellSnapshotProcess)(
      windowsProcessSnapshotScript(options.prepareCim === true),
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.consumeStdout(chunk);
    });
    this.child.stderr.resume();
    this.child.once("error", () => {
      this.fail(new WindowsSnapshotError("spawn"));
    });
    this.child.once("close", () => {
      this.fail(new WindowsSnapshotError("worker-exit"));
    });
  }

  ready(): Promise<void> {
    if (this.disposed)
      return Promise.reject(this.terminalError ?? new WindowsSnapshotError("closed"));
    if (this.initialized) return Promise.resolve();
    return new Promise((resolve, reject) => this.readinessWaiters.add({ resolve, reject }));
  }

  isReady(): boolean {
    return this.initialized && !this.disposed;
  }

  capture(pids?: readonly number[]): Promise<ProcessChildrenMap> {
    if (this.disposed) {
      return Promise.reject(this.terminalError ?? new WindowsSnapshotError("closed"));
    }
    if (this.pending) {
      return Promise.reject(new WindowsSnapshotError("protocol"));
    }

    let selected: number[] | undefined;
    try {
      selected = normalizedSnapshotPids(pids);
    } catch (error) {
      return Promise.reject(error);
    }
    if (selected?.length === 0) return Promise.resolve(new Map());

    return new Promise<ProcessChildrenMap>((resolve, reject) => {
      this.pending = {
        childrenByParentPid: new Map(),
        outputBytes: 0,
        sawStartMarker: false,
        targeted: selected !== undefined,
        resolve,
        reject,
      };
      const request = selected ? `pids:${selected.join(",")}\n` : "snapshot\n";
      this.child.stdin.write(request, (error) => {
        if (error) {
          this.fail(new WindowsSnapshotError("request"));
        }
      });
    });
  }

  dispose(): void {
    this.fail(new WindowsSnapshotError("closed"));
  }

  phase(): WindowsSnapshotPhaseObservation {
    return {
      phase: this.currentPhase,
      phaseElapsedMs: Math.max(0, Date.now() - this.phaseStartedAt),
    };
  }

  private consumeStdout(chunk: string): void {
    this.stdoutCarry += chunk;
    while (true) {
      const newlineIndex = this.stdoutCarry.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.stdoutCarry.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutCarry = this.stdoutCarry.slice(newlineIndex + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (this.disposed) return;
    // Initialization runs before any capture. These fixed markers carry no
    // process data and can never create a snapshot or satisfy its end marker.
    if (line.startsWith(SNAPSHOT_PHASE_PREFIX)) {
      const phase = line.slice(SNAPSHOT_PHASE_PREFIX.length);
      if (
        phase === "worker-ready" ||
        phase === "module-loading" ||
        phase === "provider-initializing" ||
        phase === "ready" ||
        phase === "query" ||
        phase === "serialization"
      ) {
        this.currentPhase = phase;
        this.phaseStartedAt = Date.now();
        if (phase === "ready") {
          this.initialized = true;
          for (const waiter of this.readinessWaiters) waiter.resolve();
          this.readinessWaiters.clear();
        }
        return;
      }
      this.fail(new WindowsSnapshotError("protocol"));
      return;
    }
    if (line === SNAPSHOT_WARMUP_ERROR_MARKER) {
      this.fail(new WindowsSnapshotError("initialization"));
      return;
    }
    const pending = this.pending;
    if (!pending) return;

    pending.outputBytes += Buffer.byteLength(line, "utf8") + 1;
    if (pending.outputBytes > MAX_SNAPSHOT_OUTPUT_BYTES) {
      this.fail(new WindowsSnapshotError("output-limit"));
      return;
    }
    if (line === SNAPSHOT_START_MARKER) {
      pending.sawStartMarker = true;
      pending.childrenByParentPid.clear();
      return;
    }
    if (line === SNAPSHOT_ERROR_MARKER) {
      this.fail(new WindowsSnapshotError("query"));
      return;
    }
    if (line === SNAPSHOT_END_MARKER) {
      if (!pending.sawStartMarker) {
        this.fail(new WindowsSnapshotError("protocol"));
        return;
      }
      this.pending = null;
      pending.resolve(pending.childrenByParentPid);
      return;
    }
    if (!pending.sawStartMarker) return;

    const process = parseWindowsProcessSnapshotLine(line);
    if (!process) {
      this.fail(new WindowsSnapshotError("malformed-row"));
      return;
    }
    const siblings = pending.childrenByParentPid.get(process.ppid) ?? [];
    siblings.push({
      pid: process.pid,
      command: process.command,
      ...(process.startedAt ? { startedAt: process.startedAt } : {}),
      ...(pending.targeted ? { identityKind: "windows-start-time" as const } : {}),
    });
    pending.childrenByParentPid.set(process.ppid, siblings);
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalError = error;
    for (const waiter of this.readinessWaiters) waiter.reject(error);
    this.readinessWaiters.clear();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    this.child.stdin.destroy();
    this.child.kill();
  }
}

export function createPowerShellProcessSnapshotWorker(
  options: PowerShellProcessSnapshotWorkerOptions = {},
): ProcessChildrenSnapshotWorker {
  return new PowerShellProcessSnapshotWorker(options);
}

function retryBackoffMs(failureCount: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failureCount - 1));
}

export function createWindowsProcessSnapshotObserver(
  options: WindowsProcessSnapshotObserverOptions = {},
): ProcessChildrenSnapshotObserver &
  Pick<TeardownProcessChildrenSnapshotObserver, "prepareWithin" | "assertReady"> {
  const createWorker =
    options.createWorker ??
    (() =>
      createPowerShellProcessSnapshotWorker({ prepareCim: options.startImmediately === true }));
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const retryBackoffBaseMs = options.retryBackoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS;
  const retryBackoffMaxMs = options.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;

  let worker: ProcessChildrenSnapshotWorker | null = null;
  let inFlight: Promise<ProcessChildrenMap | null> | null = null;
  let inFlightScope: string | undefined;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  let lastFailure: WindowsSnapshotFailure | null = null;
  let disposed = false;

  const recordFailure = (error: unknown, startedAt: number): null => {
    lastFailure = {
      kind: error instanceof WindowsSnapshotError ? error.kind : "unknown",
      elapsedMs: Math.max(0, now() - startedAt),
      ...worker?.phase?.(),
    };
    worker?.dispose();
    worker = null;
    consecutiveFailures += 1;
    nextAttemptAt =
      now() + retryBackoffMs(consecutiveFailures, retryBackoffBaseMs, retryBackoffMaxMs);
    return null;
  };

  if (options.startImmediately) {
    const startedAt = now();
    // Do not delay child spawn/listener attachment, and do not capture any rows
    // that could later be mistaken for fresh teardown evidence.
    void Promise.resolve()
      .then(() => {
        if (!disposed) worker ??= createWorker();
      })
      .catch((error: unknown) => recordFailure(error, startedAt));
  }

  const captureWithTimeout = (
    activeWorker: ProcessChildrenSnapshotWorker,
    pids: readonly number[] | undefined,
  ): Promise<ProcessChildrenMap> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new WindowsSnapshotError("timeout"));
      }, probeTimeoutMs);
      timeout.unref?.();
      (pids === undefined ? activeWorker.capture() : activeWorker.capture(pids)).then(
        (snapshot) => {
          clearTimeout(timeout);
          resolve(snapshot);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });

  const capture = (pids?: readonly number[]): Promise<ProcessChildrenMap | null> => {
    let selected: number[] | undefined;
    try {
      selected = normalizedSnapshotPids(pids);
    } catch {
      return Promise.resolve(null);
    }
    if (disposed || now() < nextAttemptAt) return Promise.resolve(null);
    if (selected?.length === 0) return Promise.resolve(new Map());
    const scope = selected?.join(",") ?? "all";
    if (inFlight) {
      // A partial response must never prove absence for another PID set or
      // satisfy a full descendant capture. Serialize different native queries.
      return inFlightScope === scope ? inFlight : inFlight.then(() => capture(selected));
    }

    const startedAt = now();
    const attempt = Promise.resolve()
      .then(() => {
        if (disposed) throw new WindowsSnapshotError("closed");
        worker ??= createWorker();
        return captureWithTimeout(worker, selected);
      })
      .then(
        (snapshot) => {
          consecutiveFailures = 0;
          nextAttemptAt = 0;
          lastFailure = null;
          return snapshot;
        },
        (error: unknown) => recordFailure(error, startedAt),
      )
      .finally(() => {
        if (inFlight === attempt) {
          inFlight = null;
          inFlightScope = undefined;
        }
      });
    inFlight = attempt;
    inFlightScope = scope;
    return attempt;
  };

  return {
    assertReady: () => {
      if (disposed || worker?.isReady?.() !== true) throw new WindowsSnapshotError("closed");
    },
    prepareWithin: async (timeoutMs, signal) => {
      signal?.throwIfAborted();
      if (disposed) throw new WindowsSnapshotError("closed");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WindowsSnapshotError("deadline");
      const startedAt = now();
      try {
        worker ??= createWorker();
        const activeWorker = worker;
        if (!activeWorker.ready) throw new WindowsSnapshotError("initialization");
        await new Promise<void>((resolve, reject) => {
          const abort = () => finish(signal?.reason ?? new WindowsSnapshotError("closed"));
          const timer = setTimeout(() => finish(new WindowsSnapshotError("deadline")), timeoutMs);
          let settled = false;
          function finish(error?: unknown) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error !== undefined) reject(error);
            else resolve();
          }
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try {
            activeWorker.ready!().then(() => finish(), finish);
          } catch (error) {
            finish(error);
          }
        });
        signal?.throwIfAborted();
        if (disposed || worker !== activeWorker || !activeWorker.isReady?.())
          throw new WindowsSnapshotError("closed");
      } catch (error) {
        recordFailure(error, startedAt);
        throw error;
      }
    },
    capture,
    retryDelayMs: () => Math.max(0, nextAttemptAt - now()),
    lastFailure: () => lastFailure,
    phase: () => worker?.phase?.(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      worker?.dispose();
      worker = null;
    },
  };
}

/** Keeps teardown recovery inside its short proof windows without spawning fallback probes. */
export function createWindowsTeardownProcessSnapshotObserver(
  options: WindowsTeardownProcessSnapshotObserverOptions = {},
): TeardownProcessChildrenSnapshotObserver {
  const now = options.now ?? Date.now;
  const observer = createWindowsProcessSnapshotObserver({
    ...options,
    probeTimeoutMs: options.probeTimeoutMs ?? WINDOWS_PROCESS_TREE_CAPTURE_TIMEOUT_MS,
    retryBackoffBaseMs: TEARDOWN_RETRY_BACKOFF_BASE_MS,
    retryBackoffMaxMs: TEARDOWN_RETRY_BACKOFF_MAX_MS,
  });

  let windowFailure: WindowsSnapshotFailure | null = null;
  const captureUntil = (
    deadline: number,
    pids?: readonly number[],
  ): Promise<ProcessChildrenMap | null> => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const startedAt = now();
      const timeout = setTimeout(() => {
        windowFailure = {
          kind: "deadline",
          elapsedMs: Math.max(0, now() - startedAt),
          ...observer.phase?.(),
        };
        settled = true;
        resolve(null);
      }, remainingMs);
      observer.capture(pids).then(
        (snapshot) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(snapshot);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(null);
        },
      );
    });
  };

  const captureWithin = async (timeoutMs: number, pids?: readonly number[]) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
    windowFailure = null;
    const deadline = now() + timeoutMs;
    const firstSnapshot = await captureUntil(deadline, pids);
    if (firstSnapshot !== null) return firstSnapshot;

    const retryDelayMs = observer.retryDelayMs();
    const remainingMs = deadline - now();
    if (retryDelayMs <= 0 || retryDelayMs >= remainingMs) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    return captureUntil(deadline, pids);
  };
  return {
    ...observer,
    lastFailure: () => windowFailure ?? observer.lastFailure?.() ?? null,
    captureWithin: (timeoutMs) => captureWithin(timeoutMs),
    capturePidsWithin: (pids, timeoutMs) => captureWithin(timeoutMs, pids),
  };
}

/** One-shot fallback for callers that do not own a shared observer. */
export async function captureWindowsProcessChildrenMap(): Promise<ProcessChildrenMap | null> {
  const observer = createWindowsProcessSnapshotObserver();
  try {
    return await observer.capture();
  } finally {
    observer.dispose();
  }
}
