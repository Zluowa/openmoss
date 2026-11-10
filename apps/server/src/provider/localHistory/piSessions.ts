// FILE: piSessions.ts
// Purpose: Read Pi-format JSONL sessions (`<agentDir>/sessions/<workspace>/<time>_<id>.jsonl`),
//          the store Pi and its fork Oh My Pi share. A session folder chosen with
//          `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in `<agentDir>/settings.json` holds the
//          files directly.
// Layer: Provider local-history parsing
// Exports: readPiSessionFile, findPiSessionFile, makePiSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { NativeImportSession } from "../projectImportTypes";
import { readJsonlRecords } from "./jsonlRecords";
import {
  absolutePath,
  asRecord,
  envDirectory,
  homeDirectory,
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
const DISCOVERY_CONCURRENCY = 8;

export interface PiSessionFile {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly createdAt?: string;
  readonly name?: string;
  readonly lastModel?: string;
  readonly lastThinkingLevel?: string;
  readonly messages: ReadonlyArray<LocalHistoryMessage>;
}

interface PiEntry {
  readonly id: string | undefined;
  readonly parentId: string | undefined;
  readonly message: LocalHistoryMessage | undefined;
}

function sessionIdFromFileName(name: string): string | undefined {
  if (!name.endsWith(".jsonl")) return undefined;
  const separator = name.lastIndexOf("_");
  const id = separator >= 0 ? name.slice(separator + 1, -".jsonl".length) : "";
  return SESSION_ID_PATTERN.test(id) ? id : undefined;
}

async function jsonlFilesIn(directory: string): Promise<string[]> {
  return (await listDirectory(directory)).flatMap((entry) =>
    entry.isFile() && entry.name.endsWith(".jsonl") ? [nodePath.join(directory, entry.name)] : [],
  );
}

async function sessionFiles(agentDir: string, customDir?: string): Promise<string[]> {
  const sessionsDir = nodePath.join(agentDir, "sessions");
  const files: string[] = [];
  for (const workspace of await listDirectory(sessionsDir)) {
    if (!workspace.isDirectory()) continue;
    files.push(...(await jsonlFilesIn(nodePath.join(sessionsDir, workspace.name))));
  }
  if (customDir && nodePath.resolve(customDir) !== nodePath.resolve(sessionsDir)) {
    // A chosen session folder holds the files directly.
    files.push(...(await jsonlFilesIn(customDir)));
  }
  return [...new Set(files)];
}

/**
 * The session folder Pi was told to use instead of `<agentDir>/sessions`: the environment
 * override first, then `sessionDir` in the agent's settings, as Pi itself resolves it.
 */
export async function piCustomSessionDir(
  input: LocalHistoryPathInput,
  agentDir: string,
  envKey?: string,
): Promise<string | undefined> {
  const fromEnv = envKey ? envDirectory(input.env, envKey, input.homeDir) : undefined;
  if (fromEnv) return fromEnv;
  try {
    const settings = asRecord(
      JSON.parse(await fs.readFile(nodePath.join(agentDir, "settings.json"), "utf8")),
    );
    return homeDirectory(settings?.sessionDir, input.homeDir);
  } catch {
    return undefined;
  }
}

export async function findPiSessionFile(
  agentDir: string,
  sessionId: string,
  customDir?: string,
): Promise<string | undefined> {
  const id = sessionId.trim();
  if (!SESSION_ID_PATTERN.test(id)) return undefined;
  // Session files are named `<iso-timestamp>_<sessionId>.jsonl`.
  return (await sessionFiles(agentDir, customDir)).find((file) =>
    nodePath.basename(file).endsWith(`_${id}.jsonl`),
  );
}

/** Oh My Pi records a full slug; Pi records the provider and model id separately. */
function modelSlug(record: Record<string, unknown>): string | undefined {
  const provider = nonEmptyString(record.provider);
  const modelId = nonEmptyString(record.modelId);
  return (
    nonEmptyString(record.model) ?? (provider && modelId ? `${provider}/${modelId}` : undefined)
  );
}

function messageFrom(
  record: Record<string, unknown>,
  index: number,
): LocalHistoryMessage | undefined {
  const message = asRecord(record.message);
  if (message?.role !== "user" && message?.role !== "assistant") return undefined;
  const text = visibleMessageText(message.content);
  if (!text) return undefined;
  return {
    id: nonEmptyString(record.id) ?? String(index),
    role: message.role,
    text,
    createdAt: isoTimestamp(record.timestamp) ?? isoTimestamp(message.timestamp),
  };
}

/**
 * Pi sessions are trees: rewinding or branching appends entries whose parent is an earlier
 * entry. The conversation a person last saw is the path from the newest entry to the root.
 * Files without parent links (older format) are read in file order.
 */
function visiblePath(entries: ReadonlyArray<PiEntry>): ReadonlyArray<LocalHistoryMessage> {
  const linear = entries.flatMap((entry) => (entry.message ? [entry.message] : []));
  const leaf = entries.at(-1);
  const linked = entries.some((entry) => entry.parentId);
  if (!leaf?.id || !linked || entries.some((entry) => !entry.id)) return linear;
  const byId = new Map(entries.map((entry) => [entry.id!, entry] as const));
  const path: LocalHistoryMessage[] = [];
  const seen = new Set<string>();
  let current: PiEntry | undefined = leaf;
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.message) path.push(current.message);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.toReversed();
}

export async function readPiSessionFile(file: string): Promise<PiSessionFile | undefined> {
  const fileId = sessionIdFromFileName(nodePath.basename(file));
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let name: string | undefined;
  let lastModel: string | undefined;
  let lastThinkingLevel: string | undefined;
  const entries: PiEntry[] = [];
  for await (const record of readJsonlRecords(file)) {
    switch (record.type) {
      case "session":
        sessionId ??= nonEmptyString(record.id);
        cwd ??= absolutePath(record.cwd);
        createdAt ??= isoTimestamp(record.timestamp);
        continue;
      case "session_info":
        name = nonEmptyString(record.name) ?? name;
        break;
      case "model_change":
        lastModel = nonEmptyString(record.model) ?? lastModel;
        break;
      case "thinking_level_change":
        lastThinkingLevel = nonEmptyString(record.thinkingLevel) ?? lastThinkingLevel;
        break;
    }
    entries.push({
      id: nonEmptyString(record.id),
      parentId: nonEmptyString(record.parentId),
      message: record.type === "message" ? messageFrom(record, entries.length) : undefined,
    });
  }
  const id = sessionId ?? fileId;
  if (!id) return undefined;
  return {
    sessionId: id,
    ...(cwd ? { cwd } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(name ? { name } : {}),
    ...(lastModel ? { lastModel } : {}),
    ...(lastThinkingLevel ? { lastThinkingLevel } : {}),
    messages: visiblePath(entries),
  };
}

/** Header, name, and first prompt only, so discovery never reads whole transcripts. */
async function readPiSessionSummary(file: string): Promise<NativeImportSession | undefined> {
  let id = sessionIdFromFileName(nodePath.basename(file));
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let name: string | undefined;
  let model: string | undefined;
  let firstPrompt: string | undefined;
  for await (const record of readJsonlRecords(file)) {
    if (record.type === "session") {
      id = nonEmptyString(record.id) ?? id;
      cwd = absolutePath(record.cwd);
      createdAt = isoTimestamp(record.timestamp);
    } else if (record.type === "session_info") {
      name = nonEmptyString(record.name) ?? name;
    } else if (record.type === "model_change") {
      model = modelSlug(record) ?? model;
    } else if (record.type === "message") {
      const message = messageFrom(record, 0);
      if (message?.role === "user") {
        firstPrompt = message.text;
        break;
      }
    }
  }
  // A session with no prompt yet has nothing to import.
  if (!id || !cwd || !firstPrompt) return undefined;
  const updatedAt = (await modifiedAt(file)) ?? createdAt;
  if (!updatedAt) return undefined;
  return {
    id,
    title: name ?? titleFromText(firstPrompt) ?? nodePath.basename(cwd),
    cwd,
    projectId: null,
    createdAt: createdAt ?? updatedAt,
    updatedAt,
    archived: false,
    ...(model ? { model } : {}),
  };
}

export function makePiSessionReader(
  agentDir: (input: LocalHistoryPathInput) => string,
  /** The environment variable that moves the session folder, when the agent has one. */
  sessionDirEnv?: string,
): LocalHistoryReader {
  const customDir = (input: LocalHistoryPathInput) =>
    piCustomSessionDir(input, agentDir(input), sessionDirEnv);
  return {
    sourceHome: agentDir,
    discover: async (input) => {
      const files = await sessionFiles(agentDir(input), await customDir(input));
      const sessions = await mapBounded(files, DISCOVERY_CONCURRENCY, readPiSessionSummary);
      return {
        sourceHome: agentDir(input),
        projects: [],
        sessions: sessions.filter((session) => session !== undefined),
      };
    },
    readMessages: async (input) => {
      const file = await findPiSessionFile(
        agentDir(input),
        input.sessionId,
        await customDir(input),
      );
      if (!file) throw new Error("The conversation file is no longer on this computer.");
      return (await readPiSessionFile(file))?.messages ?? [];
    },
  };
}
