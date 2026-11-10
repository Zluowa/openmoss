/**
 * 资料空间 sharing and 站点 publishing.
 *
 * A page or a whole space can be shared by link or with invited people, and a page (or 应用页)
 * can be published as a site. Guests never reach the owner's Moss server directly: one relay
 * share per Moss instance (the "publisher") carries every page link and site, and the guest
 * page names the link in its request body. See `docs/page-sharing.md`.
 *
 * Owner side: the `pageSharing.*` RPCs below, served on the same socket as `pages.*` but kept in
 * their own satellite group so other streams can extend the pages group without conflicts.
 * Guest side: the `page`, `page-comments` and `page-access` guest routes (POST JSON bodies, so
 * credentials stay out of URLs and relay logs).
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  SpaceId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { PageId, PageSpaceId } from "./pages";
import { PageAppId } from "./pageApps";

// ── Access model ────────────────────────────────────────────────────

/** Who can open the link: invited people only, anyone holding the link, or anyone at all. */
export const PageShareLinkAccess = Schema.Literals(["invited", "link", "anyone"]);
export type PageShareLinkAccess = typeof PageShareLinkAccess.Type;
/** What they can do once in. Guests with `edit` can comment; web editing needs live sync. */
export const PageShareRole = Schema.Literals(["view", "comment", "edit"]);
export type PageShareRole = typeof PageShareRole.Type;

export const PAGE_SHARE_ACCESS_RANK: Record<PageShareLinkAccess, number> = {
  invited: 0,
  link: 1,
  anyone: 2,
};
export const PAGE_SHARE_ROLE_RANK: Record<PageShareRole, number> = { view: 0, comment: 1, edit: 2 };

export const pageShareRoleCanComment = (role: PageShareRole): boolean =>
  PAGE_SHARE_ROLE_RANK[role] >= PAGE_SHARE_ROLE_RANK.comment;

export const PageShareTargetKind = Schema.Literals(["page", "space"]);
export type PageShareTargetKind = typeof PageShareTargetKind.Type;
export const PageShareTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("page"), id: PageId }),
  Schema.Struct({ kind: Schema.Literal("space"), id: PageSpaceId }),
]);
export type PageShareTarget = typeof PageShareTarget.Type;

export const PageShareLinkSetting = Schema.Struct({
  access: PageShareLinkAccess,
  role: PageShareRole,
});
export type PageShareLinkSetting = typeof PageShareLinkSetting.Type;

/** What a page or space without any setting gets: only invited people, read-only. */
export const DEFAULT_PAGE_SHARE_LINK_SETTING: PageShareLinkSetting = {
  access: "invited",
  role: "view",
};

const ShareName = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
const ShareContact = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const ShareNote = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const PageShareMemberId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const PageAccessRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const PageSiteId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PageSiteId = typeof PageSiteId.Type;
/** Link ids are 16 random bytes, base64url. */
export const PageShareLinkId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/));

export const PageShareMember = Schema.Struct({
  id: PageShareMemberId,
  name: ShareName,
  contact: Schema.NullOr(ShareContact),
  role: PageShareRole,
  /** `space`: invited to the whole space, shown read-only on its pages. */
  source: PageShareTargetKind,
  /** The personal link to send them; null while no relay is reachable. */
  url: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type PageShareMember = typeof PageShareMember.Type;

export const PageAccessRequest = Schema.Struct({
  id: PageAccessRequestId,
  name: ShareName,
  contact: Schema.NullOr(ShareContact),
  note: Schema.NullOr(ShareNote),
  role: PageShareRole,
  createdAt: IsoDateTime,
});
export type PageAccessRequest = typeof PageAccessRequest.Type;

/** `unavailable`: no Moss account to register links with (signed out). */
export const PageShareRelayStatus = Schema.Literals([
  "online",
  "connecting",
  "offline",
  "unavailable",
]);
export type PageShareRelayStatus = typeof PageShareRelayStatus.Type;

export const PageShareState = Schema.Struct({
  target: PageShareTarget,
  title: Schema.String,
  scopeSpaceId: Schema.NullOr(SpaceId),
  /** The space a page inherits from; null for spaces and pages outside a space. */
  inheritedFrom: Schema.NullOr(
    Schema.Struct({ spaceId: PageSpaceId, title: Schema.String, setting: PageShareLinkSetting }),
  ),
  /** This item's own setting; null on a page means "use the space's access". */
  direct: Schema.NullOr(PageShareLinkSetting),
  /** What applies: never below the inherited access (a page can open up, not close down). */
  effective: PageShareLinkSetting,
  /** The link to copy; null while no relay is reachable. Invited-only links still open for members. */
  linkUrl: Schema.NullOr(Schema.String),
  /** Owner-only identifier for explicitly granting previews, including invited-only links. */
  appPublicationEntryId: Schema.optional(Schema.String),
  members: Schema.Array(PageShareMember),
  requests: Schema.Array(PageAccessRequest),
  /** Optimistic concurrency for `set-link` and `rotate-link`. */
  version: NonNegativeInt,
  relayStatus: PageShareRelayStatus,
});
export type PageShareState = typeof PageShareState.Type;

// ── Activity (audit) ────────────────────────────────────────────────

export const PageShareEventAction = Schema.Literals([
  "opened",
  "commented",
  "requested",
  "approved",
  "rejected",
  "invited",
  "member-changed",
  "member-removed",
  "link-changed",
  "link-rotated",
  "published",
  "unpublished",
  "visibility-changed",
]);
export type PageShareEventAction = typeof PageShareEventAction.Type;

export const PageShareEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: PageShareEventAction,
  /** `owner`, a guest's chosen name, an invitee's name, or null for an anonymous visitor. */
  actorKind: Schema.Literals(["owner", "member", "guest", "visitor"]),
  actorName: Schema.NullOr(Schema.String),
  pageId: Schema.NullOr(PageId),
  createdAt: IsoDateTime,
});
export type PageShareEvent = typeof PageShareEvent.Type;

export const PageGuestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  pageId: PageId,
  authorKind: Schema.Literals(["owner", "member", "guest"]),
  authorName: Schema.String,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  createdAt: IsoDateTime,
});
export type PageGuestComment = typeof PageGuestComment.Type;
export const PAGE_GUEST_COMMENT_MAX_LENGTH = 4_000;

// ── Sites ───────────────────────────────────────────────────────────

/** `private`: only the owner, inside Moss. `link`: anyone with the link. `anyone`: no secret. */
export const PageSiteVisibility = Schema.Literals(["private", "link", "anyone"]);
export type PageSiteVisibility = typeof PageSiteVisibility.Type;
export const PageSiteKind = Schema.Literals(["page", "app"]);
export type PageSiteKind = typeof PageSiteKind.Type;

export const PageSite = Schema.Struct({
  id: PageSiteId,
  pageId: PageId,
  scopeSpaceId: Schema.NullOr(SpaceId),
  kind: PageSiteKind,
  title: Schema.String,
  visibility: PageSiteVisibility,
  /** False after 取消发布: the link stops working until it is published again. */
  published: Schema.Boolean,
  /** The page revision guests see; later edits wait for the next publish. */
  publishedRevision: Schema.NullOr(PositiveInt),
  publishedAt: Schema.NullOr(IsoDateTime),
  /** True when the page changed since the published revision. */
  hasUnpublishedChanges: Schema.Boolean,
  updatedAt: IsoDateTime,
  pinned: Schema.Boolean,
  /** Null for private and unpublished sites, and while no relay is reachable. */
  url: Schema.NullOr(Schema.String),
  /** Page opens in the last 30 days (one per visitor per half hour). */
  views30d: NonNegativeInt,
});
export type PageSite = typeof PageSite.Type;

// ── Owner RPC payloads ──────────────────────────────────────────────

const OwnerScope = { scopeSpaceId: Schema.NullOr(SpaceId) };

export const PageShareGetInput = Schema.Struct({ ...OwnerScope, target: PageShareTarget });
export type PageShareGetInput = typeof PageShareGetInput.Type;

const PreviewNodePath = Schema.Array(NonNegativeInt).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
const AppPublicationBase = {
  ...OwnerScope,
  pageId: PageId,
  pageRevision: PositiveInt,
  entry: Schema.Struct({
    kind: Schema.Literals(["link", "site"]),
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
};
export const PageShareAppPublicationsInput = Schema.Union([
  Schema.Struct({ ...AppPublicationBase, op: Schema.Literal("list"), offset: NonNegativeInt }),
  Schema.Struct({
    ...AppPublicationBase,
    op: Schema.Literal("publish"),
    nodePath: PreviewNodePath,
    appId: PageAppId,
    appRevision: PositiveInt,
    expectedGeneration: NonNegativeInt,
  }),
  Schema.Struct({
    ...AppPublicationBase,
    op: Schema.Literal("revoke"),
    nodePath: PreviewNodePath,
    expectedGeneration: PositiveInt,
  }),
]);
export type PageShareAppPublicationsInput = typeof PageShareAppPublicationsInput.Type;
export const PageShareAppPublicationsResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      nodePath: PreviewNodePath,
      appId: PageAppId,
      revision: Schema.NullOr(PositiveInt),
      title: Schema.NullOr(Schema.String),
      generation: NonNegativeInt,
      confirmedRevision: Schema.NullOr(PositiveInt),
    }),
  ),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type PageShareAppPublicationsResult = typeof PageShareAppPublicationsResult.Type;

const TargetFields = { ...OwnerScope, target: PageShareTarget };
export const PageShareMutateInput = Schema.Union([
  /** `setting: null` on a page goes back to the space's access. */
  Schema.Struct({
    op: Schema.Literal("set-link"),
    ...TargetFields,
    expectedVersion: NonNegativeInt,
    setting: Schema.NullOr(PageShareLinkSetting),
  }),
  Schema.Struct({
    op: Schema.Literal("rotate-link"),
    ...TargetFields,
    expectedVersion: NonNegativeInt,
  }),
  Schema.Struct({
    op: Schema.Literal("invite"),
    ...TargetFields,
    name: ShareName,
    contact: Schema.optional(Schema.NullOr(ShareContact)),
    role: PageShareRole,
  }),
  /** `role: null` removes the member and kills their personal link. */
  Schema.Struct({
    op: Schema.Literal("set-member"),
    ...TargetFields,
    memberId: PageShareMemberId,
    role: Schema.NullOr(PageShareRole),
  }),
  Schema.Struct({
    op: Schema.Literal("decide-request"),
    ...TargetFields,
    requestId: PageAccessRequestId,
    decision: Schema.Literals(["approve", "reject"]),
    /** Approve with a different role than the one asked for. */
    role: Schema.optional(PageShareRole),
  }),
]);
export type PageShareMutateInput = typeof PageShareMutateInput.Type;

export const PageShareActivityInput = Schema.Struct({ ...OwnerScope, pageId: PageId });
export type PageShareActivityInput = typeof PageShareActivityInput.Type;
export const PageShareActivityResult = Schema.Struct({
  comments: Schema.Array(PageGuestComment),
  events: Schema.Array(PageShareEvent),
});
export type PageShareActivityResult = typeof PageShareActivityResult.Type;

export const PageShareReplyInput = Schema.Struct({
  ...OwnerScope,
  pageId: PageId,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(PAGE_GUEST_COMMENT_MAX_LENGTH)),
});
export type PageShareReplyInput = typeof PageShareReplyInput.Type;

export const PageSitesListInput = Schema.Struct({ ...OwnerScope });
export type PageSitesListInput = typeof PageSitesListInput.Type;
export const PageSitesListResult = Schema.Struct({
  sites: Schema.Array(PageSite),
  /** The first-publish notice was accepted on this Moss. */
  termsAccepted: Schema.Boolean,
  relayStatus: PageShareRelayStatus,
});
export type PageSitesListResult = typeof PageSitesListResult.Type;

export const PageSiteMutateInput = Schema.Union([
  /** Publishes the page's current revision, creating the site on first publish. */
  Schema.Struct({
    op: Schema.Literal("publish"),
    ...OwnerScope,
    pageId: PageId,
    visibility: PageSiteVisibility,
    /** Required (true) until the first-publish notice has been accepted once. */
    acceptTerms: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    op: Schema.Literal("set-visibility"),
    ...OwnerScope,
    siteId: PageSiteId,
    visibility: PageSiteVisibility,
  }),
  Schema.Struct({ op: Schema.Literal("unpublish"), ...OwnerScope, siteId: PageSiteId }),
  Schema.Struct({
    op: Schema.Literal("pin"),
    ...OwnerScope,
    siteId: PageSiteId,
    pinned: Schema.Boolean,
  }),
]);
export type PageSiteMutateInput = typeof PageSiteMutateInput.Type;
export const PageSiteMutateResult = Schema.Struct({ site: PageSite });
export type PageSiteMutateResult = typeof PageSiteMutateResult.Type;

export const PageSiteForPageInput = Schema.Struct({ ...OwnerScope, pageId: PageId });
export type PageSiteForPageInput = typeof PageSiteForPageInput.Type;
export const PageSiteForPageResult = Schema.Struct({
  site: Schema.NullOr(PageSite),
  termsAccepted: Schema.Boolean,
});
export type PageSiteForPageResult = typeof PageSiteForPageResult.Type;

export class PageSharingRpcError extends Schema.TaggedErrorClass<PageSharingRpcError>()(
  "PageSharingRpcError",
  {
    code: Schema.Literals([
      "invalid",
      "owner-required",
      "not-found",
      "conflict",
      "terms-required",
      "account-required",
      "relay-unavailable",
      "storage",
    ]),
    message: Schema.String,
    currentVersion: Schema.optional(NonNegativeInt),
  },
) {}

export const PAGE_SHARING_WS_METHODS = {
  get: "pageSharing.get",
  appPublications: "pageSharing.appPublications",
  mutate: "pageSharing.mutate",
  activity: "pageSharing.activity",
  reply: "pageSharing.reply",
  sitesList: "pageSharing.sites.list",
  siteForPage: "pageSharing.sites.forPage",
  siteMutate: "pageSharing.sites.mutate",
} as const;

export const WsPageSharingGetRpc = Rpc.make(PAGE_SHARING_WS_METHODS.get, {
  payload: PageShareGetInput,
  success: PageShareState,
  error: PageSharingRpcError,
});
export const WsPageSharingMutateRpc = Rpc.make(PAGE_SHARING_WS_METHODS.mutate, {
  payload: PageShareMutateInput,
  success: PageShareState,
  error: PageSharingRpcError,
});
export const WsPageSharingActivityRpc = Rpc.make(PAGE_SHARING_WS_METHODS.activity, {
  payload: PageShareActivityInput,
  success: PageShareActivityResult,
  error: PageSharingRpcError,
});
export const WsPageSharingReplyRpc = Rpc.make(PAGE_SHARING_WS_METHODS.reply, {
  payload: PageShareReplyInput,
  success: PageShareActivityResult,
  error: PageSharingRpcError,
});
export const WsPageSitesListRpc = Rpc.make(PAGE_SHARING_WS_METHODS.sitesList, {
  payload: PageSitesListInput,
  success: PageSitesListResult,
  error: PageSharingRpcError,
});
export const WsPageSiteForPageRpc = Rpc.make(PAGE_SHARING_WS_METHODS.siteForPage, {
  payload: PageSiteForPageInput,
  success: PageSiteForPageResult,
  error: PageSharingRpcError,
});
export const WsPageSiteMutateRpc = Rpc.make(PAGE_SHARING_WS_METHODS.siteMutate, {
  payload: PageSiteMutateInput,
  success: PageSiteMutateResult,
  error: PageSharingRpcError,
});
export const WsPageShareAppPublicationsRpc = Rpc.make(PAGE_SHARING_WS_METHODS.appPublications, {
  payload: PageShareAppPublicationsInput,
  success: PageShareAppPublicationsResult,
  error: PageSharingRpcError,
});
export const WsPageSharingRpcGroup = RpcGroup.make(
  WsPageShareAppPublicationsRpc,
  WsPageSharingGetRpc,
  WsPageSharingMutateRpc,
  WsPageSharingActivityRpc,
  WsPageSharingReplyRpc,
  WsPageSitesListRpc,
  WsPageSiteForPageRpc,
  WsPageSiteMutateRpc,
);

// ── Guest HTTP API (through the publisher relay share) ──────────────

/** The guest page for links and sites: `https://<relay>/p/<publisher share id>?l=<link id>`. */
export const PAGE_GUEST_PATH_PREFIX = "/p/";
export const pageGuestPath = (publisherShareId: string) =>
  `${PAGE_GUEST_PATH_PREFIX}${publisherShareId}`;
/** Query parameter naming the link or site. Member links carry no link id, only a credential. */
export const PAGE_GUEST_LINK_PARAM = "l";

const GuestCredential = Schema.String.check(Schema.isMaxLength(200));
/** A random id the guest page keeps per browser, so opens can be counted without accounts. */
const GuestVisitorId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));

const GuestEntryFields = {
  /** The link or site id from `?l=`; absent on personal (member) links. */
  link: Schema.optional(PageShareLinkId),
  /** The credential from the URL fragment, or one an approved access request handed out. */
  key: Schema.optional(GuestCredential),
  visitor: GuestVisitorId,
};

/** POST `page`: the page to show (the link's own page when `pageId` is absent). */
export const PageGuestViewRequest = Schema.Struct({
  ...GuestEntryFields,
  pageId: Schema.optional(PageId),
});
export type PageGuestViewRequest = typeof PageGuestViewRequest.Type;

export const PAGE_GUEST_EDIT_LIMITS = {
  bytes: 256 * 1024,
  encodedChars: 349_526,
  jsonBytes: 4096,
  updateBodyBytes: 352 * 1024,
  streamBytes: 16 * 1024,
  streams: 16,
  ttlMs: 60_000,
  heartbeatMs: 5000,
} as const;
/** Added by the relay only after validating the configured main origin. */
export const PAGE_GUEST_EDIT_ORIGIN_HEADER = "x-moss-page-edit-origin";
const editStrict = { parseOptions: { onExcessProperty: "error" as const } };
export const PageGuestEditCapability = Schema.Struct({ v: Schema.Literal(1) }).annotate(editStrict);
export type PageGuestEditCapability = typeof PageGuestEditCapability.Type;
const editEntry = Schema.Struct(GuestEntryFields).annotate(editStrict);
export const PageGuestEditTicket = Schema.Struct({
  sessionKey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  epoch: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
}).annotate(editStrict);
export type PageGuestEditTicket = typeof PageGuestEditTicket.Type;
const editBytes = Schema.String.check(
  Schema.isMaxLength(PAGE_GUEST_EDIT_LIMITS.encodedChars),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.makeFilter((value: string) => {
    const tail = value.length % 4;
    return (
      tail === 0 ||
      (tail === 2 && /[AQgw]$/.test(value)) ||
      (tail === 3 && /[AEIMQUYcgkosw048]$/.test(value))
    );
  }),
);
const editFields = {
  v: Schema.Literal(1),
  pageId: PageId.check(Schema.isMaxLength(256)),
  entry: editEntry,
};
export const PageGuestEditOpenRequest = Schema.Struct(editFields).annotate(editStrict);
export const PageGuestEditSessionRequest = Schema.Struct({
  ...editFields,
  ticket: PageGuestEditTicket,
}).annotate(editStrict);
export const PageGuestEditUpdateRequest = Schema.Struct({
  ...editFields,
  ticket: PageGuestEditTicket,
  update: editBytes,
}).annotate(editStrict);
export const PageGuestEditOpenResult = Schema.Struct({
  v: Schema.Literal(1),
  ticket: PageGuestEditTicket,
  revision: PositiveInt,
  seed: editBytes,
  expiresInMs: Schema.Literal(PAGE_GUEST_EDIT_LIMITS.ttlMs),
}).annotate(editStrict);
export const PageGuestEditUpdateResult = Schema.Struct({
  v: Schema.Literal(1),
  revision: PositiveInt,
  applied: Schema.Boolean,
}).annotate(editStrict);
export const PageGuestEditEvent = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("ready"),
    revision: PositiveInt,
  }).annotate(editStrict),
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literals(["refresh", "ended"]) }).annotate(
    editStrict,
  ),
]);
export type PageGuestEditOpenRequest = typeof PageGuestEditOpenRequest.Type;
export type PageGuestEditSessionRequest = typeof PageGuestEditSessionRequest.Type;
export type PageGuestEditUpdateRequest = typeof PageGuestEditUpdateRequest.Type;
export type PageGuestEditOpenResult = typeof PageGuestEditOpenResult.Type;
export type PageGuestEditUpdateResult = typeof PageGuestEditUpdateResult.Type;
export type PageGuestEditEvent = typeof PageGuestEditEvent.Type;

/** Versioned readonly preview transport; no account identity or application capability grant. */
export const PAGE_APP_PREVIEW_LIMITS = {
  protocolVersion: 1,
  ticketMs: 30_000,
  frameMs: 300_000,
  operationMs: 8_000,
  openBodyBytes: 32 * 1024,
  documentBodyBytes: 4 * 1024,
  documentBytes: 8 * 1024 * 1024,
  pendingPerPublisher: 64,
  pendingTotal: 256,
  concurrentOperations: 2,
} as const;
export const PAGE_APP_PREVIEW_CONTEXT_HEADERS = {
  parent: "x-moss-app-preview-parent-origin",
  content: "x-moss-app-preview-content-origin",
  kind: "x-moss-app-preview-kind",
} as const;
export const PageAppPreviewRelayCapability = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  contentOrigin: Schema.String.check(Schema.isMaxLength(2_048)),
  brokerProtocol: Schema.optional(Schema.Literal(1)),
});
export type PageAppPreviewRelayCapability = typeof PageAppPreviewRelayCapability.Type;
const PreviewDigest = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const PageGuestAppReference = Schema.Struct({
  appId: PageAppId,
  nodePath: PreviewNodePath,
  appRevision: Schema.optional(PositiveInt),
});
export type PageGuestAppReference = typeof PageGuestAppReference.Type;
export const PageGuestAppPreviewOpenRequest = Schema.Struct({
  ...GuestEntryFields,
  pageId: PageId,
  expectedPageRevision: PositiveInt,
  reference: Schema.optional(PageGuestAppReference),
  frameSecretHash: PreviewDigest,
  brokerSecretHash: Schema.optional(PreviewDigest),
  frameNonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,64}$/)),
});
export type PageGuestAppPreviewOpenRequest = typeof PageGuestAppPreviewOpenRequest.Type;
export const PageGuestAppPreviewDocumentRequest = Schema.Struct({
  ticket: PreviewDigest,
  frameSecret: PreviewDigest,
});
export type PageGuestAppPreviewDocumentRequest = typeof PageGuestAppPreviewDocumentRequest.Type;
const GuestPublishedAppSource = Schema.Struct({
  sourceKind: Schema.Literal("page-app"),
  pageId: PageId,
  pageRevision: PositiveInt,
  appId: PageAppId,
  appRevision: PositiveInt,
  publicationId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  ),
  generation: PositiveInt,
});
export const PageGuestAppPreviewBrokerRequest = Schema.Struct({
  method: Schema.Literal("permissions.state"),
  handle: PreviewDigest,
  secret: PreviewDigest,
  frameNonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,64}$/)),
});
export type PageGuestAppPreviewBrokerRequest = typeof PageGuestAppPreviewBrokerRequest.Type;
export const PageGuestAppPreviewBrokerResult = Schema.Struct({
  source: GuestPublishedAppSource,
  expiresAt: IsoDateTime,
  availableCapabilities: Schema.Tuple([]),
});
export type PageGuestAppPreviewBrokerResult = typeof PageGuestAppPreviewBrokerResult.Type;
export const PageGuestAppPreviewOpenResult = Schema.Struct({
  brokerHandle: Schema.optional(PreviewDigest),
  ticket: PreviewDigest,
  ticketExpiresAt: IsoDateTime,
  frameExpiresAt: IsoDateTime,
  source: Schema.Union([
    Schema.Struct({
      sourceKind: Schema.Literal("page-item"),
      pageId: PageId,
      pageRevision: PositiveInt,
      dataRevision: PositiveInt,
    }),
    GuestPublishedAppSource,
  ]),
  publicMetadata: Schema.Struct({
    title: Schema.String.check(Schema.isMaxLength(256)),
    revision: PositiveInt,
  }),
});
export type PageGuestAppPreviewOpenResult = typeof PageGuestAppPreviewOpenResult.Type;

/** POST `page-media`: credentials remain in the body; a library ID alone grants no access. */
export const PageGuestMediaRequest = Schema.Struct({
  ...GuestEntryFields,
  pageId: PageId,
  revision: PositiveInt,
  itemId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
});
export type PageGuestMediaRequest = typeof PageGuestMediaRequest.Type;

export const PageGuestNavItem = Schema.Struct({
  id: PageId,
  title: Schema.String,
  parentId: Schema.NullOr(PageId),
});
export type PageGuestNavItem = typeof PageGuestNavItem.Type;

export const PageGuestView = Schema.Struct({
  /** Present only when this owner and its registered relay agree on the preview protocol/origin. */
  appPreview: Schema.optional(PageAppPreviewRelayCapability),
  editProjection: Schema.optional(PageGuestEditCapability),
  mode: Schema.Literals(["share", "site"]),
  /** The shared page or space, or the site title. */
  title: Schema.String,
  role: PageShareRole,
  /** Set on personal links: who the owner invited. */
  viewerName: Schema.NullOr(Schema.String),
  pages: Schema.Array(PageGuestNavItem),
  page: Schema.Struct({
    id: PageId,
    title: Schema.String,
    kind: PageSiteKind,
    revision: PositiveInt,
    updatedAt: IsoDateTime,
    content: Schema.String,
    richContent: Schema.optional(Schema.String),
    /** 幻灯片: the deck JSON (deck schema v2) as of this revision; the guest view presents it. */
    deck: Schema.optional(Schema.String),
  }),
  canComment: Schema.Boolean,
  /** Older owners omit this. Only current authorized library raster images are supported. */
  canLoadImages: Schema.optional(Schema.Boolean),
});
export type PageGuestView = typeof PageGuestView.Type;

/** POST `page-comments`. */
export const PageGuestCommentsRequest = Schema.Union([
  Schema.Struct({ ...GuestEntryFields, action: Schema.Literal("list"), pageId: PageId }),
  Schema.Struct({
    ...GuestEntryFields,
    action: Schema.Literal("add"),
    pageId: PageId,
    /** Ignored on personal links, where the invitee's name is used. */
    name: Schema.optional(ShareName),
    content: TrimmedNonEmptyString.check(Schema.isMaxLength(PAGE_GUEST_COMMENT_MAX_LENGTH)),
  }),
]);
export type PageGuestCommentsRequest = typeof PageGuestCommentsRequest.Type;
export const PageGuestCommentsResult = Schema.Struct({
  comments: Schema.Array(PageGuestComment),
});
export type PageGuestCommentsResult = typeof PageGuestCommentsResult.Type;

/** POST `page-access`: ask the owner for access, then poll until they decide. */
export const PageGuestAccessRequest = Schema.Union([
  Schema.Struct({
    ...GuestEntryFields,
    action: Schema.Literal("request"),
    name: ShareName,
    contact: Schema.optional(ShareContact),
    note: Schema.optional(ShareNote),
    role: PageShareRole,
  }),
  Schema.Struct({
    visitor: GuestVisitorId,
    action: Schema.Literal("status"),
    requestId: PageAccessRequestId,
    secret: GuestCredential,
  }),
]);
export type PageGuestAccessRequest = typeof PageGuestAccessRequest.Type;
export const PageGuestAccessResult = Schema.Struct({
  requestId: PageAccessRequestId,
  /** Shown once, to the requesting browser only; proves it on `status`. */
  secret: Schema.optional(GuestCredential),
  status: Schema.Literals(["pending", "approved", "rejected"]),
  /** The personal credential once approved. */
  key: Schema.optional(GuestCredential),
});
export type PageGuestAccessResult = typeof PageGuestAccessResult.Type;

export const PageGuestErrorReason = Schema.Literals([
  /** Only invited people can open this; the page offers to ask for access. */
  "invite-only",
  /** The link was changed, removed, or never existed. */
  "unavailable",
  /** The site exists but is not published. */
  "unpublished",
  "forbidden",
  "invalid",
  "rate-limited",
]);
export type PageGuestErrorReason = typeof PageGuestErrorReason.Type;
export const PageGuestErrorBody = Schema.Struct({
  reason: PageGuestErrorReason,
  message: Schema.String,
});
export type PageGuestErrorBody = typeof PageGuestErrorBody.Type;

export const pageGuestErrorStatus = (reason: PageGuestErrorReason): number => {
  switch (reason) {
    case "invite-only":
    case "forbidden":
      return 403;
    case "unavailable":
    case "unpublished":
      return 404;
    case "invalid":
      return 400;
    case "rate-limited":
      return 429;
  }
};

/** Limits that keep a public link from filling the owner's disk. */
export const PAGE_GUEST_LIMITS = {
  /** Comments one visitor may add per page per hour. */
  commentsPerVisitorPerHour: 20,
  /** Pending access requests one target holds. */
  pendingRequestsPerTarget: 50,
  /** Access requests one visitor may file per hour. */
  requestsPerVisitorPerHour: 5,
  /** An open counts again for the same visitor and page after this long. */
  openDedupeMs: 30 * 60 * 1000,
} as const;
