import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { QUICK_CHAT_DEFAULT_SIZE, resolveQuickChatWindowPosition } from "./QuickChat.logic";
import type { QuickChatItem } from "./QuickChat.logic";

vi.mock("./ChatView", () => ({ default: () => null }));

type SidebarQuickChatModule = typeof import("./SidebarQuickChat");

let quickChatResizeDirections: SidebarQuickChatModule["quickChatResizeDirections"];
let resizedQuickChatSize: SidebarQuickChatModule["resizedQuickChatSize"];
let shouldDisableQuickChatAttach: SidebarQuickChatModule["shouldDisableQuickChatAttach"];
let discardUnpromotedQuickChatDraft: SidebarQuickChatModule["discardUnpromotedQuickChatDraft"];
let useComposerDraftStore: typeof import("../composerDraftStore").useComposerDraftStore;

const lifecycleDraftIds = [
  ThreadId.makeUnsafe("quick-chat-local-draft"),
  ThreadId.makeUnsafe("quick-chat-promoted-draft"),
] as const;

beforeAll(async () => {
  vi.stubGlobal("self", globalThis);
  const module = await import("./SidebarQuickChat");
  quickChatResizeDirections = module.quickChatResizeDirections;
  resizedQuickChatSize = module.resizedQuickChatSize;
  shouldDisableQuickChatAttach = module.shouldDisableQuickChatAttach;
  discardUnpromotedQuickChatDraft = module.discardUnpromotedQuickChatDraft;
  ({ useComposerDraftStore } = await import("../composerDraftStore"));
});

afterEach(() => {
  for (const threadId of lifecycleDraftIds) {
    useComposerDraftStore.getState().clearDraftThread(threadId);
  }
});

describe("Quick Chat resize handles", () => {
  const viewport = { width: 1_400, height: 900 };

  it("only exposes edges that can track the pointer for a bottom dock", () => {
    expect(quickChatResizeDirections("bottom-right")).toEqual(["n", "w", "nw"]);
    expect(quickChatResizeDirections("bottom-left")).toEqual(["n", "ne", "e"]);
  });

  it("keeps the anchored edge fixed while the opposite edge follows the pointer", () => {
    const startPosition = resolveQuickChatWindowPosition(
      "bottom-right",
      QUICK_CHAT_DEFAULT_SIZE,
      viewport,
    );
    const nextSize = resizedQuickChatSize(
      "w",
      QUICK_CHAT_DEFAULT_SIZE,
      -40,
      0,
      viewport,
      "bottom-right",
    );
    const nextPosition = resolveQuickChatWindowPosition("bottom-right", nextSize, viewport);

    expect(nextSize.width).toBe(600);
    expect(nextPosition.x).toBe(startPosition.x - 40);
    expect(nextPosition.x + nextSize.width).toBe(startPosition.x + QUICK_CHAT_DEFAULT_SIZE.width);
  });

  it("doubles centered resize deltas so the grabbed edge moves one-to-one", () => {
    const startPosition = resolveQuickChatWindowPosition(
      "center",
      QUICK_CHAT_DEFAULT_SIZE,
      viewport,
    );
    const nextSize = resizedQuickChatSize("e", QUICK_CHAT_DEFAULT_SIZE, 40, 0, viewport, "center");
    const nextPosition = resolveQuickChatWindowPosition("center", nextSize, viewport);

    expect(nextSize.width).toBe(640);
    expect(nextPosition.x + nextSize.width).toBe(
      startPosition.x + QUICK_CHAT_DEFAULT_SIZE.width + 40,
    );
  });
});

describe("Quick Chat attach state", () => {
  const threadId = ThreadId.makeUnsafe("quick-chat-thread");
  const activeThread = {
    id: threadId,
    projectId: "home-chat-project",
    title: "Quick Chat",
    updatedAt: "2026-07-10T12:00:00.000Z",
    isPinned: false,
    unread: false,
    streaming: false,
  } as QuickChatItem;

  it("keeps a durable active conversation attachable while it is streaming", () => {
    expect(
      shouldDisableQuickChatAttach({
        activeThreadId: threadId,
        activeThread: { ...activeThread, streaming: true },
        attaching: false,
      }),
    ).toBe(false);
    expect(
      shouldDisableQuickChatAttach({
        activeThreadId: threadId,
        activeThread,
        attaching: true,
      }),
    ).toBe(true);
  });
});

describe("Quick Chat detached draft lifecycle", () => {
  const projectId = ProjectId.makeUnsafe("quick-chat-project");

  it("discards a local draft once Quick Chat can no longer reach it", () => {
    const [threadId] = lifecycleDraftIds;
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, { projectId });
    store.setPrompt(threadId, "unsent quick chat");

    expect(discardUnpromotedQuickChatDraft(threadId)).toBe(true);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("never discards a draft after its durable thread starts promotion", () => {
    const [, threadId] = lifecycleDraftIds;
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, { projectId });
    store.setPrompt(threadId, "send this quick chat");
    store.markDraftThreadPromoting(threadId);

    expect(discardUnpromotedQuickChatDraft(threadId)).toBe(false);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "send this quick chat",
    );
  });
});
