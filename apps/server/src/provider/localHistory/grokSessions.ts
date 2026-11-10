// FILE: grokSessions.ts
// Purpose: Read Grok CLI sessions from `<GROK_HOME|~/.grok>/sessions/<encoded cwd>/<id>/`
//          (summary.json for metadata, chat_history.jsonl for the conversation).
// Layer: Provider local-history parsing
// Exports: grokSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { NativeImportSession } from "../projectImportTypes";
import { readJsonlRecords } from "./jsonlRecords";
import {
  absolutePath,
  asRecord,
  envDirectory,
  isoTimestamp,
  listDirectory,
  mapBounded,
  modifiedAt,
  nonEmptyString,
  titleFromText,
  visibleMessageText,
} from "./shared";
import type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_SUMMARY_BYTES = 1024 * 1024;
const DISCOVERY_CONCURRENCY = 8;

function grokHome(input: LocalHistoryPathInput): string {
  return (
    envDirectory(input.env, "GROK_HOME", input.homeDir) ?? nodePath.join(input.homeDir, ".grok")
  );
}

function decodeWorkspaceDirectory(name: string): string | undefined {
  try {
    return absolutePath(decodeURIComponent(name));
  } catch {
    return undefined;
  }
}

async function sessionDirectories(home: string): Promise<string[]> {
  const sessionsDir = nodePath.join(home, "sessions");
  const directories: string[] = [];
  for (const workspace of await listDirectory(sessionsDir)) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = nodePath.join(sessionsDir, workspace.name);
    for (const session of await listDirectory(workspaceDir)) {
      if (session.isDirectory() && SESSION_ID_PATTERN.test(session.name)) {
        directories.push(nodePath.join(workspaceDir, session.name));
      }
    }
  }
  return directories;
}

async function readSummary(directory: string): Promise<Record<string, unknown> | null> {
  try {
    const file = nodePath.join(directory, "summary.json");
    if ((await fs.stat(file)).size > MAX_SUMMARY_BYTES) return null;
    return asRecord(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

function messageFrom(
  record: Record<string, unknown>,
  index: number,
): LocalHistoryMessage | undefined {
  if (record.type !== "user" && record.type !== "assistant") return undefined;
  const text = visibleMessageText(record.content);
  return text
    ? { id: nonEmptyString(record.id) ?? String(index), role: record.type, text }
    : undefined;
}

async function firstPrompt(directory: string): Promise<string | undefined> {
  for await (const record of readJsonlRecords(nodePath.join(directory, "chat_history.jsonl"))) {
    const message = messageFrom(record, 0);
    if (message?.role === "user") return message.text;
  }
  return undefined;
}

async function readSessionSummary(directory: string): Promise<NativeImportSession | undefined> {
  const prompt = await firstPrompt(directory);
  // Sessions that never received a prompt have nothing to import.
  if (!prompt) return undefined;
  const summary = await readSummary(directory);
  const info = asRecord(summary?.info);
  const cwd =
    absolutePath(info?.cwd) ??
    decodeWorkspaceDirectory(nodePath.basename(nodePath.dirname(directory)));
  if (!cwd) return undefined;
  const fileDate = await modifiedAt(nodePath.join(directory, "chat_history.jsonl"));
  const updatedAt =
    isoTimestamp(summary?.last_active_at) ?? isoTimestamp(summary?.updated_at) ?? fileDate;
  if (!updatedAt) return undefined;
  return {
    id: nodePath.basename(directory),
    title:
      titleFromText(nonEmptyString(summary?.session_summary)) ??
      titleFromText(prompt) ??
      nodePath.basename(cwd),
    cwd,
    projectId: null,
    createdAt: isoTimestamp(summary?.created_at) ?? updatedAt,
    updatedAt,
    archived: false,
  };
}

export const grokSessionReader: LocalHistoryReader = {
  sourceHome: grokHome,
  discover: async (input) => {
    const directories = await sessionDirectories(grokHome(input));
    const sessions = await mapBounded(directories, DISCOVERY_CONCURRENCY, readSessionSummary);
    return {
      sourceHome: grokHome(input),
      projects: [],
      sessions: sessions.filter((session) => session !== undefined),
    };
  },
  readMessages: async (input) => {
    const id = input.sessionId.trim();
    const directory = SESSION_ID_PATTERN.test(id)
      ? (await sessionDirectories(grokHome(input))).find((entry) => nodePath.basename(entry) === id)
      : undefined;
    if (!directory) throw new Error("The conversation file is no longer on this computer.");
    const messages: LocalHistoryMessage[] = [];
    for await (const record of readJsonlRecords(nodePath.join(directory, "chat_history.jsonl"))) {
      const message = messageFrom(record, messages.length);
      if (message) messages.push(message);
    }
    return messages;
  },
};
