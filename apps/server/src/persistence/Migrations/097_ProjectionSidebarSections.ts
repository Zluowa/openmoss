// FILE: 097_ProjectionSidebarSections.ts
// Purpose: Adds durable custom sidebar sections and thread memberships.
// Layer: SQLite migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sidebar_sections (
      section_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      is_collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_sidebar_sections_active_order
    ON projection_sidebar_sections(deleted_at, sort_order, section_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sidebar_section_items (
      section_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      item_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (section_id, item_key),
      UNIQUE (item_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_sidebar_section_items_order
    ON projection_sidebar_section_items(section_id, sort_order, item_key)
  `;
});
