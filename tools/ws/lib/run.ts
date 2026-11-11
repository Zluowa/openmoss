// Child-process helpers. Never use a shell for these: arguments go straight to the program.
import { spawn, spawnSync } from "node:child_process";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSync(
  cmd: string,
  args: readonly string[],
  cwd?: string,
  timeoutMs = 120_000,
): RunResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
}

export function runAsync(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
