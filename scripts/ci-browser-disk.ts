// Phase caches belong only to one hosted component-browser worker.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
type Phase = "stable" | "compiler" | "geometry";
const PHASES: readonly Phase[] = ["stable", "compiler", "geometry"];
const OWNER_FILE = ".moss-browser-ci-owner.json";
export const BROWSER_PHASE_RESERVE_BYTES = 2n * 1024n ** 3n;

function exactDirectory(directory: string): string {
  const absolute = resolve(directory);
  const stat = lstatSync(absolute);
  if (
    !isAbsolute(directory) ||
    absolute === parse(absolute).root ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(absolute) !== absolute
  ) {
    throw new Error(`Refusing noncanonical browser CI directory: ${directory}`);
  }
  return absolute;
}

function identity(directory: string) {
  const stat = statSync(exactDirectory(directory), { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

export function browserDiskContext(env: Environment, platform: string = process.platform) {
  const shard = /^([12])\/2$/u.exec(env.MOSS_CI_BROWSER_LANE ?? "")?.[1];
  if (
    platform !== "linux" ||
    env.RUNNER_OS !== "Linux" ||
    env.MOSS_CI_RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_JOB !== "browser" ||
    env.MOSS_CI_BROWSER_PROJECT !== "components" ||
    !shard ||
    !/^\d+$/u.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")
  ) {
    throw new Error("Disk preparation requires a hosted Linux component-browser shard.");
  }
  const workspace = exactDirectory(env.GITHUB_WORKSPACE ?? "");
  const temporary = exactDirectory(env.RUNNER_TEMP ?? "");
  const root = join(
    temporary,
    `moss-browser-vite-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${shard}`,
  );
  return {
    workspace,
    temporary,
    root,
    phases: Object.fromEntries(PHASES.map((phase) => [phase, join(root, phase)])) as Record<
      Phase,
      string
    >,
    owner: {
      workspace,
      run: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      job: "browser",
      project: "components",
      lane: env.MOSS_CI_BROWSER_LANE,
    },
  };
}

type DiskContext = ReturnType<typeof browserDiskContext>;

export function initializeBrowserCaches(context: DiskContext): void {
  exactDirectory(context.workspace);
  exactDirectory(context.temporary);
  // Exclusive creation refuses caches left by any other invocation.
  mkdirSync(context.root);
  for (const directory of Object.values(context.phases)) mkdirSync(directory);
  const owner = {
    ...context.owner,
    rootIdentity: identity(context.root),
    phaseIdentities: Object.fromEntries(
      PHASES.map((phase) => [phase, identity(context.phases[phase])]),
    ),
  };
  writeFileSync(join(context.root, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
}

export function releaseBrowserCache(context: DiskContext, phase: Exclude<Phase, "geometry">): void {
  if (phase !== "stable" && phase !== "compiler") {
    throw new Error("Only completed stable/compiler browser caches can be released.");
  }
  exactDirectory(context.workspace);
  exactDirectory(context.temporary);
  exactDirectory(context.root);
  const marker = join(context.root, OWNER_FILE);
  if (lstatSync(marker).isSymbolicLink() || !lstatSync(marker).isFile()) {
    throw new Error("Browser cache owner must remain a regular file.");
  }
  const owner = JSON.parse(readFileSync(marker, "utf8"));
  for (const [key, value] of Object.entries(context.owner)) {
    if (owner[key] !== value) throw new Error("Browser cache belongs to another worker.");
  }
  if (
    JSON.stringify(owner.rootIdentity) !== JSON.stringify(identity(context.root)) ||
    JSON.stringify(owner.phaseIdentities?.[phase]) !==
      JSON.stringify(identity(context.phases[phase]))
  ) {
    throw new Error("Browser cache directory identity changed.");
  }
  // The workflow calls this only after that phase succeeds and Vitest exits.
  // Leave the current/next phase, all dependency trees and tools untouched.
  rmSync(context.phases[phase], { recursive: true });
}

export function requireBrowserDiskReserve(availableBytes: bigint): void {
  if (availableBytes < BROWSER_PHASE_RESERVE_BYTES) {
    throw new Error(
      `Browser phase has ${availableBytes} available bytes; requires ${BROWSER_PHASE_RESERVE_BYTES} bytes operational reserve (not a measured peak).`,
    );
  }
}

function reportDisk(context: DiskContext, stage: string): void {
  console.log(`[browser-ci-disk] ${stage}`);
  const directories = [
    context.workspace,
    join(context.workspace, "node_modules"),
    join(context.workspace, "apps/web/node_modules/.vite"),
    join(context.workspace, ".turbo"),
    context.root,
    ...Object.values(context.phases),
    join(homedir(), ".bun/install/cache"),
    join(homedir(), ".cache/ms-playwright"),
    context.temporary,
  ].filter(existsSync);
  const deadline = Date.now() + 15_000;
  const diagnostics: Array<[string, string[]]> = [
    ["df", ["-Pk", context.workspace, context.temporary, homedir()]],
    ...directories.map((directory): [string, string[]] => ["du", ["-sk", directory]]),
  ];
  for (const [command, args] of diagnostics) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn("[browser-ci-disk] diagnostic deadline reached");
      break;
    }
    const result = spawnSync(command, args, { encoding: "utf8", timeout: remaining });
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.error || result.status !== 0) {
      console.warn(`[browser-ci-disk] ${command} diagnostic incomplete`);
    }
  }
}

function main(): void {
  const context = browserDiskContext(process.env);
  const mode = process.argv[2];
  if (mode === "initialize") {
    const environmentFile = process.env.GITHUB_ENV ?? "";
    const absolute = resolve(environmentFile);
    if (
      !isAbsolute(environmentFile) ||
      !absolute.startsWith(context.temporary + sep) ||
      lstatSync(absolute).isSymbolicLink() ||
      !lstatSync(absolute).isFile() ||
      realpathSync(absolute) !== absolute
    ) {
      throw new Error("Browser cache environment file must remain under runner temporary files.");
    }
    initializeBrowserCaches(context);
    appendFileSync(
      absolute,
      PHASES.map(
        (phase) => `MOSS_BROWSER_${phase.toUpperCase()}_CACHE_DIR=${context.phases[phase]}\n`,
      ).join(""),
    );
  } else if (mode === "release-stable" || mode === "release-compiler") {
    const phase = mode === "release-stable" ? "stable" : "compiler";
    reportDisk(context, `after-${phase}-before-cleanup`);
    releaseBrowserCache(context, phase);
  } else if (mode !== "observe") {
    throw new Error(`Unknown browser disk command: ${mode}`);
  }
  const stage =
    mode === "initialize"
      ? "before-stable"
      : mode === "release-stable"
        ? "after-stable-cleanup-before-compiler"
        : mode === "release-compiler"
          ? "after-compiler-cleanup-before-geometry"
          : process.argv[3];
  if (!stage || !/^[a-z-]+$/u.test(stage)) throw new Error("Unknown browser disk stage.");
  reportDisk(context, stage);
  if (mode !== "observe") {
    const stat = statfsSync(context.temporary, { bigint: true });
    const available = stat.bavail * stat.bsize;
    console.log(`[browser-ci-disk] availableBytes=${available}`);
    requireBrowserDiskReserve(available);
  }
}

if (import.meta.main) main();
