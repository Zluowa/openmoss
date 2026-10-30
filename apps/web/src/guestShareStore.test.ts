import type { GuestMessageId, GuestShareId, ThreadGuestShare, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  applyGuestShareOwnerEvent,
  type GuestShareState,
  selectPendingGuestMessageCount,
  selectThreadGuestShare,
  useGuestShareStore,
} from "./guestShareStore";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;

function share(overrides: Partial<ThreadGuestShare> = {}): ThreadGuestShare {
  return {
    id: "AAAAAAAAAAAAAAAAAAAAAA" as GuestShareId,
    threadId: THREAD_A,
    relayOrigin: "https://moss-share.example",
    inviteUrl: "https://moss-share.example/s/AAAAAAAAAAAAAAAAAAAAAA#invite",
    createdAt: "2026-10-29T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    guestName: null,
    guestJoinedAt: null,
    messages: [],
    relayStatus: "online",
    ...overrides,
  };
}

const EMPTY: GuestShareState = { sharesByThreadId: {}, hydrated: false };

describe("applyGuestShareOwnerEvent", () => {
  it("replaces everything with a snapshot and marks the store hydrated", () => {
    const stale = share({ threadId: THREAD_B, id: "BBBBBBBBBBBBBBBBBBBBBB" as GuestShareId });
    const next = applyGuestShareOwnerEvent(
      { sharesByThreadId: { [THREAD_B]: stale }, hydrated: false },
      { type: "snapshot", shares: [share()] },
    );

    expect(next.hydrated).toBe(true);
    expect(Object.keys(next.sharesByThreadId)).toEqual([THREAD_A]);
    expect(next.sharesByThreadId[THREAD_A]?.inviteUrl).toContain("#invite");
  });

  it("upserts a thread's share without touching other threads", () => {
    const other = share({ threadId: THREAD_B, id: "BBBBBBBBBBBBBBBBBBBBBB" as GuestShareId });
    const seeded = applyGuestShareOwnerEvent(EMPTY, { type: "snapshot", shares: [other] });
    const joined = share({
      guestName: "Ada",
      guestJoinedAt: "2026-10-29T10:05:00.000Z",
      inviteUrl: null,
    });

    const next = applyGuestShareOwnerEvent(seeded, { type: "upsert", share: joined });

    expect(next.sharesByThreadId[THREAD_A]).toBe(joined);
    expect(next.sharesByThreadId[THREAD_B]).toBe(other);
  });

  it("keeps the same state object for an upsert of the identical share", () => {
    const current = share();
    const seeded = applyGuestShareOwnerEvent(EMPTY, { type: "snapshot", shares: [current] });

    expect(applyGuestShareOwnerEvent(seeded, { type: "upsert", share: current })).toBe(seeded);
  });

  it("removes a share only when the share id still matches", () => {
    const replaced = share({ id: "CCCCCCCCCCCCCCCCCCCCCC" as GuestShareId });
    const seeded = applyGuestShareOwnerEvent(EMPTY, { type: "snapshot", shares: [replaced] });

    const staleRemove = applyGuestShareOwnerEvent(seeded, {
      type: "remove",
      threadId: THREAD_A,
      shareId: "AAAAAAAAAAAAAAAAAAAAAA" as GuestShareId,
    });
    expect(staleRemove).toBe(seeded);

    const removed = applyGuestShareOwnerEvent(seeded, {
      type: "remove",
      threadId: THREAD_A,
      shareId: replaced.id,
    });
    expect(removed.sharesByThreadId[THREAD_A]).toBeUndefined();
    expect(removed.hydrated).toBe(true);
  });
});

describe("useGuestShareStore", () => {
  it("applies events and exposes the pending-count selector", () => {
    useGuestShareStore.getState().clear();
    useGuestShareStore.getState().applyEvent({
      type: "upsert",
      share: share({
        guestName: "Ada",
        messages: [
          {
            id: "m1" as GuestMessageId,
            text: "First",
            status: "pending",
            submittedAt: "2026-10-29T10:06:00.000Z",
            attachments: [],
          },
          {
            id: "m2" as GuestMessageId,
            text: "Second",
            status: "sent",
            submittedAt: "2026-10-29T10:07:00.000Z",
            attachments: [],
          },
        ],
      }),
    });

    const state = useGuestShareStore.getState();
    expect(selectThreadGuestShare(THREAD_A)(state)?.guestName).toBe("Ada");
    expect(selectPendingGuestMessageCount(THREAD_A)(state)).toBe(1);
    expect(selectPendingGuestMessageCount(THREAD_B)(state)).toBe(0);
    expect(selectThreadGuestShare(THREAD_B)(state)).toBeNull();

    useGuestShareStore.getState().clear();
    expect(useGuestShareStore.getState().hydrated).toBe(false);
  });
});
