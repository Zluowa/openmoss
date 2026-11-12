// FILE: tools/queue/lib/lanes.ts
// Purpose: The verification lanes as data: what runs where, how a failing part is rerun alone,
//          and which files make a PR a suspect for a lane.
// Layer: tool library
// Exports: LaneSpec, LANES, LANE_ENV, selectLanes, laneCommand, quarantineId, laneByName

import { namePattern } from "./vitest.ts";

export type RerunMode =
  /** Rerun the failing files, by path. */
  | "files"
  /** Rerun the failing tests by name (`-t`): one big file holds the whole lane. */
  | "names"
  /** Rerun the whole lane. */
  | "lane";

export interface LaneSpec {
  readonly name: string;
  readonly group: "static" | "unit" | "browser" | "smoke";
  /** Folder the command runs in, relative to the checkout. */
  readonly cwd: string;
  /**
   * The command. `$bun` and `$node` are the configured tools; `$bin:<name>` is
   * `<cwd>/node_modules/.bin/<name>`; `{port:N}` is the run's browser port base plus N.
   */
  readonly command: readonly string[];
  /** Extra environment; `{port:N}` as in the command. */
  readonly env?: Readonly<Record<string, string>>;
  /** `remote` lanes run on the second machine when one is configured, else locally. */
  readonly where: "local" | "remote";
  /** Output is a Vitest run: failures are read from it. */
  readonly vitest: boolean;
  readonly rerun: RerunMode;
  /**
   * A PR is a suspect for this lane's failures when it touches a file under one of these folders
   * (repository-relative). Empty: every PR of the batch is.
   */
  readonly suspects: readonly string[];
  /** Lane name in `test-quarantine.json` ids, when the quarantine list covers this lane. */
  readonly quarantineLane?: string;
}

/** Set for every lane: the operator's scripts unset these before running anything. */
export const LANE_ENV: Readonly<Record<string, string | null>> = {
  CLAUDE_CODE_CHILD_SESSION: null,
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: null,
};

const vitestUnit = (workers: number) =>
  ["$bin:vitest", "run", "--passWithNoTests", `--maxWorkers=${workers}`] as const;

const browserFlags = (port: string) =>
  [
    `--browser.api.port=${port}`,
    "--browser.api.strictPort",
    "--browser.connectTimeout=300000",
  ] as const;

/** In the order they run, as in the coordinator's verify-full-nocomp.sh. */
export const LANES: readonly LaneSpec[] = [
  {
    name: "fmt",
    group: "static",
    cwd: ".",
    command: ["$bun", "run", "fmt:check"],
    where: "local",
    vitest: false,
    rerun: "lane",
    suspects: [],
  },
  {
    name: "lint",
    group: "static",
    cwd: ".",
    command: ["$bun", "run", "lint"],
    where: "local",
    vitest: false,
    rerun: "lane",
    suspects: [],
  },
  {
    name: "winruntime",
    group: "static",
    cwd: ".",
    command: ["$bun", "run", "windows-runtime:check"],
    where: "local",
    vitest: false,
    rerun: "lane",
    suspects: [],
  },
  {
    name: "migrations",
    group: "static",
    cwd: ".",
    command: ["$bun", "run", "migrations:check"],
    where: "local",
    vitest: false,
    rerun: "lane",
    suspects: [],
  },
  {
    name: "typecheck",
    group: "static",
    cwd: ".",
    command: ["$bin:turbo", "run", "typecheck", "--continue", "--filter=!@moss/marketing"],
    where: "local",
    vitest: false,
    rerun: "lane",
    suspects: [],
  },
  {
    name: "contracts",
    group: "unit",
    cwd: "packages/contracts",
    command: vitestUnit(4),
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["packages/contracts/"],
    quarantineLane: "contracts",
  },
  {
    name: "shared",
    group: "unit",
    cwd: "packages/shared",
    command: vitestUnit(4),
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["packages/shared/"],
    quarantineLane: "shared",
  },
  {
    name: "desktop",
    group: "unit",
    cwd: "apps/desktop",
    command: vitestUnit(4),
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["apps/desktop/"],
    quarantineLane: "desktop",
  },
  {
    name: "web",
    group: "unit",
    cwd: "apps/web",
    command: vitestUnit(3),
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["apps/web/"],
    quarantineLane: "web",
  },
  {
    name: "chat",
    group: "browser",
    cwd: "apps/web",
    command: [
      "$bin:vitest",
      "run",
      "--config",
      "vitest.browser.ci.config.ts",
      "--project=chat",
      ...browserFlags("{port:1}"),
    ],
    env: { VITEST_BROWSER_API_PORT: "{port:0}", MOSS_BROWSER_CASE_PARTITION: "1/1" },
    where: "local",
    vitest: true,
    rerun: "names",
    suspects: ["apps/web/"],
    quarantineLane: "chat",
  },
  {
    name: "compiler",
    group: "browser",
    cwd: "apps/web",
    command: [
      "$bin:vitest",
      "run",
      "--config",
      "vitest.browser.compiler.config.ts",
      ...browserFlags("{port:2}"),
    ],
    env: { VITEST_BROWSER_API_PORT: "{port:2}" },
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["apps/web/"],
  },
  {
    name: "server",
    group: "unit",
    cwd: "apps/server",
    command: vitestUnit(4),
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["apps/server/"],
    quarantineLane: "server",
  },
  {
    name: "scripts",
    group: "unit",
    cwd: ".",
    command: [...vitestUnit(4), "--dir", "scripts"],
    where: "local",
    vitest: true,
    rerun: "files",
    suspects: ["scripts/"],
    quarantineLane: "scripts",
  },
  {
    name: "releasesmoke",
    group: "smoke",
    cwd: ".",
    command: ["$node", "scripts/release-smoke.ts"],
    where: "local",
    vitest: false,
    rerun: "lane",
    suspects: [],
  },
  {
    name: "components",
    group: "browser",
    cwd: "apps/web",
    command: [
      "$bin:vitest",
      "run",
      "--config",
      "vitest.browser.ci.config.ts",
      "--project=components",
      ...browserFlags("{port:0}"),
    ],
    env: { VITEST_BROWSER_API_PORT: "{port:0}" },
    where: "remote",
    vitest: true,
    rerun: "files",
    suspects: ["apps/web/"],
    quarantineLane: "components",
  },
];

export function laneByName(name: string): LaneSpec | undefined {
  return LANES.find((l) => l.name === name);
}

/** Lanes named by `--only` (in table order), or every lane; unknown names are an error. */
export function selectLanes(only: readonly string[] | undefined): LaneSpec[] {
  if (!only || only.length === 0) return [...LANES];
  const unknown = only.filter((n) => !laneByName(n));
  if (unknown.length)
    throw new Error(
      `unknown lane ${unknown.join(", ")}; lanes: ${LANES.map((l) => l.name).join(", ")}`,
    );
  return LANES.filter((l) => only.includes(l.name));
}

export interface CommandContext {
  readonly bun: string;
  readonly node: string;
  readonly portBase: number;
  /** How `$bin:<name>` is spelled where the lane runs. */
  readonly bin: (cwd: string, name: string) => string;
}

export interface Selection {
  readonly files?: readonly string[] | undefined;
  readonly names?: readonly string[] | undefined;
  /** `k/n`: Vitest's own sharding. */
  readonly shard?: string | undefined;
}

function fill(value: string, portBase: number): string {
  return value.replace(/\{port:(\d+)\}/g, (_, n: string) => String(portBase + Number(n)));
}

/** The program, arguments and environment of one lane run. */
export function laneCommand(
  lane: LaneSpec,
  ctx: CommandContext,
  selection: Selection = {},
): { cmd: string; args: string[]; env: Record<string, string> } {
  const [first, ...rest] = lane.command.map((t) => fill(t, ctx.portBase));
  const cmd =
    first === "$bun"
      ? ctx.bun
      : first === "$node"
        ? ctx.node
        : first!.startsWith("$bin:")
          ? ctx.bin(lane.cwd, first!.slice(5))
          : first!;
  const args = [...rest];
  if (selection.shard) args.push(`--shard=${selection.shard}`);
  const selective = (selection.files?.length ?? 0) > 0 || (selection.names?.length ?? 0) > 0;
  if (selective && lane.vitest) args.push("--no-file-parallelism");
  if (selection.names?.length) args.push("-t", namePattern(selection.names));
  if (selection.files?.length) args.push(...selection.files);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(lane.env ?? {})) env[k] = fill(v, ctx.portBase);
  return { cmd, args, env };
}

/** The `test-quarantine.json` id for a failure, when the lane is covered by the list. */
export function quarantineId(
  lane: LaneSpec,
  file: string,
  name: string | undefined,
): string | undefined {
  if (!lane.quarantineLane || !file) return undefined;
  const repoPath = lane.cwd === "." ? file : `${lane.cwd}/${file}`;
  return `${lane.quarantineLane}:${repoPath}${name ? ` > ${name}` : ""}`;
}
