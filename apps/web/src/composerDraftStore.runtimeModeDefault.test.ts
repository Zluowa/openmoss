// A new chat's permission mode: someone who never chose one starts asking first (Claude
// desktop's default); a mode they pick is kept for their new chats; a profile saved before
// this rule keeps full access, the default it ran in. No stored choice is ever changed.
import { ProjectId, ThreadId } from "@moss/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";
import { COMPOSER_DRAFT_STORAGE_VERSION } from "./composerDraftDomain";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
} from "./composerDraftPersistence";
import { resetComposerDraftStore } from "./composerDraftStoreTestFixtures";
import { createFreshDraftThreadSeed } from "./lib/threadBootstrap";

const projectId = ProjectId.makeUnsafe("project-permission-default");

function newDraftMode(id: string) {
  const threadId = ThreadId.makeUnsafe(id);
  useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId);
  return useComposerDraftStore.getState().draftThreadsByThreadId[threadId]?.runtimeMode;
}

describe("a new chat's permission mode", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("asks first in a fresh profile, for every way a new chat starts", () => {
    expect(useComposerDraftStore.getState().stickyRuntimeMode).toBeNull();
    expect(newDraftMode("fresh-chat")).toBe("approval-required");
    const kanbanThread = ThreadId.makeUnsafe("fresh-task");
    useComposerDraftStore.getState().registerDraftThread(kanbanThread, { projectId });
    expect(useComposerDraftStore.getState().draftThreadsByThreadId[kanbanThread]?.runtimeMode).toBe(
      "approval-required",
    );
    expect(
      createFreshDraftThreadSeed({
        createdAt: "2026-11-19T00:00:00.000Z",
        entryPoint: "chat",
        options: undefined,
        newChatRuntimeMode: useComposerDraftStore.getState().stickyRuntimeMode,
      }).runtimeMode,
    ).toBe("approval-required");
  });

  it("keeps the mode a person picked for their new chats, across a reload", () => {
    useComposerDraftStore.getState().setStickyRuntimeMode("full-access");
    expect(newDraftMode("after-pick")).toBe("full-access");

    const saved = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    expect(saved.stickyRuntimeMode).toBe("full-access");
    const reloaded = migratePersistedComposerDraftStoreState(
      JSON.parse(JSON.stringify(saved)),
      COMPOSER_DRAFT_STORAGE_VERSION,
    );
    expect(reloaded.stickyRuntimeMode).toBe("full-access");
  });

  it("keeps full access for a profile saved before this rule, and every chat's own mode", () => {
    const existingChat = ThreadId.makeUnsafe("owner-chat");
    const savedBefore = {
      draftsByThreadId: {},
      draftThreadsByThreadId: {
        [existingChat]: {
          projectId,
          createdAt: "2026-11-10T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    };
    const migrated = migratePersistedComposerDraftStoreState(savedBefore, 6);
    expect(migrated.stickyRuntimeMode).toBe("full-access");
    expect(migrated.draftThreadsByThreadId[existingChat]?.runtimeMode).toBe("full-access");

    // A pick stored before the version bump is never replaced.
    expect(
      migratePersistedComposerDraftStoreState({ ...savedBefore, stickyRuntimeMode: "auto" }, 6)
        .stickyRuntimeMode,
    ).toBe("auto");
  });

  it("does not invent a choice for a profile that started on this version", () => {
    const freshSaved = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    expect(
      migratePersistedComposerDraftStoreState(freshSaved, COMPOSER_DRAFT_STORAGE_VERSION)
        .stickyRuntimeMode ?? null,
    ).toBeNull();
    expect(normalizeCurrentPersistedComposerDraftStoreState(freshSaved).stickyRuntimeMode).toBe(
      undefined,
    );
  });
});
