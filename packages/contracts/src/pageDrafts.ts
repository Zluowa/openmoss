import { Schema } from "effect";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { PageAuthor, PageId, PageScopeSpaceId } from "./pages";

/**
 * AI page drafts: changes an agent (or the page's own AI actions) proposes to a page. They are
 * never applied by the server. The page editor shows them as highlighted proposals, and only
 * the person accepting one writes it into the page through the normal save path.
 */
export const PageDraftId = TrimmedNonEmptyString.pipe(Schema.brand("PageDraftId"));
export type PageDraftId = typeof PageDraftId.Type;

export const PAGE_DRAFT_LIMITS = { ops: 64, blockBytes: 400_000, totalBytes: 1_000_000 } as const;

const BlockId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
/** Proposed blocks: Markdown (converted by the editor) or a Plate JSON node array. */
const DraftBody = {
  markdown: Schema.optional(Schema.String.check(Schema.isMaxLength(PAGE_DRAFT_LIMITS.blockBytes))),
  richContent: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PAGE_DRAFT_LIMITS.blockBytes)),
  ),
};

export const PageDraftOp = Schema.Union([
  /** No anchor appends at the end; `atStart` prepends. */
  Schema.Struct({
    kind: Schema.Literal("insert"),
    afterBlockId: Schema.optional(BlockId),
    atStart: Schema.optional(Schema.Boolean),
    ...DraftBody,
  }),
  Schema.Struct({ kind: Schema.Literal("replace"), blockId: BlockId, ...DraftBody }),
  Schema.Struct({ kind: Schema.Literal("delete"), blockId: BlockId }),
  /** The whole body; the editor shows it as a block diff against the current page. */
  Schema.Struct({ kind: Schema.Literal("replace-all"), ...DraftBody }),
  /**
   * 幻灯片 only: deck operations (JSON array, `@moss/shared/spaceItems/deckOps` DeckOp[]) applied
   * on top of the base revision's deck. `target` names what the request was about.
   */
  Schema.Struct({
    kind: Schema.Literal("deck"),
    deckOps: Schema.String.check(Schema.isMaxLength(PAGE_DRAFT_LIMITS.blockBytes)),
    target: Schema.optional(
      Schema.Struct({
        slideIds: Schema.Array(BlockId).check(Schema.isMaxLength(300)),
        elementIds: Schema.Array(BlockId).check(Schema.isMaxLength(500)),
      }),
    ),
  }),
]);
export type PageDraftOp = typeof PageDraftOp.Type;

export const PageDraftKind = Schema.Literals(["text", "image", "visualization"]);
export type PageDraftKind = typeof PageDraftKind.Type;
export const PageDraftStatus = Schema.Literals(["open", "accepted", "discarded"]);
export type PageDraftStatus = typeof PageDraftStatus.Type;

const DraftSummary = Schema.String.check(Schema.isMaxLength(500));
const DraftOps = Schema.Array(PageDraftOp).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PAGE_DRAFT_LIMITS.ops),
);

export const PageDraft = Schema.Struct({
  id: PageDraftId,
  pageId: PageId,
  /** The page revision the proposal was written against. */
  baseRevision: PositiveInt,
  kind: PageDraftKind,
  summary: Schema.NullOr(DraftSummary),
  ops: Schema.Array(PageDraftOp),
  status: PageDraftStatus,
  author: PageAuthor,
  authorThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  /** The page revision that contains an accepted draft. */
  resolvedRevision: Schema.NullOr(PositiveInt),
});
export type PageDraft = typeof PageDraft.Type;

const DraftScope = {
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
};

export const PageDraftsListInput = Schema.Struct({
  ...DraftScope,
  includeResolved: Schema.optional(Schema.Boolean),
});
export type PageDraftsListInput = typeof PageDraftsListInput.Type;
export const PageDraftsListResult = Schema.Struct({ drafts: Schema.Array(PageDraft) });
export type PageDraftsListResult = typeof PageDraftsListResult.Type;

export const PageDraftsMutateInput = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("create"),
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    ...DraftScope,
    baseRevision: PositiveInt,
    kind: Schema.optional(PageDraftKind),
    summary: Schema.optional(DraftSummary),
    ops: DraftOps,
    /**
     * Only the trusted local UI may name the conversation that wrote a draft (page 生成 streams
     * an agent reply into the page). Agent callers are always attributed to their own thread.
     */
    authorThreadId: Schema.optional(ThreadId),
  }),
  Schema.Struct({
    op: Schema.Literal("resolve"),
    ...DraftScope,
    draftIds: Schema.Array(PageDraftId).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    action: Schema.Literals(["accept", "discard"]),
    /** The saved revision that contains the accepted drafts. */
    revision: Schema.optional(PositiveInt),
  }),
]);
export type PageDraftsMutateInput = typeof PageDraftsMutateInput.Type;
export const PageDraftsMutateResult = Schema.Struct({ drafts: Schema.Array(PageDraft) });
export type PageDraftsMutateResult = typeof PageDraftsMutateResult.Type;
