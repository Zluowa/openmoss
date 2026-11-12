// FILE: tools/queue/lib/runner.ts
// Purpose: The one door to the outside world. Every git, gh, ssh and lane process the queue
//          starts goes through a Runner, so the logic above it is tested with a fake one.
// Layer: tool library
// Exports: Runner, RunOptions, RunResult, realRunner, stopAllChildren, shellQuote, mergeEnv

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopProcessTree } from "../../ws/lib/proc.ts";
import type { RunResult as WsRunResult } from "../../ws/lib/run.ts";

export interface RunResult extends WsRunResult {
  /** Raw standard output, only when `binaryStdout` was asked for. */
  readonly stdoutBytes?: Buffer | undefined;
  readonly timedOut?: boolean | undefined;
}

export interface RunOptions {
  readonly cwd?: string | undefined;
  /** Merged over the current environment; `null` removes a variable. */
  readonly env?: Readonly<Record<string, string | null>> | undefined;
  readonly input?: string | Uint8Array | undefined;
  readonly timeoutMs?: number | undefined;
  /** Standard output and error, interleaved as they arrive, are appended to this file. */
  readonly logFile?: string | undefined;
  readonly binaryStdout?: boolean | undefined;
}

export interface Runner {
  run(cmd: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Exit code used when a run hit its time limit. */
export const EXIT_TIMEOUT = 124;

/** The environment for a child: the current one, then `extra`; keys match case-insensitively on Windows. */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string | null>> = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    const existing =
      platform === "win32"
        ? Object.keys(out).filter((key) => key.toLowerCase() === k.toLowerCase())
        : [k];
    for (const key of existing) delete out[key];
    if (v !== null) out[k] = v;
  }
  return out;
}

const live = new Set<ChildProcess>();

/** Stops every child the real runner started and that is still running (Ctrl-C, fatal errors). */
export function stopAllChildren(): void {
  for (const child of live) if (child.pid) stopProcessTree(child.pid);
  live.clear();
}

export const realRunner: Runner = {
  run(cmd, args, options = {}) {
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      let stderr = "";
      let log: fs.WriteStream | undefined;
      if (options.logFile) {
        fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
        log = fs.createWriteStream(options.logFile, { flags: "a" });
      }
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, {
          cwd: options.cwd,
          windowsHide: true,
          env: mergeEnv(process.env, {
            GIT_TERMINAL_PROMPT: "0",
            GH_PROMPT_DISABLED: "1",
            ...options.env,
          }),
        });
      } catch (error) {
        log?.end();
        resolve({ code: 127, stdout: "", stderr: String(error) });
        return;
      }
      live.add(child);
      let timedOut = false;
      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              if (child.pid) stopProcessTree(child.pid);
            }, options.timeoutMs)
          : undefined;
      child.stdout?.on("data", (d: Buffer) => {
        out.push(d);
        log?.write(d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        log?.write(d);
      });
      let settled = false;
      const finish = (code: number, extraErr = "") => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        live.delete(child);
        const bytes = Buffer.concat(out);
        const done = () =>
          resolve({
            code: timedOut ? EXIT_TIMEOUT : code,
            stdout: options.binaryStdout ? "" : bytes.toString("utf8"),
            stderr: stderr + extraErr,
            stdoutBytes: options.binaryStdout ? bytes : undefined,
            timedOut,
          });
        if (log) log.end(done);
        else done();
      };
      child.on("error", (error) => finish(127, String(error)));
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    });
  },
};

/** POSIX shell single-quoting, for commands sent to the remote machine. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
