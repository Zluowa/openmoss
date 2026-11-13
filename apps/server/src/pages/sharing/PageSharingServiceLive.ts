import { randomUUID } from "node:crypto";

import {
  DEFAULT_PAGE_SHARE_LINK_SETTING,
  PAGE_GUEST_LIMITS,
  PAGE_GUEST_LINK_PARAM,
  pageShareRoleCanComment,
  PageGuestViewRequest,
  type Page,
  type PageGuestAccessRequest,
  type PageGuestAccessResult,
  type PageGuestComment,
  type PageGuestCommentsRequest,
  type PageGuestCommentsResult,
  type PageGuestMediaRequest,
  type PageGuestView,
  type PageId,
  type PageShareEvent,
  type PageShareLinkSetting,
  type PageShareMember,
  type PageShareRole,
  type PageShareState,
  type PageShareTarget,
  type PageSite,
  type PageSiteVisibility,
  type PageSpace,
  type PageSpaceId,
} from "@moss/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { pageAccessEpoch } from "../pageAccessEpoch";
import { PageRealtimeService } from "../realtime/PageRealtimeService";
import { makeGuestPageProjectionService } from "../guestEditing/GuestPageProjectionService";
import { visibleParagraphs } from "../guestEditing/guestProjectionContent";
import { PageGuestEditHttp } from "../guestEditing/pageGuestEditHttp";
import { isDashboardPayload, parseDashboard } from "@moss/shared/spaceItems/dashboard";
import { buildDashboardSnapshotDocument } from "@moss/shared/spaceItems/dashboardFrame";
import { parseAppItem } from "@moss/shared/spaceItems/itemData";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { pageGuestLibraryImageIds } from "./pageGuestMediaReferences.ts";
import { guestTextThreadOf, newGuestTextThread, withGuestReply } from "./pageGuestTextThreads.ts";

import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService.ts";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { timingSafeEqualBase64Url } from "../../auth/utils.ts";
import { ServerConfig } from "../../config.ts";
import {
  GUEST_SHARE_SIGNING_KEY_BYTES,
  GUEST_SHARE_SIGNING_SECRET_NAME,
} from "../../guestShare/guestShareCredentials.ts";
import { ShareRelayTransport } from "../../guestShare/Services/ShareRelayTransport.ts";
import { LibraryService } from "../../library/Services/LibraryService.ts";
import type { LibraryImage } from "../../library/libraryImage.ts";
import { LOCAL_PAGES_PRINCIPAL, PagesService } from "../Services/PagesService.ts";
import { decideLinkEntry, descendantPageIds, effectiveLinkSetting } from "./pageShareAccess.ts";
import {
  hashRequestSecret,
  isLinkCredential,
  isSiteCredential,
  linkCredential,
  memberCredential,
  parseMemberCredential,
  randomMemberId,
  randomRequestSecret,
  randomShareId,
  siteCredential,
} from "./pageShareCredentials.ts";
import {
  handlePageGuestRequest,
  pageGuestFailure,
  PageGuestFailure,
  type PageGuestOperations,
} from "./pageGuestHandler.ts";
import { makePageSharePublisher, type PageSharePublisher } from "./pageSharePublisher.ts";
import { PageAppPreviewTickets, pageAppPreviewIssuer } from "./pageAppPreviewTickets.ts";
import { preparePageAppPreviewDocument } from "./pageAppPreviewDocument.ts";
import { PageAppsService } from "../apps/PageAppsService.ts";
import { makePageAppPublicationsFor } from "./pageAppPublications.ts";
import { publishedGuestDocument } from "./publishedPageAppPreview.ts";
import type { TicketSource } from "./pageAppPreviewTickets.ts";
import type { PageAppPreviewDocument } from "./pageAppPreviewDocument.ts";
import {
  PageSharingService,
  pageSharingError,
  type PageSharingError,
  type PageSharingServiceShape,
  type AuthorizedReadonlyAppItem,
  type GuestPageEditEligibility,
} from "./PageSharingService.ts";
import {
  makePageSharingStore,
  scopeFromKey,
  scopeKey,
  type EventRow,
  type LinkRow,
  type MemberRow,
  type NewEvent,
  type Scope,
  type SiteRow,
} from "./pageSharingStore.ts";

const TERMS_META_KEY = "terms_accepted_at";
/** The share dialog should not hang on a slow relay: it shows the link once it is ready. */
const PUBLISHER_WAIT = "5 seconds";
const VIEWS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Visitor opens and guest actions are kept for half a year. */
const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

const settingOf = (row: LinkRow | null): PageShareLinkSetting | null =>
  row !== null && row.access !== null && row.role !== null
    ? { access: row.access, role: row.role }
    : null;

const siteKindOf = (page: Page) => (page.kind === "app" ? "app" : "page");
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const targetPageId = (target: PageShareTarget) => (target.kind === "page" ? target.id : null);

type ShareEntry = {
  readonly mode: "share";
  readonly target: PageShareTarget;
  readonly scope: Scope;
  readonly role: PageShareRole;
  readonly member: MemberRow | null;
  readonly title: string;
  readonly rootPageId: PageId;
  readonly pages: ReadonlyArray<Page>;
  readonly link: Pick<LinkRow, "link_id" | "version">;
};
type SiteEntry = { readonly mode: "site"; readonly site: SiteRow; readonly scope: Scope };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionEpoch = pageAccessEpoch(sql);
  const store = yield* makePageSharingStore;
  const pages = yield* PagesService;
  const appService = yield* Effect.serviceOption(PageAppsService);
  const library = yield* LibraryService;
  const secretStore = yield* ServerSecretStore;
  const transport = yield* ShareRelayTransport;
  const realtime = yield* Effect.serviceOption(PageRealtimeService);
  const editEnabled = transport.env.MOSS_PAGE_GUEST_EDIT_ENABLED === "1";
  const serverConfig = yield* Effect.serviceOption(ServerConfig);
  const phoneAccount = yield* MossPhoneAccountService;
  const cloudAccount = yield* MossCloudAccountService;
  const services = yield* Effect.services<never>();
  // The guest-share key: one server secret signs every guest credential of this Moss.
  const signingKey = yield* secretStore
    .getOrCreateRandom(GUEST_SHARE_SIGNING_SECRET_NAME, GUEST_SHARE_SIGNING_KEY_BYTES)
    .pipe(Effect.orDie);

  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        pageSharingError("storage", "分享设置读写失败，请重试。", { cause }),
      ),
    );
  const guestStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => pageGuestFailure("unavailable", cause)));

  const recordEvent = (event: NewEvent) =>
    store.insertEvent({ ...event, event_id: randomUUID(), created_at: now() });
  const ownerEvent = (
    target: { kind: "page" | "space" | "site"; id: string },
    pageId: string | null,
    action: PageShareEvent["action"],
  ) =>
    recordEvent({
      target_kind: target.kind,
      target_id: target.id,
      page_id: pageId,
      action,
      actor_kind: "owner",
      actor_name: null,
      visitor_id: null,
    });

  // ── Pages lookups ─────────────────────────────────────────────────
  const notFound = (cause?: unknown) =>
    pageSharingError("not-found", "找不到这个页面或资料空间。", { cause });
  const readPage = (scope: Scope, pageId: PageId) =>
    pages.read({ scopeSpaceId: scope, pageId }, LOCAL_PAGES_PRINCIPAL);
  /** Slides guests get the deck as of the page revision they are shown. */
  const guestDeck = (page: Page) =>
    page.kind === "slides"
      ? store.getDeckData(page.id, page.revision).pipe(
          Effect.map((data): { deck?: string } => (data ? { deck: data } : {})),
          Effect.orElseSucceed((): { deck?: string } => ({})),
        )
      : Effect.succeed<{ deck?: string }>({});
  const loadPage = (scope: Scope, pageId: PageId) =>
    readPage(scope, pageId).pipe(
      Effect.map((result) => result.page),
      Effect.mapError(notFound),
    );
  const loadSpace = (scope: Scope, spaceId: PageSpaceId) =>
    pages.spaces({ scopeSpaceId: scope }, LOCAL_PAGES_PRINCIPAL).pipe(
      Effect.mapError(notFound),
      Effect.flatMap((result) => {
        const space = result.spaces.find((candidate) => candidate.id === spaceId);
        return space === undefined ? Effect.fail(notFound()) : Effect.succeed(space);
      }),
    );
  const listPages = (scope: Scope) =>
    pages
      .list({ scopeSpaceId: scope }, LOCAL_PAGES_PRINCIPAL)
      .pipe(Effect.map((result) => result.pages));

  // ── Publisher (the relay connection) ──────────────────────────────
  const run = Effect.runPromiseWith(services);
  const publisher: PageSharePublisher = yield* makePageSharePublisher({
    store,
    signingKey,
    transport,
    accountSources: { phoneAccount, cloudAccount, env: transport.env },
    handle: (request) =>
      run(handlePageGuestRequest(guestOperations, request), { signal: request.signal }),
  });
  const publisherSoon = publisher.ensure.pipe(
    Effect.timeout(PUBLISHER_WAIT),
    Effect.catchCause((cause) =>
      Effect.logDebug("The page share publisher is not ready.", { cause: String(cause) }),
    ),
  );
  const registeredPreviewIssuer = () => {
    const registration = publisher.registration();
    const issuer = pageAppPreviewIssuer(
      registration,
      transport.env.MOSS_PAGE_APP_PREVIEW_CONTENT_ORIGIN,
    );
    return issuer &&
      registration?.appPreview?.protocolVersion === 1 &&
      registration.appPreview.contentOrigin === issuer.contentOrigin
      ? issuer
      : null;
  };
  const brokerEnabled = () =>
    registeredPreviewIssuer() !== null &&
    publisher.registration()?.appPreview?.brokerProtocol === 1;
  const previewAvailability = (kind: Page["kind"], richContent?: string | null) => {
    const mayReferenceApp =
      (kind ?? "page") === "page" &&
      Option.isSome(appService) &&
      richContent?.includes('"moss_visualization"');
    const issuer = kind === "app" || mayReferenceApp ? registeredPreviewIssuer() : null;
    return issuer
      ? {
          appPreview: {
            protocolVersion: 1 as const,
            contentOrigin: issuer.contentOrigin,
            ...(mayReferenceApp && brokerEnabled() ? { brokerProtocol: 1 as const } : {}),
          },
        }
      : {};
  };
  const editIssuer = (): ReturnType<PageSharePublisher["registration"]> => {
    const registration = publisher.registration();
    return editEnabled &&
      transport.env.MOSS_PAGE_GUEST_EDIT_ENABLED === "1" &&
      registration?.editProjection?.v === 1 &&
      Option.isSome(realtime)
      ? registration
      : null;
  };
  const editAvailability = (role: PageShareRole, page: Page, rich: string | undefined) => {
    if (role !== "edit" || (page.kind ?? "page") !== "page" || !rich || !editIssuer()) return {};
    try {
      visibleParagraphs(rich);
      return { editProjection: { v: 1 as const } };
    } catch {
      return {};
    }
  };

  const linkUrl = (linkId: string) => {
    const base = publisher.pageBase();
    return base === null
      ? null
      : `${base}?${PAGE_GUEST_LINK_PARAM}=${linkId}#${linkCredential(signingKey, linkId)}`;
  };
  const memberUrl = (memberId: string) => {
    const base = publisher.pageBase();
    return base === null ? null : `${base}#${memberCredential(signingKey, memberId)}`;
  };
  const siteUrl = (site: SiteRow) => {
    const base = publisher.pageBase();
    if (base === null || site.published_at === null || site.visibility === "private") return null;
    const url = `${base}?${PAGE_GUEST_LINK_PARAM}=${site.link_id}`;
    return site.visibility === "link" ? `${url}#${siteCredential(signingKey, site.link_id)}` : url;
  };

  // ── Owner: share settings ─────────────────────────────────────────
  const ensureLink = (target: PageShareTarget, scope: Scope) =>
    Effect.gen(function* () {
      const existing = yield* store.getLink(target.kind, target.id);
      if (existing !== null) return existing;
      const timestamp = now();
      yield* store.insertLink({
        target_kind: target.kind,
        target_id: target.id,
        scope_key: scopeKey(scope),
        link_id: randomShareId(),
        access: null,
        role: null,
        version: 0,
        created_at: timestamp,
        updated_at: timestamp,
      });
      const inserted = yield* store.getLink(target.kind, target.id);
      return inserted!;
    });

  const memberOf = (row: MemberRow, source: "page" | "space"): PageShareMember => ({
    id: row.member_id,
    name: row.name,
    contact: row.contact,
    role: row.role,
    source,
    url: memberUrl(row.member_id),
    createdAt: row.created_at,
  });

  /** The space a page inherits from, with the space's link setting. */
  const inheritanceOf = (scope: Scope, page: Page) =>
    Effect.gen(function* () {
      if (page.spaceId === null) return null;
      const space = yield* loadSpace(scope, page.spaceId);
      const row = yield* storage(store.getLink("space", space.id));
      return {
        spaceId: space.id,
        title: space.title,
        setting: settingOf(row) ?? DEFAULT_PAGE_SHARE_LINK_SETTING,
      };
    });

  const targetTitle = (scope: Scope, target: PageShareTarget) =>
    target.kind === "page"
      ? loadPage(scope, target.id).pipe(Effect.map((page) => ({ page, title: page.title })))
      : loadSpace(scope, target.id).pipe(
          Effect.map((space: PageSpace) => ({ page: null, title: space.title })),
        );

  const stateOf = (scope: Scope, target: PageShareTarget) =>
    Effect.gen(function* () {
      const { page, title } = yield* targetTitle(scope, target);
      const inheritedFrom = page === null ? null : yield* inheritanceOf(scope, page);
      const link = yield* storage(ensureLink(target, scope));
      const direct = settingOf(link);
      const ownMembers = yield* storage(store.listMembers(target.kind, target.id));
      const spaceMembers =
        inheritedFrom === null
          ? []
          : yield* storage(store.listMembers("space", inheritedFrom.spaceId));
      const requests = yield* storage(store.listPendingRequests(target.kind, target.id));
      return {
        target,
        title,
        scopeSpaceId: scope,
        inheritedFrom,
        direct,
        effective: effectiveLinkSetting(direct, inheritedFrom?.setting ?? null),
        linkUrl: linkUrl(link.link_id),
        appPublicationEntryId: link.link_id,
        members: [
          ...ownMembers.map((row) => memberOf(row, target.kind)),
          ...spaceMembers.map((row) => memberOf(row, "space")),
        ],
        requests: requests.map((row) => ({
          id: row.request_id,
          name: row.name,
          contact: row.contact,
          note: row.note,
          role: row.role,
          createdAt: row.created_at,
        })),
        version: link.version,
        relayStatus: publisher.status(),
      } satisfies PageShareState;
    });

  const get: PageSharingServiceShape["get"] = (input) =>
    Effect.gen(function* () {
      yield* targetTitle(input.scopeSpaceId, input.target);
      yield* publisherSoon;
      return yield* stateOf(input.scopeSpaceId, input.target);
    });

  const mutate: PageSharingServiceShape["mutate"] = (input) =>
    Effect.gen(function* () {
      const scope = input.scopeSpaceId;
      const { target } = input;
      const { page } = yield* targetTitle(scope, target);
      if (page?.trashedAt) {
        return yield* pageSharingError("invalid", "回收站中的页面不能分享。");
      }
      const link = yield* storage(ensureLink(target, scope));
      const conflict = () =>
        pageSharingError("conflict", "分享设置刚刚被修改过，已为你刷新。", {
          currentVersion: link.version,
        });
      switch (input.op) {
        case "set-link": {
          if (input.expectedVersion !== link.version) return yield* conflict();
          if (input.setting !== null && page !== null) {
            const inherited = yield* inheritanceOf(scope, page);
            const effective = effectiveLinkSetting(input.setting, inherited?.setting ?? null);
            if (
              effective.access !== input.setting.access ||
              effective.role !== input.setting.role
            ) {
              return yield* pageSharingError(
                "invalid",
                "页面的访问权限不能低于资料空间。请选择更高的权限，或使用资料空间的访问权限。",
              );
            }
          }
          yield* storage(
            store.updateLinkSetting(
              target.kind,
              target.id,
              input.setting?.access ?? null,
              input.setting?.role ?? null,
              now(),
            ),
          );
          yield* storage(ownerEvent(target, targetPageId(target), "link-changed"));
          break;
        }
        case "rotate-link": {
          if (input.expectedVersion !== link.version) return yield* conflict();
          yield* storage(store.rotateLink(target.kind, target.id, randomShareId(), now()));
          yield* storage(ownerEvent(target, targetPageId(target), "link-rotated"));
          break;
        }
        case "invite": {
          yield* storage(
            store.insertMember({
              member_id: randomMemberId(),
              target_kind: target.kind,
              target_id: target.id,
              name: input.name,
              contact: input.contact ?? null,
              role: input.role,
              created_at: now(),
            }),
          );
          yield* storage(ownerEvent(target, targetPageId(target), "invited"));
          yield* publisherSoon;
          break;
        }
        case "set-member": {
          const member = yield* storage(store.getMember(input.memberId));
          if (
            member === null ||
            member.target_kind !== target.kind ||
            member.target_id !== target.id
          ) {
            return yield* pageSharingError("not-found", "这位成员已不在列表中。");
          }
          if (input.role === null) {
            yield* storage(store.deleteMember(member.member_id));
            yield* storage(ownerEvent(target, targetPageId(target), "member-removed"));
          } else {
            yield* storage(store.updateMemberRole(member.member_id, input.role));
            yield* storage(ownerEvent(target, targetPageId(target), "member-changed"));
          }
          break;
        }
        case "decide-request": {
          const request = yield* storage(store.getRequest(input.requestId));
          if (
            request === null ||
            request.status !== "pending" ||
            request.target_kind !== target.kind ||
            request.target_id !== target.id
          ) {
            return yield* pageSharingError("not-found", "这条访问请求已处理或已失效。");
          }
          if (input.decision === "approve") {
            const memberId = randomMemberId();
            yield* storage(
              store.transaction(
                Effect.gen(function* () {
                  yield* store.insertMember({
                    member_id: memberId,
                    target_kind: target.kind,
                    target_id: target.id,
                    name: request.name,
                    contact: request.contact,
                    role: input.role ?? request.role,
                    created_at: now(),
                  });
                  yield* store.decideRequest(request.request_id, "approved", memberId, now());
                }),
              ),
            );
            yield* storage(ownerEvent(target, targetPageId(target), "approved"));
          } else {
            yield* storage(store.decideRequest(request.request_id, "rejected", null, now()));
            yield* storage(ownerEvent(target, targetPageId(target), "rejected"));
          }
          break;
        }
      }
      return yield* stateOf(scope, target);
    });

  const guestCommentOf = (row: {
    readonly comment_id: string;
    readonly page_id: string;
    readonly author_kind: "owner" | "member" | "guest";
    readonly author_name: string;
    readonly content: string;
    readonly created_at: string;
  }): PageGuestComment => ({
    id: row.comment_id,
    pageId: row.page_id as PageId,
    authorKind: row.author_kind,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
  });
  const eventOf = (row: EventRow): PageShareEvent => ({
    id: row.event_id,
    action: row.action as PageShareEvent["action"],
    actorKind: row.actor_kind,
    actorName: row.actor_name,
    pageId: row.page_id as PageId | null,
    createdAt: row.created_at,
  });

  const activity: PageSharingServiceShape["activity"] = (input) =>
    Effect.gen(function* () {
      yield* loadPage(input.scopeSpaceId, input.pageId);
      const comments = yield* storage(store.listGuestComments(input.pageId));
      const events = yield* storage(store.listPageEvents(input.pageId));
      return { comments: comments.map(guestCommentOf), events: events.map(eventOf) };
    });

  const reply: PageSharingServiceShape["reply"] = (input) =>
    Effect.gen(function* () {
      yield* loadPage(input.scopeSpaceId, input.pageId);
      yield* storage(
        store.insertGuestComment({
          comment_id: randomUUID(),
          page_id: input.pageId,
          author_kind: "owner",
          author_name: "owner",
          member_id: null,
          visitor_id: null,
          content: input.content,
          created_at: now(),
        }),
      );
      return yield* activity(input);
    });

  // ── Owner: sites ──────────────────────────────────────────────────
  const siteOf = (
    row: SiteRow,
    page: Page | undefined,
  ): Effect.Effect<PageSite, PageSharingError> =>
    Effect.gen(function* () {
      const views30d = yield* storage(store.countSiteOpens(row.site_id, ago(VIEWS_WINDOW_MS)));
      return {
        id: row.site_id,
        pageId: row.page_id as PageId,
        scopeSpaceId: scopeFromKey(row.scope_key),
        kind: row.kind,
        title: row.title,
        visibility: row.visibility,
        published: row.published_at !== null,
        publishedRevision: row.published_revision,
        publishedAt: row.published_at,
        hasUnpublishedChanges:
          page !== undefined &&
          row.published_revision !== null &&
          page.revision !== row.published_revision,
        updatedAt: row.updated_at,
        pinned: row.pinned !== 0,
        url: siteUrl(row),
        views30d,
      } satisfies PageSite;
    });

  const termsAccepted = storage(store.getMeta(TERMS_META_KEY)).pipe(
    Effect.map((value) => value !== null),
  );

  const sitesList: PageSharingServiceShape["sitesList"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* storage(store.listSites(input.scopeSpaceId));
      const byId = new Map(
        (yield* listPages(input.scopeSpaceId).pipe(Effect.mapError(notFound))).map((page) => [
          page.id as string,
          page,
        ]),
      );
      if (rows.some((row) => row.published_at !== null && row.visibility !== "private")) {
        yield* publisherSoon;
      }
      const live = rows.filter((row) => {
        const page = byId.get(row.page_id);
        return page !== undefined && page.trashedAt === null;
      });
      const sites = yield* Effect.forEach(live, (row) => siteOf(row, byId.get(row.page_id)));
      return {
        sites,
        termsAccepted: yield* termsAccepted,
        relayStatus: publisher.status(),
      };
    });

  const siteForPage: PageSharingServiceShape["siteForPage"] = (input) =>
    Effect.gen(function* () {
      const page = yield* loadPage(input.scopeSpaceId, input.pageId);
      const row = yield* storage(store.getSiteByPage(page.id));
      if (row !== null && row.published_at !== null && row.visibility !== "private") {
        yield* publisherSoon;
      }
      return {
        site: row === null ? null : yield* siteOf(row, page),
        termsAccepted: yield* termsAccepted,
      };
    });

  const siteMutate: PageSharingServiceShape["siteMutate"] = (input) =>
    Effect.gen(function* () {
      const scope = input.scopeSpaceId;
      const loadSite = (siteId: string) =>
        storage(store.getSite(siteId)).pipe(
          Effect.flatMap((row) =>
            row === null || row.scope_key !== scopeKey(scope)
              ? Effect.fail(pageSharingError("not-found", "找不到这个站点。"))
              : Effect.succeed(row),
          ),
        );
      const needsRelay = (visibility: PageSiteVisibility) =>
        visibility === "private" ? Effect.void : publisherSoon;
      let row: SiteRow;
      switch (input.op) {
        case "publish": {
          const page = yield* loadPage(scope, input.pageId);
          if (page.trashedAt !== null) {
            return yield* pageSharingError("invalid", "回收站中的页面不能发布。");
          }
          if (!(yield* termsAccepted)) {
            if (input.acceptTerms !== true) {
              return yield* pageSharingError(
                "terms-required",
                "首次发布前请先阅读并同意发布须知。",
              );
            }
            yield* storage(store.setMeta(TERMS_META_KEY, now()));
          }
          const existing = yield* storage(store.getSiteByPage(page.id));
          const timestamp = now();
          row = {
            site_id: existing?.site_id ?? randomUUID(),
            page_id: page.id,
            scope_key: scopeKey(scope),
            kind: siteKindOf(page),
            title: page.title,
            visibility: input.visibility,
            link_id: existing?.link_id ?? randomShareId(),
            published_revision: page.revision,
            published_at: timestamp,
            pinned: existing?.pinned ?? 0,
            created_at: existing?.created_at ?? timestamp,
            updated_at: timestamp,
          };
          yield* storage(store.upsertSite(row));
          yield* storage(ownerEvent({ kind: "site", id: row.site_id }, page.id, "published"));
          yield* needsRelay(row.visibility);
          return { site: yield* siteOf(row, page) };
        }
        case "set-visibility": {
          const existing = yield* loadSite(input.siteId);
          row = { ...existing, visibility: input.visibility, updated_at: now() };
          yield* storage(store.upsertSite(row));
          yield* storage(
            ownerEvent({ kind: "site", id: row.site_id }, row.page_id, "visibility-changed"),
          );
          yield* needsRelay(row.visibility);
          break;
        }
        case "unpublish": {
          const existing = yield* loadSite(input.siteId);
          row = { ...existing, published_at: null, published_revision: null, updated_at: now() };
          yield* storage(store.upsertSite(row));
          yield* storage(ownerEvent({ kind: "site", id: row.site_id }, row.page_id, "unpublished"));
          break;
        }
        case "pin": {
          const existing = yield* loadSite(input.siteId);
          // Pinning is a list preference: it does not move the site's "updated" time.
          row = { ...existing, pinned: input.pinned ? 1 : 0 };
          yield* storage(store.upsertSite(row, false));
          break;
        }
      }
      const page = yield* loadPage(scope, row.page_id as PageId).pipe(
        Effect.option,
        Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
      );
      return { site: yield* siteOf(row, page) };
    });

  // ── Guests ────────────────────────────────────────────────────────
  const shareEntryFor = (
    link: LinkRow,
    role: PageShareRole,
    member: MemberRow | null,
  ): Effect.Effect<ShareEntry, PageGuestFailure> =>
    Effect.gen(function* () {
      const scope = scopeFromKey(link.scope_key);
      const all = yield* listPages(scope).pipe(
        Effect.mapError((cause) => pageGuestFailure("unavailable", cause)),
      );
      const live = all.filter((page) => page.trashedAt === null);
      if (link.target_kind === "page") {
        const root = live.find((page) => page.id === link.target_id);
        if (root === undefined) return yield* pageGuestFailure("unavailable");
        const allowed = descendantPageIds(root.id, live);
        return {
          mode: "share",
          target: { kind: "page", id: root.id },
          scope,
          role,
          member,
          title: root.title,
          rootPageId: root.id,
          pages: live.filter((page) => allowed.has(page.id)),
          link,
        };
      }
      const space = yield* pages.spaces({ scopeSpaceId: scope }, LOCAL_PAGES_PRINCIPAL).pipe(
        Effect.map((result) => result.spaces.find((candidate) => candidate.id === link.target_id)),
        Effect.mapError((cause) => pageGuestFailure("unavailable", cause)),
      );
      if (space === undefined || space.trashedAt !== null) {
        return yield* pageGuestFailure("unavailable");
      }
      return {
        mode: "share",
        target: { kind: "space", id: space.id },
        scope,
        role,
        member,
        title: space.title,
        rootPageId: space.rootPageId,
        pages: live.filter((page) => page.spaceId === space.id),
        link,
      };
    });

  const linkSettingFor = (link: LinkRow) =>
    Effect.gen(function* () {
      const direct = settingOf(link);
      if (link.target_kind === "space") return direct ?? DEFAULT_PAGE_SHARE_LINK_SETTING;
      const scope = scopeFromKey(link.scope_key);
      const page = yield* readPage(scope, link.target_id as PageId).pipe(
        Effect.map((result) => result.page),
        Effect.mapError((cause) => pageGuestFailure("unavailable", cause)),
      );
      const inherited =
        page.spaceId === null
          ? null
          : settingOf(yield* guestStorage(store.getLink("space", page.spaceId)));
      return effectiveLinkSetting(direct, inherited);
    });

  const resolveEntry = (request: {
    readonly link?: string | undefined;
    readonly key?: string | undefined;
  }): Effect.Effect<ShareEntry | SiteEntry, PageGuestFailure> =>
    Effect.gen(function* () {
      const key = request.key;
      if (key !== undefined && key.startsWith("m.")) {
        const memberId = parseMemberCredential(signingKey, key);
        if (memberId === null) return yield* pageGuestFailure("forbidden");
        const member = yield* guestStorage(store.getMember(memberId));
        if (member === null) return yield* pageGuestFailure("unavailable");
        const link = yield* guestStorage(store.getLink(member.target_kind, member.target_id));
        if (link === null) return yield* pageGuestFailure("unavailable");
        return yield* shareEntryFor(link, member.role, member);
      }
      if (request.link === undefined) return yield* pageGuestFailure("unavailable");
      const link = yield* guestStorage(store.getLinkById(request.link));
      if (link !== null) {
        const setting = yield* linkSettingFor(link);
        const decision = decideLinkEntry(
          setting,
          key === undefined ? null : isLinkCredential(signingKey, link.link_id, key),
        );
        if (!decision.ok) return yield* pageGuestFailure(decision.reason);
        return yield* shareEntryFor(link, decision.role, null);
      }
      const site = yield* guestStorage(store.getSiteByLink(request.link));
      if (site === null || site.visibility === "private") {
        return yield* pageGuestFailure("unavailable");
      }
      if (site.published_at === null) return yield* pageGuestFailure("unpublished");
      if (
        site.visibility === "link" &&
        (key === undefined || !isSiteCredential(signingKey, site.link_id, key))
      ) {
        return yield* pageGuestFailure("forbidden");
      }
      return { mode: "site", site, scope: scopeFromKey(site.scope_key) } satisfies SiteEntry;
    });

  const recordOpen = (
    target: { kind: "page" | "space" | "site"; id: string },
    pageId: string,
    visitor: string,
    member: MemberRow | null,
  ) =>
    Effect.gen(function* () {
      if (yield* store.hasRecentOpen(target, pageId, visitor, ago(PAGE_GUEST_LIMITS.openDedupeMs)))
        return;
      yield* recordEvent({
        target_kind: target.kind,
        target_id: target.id,
        page_id: pageId,
        action: "opened",
        actor_kind: member === null ? "visitor" : "member",
        actor_name: member?.name ?? null,
        visitor_id: visitor,
      });
    }).pipe(Effect.ignore);

  // Share one page-selection path between the public view and internal publication
  // checks. An internal recheck must not count as another visitor opening the page.
  const readEntryPage = (entry: ShareEntry | SiteEntry, selectedPage?: PageId) =>
    Effect.gen(function* () {
      if (entry.mode === "site") {
        const { site } = entry;
        const unavailable = (cause: unknown) => pageGuestFailure("unavailable", cause);
        const current = yield* readPage(entry.scope, site.page_id as PageId).pipe(
          Effect.mapError(unavailable),
        );
        if (current.page.trashedAt !== null) return yield* pageGuestFailure("unavailable");
        // Guests see the published revision; edits since then wait for the next publish.
        const result = yield* pages
          .read(
            {
              scopeSpaceId: entry.scope,
              pageId: site.page_id as PageId,
              revision: site.published_revision!,
            },
            LOCAL_PAGES_PRINCIPAL,
          )
          .pipe(Effect.mapError(unavailable));
        return { entry, result };
      }
      const pageId = selectedPage ?? entry.rootPageId;
      if (!entry.pages.some((page) => page.id === pageId))
        return yield* pageGuestFailure("forbidden");
      const result = yield* readPage(entry.scope, pageId).pipe(
        Effect.mapError((cause) => pageGuestFailure("unavailable", cause)),
      );
      return { entry, result };
    });

  const resolveGuestPageSnapshot = (request: PageGuestViewRequest) =>
    resolveEntry(request).pipe(Effect.flatMap((entry) => readEntryPage(entry, request.pageId)));

  const view = (request: PageGuestViewRequest): Effect.Effect<PageGuestView, PageGuestFailure> =>
    Effect.gen(function* () {
      const { entry, result } = yield* resolveGuestPageSnapshot(request);
      if (entry.mode === "site") {
        const { site } = entry;
        yield* recordOpen({ kind: "site", id: site.site_id }, site.page_id, request.visitor, null);
        return {
          mode: "site",
          ...previewAvailability(result.page.kind, result.richContent),
          title: site.title,
          role: "view",
          viewerName: null,
          pages: [{ id: result.page.id, title: result.page.title, parentId: null }],
          page: {
            id: result.page.id,
            title: result.page.title,
            kind: site.kind,
            revision: result.page.revision,
            updatedAt: site.published_at!,
            content: result.content,
            ...(result.richContent === undefined ? {} : { richContent: result.richContent }),
            ...(yield* guestDeck(result.page)),
          },
          canComment: false,
          canLoadImages: true,
        } satisfies PageGuestView;
      }
      yield* recordOpen(entry.target, result.page.id, request.visitor, entry.member);
      const visible = new Set(entry.pages.map((page) => page.id as string));
      return {
        mode: "share",
        ...previewAvailability(result.page.kind, result.richContent),
        ...editAvailability(entry.role, result.page, result.richContent),
        title: entry.title,
        role: entry.role,
        viewerName: entry.member?.name ?? null,
        pages: entry.pages.map((page) => ({
          id: page.id,
          title: page.title,
          parentId:
            page.parentPageId !== null && visible.has(page.parentPageId) ? page.parentPageId : null,
        })),
        page: {
          id: result.page.id,
          title: result.page.title,
          kind: siteKindOf(result.page),
          revision: result.page.revision,
          updatedAt: result.page.updatedAt,
          content: result.content,
          ...(result.richContent === undefined ? {} : { richContent: result.richContent }),
          ...(yield* guestDeck(result.page)),
        },
        canComment: pageShareRoleCanComment(entry.role),
        canLoadImages: true,
      } satisfies PageGuestView;
    });

  const comments = (
    request: PageGuestCommentsRequest,
  ): Effect.Effect<PageGuestCommentsResult, PageGuestFailure> =>
    Effect.gen(function* () {
      const entry = yield* resolveEntry(request);
      if (entry.mode === "site" || !entry.pages.some((page) => page.id === request.pageId)) {
        return yield* pageGuestFailure("forbidden");
      }
      if (request.action === "add-text" || request.action === "reply-text") {
        if (!pageShareRoleCanComment(entry.role)) return yield* pageGuestFailure("forbidden");
        const name = entry.member?.name ?? request.name;
        if (name === undefined) return yield* pageGuestFailure("invalid");
        // Every comment a visitor leaves on this page, whole-page or on words, is a "commented" event.
        const recent = yield* guestStorage(
          store.countRecentEventsByVisitor(
            request.pageId,
            request.visitor,
            "commented",
            ago(60 * 60 * 1000),
          ),
        );
        if (recent >= PAGE_GUEST_LIMITS.commentsPerVisitorPerHour) {
          return yield* pageGuestFailure("rate-limited");
        }
        const author = {
          kind: entry.member === null ? ("guest" as const) : ("member" as const),
          name,
        };
        const createdAt = now();
        if (request.action === "add-text") {
          const id = `g${randomUUID().replaceAll("-", "")}`;
          yield* guestStorage(
            store.saveTextComment(
              request.pageId,
              id,
              newGuestTextThread({
                id,
                pageId: request.pageId,
                anchor: request.anchor,
                author,
                body: request.content,
                createdAt,
              }),
              createdAt,
            ),
          );
        } else {
          const stored = yield* guestStorage(
            store.getTextComment(request.pageId, request.threadId),
          );
          const thread = stored === null ? null : guestTextThreadOf(stored);
          if (stored === null || thread === null || thread.resolved)
            return yield* pageGuestFailure("invalid");
          const next = withGuestReply(stored, {
            id: randomUUID(),
            author,
            body: request.content,
            createdAt,
          });
          if (next === null) return yield* pageGuestFailure("invalid");
          yield* guestStorage(
            store.saveTextComment(request.pageId, request.threadId, next, createdAt),
          );
        }
        yield* guestStorage(
          recordEvent({
            target_kind: entry.target.kind,
            target_id: entry.target.id,
            page_id: request.pageId,
            action: "commented",
            actor_kind: author.kind,
            actor_name: name,
            visitor_id: request.visitor,
          }),
        );
      }
      if (request.action === "add") {
        if (!pageShareRoleCanComment(entry.role)) return yield* pageGuestFailure("forbidden");
        const name = entry.member?.name ?? request.name;
        if (name === undefined) return yield* pageGuestFailure("invalid");
        const recent = yield* guestStorage(
          store.countRecentCommentsByVisitor(request.pageId, request.visitor, ago(60 * 60 * 1000)),
        );
        if (recent >= PAGE_GUEST_LIMITS.commentsPerVisitorPerHour) {
          return yield* pageGuestFailure("rate-limited");
        }
        yield* guestStorage(
          store.insertGuestComment({
            comment_id: randomUUID(),
            page_id: request.pageId,
            author_kind: entry.member === null ? "guest" : "member",
            author_name: name,
            member_id: entry.member?.member_id ?? null,
            visitor_id: request.visitor,
            content: request.content,
            created_at: now(),
          }),
        );
        yield* guestStorage(
          recordEvent({
            target_kind: entry.target.kind,
            target_id: entry.target.id,
            page_id: request.pageId,
            action: "commented",
            actor_kind: entry.member === null ? "guest" : "member",
            actor_name: name,
            visitor_id: request.visitor,
          }),
        );
      }
      const rows = yield* guestStorage(store.listGuestComments(request.pageId));
      // Comments on words include the owner's own review notes and Moss's answers: only links
      // that may comment see them. A view-only link gets the page, not the conversation about it.
      const threads = pageShareRoleCanComment(entry.role)
        ? yield* guestStorage(store.listTextComments(request.pageId))
        : [];
      return {
        comments: rows.map(guestCommentOf),
        textThreads: threads.flatMap((row) => {
          const thread = guestTextThreadOf(row.thread_json);
          return thread ? [thread] : [];
        }),
      };
    });

  const access = (
    request: PageGuestAccessRequest,
  ): Effect.Effect<PageGuestAccessResult, PageGuestFailure> =>
    Effect.gen(function* () {
      if (request.action === "status") {
        const row = yield* guestStorage(store.getRequest(request.requestId));
        if (
          row === null ||
          !timingSafeEqualBase64Url(hashRequestSecret(request.secret), row.secret_hash)
        ) {
          return yield* pageGuestFailure("unavailable");
        }
        const member =
          row.member_id === null ? null : yield* guestStorage(store.getMember(row.member_id));
        return {
          requestId: row.request_id,
          status: row.status === "approved" && member === null ? "rejected" : row.status,
          ...(member === null ? {} : { key: memberCredential(signingKey, member.member_id) }),
        };
      }
      if (request.link === undefined) return yield* pageGuestFailure("unavailable");
      const link = yield* guestStorage(store.getLinkById(request.link));
      if (link === null) return yield* pageGuestFailure("unavailable");
      const pending = yield* guestStorage(
        store.listPendingRequests(link.target_kind, link.target_id),
      );
      const recent = yield* guestStorage(
        store.countRecentRequestsByVisitor(request.visitor, ago(60 * 60 * 1000)),
      );
      if (
        pending.length >= PAGE_GUEST_LIMITS.pendingRequestsPerTarget ||
        recent >= PAGE_GUEST_LIMITS.requestsPerVisitorPerHour
      ) {
        return yield* pageGuestFailure("rate-limited");
      }
      const requestId = randomUUID();
      const secret = randomRequestSecret();
      yield* guestStorage(
        store.insertRequest({
          request_id: requestId,
          target_kind: link.target_kind,
          target_id: link.target_id,
          name: request.name,
          contact: request.contact ?? null,
          note: request.note ?? null,
          role: request.role,
          secret_hash: hashRequestSecret(secret),
          visitor_id: request.visitor,
          status: "pending",
          member_id: null,
          created_at: now(),
          decided_at: null,
        }),
      );
      yield* guestStorage(
        recordEvent({
          target_kind: link.target_kind,
          target_id: link.target_id,
          page_id: link.target_kind === "page" ? link.target_id : null,
          action: "requested",
          actor_kind: "guest",
          actor_name: request.name,
          visitor_id: request.visitor,
        }),
      );
      return { requestId, secret, status: "pending" };
    });

  const media = (request: PageGuestMediaRequest): Effect.Effect<LibraryImage, PageGuestFailure> =>
    Effect.gen(function* () {
      // Reuse the same entry resolution, page visibility and frozen site revision as the view.
      // Nothing is cached across requests: changing a link/member/site takes effect immediately.
      const authorized = yield* view(request);
      if (authorized.page.id !== request.pageId || authorized.page.revision !== request.revision)
        return yield* pageGuestFailure("unavailable");
      let referenced = false;
      try {
        const nodes = parsePageRichContent(authorized.page.richContent ?? "[]").nodes;
        referenced = pageGuestLibraryImageIds(nodes).has(request.itemId);
      } catch {
        // Invalid stored rich content never grants media access.
      }
      if (!referenced) return yield* pageGuestFailure("forbidden");
      const image = yield* library
        .readImage(request.itemId)
        .pipe(Effect.mapError(() => pageGuestFailure("unavailable")));
      return image ?? (yield* pageGuestFailure("unavailable"));
    });

  const appHostAt = (entry: ShareEntry | SiteEntry, pageId: PageId, revision: number) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(revision) || revision < 1)
        return yield* pageGuestFailure("invalid");
      const { result } = yield* readEntryPage(entry, pageId);
      const { page } = result;
      if (
        page.id !== pageId ||
        page.revision !== revision ||
        page.trashedAt !== null ||
        page.scopeSpaceId !== entry.scope ||
        (page.kind ?? "page") !== "page"
      )
        return yield* pageGuestFailure("unavailable");
      let policyStamp: string;
      if (entry.mode === "site") {
        const epoch = yield* guestStorage(store.sitePolicyEpoch(entry.site.site_id));
        if (epoch === null) return yield* pageGuestFailure("unavailable");
        policyStamp = JSON.stringify(["site", epoch]);
      } else {
        const parentSpace =
          entry.target.kind === "page"
            ? entry.pages.find((p) => p.id === entry.rootPageId)?.spaceId
            : null;
        const inherited = parentSpace
          ? yield* guestStorage(store.getLink("space", parentSpace))
          : null;
        policyStamp = JSON.stringify([
          "link",
          entry.link.version,
          parentSpace ?? null,
          inherited?.link_id ?? null,
          inherited?.version ?? null,
        ]);
      }
      return {
        entry:
          entry.mode === "site"
            ? { kind: "site" as const, id: entry.site.site_id }
            : { kind: "link" as const, id: entry.link.link_id },
        policyStamp,
        pageId: page.id,
        pageRevision: page.revision,
        scopeSpaceId: page.scopeSpaceId,
        spaceId: page.spaceId,
        richContent: result.richContent ?? null,
      };
    });
  const resolveGuestAppHostPage: PageSharingServiceShape["resolveGuestAppHostPage"] = (input) => {
    const request = Schema.decodeUnknownOption(PageGuestViewRequest)(input);
    if (
      Option.isNone(request) ||
      request.value.pageId === undefined ||
      !Number.isSafeInteger(input.expectedPageRevision) ||
      input.expectedPageRevision < 1
    )
      return Effect.fail(pageGuestFailure("invalid"));
    return store
      .transaction(
        Effect.gen(function* () {
          return yield* appHostAt(
            yield* resolveEntry(request.value),
            input.pageId,
            input.expectedPageRevision,
          );
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof PageGuestFailure ? cause : pageGuestFailure("unavailable", cause),
        ),
      );
  };

  const resolveOwnerAppHostPage: PageSharingServiceShape["resolveOwnerAppHostPage"] = (
    ref,
    pageId,
    revision,
    principal,
  ) =>
    store
      .transaction(
        Effect.gen(function* () {
          if (principal.kind !== "local-user") return yield* pageGuestFailure("forbidden");
          if (ref.kind === "site") {
            const site = yield* guestStorage(store.getSite(ref.id));
            if (!site || site.visibility === "private" || site.published_at === null)
              return yield* pageGuestFailure("unavailable");
            return yield* appHostAt(
              { mode: "site", site, scope: scopeFromKey(site.scope_key) },
              pageId,
              revision,
            );
          }
          const link = yield* guestStorage(store.getLinkById(ref.id));
          if (!link) return yield* pageGuestFailure("unavailable");
          return yield* appHostAt(yield* shareEntryFor(link, "view", null), pageId, revision);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof PageGuestFailure ? cause : pageGuestFailure("unavailable", cause),
        ),
      );

  const resolveEditableGuestPage: PageSharingServiceShape["resolveEditableGuestPage"] = (input) => {
    const decoded = Schema.decodeUnknownOption(PageGuestViewRequest)(input);
    if (
      Option.isNone(decoded) ||
      decoded.value.pageId === undefined ||
      !Number.isSafeInteger(input.expectedPageRevision) ||
      input.expectedPageRevision <= 0
    )
      return Effect.fail(pageGuestFailure("invalid"));
    // One database snapshot avoids mixing membership/visibility with a later page
    // read. Nothing is cached or granted: G1 only inspects current eligibility.
    return store
      .transaction(
        Effect.gen(function* () {
          const entry = yield* resolveEntry(decoded.value);
          if (entry.mode !== "share" || entry.role !== "edit")
            return yield* pageGuestFailure("forbidden");
          if (!entry.pages.some((page) => page.id === input.pageId))
            return yield* pageGuestFailure("forbidden");
          const result = yield* readPage(entry.scope, input.pageId).pipe(
            Effect.mapError((cause) => pageGuestFailure("unavailable", cause)),
          );
          const page = result.page;
          if (
            page.trashedAt !== null ||
            page.scopeSpaceId !== entry.scope ||
            page.revision !== input.expectedPageRevision
          )
            return yield* pageGuestFailure("unavailable");
          // Slides/sheets/apps have their own data models and are not a Slate document.
          if ((page.kind ?? "page") !== "page") return yield* pageGuestFailure("forbidden");
          return {
            pageId: page.id,
            pageRevision: page.revision,
            scopeSpaceId: entry.scope,
            role: "edit",
            entry: {
              target: entry.target,
              linkId: entry.link.link_id,
              linkVersion: entry.link.version,
            },
            actorRef:
              entry.member === null
                ? { kind: "share-link", linkId: entry.link.link_id }
                : { kind: "share-member", memberId: entry.member.member_id },
          } satisfies GuestPageEditEligibility;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof PageGuestFailure ? cause : pageGuestFailure("unavailable", cause),
        ),
      );
  };

  const resolveReadonlyAppItem: PageSharingServiceShape["resolveReadonlyAppItem"] = (input) =>
    Effect.gen(function* () {
      // Reuse the existing request/proof/visitor bounds. Visitor is an audit id,
      // not an account or an authorization principal, and is never sent to HTML.
      const decoded = Schema.decodeUnknownOption(PageGuestViewRequest)(input);
      if (
        Option.isNone(decoded) ||
        decoded.value.pageId === undefined ||
        !Number.isSafeInteger(input.expectedPageRevision) ||
        input.expectedPageRevision <= 0
      )
        return yield* pageGuestFailure("invalid");
      const authorized = yield* view(decoded.value);
      if (
        authorized.page.id !== input.pageId ||
        authorized.page.revision !== input.expectedPageRevision
      )
        return yield* pageGuestFailure("unavailable");
      if (authorized.page.kind !== "app") return yield* pageGuestFailure("unavailable");
      const row = yield* guestStorage(
        store.getAppDataAtRevision(authorized.page.id, authorized.page.revision),
      );
      if (!row) return yield* pageGuestFailure("unavailable");
      // A 数据看板 is shared as a snapshot: its page with the files' rows inlined.
      const app = yield* Effect.try({
        try: () =>
          isDashboardPayload(row.data)
            ? {
                html: buildDashboardSnapshotDocument(
                  parseDashboard(row.data),
                  "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
                ),
              }
            : parseAppItem(row.data),
        catch: (cause) => pageGuestFailure("unavailable", cause),
      });
      return {
        source: {
          sourceKind: "page-item",
          pageId: authorized.page.id,
          pageRevision: authorized.page.revision,
          dataRevision: row.revision,
        },
        html: app.html,
        publicMetadata: { title: authorized.page.title, revision: authorized.page.revision },
        availableCapabilities: [],
      } satisfies AuthorizedReadonlyAppItem;
    });

  // Only the explicit two-host guest adapter exposes these operations; no owner RPC bypass.
  // The origin is explicit owner configuration; the publisher comes only from a successful registration.
  const publications = Option.isSome(appService)
    ? yield* makePageAppPublicationsFor({ resolveGuestAppHostPage, resolveOwnerAppHostPage }).pipe(
        Effect.provideService(PageAppsService, appService.value),
      )
    : undefined;
  const previewTickets = new PageAppPreviewTickets<PageAppPreviewDocument, TicketSource>({
    issuer: registeredPreviewIssuer,
    brokerAvailable: brokerEnabled,
    ...(publications
      ? {
          findForGuest: (request, reference, signal) =>
            run(publications.findForGuest(request, reference), { signal }),
        }
      : {}),
    resolve: async (request, signal) => {
      if (!request.publicationId) return run(resolveReadonlyAppItem(request), { signal });
      if (!publications) throw pageGuestFailure("unavailable");
      return publishedGuestDocument(
        await run(publications.resolve(request, request.publicationId), { signal }),
      );
    },
    render: (document, context, signal) =>
      preparePageAppPreviewDocument(document, context, signal, {
        ...(Option.isSome(serverConfig) && serverConfig.value.staticDir !== undefined
          ? { staticDir: serverConfig.value.staticDir }
          : {}),
      }),
  });
  const previewFailure = (cause: unknown) =>
    cause instanceof PageGuestFailure ? cause : pageGuestFailure("unavailable", cause);
  const openReadonlyAppItemPreview: PageSharingServiceShape["openReadonlyAppItemPreview"] = (
    input,
  ) =>
    input.brokerSecretHash !== undefined && !brokerEnabled()
      ? Effect.fail(pageGuestFailure("unavailable"))
      : Effect.tryPromise({
          try: (signal) => previewTickets.open(input, signal),
          catch: previewFailure,
        });
  const consumeReadonlyAppItemPreview: PageSharingServiceShape["consumeReadonlyAppItemPreview"] = (
    input,
  ) =>
    Effect.tryPromise({
      try: (signal) => previewTickets.consume(input, signal),
      catch: previewFailure,
    });
  const edit =
    editEnabled && Option.isSome(realtime)
      ? new PageGuestEditHttp(
          yield* makeGuestPageProjectionService({
            sql,
            realtime: realtime.value,
            sharing: { resolveEditableGuestPage },
            secrets: secretStore,
            issuer: () => {
              const current = editIssuer();
              return current ? current.shareId + "@" + current.parentOrigin : null;
            },
          }),
          editIssuer,
        )
      : undefined;
  const guestOperations: PageGuestOperations = {
    view,
    comments,
    access,
    media,
    ...(edit ? { edit } : {}),
    preview: {
      issuer: registeredPreviewIssuer,
      open: openReadonlyAppItemPreview,
      document: consumeReadonlyAppItemPreview,
      inspect: (proof: import("@moss/contracts").PageGuestAppPreviewBrokerRequest) =>
        !brokerEnabled()
          ? Effect.fail(pageGuestFailure("unavailable"))
          : Effect.tryPromise({
              try: (signal) => previewTickets.inspectBroker(proof, signal),
              catch: previewFailure,
            }),
    },
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => edit?.close()));
  yield* Effect.addFinalizer(() => Effect.sync(() => previewTickets.close()));

  // Old visitor opens are not worth keeping forever; then reconnect the publisher and keep its
  // registration fresh.
  yield* Effect.gen(function* () {
    yield* store.pruneEvents(ago(EVENT_RETENTION_MS)).pipe(Effect.ignore);
    yield* publisher.resume;
    yield* publisher.renewForever;
  }).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => Effect.sync(() => publisher.close()));

  return {
    resolveGuestAppHostPage,
    resolveOwnerAppHostPage,
    resolveEditableGuestPage,
    resolveReadonlyAppItem,
    openReadonlyAppItemPreview,
    consumeReadonlyAppItemPreview,
    get,
    mutate: (input) => projectionEpoch.around(mutate(input)),
    activity,
    reply,
    sitesList,
    siteForPage,
    siteMutate: (input) => projectionEpoch.around(siteMutate(input)),
  } satisfies PageSharingServiceShape;
});

export const PageSharingServiceLive = Layer.effect(PageSharingService, make);

export type { PageSharingError };
