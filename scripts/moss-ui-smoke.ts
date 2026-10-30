import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface MossUiSmokeCommand {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface MossUiSmokePlan {
  readonly version: 1;
  readonly commands: ReadonlyArray<MossUiSmokeCommand>;
}

export interface MossUiSmokeSpawnResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

export type MossUiSmokeSpawn = (
  command: string,
  args: ReadonlyArray<string>,
) => MossUiSmokeSpawnResult;

export const MOSS_UI_SMOKE_COMMANDS = [
  {
    id: "moss-promoted-shell-served-app-smoke",
    description:
      "Start the served Web app route and verify promoted Moss shell affordances under real app startup.",
    command: "node",
    args: ["scripts/moss-promoted-shell-served-smoke.ts"],
  },
  {
    id: "moss-control-plane-browser-smoke",
    description: "Run Moss Control panel and normalized timeline hook browser smoke tests.",
    command: "bun",
    args: [
      "--filter",
      "@synara/web",
      "test:browser",
      "--",
      "MossControlPlanePanel.browser.tsx",
      "mossNormalizedTimeline.browser.tsx",
    ],
  },
  {
    id: "moss-control-plane-unit-smoke",
    description: "Run Moss normalized timeline and control-panel unit tests.",
    command: "bun",
    args: [
      "--filter",
      "@synara/web",
      "test",
      "--",
      "mossNormalizedTimeline",
      "MossControlPlanePanel",
    ],
  },
  {
    id: "moss-web-typecheck",
    description: "Run Web package typecheck for Moss UI smoke boundaries.",
    command: "bun",
    args: ["--filter", "@synara/web", "typecheck"],
  },
] as const satisfies ReadonlyArray<MossUiSmokeCommand>;

export function buildMossUiSmokePlan(): MossUiSmokePlan {
  return {
    version: 1,
    commands: MOSS_UI_SMOKE_COMMANDS,
  };
}

export function runMossUiSmokeCommands(
  commands: ReadonlyArray<MossUiSmokeCommand> = MOSS_UI_SMOKE_COMMANDS,
  spawn: MossUiSmokeSpawn = spawnMossUiSmokeCommand,
): number {
  for (const entry of commands) {
    console.log(`\n[moss:ui-smoke] ${entry.id}`);
    console.log(`$ ${[entry.command, ...entry.args].join(" ")}`);
    const result = spawn(entry.command, entry.args);
    if (result.error) {
      console.error(`[moss:ui-smoke] ${entry.id} failed: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      const status = result.status ?? 1;
      console.error(`[moss:ui-smoke] ${entry.id} exited with ${status}`);
      return status;
    }
  }
  console.log("\n[moss:ui-smoke] pass");
  return 0;
}

function spawnMossUiSmokeCommand(
  command: string,
  args: ReadonlyArray<string>,
): MossUiSmokeSpawnResult {
  return spawnSync(command, args, {
    stdio: "inherit",
  });
}

function main(argv: ReadonlyArray<string>): number {
  if (argv.includes("--print-plan")) {
    console.log(JSON.stringify(buildMossUiSmokePlan(), null, 2));
    return 0;
  }
  return runMossUiSmokeCommands();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
