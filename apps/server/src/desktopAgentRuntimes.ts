// FILE: desktopAgentRuntimes.ts
// Purpose: Applies the desktop's "this agent runtime is ready" notice to the running server.
// Layer: Server bootstrap glue (desktop → server)
//
// A `download` build fetches Moss's Codex and Claude Code after install. The server picks the
// program through the same environment keys a bundled build sets at start (MOSS_BUNDLED_*_PATH,
// read on every launch), so a runtime that finishes downloading later is put there, and its
// name leaves MOSS_AGENT_RUNTIMES_PENDING. No restart, and the resolvers stay as they are.

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  type AgentRuntimeName,
  MOSS_AGENT_RUNTIMES_PENDING_ENV_KEY,
  MOSS_BUNDLED_CODEX_ERROR_ENV_KEY,
  MOSS_BUNDLED_CODEX_PATH_ENV_KEY,
  pendingAgentRuntimes,
} from "@moss/shared/codexRuntime";

import { MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY } from "./provider/claudeEnvironment";

const PATH_KEYS: Readonly<Record<AgentRuntimeName, string>> = {
  codex: MOSS_BUNDLED_CODEX_PATH_ENV_KEY,
  claude: MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY,
};

export interface DesktopAgentRuntimeReady {
  readonly name: AgentRuntimeName;
  readonly executablePath: string;
}

/** Accepts only `{ ready: [{ name: "codex" | "claude", executablePath: <absolute path> }] }`. */
export function parseDesktopAgentRuntimesNotice(
  body: unknown,
): ReadonlyArray<DesktopAgentRuntimeReady> | null {
  if (typeof body !== "object" || body === null) return null;
  const ready = (body as { ready?: unknown }).ready;
  if (!Array.isArray(ready) || ready.length === 0 || ready.length > 2) return null;
  const parsed: DesktopAgentRuntimeReady[] = [];
  for (const entry of ready) {
    if (typeof entry !== "object" || entry === null) return null;
    const { name, executablePath } = entry as { name?: unknown; executablePath?: unknown };
    if (name !== "codex" && name !== "claude") return null;
    if (typeof executablePath !== "string" || !isAbsolute(executablePath)) return null;
    if (executablePath.length > 4096 || executablePath.includes("\u0000")) return null;
    if (executablePath.includes("\n") || executablePath.includes("\r")) return null;
    if (parsed.some((existing) => existing.name === name)) return null;
    parsed.push({ name, executablePath });
  }
  return parsed;
}

/**
 * Points the server at each ready runtime and clears it from the pending list. A path that is
 * not a file is refused (nothing changes for that runtime). Returns the names applied.
 */
export async function applyDesktopAgentRuntimesNotice(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly ready: ReadonlyArray<DesktopAgentRuntimeReady>;
  readonly isFile?: (path: string) => Promise<boolean>;
}): Promise<ReadonlyArray<AgentRuntimeName>> {
  const isFile =
    input.isFile ??
    ((path: string) =>
      stat(path).then(
        (value) => value.isFile(),
        () => false,
      ));
  const applied: AgentRuntimeName[] = [];
  for (const runtime of input.ready) {
    if (!(await isFile(runtime.executablePath))) continue;
    input.env[PATH_KEYS[runtime.name]] = runtime.executablePath;
    if (runtime.name === "codex") delete input.env[MOSS_BUNDLED_CODEX_ERROR_ENV_KEY];
    applied.push(runtime.name);
  }
  const pending = [...pendingAgentRuntimes(input.env)].filter(
    (name) => !applied.includes(name as AgentRuntimeName),
  );
  if (pending.length > 0) input.env[MOSS_AGENT_RUNTIMES_PENDING_ENV_KEY] = pending.join(",");
  else delete input.env[MOSS_AGENT_RUNTIMES_PENDING_ENV_KEY];
  return applied;
}
