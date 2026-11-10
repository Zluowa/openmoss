// FILE: PageAppExtensionStore.ts
// Purpose: SQLite storage of the reaching-out 应用页 capabilities: per-server
// connector answers and remembered destructive tools, the audit log, page
// assets and page comments (migration PageAppCapabilities).
// Layer: Server pages/apps extensions

import type { PageAppAssetType, PageAppCommentAnchor } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type PageAppGrantState = "granted" | "denied";

export interface PageAppAuditEntry {
  readonly appId: string;
  readonly revision: number;
  readonly viewerId: string;
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  /** ok | error code | declined | blocked | cached */
  readonly outcome: string;
  readonly detail?: string | null;
  readonly durationMs?: number | null;
}

export interface PageAppAuditRow extends PageAppAuditEntry {
  readonly id: number;
  readonly createdAt: string;
}

export interface PageAppAssetRow {
  readonly id: string;
  readonly appId: string;
  readonly name: string;
  readonly mimeType: PageAppAssetType;
  readonly size: number;
  readonly sha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PageAppCommentRow {
  readonly id: string;
  readonly appId: string;
  readonly anchor: PageAppCommentAnchor;
  readonly body: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Fx<A> = Effect.Effect<A, PageAppCapabilityError>;

export interface PageAppExtensionStore {
  readonly grants: (appId: string, viewerId: string) => Fx<ReadonlyMap<string, PageAppGrantState>>;
  /** `tool` '' is the server answer; a tool name remembers a destructive confirm. */
  readonly setGrant: (input: {
    readonly appId: string;
    readonly viewerId: string;
    readonly server: string;
    readonly tool: string;
    readonly state: PageAppGrantState | null;
    readonly now: string;
  }) => Fx<void>;
  readonly audit: (entry: PageAppAuditEntry, now: string) => Fx<void>;
  readonly auditLog: (appId: string, limit: number) => Fx<ReadonlyArray<PageAppAuditRow>>;
  readonly listAssets: (appId: string) => Fx<ReadonlyArray<PageAppAssetRow>>;
  readonly assetTotals: (appId: string) => Fx<{ readonly count: number; readonly bytes: number }>;
  readonly insertAsset: (row: PageAppAssetRow, data: Uint8Array) => Fx<void>;
  readonly readAsset: (
    appId: string,
    assetId: string,
  ) => Fx<{ readonly row: PageAppAssetRow; readonly data: Uint8Array } | null>;
  readonly deleteAsset: (appId: string, assetId: string) => Fx<boolean>;
  readonly listComments: (appId: string) => Fx<ReadonlyArray<PageAppCommentRow>>;
  readonly countComments: (appId: string) => Fx<number>;
  readonly insertComment: (row: PageAppCommentRow) => Fx<void>;
  readonly updateComment: (
    appId: string,
    commentId: string,
    patch: { readonly body?: string; readonly resolvedAt?: string | null; readonly now: string },
  ) => Fx<boolean>;
  readonly deleteComment: (appId: string, commentId: string) => Fx<boolean>;
  readonly getComment: (appId: string, commentId: string) => Fx<PageAppCommentRow | null>;
  /** Everything this store keeps for a page (for callers that erase pages). */
  readonly purge: (appId: string) => Fx<void>;
}

const storage = <A, E>(effect: Effect.Effect<A, E>): Fx<A> =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof PageAppCapabilityError
        ? error
        : new PageAppCapabilityError("storage", "Moss could not save this page's data."),
    ),
  );

type AssetSqlRow = {
  asset_id: string;
  app_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_by: string;
  created_at: string;
};
type CommentSqlRow = {
  comment_id: string;
  app_id: string;
  anchor_json: string;
  body: string;
  author_id: string;
  author_name: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

const assetFromRow = (row: AssetSqlRow): PageAppAssetRow => ({
  id: row.asset_id,
  appId: row.app_id,
  name: row.name,
  mimeType: row.mime_type as PageAppAssetType,
  size: Number(row.size_bytes),
  sha256: row.sha256,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const commentFromRow = (row: CommentSqlRow): PageAppCommentRow => ({
  id: row.comment_id,
  appId: row.app_id,
  anchor: JSON.parse(row.anchor_json) as PageAppCommentAnchor,
  body: row.body,
  authorId: row.author_id,
  authorName: row.author_name,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
};

export function makePageAppExtensionStore(sql: SqlClient.SqlClient): PageAppExtensionStore {
  return {
    grants: (appId, viewerId) =>
      storage(
        sql<{ server: string; tool: string; state: PageAppGrantState }>`SELECT server, tool, state
          FROM page_app_mcp_grants WHERE app_id = ${appId} AND viewer_id = ${viewerId}`.pipe(
          Effect.map(
            (rows) => new Map(rows.map((row) => [`${row.server}\u0000${row.tool}`, row.state])),
          ),
        ),
      ),
    setGrant: ({ appId, viewerId, server, tool, state, now }) =>
      storage(
        state === null
          ? sql`DELETE FROM page_app_mcp_grants WHERE app_id = ${appId} AND viewer_id = ${viewerId}
              AND server = ${server} AND tool = ${tool}`.pipe(Effect.asVoid)
          : sql`INSERT INTO page_app_mcp_grants (app_id, viewer_id, server, tool, state, updated_at)
              VALUES (${appId}, ${viewerId}, ${server}, ${tool}, ${state}, ${now})
              ON CONFLICT (app_id, viewer_id, server, tool)
              DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`.pipe(
              Effect.asVoid,
            ),
      ),
    audit: (entry, now) =>
      storage(
        sql`INSERT INTO page_app_audit (app_id, revision, viewer_id, capability, method, target, outcome,
            detail, duration_ms, created_at)
          VALUES (${entry.appId}, ${entry.revision}, ${entry.viewerId}, ${entry.capability}, ${entry.method},
            ${entry.target.slice(0, 300)}, ${entry.outcome}, ${entry.detail?.slice(0, 500) ?? null},
            ${entry.durationMs ?? null}, ${now})`.pipe(Effect.asVoid),
      ),
    auditLog: (appId, limit) =>
      storage(
        sql<{
          audit_id: number;
          app_id: string;
          revision: number;
          viewer_id: string;
          capability: string;
          method: string;
          target: string;
          outcome: string;
          detail: string | null;
          duration_ms: number | null;
          created_at: string;
        }>`SELECT * FROM page_app_audit WHERE app_id = ${appId} ORDER BY audit_id DESC LIMIT ${limit}`.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              id: row.audit_id,
              appId: row.app_id,
              revision: row.revision,
              viewerId: row.viewer_id,
              capability: row.capability,
              method: row.method,
              target: row.target,
              outcome: row.outcome,
              detail: row.detail,
              durationMs: row.duration_ms,
              createdAt: row.created_at,
            })),
          ),
        ),
      ),
    listAssets: (appId) =>
      storage(
        sql<AssetSqlRow>`SELECT asset_id, app_id, name, mime_type, size_bytes, sha256, created_by, created_at
          FROM page_app_assets WHERE app_id = ${appId} ORDER BY created_at, asset_id`.pipe(
          Effect.map((rows) => rows.map(assetFromRow)),
        ),
      ),
    assetTotals: (appId) =>
      storage(
        sql<{
          count: number;
          bytes: number | null;
        }>`SELECT COUNT(*) AS count, SUM(size_bytes) AS bytes
          FROM page_app_assets WHERE app_id = ${appId}`.pipe(
          Effect.map((rows) => ({
            count: Number(rows[0]?.count ?? 0),
            bytes: Number(rows[0]?.bytes ?? 0),
          })),
        ),
      ),
    insertAsset: (row, data) =>
      storage(
        sql`INSERT INTO page_app_assets (asset_id, app_id, name, mime_type, size_bytes, sha256, data, created_by, created_at)
          VALUES (${row.id}, ${row.appId}, ${row.name}, ${row.mimeType}, ${row.size}, ${row.sha256}, ${data},
            ${row.createdBy}, ${row.createdAt})`.pipe(Effect.asVoid),
      ),
    readAsset: (appId, assetId) =>
      storage(
        sql<AssetSqlRow & { data: unknown }>`SELECT * FROM page_app_assets
          WHERE app_id = ${appId} AND asset_id = ${assetId}`.pipe(
          Effect.map((rows) =>
            rows[0] ? { row: assetFromRow(rows[0]), data: toBytes(rows[0].data) } : null,
          ),
        ),
      ),
    deleteAsset: (appId, assetId) =>
      storage(
        Effect.gen(function* () {
          const rows = yield* sql<{ asset_id: string }>`SELECT asset_id FROM page_app_assets
            WHERE app_id = ${appId} AND asset_id = ${assetId}`;
          if (!rows[0]) return false;
          yield* sql`DELETE FROM page_app_assets WHERE app_id = ${appId} AND asset_id = ${assetId}`;
          return true;
        }),
      ),
    listComments: (appId) =>
      storage(
        sql<CommentSqlRow>`SELECT * FROM page_app_comments WHERE app_id = ${appId}
          ORDER BY created_at, comment_id`.pipe(Effect.map((rows) => rows.map(commentFromRow))),
      ),
    countComments: (appId) =>
      storage(
        sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM page_app_comments WHERE app_id = ${appId}`.pipe(
          Effect.map((rows) => Number(rows[0]?.count ?? 0)),
        ),
      ),
    insertComment: (row) =>
      storage(
        sql`INSERT INTO page_app_comments (comment_id, app_id, anchor_json, body, author_id, author_name,
            resolved_at, created_at, updated_at)
          VALUES (${row.id}, ${row.appId}, ${JSON.stringify(row.anchor)}, ${row.body}, ${row.authorId},
            ${row.authorName}, ${row.resolvedAt}, ${row.createdAt}, ${row.updatedAt})`.pipe(
          Effect.asVoid,
        ),
      ),
    updateComment: (appId, commentId, patch) =>
      storage(
        Effect.gen(function* () {
          const rows = yield* sql<CommentSqlRow>`SELECT * FROM page_app_comments
            WHERE app_id = ${appId} AND comment_id = ${commentId}`;
          const current = rows[0];
          if (!current) return false;
          const body = patch.body ?? current.body;
          const resolvedAt =
            patch.resolvedAt === undefined ? current.resolved_at : patch.resolvedAt;
          yield* sql`UPDATE page_app_comments SET body = ${body}, resolved_at = ${resolvedAt}, updated_at = ${patch.now}
            WHERE app_id = ${appId} AND comment_id = ${commentId}`;
          return true;
        }),
      ),
    deleteComment: (appId, commentId) =>
      storage(
        Effect.gen(function* () {
          const rows = yield* sql<{ comment_id: string }>`SELECT comment_id FROM page_app_comments
            WHERE app_id = ${appId} AND comment_id = ${commentId}`;
          if (!rows[0]) return false;
          yield* sql`DELETE FROM page_app_comments WHERE app_id = ${appId} AND comment_id = ${commentId}`;
          return true;
        }),
      ),
    getComment: (appId, commentId) =>
      storage(
        sql<CommentSqlRow>`SELECT * FROM page_app_comments WHERE app_id = ${appId} AND comment_id = ${commentId}`.pipe(
          Effect.map((rows) => (rows[0] ? commentFromRow(rows[0]) : null)),
        ),
      ),
    purge: (appId) =>
      storage(
        Effect.gen(function* () {
          yield* sql`DELETE FROM page_app_mcp_grants WHERE app_id = ${appId}`;
          yield* sql`DELETE FROM page_app_audit WHERE app_id = ${appId}`;
          yield* sql`DELETE FROM page_app_assets WHERE app_id = ${appId}`;
          yield* sql`DELETE FROM page_app_comments WHERE app_id = ${appId}`;
        }),
      ),
  };
}
