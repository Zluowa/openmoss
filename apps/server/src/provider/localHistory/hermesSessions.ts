// FILE: hermesSessions.ts
// Purpose: Read Hermes Agent sessions from `<HERMES_HOME|~/.hermes>/state.db` (`sessions` and
//          `messages`). Hermes splits a long session into child sessions when it compresses
//          context, so a conversation is a root session plus its descendants.
// Layer: Provider local-history parsing
// Exports: hermesSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  openReadonlySqlite,
  sqliteTableColumns,
  sqliteTableNames,
  type ReadonlySqliteDatabase,
} from "../../readonlySqlite";
import type { NativeImportSession } from "../projectImportTypes";
import {
  absolutePath,
  envDirectory,
  isoTimestamp,
  nonEmptyString,
  titleFromText,
  visibleMessageText,
} from "./shared";
import type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

interface Store {
  readonly database: ReadonlySqliteDatabase;
  readonly sessionColumns: ReadonlySet<string>;
  /** SQL that keeps only messages the person saw (newer schemas mark the rest). */
  readonly visibleMessage: string;
}

function hermesHome(input: LocalHistoryPathInput): string {
  return (
    envDirectory(input.env, "HERMES_HOME", input.homeDir) ?? nodePath.join(input.homeDir, ".hermes")
  );
}

async function withStore<T>(
  input: LocalHistoryPathInput,
  read: (store: Store) => T,
  empty: T,
): Promise<T> {
  const file = nodePath.join(hermesHome(input), "state.db");
  try {
    await fs.access(file);
  } catch {
    return empty;
  }
  const database = await openReadonlySqlite(file);
  try {
    const tables = sqliteTableNames(database);
    if (!tables.has("sessions") || !tables.has("messages")) return empty;
    const messageColumns = sqliteTableColumns(database, "messages");
    const visibleMessage = [
      "1 = 1",
      ...(messageColumns.has("active") ? ["m.active = 1"] : []),
      ...(messageColumns.has("compacted") ? ["m.compacted = 0"] : []),
      ...(messageColumns.has("_compressed_summary") ? ["m._compressed_summary = 0"] : []),
    ].join(" AND ");
    return read({
      database,
      sessionColumns: sqliteTableColumns(database, "sessions"),
      visibleMessage,
    });
  } finally {
    database.close();
  }
}

function conversationMessages(store: Store, rootId: string): LocalHistoryMessage[] {
  const { database, sessionColumns, visibleMessage } = store;
  const rows = sessionColumns.has("parent_session_id")
    ? database.all(
        `WITH RECURSIVE chain(id) AS (
           SELECT ? UNION ALL
           SELECT s.id FROM sessions s JOIN chain c ON s.parent_session_id = c.id
         )
         SELECT m.id, m.role, m.content, m.timestamp FROM messages m
         WHERE m.session_id IN (SELECT id FROM chain) AND ${visibleMessage}
         ORDER BY m.timestamp, m.id`,
        rootId,
      )
    : database.all(
        `SELECT m.id, m.role, m.content, m.timestamp FROM messages m
         WHERE m.session_id = ? AND ${visibleMessage} ORDER BY m.timestamp, m.id`,
        rootId,
      );
  return rows.flatMap((row) => {
    if (row.role !== "user" && row.role !== "assistant") return [];
    const text = visibleMessageText(row.content);
    if (!text) return [];
    return [{ id: String(row.id), role: row.role, text, createdAt: isoTimestamp(row.timestamp) }];
  });
}

function discover(input: LocalHistoryPathInput, store: Store): NativeImportSession[] {
  const { database, sessionColumns } = store;
  const optional = ["title", "cwd"].filter((column) => sessionColumns.has(column));
  const rows = database.all(
    `SELECT id, started_at, ended_at${optional.map((column) => `, ${column}`).join("")}
     FROM sessions${sessionColumns.has("parent_session_id") ? " WHERE parent_session_id IS NULL" : ""}`,
  );
  return rows.flatMap((row) => {
    const id = nonEmptyString(row.id);
    if (!id) return [];
    const messages = conversationMessages(store, id);
    const firstPrompt = messages.find((message) => message.role === "user")?.text;
    if (!firstPrompt) return [];
    const updatedAt =
      messages.at(-1)?.createdAt ?? isoTimestamp(row.ended_at) ?? isoTimestamp(row.started_at);
    if (!updatedAt) return [];
    // Older Hermes versions do not record a working folder; file those under the home folder.
    const cwd = absolutePath(row.cwd) ?? input.homeDir;
    return [
      {
        id,
        title:
          titleFromText(nonEmptyString(row.title)) ??
          titleFromText(firstPrompt) ??
          (nodePath.basename(cwd) || cwd),
        cwd,
        projectId: null,
        createdAt: isoTimestamp(row.started_at) ?? updatedAt,
        updatedAt,
        archived: false,
      },
    ];
  });
}

export const hermesSessionReader: LocalHistoryReader = {
  sourceHome: hermesHome,
  discover: async (input) => ({
    sourceHome: hermesHome(input),
    projects: [],
    sessions: await withStore(input, (store) => discover(input, store), []),
  }),
  readMessages: (input) =>
    withStore(input, (store) => conversationMessages(store, input.sessionId), []),
};
