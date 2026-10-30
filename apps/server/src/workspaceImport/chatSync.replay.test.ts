import { describe, expect, it } from "vitest";
import { orderChatPlansForReplay, planChatSync } from "./chatSync";
import type { CollectedImportChat } from "./chats";
const now = "2026-09-06T09:00:00.000Z";
const chat = (id: string, parent?: string): CollectedImportChat => ({
  source: "codex",
  sourceId: id,
  title: id,
  workingDirectory: "/tmp",
  updatedAt: now,
  messages: [],
  connectors: [],
  nativeThreadId: id,
  ...(parent ? { nativeParentThreadId: parent } : {}),
  replayFingerprint: "a".repeat(64),
});
const plans = (chats: CollectedImportChat[]) =>
  planChatSync({
    chats,
    ledger: { version: 1, entries: {} },
    existingThreadIds: new Set(),
    nowIso: now,
    createThreadId: (chat) => chat!.sourceId,
  });
describe("workspace canonical replay sync", () => {
  it("orders descendants after their parents and breaks cycles without aborting", () => {
    expect(
      orderChatPlansForReplay(plans([chat("child", "parent"), chat("parent")])).map(
        (plan) => plan.threadId,
      ),
    ).toEqual(["parent", "child"]);
    const cycled = orderChatPlansForReplay(plans([chat("a", "b"), chat("b", "a")])).map(
      (plan) => plan.threadId,
    );
    expect(cycled.toSorted()).toEqual(["a", "b"]);
    expect(cycled).toHaveLength(2);
  });
  it("updates a tool-only change even when message count and timestamp are unchanged", () => {
    const initial = plans([chat("parent")])[0]!;
    const input = {
      chats: [chat("parent")],
      ledger: { version: 1 as const, entries: { "codex:parent": initial.ledgerEntry } },
      existingThreadIds: new Set(["parent"]),
      nowIso: now,
      createThreadId: () => "unexpected",
    };
    expect(planChatSync(input)[0]?.action).toBe("unchanged");
    expect(
      planChatSync({
        ...input,
        chats: [{ ...chat("parent"), replayFingerprint: "b".repeat(64) }],
      })[0]?.action,
    ).toBe("updated");
  });
});
