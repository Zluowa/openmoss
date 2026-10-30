/**
 * Moss projection materializer CLI (control-plane tool).
 *
 * Projects the workspace's `.moss` unified source into provider-native paths
 * (codex + claudeAgent in this slice) and prints the materialization JSON to
 * stdout. This is a control-plane command: runtime session wiring is SY3,
 * provider-visible MCP config is SY4.
 *
 * Usage:
 *   bun scripts/moss-materialize.ts [--workspace <path>] [--engines codex,claudeAgent] [--dry-run]
 *   bun scripts/moss-materialize.ts --summary [--workspace <path>]
 *   bun scripts/moss-materialize.ts --remove <resourceId> [--source <path>]
 *       [--target <path>]... [--remove-targets] [--workspace <path>]
 *
 * Exit codes: 1 when any mapping conflicts, an engine projection fails, or the
 * manifest summary reports a parse error; 0 otherwise.
 */
import { pathToFileURL } from "node:url";

import { isSupportedProviderKind, type SupportedProviderKind } from "@synara/contracts";
import {
  materializeMossWorkspaceProjections,
  readMossProjectionManifestSummary,
  removeMossProjectionResource,
  type MaterializedMossWorkspaceProjections,
  type MossProjectionManifestSummary,
  type RemoveMossProjectionResourceResult,
} from "@synara/shared/mossProjectionMaterializer";

export interface MossMaterializeCliOptions {
  workspace: string;
  mode: "materialize" | "summary" | "remove";
  engines?: SupportedProviderKind[] | undefined;
  dryRun: boolean;
  remove?:
    | {
        resourceId: string;
        sourcePath?: string | undefined;
        targetPaths: string[];
        removeTargets: boolean;
      }
    | undefined;
}

function requireValue(argv: ReadonlyArray<string>, index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseMossMaterializeArgs(
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
): MossMaterializeCliOptions {
  const options: MossMaterializeCliOptions = {
    workspace: cwd,
    mode: "materialize",
    dryRun: false,
  };
  let removeResourceId: string | undefined;
  let removeSourcePath: string | undefined;
  const removeTargetPaths: string[] = [];
  let removeTargets = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      options.workspace = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--engines") {
      const raw = requireValue(argv, index, arg);
      const engines = raw
        .split(",")
        .map((engine) => engine.trim())
        .filter(Boolean);
      if (engines.length === 0) {
        throw new Error("--engines requires a comma-separated provider list");
      }
      for (const engine of engines) {
        if (!isSupportedProviderKind(engine)) {
          throw new Error(`unknown provider kind: ${engine}`);
        }
      }
      options.engines = engines as SupportedProviderKind[];
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--summary") {
      options.mode = "summary";
      continue;
    }
    if (arg === "--remove") {
      options.mode = "remove";
      removeResourceId = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--source") {
      removeSourcePath = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--target") {
      removeTargetPaths.push(requireValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--remove-targets") {
      removeTargets = true;
      continue;
    }
    throw new Error(`unknown moss materialize option: ${arg}`);
  }

  if (options.mode === "remove") {
    if (!removeResourceId) {
      throw new Error("--remove requires a resource id");
    }
    options.remove = {
      resourceId: removeResourceId,
      sourcePath: removeSourcePath,
      targetPaths: removeTargetPaths,
      removeTargets,
    };
  } else if (removeSourcePath || removeTargetPaths.length > 0 || removeTargets) {
    throw new Error("--source/--target/--remove-targets require --remove <resourceId>");
  }

  return options;
}

export function mossMaterializeExitCode(output: MaterializedMossWorkspaceProjections): number {
  for (const projection of output.projections) {
    if (projection.failed) return 1;
    if (projection.summary.conflict > 0) return 1;
  }
  return 0;
}

export function mossSummaryExitCode(summary: MossProjectionManifestSummary): number {
  return summary.status === "parse-error" ? 1 : 0;
}

function printJson(
  value:
    | MaterializedMossWorkspaceProjections
    | MossProjectionManifestSummary
    | RemoveMossProjectionResourceResult,
): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseMossMaterializeArgs(process.argv.slice(2));

  if (options.mode === "summary") {
    const summary = await readMossProjectionManifestSummary(options.workspace);
    printJson(summary);
    process.exitCode = mossSummaryExitCode(summary);
    return;
  }

  if (options.mode === "remove" && options.remove) {
    const result = await removeMossProjectionResource({
      projectPath: options.workspace,
      resourceId: options.remove.resourceId,
      sourcePath: options.remove.sourcePath,
      targetPaths: options.remove.targetPaths,
      removeTargets: options.remove.removeTargets,
    });
    printJson(result);
    process.exitCode = 0;
    return;
  }

  const output = await materializeMossWorkspaceProjections({
    projectPath: options.workspace,
    engines: options.engines,
    dryRun: options.dryRun,
  });
  printJson(output);
  process.exitCode = mossMaterializeExitCode(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
