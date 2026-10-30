/**
 * Moss hooks trust CLI (control-plane tool).
 *
 * Moss's minimal counterpart of the 1code settings hooks UI (S4.4): lists
 * discovered `.moss/hooks/*.md` entries with their trust state and records
 * trust decisions in `.moss/hooks/.trust.json` at the CURRENT content hash.
 *
 * This is a control-plane tool only — the runtime trust gate itself lives in
 * `@synara/shared/mossHooks` and is enforced on the real session-start path
 * by `ProviderService` (see `mossSessionStartHookRunner`). Trusting a hook
 * here is what allows that runtime path to execute it.
 *
 * Usage:
 *   bun scripts/moss-hooks.ts list [--workspace <path>] [--json]
 *   bun scripts/moss-hooks.ts trust <name> [--workspace <path>]
 *   bun scripts/moss-hooks.ts trust --all [--workspace <path>]
 */
import { pathToFileURL } from "node:url";

import { trustAllHooks, trustHook } from "@synara/shared/mossHookTrust";
import { discoverMossHooks, type MossHookResource } from "@synara/shared/mossHooks";

export interface MossHooksCliCommand {
  readonly action: "list" | "trust";
  readonly workspace: string;
  readonly json: boolean;
  /** For `trust`: hook name, or undefined with `all: true`. */
  readonly hookName?: string;
  readonly all: boolean;
}

export function parseMossHooksCliArgs(
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
): MossHooksCliCommand {
  const [action, ...rest] = argv;
  if (action !== "list" && action !== "trust") {
    throw new Error(`unknown moss hooks command: ${action ?? "(none)"} (expected list|trust)`);
  }

  let workspace = cwd;
  let json = false;
  let all = false;
  let hookName: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--workspace") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--workspace requires a path");
      }
      workspace = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg !== undefined && !arg.startsWith("--") && hookName === undefined) {
      hookName = arg;
      continue;
    }
    throw new Error(`unknown moss hooks option: ${arg}`);
  }

  if (action === "trust" && !all && !hookName) {
    throw new Error("trust requires a hook name or --all");
  }
  if (action === "trust" && all && hookName) {
    throw new Error("trust takes either a hook name or --all, not both");
  }

  return { action, workspace, json, all, ...(hookName ? { hookName } : {}) };
}

export function renderHookList(resources: ReadonlyArray<MossHookResource>): string {
  if (resources.length === 0) {
    return "no .moss hooks discovered\n";
  }
  const lines = resources.map(
    (resource) =>
      `${resource.name}\t${resource.event}\t${resource.enabled ? "enabled" : "disabled"}\t${resource.trustState}\t${resource.command ?? "(no command)"}`,
  );
  return `name\tevent\tenabled\ttrust\tcommand\n${lines.join("\n")}\n`;
}

export interface MossHooksTrustOutcome {
  readonly trusted: ReadonlyArray<string>;
}

export async function runMossHooksCli(
  command: MossHooksCliCommand,
  write: (text: string) => void,
): Promise<void> {
  const resources = await discoverMossHooks(command.workspace);

  if (command.action === "list") {
    write(command.json ? `${JSON.stringify(resources, null, 2)}\n` : renderHookList(resources));
    return;
  }

  if (command.all) {
    await trustAllHooks({
      projectPath: command.workspace,
      hooks: resources.map((resource) => ({
        name: resource.name,
        trustedHash: resource.trustHash,
      })),
    });
    const outcome: MossHooksTrustOutcome = {
      trusted: resources.map((resource) => resource.name),
    };
    write(`${JSON.stringify(outcome, null, 2)}\n`);
    return;
  }

  const resource = resources.find((entry) => entry.name === command.hookName);
  if (!resource) {
    throw new Error(
      `no .moss hook named '${command.hookName}' in ${command.workspace} (run: bun scripts/moss-hooks.ts list)`,
    );
  }
  await trustHook({
    projectPath: command.workspace,
    hookName: resource.name,
    trustedHash: resource.trustHash,
  });
  const outcome: MossHooksTrustOutcome = { trusted: [resource.name] };
  write(`${JSON.stringify(outcome, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = parseMossHooksCliArgs(process.argv.slice(2));
  await runMossHooksCli(command, (text) => process.stdout.write(text));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
