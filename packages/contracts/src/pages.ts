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

/**
 * What a 资料空间 item is. Every item is a row in pages_documents; `page` is the rich document,
 * the others are owned by their streams (app = 应用页, slides, sheet, board, site, design = 设计) or come from
 * agent outputs (file, image). Clients render a kind they do not know as a generic card.
 * Add a kind only in a small separate commit and tell the space lead.
 */
export const SpaceItemKind = Schema.Literals([
  "page",
  "app",
  "slides",
  "sheet",
  "board",
  "site",
  "file",
  "image",
  "design",
]);
export type SpaceItemKind = typeof SpaceItemKind.Type;
export const SPACE_ITEM_KINDS = SpaceItemKind.literals;

const PageTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PageSpaceIcon = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
/** A page's icon above its title: a Central glyph name or one emoji. */
const PageIcon = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
/** A page's cover band: one of the preset covers (no uploaded media, so it never breaks). */
export const PAGE_COVER_IDS = [
  "paper",
  "sand",
  "sage",
  "sky",
  "dusk",
  "rose",
  "ink",
  "mist",
] as const;
export const PageCover = Schema.Literals(PAGE_COVER_IDS);
export type PageCover = typeof PageCover.Type;
/** The languages a page can be marked as (文档语言), for screen readers and spelling. */
export const PAGE_DOC_LANGUAGES = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es"] as const;
/** How a page is laid out for everyone who opens it: column width, fonts and language. */
export const PageDocStyle = Schema.Struct({
  width: Schema.Literals(["default", "wide"]),
  headingFont: Schema.Literals(["sans", "serif"]),
  textFont: Schema.Literals(["sans", "serif"]),
  lang: Schema.optional(Schema.Literals(PAGE_DOC_LANGUAGES)),
});
export type PageDocStyle = typeof PageDocStyle.Type;
/** Trashed items are purged this many days after they were trashed. */
export const SPACE_TRASH_RETENTION_DAYS = 30;
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
  /** One emoji or short glyph name shown before the space title; absent = default icon. */
  icon: Schema.optional(Schema.NullOr(PageSpaceIcon)),
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
  /** Absent on rows written before kinds existed: those are pages. */
  kind: Schema.optional(SpaceItemKind),
  title: PageTitle,
  /** Absent = no icon / no cover. */
  icon: Schema.optional(Schema.NullOr(PageIcon)),
  cover: Schema.optional(Schema.NullOr(PageCover)),
  /** Absent = the default width and fonts in the app's language. */
  docStyle: Schema.optional(Schema.NullOr(PageDocStyle)),
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
/** The requested Space is a Pages document space inside the current authorization scope. */
export const PageSpaceSyncInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  spaceId: PageSpaceId.check(Schema.isMaxLength(128)),
  enabled: Schema.optional(Schema.Boolean),
  observation: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
});
export type PageSpaceSyncInput = typeof PageSpaceSyncInput.Type;
export const PageSpaceSyncState = Schema.Struct({
  available: Schema.Boolean,
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  canClear: Schema.Boolean,
  observation: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type PageSpaceSyncState = typeof PageSpaceSyncState.Type;
const RecoveryId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const RecoveryObservation = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const PageAccountRecoveryInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("availability") }),
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({
    op: Schema.Literal("restore"),
    recoveryId: RecoveryId,
    observation: RecoveryObservation,
  }),
  Schema.Struct({
    op: Schema.Literal("publication-status"),
    spaceId: PageSpaceId.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    op: Schema.Literal("set-publication"),
    spaceId: PageSpaceId.check(Schema.isMaxLength(128)),
    enabled: Schema.Boolean,
    observation: RecoveryObservation,
  }),
]);
export type PageAccountRecoveryInput = typeof PageAccountRecoveryInput.Type;
export const PageAccountRecoveryResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("availability"), available: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    items: Schema.Array(
      Schema.Struct({
        recoveryId: RecoveryId,
        title: PageTitle,
        confirmedAt: IsoDateTime,
        observation: RecoveryObservation,
      }),
    ).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({ kind: Schema.Literal("restored"), pageId: PageId }),
  Schema.Struct({
    kind: Schema.Literal("publication"),
    available: Schema.Boolean,
    allowed: Schema.Boolean,
    confirmedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    lastConfirmedAt: Schema.NullOr(IsoDateTime),
    observation: Schema.String.check(Schema.isMaxLength(64)),
  }),
]);
export type PageAccountRecoveryResult = typeof PageAccountRecoveryResult.Type;
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
export const PAGE_VERSION_CONTRIBUTOR_LIMIT = 128;
const contributorOptions = { parseOptions: { onExcessProperty: "error" as const } };
const guestActorRef = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const PageVersionContributor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-user") }).annotate(contributorOptions),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId.check(Schema.isMaxLength(512)),
  }).annotate(contributorOptions),
  Schema.Struct({ kind: Schema.Literal("guest"), actorRef: guestActorRef }).annotate(
    contributorOptions,
  ),
  Schema.Struct({ kind: Schema.Literal("unrecorded") }).annotate(contributorOptions),
]);
export type PageVersionContributor = typeof PageVersionContributor.Type;
export const PageVersionContributors = Schema.Array(PageVersionContributor).check(
  Schema.isMaxLength(PAGE_VERSION_CONTRIBUTOR_LIMIT),
  Schema.makeFilter(
    (sources) =>
      new Set(
        sources.map((source) =>
          source.kind === "agent"
            ? `agent:${source.threadId}`
            : source.kind === "guest"
              ? `guest:${source.actorRef}`
              : source.kind,
        ),
      ).size === sources.length,
  ),
);
export const PageVersion = Schema.Struct({
  page: Page,
  content: PageContent,
  richContent: Schema.optional(PageRichContent),
  operation: Schema.String,
  author: Schema.Literals(["local-user", "agent", "guest"]),
  authorThreadId: Schema.NullOr(ThreadId),
  authorGuestRef: Schema.optional(guestActorRef),
  /** Absent on legacy/non-room versions. Each entry is a source, not a count of people. */
  contributors: Schema.optional(PageVersionContributors.check(Schema.isMinLength(1))),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter((version) =>
    version.author === "guest"
      ? version.authorGuestRef !== undefined && version.authorThreadId === null
      : version.authorGuestRef === undefined,
  ),
);
export type PageVersion = typeof PageVersion.Type;
export const PagesVersionsInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  beforeRevision: Schema.optional(PositiveInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  /**
   * Metadata only: `content` comes back empty and `richContent` absent. A rich page with images
   * can be megabytes per version; a history list must not wait for 30 bodies. Read one body
   * with `pages.read({ revision })`.
   */
  summaryOnly: Schema.optional(Schema.Boolean),
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

/**
 * A comment thread on words in a page (评论 on a selection): kept with the page in Moss's
 * database. `thread` is the web app's thread record as JSON (messages, replies, reactions,
 * resolved, Moss's answers); the server stores it as given and never interprets it.
 */
export const PageTextCommentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
export const PageTextComment = Schema.Struct({
  id: PageTextCommentId,
  pageId: PageId,
  thread: Schema.String.check(Schema.isMaxLength(200_000)),
  updatedAt: IsoDateTime,
});
export type PageTextComment = typeof PageTextComment.Type;
export const PagesTextCommentsInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
});
export type PagesTextCommentsInput = typeof PagesTextCommentsInput.Type;
export const PagesTextCommentsResult = Schema.Struct({ comments: Schema.Array(PageTextComment) });
export type PagesTextCommentsResult = typeof PagesTextCommentsResult.Type;
export const PagesTextCommentMutateInput = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("save"),
    scopeSpaceId: PageScopeSpaceId,
    pageId: PageId,
    commentId: PageTextCommentId,
    thread: Schema.String.check(Schema.isMaxLength(200_000)),
  }),
  Schema.Struct({
    op: Schema.Literal("delete"),
    scopeSpaceId: PageScopeSpaceId,
    pageId: PageId,
    commentId: PageTextCommentId,
  }),
]);
export type PagesTextCommentMutateInput = typeof PagesTextCommentMutateInput.Type;
export const PagesTextCommentMutateResult = Schema.Struct({ ok: Schema.Boolean });
export type PagesTextCommentMutateResult = typeof PagesTextCommentMutateResult.Type;

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
    /** Defaults to `page`. */
    kind: Schema.optional(SpaceItemKind),
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
  /** Permanently deletes a trashed page and everything trashed with it. */
  Schema.Struct({ op: Schema.Literal("purge"), ...MutationFields }),
  /** Sets the icon of the document space whose root page is `pageId`. */
  Schema.Struct({
    op: Schema.Literal("space-icon"),
    ...MutationFields,
    icon: Schema.NullOr(PageSpaceIcon),
  }),
  /** Sets or clears a page's icon, cover and doc style; a field left out keeps its value. */
  Schema.Struct({
    op: Schema.Literal("page-appearance"),
    ...MutationFields,
    icon: Schema.optional(Schema.NullOr(PageIcon)),
    cover: Schema.optional(Schema.NullOr(PageCover)),
    docStyle: Schema.optional(Schema.NullOr(PageDocStyle)),
  }),
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

/**
 * A file an agent wrote in a chat turn (HTML, Office, CSV, images, archives…), read from the
 * turn's checkpoint. It is not copied: the file stays in the chat's workspace, and the Space
 * shows it under 你的条目 with a way back to the chat.
 */
export const SpaceOutput = Schema.Struct({
  /** Stable key: thread id and workspace-relative path. */
  id: TrimmedNonEmptyString,
  kind: SpaceItemKind,
  title: TrimmedNonEmptyString,
  /** Workspace-relative path as the turn reported it. */
  path: TrimmedNonEmptyString,
  /** Absolute folder the path is relative to (the chat's worktree or project root). */
  workspaceRoot: TrimmedNonEmptyString,
  threadId: ThreadId,
  threadTitle: Schema.String,
  /** When the turn that last touched the file finished. */
  updatedAt: IsoDateTime,
  trashedAt: Schema.NullOr(IsoDateTime),
});
export type SpaceOutput = typeof SpaceOutput.Type;
export const PagesOutputsInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  includeTrashed: Schema.optional(Schema.Boolean),
});
export type PagesOutputsInput = typeof PagesOutputsInput.Type;
export const PagesOutputsResult = Schema.Struct({ outputs: Schema.Array(SpaceOutput) });
export type PagesOutputsResult = typeof PagesOutputsResult.Type;
/** Trash, restore or permanently hide an output. The file on disk is never touched. */
export const PagesOutputStateInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  outputId: TrimmedNonEmptyString,
  action: Schema.Literals(["trash", "restore", "purge"]),
});
export type PagesOutputStateInput = typeof PagesOutputStateInput.Type;
