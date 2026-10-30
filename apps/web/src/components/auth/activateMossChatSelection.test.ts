import { QueryClient } from "@tanstack/react-query";
import { ProviderInstanceId, ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "~/composerDraftStore";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  activateMossChatSelection,
  MOSS_IMMEDIATE_MODEL_SELECTION,
} from "./activateMossChatSelection";

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("activateMossChatSelection", () => {
  beforeEach(resetComposerDraftStore);

  it("uses GPT-5.6 Terra as the immediate post-login model", () => {
    expect(MOSS_IMMEDIATE_MODEL_SELECTION).toEqual({
      provider: "codex",
      instanceId: "codex_moss",
      model: "gpt-5.6-terra",
    });
  });

  it("snaps a foreign Moss selection onto the CN allowlist", () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-remap-cn-allowlist");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-remap-cn-allowlist"),
    });
    queryClient.setQueryData(serverQueryKeys.settings(), {
      textGenerationModelSelection: {
        provider: "codex",
        instanceId: "codex_moss",
        model: "gpt-5.6-luna",
      },
      providerInstances: {
        codex_moss: {
          driver: "codex",
          enabled: true,
          config: {
            modelAllowlist: ["deepseek-v4-pro", "glm-5.3"],
          },
        },
      },
    });

    expect(activateMossChatSelection(queryClient)).toBe(true);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_moss).toEqual({
      provider: "codex",
      instanceId: "codex_moss",
      model: "deepseek-v4-pro",
    });
  });

  it.each([
    { model: "gpt-5.6-luna", expected: "gpt-5.6-luna" },
    { model: "gpt-5.5", expected: "gpt-5.6-terra" },
  ])("resolves the persisted Moss selection $model to $expected", ({ model, expected }) => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-remap-luna-moss-selection");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-remap-luna-moss-selection"),
    });
    queryClient.setQueryData(serverQueryKeys.settings(), {
      textGenerationModelSelection: {
        provider: "codex",
        instanceId: "codex_moss",
        model,
      },
    });

    expect(activateMossChatSelection(queryClient)).toBe(true);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_moss).toEqual({
      provider: "codex",
      instanceId: "codex_moss",
      model: expected,
    });
  });

  it("activates the synchronized server selection and preserves draft content", () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-synchronized-moss-selection");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-synchronized-moss-selection"),
    });
    store.setPrompt(threadId, "keep this prompt");
    store.setModelSelection(threadId, {
      provider: "codex",
      instanceId: ProviderInstanceId.makeUnsafe("codex"),
      model: "gpt-5.4",
    });
    queryClient.setQueryData(serverQueryKeys.settings(), {
      textGenerationModelSelection: {
        provider: "codex",
        instanceId: "codex_moss",
        model: "gpt-5.5",
      },
    });

    expect(activateMossChatSelection(queryClient)).toBe(true);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "keep this prompt",
      activeProvider: "codex_moss",
    });
  });
});
