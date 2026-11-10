// FILE: openCodeSessions.ts
// Purpose: Read OpenCode-style SQLite session stores: OpenCode's current `session_v2`/
//          `session_message` tables and the earlier `session`/`message`/`part` tables, which
//          ZCode (an OpenCode fork) still uses.
// Layer: Provider local-history parsing
// Exports: makeOpenCodeStyleReader, openCodeSessionReader, zcodeSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  openReadonlySqlite,
  sqliteTableColumns,
  sqliteTableNames,
  type ReadonlySqliteDatabase,
  type SqliteRow,
} from "../../readonlySqlite";
import type { NativeImportSession, NativeProjectImportCatalog } from "../projectImportTypes";
import {
  absolutePath,
  asRecord,
  envDirectory,
  isoTimestamp,
  nonEmptyString,
  visibleMessageText,
} from "./shared";
import type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

type Layout = "v2" | "legacy";

interface Store {
  readonly database: ReadonlySqliteDatabase;
  readonly layout: Layout;
  readonly sessionColumns: ReadonlySet<string>;
  readonly ordered: { readonly message: boolean; readonly part: boolean };
}

const SESSION_COLUMNS = ["id", "directory", "title", "parent_id", "time_created", "time_updated"];

async function withStore<T>(
  file: string,
  agentName: string,
  read: (store: Store) => T,
  empty: T,
): Promise<T> {
  try {
    await fs.access(file);
  } catch {
    return empty;
  }
  const database = await openReadonlySqlite(file);
  try {
    const tables = sqliteTableNames(database);
    const layout: Layout | undefined =
      tables.has("session_v2") && tables.has("session_message")
        ? "v2"
        : tables.has("session") && tables.has("message") && tables.has("part")
          ? "legacy"
          : undefined;
    if (!layout) return empty;
    const sessionColumns = sqliteTableColumns(database, layout === "v2" ? "session_v2" : "session");
    if (SESSION_COLUMNS.some((column) => !sessionColumns.has(column))) {
      throw new Error(
        `This ${agentName} version stores conversations in a format Moss can't read yet.`,
      );
    }
    const ordered =
      layout === "legacy"
        ? {
            message: sqliteTableColumns(database, "message").has("sequence"),
            part: sqliteTableColumns(database, "part").has("sequence"),
          }
        : { message: false, part: false };
    return read({ database, layout, sessionColumns, ordered });
  } finally {
    database.close();
  }
}

function parseData(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Prompts the agent added on its own (background tasks, listings) are not the person's words. */
function isHiddenMessage(data: Record<string, unknown>): boolean {
  return data.synthetic === true || data.visibility === "model-only";
}

function sessionFromRow(row: SqliteRow, hasArchive: boolean): NativeImportSession | undefined {
  const id = nonEmptyString(row.id);
  const cwd = absolutePath(row.directory);
  const updatedAt = isoTimestamp(row.time_updated);
  if (!id || !cwd || !updatedAt) return undefined;
  return {
    id,
    title: nonEmptyString(row.title) ?? (nodePath.basename(cwd) || cwd),
    cwd,
    projectId: null,
    createdAt: isoTimestamp(row.time_created) ?? updatedAt,
    updatedAt,
    archived: hasArchive && row.time_archived !== null && row.time_archived !== undefined,
  };
}

function discoverSessions({ database, layout, sessionColumns }: Store): NativeImportSession[] {
  const sessionTable = layout === "v2" ? "session_v2" : "session";
  const hasArchive = sessionColumns.has("time_archived");
  const filters = [
    // Child sessions are subagent runs inside a parent conversation, not conversations.
    "s.parent_id IS NULL",
    layout === "v2"
      ? "EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id AND m.type = 'user')"
      : "EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user')",
    ...(sessionColumns.has("time_deleted") ? ["s.time_deleted IS NULL"] : []),
    // ZCode also keeps side chats and subagent children as sessions.
    ...(sessionColumns.has("task_type") ? ["s.task_type = 'interactive'"] : []),
  ];
  const rows = database.all(
    `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated${
      hasArchive ? ", s.time_archived" : ""
    } FROM ${sessionTable} s WHERE ${filters.join(" AND ")}`,
  );
  return rows.flatMap((row) => sessionFromRow(row, hasArchive) ?? []);
}

function readV2Messages({ database }: Store, sessionId: string): LocalHistoryMessage[] {
  return database
    .all(
      "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq, time_created, id",
      sessionId,
    )
    .flatMap((row) => {
      const data = parseData(row.data);
      const role = row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : null;
      if (!data || !role || isHiddenMessage(data)) return [];
      const text = visibleMessageText(role === "user" ? data.text : data.content);
      if (!text) return [];
      return [{ id: String(row.id), role, text, createdAt: isoTimestamp(row.time_created) }];
    });
}

function readLegacyMessages(
  { database, ordered }: Store,
  sessionId: string,
): LocalHistoryMessage[] {
  const textByMessage = new Map<string, string[]>();
  for (const row of database.all(
    `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY ${
      ordered.part ? "sequence, " : ""
    }id`,
    sessionId,
  )) {
    const part = parseData(row.data);
    if (part?.type !== "text" || part.synthetic === true || part.ignored === true) continue;
    const text = visibleMessageText(part.text);
    if (!text) continue;
    const messageId = String(row.message_id);
    textByMessage.set(messageId, [...(textByMessage.get(messageId) ?? []), text]);
  }
  return database
    .all(
      `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY ${
        ordered.message ? "sequence, " : ""
      }time_created, id`,
      sessionId,
    )
    .flatMap((row) => {
      const data = parseData(row.data);
      const role = data?.role === "user" || data?.role === "assistant" ? data.role : null;
      const text = textByMessage.get(String(row.id))?.join("\n\n");
      if (!data || !role || !text || isHiddenMessage(data)) return [];
      return [{ id: String(row.id), role, text, createdAt: isoTimestamp(row.time_created) }];
    });
}

export interface ChatFolderGroup {
  /** What the agent calls these conversations, shown as one project. */
  readonly title: string;
  /**
   * The folder holding the agent's per-chat throwaway folders when `cwd` is one of them.
   * Matched on the recorded path, so chats are grouped even when the store was moved.
   */
  readonly rootOf: (cwd: string) => string | undefined;
}

/**
 * Agents that give every folder-less chat its own throwaway folder (`draft-<uuid>`) would show
 * as dozens of unrecognisable projects. Those chats are grouped into one project instead.
 */
function groupChatFolders(
  sessions: ReadonlyArray<NativeImportSession>,
  group: ChatFolderGroup | undefined,
): Pick<NativeProjectImportCatalog, "projects" | "sessions"> {
  if (!group) return { projects: [], sessions };
  const projects = new Map<string, NativeProjectImportCatalog["projects"][number]>();
  const assigned = sessions.map((session) => {
    const root = group.rootOf(session.cwd);
    if (!root) return session;
    const id = `chats:${root}`;
    if (!projects.has(id)) projects.set(id, { id, title: group.title, roots: [root] });
    return { ...session, projectId: id };
  });
  return { projects: [...projects.values()], sessions: assigned };
}

export function makeOpenCodeStyleReader(options: {
  readonly agentName: string;
  readonly sourceHome: (input: LocalHistoryPathInput) => string;
  readonly databasePath: (input: LocalHistoryPathInput) => string;
  readonly chatFolders?: ChatFolderGroup;
}): LocalHistoryReader {
  return {
    sourceHome: options.sourceHome,
    discover: async (input) => ({
      sourceHome: options.sourceHome(input),
      ...groupChatFolders(
        await withStore(options.databasePath(input), options.agentName, discoverSessions, []),
        options.chatFolders,
      ),
    }),
    readMessages: (input) =>
      withStore(
        options.databasePath(input),
        options.agentName,
        (store) =>
          store.layout === "v2"
            ? readV2Messages(store, input.sessionId)
            : readLegacyMessages(store, input.sessionId),
        [],
      ),
  };
}

function openCodeDataHome(input: LocalHistoryPathInput): string {
  return nodePath.join(
    envDirectory(input.env, "XDG_DATA_HOME", input.homeDir) ??
      nodePath.join(input.homeDir, ".local", "share"),
    "opencode",
  );
}

export const openCodeSessionReader = makeOpenCodeStyleReader({
  agentName: "OpenCode",
  sourceHome: openCodeDataHome,
  databasePath: (input) => nodePath.join(openCodeDataHome(input), "opencode.db"),
});

const ZCODE_CHAT_FOLDER = /^(.*[\\/]\.zcode[\\/]workspace)[\\/](?:default|draft-[^\\/]+)[\\/]?$/iu;

/** ZCode only honors a home whose folder is named `.zcode`, like its own CLI. */
function zcodeHome(input: LocalHistoryPathInput): string {
  const configured = envDirectory(input.env, "ZCODE_HOME", input.homeDir);
  return configured && nodePath.basename(configured) === ".zcode"
    ? configured
    : nodePath.join(input.homeDir, ".zcode");
}

export const zcodeSessionReader = makeOpenCodeStyleReader({
  agentName: "ZCode",
  sourceHome: zcodeHome,
  databasePath: (input) => nodePath.join(zcodeHome(input), "cli", "db", "db.sqlite"),
  // ZCode runs chats started without a folder in `.zcode/workspace/default` or
  // `.zcode/workspace/draft-<id>` and lists them as plain chats, not projects.
  chatFolders: {
    title: "ZCode chats",
    rootOf: (cwd) => ZCODE_CHAT_FOLDER.exec(cwd)?.[1],
  },
});
