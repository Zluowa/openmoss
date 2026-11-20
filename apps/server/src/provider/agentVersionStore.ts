// FILE: agentVersionStore.ts
// Purpose: In-app updates of Codex and Claude Code that work while the agent is in use. Each
//          update installs into its own folder beside the running copy, one pointer names the
//          copy new launches use, and folders no running process uses any more are removed
//          later. Running programs are never overwritten or deleted, so Windows' lock on a
//          running .exe cannot fail an update.
// Layer: Provider maintenance (server).
//
// The layout follows T3 Code's managed Codex runtime (`tools/codex/<version>` plus
// `active.json`, pruned when no session leases a release) and Codex's own desktop daemon,
// which keeps `releases/<version>` side by side:
//
//   <Moss home>/agents/versions/<codex|claude>/<version>-<id>/   one npm `--prefix` per update
//   <Moss home>/agents/versions/<codex|claude>/active.json       the copy new launches use
//   <Moss home>/agents/versions/<codex|claude>/.trash-<id>/      a folder on its way out

import { randomBytes } from "node:crypto";
import * as FS from "node:fs/promises";
import * as NodePath from "node:path";

import { MOSS_UPDATED_CODEX_PATH_ENV_KEY } from "@moss/shared/codexRuntime";
import { Effect } from "effect";

import type { AgentProgramOwnership } from "./agentProgramOwnership.ts";
import { MOSS_UPDATED_CLAUDE_PATH_ENV_KEY } from "./claudeEnvironment.ts";
import { managedAgentInstallPrefix } from "./managedAgentPaths.ts";
import type { AgentInstallOutcome } from "./providerInstall.ts";

export type VersionedAgent = "codex" | "claudeAgent";

const AGENT_FOLDERS: Record<VersionedAgent, string> = { codex: "codex", claudeAgent: "claude" };
export const AGENT_UPDATED_PATH_ENV_KEYS: Record<VersionedAgent, string> = {
  codex: MOSS_UPDATED_CODEX_PATH_ENV_KEY,
  claudeAgent: MOSS_UPDATED_CLAUDE_PATH_ENV_KEY,
};
const ACTIVE_FILE = "active.json";
const TRASH_PREFIX = ".trash-";
const MAX_ACTIVE_FILE_BYTES = 8_192;

/** Folders an update in this process is still filling; pruning leaves them alone. */
const installingDirectories = new Set<string>();

/** Windows cannot replace a running program, so every managed update there installs side by side. */
export function updatesInstallSideBySide(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function agentVersionsRoot(mossHomeDir: string, agent: VersionedAgent): string {
  return NodePath.join(managedAgentInstallPrefix(mossHomeDir), "versions", AGENT_FOLDERS[agent]);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

/** A fresh folder for one update; a name never repeats, so it can never be a running copy. */
export async function createAgentVersionDirectory(
  mossHomeDir: string,
  agent: VersionedAgent,
  version: string | null,
): Promise<string> {
  const root = agentVersionsRoot(mossHomeDir, agent);
  await FS.mkdir(root, { recursive: true });
  const label = (version ?? "latest").replace(/[^0-9A-Za-z.+-]/gu, "_").slice(0, 64) || "latest";
  const directory = NodePath.join(root, `${label}-${uniqueSuffix()}`);
  await FS.mkdir(directory);
  installingDirectories.add(directory);
  return directory;
}

export interface ActiveAgentVersion {
  readonly version: string;
  readonly directory: string;
  readonly executable: string;
}

export async function readActiveAgentVersion(
  mossHomeDir: string,
  agent: VersionedAgent,
): Promise<ActiveAgentVersion | null> {
  const root = agentVersionsRoot(mossHomeDir, agent);
  try {
    const file = NodePath.join(root, ACTIVE_FILE);
    const info = await FS.stat(file);
    if (!info.isFile() || info.size > MAX_ACTIVE_FILE_BYTES) return null;
    const record = JSON.parse(await FS.readFile(file, "utf8")) as Record<string, unknown>;
    if (
      typeof record.version !== "string" ||
      typeof record.directory !== "string" ||
      typeof record.executable !== "string"
    ) {
      return null;
    }
    const directory = NodePath.resolve(root, record.directory);
    const executable = NodePath.resolve(directory, record.executable);
    if (NodePath.dirname(directory) !== NodePath.resolve(root)) return null;
    if (!isInside(directory, executable)) return null;
    if (!(await FS.stat(executable)).isFile()) return null;
    return { version: record.version, directory, executable };
  } catch {
    return null;
  }
}

/**
 * Makes `executable` (inside `directory`) the copy every new launch resolves: the pointer is
 * replaced in one rename, then this server's environment names it.
 */
export async function activateAgentVersion(input: {
  readonly mossHomeDir: string;
  readonly agent: VersionedAgent;
  readonly directory: string;
  readonly version: string;
  readonly executable: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const root = agentVersionsRoot(input.mossHomeDir, input.agent);
  const record = {
    version: input.version,
    directory: NodePath.basename(input.directory),
    executable: NodePath.relative(input.directory, input.executable),
  };
  const temporary = NodePath.join(root, `.active-${uniqueSuffix()}.json`);
  await FS.writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx" });
  try {
    await FS.rename(temporary, NodePath.join(root, ACTIVE_FILE));
  } catch (cause) {
    await FS.rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
  installingDirectories.delete(input.directory);
  (input.env ?? process.env)[AGENT_UPDATED_PATH_ENV_KEYS[input.agent]] = input.executable;
}

/** Drops a folder an update created but never activated. Nothing can be running from it. */
export async function abandonAgentVersionDirectory(directory: string): Promise<void> {
  installingDirectories.delete(directory);
  await FS.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/** At server start: point new launches at the copies earlier updates activated. */
export async function restoreActiveAgentVersions(
  mossHomeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const agent of Object.keys(AGENT_FOLDERS) as VersionedAgent[]) {
    const active = await readActiveAgentVersion(mossHomeDir, agent);
    if (active) env[AGENT_UPDATED_PATH_ENV_KEYS[agent]] = active.executable;
    else delete env[AGENT_UPDATED_PATH_ENV_KEYS[agent]];
  }
}

/**
 * Removes update folders that are neither active nor in use. A folder is first renamed: on
 * Windows that fails while any program inside it runs, including processes this server does
 * not track, so a running copy is never deleted.
 */
export async function pruneAgentVersions(input: {
  readonly mossHomeDir: string;
  readonly agent: VersionedAgent;
  readonly isInUse: (directory: string) => boolean;
}): Promise<ReadonlyArray<string>> {
  const root = agentVersionsRoot(input.mossHomeDir, input.agent);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await FS.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const active = await readActiveAgentVersion(input.mossHomeDir, input.agent);
  const removed: string[] = [];
  for (const entry of entries) {
    const directory = NodePath.join(root, entry.name);
    // A link is never followed or removed; only real folders this store created.
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let trash: string;
    if (entry.name.startsWith(TRASH_PREFIX)) {
      trash = directory;
    } else {
      if (
        entry.name.startsWith(".") ||
        directory === active?.directory ||
        installingDirectories.has(directory) ||
        input.isInUse(directory)
      ) {
        continue;
      }
      trash = NodePath.join(root, `${TRASH_PREFIX}${uniqueSuffix()}`);
      try {
        await FS.rename(directory, trash);
      } catch {
        continue;
      }
      removed.push(directory);
    }
    await FS.rm(trash, { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}

export type SideBySideUpdateOutcome =
  | { readonly ok: true; readonly version: string; readonly executable: string }
  | Extract<AgentInstallOutcome, { readonly ok: false }>;

/**
 * Installs the update beside the running copy, switches new launches to it and tells the
 * runtime managers, which move each session over once its turn has finished.
 */
export const installAgentVersionSideBySide = Effect.fn("installAgentVersionSideBySide")(
  function* (input: {
    readonly mossHomeDir: string;
    readonly agent: VersionedAgent;
    readonly targetVersion: string | null;
    readonly programs: AgentProgramOwnership;
    readonly install: (prefix: string) => Effect.Effect<AgentInstallOutcome, unknown>;
    readonly env?: NodeJS.ProcessEnv;
  }) {
    const directory = yield* Effect.tryPromise(() =>
      createAgentVersionDirectory(input.mossHomeDir, input.agent, input.targetVersion),
    ).pipe(Effect.result);
    if (directory._tag === "Failure") {
      return {
        ok: false,
        reason: "download-failed",
        detail: `Could not create the update folder: ${String(directory.failure)}`,
      } satisfies SideBySideUpdateOutcome as SideBySideUpdateOutcome;
    }
    const prefix = directory.success;
    const installed = yield* input.install(prefix).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false,
          reason: "download-failed",
          detail: String(cause),
        } satisfies AgentInstallOutcome as AgentInstallOutcome),
      ),
      Effect.onInterrupt(() => Effect.promise(() => abandonAgentVersionDirectory(prefix))),
    );
    if (!installed.ok || !installed.executable || !isInside(prefix, installed.executable)) {
      yield* Effect.promise(() => abandonAgentVersionDirectory(prefix));
      return installed.ok
        ? ({
            ok: false,
            reason: "verify-failed",
            detail: "The installed command is not inside the update folder.",
          } satisfies SideBySideUpdateOutcome as SideBySideUpdateOutcome)
        : installed;
    }
    const executable = installed.executable;
    const activated = yield* Effect.tryPromise(() =>
      activateAgentVersion({
        mossHomeDir: input.mossHomeDir,
        agent: input.agent,
        directory: prefix,
        version: installed.version,
        executable,
        ...(input.env ? { env: input.env } : {}),
      }),
    ).pipe(Effect.result);
    if (activated._tag === "Failure") {
      yield* Effect.promise(() => abandonAgentVersionDirectory(prefix));
      return {
        ok: false,
        reason: "download-failed",
        detail: `Could not switch to the new version: ${String(activated.failure)}`,
      } satisfies SideBySideUpdateOutcome as SideBySideUpdateOutcome;
    }
    input.programs.approveProgramSwitch(executable);
    // Older copies go once nothing runs from them; the ones still in use stay for a later pass.
    yield* Effect.promise(() =>
      pruneAgentVersions({
        mossHomeDir: input.mossHomeDir,
        agent: input.agent,
        isInUse: (candidate) => input.programs.isDirectoryInUse(candidate),
      }),
    );
    return {
      ok: true,
      version: installed.version,
      executable,
    } satisfies SideBySideUpdateOutcome as SideBySideUpdateOutcome;
  },
);

/** What the update dialog says once an agent was updated while it may still be running. */
export const AGENT_UPDATED_LIVE_MESSAGE =
  "Updated. Conversations in progress switch to the new version after their current turn.";

/** One sentence per reason an update can still fail; each ends in what to do next. */
export function sideBySideUpdateFailureMessage(
  outcome: Extract<AgentInstallOutcome, { readonly ok: false }>,
): string {
  if (/\bENOSPC\b|no space left|not enough space|disk (?:is )?full/iu.test(outcome.detail)) {
    return "There is not enough disk space for the update. Free some space, then try again.";
  }
  switch (outcome.reason) {
    case "npm-unavailable":
      return "Moss could not find npm to download the update. Install Node.js, then try again.";
    case "timed-out":
      return "The update download took too long. Check your network, then try again.";
    case "verify-failed":
      return "The downloaded version did not start. Try again.";
    default:
      return "Moss could not download the update. Check your network, then try again.";
  }
}
