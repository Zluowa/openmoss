import { MessageId, ThreadId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

import { wasThreadMessageAccepted } from "./threadTurnReceipt";

describe("turn acceptance after a lost dispatch reply", () => {
  const threadId = ThreadId.makeUnsafe("receipt-thread");
  const messageId = MessageId.makeUnsafe("receipt-message");

  it("recognizes only the exact persisted message, including a turn still starting", async () => {
    const getThreadDetailSnapshot = vi.fn().mockResolvedValue({
      thread: { messages: [{ id: messageId }], session: { status: "starting" } },
    });
    await expect(
      wasThreadMessageAccepted({ getThreadDetailSnapshot }, threadId, messageId),
    ).resolves.toBe(true);
    expect(getThreadDetailSnapshot).toHaveBeenCalledWith({ threadId });
    await expect(
      wasThreadMessageAccepted(
        { getThreadDetailSnapshot },
        threadId,
        MessageId.makeUnsafe("other"),
      ),
    ).resolves.toBe(false);
  });

  it("does not claim acceptance when the authoritative read fails", async () => {
    const getThreadDetailSnapshot = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      wasThreadMessageAccepted({ getThreadDetailSnapshot }, threadId, messageId),
    ).resolves.toBe(false);
  });
});
