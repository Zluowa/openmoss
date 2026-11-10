// FILE: windowsRegistry.ts
// Purpose: One way to read the Windows registry through `reg.exe` without leaking its stderr.
// Layer: Shared platform runtime
//
// `execFileSync` forwards a child's stderr to the parent's stderr unless `stdio` is given, so a
// missing key printed "错误: 系统找不到指定的注册表项或值。" (in the system code page) into
// Moss's logs as mojibake. A missing key or value is an expected answer here, not an error:
// it comes back as `null` and nothing is written anywhere. Output is decoded with the system
// code page when it is not UTF-8, so values holding non-ASCII paths stay readable.

import path from "node:path";

import { resolveWindowsSystemRoot } from "./platformEnvironment";
import { decodeNativeOutput } from "./platformEncoding";
import { spawnProcessSync } from "./processRuntime";

export interface WindowsRegistryQueryOptions {
  readonly timeoutMs?: number;
  /** Test seam: replaces the `reg.exe` run; returns the exit status and raw output bytes. */
  readonly run?: (args: ReadonlyArray<string>) => {
    readonly status: number | null;
    readonly stdout: Uint8Array;
  };
}

function runRegExe(args: ReadonlyArray<string>, timeoutMs: number) {
  const result = spawnProcessSync(
    path.win32.join(resolveWindowsSystemRoot(), "System32", "reg.exe"),
    args,
    { timeout: timeoutMs, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return { status: result.status, stdout: result.stdout ?? new Uint8Array(0) };
}

/**
 * Output of `reg query <args>`, or `null` when the key or value does not exist (reg.exe exits
 * with 1) or the query cannot run. Never prints and never throws.
 */
export function queryWindowsRegistry(
  args: ReadonlyArray<string>,
  options: WindowsRegistryQueryOptions = {},
): string | null {
  try {
    const result = options.run
      ? options.run(["query", ...args])
      : runRegExe(["query", ...args], options.timeoutMs ?? 5_000);
    if (result.status !== 0) return null;
    return decodeNativeOutput(result.stdout);
  } catch {
    return null;
  }
}

/** A string value (`REG_SZ` / `REG_EXPAND_SZ`) of a key, or `null` when it is not there. */
export function readWindowsRegistryString(
  key: string,
  valueName: string,
  options: WindowsRegistryQueryOptions = {},
): string | null {
  const output = queryWindowsRegistry([key, "/v", valueName], options);
  if (output === null) return null;
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`, "im").exec(output);
  const value = match?.[1]?.trim();
  return value ? value : null;
}
