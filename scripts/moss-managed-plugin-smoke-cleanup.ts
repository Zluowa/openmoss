import { lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class ManagedPluginSmokeFinalizationError extends Error {
  constructor(
    readonly stage: "workspace-cleanup" | "report",
    cause: unknown,
  ) {
    super(`Managed plugin smoke ${stage} failed: ${String(cause)}`, { cause });
    this.name = "ManagedPluginSmokeFinalizationError";
  }
}

/** Called only after the native lifecycle and required process-tree teardown pass. */
export async function finalizeManagedPluginSmoke(
  report: Readonly<Record<string, unknown>>,
  options: { root: string; keepWorkspace: boolean; output?: string },
): Promise<void> {
  if (!options.keepWorkspace) {
    try {
      // Bun 1.4.2 does not honor fs.rm's native retries for these Windows locks.
      // At most four removals and 600ms of delay, only AFTER process-tree proof.
      // A permanent lock still fails; this never extends the production proof.
      for (let attempt = 0; attempt <= 3; attempt += 1) {
        try {
          await rm(options.root, { recursive: true, force: true });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (attempt === 3 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
          await delay((attempt + 1) * 100);
        }
      }
      const remaining = await lstat(options.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (remaining !== null) throw new Error("Managed plugin smoke workspace still exists.");
    } catch (cause) {
      throw new ManagedPluginSmokeFinalizationError("workspace-cleanup", cause);
    }
  }
  const completed = {
    ...report,
    workspaceCleanup: options.keepWorkspace ? "retained-by-request" : "removed",
    ...(options.keepWorkspace ? { workspace: options.root } : {}),
  };
  try {
    const serialized = `${JSON.stringify(completed, null, 2)}\n`;
    if (options.output) await writeFile(path.resolve(options.output), serialized);
    console.log(serialized.trimEnd());
  } catch (cause) {
    throw new ManagedPluginSmokeFinalizationError("report", cause);
  }
}
