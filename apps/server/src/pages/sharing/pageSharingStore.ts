/**
 * SQL for 资料空间 sharing and sites (migrations PagesSharing and PagesSites). Plain
 * row access only; the rules live in `pageShareAccess.ts` and the service.
 */
import type {
  PageShareLinkAccess,
  PageShareRole,
  PageShareTargetKind,
  PageSiteKind,
  PageSiteVisibility,
  SpaceId,
} from "@moss/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type Scope = SpaceId | null;
export const scopeKey = (scope: Scope) =>
  scope === null ? "local-default" : `project-space:${scope}`;
export const scopeFromKey = (key: string): Scope =>
  key === "local-default" ? null : (key.slice("project-space:".length) as SpaceId);

export interface PublisherRow {
  readonly share_id: string;
  readonly relay_origin: string;
  readonly created_at: string;
}
export interface LinkRow {
  readonly target_kind: PageShareTargetKind;
  readonly target_id: string;
  readonly scope_key: string;
  readonly link_id: string;
  readonly access: PageShareLinkAccess | null;
  readonly role: PageShareRole | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
export interface MemberRow {
  readonly member_id: string;
  readonly target_kind: PageShareTargetKind;
  readonly target_id: string;
  readonly name: string;
  readonly contact: string | null;
  readonly role: PageShareRole;
  readonly created_at: string;
}
export interface RequestRow {
  readonly request_id: string;
  readonly target_kind: PageShareTargetKind;
  readonly target_id: string;
  readonly name: string;
  readonly contact: string | null;
  readonly note: string | null;
  readonly role: PageShareRole;
  readonly secret_hash: string;
  readonly visitor_id: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly member_id: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}
export interface GuestCommentRow {
  readonly comment_id: string;
  readonly page_id: string;
  readonly author_kind: "owner" | "member" | "guest";
  readonly author_name: string;
  readonly member_id: string | null;
  readonly visitor_id: string | null;
  readonly content: string;
  readonly created_at: string;
}
export interface EventRow {
  readonly event_id: string;
  readonly target_kind: "page" | "space" | "site";
  readonly target_id: string;
  readonly page_id: string | null;
  readonly action: string;
  readonly actor_kind: "owner" | "member" | "guest" | "visitor";
  readonly actor_name: string | null;
  readonly visitor_id: string | null;
  readonly created_at: string;
}
export interface SiteRow {
  readonly site_id: string;
  readonly page_id: string;
  readonly scope_key: string;
  readonly kind: PageSiteKind;
  readonly title: string;
  readonly visibility: PageSiteVisibility;
  readonly link_id: string;
  readonly published_revision: number | null;
  readonly published_at: string | null;
  readonly pinned: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export type NewEvent = Omit<EventRow, "event_id" | "created_at">;

const first = <A>(rows: ReadonlyArray<A>): A | null => rows[0] ?? null;

export const makePageSharingStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),

    // ── Publisher ────────────────────────────────────────────────
    getPublisher: sql<PublisherRow>`SELECT * FROM pages_share_publisher WHERE singleton = 1`.pipe(
      Effect.map(first),
    ),
    insertPublisher: (row: PublisherRow) =>
      sql`INSERT INTO pages_share_publisher (singleton, share_id, relay_origin, created_at)
        VALUES (1, ${row.share_id}, ${row.relay_origin}, ${row.created_at})
        ON CONFLICT (singleton) DO UPDATE SET share_id = excluded.share_id,
          relay_origin = excluded.relay_origin, created_at = excluded.created_at`.pipe(
        Effect.asVoid,
      ),
    deletePublisher: sql`DELETE FROM pages_share_publisher`.pipe(Effect.asVoid),

    // ── Links ────────────────────────────────────────────────────
    getLink: (kind: PageShareTargetKind, id: string) =>
      sql<LinkRow>`SELECT * FROM pages_share_links WHERE target_kind = ${kind} AND target_id = ${id}`.pipe(
        Effect.map(first),
      ),
    getLinkById: (linkId: string) =>
      sql<LinkRow>`SELECT * FROM pages_share_links WHERE link_id = ${linkId}`.pipe(
        Effect.map(first),
      ),
    insertLink: (row: LinkRow) =>
      sql`INSERT INTO pages_share_links (target_kind, target_id, scope_key, link_id, access, role, version, created_at, updated_at)
        VALUES (${row.target_kind}, ${row.target_id}, ${row.scope_key}, ${row.link_id}, ${row.access}, ${row.role}, ${row.version}, ${row.created_at}, ${row.updated_at})
        ON CONFLICT (target_kind, target_id) DO NOTHING`.pipe(Effect.asVoid),
    updateLinkSetting: (
      kind: PageShareTargetKind,
      id: string,
      access: PageShareLinkAccess | null,
      role: PageShareRole | null,
      updatedAt: string,
    ) =>
      sql`UPDATE pages_share_links SET access = ${access}, role = ${role}, version = version + 1, updated_at = ${updatedAt}
        WHERE target_kind = ${kind} AND target_id = ${id}`.pipe(Effect.asVoid),
    rotateLink: (kind: PageShareTargetKind, id: string, linkId: string, updatedAt: string) =>
      sql`UPDATE pages_share_links SET link_id = ${linkId}, version = version + 1, updated_at = ${updatedAt}
        WHERE target_kind = ${kind} AND target_id = ${id}`.pipe(Effect.asVoid),

    // ── Members ──────────────────────────────────────────────────
    listMembers: (kind: PageShareTargetKind, id: string) =>
      sql<MemberRow>`SELECT * FROM pages_share_members WHERE target_kind = ${kind} AND target_id = ${id}
        ORDER BY created_at, member_id`,
    getMember: (memberId: string) =>
      sql<MemberRow>`SELECT * FROM pages_share_members WHERE member_id = ${memberId}`.pipe(
        Effect.map(first),
      ),
    insertMember: (row: MemberRow) =>
      sql`INSERT INTO pages_share_members (member_id, target_kind, target_id, name, contact, role, created_at)
        VALUES (${row.member_id}, ${row.target_kind}, ${row.target_id}, ${row.name}, ${row.contact}, ${row.role}, ${row.created_at})`.pipe(
        Effect.asVoid,
      ),
    updateMemberRole: (memberId: string, role: PageShareRole) =>
      sql`UPDATE pages_share_members SET role = ${role} WHERE member_id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    deleteMember: (memberId: string) =>
      sql`DELETE FROM pages_share_members WHERE member_id = ${memberId}`.pipe(Effect.asVoid),

    // ── Access requests ──────────────────────────────────────────
    listPendingRequests: (kind: PageShareTargetKind, id: string) =>
      sql<RequestRow>`SELECT * FROM pages_share_requests
        WHERE target_kind = ${kind} AND target_id = ${id} AND status = 'pending'
        ORDER BY created_at, request_id`,
    getRequest: (requestId: string) =>
      sql<RequestRow>`SELECT * FROM pages_share_requests WHERE request_id = ${requestId}`.pipe(
        Effect.map(first),
      ),
    countRecentRequestsByVisitor: (visitorId: string, since: string) =>
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM pages_share_requests
        WHERE visitor_id = ${visitorId} AND created_at > ${since}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    insertRequest: (row: RequestRow) =>
      sql`INSERT INTO pages_share_requests (request_id, target_kind, target_id, name, contact, note, role, secret_hash, visitor_id, status, member_id, created_at, decided_at)
        VALUES (${row.request_id}, ${row.target_kind}, ${row.target_id}, ${row.name}, ${row.contact}, ${row.note}, ${row.role}, ${row.secret_hash}, ${row.visitor_id}, ${row.status}, ${row.member_id}, ${row.created_at}, ${row.decided_at})`.pipe(
        Effect.asVoid,
      ),
    decideRequest: (
      requestId: string,
      status: "approved" | "rejected",
      memberId: string | null,
      decidedAt: string,
    ) =>
      sql`UPDATE pages_share_requests SET status = ${status}, member_id = ${memberId}, decided_at = ${decidedAt}
        WHERE request_id = ${requestId} AND status = 'pending'`.pipe(Effect.asVoid),

    // ── Guest comments ───────────────────────────────────────────
    listGuestComments: (pageId: string) =>
      sql<GuestCommentRow>`SELECT * FROM pages_guest_comments WHERE page_id = ${pageId}
        ORDER BY created_at, comment_id LIMIT 500`,
    countRecentCommentsByVisitor: (pageId: string, visitorId: string, since: string) =>
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM pages_guest_comments
        WHERE page_id = ${pageId} AND visitor_id = ${visitorId} AND created_at > ${since}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    insertGuestComment: (row: GuestCommentRow) =>
      sql`INSERT INTO pages_guest_comments (comment_id, page_id, author_kind, author_name, member_id, visitor_id, content, created_at)
        VALUES (${row.comment_id}, ${row.page_id}, ${row.author_kind}, ${row.author_name}, ${row.member_id}, ${row.visitor_id}, ${row.content}, ${row.created_at})`.pipe(
        Effect.asVoid,
      ),

    // ── Comment threads on words (pages_text_comments, written by the owner's Moss) ──
    listTextComments: (pageId: string) =>
      sql<{
        comment_id: string;
        thread_json: string;
      }>`SELECT comment_id, thread_json FROM pages_text_comments
        WHERE page_id = ${pageId} ORDER BY updated_at, comment_id LIMIT 500`,
    getTextComment: (pageId: string, commentId: string) =>
      sql<{ thread_json: string }>`SELECT thread_json FROM pages_text_comments
        WHERE page_id = ${pageId} AND comment_id = ${commentId}`.pipe(
        Effect.map((rows) => rows[0]?.thread_json ?? null),
      ),
    saveTextComment: (pageId: string, commentId: string, thread: string, updatedAt: string) =>
      sql`INSERT INTO pages_text_comments (comment_id, page_id, thread_json, updated_at)
        VALUES (${commentId}, ${pageId}, ${thread}, ${updatedAt})
        ON CONFLICT (page_id, comment_id) DO UPDATE SET thread_json = excluded.thread_json,
          updated_at = excluded.updated_at`.pipe(Effect.asVoid),

    // ── Events ───────────────────────────────────────────────────
    countRecentEventsByVisitor: (
      pageId: string,
      visitorId: string,
      action: string,
      since: string,
    ) =>
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM pages_share_events
        WHERE page_id = ${pageId} AND visitor_id = ${visitorId} AND action = ${action} AND created_at > ${since}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    insertEvent: (row: EventRow) =>
      sql`INSERT INTO pages_share_events (event_id, target_kind, target_id, page_id, action, actor_kind, actor_name, visitor_id, created_at)
        VALUES (${row.event_id}, ${row.target_kind}, ${row.target_id}, ${row.page_id}, ${row.action}, ${row.actor_kind}, ${row.actor_name}, ${row.visitor_id}, ${row.created_at})`.pipe(
        Effect.asVoid,
      ),
    /** Opens are counted per way in (a link or a site), so a site visit after a link visit counts. */
    hasRecentOpen: (
      target: { readonly kind: string; readonly id: string },
      pageId: string,
      visitorId: string,
      since: string,
    ) =>
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM pages_share_events
        WHERE target_kind = ${target.kind} AND target_id = ${target.id} AND page_id = ${pageId}
          AND visitor_id = ${visitorId} AND action = 'opened' AND created_at > ${since}`.pipe(
        Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
      ),
    listPageEvents: (pageId: string) =>
      sql<EventRow>`SELECT * FROM pages_share_events WHERE page_id = ${pageId}
        ORDER BY created_at DESC, event_id DESC LIMIT 100`,
    pruneEvents: (before: string) =>
      sql`DELETE FROM pages_share_events WHERE created_at < ${before}`.pipe(Effect.asVoid),
    countSiteOpens: (siteId: string, since: string) =>
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM pages_share_events
        WHERE target_kind = 'site' AND target_id = ${siteId} AND action = 'opened' AND created_at > ${since}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),

    // ── Sites ────────────────────────────────────────────────────
    listSites: (scope: Scope) =>
      sql<SiteRow>`SELECT * FROM pages_sites WHERE scope_key = ${scopeKey(scope)}
        ORDER BY pinned DESC, updated_at DESC, site_id`,
    getSite: (siteId: string) =>
      sql<SiteRow>`SELECT * FROM pages_sites WHERE site_id = ${siteId}`.pipe(Effect.map(first)),
    getSiteByPage: (pageId: string) =>
      sql<SiteRow>`SELECT * FROM pages_sites WHERE page_id = ${pageId}`.pipe(Effect.map(first)),
    getSiteByLink: (linkId: string) =>
      sql<SiteRow>`SELECT * FROM pages_sites WHERE link_id = ${linkId}`.pipe(Effect.map(first)),
    sitePolicyEpoch: (id: string) =>
      sql<{
        publication_epoch: number;
      }>`SELECT publication_epoch FROM pages_sites WHERE site_id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.publication_epoch ?? null),
      ),
    upsertSite: (row: SiteRow, policyChanged = true) =>
      sql`INSERT INTO pages_sites (site_id, page_id, scope_key, kind, title, visibility, link_id, published_revision, published_at, pinned, created_at, updated_at)
        VALUES (${row.site_id}, ${row.page_id}, ${row.scope_key}, ${row.kind}, ${row.title}, ${row.visibility}, ${row.link_id}, ${row.published_revision}, ${row.published_at}, ${row.pinned}, ${row.created_at}, ${row.updated_at})
        ON CONFLICT (site_id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
          visibility = excluded.visibility, published_revision = excluded.published_revision,
          published_at = excluded.published_at, pinned = excluded.pinned, updated_at = excluded.updated_at,
          publication_epoch = pages_sites.publication_epoch + ${policyChanged ? 1 : 0}`.pipe(
        Effect.asVoid,
      ),
    getMeta: (key: string) =>
      sql<{ value: string }>`SELECT value FROM pages_sites_meta WHERE key = ${key}`.pipe(
        Effect.map((rows) => rows[0]?.value ?? null),
      ),
    setMeta: (key: string, value: string) =>
      sql`INSERT INTO pages_sites_meta (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid),
    /** A slides deck's payload as of `revision` (guests see the shared or published state). */
    getDeckData: (pageId: string, revision: number) =>
      sql<{ data: string }>`SELECT data FROM pages_item_data
        WHERE page_id = ${pageId} AND kind = 'slides' AND revision <= ${revision}
        ORDER BY revision DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.data ?? null)),
    /** The authorized typed page version, never a newer owner draft or page_apps record. */
    getAppDataAtRevision: (pageId: string, revision: number) =>
      sql<{ revision: number; data: string }>`SELECT revision, data FROM pages_item_data
        WHERE page_id = ${pageId} AND kind = 'app' AND revision <= ${revision}
        ORDER BY revision DESC LIMIT 1`.pipe(Effect.map(first)),
  };
  return store;
});

export type PageSharingStore = Effect.Success<typeof makePageSharingStore>;
