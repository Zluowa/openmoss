import { ProviderInstanceId, ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "~/composerDraftStore";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { mossServerQueryKeys } from "./mossServerReactQuery";
import {
  completeMossPhoneLogin,
  resolveMossPhoneAuthenticatedSurface,
} from "./mossPhoneLogin.logic";

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("Moss phone login completion", () => {
  beforeEach(resetComposerDraftStore);

  it("never returns an accepted current-mutation session to the OTP form", () => {
    expect(
      resolveMossPhoneAuthenticatedSurface({
        sessionAuthenticated: false,
        currentMutationAuthenticated: true,
        recoveryError: null,
      }),
    ).toBe("preparing");
    expect(
      resolveMossPhoneAuthenticatedSurface({
        sessionAuthenticated: false,
        currentMutationAuthenticated: true,
        recoveryError: "safe recovery message",
      }),
    ).toBe("recovery");
    expect(
      resolveMossPhoneAuthenticatedSurface({
        sessionAuthenticated: false,
        currentMutationAuthenticated: false,
        recoveryError: null,
      }),
    ).toBe("login");
  });

  it("opens chat with the managed default without waiting for provider synchronization", async () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-restored-phone-session");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-restored-phone-session"),
    });
    store.setPrompt(threadId, "keep restored phone draft");
    store.setModelSelection(threadId, {
      provider: "codex",
      instanceId: ProviderInstanceId.makeUnsafe("codex"),
      model: "gpt-5.4",
    });
    const navigate = vi.fn(async () => undefined);
    let resolveSynchronization!: (settings: never) => void;
    const synchronize = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          resolveSynchronization = resolve;
        }),
    );

    await expect(
      completeMossPhoneLogin({
        authenticated: true,
        navigate,
        queryClient,
        synchronize,
      }),
    ).resolves.toBe(true);

    expect(synchronize).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "keep restored phone draft",
      activeProvider: "codex_moss",
    });
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_moss).toEqual({
      provider: "codex",
      instanceId: "codex_moss",
      model: "deepseek-v4-pro",
    });

    resolveSynchronization({
      textGenerationModelSelection: { instanceId: "codex_moss", model: "deepseek-v4-pro" },
    } as never);

    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        prompt: "keep restored phone draft",
      });
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_moss).toEqual({
        provider: "codex",
        instanceId: "codex_moss",
        model: "deepseek-v4-pro",
      });
    });
  });

  it("keeps provider synchronization failure in the background after accepted login", async () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-stale-phone-readiness");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-stale-phone-readiness"),
    });
    store.setModelSelection(threadId, {
      provider: "codex",
      instanceId: ProviderInstanceId.makeUnsafe("codex"),
      model: "gpt-5.4",
    });
    queryClient.setQueryData(serverQueryKeys.settings(), {
      textGenerationModelSelection: { instanceId: "codex_moss", model: "stale-model" },
    });
    queryClient.setQueryData(serverQueryKeys.config(), {
      providers: [{ instanceId: "codex_moss", status: "warning" }],
    });
    const acceptedPhoneSession = { authenticated: true, session: { id: "phone-session" } };
    queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), acceptedPhoneSession);
    const navigate = vi.fn(async () => undefined);
    const synchronizeFailure = vi.fn(async () => {
      throw new Error("fixture readiness failure");
    });

    await expect(
      completeMossPhoneLogin({
        authenticated: true,
        navigate,
        queryClient,
        synchronize: synchronizeFailure,
      }),
    ).resolves.toBe(true);
    expect(synchronizeFailure).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(mossServerQueryKeys.mossAccountSession())).toEqual(
      acceptedPhoneSession,
    );
    expect(queryClient.getQueryData(serverQueryKeys.settings())).toBeUndefined();
    expect(queryClient.getQueryData(serverQueryKeys.config())).toBeUndefined();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.activeProvider).toBe(
      "codex_moss",
    );
  });

  it("applies an authoritative managed selection when background synchronization completes", async () => {
    const queryClient = new QueryClient();
    const threadId = ThreadId.makeUnsafe("draft-recovered-phone-readiness");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, {
      projectId: ProjectId.makeUnsafe("project-recovered-phone-readiness"),
    });
    store.setModelSelection(threadId, {
      provider: "codex",
      instanceId: ProviderInstanceId.makeUnsafe("codex"),
      model: "gpt-5.4",
    });
    queryClient.setQueryData(serverQueryKeys.settings(), {
      textGenerationModelSelection: { instanceId: "codex", model: "stale-model" },
    });
    const navigate = vi.fn(async () => undefined);
    const authoritativeSettings = {
      textGenerationModelSelection: { instanceId: "codex_moss", model: "gpt-5.6-terra" },
      providerInstances: {
        codex_moss: {
          driver: "codex",
          enabled: true,
          config: {
            modelAllowlist: ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.3"],
          },
        },
      },
    } as const;
    const synchronize = vi.fn(async () => authoritativeSettings as never);

    await expect(
      completeMossPhoneLogin({
        authenticated: true,
        navigate,
        queryClient,
        synchronize,
      }),
    ).resolves.toBe(true);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(serverQueryKeys.settings())).toEqual(authoritativeSettings);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        activeProvider: "codex_moss",
      });
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_moss).toEqual({
        provider: "codex",
        instanceId: "codex_moss",
        model: "deepseek-v4-pro",
      });
    });
  });

  it("does not let a non-managed background snapshot revoke accepted navigation", async () => {
    const navigate = vi.fn(async () => undefined);
    const synchronize = vi.fn(async () => ({
      textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    })) as never;

    await expect(
      completeMossPhoneLogin({
        authenticated: true,
        navigate,
        queryClient: new QueryClient(),
        synchronize,
      }),
    ).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex_moss");
  });

  it("does nothing for an unauthenticated account", async () => {
    const navigate = vi.fn(async () => undefined);
    const synchronize = vi.fn(async () => null);

    await expect(
      completeMossPhoneLogin({
        authenticated: false,
        navigate,
        queryClient: new QueryClient(),
        synchronize,
      }),
    ).resolves.toBe(false);
    expect(synchronize).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
