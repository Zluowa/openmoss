/**
 * Moss workspace bootstrap CLI (control-plane tool).
 *
 * Idempotently materializes the Moss unified-source tree for a workspace and
 * prints the `EnsureMossSourceResult` JSON to stdout. Exits non-zero when the
 * workspace conflicts with the expected layout (for example when the Moss root
 * exists as a plain file).
 *
 * Usage: bun scripts/moss-bootstrap.ts [--workspace <path>]
 */
import { pathToFileURL } from "node:url";

import { ensureMossSource, type EnsureMossSourceResult } from "@synara/shared/mossSourceBootstrap";

export function parseBootstrapWorkspace(argv: ReadonlyArray<string>, cwd = process.cwd()): string {
  let workspace = cwd;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--workspace requires a path");
      }
      workspace = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown moss bootstrap option: ${arg}`);
  }

  return workspace;
}

export function mossBootstrapExitCode(result: EnsureMossSourceResult): number {
  return result.status === "conflict" ? 1 : 0;
}

async function main(): Promise<void> {
  const workspace = parseBootstrapWorkspace(process.argv.slice(2));
  const result = await ensureMossSource({ projectPath: workspace });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = mossBootstrapExitCode(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
