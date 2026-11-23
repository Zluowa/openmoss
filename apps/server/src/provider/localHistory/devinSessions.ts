// FILE: devinSessions.ts
// Purpose: Read Devin CLI sessions from its SQLite store (`%APPDATA%\Devin\cli\sessions.db` on
//          Windows, `<XDG_DATA_HOME|~/.local/share>/devin/cli/sessions.db` elsewhere): `sessions`
//          rows plus the `message_nodes` tree, following the session's main chain.
// Layer: Provider local-history parsing
// Exports: devinSessionReader

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { resolveApplicationDirectory } from "@moss/shared/platformEnvironment";

import {
  openReadonlySqlite,
  sqliteTableColumns,
  sqliteTableNames,
  type ReadonlySqliteDatabase,
  type SqliteRow,
} from "../../readonlySqlite";
import type { NativeImportSession } from "../projectImportTypes";
import {
  absolutePath,
  asRecord,
  envDirectory,
  isoTimestamp,
  nonEmptyString,
  titleFromText,
  visibleMessageText,
} from "./shared";
import type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

function devinCliHome(input: LocalHistoryPathInput): string {
  const userData = resolveApplicationDirectory({
    platform: process.platform,
    homeDir: input.homeDir,
    kind: "cli-data",
    name: "Devin",
    xdgName: "devin",
    roamingAppData: envDirectory(input.env, "APPDATA", input.homeDir),
    xdgHome: envDirectory(input.env, "XDG_DATA_HOME", input.homeDir),
  });
  return nodePath.join(userData, "cli");
}

async function withDatabase<T>(
  input: LocalHistoryPathInput,
  read: (database: ReadonlySqliteDatabase, sessionColumns: ReadonlySet<string>) => T,
  empty: T,
): Promise<T> {
  const file = nodePath.join(devinCliHome(input), "sessions.db");
  try {
    await fs.access(file);
  } catch {
    return empty;
  }
  const database = await openReadonlySqlite(file);
  try {
    const tables = sqliteTableNames(database);
    if (!tables.has("sessions") || !tables.has("message_nodes")) return empty;
    return read(database, sqliteTableColumns(database, "sessions"));
  } finally {
    database.close();
  }
}

/** A stored chat message: `{ role, content }`, possibly wrapped in `message`. */
function messageFrom(row: SqliteRow): LocalHistoryMessage | undefined {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(String(row.chat_message)));
  } catch {
    return undefined;
  }
  const message = asRecord(parsed?.message) ?? parsed;
  const role = message?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = visibleMessageText(message?.content ?? message?.text);
  if (!text) return undefined;
  return {
    id: String(row.node_id),
    role,
    text,
    createdAt: isoTimestamp(row.created_at),
  };
}

/**
 * Nodes form a tree (edits and retries branch). The session's `main_chain_id` names the
 * node the person last saw; walk from it to the root. Without it, read nodes in order.
 */
function mainChain(
  rows: ReadonlyArray<SqliteRow>,
  mainChainId: unknown,
  options?: { readonly requireLeaf?: boolean },
): SqliteRow[] {
  const byId = new Map(rows.map((row) => [String(row.node_id), row] as const));
  const leaf =
    mainChainId === null || mainChainId === undefined ? undefined : byId.get(String(mainChainId));
  if (!leaf) return options?.requireLeaf ? [] : [...rows];
  const chain: SqliteRow[] = [];
  const seen = new Set<string>();
  let current: SqliteRow | undefined = leaf;
  while (current && !seen.has(String(current.node_id))) {
    seen.add(String(current.node_id));
    chain.push(current);
    current =
      current.parent_node_id === null || current.parent_node_id === undefined
        ? undefined
        : byId.get(String(current.parent_node_id));
  }
  return chain.toReversed();
}

const DEVIN_SUBAGENT_PREFIX = "devin-subagent:";

function encodeDevinSubagentId(parentSessionId: string, agentId: string): string {
  return `${DEVIN_SUBAGENT_PREFIX}${encodeURIComponent(parentSessionId)}:${encodeURIComponent(agentId)}`;
}

function decodeDevinSubagentId(
  sessionId: string,
): { readonly parentSessionId: string; readonly agentId: string } | undefined {
  if (!sessionId.startsWith(DEVIN_SUBAGENT_PREFIX)) return undefined;
  const remainder = sessionId.slice(DEVIN_SUBAGENT_PREFIX.length);
  const parts = remainder.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    return {
      parentSessionId: decodeURIComponent(parts[0]),
      agentId: decodeURIComponent(parts[1]),
    };
  } catch {
    return undefined;
  }
}

function hasSubagentHeadsTable(database: ReadonlySqliteDatabase): boolean {
  if (!sqliteTableNames(database).has("subagent_heads")) return false;
  const columns = sqliteTableColumns(database, "subagent_heads");
  return columns.has("session_id") && columns.has("agent_id") && columns.has("chain_node_id");
}

function readMessageNodeRows(
  database: ReadonlySqliteDatabase,
  sessionId: string,
): readonly SqliteRow[] {
  return database.all(
    "SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY node_id",
    sessionId,
  );
}

function readMessages(
  database: ReadonlySqliteDatabase,
  sessionColumns: ReadonlySet<string>,
  sessionId: string,
): LocalHistoryMessage[] {
  const subagent = decodeDevinSubagentId(sessionId);
  if (subagent) {
    if (!hasSubagentHeadsTable(database)) return [];
    const head = database.all(
      "SELECT chain_node_id FROM subagent_heads WHERE session_id = ? AND agent_id = ?",
      subagent.parentSessionId,
      subagent.agentId,
    )[0];
    if (!head) return [];
    const rows = readMessageNodeRows(database, subagent.parentSessionId);
    return mainChain(rows, head.chain_node_id, { requireLeaf: true }).flatMap(
      (row) => messageFrom(row) ?? [],
    );
  }
  const session = database.all(
    `SELECT ${sessionColumns.has("main_chain_id") ? "main_chain_id" : "NULL AS main_chain_id"} FROM sessions WHERE id = ?`,
    sessionId,
  )[0];
  const rows = readMessageNodeRows(database, sessionId);
  return mainChain(rows, session?.main_chain_id).flatMap((row) => messageFrom(row) ?? []);
}

function discover(
  input: LocalHistoryPathInput,
  database: ReadonlySqliteDatabase,
  sessionColumns: ReadonlySet<string>,
): NativeImportSession[] {
  const hasTitle = sessionColumns.has("title");
  const hasHidden = sessionColumns.has("hidden");
  const rows = database.all(
    `SELECT id, working_directory, created_at, last_activity_at${
      hasTitle ? ", title" : ""
    }${hasHidden ? ", hidden" : ""} FROM sessions`,
  );
  const allSessionIds = new Set<string>();
  const discoveredById = new Map<string, NativeImportSession>();
  for (const row of rows) {
    const id = nonEmptyString(row.id);
    if (!id) continue;
    allSessionIds.add(id);
    if (hasHidden && row.hidden !== 0 && row.hidden !== false && row.hidden !== null) {
      continue;
    }
    const messages = readMessages(database, sessionColumns, id);
    const firstPrompt = messages.find((message) => message.role === "user")?.text;
    if (!firstPrompt) continue;
    const cwd = absolutePath(row.working_directory) ?? input.homeDir;
    const updatedAt = isoTimestamp(row.last_activity_at) ?? messages.at(-1)?.createdAt;
    if (!updatedAt) continue;
    discoveredById.set(id, {
      id,
      title:
        titleFromText(nonEmptyString(row.title)) ??
        titleFromText(firstPrompt) ??
        (nodePath.basename(cwd) || cwd),
      cwd,
      projectId: null,
      createdAt: isoTimestamp(row.created_at) ?? updatedAt,
      updatedAt,
      archived: false,
    });
  }

  const subagentSessions: NativeImportSession[] = [];
  if (hasSubagentHeadsTable(database)) {
    const headColumns = sqliteTableColumns(database, "subagent_heads");
    const hasUpdatedAt = headColumns.has("updated_at");
    const heads = database.all(
      `SELECT session_id, agent_id, chain_node_id${
        hasUpdatedAt ? ", updated_at" : ""
      } FROM subagent_heads ORDER BY ${hasUpdatedAt ? "updated_at DESC, " : ""}session_id, agent_id`,
    );
    const nodeCache = new Map<string, readonly SqliteRow[]>();
    for (const head of heads) {
      const parentSessionId = nonEmptyString(head.session_id);
      const agentId = nonEmptyString(head.agent_id);
      if (!parentSessionId || !agentId || parentSessionId === agentId) continue;
      const parentSession = discoveredById.get(parentSessionId);
      if (!parentSession) continue;

      const existingChild = discoveredById.get(agentId);
      if (existingChild) {
        discoveredById.set(agentId, {
          ...existingChild,
          parentSessionId,
          parentSourceSessionId: parentSessionId,
          hierarchyKind: "subagent",
          subagentNickname: agentId,
        });
        continue;
      }
      if (allSessionIds.has(agentId)) continue;

      let parentNodes = nodeCache.get(parentSessionId);
      if (!parentNodes) {
        parentNodes = readMessageNodeRows(database, parentSessionId);
        nodeCache.set(parentSessionId, parentNodes);
      }
      const messages = mainChain(parentNodes, head.chain_node_id, { requireLeaf: true }).flatMap(
        (row) => messageFrom(row) ?? [],
      );
      const firstPrompt = messages.find((message) => message.role === "user")?.text;
      if (!firstPrompt) continue;
      const updatedAt =
        (hasUpdatedAt ? isoTimestamp(head.updated_at) : undefined) ??
        messages.at(-1)?.createdAt ??
        parentSession.updatedAt;
      subagentSessions.push({
        id: encodeDevinSubagentId(parentSessionId, agentId),
        title: titleFromText(firstPrompt) ?? agentId,
        cwd: parentSession.cwd,
        projectId: null,
        createdAt: messages[0]?.createdAt ?? updatedAt,
        updatedAt,
        archived: false,
        parentSessionId,
        parentSourceSessionId: parentSessionId,
        hierarchyKind: "subagent",
        subagentNickname: agentId,
      });
    }
  }

  return [...discoveredById.values(), ...subagentSessions];
}

export const devinSessionReader: LocalHistoryReader = {
  sourceHome: devinCliHome,
  discover: async (input) => ({
    sourceHome: devinCliHome(input),
    projects: [],
    sessions: await withDatabase(
      input,
      (database, columns) => discover(input, database, columns),
      [],
    ),
  }),
  readMessages: (input) =>
    withDatabase(
      input,
      (database, columns) => readMessages(database, columns, input.sessionId),
      [],
    ),
};
