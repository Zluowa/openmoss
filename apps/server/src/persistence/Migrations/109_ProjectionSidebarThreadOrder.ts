// FILE: 109_ProjectionSidebarThreadOrder.ts
// Purpose: Introduces the single durable sidebar placement authority.
// Layer: SQLite migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/**
 * Migration 109 is additive and intentionally leaves the 097 legacy tables
 * untouched.  Existing rows are copied once into the new relation, but the
 * state remains `legacy_import_required` until the client submits a complete,
 * hydrated seed.  This prevents a partial legacy view from becoming the new
 * authority while still preserving every old custom/project slot verbatim.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sidebar_order_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      migration_state TEXT NOT NULL CHECK (migration_state IN ('ready', 'legacy_import_required')),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sidebar_order_items (
      item_key TEXT PRIMARY KEY,
      item_type TEXT NOT NULL CHECK (item_type IN ('thread', 'project')),
      destination TEXT NOT NULL CHECK (destination IN ('pinned', 'default', 'custom')),
      section_id TEXT,
      section_created_at TEXT,
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (destination = 'custom' AND section_id IS NOT NULL AND section_created_at IS NOT NULL)
        OR
        (destination IN ('pinned', 'default') AND section_id IS NULL AND section_created_at IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_sidebar_order_container
    ON projection_sidebar_order_items(destination, section_id, section_created_at, sort_order, item_key)
  `;

  // One item may occupy one slot in one container only.  Keep the identity
  // columns nullable for the pinned/default containers, but make the slot
  // itself unique at the SQLite boundary so a corrupt projection cannot be
  // promoted by a later read-model repair.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_sidebar_order_container_unique
    ON projection_sidebar_order_items(
      destination,
      COALESCE(section_id, ''),
      COALESCE(section_created_at, ''),
      sort_order
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sidebar_archive_placements (
      thread_id TEXT PRIMARY KEY,
      destination TEXT NOT NULL CHECK (destination IN ('pinned', 'default', 'custom')),
      section_id TEXT,
      section_created_at TEXT,
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      archived_by_command_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        (destination = 'custom' AND section_id IS NOT NULL AND section_created_at IS NOT NULL)
        OR
        (destination IN ('pinned', 'default') AND section_id IS NULL AND section_created_at IS NULL)
      )
    )
  `;

  if (!(yield* columnExists(sql, "orchestration_command_receipts", "sidebar_order_revision"))) {
    yield* sql`
      ALTER TABLE orchestration_command_receipts
      ADD COLUMN sidebar_order_revision INTEGER
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "archived_sidebar_destination"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_sidebar_destination TEXT
    `;
  }

  const now = new Date().toISOString();
  const legacyItems = yield* sql<{
    readonly itemKey: string;
    readonly itemType: string;
    readonly sectionId: string;
    readonly sectionCreatedAt: string;
    readonly sortOrder: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>`
    SELECT
      items.item_key AS "itemKey",
      items.item_type AS "itemType",
      items.section_id AS "sectionId",
      sections.created_at AS "sectionCreatedAt",
      items.sort_order AS "sortOrder",
      items.created_at AS "createdAt",
      items.updated_at AS "updatedAt"
    FROM projection_sidebar_section_items AS items
    JOIN projection_sidebar_sections AS sections
      ON sections.section_id = items.section_id
    WHERE sections.deleted_at IS NULL
    ORDER BY items.section_id ASC, items.sort_order ASC, items.item_key ASC
  `;

  // Copy legacy custom rows without changing their key, incarnation, relative
  // order, or timestamp.  Legacy sort values can contain gaps, so compact each
  // section while preserving the old relative order.  Duplicate membership is
  // corrupt state and must fail the migration transaction rather than silently
  // selecting one of the competing placements.
  const copiedLegacyKeys = new Set<string>();
  const nextLegacySortBySection = new Map<string, number>();
  for (const item of legacyItems) {
    if (copiedLegacyKeys.has(item.itemKey)) {
      return yield* Effect.fail(
        new Error(`Migration 109 found duplicate sidebar membership for '${item.itemKey}'.`),
      );
    }
    copiedLegacyKeys.add(item.itemKey);
    const sortOrder = nextLegacySortBySection.get(item.sectionId) ?? 0;
    nextLegacySortBySection.set(item.sectionId, sortOrder + 1);
    yield* sql`
      INSERT OR IGNORE INTO projection_sidebar_order_items (
        item_key, item_type, destination, section_id, section_created_at,
        sort_order, created_at, updated_at
      ) VALUES (
        ${item.itemKey}, ${item.itemType}, 'custom', ${item.sectionId},
        ${item.sectionCreatedAt}, ${sortOrder}, ${item.createdAt}, ${item.updatedAt}
      )
    `;
  }

  const legacyKeys = new Set(legacyItems.map((item) => item.itemKey));
  const activeThreads = yield* sql<{
    readonly threadId: string;
    readonly isPinned: number;
    readonly parentThreadId: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>`
    SELECT
      thread_id AS "threadId",
      COALESCE(is_pinned, 0) AS "isPinned",
      parent_thread_id AS "parentThreadId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_threads
    WHERE deleted_at IS NULL AND archived_at IS NULL
    ORDER BY created_at ASC, thread_id ASC
  `;
  const nextSortByDestination = new Map<string, number>();
  for (const thread of activeThreads) {
    const key = `thread:${thread.threadId}`;
    // Descendants without an explicit legacy row inherit their root placement;
    // only roots, explicitly placed rows, and server-known pinned rows receive
    // an independent durable slot.
    if (thread.parentThreadId !== null && !legacyKeys.has(key) && thread.isPinned === 0) continue;
    if (legacyKeys.has(key)) continue;
    const destination = thread.isPinned !== 0 ? "pinned" : "default";
    const sortOrder = nextSortByDestination.get(destination) ?? 0;
    nextSortByDestination.set(destination, sortOrder + 1);
    yield* sql`
      INSERT OR IGNORE INTO projection_sidebar_order_items (
        item_key, item_type, destination, section_id, section_created_at,
        sort_order, created_at, updated_at
      ) VALUES (
        ${key}, 'thread', ${destination}, NULL, NULL,
        ${sortOrder}, ${thread.createdAt}, ${thread.updatedAt}
      )
    `;
  }

  // Preserve B03e's exact custom incarnation/order as a durable archive
  // provenance record.  Pinned/default provenance for old profiles is unknown
  // and is deliberately not invented here.
  yield* sql`
    INSERT OR IGNORE INTO projection_sidebar_archive_placements (
      thread_id, destination, section_id, section_created_at, sort_order,
      archived_by_command_id, updated_at
    )
    SELECT
      thread_id, 'custom', archived_sidebar_section_id,
      archived_sidebar_section_created_at, archived_sidebar_sort_order,
      archived_by_command_id, updated_at
    FROM projection_threads
    WHERE archived_at IS NOT NULL
      AND archived_sidebar_section_id IS NOT NULL
      AND archived_sidebar_section_created_at IS NOT NULL
      AND archived_sidebar_sort_order IS NOT NULL
  `;
  yield* sql`
    UPDATE projection_threads
    SET archived_sidebar_destination = 'custom'
    WHERE archived_at IS NOT NULL
      AND archived_sidebar_section_id IS NOT NULL
      AND archived_sidebar_section_created_at IS NOT NULL
      AND archived_sidebar_sort_order IS NOT NULL
  `;

  const legacyCount = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM projection_sidebar_section_items AS items
    JOIN projection_sidebar_sections AS sections
      ON sections.section_id = items.section_id
    WHERE sections.deleted_at IS NULL
  `;
  const activeThreadCount = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM projection_threads
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
  // Any existing active root/explicit row needs a hydrated authoritative
  // snapshot.  A default-only profile must not be treated as already ready.
  const migrationState =
    (legacyCount[0]?.count ?? 0) + (activeThreadCount[0]?.count ?? 0) > 0
      ? "legacy_import_required"
      : "ready";
  yield* sql`
    INSERT INTO projection_sidebar_order_state (singleton_id, revision, migration_state, updated_at)
    VALUES (1, 0, ${migrationState}, ${now})
    ON CONFLICT (singleton_id) DO NOTHING
  `;
});
