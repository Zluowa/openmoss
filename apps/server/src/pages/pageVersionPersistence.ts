import type { Page } from "@moss/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { PagesServiceError, type PagesPrincipal } from "./Services/PagesService";

/** Trusted persistence primitive. Callers own authorization and the encompassing transaction. */
export type PageVersionWriter =
  | PagesPrincipal
  | { readonly kind: "guest"; readonly actorRef: string };

export const persistPageVersion = (
  sql: SqlClient.SqlClient,
  page: Page,
  content: string,
  operation: string,
  author: PageVersionWriter,
  previousRevision: number | null,
  trashBatch: string | null = null,
  richContent: string | null = null,
) =>
  Effect.gen(function* () {
    const key = page.scopeSpaceId === null ? "local-default" : `project-space:${page.scopeSpaceId}`;
    if (previousRevision === null) {
      yield* sql`INSERT INTO pages_documents (page_id, scope_key, space_id, parent_page_id, root_page_id, kind, title, icon, cover,
        revision, pinned, trashed_at, trash_batch, source_thread_id, asset_ids_json, automation_ids_json, created_at, updated_at)
        VALUES (${page.id}, ${key}, ${page.spaceId}, ${page.parentPageId}, ${page.rootPageId}, ${page.kind ?? "page"}, ${page.title}, ${page.icon ?? null}, ${page.cover ?? null},
        ${page.revision}, ${page.pinned ? 1 : 0}, ${page.trashedAt}, ${trashBatch}, ${page.sourceThreadId},
        ${JSON.stringify(page.assetIds)}, ${JSON.stringify(page.automationIds)}, ${page.createdAt}, ${page.updatedAt})`;
    } else {
      const changed =
        yield* sql`UPDATE pages_documents SET space_id = ${page.spaceId}, parent_page_id = ${page.parentPageId},
        root_page_id = ${page.rootPageId}, title = ${page.title}, icon = ${page.icon ?? null}, cover = ${page.cover ?? null}, revision = ${page.revision}, pinned = ${page.pinned ? 1 : 0},
        trashed_at = ${page.trashedAt}, trash_batch = ${trashBatch}, source_thread_id = ${page.sourceThreadId},
        asset_ids_json = ${JSON.stringify(page.assetIds)}, automation_ids_json = ${JSON.stringify(page.automationIds)}, updated_at = ${page.updatedAt}
        WHERE page_id = ${page.id} AND scope_key = ${key} AND revision = ${previousRevision} RETURNING page_id`;
      if (changed.length !== 1)
        return yield* Effect.fail(
          new PagesServiceError({ code: "conflict", message: "Page changed during this edit" }),
        );
    }
    yield* sql`INSERT INTO pages_versions (page_id, revision, page_json, content, rich_content, operation, author, author_thread_id, created_at, author_guest_ref)
      VALUES (${page.id}, ${page.revision}, ${JSON.stringify(page)}, ${content}, ${richContent}, ${operation}, ${author.kind},
        ${author.kind === "agent" ? author.threadId : null}, ${page.updatedAt}, ${author.kind === "guest" ? author.actorRef : null})`;
    if (page.spaceId !== null) {
      yield* sql`UPDATE pages_spaces SET title = ${page.title}, revision = ${page.revision}, trashed_at = ${page.trashedAt}, updated_at = ${page.updatedAt}
        WHERE space_id = ${page.spaceId} AND root_page_id = ${page.id} AND scope_key = ${key}`;
    }
  });
