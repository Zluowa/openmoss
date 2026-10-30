import { MessageId, ThreadId, type ThreadId as ThreadIdType } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import type { ChatMessage, Thread } from "../types";
import { createPastedTextDraft } from "./composerPastedText";
import { attachQuickChatToTask, canAttachQuickChatThread } from "./quickChatAttachment";
import { parseQuickChatReferenceContext } from "./quickChatReference";

function message(input: {
  readonly id: string;
  readonly role: ChatMessage["role"];
  readonly text: string;
  readonly streaming?: boolean;
}): ChatMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.text,
    createdAt: "2026-07-10T10:00:00.000Z",
    completedAt: input.streaming ? undefined : "2026-07-10T10:00:01.000Z",
    streaming: input.streaming ?? false,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("quick-chat-1"),
    codexThreadId: "server-quick-chat-1",
    projectId: "project-1" as Thread["projectId"],
    title: "Quick question",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [message({ id: "m1", role: "user", text: "What changed?" })],
    proposedPlans: [],
    error: null,
    createdAt: "2026-07-10T10:00:00.000Z",
    latestTurn: null,
    turnDiffSummaries: [],
    activities: [],
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function resetStores(): void {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useComposerFocusRequestStore.setState({ requestsByThreadId: {} });
}

beforeEach(resetStores);
afterEach(resetStores);

describe("canAttachQuickChatThread", () => {
  const targetId = ThreadId.makeUnsafe("task-1");

  it("requires a different target and a durable conversation identity", () => {
    expect(canAttachQuickChatThread({ source: thread(), targetId })).toBe(true);
    expect(canAttachQuickChatThread({ source: thread(), targetId: null })).toBe(false);
    expect(
      canAttachQuickChatThread({
        source: thread(),
        targetId: ThreadId.makeUnsafe("quick-chat-1"),
      }),
    ).toBe(false);
    expect(
      canAttachQuickChatThread({
        source: thread({ codexThreadId: null, session: null }),
        targetId,
      }),
    ).toBe(false);
  });

  it("remains attachable while a durable conversation is streaming", () => {
    expect(
      canAttachQuickChatThread({
        source: thread({
          messages: [
            message({ id: "m1", role: "user", text: "completed question" }),
            message({ id: "m2", role: "assistant", text: "partial", streaming: true }),
          ],
        }),
        targetId,
      }),
    ).toBe(true);
  });

  it("accepts the Moss thread id when a provider session proves persistence", () => {
    expect(
      canAttachQuickChatThread({
        source: thread({
          codexThreadId: null,
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-07-10T10:00:00.000Z",
            updatedAt: "2026-07-10T10:00:01.000Z",
            orchestrationStatus: "idle",
          },
        }),
        targetId,
      }),
    ).toBe(true);
  });
});

describe("attachQuickChatToTask", () => {
  const targetId = ThreadId.makeUnsafe("task-1");

  it("stores a replaceable structured reference without copying transcript text", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(targetId, "Keep my draft prompt");
    store.addPastedTexts(targetId, [
      createPastedTextDraft({
        id: "other-context",
        createdAt: "2026-07-10T09:00:00.000Z",
        text: "Existing context",
      }),
    ]);

    expect(
      attachQuickChatToTask({
        source: thread(),
        targetId,
        now: "2026-07-10T10:10:00.000Z",
      }),
    ).toBe(true);
    expect(
      attachQuickChatToTask({
        source: thread({
          title: "  Updated   question  ",
          messages: [message({ id: "m2", role: "assistant", text: "Updated answer" })],
        }),
        targetId,
        now: new Date("2026-07-10T10:20:00.000Z"),
      }),
    ).toBe(true);

    const draft = useComposerDraftStore.getState().draftsByThreadId[targetId];
    expect(draft?.prompt).toBe("Keep my draft prompt");
    expect(draft?.pastedTexts.map((pasted) => pasted.id)).toEqual([
      "other-context",
      "quick-chat-reference:quick-chat-1",
    ]);
    expect(draft?.pastedTexts[0]?.text).toBe("Existing context");

    const referenceContext = draft?.pastedTexts[1];
    expect(referenceContext).toMatchObject({
      createdAt: "2026-07-10T10:20:00.000Z",
    });
    expect(referenceContext?.text).not.toContain("What changed?");
    expect(referenceContext?.text).not.toContain("Updated answer");
    expect(referenceContext?.text.length).toBeLessThan(512);
    expect(parseQuickChatReferenceContext(referenceContext?.text ?? "")).toEqual({
      type: "quick-chat",
      version: 1,
      conversationId: "server-quick-chat-1",
      threadId: "quick-chat-1",
      title: "Updated question",
    });
    expect(useComposerFocusRequestStore.getState().requestsByThreadId[targetId]).toBe(2);
  });

  it("uses the stable Moss thread id when there is no provider conversation id", () => {
    const source = thread({
      codexThreadId: null,
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-07-10T10:00:00.000Z",
        updatedAt: "2026-07-10T10:00:01.000Z",
        orchestrationStatus: "idle",
      },
    });

    expect(attachQuickChatToTask({ source, targetId })).toBe(true);
    const context = useComposerDraftStore.getState().draftsByThreadId[targetId]?.pastedTexts[0];
    expect(parseQuickChatReferenceContext(context?.text ?? "")?.conversationId).toBe(
      "quick-chat-1",
    );
  });

  it("leaves target state untouched when attachment is disabled", () => {
    const emptyTarget = "" as ThreadIdType;
    expect(
      attachQuickChatToTask({
        source: thread({ codexThreadId: null, session: null }),
        targetId: emptyTarget,
      }),
    ).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId).toEqual({});
    expect(useComposerFocusRequestStore.getState().requestsByThreadId).toEqual({});
  });
});
