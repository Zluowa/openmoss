import { randomUUID } from "node:crypto";

import {
  Page,
  PageComment,
  PageId,
  PageSpace,
  PageSpaceId,
  PageVersion,
  PagesCommentsInput,
  PagesListInput,
  PagesMutateInput,
  PagesMutateResult,
  PagesReadInput,
  PagesScopeInput,
  PagesVersionsInput,
  type SpaceId,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { parsePageRichContent } from "@synara/shared/pageRichContent";

import { stableGatewayDigest } from "../../agentGateway/creationUtils";
import {
  PagesService,
  PagesServiceError,
  type PagesPrincipal,
  type PagesServiceShape,
} from "../Services/PagesService";

type Scope = SpaceId | null;
type DocumentRow = {
  page_id: string;
  scope_key: string;
  space_id: string | null;
  parent_page_id: string | null;
  root_page_id: string;
  title: string;
  revision: number;
  pinned: number;
  trashed_at: string | null;
  trash_batch: string | null;
  source_thread_id: string | null;
  asset_ids_json: string;
  automation_ids_json: string;
  created_at: string;
  updated_at: string;
};
type SpaceRow = {
  space_id: string;
  scope_key: string;
  root_page_id: string;
  title: string;
  revision: number;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
};
type VersionRow = {
  page_json: string;
  content: string;
  rich_content: string | null;
  operation: string;
  author: string;
  author_thread_id: string | null;
  created_at: string;
};
const scopeKey = (scope: Scope) => (scope === null ? "local-default" : `project-space:${scope}`);
const scopeFromKey = (key: string): Scope =>
  key === "local-default" ? null : (key.slice("project-space:".length) as SpaceId);
const failure = (code: PagesServiceError["code"], message: string, currentRevision?: number) =>
  new PagesServiceError({
    code,
    message,
    ...(currentRevision === undefined ? {} : { currentRevision }),
  });
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new PagesServiceError({
        code: "invalid",
        message: "Invalid Pages input or stored record",
        cause,
      }),
  });
const pageFromRow = (row: DocumentRow) =>
  Schema.decodeUnknownSync(Page)({
    id: row.page_id,
    scopeSpaceId: scopeFromKey(row.scope_key),
    spaceId: row.space_id,
    parentPageId: row.parent_page_id,
    rootPageId: row.root_page_id,
    title: row.title,
    revision: row.revision,
    pinned: row.pinned !== 0,
    trashedAt: row.trashed_at,
    sourceThreadId: row.source_thread_id,
    assetIds: JSON.parse(row.asset_ids_json),
    automationIds: JSON.parse(row.automation_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
const spaceFromRow = (row: SpaceRow) =>
  Schema.decodeUnknownSync(PageSpace)({
    id: row.space_id,
    scopeSpaceId: scopeFromKey(row.scope_key),
    rootPageId: row.root_page_id,
    title: row.title,
    revision: row.revision,
    trashedAt: row.trashed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
const versionFromRow = (row: VersionRow) =>
  Schema.decodeUnknownSync(PageVersion)({
    page: JSON.parse(row.page_json),
    content: row.content,
    operation: row.operation,
    ...(row.rich_content == null ? {} : { richContent: row.rich_content }),
    author: row.author,
    authorThreadId: row.author_thread_id,
    createdAt: row.created_at,
  });

/** Reuses the profile's SQLite connection. Document bodies are immutable version rows. */
export const makePagesServiceShape = (
  options: { readonly now?: () => string; readonly id?: () => string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = options.now ?? (() => new Date().toISOString());
    const newId = options.id ?? randomUUID;
    const richDocument = (input: string) =>
      Effect.try({
        try: () => parsePageRichContent(input),
        catch: (cause) =>
          failure("invalid", cause instanceof Error ? cause.message : "Invalid page richContent"),
      });
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof PagesServiceError
            ? cause
            : new PagesServiceError({
                code: "storage",
                message: "Pages storage operation failed",
                cause,
              }),
        ),
      );
    const threadScope = (threadId: ThreadId, requireUnarchived = false) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ space_id: Scope }>`SELECT p.space_id
        FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL
          AND (${requireUnarchived ? 0 : 1} = 1 OR t.archived_at IS NULL)`;
        if (!rows[0])
          return yield* Effect.fail(failure("forbidden", "The caller has no active local project"));
        return rows[0].space_id;
      });
    const authorize = (scope: Scope, principal: PagesPrincipal) =>
      Effect.gen(function* () {
        if (
          principal.kind === "agent" &&
          (yield* threadScope(principal.threadId, true)) !== scope
        ) {
          return yield* Effect.fail(
            failure("forbidden", "Pages belong to another authorization space"),
          );
        }
        if (scope !== null) {
          const rows =
            yield* sql`SELECT space_id FROM projection_spaces WHERE space_id = ${scope} AND deleted_at IS NULL`;
          if (!rows[0])
            return yield* Effect.fail(
              failure("forbidden", "The authorization space is unavailable"),
            );
        }
      });
    const document = (id: PageId, scope: Scope) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<DocumentRow>`SELECT * FROM pages_documents WHERE page_id = ${id} AND scope_key = ${scopeKey(scope)}`;
        if (!rows[0])
          return yield* Effect.fail(failure("not-found", "Page not found in this space"));
        return { page: pageFromRow(rows[0]), trashBatch: rows[0].trash_batch };
      });
    const space = (id: PageSpaceId, scope: Scope) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<SpaceRow>`SELECT * FROM pages_spaces WHERE space_id = ${id} AND scope_key = ${scopeKey(scope)}`;
        if (!rows[0]) return yield* Effect.fail(failure("not-found", "Document space not found"));
        return spaceFromRow(rows[0]);
      });
    const version = (id: PageId, revision: number) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<VersionRow>`SELECT * FROM pages_versions WHERE page_id = ${id} AND revision = ${revision}`;
        if (!rows[0]) return yield* Effect.fail(failure("not-found", "Page version not found"));
        return versionFromRow(rows[0]);
      });
    const active = (page: Page) =>
      page.trashedAt === null
        ? Effect.void
        : Effect.fail(failure("invalid", "Restore this page before editing it"));
    const rootSpace = (page: Page) =>
      Effect.gen(function* () {
        if (page.spaceId === null) return undefined;
        const existing = yield* space(page.spaceId, page.scopeSpaceId);
        return existing.rootPageId === page.id ? existing : undefined;
      });
    const checkReferences = (
      value: Pick<Page, "sourceThreadId" | "assetIds" | "automationIds">,
      scope: Scope,
      principal: PagesPrincipal,
    ) =>
      Effect.gen(function* () {
        if (value.sourceThreadId !== null && (yield* threadScope(value.sourceThreadId)) !== scope) {
          return yield* Effect.fail(
            failure("forbidden", "Source conversation belongs to another space"),
          );
        }
        for (const id of new Set(value.assetIds)) {
          const rows = yield* sql<{
            origination_thread_id: ThreadId | null;
          }>`SELECT origination_thread_id FROM library_items WHERE item_id = ${id} AND trashed_at IS NULL`;
          if (!rows[0])
            return yield* Effect.fail(failure("not-found", "Library attachment is unavailable"));
          const origin = rows[0].origination_thread_id;
          if (origin === null) {
            if (principal.kind !== "local-user")
              return yield* Effect.fail(
                failure("forbidden", "Only the local user may attach an unscoped Library asset"),
              );
          } else if ((yield* threadScope(origin)) !== scope) {
            return yield* Effect.fail(
              failure("forbidden", "Library attachment belongs to another space"),
            );
          }
        }
        for (const id of new Set(value.automationIds)) {
          const rows = yield* sql<{
            space_id: Scope;
          }>`SELECT p.space_id FROM automation_definitions a
            JOIN projection_projects p ON p.project_id = a.project_id
            WHERE a.automation_id = ${id} AND a.archived_at IS NULL AND p.deleted_at IS NULL`;
          if (!rows[0] || rows[0].space_id !== scope)
            return yield* Effect.fail(
              failure("forbidden", "Automation is unavailable in this space"),
            );
        }
      });
    const save = (
      page: Page,
      content: string,
      operation: string,
      principal: PagesPrincipal,
      previousRevision: number | null,
      trashBatch: string | null = null,
      richContent: string | null = null,
    ) =>
      Effect.gen(function* () {
        const key = scopeKey(page.scopeSpaceId);
        if (previousRevision === null) {
          yield* sql`INSERT INTO pages_documents (page_id, scope_key, space_id, parent_page_id, root_page_id, title,
            revision, pinned, trashed_at, trash_batch, source_thread_id, asset_ids_json, automation_ids_json, created_at, updated_at)
            VALUES (${page.id}, ${key}, ${page.spaceId}, ${page.parentPageId}, ${page.rootPageId}, ${page.title},
            ${page.revision}, ${page.pinned ? 1 : 0}, ${page.trashedAt}, ${trashBatch}, ${page.sourceThreadId},
            ${JSON.stringify(page.assetIds)}, ${JSON.stringify(page.automationIds)}, ${page.createdAt}, ${page.updatedAt})`;
        } else {
          const changed =
            yield* sql`UPDATE pages_documents SET space_id = ${page.spaceId}, parent_page_id = ${page.parentPageId},
            root_page_id = ${page.rootPageId}, title = ${page.title}, revision = ${page.revision}, pinned = ${page.pinned ? 1 : 0},
            trashed_at = ${page.trashedAt}, trash_batch = ${trashBatch}, source_thread_id = ${page.sourceThreadId},
            asset_ids_json = ${JSON.stringify(page.assetIds)}, automation_ids_json = ${JSON.stringify(page.automationIds)}, updated_at = ${page.updatedAt}
            WHERE page_id = ${page.id} AND scope_key = ${key} AND revision = ${previousRevision} RETURNING page_id`;
          if (changed.length !== 1)
            return yield* Effect.fail(failure("conflict", "Page changed during this edit"));
        }
        yield* sql`INSERT INTO pages_versions (page_id, revision, page_json, content, rich_content, operation, author, author_thread_id, created_at)
          VALUES (${page.id}, ${page.revision}, ${JSON.stringify(page)}, ${content}, ${richContent}, ${operation}, ${principal.kind},
            ${principal.kind === "agent" ? principal.threadId : null}, ${page.updatedAt})`;
        if (page.spaceId !== null) {
          yield* sql`UPDATE pages_spaces SET title = ${page.title}, revision = ${page.revision}, trashed_at = ${page.trashedAt}, updated_at = ${page.updatedAt}
            WHERE space_id = ${page.spaceId} AND root_page_id = ${page.id} AND scope_key = ${key}`;
        }
      });
    const subtree = (page: Page) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<DocumentRow>`SELECT * FROM pages_documents WHERE scope_key = ${scopeKey(page.scopeSpaceId)}`;
        const children = new Map<string, DocumentRow[]>();
        for (const row of rows)
          if (row.parent_page_id !== null) {
            const siblings = children.get(row.parent_page_id) ?? [];
            siblings.push(row);
            children.set(row.parent_page_id, siblings);
          }
        const result: { page: Page; trashBatch: string | null }[] = [
          yield* document(page.id, page.scopeSpaceId),
        ];
        const visited = new Set<string>([page.id]);
        for (let index = 0; index < result.length; index++) {
          for (const row of children.get(result[index]!.page.id) ?? []) {
            if (visited.has(row.page_id))
              return yield* Effect.fail(failure("cycle", "Invalid page tree cycle"));
            visited.add(row.page_id);
            result.push({ page: pageFromRow(row), trashBatch: row.trash_batch });
          }
        }
        return result;
      });
    const targetParent = (
      scope: Scope,
      targetSpaceId: PageSpaceId | null,
      parentId: PageId | null,
    ) =>
      Effect.gen(function* () {
        let targetSpace: PageSpace | undefined;
        if (targetSpaceId !== null) {
          targetSpace = yield* space(targetSpaceId, scope);
          if (targetSpace.trashedAt !== null)
            return yield* Effect.fail(failure("invalid", "Document space is in trash"));
        }
        const effectiveParentId = parentId ?? targetSpace?.rootPageId ?? null;
        const parent =
          effectiveParentId === null ? undefined : (yield* document(effectiveParentId, scope)).page;
        if (parent) {
          yield* active(parent);
          if (parent.spaceId !== targetSpaceId)
            return yield* Effect.fail(
              failure("invalid", "Parent page belongs to a different document space"),
            );
        }
        return parent;
      });

    const spaces: PagesServiceShape["spaces"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesScopeInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          const rows =
            yield* sql<SpaceRow>`SELECT * FROM pages_spaces WHERE scope_key = ${scopeKey(input.scopeSpaceId)} ORDER BY created_at, space_id`;
          return { spaces: rows.map(spaceFromRow) };
        }),
      );
    const list: PagesServiceShape["list"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesListInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          const rows = input.includeTrashed
            ? yield* sql<DocumentRow>`SELECT * FROM pages_documents WHERE scope_key = ${scopeKey(input.scopeSpaceId)} ORDER BY pinned DESC, updated_at DESC, page_id`
            : yield* sql<DocumentRow>`SELECT * FROM pages_documents WHERE scope_key = ${scopeKey(input.scopeSpaceId)} AND trashed_at IS NULL ORDER BY pinned DESC, updated_at DESC, page_id`;
          return { pages: rows.map(pageFromRow) };
        }),
      );
    const read: PagesServiceShape["read"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesReadInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          const current = yield* document(input.pageId, input.scopeSpaceId);
          const record = yield* version(input.pageId, input.revision ?? current.page.revision);
          return {
            page: record.page,
            content: record.content,
            ...(record.richContent === undefined ? {} : { richContent: record.richContent }),
          };
        }),
      );
    const versions: PagesServiceShape["versions"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesVersionsInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          yield* document(input.pageId, input.scopeSpaceId);
          const rows =
            yield* sql<VersionRow>`SELECT * FROM pages_versions WHERE page_id = ${input.pageId}
        AND revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER} ORDER BY revision DESC LIMIT ${input.limit ?? 30}`;
          return { versions: rows.map(versionFromRow) };
        }),
      );
    const comments: PagesServiceShape["comments"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesCommentsInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          yield* document(input.pageId, input.scopeSpaceId);
          const rows = yield* sql<{
            comment_id: string;
            page_id: string;
            revision: number;
            content: string;
            author: string;
            author_thread_id: string | null;
            created_at: string;
          }>`SELECT * FROM pages_comments WHERE page_id = ${input.pageId} ORDER BY revision, comment_id`;
          return {
            comments: rows.map((row) =>
              Schema.decodeUnknownSync(PageComment)({
                id: row.comment_id,
                pageId: row.page_id,
                revision: row.revision,
                content: row.content,
                author: row.author,
                authorThreadId: row.author_thread_id,
                createdAt: row.created_at,
              }),
            ),
          };
        }),
      );
    const mutate: PagesServiceShape["mutate"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesMutateInput, raw);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* authorize(input.scopeSpaceId, principal);
              const key = scopeKey(input.scopeSpaceId);
              const actorKey =
                principal.kind === "local-user" ? "local-user" : `thread:${principal.threadId}`;
              const fingerprint = stableGatewayDigest(input, 64);
              const prior = yield* sql<{
                fingerprint: string;
                result_json: string;
              }>`SELECT fingerprint, result_json FROM pages_requests
          WHERE scope_key = ${key} AND actor_key = ${actorKey} AND request_id = ${input.requestId}`;
              if (prior[0]) {
                if (prior[0].fingerprint !== fingerprint)
                  return yield* Effect.fail(
                    failure("conflict", "This request id was used for a different Pages mutation"),
                  );
                return yield* decode(PagesMutateResult, JSON.parse(prior[0].result_json));
              }
              const timestamp = now();
              let result: PagesMutateResult;
              if (input.op === "create-space" || input.op === "create") {
                const rich =
                  typeof input.richContent === "string"
                    ? yield* richDocument(input.richContent)
                    : undefined;
                const content = rich?.content ?? input.content ?? "";
                const id = PageId.makeUnsafe(newId());
                const createdSpaceId =
                  input.op === "create-space" ? PageSpaceId.makeUnsafe(newId()) : input.spaceId;
                const parent =
                  input.op === "create-space"
                    ? undefined
                    : yield* targetParent(input.scopeSpaceId, input.spaceId, input.parentPageId);
                const page: Page = {
                  id,
                  scopeSpaceId: input.scopeSpaceId,
                  spaceId: createdSpaceId,
                  parentPageId: parent?.id ?? null,
                  rootPageId: parent?.rootPageId ?? id,
                  title: input.title,
                  revision: 1,
                  pinned: false,
                  trashedAt: null,
                  sourceThreadId:
                    input.op === "create"
                      ? (input.sourceThreadId ??
                        (principal.kind === "agent" ? principal.threadId : null))
                      : null,
                  assetIds: input.op === "create" ? [...new Set(input.assetIds ?? [])] : [],
                  automationIds:
                    input.op === "create" ? [...new Set(input.automationIds ?? [])] : [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                };
                yield* checkReferences(page, input.scopeSpaceId, principal);
                if (input.op === "create-space") {
                  yield* sql`INSERT INTO pages_spaces (space_id, scope_key, root_page_id, title, revision, trashed_at, created_at, updated_at)
              VALUES (${createdSpaceId}, ${key}, ${id}, ${page.title}, 1, NULL, ${timestamp}, ${timestamp})`;
                }
                yield* save(
                  page,
                  content,
                  input.op,
                  principal,
                  null,
                  null,
                  rich?.richContent ?? null,
                );
                result = {
                  page,
                  content,
                  ...(rich ? { richContent: rich.richContent } : {}),
                  affectedPageIds: [id],
                  ...(input.op === "create-space" && createdSpaceId !== null
                    ? { space: yield* space(createdSpaceId, input.scopeSpaceId) }
                    : {}),
                };
              } else {
                const current = yield* document(input.pageId, input.scopeSpaceId);
                const original = current.page;
                if (original.revision !== input.expectedRevision)
                  return yield* Effect.fail(
                    failure("conflict", "Page changed; reload before saving", original.revision),
                  );
                const previous = yield* version(original.id, original.revision);
                const ownedSpace = yield* rootSpace(original);
                let next = { ...original, revision: original.revision + 1, updatedAt: timestamp };
                let content = previous.content;
                let richContent = previous.richContent;
                let batch = current.trashBatch;
                let comment: PageComment | undefined;
                const affected: PageId[] = [];
                if (input.op === "restore" || input.op === "restore-space") {
                  if ((input.op === "restore-space") !== (ownedSpace !== undefined))
                    return yield* Effect.fail(
                      failure("invalid", "Use the document-space action for its root page"),
                    );
                  if (original.trashedAt === null || batch === null)
                    return yield* Effect.fail(failure("invalid", "Page is not in trash"));
                  if (original.parentPageId !== null)
                    yield* active(
                      (yield* document(original.parentPageId, input.scopeSpaceId)).page,
                    );
                  const tree = yield* subtree(original);
                  for (const item of tree)
                    if (item.trashBatch === batch) {
                      const restored = {
                        ...item.page,
                        trashedAt: null,
                        revision: item.page.revision + 1,
                        updatedAt: timestamp,
                      };
                      const oldVersion = yield* version(item.page.id, item.page.revision);
                      yield* save(
                        restored,
                        oldVersion.content,
                        input.op,
                        principal,
                        item.page.revision,
                        null,
                        oldVersion.richContent ?? null,
                      );
                      affected.push(restored.id);
                      if (restored.id === original.id) next = restored;
                    }
                } else {
                  yield* active(original);
                  if (input.op === "trash" || input.op === "trash-space") {
                    if ((input.op === "trash-space") !== (ownedSpace !== undefined))
                      return yield* Effect.fail(
                        failure("invalid", "Use the document-space action for its root page"),
                      );
                    batch = newId();
                    for (const item of yield* subtree(original))
                      if (item.page.trashedAt === null) {
                        const trashed = {
                          ...item.page,
                          trashedAt: timestamp,
                          revision: item.page.revision + 1,
                          updatedAt: timestamp,
                        };
                        const oldVersion = yield* version(item.page.id, item.page.revision);
                        yield* save(
                          trashed,
                          oldVersion.content,
                          input.op,
                          principal,
                          item.page.revision,
                          batch,
                          oldVersion.richContent ?? null,
                        );
                        affected.push(trashed.id);
                        if (trashed.id === original.id) next = trashed;
                      }
                  } else if (input.op === "move") {
                    if (ownedSpace)
                      return yield* Effect.fail(
                        failure("invalid", "A document-space root cannot be moved"),
                      );
                    const parent = yield* targetParent(
                      input.scopeSpaceId,
                      input.spaceId,
                      input.parentPageId,
                    );
                    const tree = yield* subtree(original);
                    if (parent && tree.some((item) => item.page.id === parent.id))
                      return yield* Effect.fail(
                        failure("cycle", "A page cannot be moved into its own descendants"),
                      );
                    for (const item of tree) {
                      const moved = {
                        ...item.page,
                        spaceId: input.spaceId,
                        rootPageId: parent?.rootPageId ?? original.id,
                        parentPageId:
                          item.page.id === original.id
                            ? (parent?.id ?? null)
                            : item.page.parentPageId,
                        revision: item.page.revision + 1,
                        updatedAt: timestamp,
                      };
                      const oldVersion = yield* version(item.page.id, item.page.revision);
                      yield* save(
                        moved,
                        oldVersion.content,
                        input.op,
                        principal,
                        item.page.revision,
                        item.trashBatch,
                        oldVersion.richContent ?? null,
                      );
                      affected.push(moved.id);
                      if (moved.id === original.id) next = moved;
                    }
                  } else {
                    if (input.op === "update") {
                      if (
                        previous.richContent !== undefined &&
                        input.content !== undefined &&
                        input.richContent === undefined
                      ) {
                        return yield* Effect.fail(
                          failure(
                            "invalid",
                            "This is a rich page. Preserve its structure with richContent, or explicitly send richContent: null to convert to Markdown.",
                          ),
                        );
                      }
                      next = {
                        ...next,
                        ...(input.title === undefined ? {} : { title: input.title }),
                        ...(input.sourceThreadId === undefined
                          ? {}
                          : { sourceThreadId: input.sourceThreadId }),
                        ...(input.assetIds === undefined
                          ? {}
                          : { assetIds: [...new Set(input.assetIds)] }),
                        ...(input.automationIds === undefined
                          ? {}
                          : { automationIds: [...new Set(input.automationIds)] }),
                      };
                      if (typeof input.richContent === "string") {
                        const rich = yield* richDocument(input.richContent);
                        richContent = rich.richContent;
                        content = rich.content;
                      } else if (input.richContent === null) {
                        richContent = undefined;
                        content = input.content ?? content;
                      } else content = input.content ?? content;
                      // Existing user-attached local assets remain usable; changing
                      // references must pass the same scope checks as initial attach.
                      yield* checkReferences(
                        {
                          sourceThreadId: input.sourceThreadId ?? null,
                          assetIds: input.assetIds ?? [],
                          automationIds: input.automationIds ?? [],
                        },
                        input.scopeSpaceId,
                        principal,
                      );
                    } else if (input.op === "pin") next = { ...next, pinned: input.pinned };
                    else if (input.op === "restore-version") {
                      const old = yield* version(original.id, input.revision);
                      // Restore the document, not old tree placement or automation links.
                      next = { ...next, title: old.page.title };
                      content = old.content;
                      richContent = old.richContent;
                    } else if (input.op === "comment") {
                      comment = {
                        id: newId(),
                        pageId: original.id,
                        revision: next.revision,
                        content: input.content,
                        author: principal.kind,
                        authorThreadId: principal.kind === "agent" ? principal.threadId : null,
                        createdAt: timestamp,
                      };
                      yield* sql`INSERT INTO pages_comments (comment_id, page_id, revision, content, author, author_thread_id, created_at)
                  VALUES (${comment.id}, ${comment.pageId}, ${comment.revision}, ${comment.content}, ${comment.author}, ${comment.authorThreadId}, ${timestamp})`;
                    }
                    yield* save(
                      next,
                      content,
                      input.op,
                      principal,
                      original.revision,
                      batch,
                      richContent ?? null,
                    );
                    affected.push(next.id);
                  }
                }
                result = {
                  page: next,
                  content,
                  ...(richContent === undefined ? {} : { richContent }),
                  affectedPageIds: affected,
                  ...(ownedSpace && next.spaceId !== null
                    ? { space: yield* space(next.spaceId, input.scopeSpaceId) }
                    : {}),
                  ...(comment ? { comment } : {}),
                };
              }
              yield* sql`INSERT INTO pages_requests (scope_key, actor_key, request_id, fingerprint, result_json, created_at)
          VALUES (${key}, ${actorKey}, ${input.requestId}, ${fingerprint}, ${JSON.stringify(result)}, ${timestamp})`;
              return result;
            }),
          );
        }),
      );
    return { spaces, list, read, versions, comments, mutate } satisfies PagesServiceShape;
  });

export const PagesServiceLive = Layer.effect(PagesService, makePagesServiceShape());
