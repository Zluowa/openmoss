import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  OrchestrationThreadStreamItem,
  ProviderKind,
} from "./orchestration";

/**
 * Share with guest: the owner sends a one-time link; the guest watches the thread live and
 * proposes messages that wait until the owner sends or dismisses each one (group-order flow).
 *
 * The owner's Moss server keeps the share and serves every guest request. Guests reach it through
 * the Moss share relay (`guestShareRelay.ts`), which only forwards the guest routes below and serves
 * the static guest page. Invite and session credentials are HMACs of the share id under a server
 * key, so nothing secret is stored and replacing or closing a share revokes them.
 */

// ── Limits ──────────────────────────────────────────────────────────

export const GUEST_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_MESSAGE_MAX_LENGTH = 4_000;
export const GUEST_NAME_MAX_LENGTH = 40;
export const GUEST_PENDING_MESSAGE_LIMIT = 3;
/** Resolved messages kept so the guest can see what happened to what they sent. */
export const GUEST_RESOLVED_MESSAGE_LIMIT = 20;
/** Files a guest can attach to one message, and their total size. */
export const GUEST_MESSAGE_MAX_ATTACHMENTS = 4;
export const GUEST_MESSAGE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Total size of the files in a share's waiting messages, so a guest cannot fill the disk. */
export const GUEST_PENDING_ATTACHMENT_BYTES_LIMIT = 20 * 1024 * 1024;
/** Opening snapshot window, as in T3: recent user turns, capped by message count. */
export const GUEST_SNAPSHOT_USER_TURN_LIMIT = 20;
export const GUEST_SNAPSHOT_MESSAGE_LIMIT = 600;

// ── Identifiers ─────────────────────────────────────────────────────

/** 16 random bytes, base64url without padding. */
export const GuestShareId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)).pipe(
  Schema.brand("GuestShareId"),
);
export type GuestShareId = typeof GuestShareId.Type;

export const GuestMessageId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("GuestMessageId"));
export type GuestMessageId = typeof GuestMessageId.Type;

// ── Owner-side share state ──────────────────────────────────────────

/** A guest's file, stored as a thread attachment so a sent message passes it to the agent. */
export const GuestMessageAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type GuestMessageAttachment = typeof GuestMessageAttachment.Type;

export const ThreadGuestMessageStatus = Schema.Literals(["pending", "sent", "dismissed"]);
export type ThreadGuestMessageStatus = typeof ThreadGuestMessageStatus.Type;

export const ThreadGuestMessage = Schema.Struct({
  id: GuestMessageId,
  text: Schema.String,
  status: ThreadGuestMessageStatus,
  submittedAt: IsoDateTime,
  attachments: Schema.Array(GuestMessageAttachment),
});
export type ThreadGuestMessage = typeof ThreadGuestMessage.Type;

/** Whether the owner's server holds a live connection to the relay for this share. */
export const GuestShareRelayStatus = Schema.Literals(["connecting", "online", "offline"]);
export type GuestShareRelayStatus = typeof GuestShareRelayStatus.Type;

export const ThreadGuestShare = Schema.Struct({
  id: GuestShareId,
  threadId: ThreadId,
  /** The relay origin the link points at, e.g. `https://moss-share.comiction.cn`. */
  relayOrigin: TrimmedNonEmptyString,
  /** The invite link while it is unused; null once the guest joined (links work once). */
  inviteUrl: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** Set once, when the guest redeems the link. */
  guestName: Schema.NullOr(TrimmedNonEmptyString),
  guestJoinedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(ThreadGuestMessage),
  relayStatus: GuestShareRelayStatus,
});
export type ThreadGuestShare = typeof ThreadGuestShare.Type;

export const pendingGuestMessageCount = (share: ThreadGuestShare | null | undefined): number =>
  share?.messages.filter((message) => message.status === "pending").length ?? 0;

export const isGuestShareExpired = (
  share: Pick<ThreadGuestShare, "expiresAt">,
  nowMs: number,
): boolean => nowMs >= Date.parse(share.expiresAt);

// ── Owner WebSocket surface ─────────────────────────────────────────

export const GUEST_SHARE_WS_METHODS = {
  create: "guestShare.create",
  close: "guestShare.close",
  resolveMessage: "guestShare.resolveMessage",
  subscribe: "guestShare.subscribe",
} as const;

export const GuestShareCreateInput = Schema.Struct({ threadId: ThreadId });
export type GuestShareCreateInput = typeof GuestShareCreateInput.Type;

export const GuestShareCreateResult = Schema.Struct({
  share: ThreadGuestShare,
  inviteUrl: TrimmedNonEmptyString,
});
export type GuestShareCreateResult = typeof GuestShareCreateResult.Type;

export const GuestShareCloseInput = Schema.Struct({ threadId: ThreadId });
export type GuestShareCloseInput = typeof GuestShareCloseInput.Type;

export const GuestMessageDecision = Schema.Literals(["send", "dismiss"]);
export type GuestMessageDecision = typeof GuestMessageDecision.Type;

export const GuestShareResolveMessageInput = Schema.Struct({
  threadId: ThreadId,
  guestMessageId: GuestMessageId,
  decision: GuestMessageDecision,
});
export type GuestShareResolveMessageInput = typeof GuestShareResolveMessageInput.Type;

/**
 * Every share the owner's server holds, then each change. One stream covers all threads so a
 * window costs a single stream lease.
 */
export const GuestShareOwnerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), shares: Schema.Array(ThreadGuestShare) }),
  Schema.Struct({ type: Schema.Literal("upsert"), share: ThreadGuestShare }),
  Schema.Struct({
    type: Schema.Literal("remove"),
    threadId: ThreadId,
    shareId: GuestShareId,
  }),
]);
export type GuestShareOwnerEvent = typeof GuestShareOwnerEvent.Type;

/**
 * `WsRpcError.code` values for owner calls. Clients localize by code; `message` is the English
 * fallback.
 */
export const GUEST_SHARE_OWNER_ERROR_MESSAGES = {
  "guest_share.account_required": "Sign in with a Moss account to share threads with guests.",
  "guest_share.relay_unavailable": "The Moss share service cannot be reached. Try again shortly.",
  "guest_share.rate_limited": "Too many guest links. Try again later.",
  "guest_share.thread_unavailable": "This thread cannot be shared.",
  "guest_share.not_found": "This thread has no guest link.",
  "guest_share.message_not_pending": "This guest message was already answered.",
  "guest_share.send_failed": "The guest message could not be sent.",
} as const;
export type GuestShareOwnerErrorCode = keyof typeof GUEST_SHARE_OWNER_ERROR_MESSAGES;

// ── Guest HTTP API (owner's server, through the relay) ──────────────

/** Bumped only for breaking changes; additions keep the version. */
export const GUEST_SHARE_PROTOCOL_VERSION = 1;

/** The guest page: `https://<relay>/s/<shareId>#<invite credential>`. */
export const GUEST_PAGE_PATH_PREFIX = "/s/";
export const guestPagePath = (shareId: string) => `${GUEST_PAGE_PATH_PREFIX}${shareId}`;

export const GUEST_ROUTES = {
  /** GET: 204 while this browser's session opens the share. */
  session: "session",
  /** POST JSON `GuestRedeemRequest`: spends the invite and sets the session cookie. */
  redeem: "redeem",
  /** GET: server-sent events, one JSON `GuestStreamEvent` per `data:` line. */
  stream: "stream",
  /** POST JSON `{ text }`, or multipart with a `text` field and up to 4 `file` parts. */
  messages: "messages",
  /** GET `?id=<attachment id>`: a file of the shared thread or of the guest's own messages. */
  attachment: "attachment",
} as const;
export type GuestRoute = (typeof GUEST_ROUTES)[keyof typeof GUEST_ROUTES];
export const GUEST_ROUTE_NAMES: ReadonlyArray<GuestRoute> = Object.values(GUEST_ROUTES);

export const guestApiPrefix = (shareId: string) => `/v1/shares/${shareId}/guest`;
export const guestApiPath = (shareId: string, route: GuestRoute) =>
  `${guestApiPrefix(shareId)}/${route}`;

/** The session cookie name; its path is the share's guest prefix, so each share has its own. */
export const GUEST_SESSION_COOKIE = "moss_guest";

// The name lands in the agent's attribution line, so it must stay one plain line, and the owner
// reads it, so direction overrides cannot make it look like another name.
const NAME_BREAKING_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/u;

export const GuestName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(GUEST_NAME_MAX_LENGTH),
  Schema.makeFilter((name: string) => !NAME_BREAKING_CHARACTER.test(name), {
    description: "a single line of text",
  }),
);

export const GuestRedeemRequest = Schema.Struct({
  credential: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  name: GuestName,
});
export type GuestRedeemRequest = typeof GuestRedeemRequest.Type;

/** Text can be empty when files are attached. */
export const GuestSubmitFields = Schema.Struct({
  text: Schema.Trim.check(Schema.isMaxLength(GUEST_MESSAGE_MAX_LENGTH)),
});
export type GuestSubmitFields = typeof GuestSubmitFields.Type;

export const GuestAccessErrorReason = Schema.Literals([
  "invalid",
  "inactive",
  "used",
  "busy",
  "files_busy",
  "unavailable",
  "rejected",
  "empty",
  "too_many_files",
  "too_large",
  "unsupported_file",
  "owner_offline",
  "owner_outdated",
]);
export type GuestAccessErrorReason = typeof GuestAccessErrorReason.Type;

/** Every non-2xx guest response carries this body. The guest page localizes by `reason`. */
export const GuestAccessErrorBody = Schema.Struct({
  reason: GuestAccessErrorReason,
  message: Schema.String,
});
export type GuestAccessErrorBody = typeof GuestAccessErrorBody.Type;

export const GUEST_ACCESS_ERROR_MESSAGES: Record<GuestAccessErrorReason, string> = {
  invalid: "This guest link is not valid.",
  inactive: "This guest link is no longer active.",
  used: "This guest link was already used.",
  busy: "Wait for the owner to answer your earlier messages.",
  files_busy: "Wait for the owner to answer your earlier messages before you attach more files.",
  unavailable: "This item is not available.",
  rejected: "The owner's Moss rejected this request.",
  empty: "Write a message or attach a file.",
  too_many_files: "Attach up to 4 files to a message.",
  too_large: "Attached files can total up to 10 MB per message.",
  unsupported_file: "This file cannot be attached. Images must be PNG, JPEG, GIF, or WebP.",
  owner_offline: "The owner's Moss is offline. This page reconnects when it is back.",
  owner_outdated: "The owner's Moss needs an update to share this thread.",
};

export const guestAccessErrorStatus = (reason: GuestAccessErrorReason): number => {
  switch (reason) {
    case "invalid":
    case "inactive":
    case "unavailable":
      return 403;
    case "empty":
    case "too_many_files":
    case "too_large":
    case "unsupported_file":
      return 400;
    case "owner_offline":
      return 503;
    case "owner_outdated":
      return 426;
    case "used":
    case "busy":
    case "files_busy":
    case "rejected":
      return 409;
  }
};

// ── Guest stream protocol ───────────────────────────────────────────
// As in T3: the guest gets the same thread stream items the owner's thread subscription sends,
// so the guest page renders the thread with the owner's own transcript components. The server
// only strips owner-private fields (notes, pins, markers, local paths) and non-transcript events.

/** What the owner's header shows as the model; nothing else from the owner's provider settings. */
export const GuestThreadModel = Schema.Struct({
  /** Null when the thread's provider is no longer configured. */
  provider: Schema.NullOr(ProviderKind),
  name: TrimmedNonEmptyString,
});
export type GuestThreadModel = typeof GuestThreadModel.Type;

/** The share as its guest sees it: their name, expiry, their own proposals, and the model. */
export const GuestShareView = Schema.Struct({
  shareId: GuestShareId,
  guestName: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  messages: Schema.Array(ThreadGuestMessage),
  model: GuestThreadModel,
});
export type GuestShareView = typeof GuestShareView.Type;

export const GuestShareEndReason = Schema.Literals([
  "closed",
  "expired",
  "replaced",
  "archived",
  "deleted",
]);
export type GuestShareEndReason = typeof GuestShareEndReason.Type;

/**
 * Every (re)connect starts with `hello`, `view`, then a `thread` item of kind `snapshot` (a
 * bounded window: the last `GUEST_SNAPSHOT_USER_TURN_LIMIT` user turns, at most
 * `GUEST_SNAPSHOT_MESSAGE_LIMIT` messages); after that `thread` carries the same `event` items
 * the owner's subscription gets, `view` replaces the share, and `ended` is last. Pages ignore
 * event types they do not know.
 */
export const GuestStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), protocolVersion: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("view"), view: GuestShareView }),
  Schema.Struct({ type: Schema.Literal("thread"), item: OrchestrationThreadStreamItem }),
  Schema.Struct({ type: Schema.Literal("ended"), reason: GuestShareEndReason }),
]);
export type GuestStreamEvent = typeof GuestStreamEvent.Type;
