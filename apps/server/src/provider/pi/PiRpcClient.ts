// FILE: PiRpcClient.ts
// Purpose: Drives one `pi --mode rpc` child process: strict JSONL framing, command/response
//          correlation, session events, extension UI records, and process-tree teardown.
// Layer: Provider (Pi)
//
// Pi's RPC protocol (docs/rpc.md in @earendil-works/pi-coding-agent) writes one JSON record per
// LF-terminated line on stdout. Node's `readline` also splits on U+2028/U+2029, which are valid
// inside JSON strings, so this reader splits on the LF byte only.

import type { ChildProcess } from "node:child_process";

import {
  spawnProcess as spawnPlatformProcess,
  type RuntimeSpawnOptions,
} from "@moss/shared/processRuntime";

import { spawnGuardedProviderChild } from "../../platform/windowsProviderProcessGuard.ts";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "../supervisedProcessTeardown.ts";

/** A stdout record that is not the response to a command Moss sent. */
export type PiRpcRecord = { readonly type: string } & Readonly<Record<string, unknown>>;

export type PiRpcSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: RuntimeSpawnOptions,
) => ChildProcess;

export interface PiRpcClientOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly lowerPriority?: boolean;
  /** Test seam: replaces the platform spawn. */
  readonly spawnProcess?: PiRpcSpawn;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  /** Default deadline for one command's response. */
  readonly commandTimeoutMs?: number;
}

export interface PiRpcExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all (for example ENOENT). */
  readonly spawnError?: Error;
}

export class PiRpcCommandError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "PiRpcCommandError";
    this.command = command;
  }
}

export class PiRpcProcessError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PiRpcProcessError";
  }
}

export interface PiRpcClient {
  readonly pid: number | undefined;
  /** Sends one command and resolves with its `data` (or `undefined`) on success. */
  readonly request: <T = unknown>(
    command: { readonly type: string } & Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<T>;
  /** Writes a record that has no response, such as `extension_ui_response`. */
  readonly write: (record: Readonly<Record<string, unknown>>) => void;
  readonly onRecord: (listener: (record: PiRpcRecord) => void) => () => void;
  readonly exited: Promise<PiRpcExit>;
  readonly isExited: () => boolean;
  /** The last few KB of stderr, for error messages. Never parsed as protocol. */
  readonly stderrTail: () => string;
  /** Closes stdin (Pi's orderly shutdown), then proves the whole process tree is gone. */
  readonly close: (options?: { readonly graceMs?: number }) => Promise<void>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const STDERR_TAIL_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

interface PendingCommand {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/** Splits a byte stream into LF-terminated records; an optional CR before LF is dropped. */
export function makeJsonlSplitter(onLine: (line: string) => void) {
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  return (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const piece = chunk.subarray(start, newline);
      const line = bufferedBytes > 0 ? Buffer.concat([...buffered, piece]) : piece;
      buffered = [];
      bufferedBytes = 0;
      const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
      if (end > 0) onLine(line.toString("utf8", 0, end));
      start = newline + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      bufferedBytes += rest.length;
      if (bufferedBytes > MAX_RECORD_BYTES) {
        // A record this large is not one Moss can use; drop it instead of growing forever.
        buffered = [];
        bufferedBytes = 0;
        return;
      }
      buffered.push(Buffer.from(rest));
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function startPiRpcClient(options: PiRpcClientOptions): PiRpcClient {
  const spawn =
    options.spawnProcess ??
    ((command: string, args: ReadonlyArray<string>, spawnOptions: RuntimeSpawnOptions) =>
      spawnPlatformProcess(command, args, {
        ...spawnOptions,
        requireExecutable: true,
        ownProcessGroup: true,
      }));
  const teardownProcessTree = options.teardownProcessTree ?? teardownProviderProcessTree;
  const listeners = new Set<(record: PiRpcRecord) => void>();
  const pending = new Map<string, PendingCommand>();
  let nextId = 1;
  let stderrTail = "";
  let exitInfo: PiRpcExit | undefined;
  let resolveExited!: (exit: PiRpcExit) => void;
  const exited = new Promise<PiRpcExit>((resolve) => {
    resolveExited = resolve;
  });
  let closing: Promise<void> | undefined;

  const describeExit = (exit: PiRpcExit): string => {
    if (exit.spawnError) return `Pi could not start: ${exit.spawnError.message}`;
    const tail = stderrTail.trim();
    const status =
      exit.code !== null ? `exit code ${exit.code}` : `signal ${exit.signal ?? "unknown"}`;
    return tail ? `Pi exited (${status}): ${tail}` : `Pi exited (${status}).`;
  };

  const finish = (exit: PiRpcExit) => {
    if (exitInfo) return;
    exitInfo = exit;
    const error = new PiRpcProcessError(describeExit(exit), {
      ...(exit.spawnError ? { cause: exit.spawnError } : {}),
    });
    for (const [id, command] of pending) {
      if (command.timer !== undefined) clearTimeout(command.timer);
      pending.delete(id);
      command.reject(error);
    }
    resolveExited(exit);
  };

  let child: ChildProcess;
  try {
    child = spawnGuardedProviderChild(() =>
      spawn(options.binaryPath, options.args, {
        cwd: options.cwd,
        env: options.env,
        lowerPriority: options.lowerPriority ?? true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  } catch (cause) {
    const spawnError = cause instanceof Error ? cause : new Error(String(cause));
    finish({ code: null, signal: null, spawnError });
    return {
      pid: undefined,
      request: () => Promise.reject(new PiRpcProcessError(describeExit(exitInfo!))),
      write: () => undefined,
      onRecord: () => () => undefined,
      exited,
      isExited: () => true,
      stderrTail: () => stderrTail,
      close: async () => undefined,
    };
  }

  const handleLine = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return;
    if (parsed.type === "response" && typeof parsed.id === "string") {
      const command = pending.get(parsed.id);
      if (command) {
        pending.delete(parsed.id);
        if (command.timer !== undefined) clearTimeout(command.timer);
        if (parsed.success === true) {
          command.resolve(parsed.data);
        } else {
          const message =
            typeof parsed.error === "string" && parsed.error.trim().length > 0
              ? parsed.error
              : `Pi rejected ${command.command}.`;
          command.reject(new PiRpcCommandError(command.command, message));
        }
        return;
      }
    }
    const record = parsed as PiRpcRecord;
    for (const listener of Array.from(listeners)) {
      try {
        listener(record);
      } catch {
        // A listener failure must not stop the stream for the others.
      }
    }
  };

  child.stdout?.on("data", makeJsonlSplitter(handleLine));
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  child.stdin?.on("error", () => undefined);
  child.once("error", (cause) => {
    // Without a PID nothing started; with one, `exit` follows and carries the status.
    if (child.pid === undefined) finish({ code: null, signal: null, spawnError: cause });
  });
  child.once("exit", (code, signal) => finish({ code, signal }));

  const write = (record: Readonly<Record<string, unknown>>) => {
    if (exitInfo || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
    child.stdin.write(`${JSON.stringify(record)}\n`);
  };

  const request = <T>(
    command: { readonly type: string } & Readonly<Record<string, unknown>>,
    requestOptions?: { readonly timeoutMs?: number },
  ): Promise<T> => {
    if (exitInfo) return Promise.reject(new PiRpcProcessError(describeExit(exitInfo)));
    if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new PiRpcProcessError("Pi's input is closed."));
    }
    const id = `moss-${nextId++}`;
    const timeoutMs =
      requestOptions?.timeoutMs ?? options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(() => {
              if (!pending.delete(id)) return;
              reject(
                new PiRpcCommandError(
                  command.type,
                  `Pi did not answer ${command.type} within ${Math.round(timeoutMs / 1000)}s.`,
                ),
              );
            }, timeoutMs)
          : undefined;
      pending.set(id, {
        command: command.type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      write({ ...command, id });
    });
  };

  const close = (closeOptions?: { readonly graceMs?: number }): Promise<void> => {
    closing ??= (async () => {
      if (!exitInfo) {
        try {
          child.stdin?.end();
        } catch {
          // Already closed.
        }
        const graceMs = closeOptions?.graceMs ?? 3_000;
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.()),
        ]);
      }
      if (child.pid === undefined) return;
      // Pi's own children (bash, MCP servers, language servers) must not outlive the session.
      await teardownChildProcessTree(child, teardownProcessTree);
    })();
    return closing;
  };

  return {
    pid: child.pid,
    request,
    write,
    onRecord: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    exited,
    isExited: () => exitInfo !== undefined,
    stderrTail: () => stderrTail,
    close,
  };
}
