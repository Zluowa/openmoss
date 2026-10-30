import { Schema } from "effect";

import {
  AutomationId,
  IsoDateTime,
  PositiveInt,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const PageId = TrimmedNonEmptyString.pipe(Schema.brand("PageId"));
export type PageId = typeof PageId.Type;
export const PageSpaceId = TrimmedNonEmptyString.pipe(Schema.brand("PageSpaceId"));
export type PageSpaceId = typeof PageSpaceId.Type;

const PageTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PageContent = Schema.String.check(Schema.isMaxLength(2_000_000));
const PageRichContent = Schema.String.check(Schema.isMaxLength(2_000_000));
const PageRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const AssetIds = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(256));
const AutomationIds = Schema.Array(AutomationId).check(Schema.isMaxLength(256));

/** A definite server response, distinct from an unknown transport outcome. */
export class PagesRpcError extends Schema.TaggedErrorClass<PagesRpcError>()("PagesRpcError", {
  code: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "cycle", "storage"]),
  message: Schema.String,
  currentRevision: Schema.optional(PositiveInt),
}) {}

/** Authorization domain, distinct from a document space. Null is the local default domain. */
export const PageScopeSpaceId = Schema.NullOr(SpaceId);
/** Document spaces have their own identity and an editable root page. Null means Personal. */
export const PageSpace = Schema.Struct({
  id: PageSpaceId,
  scopeSpaceId: PageScopeSpaceId,
  rootPageId: PageId,
  title: PageTitle,
  revision: PositiveInt,
  trashedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PageSpace = typeof PageSpace.Type;

export const Page = Schema.Struct({
  id: PageId,
  scopeSpaceId: PageScopeSpaceId,
  spaceId: Schema.NullOr(PageSpaceId),
  parentPageId: Schema.NullOr(PageId),
  rootPageId: PageId,
  title: PageTitle,
  revision: PositiveInt,
  pinned: Schema.Boolean,
  trashedAt: Schema.NullOr(IsoDateTime),
  sourceThreadId: Schema.NullOr(ThreadId),
  assetIds: AssetIds,
  automationIds: AutomationIds,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Page = typeof Page.Type;

export const PagesScopeInput = Schema.Struct({ scopeSpaceId: PageScopeSpaceId });
export type PagesScopeInput = typeof PagesScopeInput.Type;
export const PagesSpacesResult = Schema.Struct({ spaces: Schema.Array(PageSpace) });
export type PagesSpacesResult = typeof PagesSpacesResult.Type;
export const PagesListInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  includeTrashed: Schema.optional(Schema.Boolean),
});
export type PagesListInput = typeof PagesListInput.Type;
export const PagesListResult = Schema.Struct({ pages: Schema.Array(Page) });
export type PagesListResult = typeof PagesListResult.Type;
export const PagesReadInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  revision: Schema.optional(PositiveInt),
});
export type PagesReadInput = typeof PagesReadInput.Type;
export const PagesReadResult = Schema.Struct({
  page: Page,
  /** Markdown/plain-text projection when richContent exists; never its source of truth. */
  content: PageContent,
  richContent: Schema.optional(PageRichContent),
});
export type PagesReadResult = typeof PagesReadResult.Type;
export const PageAuthor = Schema.Literals(["local-user", "agent"]);
export const PageVersion = Schema.Struct({
  page: Page,
  content: PageContent,
  richContent: Schema.optional(PageRichContent),
  operation: Schema.String,
  author: PageAuthor,
  authorThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type PageVersion = typeof PageVersion.Type;
export const PagesVersionsInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  beforeRevision: Schema.optional(PositiveInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type PagesVersionsInput = typeof PagesVersionsInput.Type;
export const PagesVersionsResult = Schema.Struct({ versions: Schema.Array(PageVersion) });
export type PagesVersionsResult = typeof PagesVersionsResult.Type;
export const PageComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  pageId: PageId,
  revision: PositiveInt,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  author: PageAuthor,
  authorThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type PageComment = typeof PageComment.Type;
export const PagesCommentsInput = Schema.Struct({ scopeSpaceId: PageScopeSpaceId, pageId: PageId });
export type PagesCommentsInput = typeof PagesCommentsInput.Type;
export const PagesCommentsResult = Schema.Struct({ comments: Schema.Array(PageComment) });
export type PagesCommentsResult = typeof PagesCommentsResult.Type;

const CreateFields = {
  requestId: PageRequestId,
  scopeSpaceId: PageScopeSpaceId,
  title: PageTitle,
  content: Schema.optional(PageContent),
  /** String selects canonical Plate JSON; null explicitly converts to Markdown. */
  richContent: Schema.optional(Schema.NullOr(PageRichContent)),
};
const MutationFields = {
  requestId: PageRequestId,
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  expectedRevision: PositiveInt,
};
export const PagesMutateInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create-space"), ...CreateFields }),
  Schema.Struct({
    op: Schema.Literal("create"),
    ...CreateFields,
    spaceId: Schema.NullOr(PageSpaceId),
    parentPageId: Schema.NullOr(PageId),
    sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    assetIds: Schema.optional(AssetIds),
    automationIds: Schema.optional(AutomationIds),
  }),
  Schema.Struct({
    op: Schema.Literal("update"),
    ...MutationFields,
    title: Schema.optional(PageTitle),
    content: Schema.optional(PageContent),
    richContent: Schema.optional(Schema.NullOr(PageRichContent)),
    sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    assetIds: Schema.optional(AssetIds),
    automationIds: Schema.optional(AutomationIds),
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    ...MutationFields,
    spaceId: Schema.NullOr(PageSpaceId),
    parentPageId: Schema.NullOr(PageId),
  }),
  Schema.Struct({ op: Schema.Literal("pin"), ...MutationFields, pinned: Schema.Boolean }),
  Schema.Struct({ op: Schema.Literal("trash"), ...MutationFields }),
  Schema.Struct({ op: Schema.Literal("restore"), ...MutationFields }),
  Schema.Struct({ op: Schema.Literal("trash-space"), ...MutationFields }),
  Schema.Struct({ op: Schema.Literal("restore-space"), ...MutationFields }),
  Schema.Struct({
    op: Schema.Literal("restore-version"),
    ...MutationFields,
    revision: PositiveInt,
  }),
  Schema.Struct({
    op: Schema.Literal("comment"),
    ...MutationFields,
    content: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  }),
]);
export type PagesMutateInput = typeof PagesMutateInput.Type;
export const PagesMutateResult = Schema.Struct({
  page: Page,
  content: PageContent,
  richContent: Schema.optional(PageRichContent),
  affectedPageIds: Schema.Array(PageId),
  space: Schema.optional(PageSpace),
  comment: Schema.optional(PageComment),
});
export type PagesMutateResult = typeof PagesMutateResult.Type;
