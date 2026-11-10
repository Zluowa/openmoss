// FILE: cursorSessions.ts
// Purpose: Read Cursor conversations from both places Cursor keeps them:
//          - the Cursor CLI (cursor-agent): `~/.cursor/chats/<md5 of folder>/<id>/store.db`
//            (`meta` row "0" describes the chat, `blobs` hold JSON messages in insertion order);
//          - the Cursor app: `<Cursor user data>/User/globalStorage/state.vscdb`, table
//            `cursorDiskKV` (`composerData:<id>` lists the bubbles, `bubbleId:<id>:<bubble>`
//            holds each one). Only those keys are read; the app's sign-in data is never touched.
// Layer: Provider local-history parsing
// Exports: cursorSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { resolveApplicationDirectory } from "@moss/shared/platformEnvironment";
import { fileURLToPath } from "node:url";

import { openReadonlySqlite, sqliteTableNames } from "../../readonlySqlite";
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

const CLI_PREFIX = "cli:";
const APP_PREFIX = "app:";
const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DISCOVERY_CONCURRENCY = 4;

function cursorHome(input: LocalHistoryPathInput): string {
  return nodePath.join(input.homeDir, ".cursor");
}

function cursorAppGlobalStorage(input: LocalHistoryPathInput): string {
  const userData = resolveApplicationDirectory({
    platform: process.platform,
    homeDir: input.homeDir,
    kind: "desktop-config",
    name: "Cursor",
    roamingAppData: envDirectory(input.env, "APPDATA", input.homeDir),
    xdgHome: envDirectory(input.env, "XDG_CONFIG_HOME", input.homeDir),
  });
  return nodePath.join(userData, "User", "globalStorage");
}

function decodeText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  const text = decodeText(value)?.trim();
  if (!text) return null;
  // The CLI writes its meta record as hex-encoded JSON in some versions.
  const json = /^[0-9a-f]+$/iu.test(text) ? Buffer.from(text, "hex").toString("utf8") : text;
  if (!json.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

// ── Cursor CLI ───────────────────────────────────────────────────────────────

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/u;
const WORKSPACE_PATH = /Workspace Path:\s*(.+)/u;

interface CliChat {
  readonly session: NativeImportSession;
  readonly messages?: ReadonlyArray<LocalHistoryMessage>;
}

/** Message blobs are JSON; protobuf blobs that link turns together are skipped. */
function readCliMessages(rows: ReadonlyArray<Record<string, unknown>>): {
  messages: LocalHistoryMessage[];
  workspacePath?: string;
} {
  const messages: LocalHistoryMessage[] = [];
  let workspacePath: string | undefined;
  for (const row of rows) {
    const blob = parseJson(row.data);
    if (blob?.role !== "user" && blob?.role !== "assistant") continue;
    const raw = visibleMessageText(blob.content);
    if (!raw) continue;
    if (blob.role === "user" && raw.includes("<user_info>")) {
      // Context Cursor injects before the first prompt; it names the folder.
      workspacePath ??= absolutePath(WORKSPACE_PATH.exec(raw)?.[1]?.trim());
      if (!USER_QUERY.test(raw)) continue;
    }
    const text = blob.role === "user" ? (USER_QUERY.exec(raw)?.[1]?.trim() ?? raw) : raw;
    if (!text) continue;
    messages.push({
      id: nonEmptyString(row.id) ?? String(messages.length),
      role: blob.role,
      text,
      createdAt: isoTimestamp(blob.createdAt),
    });
  }
  return { messages, ...(workspacePath ? { workspacePath } : {}) };
}

async function readCliChat(
  directory: string,
  homeDir: string,
  withMessages: boolean,
): Promise<CliChat | undefined> {
  const id = nodePath.basename(directory);
  const file = nodePath.join(directory, "store.db");
  try {
    await fs.access(file);
  } catch {
    return undefined;
  }
  const meta = await readJsonFile(nodePath.join(directory, "meta.json"));
  if (meta?.hasConversation === false) return undefined;
  const database = await openReadonlySqlite(file);
  try {
    const tables = sqliteTableNames(database);
    if (!tables.has("blobs")) return undefined;
    const agent = tables.has("meta")
      ? parseJson(database.all("SELECT value FROM meta WHERE key = '0'")[0]?.value)
      : null;
    const { messages, workspacePath } = readCliMessages(
      database.all("SELECT id, data FROM blobs ORDER BY rowid"),
    );
    const firstPrompt = messages.find((message) => message.role === "user")?.text;
    if (!firstPrompt) return undefined;
    const cwd = absolutePath(agent?.workspacePath) ?? workspacePath ?? homeDir;
    const lastDate = messages.findLast((message) => message.createdAt)?.createdAt;
    const updatedAt =
      isoTimestamp(meta?.updatedAtMs) ??
      lastDate ??
      new Date((await fs.stat(file)).mtimeMs).toISOString();
    return {
      session: {
        id: `${CLI_PREFIX}${id}`,
        title:
          titleFromText(nonEmptyString(meta?.title) ?? nonEmptyString(agent?.name)) ??
          titleFromText(firstPrompt) ??
          (nodePath.basename(cwd) || cwd),
        cwd,
        projectId: null,
        createdAt:
          isoTimestamp(meta?.createdAtMs) ??
          isoTimestamp(agent?.createdAt) ??
          messages[0]?.createdAt ??
          updatedAt,
        updatedAt,
        archived: false,
      },
      ...(withMessages ? { messages } : {}),
    };
  } finally {
    database.close();
  }
}

async function cliChatDirectories(input: LocalHistoryPathInput): Promise<string[]> {
  const chats = nodePath.join(cursorHome(input), "chats");
  const directories: string[] = [];
  for (const workspace of await listDirectory(chats)) {
    if (!workspace.isDirectory()) continue;
    for (const chat of await listDirectory(nodePath.join(chats, workspace.name))) {
      if (chat.isDirectory() && ID_PATTERN.test(chat.name)) {
        directories.push(nodePath.join(chats, workspace.name, chat.name));
      }
    }
  }
  return directories;
}

// ── Cursor app ───────────────────────────────────────────────────────────────

interface AppStore {
  readonly composers: ReadonlyArray<Record<string, unknown>>;
  readonly headers: ReadonlyMap<string, Record<string, unknown>>;
  readonly bubble: (composerId: string, bubbleId: string) => Record<string, unknown> | null;
}

async function withAppStore<T>(
  input: LocalHistoryPathInput,
  read: (store: AppStore) => Promise<T> | T,
  empty: T,
): Promise<T> {
  const file = nodePath.join(cursorAppGlobalStorage(input), "state.vscdb");
  try {
    await fs.access(file);
  } catch {
    return empty;
  }
  const database = await openReadonlySqlite(file);
  try {
    const tables = sqliteTableNames(database);
    if (!tables.has("cursorDiskKV")) return empty;
    const composers = database
      .all("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .flatMap((row) => {
        const composer = parseJson(row.value);
        return composer ? [composer] : [];
      });
    const headers = new Map<string, Record<string, unknown>>();
    if (tables.has("composerHeaders")) {
      for (const row of database.all(
        "SELECT composerId, workspaceId, isArchived, value FROM composerHeaders",
      )) {
        const id = nonEmptyString(row.composerId);
        if (id) headers.set(id, { ...row, value: parseJson(row.value) });
      }
    }
    return await read({
      composers,
      headers,
      bubble: (composerId, bubbleId) =>
        parseJson(
          database.all(
            "SELECT value FROM cursorDiskKV WHERE key = ?",
            `bubbleId:${composerId}:${bubbleId}`,
          )[0]?.value,
        ),
    });
  } finally {
    database.close();
  }
}

function folderFromUri(value: unknown): string | undefined {
  const record = asRecord(value);
  const direct = absolutePath(record?.fsPath) ?? absolutePath(record?.path);
  if (direct) return direct;
  const uri = nonEmptyString(record?.external) ?? nonEmptyString(value);
  if (!uri?.startsWith("file:")) return undefined;
  try {
    return absolutePath(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

async function appWorkspaceFolder(
  input: LocalHistoryPathInput,
  header: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const identifier = asRecord(asRecord(header?.value)?.workspaceIdentifier);
  const fromHeader = folderFromUri(identifier?.uri) ?? folderFromUri(identifier?.configPath);
  if (fromHeader) return fromHeader;
  const workspaceId = nonEmptyString(header?.workspaceId);
  if (!workspaceId || !ID_PATTERN.test(workspaceId)) return undefined;
  const workspace = await readJsonFile(
    nodePath.join(
      nodePath.dirname(cursorAppGlobalStorage(input)),
      "workspaceStorage",
      workspaceId,
      "workspace.json",
    ),
  );
  return folderFromUri(workspace?.folder);
}

function appMessages(store: AppStore, composer: Record<string, unknown>): LocalHistoryMessage[] {
  const composerId = nonEmptyString(composer.composerId) ?? "";
  // Older app versions kept the bubbles inline in `conversation`.
  const inline = Array.isArray(composer.conversation) ? composer.conversation : [];
  const headers = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly
    : [];
  const bubbles =
    headers.length > 0
      ? headers.flatMap((header) => {
          const bubbleId = nonEmptyString(asRecord(header)?.bubbleId);
          const bubble = bubbleId ? store.bubble(composerId, bubbleId) : null;
          return bubble ? [bubble] : [];
        })
      : inline.flatMap((value) => {
          const bubble = asRecord(value);
          return bubble ? [bubble] : [];
        });
  return bubbles.flatMap((bubble, index) => {
    // Bubble type 1 is the person, 2 is Cursor.
    const role = bubble.type === 1 ? "user" : bubble.type === 2 ? "assistant" : null;
    const text = visibleMessageText(bubble.text);
    if (!role || !text) return [];
    return [
      {
        id: nonEmptyString(bubble.bubbleId) ?? String(index),
        role,
        text,
        createdAt:
          isoTimestamp(bubble.createdAt) ??
          isoTimestamp(asRecord(bubble.timingInfo)?.clientStartTime),
      },
    ];
  });
}

async function discoverAppChats(input: LocalHistoryPathInput): Promise<NativeImportSession[]> {
  return withAppStore(
    input,
    async (store) => {
      const sessions: NativeImportSession[] = [];
      for (const composer of store.composers) {
        const id = nonEmptyString(composer.composerId);
        if (!id || !ID_PATTERN.test(id)) continue;
        const header = store.headers.get(id);
        if (header?.value && asRecord(header.value)?.isSubagent === true) continue;
        const messages = appMessages(store, composer);
        const firstPrompt = messages.find((message) => message.role === "user")?.text;
        if (!firstPrompt) continue;
        const cwd = (await appWorkspaceFolder(input, header)) ?? input.homeDir;
        const updatedAt =
          isoTimestamp(composer.lastUpdatedAt) ??
          messages.findLast((message) => message.createdAt)?.createdAt ??
          isoTimestamp(composer.createdAt);
        if (!updatedAt) continue;
        sessions.push({
          id: `${APP_PREFIX}${id}`,
          title:
            titleFromText(nonEmptyString(composer.name)) ??
            titleFromText(firstPrompt) ??
            (nodePath.basename(cwd) || cwd),
          cwd,
          projectId: null,
          createdAt: isoTimestamp(composer.createdAt) ?? updatedAt,
          updatedAt,
          archived: header?.isArchived === 1 || header?.isArchived === true,
        });
      }
      return sessions;
    },
    [],
  );
}

export const cursorSessionReader: LocalHistoryReader = {
  sourceHome: cursorHome,
  discover: async (input) => {
    const cli = await mapBounded(
      await cliChatDirectories(input),
      DISCOVERY_CONCURRENCY,
      async (directory) => (await readCliChat(directory, input.homeDir, false))?.session,
    );
    return {
      sourceHome: cursorHome(input),
      projects: [],
      sessions: [
        ...cli.filter((session) => session !== undefined),
        ...(await discoverAppChats(input)),
      ],
    };
  },
  readMessages: async (input) => {
    if (input.sessionId.startsWith(CLI_PREFIX)) {
      const id = input.sessionId.slice(CLI_PREFIX.length);
      const directory = ID_PATTERN.test(id)
        ? (await cliChatDirectories(input)).find((entry) => nodePath.basename(entry) === id)
        : undefined;
      const chat = directory ? await readCliChat(directory, input.homeDir, true) : undefined;
      if (!chat?.messages) throw new Error("The conversation file is no longer on this computer.");
      return chat.messages;
    }
    const composerId = input.sessionId.slice(APP_PREFIX.length);
    const messages = await withAppStore(
      input,
      (store) => {
        const composer = store.composers.find((entry) => entry.composerId === composerId);
        return composer ? appMessages(store, composer) : undefined;
      },
      undefined,
    );
    if (!messages) throw new Error("The conversation file is no longer on this computer.");
    return messages;
  },
};
