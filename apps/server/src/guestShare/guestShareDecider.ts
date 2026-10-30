/**
 * Pure decisions for "share with guest". The service serializes calls per thread,
 * so checking state here is what makes a link redeem once and a message send once.
 */
import {
  GUEST_PENDING_ATTACHMENT_BYTES_LIMIT,
  GUEST_PENDING_MESSAGE_LIMIT,
  GUEST_RESOLVED_MESSAGE_LIMIT,
  GUEST_SHARE_TTL_MS,
  guestPagePath,
  isGuestShareExpired,
  isSupportedProviderKind,
  type GuestAccessErrorReason,
  type GuestMessageAttachment,
  type GuestMessageId,
  type GuestShareId,
  type GuestShareRelayStatus,
  type GuestShareView,
  type GuestThreadModel,
  type MessageId,
  type ModelSelection,
  type ThreadGuestMessage,
  type ThreadGuestShare,
  type ThreadId,
} from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";

import type { GuestShareRecord } from "../persistence/Services/GuestShareRepository.ts";

export type GuestShareDecision<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: GuestAccessErrorReason };

const accept = <A>(value: A): GuestShareDecision<A> => ({ ok: true, value });
const reject = <A>(reason: GuestAccessErrorReason): GuestShareDecision<A> => ({
  ok: false,
  reason,
});

export function guestShareExpiresAt(createdAtMs: number): string {
  return new Date(createdAtMs + GUEST_SHARE_TTL_MS).toISOString();
}

export function openGuestShare(input: {
  readonly shareId: GuestShareId;
  readonly threadId: ThreadId;
  readonly relayOrigin: string;
  readonly nowMs: number;
}): GuestShareRecord {
  return {
    id: input.shareId,
    threadId: input.threadId,
    relayOrigin: input.relayOrigin,
    createdAt: new Date(input.nowMs).toISOString(),
    expiresAt: guestShareExpiresAt(input.nowMs),
    guestName: null,
    guestJoinedAt: null,
    messages: [],
    sentMessages: [],
  };
}

/** A link works once: the first redeem names the guest, every later one fails with `used`. */
export function redeemGuestShare(
  share: GuestShareRecord,
  input: { readonly guestName: string; readonly nowMs: number },
): GuestShareDecision<GuestShareRecord> {
  if (isGuestShareExpired(share, input.nowMs)) return reject("inactive");
  if (share.guestName !== null) return reject("used");
  return accept({
    ...share,
    guestName: input.guestName,
    guestJoinedAt: new Date(input.nowMs).toISOString(),
  });
}

export const pendingGuestMessages = (share: GuestShareRecord): ReadonlyArray<ThreadGuestMessage> =>
  share.messages.filter((message) => message.status === "pending");

export const pendingGuestAttachments = (
  share: GuestShareRecord | null,
): ReadonlyArray<GuestMessageAttachment> =>
  share === null ? [] : pendingGuestMessages(share).flatMap((message) => message.attachments);

/** Keeps every pending message and only the newest resolved ones. */
export function trimResolved(
  messages: ReadonlyArray<ThreadGuestMessage>,
): ReadonlyArray<ThreadGuestMessage> {
  let resolvedBudget = GUEST_RESOLVED_MESSAGE_LIMIT;
  const kept: Array<ThreadGuestMessage> = [];
  for (const message of messages.toReversed()) {
    if (message.status !== "pending") {
      if (resolvedBudget === 0) continue;
      resolvedBudget -= 1;
    }
    kept.push(message);
  }
  return kept.toReversed();
}

export function submitGuestMessage(
  share: GuestShareRecord,
  input: {
    readonly guestMessageId: GuestMessageId;
    readonly text: string;
    readonly attachments: ReadonlyArray<GuestMessageAttachment>;
    readonly nowMs: number;
  },
): GuestShareDecision<GuestShareRecord> {
  if (share.guestName === null || isGuestShareExpired(share, input.nowMs)) {
    return reject("inactive");
  }
  if (input.text.length === 0 && input.attachments.length === 0) return reject("empty");
  if (pendingGuestMessages(share).length >= GUEST_PENDING_MESSAGE_LIMIT) return reject("busy");
  const pendingBytes = [...pendingGuestAttachments(share), ...input.attachments].reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  );
  if (input.attachments.length > 0 && pendingBytes > GUEST_PENDING_ATTACHMENT_BYTES_LIMIT) {
    return reject("files_busy");
  }
  return accept({
    ...share,
    messages: trimResolved([
      ...share.messages,
      {
        id: input.guestMessageId,
        text: input.text,
        status: "pending",
        submittedAt: new Date(input.nowMs).toISOString(),
        attachments: input.attachments,
      },
    ]),
  });
}

/** Marks a pending message sent or dismissed; null when it is not pending (or unknown). */
export function resolveGuestMessage(
  share: GuestShareRecord,
  guestMessageId: GuestMessageId,
  status: "sent" | "dismissed",
): GuestShareRecord | null {
  const message = share.messages.find((candidate) => candidate.id === guestMessageId);
  if (message === undefined || message.status !== "pending") return null;
  return {
    ...share,
    messages: trimResolved(
      share.messages.map((candidate) =>
        candidate.id === guestMessageId ? { ...candidate, status } : candidate,
      ),
    ),
  };
}

/** Records which thread message carried a sent guest message, for the guest's name on it. */
export function withSentGuestMessage(
  share: GuestShareRecord,
  input: { readonly guestMessageId: GuestMessageId; readonly messageId: MessageId },
): GuestShareRecord {
  return {
    ...share,
    sentMessages: [
      ...share.sentMessages.filter((sent) => sent.guestMessageId !== input.guestMessageId),
      { messageId: input.messageId, guestMessageId: input.guestMessageId },
    ],
  };
}

/** Undoes a send whose dispatch failed: the message waits again and the agent never saw it. */
export function revertSentGuestMessage(
  share: GuestShareRecord,
  guestMessageId: GuestMessageId,
): GuestShareRecord {
  return {
    ...share,
    messages: share.messages.map((candidate) =>
      candidate.id === guestMessageId && candidate.status === "sent"
        ? { ...candidate, status: "pending" }
        : candidate,
    ),
    sentMessages: share.sentMessages.filter((sent) => sent.guestMessageId !== guestMessageId),
  };
}

/**
 * Stored files a share change leaves behind: those of waiting messages that were dismissed or
 * dropped with the share. A sent message keeps its files, which its thread message now holds.
 */
export function releasedGuestAttachments(
  before: GuestShareRecord | null,
  after: GuestShareRecord | null,
): ReadonlyArray<GuestMessageAttachment> {
  const kept = new Set(
    after !== null && after.id === before?.id
      ? after.messages.flatMap((message) =>
          message.status === "dismissed"
            ? []
            : message.attachments.map((attachment) => attachment.id),
        )
      : [],
  );
  return pendingGuestAttachments(before).filter((attachment) => !kept.has(attachment.id));
}

export function guestInviteUrl(relayOrigin: string, shareId: GuestShareId, invite: string): string {
  return `${relayOrigin}${guestPagePath(shareId)}#${invite}`;
}

/** The share as the owner sees it. The link is shown only while it still works. */
export function toThreadGuestShare(
  share: GuestShareRecord,
  input: { readonly inviteUrl: string; readonly relayStatus: GuestShareRelayStatus },
): ThreadGuestShare {
  return {
    id: share.id,
    threadId: share.threadId,
    relayOrigin: share.relayOrigin,
    inviteUrl: share.guestName === null ? input.inviteUrl : null,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    guestName: share.guestName,
    guestJoinedAt: share.guestJoinedAt,
    messages: share.messages,
    relayStatus: input.relayStatus,
  };
}

/** The thread's model as the owner's header labels it; the provider is null once retired. */
export function guestThreadModel(selection: ModelSelection): GuestThreadModel {
  return {
    provider: isSupportedProviderKind(selection.provider) ? selection.provider : null,
    name: formatModelDisplayName(selection.model) ?? selection.model,
  };
}

/** The share as its guest sees it, or null before the guest has joined. */
export function guestShareView(
  share: GuestShareRecord,
  model: GuestThreadModel,
): GuestShareView | null {
  if (share.guestName === null) return null;
  return {
    shareId: share.id,
    guestName: share.guestName,
    expiresAt: share.expiresAt,
    messages: share.messages,
    model,
  };
}
