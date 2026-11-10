// FILE: geminiSessions.ts
// Purpose: Read Gemini CLI chats from `~/.gemini/tmp/<project>/chats/session-*.json`.
// Layer: Provider local-history parsing
// Exports: geminiSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { NativeImportSession } from "../projectImportTypes";
import {
  absolutePath,
  asRecord,
  envDirectory,
  isoTimestamp,
  listDirectory,
  mapBounded,
  nonEmptyString,
  titleFromText,
  visibleMessageText,
} from "./shared";
import type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

const SESSION_FILE_PATTERN = /^session-.*\.json$/u;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const DISCOVERY_CONCURRENCY = 4;

interface GeminiSessionFile {
  readonly file: string;
  readonly projectDir: string;
}

function geminiHome(input: LocalHistoryPathInput): string {
  // Gemini CLI resolves its home from GEMINI_CLI_HOME before the account's home folder.
  return nodePath.join(
    envDirectory(input.env, "GEMINI_CLI_HOME", input.homeDir) ?? input.homeDir,
    ".gemini",
  );
}

async function sessionFiles(home: string): Promise<GeminiSessionFile[]> {
  const tmp = nodePath.join(home, "tmp");
  const files: GeminiSessionFile[] = [];
  for (const project of await listDirectory(tmp)) {
    if (!project.isDirectory()) continue;
    const projectDir = nodePath.join(tmp, project.name);
    for (const entry of await listDirectory(nodePath.join(projectDir, "chats"))) {
      if (entry.isFile() && SESSION_FILE_PATTERN.test(entry.name)) {
        files.push({ file: nodePath.join(projectDir, "chats", entry.name), projectDir });
      }
    }
  }
  return files;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    if ((await fs.stat(file)).size > MAX_SESSION_FILE_BYTES) return null;
    return asRecord(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Gemini names each project's temp folder after a hash or short id of the project root, so the
 * folder name alone does not say where the conversation ran. Newer releases leave the root in
 * `.project_root` or a `projects.json` registry; otherwise the conversation is filed under the
 * home folder.
 */
async function projectRoots(home: string): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const registry = await readJson(nodePath.join(home, "projects.json"));
  const entries = asRecord(registry?.projects) ?? registry ?? {};
  for (const [key, value] of Object.entries(entries)) {
    const id = nonEmptyString(value);
    if (id && absolutePath(key)) roots.set(id, key);
  }
  return roots;
}

async function projectRootFor(
  projectDir: string,
  registry: ReadonlyMap<string, string>,
  homeDir: string,
): Promise<string> {
  try {
    const marker = absolutePath(
      (await fs.readFile(nodePath.join(projectDir, ".project_root"), "utf8")).trim(),
    );
    if (marker) return marker;
  } catch {
    // Older releases do not write the marker.
  }
  return registry.get(nodePath.basename(projectDir)) ?? homeDir;
}

function roleOf(type: unknown): "user" | "assistant" | undefined {
  if (type === "user") return "user";
  if (type === "gemini" || type === "model" || type === "assistant") return "assistant";
  return undefined;
}

function messagesOf(session: Record<string, unknown>): LocalHistoryMessage[] {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return messages.flatMap((value, index) => {
    const message = asRecord(value);
    const role = roleOf(message?.type ?? message?.role);
    if (!message || !role) return [];
    const text = visibleMessageText(message.content ?? message.parts);
    if (!text) return [];
    return [
      {
        id: nonEmptyString(message.id) ?? String(index),
        role,
        text,
        createdAt: isoTimestamp(message.timestamp),
      },
    ];
  });
}

async function readSessionSummary(
  entry: GeminiSessionFile,
  registry: ReadonlyMap<string, string>,
  homeDir: string,
): Promise<NativeImportSession | undefined> {
  const session = await readJson(entry.file);
  const id = nonEmptyString(session?.sessionId);
  if (!session || !id) return undefined;
  const firstPrompt = messagesOf(session).find((message) => message.role === "user")?.text;
  if (!firstPrompt) return undefined;
  const updatedAt =
    isoTimestamp(session.lastUpdated) ??
    isoTimestamp(session.startTime) ??
    new Date((await fs.stat(entry.file)).mtimeMs).toISOString();
  const cwd = await projectRootFor(entry.projectDir, registry, homeDir);
  return {
    id,
    title: titleFromText(firstPrompt) ?? (nodePath.basename(cwd) || cwd),
    cwd,
    projectId: null,
    createdAt: isoTimestamp(session.startTime) ?? updatedAt,
    updatedAt,
    archived: false,
  };
}

export const geminiSessionReader: LocalHistoryReader = {
  sourceHome: geminiHome,
  discover: async (input) => {
    const home = geminiHome(input);
    const registry = await projectRoots(home);
    const sessions = await mapBounded(await sessionFiles(home), DISCOVERY_CONCURRENCY, (entry) =>
      readSessionSummary(entry, registry, input.homeDir),
    );
    // Gemini rewrites a session into a new file when it is resumed; keep the newest copy.
    const newest = new Map<string, NativeImportSession>();
    for (const session of sessions) {
      if (!session) continue;
      const previous = newest.get(session.id);
      if (!previous || previous.updatedAt < session.updatedAt) newest.set(session.id, session);
    }
    return { sourceHome: home, projects: [], sessions: [...newest.values()] };
  },
  readMessages: async (input) => {
    let newest: { updatedAt: string; messages: LocalHistoryMessage[] } | undefined;
    for (const entry of await sessionFiles(geminiHome(input))) {
      // File names carry the first 8 characters of the session id.
      if (!nodePath.basename(entry.file).includes(input.sessionId.slice(0, 8))) continue;
      const session = await readJson(entry.file);
      if (nonEmptyString(session?.sessionId) !== input.sessionId || !session) continue;
      const updatedAt = isoTimestamp(session.lastUpdated) ?? "";
      if (!newest || newest.updatedAt < updatedAt) {
        newest = { updatedAt, messages: messagesOf(session) };
      }
    }
    if (!newest) throw new Error("The conversation file is no longer on this computer.");
    return newest.messages;
  },
};
