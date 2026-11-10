// FILE: codexProjectImport.ts
// Purpose: Discover local Codex projects and thread metadata without loading provider sessions.
// Layer: Provider metadata discovery

import fs from "node:fs/promises";
import path from "node:path";

import { resolveBaseCodexHomePath } from "../codexHomePaths";
import { normalizeWindowsImportPath } from "../orchestration/projectImportPaths";
import {
  openReadonlySqlite,
  sqliteTableColumns,
  sqliteTableNames,
  type ReadonlySqliteDatabase,
} from "../readonlySqlite";
import { readJsonlRecords } from "./localHistory/jsonlRecords";
import {
  isoTimestamp,
  listDirectory,
  mapBounded,
  modifiedAt,
  titleFromText,
} from "./localHistory/shared";
import type {
  NativeImportProject,
  NativeImportSession,
  NativeProjectImportCatalog,
} from "./projectImportTypes";

type Row = Record<string, unknown>;
interface CodexProjectImportInput {
  homePath?: string;
  env?: NodeJS.ProcessEnv;
}

type ReadonlyDatabase = ReadonlySqliteDatabase;

export class CodexProjectImportError extends Error {
  constructor(
    readonly code: "unsupported" | "unreadable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexProjectImportError";
  }
}

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return object(error).code === "ENOENT";
}

async function realpathIfPresent(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (isMissing(error)) return path.resolve(value);
    throw error;
  }
}

/** Resolve the same source identity for discovery and preview validation, including home overlays. */
export async function resolveCodexProjectImportHome(
  input: CodexProjectImportInput = {},
): Promise<string> {
  const home = await realpathIfPresent(
    resolveBaseCodexHomePath(input.env ?? process.env, input.homePath),
  );
  try {
    // Moss's overlay links this file to the original home. Keep one provenance identity.
    return path.dirname(await fs.realpath(path.join(home, ".codex-global-state.json")));
  } catch (error) {
    if (isMissing(error)) return home;
    throw error;
  }
}

async function readDesktopState(home: string): Promise<Row> {
  try {
    return object(
      JSON.parse(await fs.readFile(path.join(home, ".codex-global-state.json"), "utf8")),
    );
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

async function findStateDatabase(sqliteHome: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(sqliteHome);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const candidates = entries
    .flatMap((name) => {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    })
    .toSorted((a, b) => b.version - a.version);
  return candidates[0] ? path.join(sqliteHome, candidates[0].name) : undefined;
}

function rows(database: ReadonlyDatabase, sql: string): ReadonlyArray<Row> {
  return database.all(sql);
}

function requireColumns(
  database: ReadonlyDatabase,
  table: string,
  required: ReadonlyArray<string>,
) {
  const columns = sqliteTableColumns(database, table);
  if (required.some((name) => !columns.has(name))) {
    throw new CodexProjectImportError("unsupported", `Unsupported Codex ${table} metadata schema.`);
  }
  return columns;
}

function readDatabaseProjects(
  database: ReadonlyDatabase,
  tables: Set<string>,
): NativeImportProject[] {
  if (!tables.has("projects") && !tables.has("project_roots")) return [];
  requireColumns(database, "projects", ["id", "name"]);
  requireColumns(database, "project_roots", ["project_id", "path", "position"]);
  const roots = rows(database, "SELECT project_id, path FROM project_roots ORDER BY position");
  return rows(database, "SELECT id, name FROM projects").flatMap((project) => {
    const id = text(project.id);
    if (!id) return [];
    return [
      {
        id,
        title: text(project.name) ?? id,
        roots: roots.flatMap((root) =>
          root.project_id === id && text(root.path) ? [root.path as string] : [],
        ),
      },
    ];
  });
}

function mergeLegacyProjects(
  modern: ReadonlyArray<NativeImportProject>,
  state: Row,
  homes: ReadonlyArray<string>,
): { projects: NativeImportProject[]; legacyIds: Map<string, string> } {
  const projects = new Map(modern.map((project) => [project.id, project]));
  const legacyIds = new Map<string, string>();
  const mappings = object(state["app-server-project-id-by-legacy-project-id-by-host"]);
  const hostMappings = homes.map((home) => object(mappings[`local:${home}`]));
  for (const [key, value] of Object.entries(object(state["local-projects"]))) {
    const legacy = object(value);
    const legacyId = text(legacy.id) ?? key;
    const mappedId = hostMappings
      .map((mapping) => text(mapping[legacyId]))
      .find((id) => id && projects.has(id));
    const id = mappedId ?? legacyId;
    legacyIds.set(legacyId, id);
    if (projects.has(id)) continue;
    const roots = Array.isArray(legacy.rootPaths)
      ? legacy.rootPaths.flatMap((root) => (text(root) ? [root as string] : []))
      : [];
    projects.set(id, { id, title: text(legacy.name) ?? path.basename(roots[0] ?? id), roots });
  }
  return { projects: [...projects.values()], legacyIds };
}

function isInternalThread(row: Row, children: Set<unknown>): boolean {
  if (children.has(row.id) || text(row.parent_thread_id)) return true;
  const source = text(row.source) ?? "";
  const threadSource = text(row.thread_source) ?? "";
  if (/^sub_?agent/i.test(source) || /^(sub_?agent|guardian)/i.test(threadSource)) return true;
  if (!source.startsWith("{")) return false;
  try {
    return object(JSON.parse(source)).subagent !== undefined;
  } catch {
    return false;
  }
}

function timestamp(milliseconds: unknown, seconds: unknown): string {
  const value =
    typeof milliseconds === "number"
      ? milliseconds
      : typeof seconds === "number"
        ? seconds * 1_000
        : NaN;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CodexProjectImportError(
      "unsupported",
      "Codex thread metadata has an unsupported timestamp.",
    );
  }
  return date.toISOString();
}

function readDatabaseSessions(
  database: ReadonlyDatabase,
  tables: Set<string>,
  state: Row,
  legacyIds: Map<string, string>,
  projects: ReadonlyArray<NativeImportProject>,
): Array<NativeImportSession & { readonly rolloutPath?: string }> {
  const columns = requireColumns(database, "threads", [
    "id",
    "cwd",
    "source",
    "created_at",
    "updated_at",
  ]);
  const selected = [
    "id",
    "cwd",
    "source",
    "created_at",
    "updated_at",
    "created_at_ms",
    "updated_at_ms",
    "name",
    "title",
    "project_id",
    "archived",
    "thread_source",
    "parent_thread_id",
    "rollout_path",
    "first_user_message",
    "preview",
  ].filter((column) => columns.has(column));
  const children = new Set(
    tables.has("thread_spawn_edges")
      ? rows(database, "SELECT child_thread_id FROM thread_spawn_edges").map(
          (row) => row.child_thread_id,
        )
      : [],
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const assignments = object(state["thread-project-assignments"]);
  const projectless = new Set(
    Array.isArray(state["projectless-thread-ids"]) ? state["projectless-thread-ids"] : [],
  );
  return rows(database, `SELECT ${selected.join(", ")} FROM threads`).flatMap((row) => {
    const id = text(row.id);
    const cwd = text(row.cwd);
    if (!id || !cwd || isInternalThread(row, children)) return [];
    const assignment = object(assignments[id]);
    const legacyId =
      !projectless.has(id) && assignment.projectKind === "local"
        ? text(assignment.projectId)
        : undefined;
    const candidateId = text(row.project_id) ?? (legacyId ? legacyIds.get(legacyId) : undefined);
    const rolloutPath = text(row.rollout_path);
    return [
      {
        id,
        // The person's own name for the thread first, then Codex's title, then the prompt.
        title:
          titleFromText(text(row.name)) ??
          titleFromText(text(row.title)) ??
          titleFromText(text(row.first_user_message)) ??
          titleFromText(text(row.preview)) ??
          (path.basename(cwd) || id),
        cwd,
        projectId: candidateId && projectIds.has(candidateId) ? candidateId : null,
        createdAt: timestamp(row.created_at_ms, row.created_at),
        updatedAt: timestamp(row.updated_at_ms, row.updated_at),
        archived: row.archived === 1 || row.archived === true,
        ...(rolloutPath ? { rolloutPath } : {}),
      },
    ];
  });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(normalizeWindowsImportPath(file))).isFile();
  } catch {
    return false;
  }
}

/**
 * Codex keeps listing a thread after its rollout file is deleted or cleaned up, but it can
 * no longer copy it ("missing source rollout"). Offer only threads whose history still exists.
 */
async function withExistingRollouts(
  sessions: ReadonlyArray<NativeImportSession & { readonly rolloutPath?: string }>,
): Promise<NativeImportSession[]> {
  const present = await mapBounded(sessions, ROLLOUT_CONCURRENCY, (session) =>
    session.rolloutPath ? fileExists(session.rolloutPath) : Promise.resolve(true),
  );
  return sessions.flatMap(({ rolloutPath: _rolloutPath, ...session }, index) =>
    present[index] ? [session] : [],
  );
}

const ROLLOUT_FILE = /^rollout-.+\.jsonl$/u;
const ROLLOUT_HEAD_BYTES = 16 * 1024 * 1024;
const ROLLOUT_CONCURRENCY = 8;

async function rolloutFiles(directory: string, depth: number): Promise<string[]> {
  if (depth > 4) return [];
  const files: string[] = [];
  for (const entry of await listDirectory(directory)) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await rolloutFiles(child, depth + 1)));
    else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) files.push(child);
  }
  return files;
}

async function readSessionNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for await (const record of readJsonlRecords(path.join(home, "session_index.jsonl"))) {
    const id = text(record.id);
    const name = text(record.thread_name);
    if (id && name) names.set(id, name);
  }
  return names;
}

async function readRolloutSession(
  file: string,
  archived: boolean,
  names: ReadonlyMap<string, string>,
): Promise<NativeImportSession | undefined> {
  for await (const record of readJsonlRecords(file, { maxBytes: ROLLOUT_HEAD_BYTES })) {
    // The first record of a rollout describes the session.
    if (record.type !== "session_meta") return undefined;
    const meta = object(record.payload);
    const id = text(meta.id);
    const cwd = text(meta.cwd);
    const source =
      typeof meta.source === "string" ? meta.source : JSON.stringify(meta.source ?? "");
    if (!id || !cwd || isInternalThread({ id, source }, new Set())) return undefined;
    const createdAt = isoTimestamp(meta.timestamp) ?? isoTimestamp(record.timestamp);
    const updatedAt = (await modifiedAt(file)) ?? createdAt;
    if (!updatedAt) return undefined;
    return {
      id,
      title: titleFromText(names.get(id)) ?? (path.basename(cwd) || id),
      cwd,
      projectId: null,
      createdAt: createdAt ?? updatedAt,
      updatedAt,
      archived,
    };
  }
  return undefined;
}

async function readRolloutSessions(home: string): Promise<NativeImportSession[]> {
  const [active, archived, names] = await Promise.all([
    rolloutFiles(path.join(home, "sessions"), 0),
    rolloutFiles(path.join(home, "archived_sessions"), 0),
    readSessionNames(home),
  ]);
  const sessions = await mapBounded(
    [
      ...active.map((file) => [file, false] as const),
      ...archived.map((file) => [file, true] as const),
    ],
    ROLLOUT_CONCURRENCY,
    ([file, isArchived]) => readRolloutSession(file, isArchived, names),
  );
  const byId = new Map<string, NativeImportSession>();
  for (const session of sessions) {
    if (session && !byId.has(session.id)) byId.set(session.id, session);
  }
  return [...byId.values()];
}

/**
 * The rollout file holding a thread's history: the state database's `rollout_path`, or for
 * homes without one, the `rollout-*-<id>.jsonl` file under `sessions/` or `archived_sessions/`.
 */
export async function findCodexRolloutPath(
  input: CodexProjectImportInput & { readonly threadId: string },
): Promise<string | undefined> {
  const env = input.env ?? process.env;
  const sourceHome = await resolveCodexProjectImportHome(input);
  const home = await realpathIfPresent(path.resolve(resolveBaseCodexHomePath(env, input.homePath)));
  const dbPath = await findStateDatabase(
    await realpathIfPresent(env.CODEX_SQLITE_HOME?.trim() || sourceHome),
  );
  if (dbPath) {
    const database = await openReadonlySqlite(dbPath);
    try {
      if (sqliteTableColumns(database, "threads").has("rollout_path")) {
        const recorded = text(
          database.all("SELECT rollout_path FROM threads WHERE id = ?", input.threadId)[0]
            ?.rollout_path,
        );
        if (recorded) return recorded;
      }
    } finally {
      database.close();
    }
  }
  const suffix = `-${input.threadId}.jsonl`;
  for (const directory of ["sessions", "archived_sessions"]) {
    const match = (await rolloutFiles(path.join(home, directory), 0)).find((file) =>
      file.endsWith(suffix),
    );
    if (match) return match;
  }
  return undefined;
}

export async function discoverCodexProjects(
  input: CodexProjectImportInput = {},
): Promise<NativeProjectImportCatalog> {
  let database: ReadonlyDatabase | undefined;
  try {
    const env = input.env ?? process.env;
    const configuredHome = path.resolve(resolveBaseCodexHomePath(env, input.homePath));
    const home = await realpathIfPresent(configuredHome);
    const sourceHome = await resolveCodexProjectImportHome(input);
    const state = await readDesktopState(home);
    const sqliteHome = await realpathIfPresent(env.CODEX_SQLITE_HOME?.trim() || sourceHome);
    const dbPath = await findStateDatabase(sqliteHome);
    if (dbPath) database = await openReadonlySqlite(dbPath);
    // A read transaction keeps projects, assignments, and thread metadata on one SQLite snapshot.
    database?.exec("BEGIN");
    const tables = database ? sqliteTableNames(database) : new Set<string>();
    const { projects, legacyIds } = mergeLegacyProjects(
      database ? readDatabaseProjects(database, tables) : [],
      state,
      [sourceHome, home, configuredHome, sqliteHome],
    );
    // Codex releases before the state database kept only rollout files; read those
    // directly so their conversations are still found.
    const sessions = database
      ? readDatabaseSessions(database, tables, state, legacyIds, projects)
      : await readRolloutSessions(home);
    database?.close();
    database = undefined;
    return { sourceHome, projects, sessions: await withExistingRollouts(sessions) };
  } catch (error) {
    if (error instanceof CodexProjectImportError) throw error;
    throw new CodexProjectImportError(
      "unreadable",
      "Could not read local Codex project metadata.",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}
