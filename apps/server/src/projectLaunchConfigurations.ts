/**
 * The servers a project lists for preview, read on demand while a list is on screen.
 *
 * Order of sources: `.moss/launch.json` (Moss's own), then `.claude/launch.json` (the
 * same shape, which many projects already have; its entries join under names the Moss
 * file does not use). With neither file, the dev scripts found in package.json are
 * offered instead, with the port their tool usually takes.
 *
 * The file shape: `{ "configurations": [{ "name", "runtimeExecutable", "runtimeArgs",
 * "port", "url"?, "cwd"?, "env"? }] }`. An entry with a `url` and no executable only
 * opens that address. Comments and trailing commas are allowed, as in editor launch files.
 *
 * @module projectLaunchConfigurations
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  PROJECT_CLAUDE_LAUNCH_FILE,
  PROJECT_LAUNCH_NAME_MAX_LENGTH,
  PROJECT_MOSS_LAUNCH_FILE,
  type ProjectLaunchConfiguration,
  type ProjectReadLaunchConfigurationsInput,
  type ProjectReadLaunchConfigurationsResult,
} from "@moss/contracts";

import { discoverProjectScripts } from "./workspaceEntries";

const LAUNCH_FILE_MAX_BYTES = 256 * 1024;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const MAX_CONFIGURATIONS = 50;
const MAX_PACKAGE_SCRIPT_CONFIGURATIONS = 12;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Script names that start something to look at, in the order they are offered. */
const DEV_SCRIPT_NAMES = ["dev", "start", "serve", "preview", "storybook"] as const;
const DEV_SCRIPT_NAME_PATTERN = /^(dev|start|serve|preview|storybook)(?::[\w-]+)?$/;

/** Strips `//` and block comments and trailing commas outside strings (JSONC). */
export function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  // Trailing commas before a closing bracket (outside strings; strings were kept intact
  // above, and a comma followed only by whitespace and a bracket cannot sit in one).
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * One argument as the project's shell reads it: PowerShell on Windows, sh elsewhere.
 * Single quotes are literal in both; only the quote itself needs escaping.
 */
export function quoteShellArgument(
  argument: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (/^[\w@%+=:,./\\-]+$/.test(argument)) return argument;
  return platform === "win32"
    ? `'${argument.replace(/'/g, "''")}'`
    : `'${argument.replace(/'/g, "'\\''")}'`;
}

export function launchCommandLine(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const quotedExecutable = quoteShellArgument(executable, platform);
  // PowerShell reads a quoted first word as a string, not a program; `&` runs it.
  const head =
    platform === "win32" && quotedExecutable !== executable
      ? `& ${quotedExecutable}`
      : quotedExecutable;
  return [head, ...args.map((arg) => quoteShellArgument(arg, platform))].join(" ");
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function localUrlForPort(port: number): string {
  return `http://localhost:${port}/`;
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reads one launch file's text into configurations. Entries that cannot run are skipped
 * with a plain-words reason, so one bad entry never hides the rest.
 */
export function parseLaunchFile(input: {
  readonly text: string;
  readonly projectRoot: string;
  readonly fileLabel: string;
  readonly platform?: NodeJS.Platform;
}): { configurations: ProjectLaunchConfiguration[]; problems: string[] } {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(input.text));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { configurations: [], problems: [`${input.fileLabel} is not valid JSON: ${reason}`] };
  }
  const rawList =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).configurations
      : undefined;
  if (!Array.isArray(rawList)) {
    return {
      configurations: [],
      problems: [`${input.fileLabel} has no "configurations" list.`],
    };
  }

  const configurations: ProjectLaunchConfiguration[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawList.entries()) {
    if (configurations.length >= MAX_CONFIGURATIONS) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${input.fileLabel}: entry ${index + 1} is not an object.`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) {
      problems.push(`${input.fileLabel}: entry ${index + 1} has no name.`);
      continue;
    }
    if (name.length > PROJECT_LAUNCH_NAME_MAX_LENGTH) {
      problems.push(`${input.fileLabel}: "${name.slice(0, 40)}…" has a name that is too long.`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${input.fileLabel}: "${name}" is listed twice; the first one is used.`);
      continue;
    }
    const executable =
      typeof entry.runtimeExecutable === "string" ? entry.runtimeExecutable.trim() : "";
    const rawArgs = entry.runtimeArgs;
    if (
      rawArgs !== undefined &&
      (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string"))
    ) {
      problems.push(`${input.fileLabel}: "${name}" has runtimeArgs that are not all text.`);
      continue;
    }
    const args = (rawArgs as string[] | undefined) ?? [];
    const port = isValidPort(entry.port) ? entry.port : null;
    if (entry.port !== undefined && port === null) {
      problems.push(
        `${input.fileLabel}: "${name}" has a port that is not a number from 1 to 65535.`,
      );
    }
    let url: string | null = null;
    let urlPort: number | null = null;
    if (typeof entry.url === "string" && entry.url.trim()) {
      try {
        const parsedUrl = new URL(entry.url.trim());
        if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
          url = parsedUrl.toString();
          // A local address's port is the one to watch for it answering.
          const explicitPort = Number(parsedUrl.port);
          if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsedUrl.hostname) && explicitPort) {
            urlPort = explicitPort;
          }
        }
      } catch {
        // Reported below as an entry that cannot run.
      }
    }
    if (!executable && !url) {
      problems.push(`${input.fileLabel}: "${name}" has neither a runtimeExecutable nor a url.`);
      continue;
    }
    let cwd = input.projectRoot;
    if (typeof entry.cwd === "string" && entry.cwd.trim()) {
      const resolved = path.resolve(input.projectRoot, entry.cwd.trim());
      if (!withinRoot(input.projectRoot, resolved)) {
        problems.push(`${input.fileLabel}: "${name}" has a cwd outside the project.`);
        continue;
      }
      cwd = resolved;
    }
    let env: Record<string, string> | undefined;
    if (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
      const values = Object.entries(entry.env as Record<string, unknown>).filter(
        (pair): pair is [string, string] =>
          ENV_KEY_PATTERN.test(pair[0]) && typeof pair[1] === "string",
      );
      if (values.length > 0) env = Object.fromEntries(values);
    }
    seen.add(name);
    configurations.push({
      name,
      command: executable ? launchCommandLine(executable, args, input.platform) : null,
      cwd,
      port: port ?? urlPort,
      url: url ?? (port !== null ? localUrlForPort(port) : null),
      ...(env ? { env } : {}),
    });
  }
  return { configurations, problems };
}

/**
 * The port a dev script usually serves on: an explicit `--port`/`-p`/`PORT=`, else the
 * default of the tool it runs. Null when the script does not say and the tool is unknown;
 * the run then reports the port it prints once it answers.
 */
export function inferDevScriptPort(scriptBody: string): number | null {
  const explicit =
    /(?:^|\s)(?:--port|-p)(?:=|\s+)(\d{2,5})\b/.exec(scriptBody) ??
    /\bPORT=(\d{2,5})\b/.exec(scriptBody);
  if (explicit) {
    const port = Number(explicit[1]);
    return isValidPort(port) ? port : null;
  }
  const defaults: ReadonlyArray<readonly [RegExp, number]> = [
    [/\bvite\s+preview\b/, 4173],
    [/\bvite\b(?!\s+build)/, 5173],
    [/\bnext\s+(?:dev|start)\b/, 3000],
    [/\bnuxi?\s+(?:dev|preview)\b/, 3000],
    [/\bastro\s+(?:dev|preview)\b/, 4321],
    [/\breact-scripts\s+start\b/, 3000],
    [/\bng\s+serve\b/, 4200],
    [/\bwebpack(?:-dev-server|\s+serve)\b/, 8080],
    [/\bgatsby\s+develop\b/, 8000],
    [/\bstorybook\s+dev\b|\bstart-storybook\b/, 6006],
    [/\bdocusaurus\s+start\b/, 3000],
    [/\bparcel\b(?!\s+build)/, 1234],
    [/\bwrangler\s+dev\b/, 8787],
    [/\bhttp-server\b/, 8080],
    [/\bhttp\.server\b/, 8000],
  ];
  for (const [pattern, port] of defaults) {
    if (pattern.test(scriptBody)) return port;
  }
  return null;
}

async function readTextFile(absolutePath: string, maxBytes: number): Promise<string | null> {
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats?.isFile() || stats.size > maxBytes) return null;
  return fs.readFile(absolutePath, "utf8").catch(() => null);
}

function devScriptRank(name: string): number {
  const base = name.split(":")[0] as (typeof DEV_SCRIPT_NAMES)[number];
  const rank = DEV_SCRIPT_NAMES.indexOf(base);
  return (rank === -1 ? DEV_SCRIPT_NAMES.length : rank) * 2 + (name.includes(":") ? 1 : 0);
}

async function packageScriptConfigurations(
  projectRoot: string,
): Promise<ProjectLaunchConfiguration[]> {
  const { targets } = await discoverProjectScripts({ cwd: projectRoot });
  const configurations: ProjectLaunchConfiguration[] = [];
  for (const target of targets) {
    const text = await readTextFile(target.packageJsonPath, PACKAGE_JSON_MAX_BYTES);
    let bodies: Record<string, unknown> = {};
    try {
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (parsed.scripts && typeof parsed.scripts === "object") {
        bodies = parsed.scripts as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    const scripts = target.scripts
      .filter((script) => DEV_SCRIPT_NAME_PATTERN.test(script.name))
      .toSorted((left, right) => devScriptRank(left.name) - devScriptRank(right.name));
    for (const script of scripts) {
      const body = typeof bodies[script.name] === "string" ? (bodies[script.name] as string) : "";
      const port = inferDevScriptPort(body);
      const name = (
        target.relativePath ? `${target.relativePath} ${script.name}` : script.name
      ).slice(0, PROJECT_LAUNCH_NAME_MAX_LENGTH);
      configurations.push({
        name,
        command: script.command,
        cwd: target.cwd,
        port,
        url: port !== null ? localUrlForPort(port) : null,
      });
    }
  }
  // The project's own scripts first, then its packages', in the order found.
  return configurations
    .toSorted((left, right) => {
      const leftRoot = left.cwd === projectRoot ? 0 : 1;
      const rightRoot = right.cwd === projectRoot ? 0 : 1;
      return leftRoot - rightRoot;
    })
    .slice(0, MAX_PACKAGE_SCRIPT_CONFIGURATIONS);
}

export async function readProjectLaunchConfigurations(
  input: ProjectReadLaunchConfigurationsInput,
  platform: NodeJS.Platform = process.platform,
): Promise<ProjectReadLaunchConfigurationsResult> {
  const projectRoot = path.resolve(input.cwd);
  const configurations: ProjectLaunchConfiguration[] = [];
  const problems: string[] = [];
  let source: ProjectReadLaunchConfigurationsResult["source"] = "none";
  let editFile: string = PROJECT_MOSS_LAUNCH_FILE;
  let editFilePath: string | null = null;

  for (const [file, fileSource] of [
    [PROJECT_MOSS_LAUNCH_FILE, "moss"],
    [PROJECT_CLAUDE_LAUNCH_FILE, "claude"],
  ] as const) {
    const absolutePath = path.join(projectRoot, ...file.split("/"));
    const text = await readTextFile(absolutePath, LAUNCH_FILE_MAX_BYTES);
    if (text === null) continue;
    if (source === "none") {
      source = fileSource;
      editFile = file;
      editFilePath = absolutePath;
    }
    const parsed = parseLaunchFile({ text, projectRoot, fileLabel: file, platform });
    problems.push(...parsed.problems);
    for (const configuration of parsed.configurations) {
      if (configurations.some((existing) => existing.name === configuration.name)) continue;
      configurations.push(configuration);
    }
  }

  if (source === "none") {
    const fromScripts = await packageScriptConfigurations(projectRoot).catch(() => []);
    if (fromScripts.length > 0) {
      source = "packageScripts";
      configurations.push(...fromScripts);
    }
  }

  return { source, editFile, editFilePath, configurations, problems };
}
