import { randomUUID } from "node:crypto";

import {
  PAGE_DRAFT_LIMITS,
  PageDraft,
  PageDraftsListInput,
  PageDraftsMutateInput,
  type PageDraftOp,
  type SpaceId,
} from "@moss/contracts";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PagesService, PagesServiceError, type PagesPrincipal } from "../../Services/PagesService";
import { PageRealtimeService } from "../../realtime/PageRealtimeService";
import { PageDraftsService, type PageDraftsServiceShape } from "../Services/PageDraftsService";

type DraftRow = {
  draft_id: string;
  page_id: string;
  base_revision: number;
  kind: string;
  summary: string | null;
  ops_json: string;
  status: string;
  author: string;
  author_thread_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_revision: number | null;
};

/** Open proposals one page keeps before an agent must wait for the person to review. */
export const MAX_OPEN_PAGE_DRAFTS = 50;

const scopeKey = (scope: SpaceId | null) =>
  scope === null ? "local-default" : `project-space:${scope}`;
const failure = (code: PagesServiceError["code"], message: string) =>
  new PagesServiceError({ code, message });
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new PagesServiceError({ code: "invalid", message: "Invalid page draft input", cause }),
  });
const draftFromRow = (row: DraftRow) =>
  Schema.decodeUnknownSync(PageDraft)({
    id: row.draft_id,
    pageId: row.page_id,
    baseRevision: row.base_revision,
    kind: row.kind,
    summary: row.summary,
    ops: JSON.parse(row.ops_json),
    status: row.status,
    author: row.author,
    authorThreadId: row.author_thread_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedRevision: row.resolved_revision,
  });

/** Every op carries one body (except delete), and a rich body is a legal Plate node array. */
export function validatePageDraftOps(ops: readonly PageDraftOp[]): void {
  let total = 0;
  const deck = ops.filter((op) => op.kind === "deck").length;
  if (deck > 0 && deck !== ops.length)
    throw new Error("A slides draft holds deck changes only; send block changes separately");
  if (deck > 1) throw new Error("Send one deck change per draft");
  for (const op of ops) {
    if (op.kind === "delete") continue;
    if (op.kind === "deck") {
      // The shape of each deck operation is checked against the deck by the slides service.
      let parsed: unknown;
      try {
        parsed = JSON.parse(op.deckOps);
      } catch {
        throw new Error("deckOps must be a JSON array of deck operations");
      }
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 200)
        throw new Error("deckOps must hold 1-200 deck operations");
      total += op.deckOps.length;
      continue;
    }
    if ((op.markdown === undefined) === (op.richContent === undefined))
      throw new Error("Each draft change needs exactly one of markdown or richContent");
    if (op.kind === "insert" && op.atStart === true && op.afterBlockId !== undefined)
      throw new Error("An insert is either atStart or afterBlockId, not both");
    const body = op.markdown ?? op.richContent ?? "";
    total += body.length;
    if (op.richContent !== undefined) {
      const parsed = parsePageRichContent(op.richContent);
      if (parsed.nodes.length === 0 && op.kind !== "replace-all")
        throw new Error("A rich draft change needs at least one block");
    } else if (op.kind !== "replace-all" && body.trim() === "") {
      throw new Error("A Markdown draft change cannot be empty");
    }
  }
  if (total > PAGE_DRAFT_LIMITS.totalBytes) throw new Error("The draft is too large");
}

export const makePageDraftsServiceShape = (
  options: { readonly now?: () => string; readonly id?: () => string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pages = yield* PagesService;
    const realtime = yield* Effect.serviceOption(PageRealtimeService);
    const now = options.now ?? (() => new Date().toISOString());
    const newId = options.id ?? randomUUID;
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof PagesServiceError
            ? cause
            : new PagesServiceError({
                code: "storage",
                message: "Page drafts storage operation failed",
                cause,
              }),
        ),
      );
    // PagesService.read authorizes the principal for the scope and proves the page exists.
    const currentPage = (
      scopeSpaceId: SpaceId | null,
      pageId: PageDraft["pageId"],
      principal: PagesPrincipal,
    ) => pages.read({ scopeSpaceId, pageId }, principal).pipe(Effect.map((result) => result.page));
    const rowsFor = (ids: readonly string[]) =>
      ids.length === 0
        ? Effect.succeed([] as DraftRow[])
        : sql<DraftRow>`SELECT * FROM pages_drafts WHERE draft_id IN ${sql.in(ids)} ORDER BY created_at, draft_id`;

    const list: PageDraftsServiceShape["list"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageDraftsListInput, raw);
          yield* currentPage(input.scopeSpaceId, input.pageId, principal);
          const key = scopeKey(input.scopeSpaceId);
          const rows = input.includeResolved
            ? yield* sql<DraftRow>`SELECT * FROM pages_drafts WHERE page_id = ${input.pageId}
                AND scope_key = ${key} ORDER BY created_at, draft_id`
            : yield* sql<DraftRow>`SELECT * FROM pages_drafts WHERE page_id = ${input.pageId}
                AND scope_key = ${key} AND status = 'open' ORDER BY created_at, draft_id`;
          return { drafts: rows.map(draftFromRow) };
        }),
      );

    const mutate: PageDraftsServiceShape["mutate"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageDraftsMutateInput, raw);
          const page = yield* currentPage(input.scopeSpaceId, input.pageId, principal);
          const key = scopeKey(input.scopeSpaceId);
          if (input.op === "resolve") {
            if (principal.kind !== "local-user")
              return yield* Effect.fail(
                failure("forbidden", "Only the person editing the page can accept or discard"),
              );
            const rows = yield* rowsFor(input.draftIds);
            if (
              rows.length !== new Set(input.draftIds).size ||
              rows.some((row) => row.page_id !== page.id)
            )
              return yield* Effect.fail(failure("not-found", "Page draft not found"));
            if (
              input.action === "accept" &&
              input.revision !== undefined &&
              input.revision > page.revision
            )
              return yield* Effect.fail(failure("invalid", "That page revision does not exist"));
            const resolvedAt = now();
            const status = input.action === "accept" ? "accepted" : "discarded";
            yield* sql`UPDATE pages_drafts SET status = ${status}, resolved_at = ${resolvedAt},
              resolved_revision = ${input.action === "accept" ? (input.revision ?? page.revision) : null}
              WHERE draft_id IN ${sql.in(input.draftIds)} AND status = 'open'`;
            return { drafts: (yield* rowsFor(input.draftIds)).map(draftFromRow) };
          }
          if (page.trashedAt !== null)
            return yield* Effect.fail(
              failure("invalid", "Restore the page before proposing changes"),
            );
          if (input.baseRevision > page.revision)
            return yield* Effect.fail(failure("invalid", "That page revision does not exist"));
          const deckDraft = input.ops.some((op) => op.kind === "deck");
          if (deckDraft !== (page.kind === "slides"))
            return yield* Effect.fail(
              failure(
                "invalid",
                deckDraft
                  ? "Deck changes can only be proposed on a slides item"
                  : "Propose slides changes as deck operations",
              ),
            );
          yield* Effect.try({
            try: () => validatePageDraftOps(input.ops),
            catch: (cause) =>
              failure("invalid", cause instanceof Error ? cause.message : "Invalid page draft"),
          });
          const actorKey =
            principal.kind === "local-user" ? "local-user" : `thread:${principal.threadId}`;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const prior = yield* sql<DraftRow>`SELECT * FROM pages_drafts WHERE scope_key = ${key}
                AND actor_key = ${actorKey} AND request_id = ${input.requestId}`;
              if (prior[0]) {
                if (prior[0].page_id !== page.id)
                  return yield* Effect.fail(
                    failure("conflict", "This request id was used for a different page"),
                  );
                return { drafts: [draftFromRow(prior[0])] };
              }
              const open = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM pages_drafts
                WHERE page_id = ${page.id} AND status = 'open'`;
              if ((open[0]?.count ?? 0) >= MAX_OPEN_PAGE_DRAFTS)
                return yield* Effect.fail(
                  failure("conflict", "This page has too many unreviewed drafts; wait for review"),
                );
              // An agent is always its own author; only the trusted local UI may name the
              // conversation whose reply it streamed into the page.
              const threadId =
                principal.kind === "agent" ? principal.threadId : (input.authorThreadId ?? null);
              const id = newId();
              yield* sql`INSERT INTO pages_drafts (draft_id, page_id, scope_key, base_revision, kind,
                summary, ops_json, status, author, author_thread_id, actor_key, request_id, created_at)
                VALUES (${id}, ${page.id}, ${key}, ${input.baseRevision}, ${input.kind ?? "text"},
                ${input.summary?.trim() || null}, ${JSON.stringify(input.ops)}, 'open',
                ${threadId === null ? "local-user" : "agent"}, ${threadId}, ${actorKey},
                ${input.requestId}, ${now()})`;
              // An agent drafting a page that is open somewhere shows in that page's presence.
              if (threadId !== null && realtime._tag === "Some")
                realtime.value.showAgent(page.id, threadId);
              return { drafts: (yield* rowsFor([id])).map(draftFromRow) };
            }),
          );
        }),
      );

    return { list, mutate } satisfies PageDraftsServiceShape;
  });

export const PageDraftsServiceLive = Layer.effect(PageDraftsService, makePageDraftsServiceShape());
