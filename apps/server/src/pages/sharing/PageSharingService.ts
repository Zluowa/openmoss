/**
 * 资料空间 sharing and 站点 publishing: the owner's calls (`pageSharing.*` RPCs) and the guest
 * requests the share relay forwards over the publisher connection. See `docs/page-sharing.md`.
 */
import type {
  PageShareActivityInput,
  PageShareActivityResult,
  PageShareGetInput,
  PageShareMutateInput,
  PageShareReplyInput,
  PageShareState,
  PageShareTarget,
  PageSiteForPageInput,
  PageSiteForPageResult,
  PageSiteMutateInput,
  PageSiteMutateResult,
  PageSitesListInput,
  PageSitesListResult,
  PageSharingRpcError,
  PageGuestViewRequest,
  PageId,
  PageSpaceId,
  SpaceId,
} from "@moss/contracts";
import type { PageItemAppSource, ReadonlyAppItemDocument } from "@moss/shared/readonlyAppItem";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { PagesPrincipal } from "../Services/PagesService.ts";
import type { PageGuestFailure } from "./pageGuestHandler.ts";
import type {
  PageAppPreviewDocumentRequest,
  PageAppPreviewOpenRequest,
  PageAppPreviewOpenResult,
} from "./pageAppPreviewTickets.ts";
import type { PageAppPreviewDocument } from "./pageAppPreviewDocument.ts";

export type GuestPageRevisionRequest = PageGuestViewRequest & {
  readonly pageId: PageId;
  readonly expectedPageRevision: number;
};
export type PageGuestReadonlyAppItemRequest = GuestPageRevisionRequest;
export type AuthorizedReadonlyAppItem = ReadonlyAppItemDocument<PageItemAppSource> & {
  readonly availableCapabilities: readonly [];
};

export type PageGuestEditablePageRequest = GuestPageRevisionRequest;
/** The shared ordinary page at one point in time. Its editable text, including
 * app IDs, confers no access to an application or its capabilities. */
export interface GuestAppHostPage {
  readonly entry: { readonly kind: "link" | "site"; readonly id: string };
  readonly policyStamp: string;
  readonly pageId: PageId;
  readonly pageRevision: number;
  readonly scopeSpaceId: SpaceId | null;
  readonly spaceId: PageSpaceId | null;
  readonly richContent: string | null;
}
/** Point-in-time eligibility only: not a token, lease, account identity or write principal.
 * A future writer must reauthorize; linkVersion alone is not a permission generation
 * (member roles and inherited settings have separate lifetimes).
 */
export interface GuestPageEditEligibility {
  readonly pageId: PageId;
  readonly pageRevision: number;
  readonly scopeSpaceId: SpaceId | null;
  readonly role: "edit";
  readonly entry: {
    readonly target: PageShareTarget;
    readonly linkId: string;
    readonly linkVersion: number;
  };
  readonly actorRef:
    | { readonly kind: "share-link"; readonly linkId: string }
    | { readonly kind: "share-member"; readonly memberId: string };
}

export type PageSharingErrorCode = PageSharingRpcError["code"];

/** An owner call failed; the client shows `message` and may branch on `code`. */
export class PageSharingError extends Data.TaggedError("PageSharingError")<{
  readonly code: PageSharingErrorCode;
  readonly message: string;
  readonly currentVersion?: number;
  readonly cause?: unknown;
}> {}

export const pageSharingError = (
  code: PageSharingErrorCode,
  message: string,
  extra: { readonly currentVersion?: number; readonly cause?: unknown } = {},
) => new PageSharingError({ code, message, ...extra });

export interface PageSharingServiceShape {
  /** Internal, side-effect-free host page lookup. A publication resolver must
   * recheck this inside its own read transaction and separately verify owner consent. */
  readonly resolveGuestAppHostPage: (
    input: GuestPageRevisionRequest,
  ) => Effect.Effect<GuestAppHostPage, PageGuestFailure>;
  readonly resolveOwnerAppHostPage: (
    entry: GuestAppHostPage["entry"],
    pageId: PageId,
    revision: number,
    principal: PagesPrincipal,
  ) => Effect.Effect<GuestAppHostPage, PageGuestFailure>;
  /** Internal eligibility inspection only. No room admission, mutation, RPC or relay route. */
  readonly resolveEditableGuestPage: (
    input: PageGuestEditablePageRequest,
  ) => Effect.Effect<GuestPageEditEligibility, PageGuestFailure>;
  /** Internal adapter only; no RPC/relay route grants access to this method yet. */
  readonly resolveReadonlyAppItem: (
    input: PageGuestReadonlyAppItemRequest,
  ) => Effect.Effect<AuthorizedReadonlyAppItem, PageGuestFailure>;
  readonly openReadonlyAppItemPreview: (
    input: PageAppPreviewOpenRequest,
  ) => Effect.Effect<PageAppPreviewOpenResult, PageGuestFailure>;
  readonly consumeReadonlyAppItemPreview: (
    input: PageAppPreviewDocumentRequest,
  ) => Effect.Effect<PageAppPreviewDocument, PageGuestFailure>;
  readonly get: (input: PageShareGetInput) => Effect.Effect<PageShareState, PageSharingError>;
  readonly mutate: (input: PageShareMutateInput) => Effect.Effect<PageShareState, PageSharingError>;
  readonly activity: (
    input: PageShareActivityInput,
  ) => Effect.Effect<PageShareActivityResult, PageSharingError>;
  readonly reply: (
    input: PageShareReplyInput,
  ) => Effect.Effect<PageShareActivityResult, PageSharingError>;
  readonly sitesList: (
    input: PageSitesListInput,
  ) => Effect.Effect<PageSitesListResult, PageSharingError>;
  readonly siteForPage: (
    input: PageSiteForPageInput,
  ) => Effect.Effect<PageSiteForPageResult, PageSharingError>;
  readonly siteMutate: (
    input: PageSiteMutateInput,
  ) => Effect.Effect<PageSiteMutateResult, PageSharingError>;
}

export class PageSharingService extends ServiceMap.Service<
  PageSharingService,
  PageSharingServiceShape
>()("moss/pages/sharing/PageSharingService") {}
