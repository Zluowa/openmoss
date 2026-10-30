// FILE: 108_ProjectionThreadsArchiveSidebarPlacement.ts
// Purpose: Persists archive cohorts and exact custom-sidebar placement snapshots.
// Layer: SQLite migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "archived_by_command_id"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_by_command_id TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "archived_sidebar_section_id"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_sidebar_section_id TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "archived_sidebar_section_created_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_sidebar_section_created_at TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "archived_sidebar_sort_order"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_sidebar_sort_order INTEGER
    `;
  }

  // Legacy archive rows have no placement to recover honestly, but a persisted
  // archive event still proves the command cohort. Keep the command id from
  // the newest archive event; if it is null, leave the row unproven instead
  // of reaching back to an older cohort.
  yield* sql`
    UPDATE projection_threads
    SET archived_by_command_id = (
      SELECT event.command_id
      FROM orchestration_events AS event
      WHERE event.aggregate_kind = 'thread'
        AND event.stream_id = projection_threads.thread_id
        AND event.event_type = 'thread.archived'
      ORDER BY event.sequence DESC
      LIMIT 1
    )
    WHERE archived_at IS NOT NULL
      AND archived_by_command_id IS NULL
  `;
});
