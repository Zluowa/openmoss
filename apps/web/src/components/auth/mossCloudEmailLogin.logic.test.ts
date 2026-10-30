import { ProviderInstanceId, ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "~/composerDraftStore";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  completeMossCloudEmailLogin,
  resolveMossCloudEmailLoginDestination,
  shouldRedirectExistingMossCloudEmailSession,
} from "./mossCloudEmailLogin.logic";

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("Moss Cloud email login completion", () => {
  beforeEach(resetComposerDraftStore);

  it("activates the synchronized Moss channel, preserves the draft, and opens chat", async () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-email-moss-selection");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-email-moss-selection"),
    });
    store.setPrompt(threadId, "keep this email-login draft");
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
    const navigate = vi.fn(async () => undefined);

    await expect(
      completeMossCloudEmailLogin({
        addAccount: false,
        authenticated: true,
        navigate,
        queryClient,
      }),
    ).resolves.toBe(true);

    expect(navigate).toHaveBeenCalledWith("/");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "keep this email-login draft",
      activeProvider: "codex_moss",
    });
  });

  it("keeps add-account completion on the account page without changing the draft source", async () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-add-email-account");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-add-email-account"),
    });
    store.setPrompt(threadId, "keep this add-account draft");
    store.setModelSelection(threadId, {
      provider: "codex",
      instanceId: ProviderInstanceId.makeUnsafe("codex_byok"),
      model: "gpt-5.5",
    });
    queryClient.setQueryData(serverQueryKeys.settings(), {
      textGenerationModelSelection: {
        provider: "codex",
        instanceId: "codex_moss",
        model: "gpt-5.5",
      },
    });
    const navigate = vi.fn(async () => undefined);

    await completeMossCloudEmailLogin({
      addAccount: true,
      authenticated: true,
      navigate,
      queryClient,
    });

    expect(navigate).toHaveBeenCalledWith("/account");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "keep this add-account draft",
      activeProvider: "codex_byok",
    });
  });

  it("does not navigate when sign-in still requires verification", async () => {
    const navigate = vi.fn(async () => undefined);

    await expect(
      completeMossCloudEmailLogin({
        addAccount: false,
        authenticated: false,
        navigate,
        queryClient: new QueryClient(),
      }),
    ).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("fails closed when the synchronized selection is absent or still points to BYOK", async () => {
    for (const selection of [
      undefined,
      {
        provider: "codex",
        instanceId: ProviderInstanceId.makeUnsafe("codex_byok"),
        model: "gpt-5.5",
      },
    ] as const) {
      resetComposerDraftStore();
      const queryClient = new QueryClient();
      const threadId = ThreadId.makeUnsafe(`draft-email-fail-closed-${selection?.instanceId}`);
      const store = useComposerDraftStore.getState();
      store.registerDraftThread(threadId, {
        projectId: ProjectId.makeUnsafe(`project-email-fail-closed-${selection?.instanceId}`),
      });
      store.setModelSelection(threadId, {
        provider: "codex",
        instanceId: ProviderInstanceId.makeUnsafe("codex"),
        model: "gpt-5.4",
      });
      if (selection) {
        queryClient.setQueryData(serverQueryKeys.settings(), {
          textGenerationModelSelection: selection,
        });
      }
      const navigate = vi.fn(async () => undefined);

      await expect(
        completeMossCloudEmailLogin({
          addAccount: false,
          authenticated: true,
          navigate,
          queryClient,
        }),
      ).resolves.toBe(false);

      expect(navigate).not.toHaveBeenCalled();
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        activeProvider: "codex",
      });
    }
  });

  it("synchronizes an existing session before activating the exact Moss channel", async () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-existing-email-session");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-existing-email-session"),
    });
    store.setModelSelection(threadId, {
      provider: "codex",
      instanceId: ProviderInstanceId.makeUnsafe("codex_byok"),
      model: "gpt-5.5",
    });
    const navigate = vi.fn(async () => undefined);
    const synchronize = vi.fn(async () => {
      queryClient.setQueryData(serverQueryKeys.settings(), {
        textGenerationModelSelection: {
          provider: "codex",
          instanceId: "codex_moss",
          model: "gpt-5.5",
        },
      });
    });

    await expect(
      completeMossCloudEmailLogin({
        addAccount: false,
        authenticated: true,
        navigate,
        queryClient,
        synchronize,
      }),
    ).resolves.toBe(true);

    expect(synchronize).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      activeProvider: "codex_moss",
    });
  });

  it("does not navigate when an existing-session synchronization fails", async () => {
    const navigate = vi.fn(async () => undefined);
    const synchronize = vi.fn(async () => {
      throw new Error("fixture synchronization failure");
    });

    await expect(
      completeMossCloudEmailLogin({
        addAccount: false,
        authenticated: true,
        navigate,
        queryClient: new QueryClient(),
        synchronize,
      }),
    ).rejects.toThrow(/fixture synchronization failure/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes ordinary and add-account login to their distinct destinations", () => {
    expect(resolveMossCloudEmailLoginDestination(false)).toBe("/");
    expect(resolveMossCloudEmailLoginDestination(true)).toBe("/account");
  });

  it("auto-opens chat only for an existing ordinary-login session", () => {
    expect(
      shouldRedirectExistingMossCloudEmailSession({
        addAccount: false,
        authenticated: true,
        mutationIdle: true,
      }),
    ).toBe(true);
    expect(
      shouldRedirectExistingMossCloudEmailSession({
        addAccount: true,
        authenticated: true,
        mutationIdle: true,
      }),
    ).toBe(false);
    expect(
      shouldRedirectExistingMossCloudEmailSession({
        addAccount: false,
        authenticated: true,
        mutationIdle: false,
      }),
    ).toBe(false);
  });
});
