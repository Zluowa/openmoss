import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The one relay share ("publisher") that carries every 资料空间 link and site of this Moss.
  // Its id is in every link, so it is kept for as long as the profile exists.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_share_publisher (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    share_id TEXT NOT NULL CHECK (length(share_id) = 22),
    relay_origin TEXT NOT NULL CHECK (length(relay_origin) > 0),
    created_at TEXT NOT NULL
  )`;
  // Link access of one page or space. A page row with NULL access inherits its space; the row
  // still exists so the page has its own link id. Rotating the link replaces link_id.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_share_links (
    target_kind TEXT NOT NULL CHECK (target_kind IN ('page', 'space')),
    target_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    link_id TEXT NOT NULL UNIQUE CHECK (length(link_id) = 22),
    access TEXT CHECK (access IS NULL OR access IN ('invited', 'link', 'anyone')),
    role TEXT CHECK (role IS NULL OR role IN ('view', 'comment', 'edit')),
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target_kind, target_id),
    CHECK ((access IS NULL) = (role IS NULL))
  )`;
  // Invited people. Each has a personal link (an HMAC of member_id), revoked by deleting the row.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_share_members (
    member_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('page', 'space')),
    target_id TEXT NOT NULL,
    name TEXT NOT NULL,
    contact TEXT,
    role TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit')),
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_share_members_target
    ON pages_share_members (target_kind, target_id)`;
  // Guests asking for access. Only a hash of the requester's secret is stored.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_share_requests (
    request_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('page', 'space')),
    target_id TEXT NOT NULL,
    name TEXT NOT NULL,
    contact TEXT,
    note TEXT,
    role TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit')),
    secret_hash TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    member_id TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_share_requests_target
    ON pages_share_requests (target_kind, target_id, status)`;
  // Comments from people outside this Moss, and the owner's replies to them. Kept apart from
  // pages_comments, whose authors are the local user and agents.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_guest_comments (
    comment_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'member', 'guest')),
    author_name TEXT NOT NULL,
    member_id TEXT,
    visitor_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_guest_comments_page
    ON pages_guest_comments (page_id, created_at)`;
  // Who opened, commented, asked, and what the owner changed. Opens are deduplicated per visitor.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_share_events (
    event_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('page', 'space', 'site')),
    target_id TEXT NOT NULL,
    page_id TEXT,
    action TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'member', 'guest', 'visitor')),
    actor_name TEXT,
    visitor_id TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_share_events_page
    ON pages_share_events (page_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_share_events_target
    ON pages_share_events (target_kind, target_id, action, created_at)`;
});
