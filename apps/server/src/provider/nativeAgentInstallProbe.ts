// Short native installer probes with real Node close observation. The existing
// process boundary and teardown owner remain authoritative for Windows trees.
import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "@moss/shared/processRuntime";
import { Duration, Effect } from "effect";
import {
  spawnChildWithPreparedTree,
  teardownChildProcessTree,
} from "../platform/supervisedProcessTeardown.ts";
import { spawnGuardedProviderChild } from "../platform/windowsProviderProcessGuard.ts";
import type { AgentInstallCommandResult, AgentInstallCommandRunner } from "./providerInstall.ts";

interface OwnedProbe {
  child: ChildProcess;
  closed: Promise<AgentInstallCommandResult>;
  didClose: boolean;
}

function bindProbe(child: ChildProcess): OwnedProbe {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const lengths = { stdout: 0, stderr: 0 };
  let spawnError: Error | undefined;
  const owned = { child, didClose: false } as OwnedProbe;
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = 4_096 - lengths[stream];
      if (remaining > 0) {
        chunks[stream].push(data.subarray(0, remaining));
        lengths[stream] += Math.min(data.length, remaining);
      }
      // Keep draining once the output budget is reached.
    });
  }
  child.once("error", (cause) => {
    spawnError = cause;
  });
  owned.closed = new Promise((resolve) => {
    child.once("close", (code) => {
      owned.didClose = true;
      resolve({
        exitCode: spawnError ? -1 : (code ?? -1),
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: spawnError
          ? "Native install probe failed to start."
          : Buffer.concat(chunks.stderr).toString("utf8"),
      });
    });
  });
  return owned;
}

async function awaitClose(owned: OwnedProbe): Promise<void> {
  if (owned.didClose) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      owned.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native install probe stdio close is unproven.")),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** onUnproven runs inside the scope before the install can clean its staging. */
export function makeNativeAgentInstallProbe(
  onUnproven: Effect.Effect<void>,
  options: { readonly timeoutMs?: number } = {},
): AgentInstallCommandRunner {
  return (input) =>
    Effect.gen(function* () {
      const owned = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) =>
            spawnChildWithPreparedTree({
              signal,
              beforeSpawn: () => signal.throwIfAborted(),
              spawn: () =>
                spawnGuardedProviderChild(() =>
                  spawnProcess(input.command, input.args, {
                    env: input.env,
                    cwd: input.env.HOME,
                    stdio: ["ignore", "pipe", "pipe"],
                  }),
                ),
              bind: bindProbe,
            }),
          catch: (cause) => cause,
        }),
        (probe) =>
          Effect.tryPromise(async () => {
            if (!probe.didClose) {
              await teardownChildProcessTree(probe.child);
              await awaitClose(probe);
            }
          }).pipe(Effect.catch(() => onUnproven)),
      );
      return yield* Effect.promise(() => owned.closed).pipe(
        Effect.timeoutOption(Duration.millis(options.timeoutMs ?? 15_000)),
      );
    }).pipe(Effect.scoped);
}
