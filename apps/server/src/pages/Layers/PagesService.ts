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
  PagesOutputStateInput,
  PagesOutputsInput,
  PagesReadInput,
  PagesScopeInput,
  PagesVersionsInput,
  SPACE_TRASH_RETENTION_DAYS,
  type SpaceId,
  SpaceOutput,
  type ThreadId,
} from "@moss/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { parsePageRichContent } from "@moss/shared/pageRichContent";

import { persistPageVersion } from "../pageVersionPersistence";
import { readContributors } from "../pageVersionContributors";
import { pageAccessEpoch } from "../pageAccessEpoch";
import { changingSpaceMembership } from "../spaceSyncMembership";

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
  kind: string;
  title: string;
  icon: string | null;
  cover: string | null;
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
  icon: string | null;
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
  author_guest_ref: string | null;
  contributors_json: string | null;
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
    ...(row.kind === "page" ? {} : { kind: row.kind }),
    title: row.title,
    ...(row.icon == null ? {} : { icon: row.icon }),
    ...(row.cover == null ? {} : { cover: row.cover }),
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
    icon: row.icon,
    revision: row.revision,
    trashedAt: row.trashed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
const versionFromRow = (row: VersionRow) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(PageVersion)({
        page: JSON.parse(row.page_json),
        content: row.content,
        operation: row.operation,
        ...(row.rich_content == null ? {} : { richContent: row.rich_content }),
        author: row.author,
        authorThreadId: row.author_thread_id,
        ...(row.author_guest_ref == null ? {} : { authorGuestRef: row.author_guest_ref }),
        ...(row.contributors_json == null
          ? {}
          : { contributors: readContributors(row.contributors_json) }),
        createdAt: row.created_at,
      }),
    catch: (cause) =>
      new PagesServiceError({ code: "storage", message: "Invalid stored Page version", cause }),
  });

const OUTPUT_TURN_LIMIT = 2_000;
const OUTPUT_ID_SEPARATOR = "|";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const FILE_EXTENSIONS = new Set([
  "html",
  "htm",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "csv",
  "tsv",
  "zip",
]);
/** Which chat outputs the Space picks up: documents people open, not source code. */
export const spaceOutputKind = (path: string): "image" | "file" | null => {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!extension) return null;
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return FILE_EXTENSIONS.has(extension) ? "file" : null;
};
export const spaceOutputId = (threadId: string, path: string) =>
  `${threadId}${OUTPUT_ID_SEPARATOR}${path}`;
const parseCheckpointFiles = (json: string): { path: string; kind: string }[] => {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is { path: string; kind: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { kind?: unknown }).kind === "string",
    );
  } catch {
    return [];
  }
};

/** Reuses the profile's SQLite connection. Document bodies are immutable version rows. */
export const makePagesServiceShape = (
  options: { readonly now?: () => string; readonly id?: () => string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectionEpoch = pageAccessEpoch(sql);
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
        const rows = yield* sql<VersionRow>`SELECT v.*, c.contributors_json FROM pages_versions v
            LEFT JOIN pages_version_contributors c USING(page_id,revision) WHERE v.page_id = ${id} AND v.revision = ${revision}`;
        if (!rows[0]) return yield* Effect.fail(failure("not-found", "Page version not found"));
        return yield* versionFromRow(rows[0]);
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
      persistPageVersion(
        sql,
        page,
        content,
        operation,
        principal,
        previousRevision,
        trashBatch,
        richContent,
      );
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

    /** Deletes pages for good: their versions, comments and a space they are the root of. */
    const purgePages = (ids: readonly PageId[], scope: Scope) =>
      Effect.gen(function* () {
        const key = scopeKey(scope);
        for (const id of ids) {
          yield* sql`DELETE FROM pages_comments WHERE page_id = ${id}`;
          yield* sql`DELETE FROM pages_versions WHERE page_id = ${id}`;
          yield* sql`DELETE FROM pages_spaces WHERE root_page_id = ${id} AND scope_key = ${key}`;
          yield* sql`DELETE FROM pages_documents WHERE page_id = ${id} AND scope_key = ${key}`;
        }
      });
    const trashCutoff = () =>
      new Date(Date.parse(now()) - SPACE_TRASH_RETENTION_DAYS * 86_400_000).toISOString();
    /**
     * Trash keeps items for SPACE_TRASH_RETENTION_DAYS. A local profile has no background job,
     * so the sweep runs when the scope is listed; it is one indexed read when nothing expired.
     */
    const sweepExpiredTrash = (scope: Scope) =>
      Effect.gen(function* () {
        const cutoff = trashCutoff();
        const key = scopeKey(scope);
        const expired = yield* sql<{ page_id: PageId }>`SELECT page_id FROM pages_documents
          WHERE scope_key = ${key} AND trashed_at IS NOT NULL AND trashed_at < ${cutoff}`;
        if (expired.length > 0)
          yield* sql.withTransaction(
            purgePages(
              expired.map((row) => row.page_id),
              scope,
            ),
          );
        yield* sql`UPDATE pages_output_states SET purged_at = ${now()}
          WHERE scope_key = ${key} AND purged_at IS NULL AND trashed_at IS NOT NULL AND trashed_at < ${cutoff}`;
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
          yield* sweepExpiredTrash(input.scopeSpaceId);
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
          const rows = input.summaryOnly
            ? yield* sql<VersionRow>`SELECT v.page_json, '' AS content, NULL AS rich_content, v.operation, v.author,
                v.author_thread_id, v.author_guest_ref, v.created_at, c.contributors_json FROM pages_versions v
                LEFT JOIN pages_version_contributors c USING(page_id,revision) WHERE v.page_id = ${input.pageId}
                AND v.revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER} ORDER BY v.revision DESC LIMIT ${input.limit ?? 30}`
            : yield* sql<VersionRow>`SELECT v.*, c.contributors_json FROM pages_versions v
                LEFT JOIN pages_version_contributors c USING(page_id,revision) WHERE v.page_id = ${input.pageId}
                AND v.revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER} ORDER BY v.revision DESC LIMIT ${input.limit ?? 30}`;
          return { versions: yield* Effect.forEach(rows, versionFromRow) };
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
          let previousSpace: PageSpaceId | null = null;
          const write = sql.withTransaction(
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
                  ...(input.op === "create" && input.kind !== undefined && input.kind !== "page"
                    ? { kind: input.kind }
                    : {}),
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
                if (["move", "trash", "trash-space", "purge"].includes(input.op))
                  previousSpace = original.spaceId;
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
                } else if (input.op === "purge") {
                  if (original.trashedAt === null)
                    return yield* Effect.fail(
                      failure("invalid", "Only trashed pages can be purged"),
                    );
                  // Everything below a trashed page is in trash too, whichever batch put it there.
                  const tree = yield* subtree(original);
                  yield* purgePages(
                    tree.map((item) => item.page.id),
                    input.scopeSpaceId,
                  );
                  for (const item of tree) affected.push(item.page.id);
                } else if (input.op === "space-icon") {
                  if (!ownedSpace)
                    return yield* Effect.fail(
                      failure("invalid", "Only a document-space root page carries its icon"),
                    );
                  yield* sql`UPDATE pages_spaces SET icon = ${input.icon}, updated_at = ${timestamp}
                    WHERE space_id = ${ownedSpace.id} AND scope_key = ${key}`;
                  next = original;
                  affected.push(original.id);
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
                    else if (input.op === "page-appearance") {
                      next = {
                        ...next,
                        ...(input.icon === undefined ? {} : { icon: input.icon }),
                        ...(input.cover === undefined ? {} : { cover: input.cover }),
                      };
                    } else if (input.op === "restore-version") {
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
                  ...(ownedSpace && next.spaceId !== null && input.op !== "purge"
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
          // Body/structure changes can alter a published baseline or inherited access.
          // Keep both ends outside the actual SQLite transaction, including rollback.
          const changesAccess = !["comment", "pin", "space-icon", "page-appearance"].includes(
            input.op,
          );
          const result = yield* changesAccess ? projectionEpoch.around(write) : write;
          // An invalid action, rolled-back transaction or idempotent replay must
          // not disconnect a room. Announce only an actual committed departure.
          if (
            previousSpace !== null &&
            (input.op !== "move" || result.page.spaceId !== previousSpace)
          )
            changingSpaceMembership(sql, input.scopeSpaceId, previousSpace);
          return result;
        }),
      );
    const outputs: PagesServiceShape["outputs"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesOutputsInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          const key = scopeKey(input.scopeSpaceId);
          const turns = yield* sql<{
            thread_id: ThreadId;
            thread_title: string;
            root: string;
            files_json: string;
            at: string;
          }>`SELECT t.thread_id, t.title AS thread_title,
              COALESCE(NULLIF(t.worktree_path, ''), p.workspace_root) AS root,
              tu.checkpoint_files_json AS files_json,
              COALESCE(tu.completed_at, tu.requested_at) AS at
            FROM projection_turns tu
            JOIN projection_threads t ON t.thread_id = tu.thread_id
            JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
              AND p.space_id IS ${input.scopeSpaceId}
              AND tu.checkpoint_files_json <> '[]'
            ORDER BY at DESC LIMIT ${OUTPUT_TURN_LIMIT}`;
          const states = new Map(
            (yield* sql<{
              output_key: string;
              trashed_at: string | null;
              purged_at: string | null;
            }>`SELECT output_key, trashed_at, purged_at FROM pages_output_states WHERE scope_key = ${key}`).map(
              (row) => [row.output_key, row] as const,
            ),
          );
          const seen = new Set<string>();
          const result: SpaceOutput[] = [];
          for (const turn of turns) {
            for (const file of parseCheckpointFiles(turn.files_json)) {
              const kind = spaceOutputKind(file.path);
              if (kind === null || file.kind === "deleted") continue;
              const id = spaceOutputId(turn.thread_id, file.path);
              if (seen.has(id)) continue;
              seen.add(id);
              const state = states.get(id);
              if (state?.purged_at) continue;
              const trashedAt = state?.trashed_at ?? null;
              if (trashedAt !== null && !input.includeTrashed) continue;
              result.push(
                Schema.decodeUnknownSync(SpaceOutput)({
                  id,
                  kind,
                  title: file.path.split(/[\\/]/).pop() || file.path,
                  path: file.path,
                  workspaceRoot: turn.root,
                  threadId: turn.thread_id,
                  threadTitle: turn.thread_title,
                  updatedAt: turn.at,
                  trashedAt,
                }),
              );
            }
          }
          return { outputs: result };
        }),
      );
    const outputState: PagesServiceShape["outputState"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PagesOutputStateInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          const separator = input.outputId.indexOf(OUTPUT_ID_SEPARATOR);
          if (separator <= 0) return yield* Effect.fail(failure("invalid", "Unknown Space output"));
          const threadId = input.outputId.slice(0, separator) as ThreadId;
          if ((yield* threadScope(threadId)) !== input.scopeSpaceId)
            return yield* Effect.fail(failure("forbidden", "Output belongs to another space"));
          const key = scopeKey(input.scopeSpaceId);
          const timestamp = now();
          const existing = yield* sql<{
            trashed_at: string | null;
          }>`SELECT trashed_at FROM pages_output_states WHERE scope_key = ${key} AND output_key = ${input.outputId}`;
          const trashedAt =
            input.action === "restore"
              ? null
              : input.action === "purge"
                ? (existing[0]?.trashed_at ?? timestamp)
                : timestamp;
          const purgedAt = input.action === "purge" ? timestamp : null;
          yield* sql`INSERT INTO pages_output_states (scope_key, output_key, trashed_at, purged_at, updated_at)
            VALUES (${key}, ${input.outputId}, ${trashedAt}, ${purgedAt}, ${timestamp})
            ON CONFLICT (scope_key, output_key) DO UPDATE SET trashed_at = excluded.trashed_at,
              purged_at = excluded.purged_at, updated_at = excluded.updated_at`;
        }),
      );
    return {
      spaces,
      list,
      read,
      versions,
      comments,
      mutate,
      outputs,
      outputState,
    } satisfies PagesServiceShape;
  });

export const PagesServiceLive = Layer.effect(PagesService, makePagesServiceShape());
