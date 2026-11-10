// FILE: PageAppDbStore.ts
// Purpose: The `db` capability's document store: JSON documents at slash
// paths in SQLite, access rules on every read and write, a document cap per
// page, short cooperative leases, and live change notifications.
// Layer: Server pages/apps

import {
  PAGE_APP_DB_MAX_DEPTH,
  PAGE_APP_DB_MAX_DOCUMENT_BYTES,
  PAGE_APP_DB_MAX_DOCUMENTS,
  PAGE_APP_DB_MAX_FILTERS,
  PAGE_APP_DB_MAX_QUERY_LIMIT,
  PageAppDbQuery,
  type PageAppDbDocument,
  type PageAppDbFilter,
  type PageAppDbRule,
  type PageAppViewer,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import {
  isPageAppCollectionPath,
  isPageAppDocumentPath,
  pageAppDbAllows,
  splitPageAppDbPath,
} from "@moss/shared/pageAppDbRules";
import { Effect, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Documents a single query may scan before it must be narrowed. */
const MAX_SCAN = 5_000;
const MAX_LEASE_MS = 60_000;

type DocumentRow = {
  path: string;
  doc_id: string;
  data_json: string;
  updated_at: string;
};

export interface PageAppDbChange {
  readonly appId: string;
  readonly path: string;
  readonly collectionPath: string;
}

export interface PageAppDbScope {
  readonly appId: string;
  readonly rules: readonly PageAppDbRule[];
  readonly viewer: Pick<PageAppViewer, "id" | "level">;
}

export interface PageAppDbQuerySnapshot {
  readonly docs: readonly PageAppDbDocument[];
}

const invalid = (message: string) => new PageAppCapabilityError("invalid_argument", message);

function checkBody(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw invalid("Document body must be a plain JSON object.");
  let depth = 0;
  const walk = (value: unknown, level: number) => {
    depth = Math.max(depth, level);
    if (depth > PAGE_APP_DB_MAX_DEPTH)
      throw invalid(`Documents may nest at most ${PAGE_APP_DB_MAX_DEPTH} levels.`);
    if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) walk(child, level + 1);
    }
  };
  walk(data, 1);
  return data as Record<string, unknown>;
}

function serialize(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, "utf8") > PAGE_APP_DB_MAX_DOCUMENT_BYTES)
    throw invalid("A document is at most 256 KiB.");
  return json;
}

function mergeDeep(target: Record<string, unknown>, patch: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const current = out[key];
    out[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

const compare = (left: unknown, right: unknown): number => {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : 1;
};

export function pageAppDbMatches(data: Record<string, unknown>, filter: PageAppDbFilter): boolean {
  const value = data[filter.field];
  switch (filter.op) {
    case "==":
      return JSON.stringify(value) === JSON.stringify(filter.value);
    case "!=":
      return value !== undefined && JSON.stringify(value) !== JSON.stringify(filter.value);
    case "<":
      return value !== undefined && compare(value, filter.value) < 0;
    case "<=":
      return value !== undefined && compare(value, filter.value) <= 0;
    case ">":
      return value !== undefined && compare(value, filter.value) > 0;
    case ">=":
      return value !== undefined && compare(value, filter.value) >= 0;
    case "in":
      return (
        Array.isArray(filter.value) &&
        filter.value.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
      );
    case "not-in":
      return (
        value !== undefined &&
        Array.isArray(filter.value) &&
        !filter.value.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
      );
    case "array-contains":
      return (
        Array.isArray(value) &&
        value.some((item) => JSON.stringify(item) === JSON.stringify(filter.value))
      );
  }
}

const parentCollection = (path: string) => {
  const parts = splitPageAppDbPath(path)!;
  return parts.slice(0, -1).join("/");
};

export const makePageAppDbStore = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<PageAppDbChange>();
    const leases = new Map<string, { holder: string; expiresAt: number }>();

    const toDocument = (path: string, row: DocumentRow | undefined): PageAppDbDocument => {
      const parts = splitPageAppDbPath(path)!;
      return row
        ? {
            id: parts.at(-1)!,
            path,
            exists: true,
            data: JSON.parse(row.data_json),
            updatedAt: row.updated_at,
          }
        : { id: parts.at(-1)!, path, exists: false, data: null, updatedAt: null };
    };

    const requireDocPath = (path: unknown): Effect.Effect<string, PageAppCapabilityError> =>
      typeof path === "string" && isPageAppDocumentPath(path)
        ? Effect.succeed(splitPageAppDbPath(path)!.join("/"))
        : Effect.fail(invalid("A document path has an even number of valid segments."));

    const storage = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof PageAppCapabilityError
            ? cause
            : new PageAppCapabilityError("unavailable", "The page database is unavailable."),
        ),
      );

    const get = (scope: PageAppDbScope, rawPath: unknown) =>
      storage(
        Effect.gen(function* () {
          const path = yield* requireDocPath(rawPath);
          if (!pageAppDbAllows(scope.rules, scope.viewer, path, "read"))
            return toDocument(path, undefined);
          const rows = yield* sql<DocumentRow>`SELECT path, doc_id, data_json, updated_at
            FROM page_app_documents WHERE app_id = ${scope.appId} AND path = ${path}`;
          return toDocument(path, rows[0]);
        }),
      );

    const publish = (appId: string, path: string) =>
      PubSub.publish(changes, { appId, path, collectionPath: parentCollection(path) });

    const write = (
      scope: PageAppDbScope,
      rawPath: unknown,
      rawData: unknown,
      mode: "set" | "update",
      now: string,
    ) =>
      storage(
        Effect.gen(function* () {
          const path = yield* requireDocPath(rawPath);
          if (!pageAppDbAllows(scope.rules, scope.viewer, path, "write"))
            return yield* Effect.fail(invalid("This viewer may not write here."));
          const body = yield* Effect.try({
            try: () => checkBody(rawData),
            catch: (e) => e as PageAppCapabilityError,
          });
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<DocumentRow>`SELECT path, doc_id, data_json, updated_at
                FROM page_app_documents WHERE app_id = ${scope.appId} AND path = ${path}`;
              const existing = rows[0];
              if (mode === "update" && !existing)
                return yield* Effect.fail(invalid("update() needs an existing document."));
              const merged =
                mode === "update" && existing
                  ? mergeDeep(JSON.parse(existing.data_json), body)
                  : body;
              const json = yield* Effect.try({
                try: () => serialize(merged),
                catch: (e) => e as PageAppCapabilityError,
              });
              if (existing) {
                yield* sql`UPDATE page_app_documents SET data_json = ${json},
                  size_bytes = ${Buffer.byteLength(json, "utf8")}, updated_by = ${scope.viewer.id},
                  updated_at = ${now} WHERE app_id = ${scope.appId} AND path = ${path}`;
              } else {
                const count = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM page_app_documents
                  WHERE app_id = ${scope.appId}`;
                if ((count[0]?.n ?? 0) >= PAGE_APP_DB_MAX_DOCUMENTS)
                  return yield* Effect.fail(
                    new PageAppCapabilityError(
                      "quota_exceeded",
                      `This page's database is full (${PAGE_APP_DB_MAX_DOCUMENTS} documents). Delete some first.`,
                    ),
                  );
                const parts = splitPageAppDbPath(path)!;
                yield* sql`INSERT INTO page_app_documents (app_id, path, collection_path, doc_id, data_json,
                  size_bytes, updated_by, created_at, updated_at)
                  VALUES (${scope.appId}, ${path}, ${parts.slice(0, -1).join("/")}, ${parts.at(-1)!}, ${json},
                  ${Buffer.byteLength(json, "utf8")}, ${scope.viewer.id}, ${now}, ${now})`;
              }
            }),
          );
          yield* publish(scope.appId, path);
          return null;
        }),
      );

    const remove = (scope: PageAppDbScope, rawPath: unknown) =>
      storage(
        Effect.gen(function* () {
          const path = yield* requireDocPath(rawPath);
          if (!pageAppDbAllows(scope.rules, scope.viewer, path, "write"))
            return yield* Effect.fail(invalid("This viewer may not write here."));
          yield* sql`DELETE FROM page_app_documents WHERE app_id = ${scope.appId} AND path = ${path}`;
          yield* publish(scope.appId, path);
          return null;
        }),
      );

    const decodeQuery = (raw: unknown): Effect.Effect<PageAppDbQuery, PageAppCapabilityError> =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(PageAppDbQuery)(raw),
        catch: () => invalid("Malformed query."),
      }).pipe(
        Effect.flatMap((query) =>
          isPageAppCollectionPath(query.collection) &&
          (query.where?.length ?? 0) <= PAGE_APP_DB_MAX_FILTERS
            ? Effect.succeed({
                ...query,
                collection: splitPageAppDbPath(query.collection)!.join("/"),
              })
            : Effect.fail(invalid("A collection path has an odd number of valid segments.")),
        ),
      );

    const query = (scope: PageAppDbScope, raw: unknown) =>
      storage(
        Effect.gen(function* () {
          const q = yield* decodeQuery(raw);
          const rows = yield* sql<DocumentRow>`SELECT path, doc_id, data_json, updated_at
            FROM page_app_documents WHERE app_id = ${scope.appId} AND collection_path = ${q.collection}
            ORDER BY doc_id LIMIT ${MAX_SCAN + 1}`;
          if (rows.length > MAX_SCAN)
            return yield* Effect.fail(
              new PageAppCapabilityError(
                "resource_exhausted",
                "This collection is too large to scan; narrow it.",
              ),
            );
          let docs = rows
            .filter((row) => pageAppDbAllows(scope.rules, scope.viewer, row.path, "read"))
            .map((row) => toDocument(row.path, row))
            .filter((doc) =>
              (q.where ?? []).every((filter) => pageAppDbMatches(doc.data!, filter)),
            );
          if (q.orderBy) {
            const { field, dir } = q.orderBy;
            docs = docs.toSorted((a, b) => {
              const order = compare(a.data![field], b.data![field]);
              return dir === "desc" ? -order : order;
            });
          }
          return {
            docs: docs.slice(0, q.limit ?? PAGE_APP_DB_MAX_QUERY_LIMIT),
          } satisfies PageAppDbQuerySnapshot;
        }),
      );

    const acquire = (
      scope: PageAppDbScope,
      rawPath: unknown,
      ttlMs: unknown,
      data: unknown,
      now: string,
    ) =>
      Effect.gen(function* () {
        const path = yield* requireDocPath(rawPath);
        if (!pageAppDbAllows(scope.rules, scope.viewer, path, "write"))
          return yield* Effect.fail(invalid("This viewer may not write here."));
        const ttl = typeof ttlMs === "number" && ttlMs > 0 ? Math.min(ttlMs, MAX_LEASE_MS) : 10_000;
        const at = Date.parse(now);
        const key = `${scope.appId}\u0000${path}`;
        const lease = leases.get(key);
        if (lease && lease.expiresAt > at && lease.holder !== scope.viewer.id) {
          return { acquired: false, expiresAt: new Date(lease.expiresAt).toISOString() };
        }
        const expiresAt = at + ttl;
        leases.set(key, { holder: scope.viewer.id, expiresAt });
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const existing = yield* get(scope, path);
          yield* write(scope, path, data, existing.exists ? "update" : "set", now);
        }
        return { acquired: true, expiresAt: new Date(expiresAt).toISOString() };
      });

    /** Emits the current value, then again whenever a relevant write changes it. */
    const live = <A>(
      appId: string,
      relevant: (change: PageAppDbChange) => boolean,
      read: Effect.Effect<A, PageAppCapabilityError>,
    ): Stream.Stream<A, PageAppCapabilityError> => {
      let last: string | null = null;
      return Stream.concat(
        Stream.fromEffect(read),
        Stream.fromPubSub(changes).pipe(
          Stream.filter((change) => change.appId === appId && relevant(change)),
          Stream.mapEffect(() => read),
        ),
      ).pipe(
        Stream.filter((value) => {
          const key = JSON.stringify(value);
          if (key === last) return false;
          last = key;
          return true;
        }),
      );
    };

    const watchDoc = (scope: PageAppDbScope, rawPath: unknown) =>
      Stream.unwrap(
        requireDocPath(rawPath).pipe(
          Effect.map((path) =>
            live(scope.appId, (change) => change.path === path, get(scope, path)),
          ),
        ),
      );

    const watchQuery = (scope: PageAppDbScope, raw: unknown) =>
      Stream.unwrap(
        decodeQuery(raw).pipe(
          Effect.map((q) =>
            live(scope.appId, (change) => change.collectionPath === q.collection, query(scope, q)),
          ),
        ),
      );

    const count = (appId: string) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM page_app_documents WHERE app_id = ${appId}`.pipe(
        Effect.map((rows) => rows[0]?.n ?? 0),
      );

    return { get, write, remove, query, acquire, watchDoc, watchQuery, count };
  });

export type PageAppDbStore = Effect.Success<ReturnType<typeof makePageAppDbStore>>;
