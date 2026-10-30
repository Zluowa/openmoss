// FILE: 110_ProjectionSidebarProjectOrder.ts
// Purpose: Backfills ordinary project rows into the durable mixed sidebar order.
// Layer: SQLite migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 109 created the relation and copied legacy custom rows, but older
 * databases can still have ordinary projects which never had a sidebar row.
 * This migration only appends those missing identities. Existing custom rows,
 * pinned rows, and their relative order are intentionally left untouched.
 * `kind` is the durable discriminator for managed Chat/Studio containers;
 * legacy Home rows are handled by the server's workspace-aware admission path.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projects = yield* sql<{
    readonly projectId: string;
    readonly isPinned: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>`
    SELECT
      project_id AS "projectId",
      COALESCE(is_pinned, 0) AS "isPinned",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_projects
    WHERE deleted_at IS NULL
      AND COALESCE(kind, 'project') = 'project'
    ORDER BY created_at ASC, project_id ASC
  `;

  for (const project of projects) {
    const destination = project.isPinned !== 0 ? "pinned" : "default";
    const key = `project:${project.projectId}`;
    const existing = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_sidebar_order_items
      WHERE item_key = ${key}
    `;
    if ((existing[0]?.count ?? 0) > 0) continue;

    const tail = yield* sql<{ readonly nextSortOrder: number }>`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS "nextSortOrder"
      FROM projection_sidebar_order_items
      WHERE destination = ${destination}
        AND section_id IS NULL
        AND section_created_at IS NULL
    `;
    yield* sql`
      INSERT OR IGNORE INTO projection_sidebar_order_items (
        item_key, item_type, destination, section_id, section_created_at,
        sort_order, created_at, updated_at
      ) VALUES (
        ${key}, 'project', ${destination}, NULL, NULL,
        ${tail[0]?.nextSortOrder ?? 0}, ${project.createdAt}, ${project.updatedAt}
      )
    `;
  }
});
