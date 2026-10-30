/**
 * Durable storage for "share with guest" state: one live share per thread.
 *
 * The repository only persists rows; the guest share service owns ids,
 * credentials, decisions, and change events. An ended share is deleted rather
 * than kept, because a share is 24-hour collaboration state, not history.
 */
import {
  GuestMessageId,
  GuestShareId,
  IsoDateTime,
  MessageId,
  ThreadGuestMessage,
  ThreadId,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { GuestShareRepositoryError } from "../Errors.ts";

/** A thread message the owner sent for the guest, so the guest sees their name on it. */
export const GuestShareSentMessage = Schema.Struct({
  messageId: MessageId,
  guestMessageId: GuestMessageId,
});
export type GuestShareSentMessage = typeof GuestShareSentMessage.Type;

/** The persisted share. `inviteUrl` and `relayStatus` are derived by the service. */
export const GuestShareRecord = Schema.Struct({
  id: GuestShareId,
  threadId: ThreadId,
  relayOrigin: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  guestName: Schema.NullOr(TrimmedNonEmptyString),
  guestJoinedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(ThreadGuestMessage),
  sentMessages: Schema.Array(GuestShareSentMessage),
});
export type GuestShareRecord = typeof GuestShareRecord.Type;

export interface GuestShareRepositoryShape {
  /** Every share, oldest first. */
  readonly list: () => Effect.Effect<ReadonlyArray<GuestShareRecord>, GuestShareRepositoryError>;
  readonly getById: (
    shareId: GuestShareId,
  ) => Effect.Effect<Option.Option<GuestShareRecord>, GuestShareRepositoryError>;
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<GuestShareRecord>, GuestShareRepositoryError>;
  /** Inserts the share; fails when its thread already has one (the caller ends that one first). */
  readonly insert: (record: GuestShareRecord) => Effect.Effect<void, GuestShareRepositoryError>;
  /** Replaces the row with this id; false when the share no longer exists. */
  readonly update: (record: GuestShareRecord) => Effect.Effect<boolean, GuestShareRepositoryError>;
  readonly deleteById: (shareId: GuestShareId) => Effect.Effect<void, GuestShareRepositoryError>;
}

export class GuestShareRepository extends ServiceMap.Service<
  GuestShareRepository,
  GuestShareRepositoryShape
>()("moss/persistence/Services/GuestShareRepository") {}
