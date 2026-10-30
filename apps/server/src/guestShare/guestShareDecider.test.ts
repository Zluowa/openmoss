import {
  GUEST_PENDING_ATTACHMENT_BYTES_LIMIT,
  GUEST_PENDING_MESSAGE_LIMIT,
  GUEST_RESOLVED_MESSAGE_LIMIT,
  GUEST_SHARE_TTL_MS,
  GuestMessageId,
  GuestShareId,
  MessageId,
  ThreadId,
  type GuestMessageAttachment,
  type ThreadGuestMessage,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { GuestShareRecord } from "../persistence/Services/GuestShareRepository.ts";
import {
  guestInviteUrl,
  guestShareView,
  guestThreadModel,
  openGuestShare,
  redeemGuestShare,
  releasedGuestAttachments,
  resolveGuestMessage,
  revertSentGuestMessage,
  submitGuestMessage,
  toThreadGuestShare,
  trimResolved,
  withSentGuestMessage,
} from "./guestShareDecider.ts";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const SHARE_ID = GuestShareId.makeUnsafe("AAAAAAAAAAAAAAAAAAAAAA");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

const image = (id: string, sizeBytes: number): GuestMessageAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes,
});

const message = (
  id: string,
  status: ThreadGuestMessage["status"],
  attachments: ReadonlyArray<GuestMessageAttachment> = [],
): ThreadGuestMessage => ({
  id: GuestMessageId.makeUnsafe(id),
  text: `message ${id}`,
  status,
  submittedAt: new Date(NOW).toISOString(),
  attachments,
});

const joined = (overrides: Partial<GuestShareRecord> = {}): GuestShareRecord => ({
  ...openGuestShare({
    shareId: SHARE_ID,
    threadId: THREAD_ID,
    relayOrigin: "https://moss-share.example",
    nowMs: NOW,
  }),
  guestName: "Ada",
  guestJoinedAt: new Date(NOW).toISOString(),
  ...overrides,
});

describe("openGuestShare", () => {
  it("opens an unredeemed share that lasts the TTL", () => {
    const share = openGuestShare({
      shareId: SHARE_ID,
      threadId: THREAD_ID,
      relayOrigin: "https://moss-share.example",
      nowMs: NOW,
    });
    expect(share).toMatchObject({
      id: SHARE_ID,
      threadId: THREAD_ID,
      guestName: null,
      guestJoinedAt: null,
      messages: [],
      sentMessages: [],
    });
    expect(Date.parse(share.expiresAt) - Date.parse(share.createdAt)).toBe(GUEST_SHARE_TTL_MS);
  });
});

describe("redeemGuestShare", () => {
  it("names the guest once and refuses a second redeem as used", () => {
    const share = joined({ guestName: null, guestJoinedAt: null });
    const first = redeemGuestShare(share, { guestName: "Ada", nowMs: NOW + 1 });
    expect(first.ok && first.value.guestName).toBe("Ada");
    expect(first.ok && first.value.guestJoinedAt).toBe(new Date(NOW + 1).toISOString());
    const second = redeemGuestShare(first.ok ? first.value : share, {
      guestName: "Bob",
      nowMs: NOW + 2,
    });
    expect(second).toEqual({ ok: false, reason: "used" });
  });

  it("refuses an expired link as inactive", () => {
    const share = joined({ guestName: null, guestJoinedAt: null });
    expect(redeemGuestShare(share, { guestName: "Ada", nowMs: NOW + GUEST_SHARE_TTL_MS })).toEqual({
      ok: false,
      reason: "inactive",
    });
  });
});

describe("submitGuestMessage", () => {
  const submit = (
    share: GuestShareRecord,
    attachments: ReadonlyArray<GuestMessageAttachment> = [],
    text = "hi",
  ) =>
    submitGuestMessage(share, {
      guestMessageId: GuestMessageId.makeUnsafe("new"),
      text,
      attachments,
      nowMs: NOW + 5,
    });

  it("appends a pending message", () => {
    const result = submit(joined());
    expect(result.ok && result.value.messages).toEqual([
      {
        id: "new",
        text: "hi",
        status: "pending",
        submittedAt: new Date(NOW + 5).toISOString(),
        attachments: [],
      },
    ]);
  });

  it("refuses before the guest joined and after expiry", () => {
    expect(submit(joined({ guestName: null, guestJoinedAt: null }))).toEqual({
      ok: false,
      reason: "inactive",
    });
    expect(
      submitGuestMessage(joined(), {
        guestMessageId: GuestMessageId.makeUnsafe("late"),
        text: "hi",
        attachments: [],
        nowMs: NOW + GUEST_SHARE_TTL_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "inactive" });
  });

  it("refuses an empty message", () => {
    expect(submit(joined(), [], "")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses when the pending limit is reached", () => {
    const share = joined({
      messages: Array.from({ length: GUEST_PENDING_MESSAGE_LIMIT }, (_, index) =>
        message(`m${index}`, "pending"),
      ),
    });
    expect(submit(share)).toEqual({ ok: false, reason: "busy" });
  });

  it("refuses files once the waiting files would exceed the budget, but still takes text", () => {
    const share = joined({
      messages: [message("m0", "pending", [image("a", GUEST_PENDING_ATTACHMENT_BYTES_LIMIT - 10)])],
    });
    expect(submit(share, [image("b", 11)])).toEqual({ ok: false, reason: "files_busy" });
    expect(submit(share, [image("b", 10)]).ok).toBe(true);
    expect(submit(share).ok).toBe(true);
  });
});

describe("trimResolved", () => {
  it("keeps every pending message and only the newest resolved ones", () => {
    const messages = [
      ...Array.from({ length: GUEST_RESOLVED_MESSAGE_LIMIT + 3 }, (_, index) =>
        message(`sent${index}`, "sent"),
      ),
      message("pending", "pending"),
    ];
    const kept = trimResolved(messages);
    expect(kept).toHaveLength(GUEST_RESOLVED_MESSAGE_LIMIT + 1);
    expect(kept.at(-1)?.id).toBe("pending");
    expect(kept[0]?.id).toBe("sent3");
  });
});

describe("resolveGuestMessage", () => {
  it("marks a pending message and refuses any other state", () => {
    const share = joined({ messages: [message("m", "pending")] });
    const sent = resolveGuestMessage(share, GuestMessageId.makeUnsafe("m"), "sent");
    expect(sent?.messages[0]?.status).toBe("sent");
    expect(resolveGuestMessage(sent!, GuestMessageId.makeUnsafe("m"), "dismissed")).toBeNull();
    expect(resolveGuestMessage(share, GuestMessageId.makeUnsafe("unknown"), "sent")).toBeNull();
  });
});

describe("sent message bookkeeping", () => {
  it("records and reverts the thread message a send produced", () => {
    const share = joined({ messages: [message("m", "pending")] });
    const sent = resolveGuestMessage(share, GuestMessageId.makeUnsafe("m"), "sent")!;
    const marked = withSentGuestMessage(sent, {
      guestMessageId: GuestMessageId.makeUnsafe("m"),
      messageId: MessageId.makeUnsafe("thread-message"),
    });
    expect(marked.sentMessages).toEqual([{ guestMessageId: "m", messageId: "thread-message" }]);
    const reverted = revertSentGuestMessage(marked, GuestMessageId.makeUnsafe("m"));
    expect(reverted.messages[0]?.status).toBe("pending");
    expect(reverted.sentMessages).toEqual([]);
  });
});

describe("releasedGuestAttachments", () => {
  it("releases the files of a dismissed message and keeps a sent message's files", () => {
    const share = joined({
      messages: [
        message("a", "pending", [image("fa", 1)]),
        message("b", "pending", [image("fb", 1)]),
      ],
    });
    const dismissedA = resolveGuestMessage(share, GuestMessageId.makeUnsafe("a"), "dismissed")!;
    expect(releasedGuestAttachments(share, dismissedA).map((a) => a.id)).toEqual(["fa"]);
    const sentB = resolveGuestMessage(share, GuestMessageId.makeUnsafe("b"), "sent")!;
    expect(releasedGuestAttachments(share, sentB)).toEqual([]);
  });

  it("releases every waiting file when the share ends or is replaced", () => {
    const share = joined({
      messages: [message("a", "pending", [image("fa", 1)]), message("s", "sent", [image("fs", 1)])],
    });
    expect(releasedGuestAttachments(share, null).map((a) => a.id)).toEqual(["fa"]);
    const replacement = joined({ id: GuestShareId.makeUnsafe("BBBBBBBBBBBBBBBBBBBBBB") });
    expect(releasedGuestAttachments(share, replacement).map((a) => a.id)).toEqual(["fa"]);
  });
});

describe("views", () => {
  it("shows the owner the link only while it is unused", () => {
    const unused = joined({ guestName: null, guestJoinedAt: null });
    const input = {
      inviteUrl: "https://moss-share.example/s/x#x.y",
      relayStatus: "online",
    } as const;
    expect(toThreadGuestShare(unused, input).inviteUrl).toBe(input.inviteUrl);
    expect(toThreadGuestShare(joined(), input).inviteUrl).toBeNull();
    expect(toThreadGuestShare(joined(), input).relayStatus).toBe("online");
  });

  it("builds the guest view only once the guest joined", () => {
    const model = { provider: "codex", name: "GPT-5.5" } as const;
    expect(guestShareView(joined({ guestName: null, guestJoinedAt: null }), model)).toBeNull();
    expect(guestShareView(joined(), model)).toMatchObject({
      shareId: SHARE_ID,
      guestName: "Ada",
      model,
    });
  });

  it("labels the model like the owner's header and drops a retired provider", () => {
    expect(guestThreadModel({ provider: "codex", instanceId: "codex", model: "gpt-5.5" })).toEqual({
      provider: "codex",
      name: "GPT-5.5",
    });
    expect(
      guestThreadModel({
        provider: "droid",
        instanceId: "droid",
        model: "custom-model-x",
      } as never),
    ).toEqual({ provider: null, name: "Custom Model X" });
  });

  it("puts the invite in the fragment of the guest page URL", () => {
    expect(guestInviteUrl("https://moss-share.example", SHARE_ID, `${SHARE_ID}.sig`)).toBe(
      `https://moss-share.example/s/${SHARE_ID}#${SHARE_ID}.sig`,
    );
  });
});
