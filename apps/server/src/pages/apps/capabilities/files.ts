// FILE: files.ts
// Purpose: Server half of the `files` capability: a page reads the files of
// one Moss project as the viewer — list, stat and read in bounded pieces.
// It never writes. Paths stay inside the project's folder (symlinks
// included), `.git` is never shown, and every read is audited.
// Layer: Server pages/apps

import { open, readdir, realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";

import {
  PAGE_APP_FILES_MAX_READ_BYTES,
  PAGE_APP_FILES_PAGE_SIZE,
  type PageAppFileEntry,
  type PageAppFilesListResult,
  type PageAppFilesReadWire,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PageAppExtensionStore } from "../extensions/PageAppExtensionStore";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

export interface PageAppProject {
  readonly id: string;
  readonly title: string;
  readonly root: string;
}

export interface PageAppFilesDeps {
  readonly store: PageAppExtensionStore;
  /** The project a page reads: the declared id, else the project of the chat that made it. */
  readonly project: (
    projectId: string | null,
    sourceThreadId: string | null,
  ) => Effect.Effect<PageAppProject | null, PageAppCapabilityError>;
  readonly now: () => string;
}

const HIDDEN = new Set([".git"]);
const SKIP_DESCENT = new Set([".git", "node_modules"]);
const MAX_WALK = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);

/** A page path: forward slashes, relative, no `.`/`..`, no drive or NUL. "" is the top. */
export function normalizePageFilePath(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > 1_024 || raw.includes("\u0000"))
    throw fail("invalid_argument", "A file path must be a short string.");
  const parts = raw
    .replace(/\\/gu, "/")
    .split("/")
    .filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === "." || part === ".." || /^[A-Za-z]:$/u.test(part))
      throw fail("invalid_argument", `Invalid path segment "${part}".`);
    if (HIDDEN.has(part)) throw fail("not_found", "No such file or folder.");
  }
  return parts.join("/");
}

/** The absolute path, after checking it (and what it links to) stays in the root. */
export async function resolveInside(root: string, pagePath: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => {
    throw fail("unavailable", "The project's folder is not available.");
  });
  const target = nodePath.resolve(realRoot, ...pagePath.split("/").filter(Boolean));
  const real = await realpath(target).catch(() => {
    throw fail("not_found", "No such file or folder.");
  });
  const relative = nodePath.relative(realRoot, real);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative))
    throw fail("not_found", "No such file or folder.");
  return real;
}

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string") throw fail("invalid_argument", "Malformed cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Number.isSafeInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch {
    // fall through
  }
  throw fail("invalid_argument", "Malformed cursor.");
}

async function entryOf(absolute: string, pagePath: string): Promise<PageAppFileEntry | null> {
  const info = await stat(absolute).catch(() => null);
  if (!info) return null;
  return {
    path: pagePath,
    isDirectory: info.isDirectory(),
    size: info.isDirectory() ? 0 : info.size,
    modifiedAt: info.mtime ? info.mtime.toISOString() : null,
  };
}

async function listFolder(
  root: string,
  folder: string,
  recursive: boolean,
): Promise<PageAppFileEntry[]> {
  const base = await resolveInside(root, folder);
  const info = await stat(base);
  if (!info.isDirectory()) throw fail("invalid_argument", "That path is a file, not a folder.");
  const out: PageAppFileEntry[] = [];
  const queue: Array<{ abs: string; rel: string }> = [{ abs: base, rel: folder }];
  while (queue.length > 0 && out.length < MAX_WALK) {
    const next = queue.shift()!;
    const children = await readdir(next.abs, { withFileTypes: true }).catch(() => []);
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (HIDDEN.has(child.name)) continue;
      const rel = next.rel ? `${next.rel}/${child.name}` : child.name;
      const abs = nodePath.join(next.abs, child.name);
      if (child.isSymbolicLink()) {
        // A link is listed only when it stays inside the project.
        const inside = await resolveInside(root, rel).then(
          () => true,
          () => false,
        );
        if (!inside) continue;
      }
      const entry = await entryOf(abs, rel);
      if (!entry) continue;
      out.push(entry);
      if (
        recursive &&
        entry.isDirectory &&
        !SKIP_DESCENT.has(child.name) &&
        !child.isSymbolicLink()
      )
        queue.push({ abs, rel });
      if (out.length >= MAX_WALK) break;
    }
  }
  return out;
}

export function makeFilesCapability(deps: PageAppFilesDeps): PageAppServerCapability {
  const run = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: (cause) => {
        const error = toPageAppCallError(cause);
        return new PageAppCapabilityError(
          error.code === "unavailable" && !(cause instanceof PageAppCapabilityError)
            ? "not_found"
            : error.code,
          error.code === "unavailable" && !(cause instanceof PageAppCapabilityError)
            ? "No such file or folder."
            : error.message,
        );
      },
    });

  const projectOf = (ctx: PageAppServerCallContext) =>
    Effect.gen(function* () {
      if (!ctx.viewer.isOwner)
        return yield* Effect.fail(
          fail("not_found", "This viewer cannot open the project's files."),
        );
      const declared =
        isRecord(ctx.config) && typeof ctx.config.project === "string" ? ctx.config.project : null;
      const project = yield* deps.project(declared, ctx.app.sourceThreadId);
      if (!project)
        return yield* Effect.fail(fail("not_found", "This page has no Moss project to read."));
      return project;
    });

  const audit = (
    ctx: PageAppServerCallContext,
    method: string,
    target: string,
    outcome: string,
    detail?: string,
  ) =>
    deps.store
      .audit(
        {
          appId: ctx.app.id,
          revision: ctx.revision,
          viewerId: ctx.viewer.id,
          capability: "files",
          method,
          target,
          outcome,
          detail: detail ?? null,
        },
        deps.now(),
      )
      .pipe(Effect.catch(() => Effect.void));

  const call = (ctx: PageAppServerCallContext, method: string, args: unknown) =>
    Effect.gen(function* () {
      const project = yield* projectOf(ctx);
      const options = isRecord(args) ? args : {};
      const path = yield* Effect.try({
        try: () => normalizePageFilePath(options.path),
        catch: (error) =>
          error instanceof PageAppCapabilityError
            ? error
            : fail("invalid_argument", "Malformed path."),
      });
      switch (method) {
        case "list": {
          const offset = yield* Effect.try({
            try: () => decodeCursor(options.cursor),
            catch: (error) =>
              error instanceof PageAppCapabilityError
                ? error
                : fail("invalid_argument", "Malformed cursor."),
          });
          const all = yield* run(() => listFolder(project.root, path, options.recursive === true));
          const entries = all.slice(offset, offset + PAGE_APP_FILES_PAGE_SIZE);
          const nextOffset = offset + entries.length;
          const result: PageAppFilesListResult = {
            project: { id: project.id, title: project.title },
            entries,
            cursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
          };
          return result;
        }
        case "stat": {
          const absolute = yield* run(() => resolveInside(project.root, path));
          const entry = yield* run(async () => {
            const found = await entryOf(absolute, path);
            if (!found) throw fail("not_found", "No such file or folder.");
            const info = await stat(absolute);
            return { ...found, revision: `${info.size}-${Math.floor(info.mtimeMs)}` };
          });
          return entry;
        }
        case "read": {
          const offset = typeof options.offset === "number" ? options.offset : 0;
          const length =
            typeof options.length === "number" ? options.length : PAGE_APP_FILES_MAX_READ_BYTES;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 1
          )
            return yield* Effect.fail(
              fail("invalid_argument", "offset and length must be whole numbers."),
            );
          if (length > PAGE_APP_FILES_MAX_READ_BYTES)
            return yield* Effect.fail(fail("invalid_argument", "Read at most 4 MB at a time."));
          const absolute = yield* run(() => resolveInside(project.root, path));
          const wire = yield* run(async (): Promise<PageAppFilesReadWire> => {
            const info = await stat(absolute);
            if (info.isDirectory()) throw fail("invalid_argument", "That path is a folder.");
            const handle = await open(absolute, "r");
            try {
              const size = Math.max(0, Math.min(length, info.size - offset));
              const buffer = Buffer.alloc(size);
              const { bytesRead } =
                size > 0 ? await handle.read(buffer, 0, size, offset) : { bytesRead: 0 };
              return {
                base64: buffer.subarray(0, bytesRead).toString("base64"),
                size: info.size,
                revision: `${info.size}-${Math.floor(info.mtimeMs)}`,
              };
            } finally {
              await handle.close();
            }
          }).pipe(Effect.tapError((error) => audit(ctx, "read", path, error.code)));
          // One audit row per file, not per chunk.
          if (offset === 0)
            yield* audit(ctx, options.purpose === "download" ? "download" : "read", path, "ok");
          return wire;
        }
        default:
          return yield* Effect.fail(fail("invalid_argument", `files has no "${method}".`));
      }
    });

  return {
    name: "files",
    consent: "standing",
    validateConfig: (config) => {
      if (config === undefined || config === null) return null;
      if (!isRecord(config)) return "files config must be an object.";
      if (
        config.project !== undefined &&
        (typeof config.project !== "string" || !config.project.trim())
      )
        return "files.project must be a Moss project id.";
      return null;
    },
    call,
  };
}

/** Looks a project up in the projections (not deleted), by id or through the chat that made the page. */
export function makeProjectResolver(sql: SqlClient.SqlClient): PageAppFilesDeps["project"] {
  return (projectId, sourceThreadId) =>
    Effect.gen(function* () {
      type Row = { project_id: string; title: string; workspace_root: string };
      if (projectId) {
        const rows =
          yield* sql<Row>`SELECT project_id, title, workspace_root FROM projection_projects
          WHERE project_id = ${projectId} AND deleted_at IS NULL`;
        return rows[0]
          ? { id: rows[0].project_id, title: rows[0].title, root: rows[0].workspace_root }
          : null;
      }
      if (!sourceThreadId) return null;
      const rows = yield* sql<Row>`SELECT p.project_id, p.title, p.workspace_root
        FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.thread_id = ${sourceThreadId} AND p.deleted_at IS NULL`;
      return rows[0]
        ? { id: rows[0].project_id, title: rows[0].title, root: rows[0].workspace_root }
        : null;
    }).pipe(Effect.mapError(() => fail("storage", "Moss could not look up the project.")));
}
