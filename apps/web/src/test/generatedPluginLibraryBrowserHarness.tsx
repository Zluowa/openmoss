// FILE: generatedPluginLibraryBrowserHarness.tsx
// Purpose: Mount the real generated /skills and /settings route tree with an isolated browser
//          profile, while keeping native RPCs at the typed boundary.
// Layer: Browser integration test support

import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  RealtimeVoiceState,
} from "@synara/contracts";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { getRouter } from "~/router";
import { useStore } from "~/store";
import { initialState } from "~/storeState";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { resetWsNativeApiForTest } from "~/wsNativeApi";
import {
  unconfiguredMossCloudAccountState,
  unconfiguredMossPhoneAccountState,
} from "./mossAccountStateFixtures";
import {
  PluginLibraryNativeFixture,
  restoreBrowserDocumentLocale,
  snapshotBrowserDocumentLocale,
} from "./pluginLibraryBrowserHarness";

const EMPTY_SNAPSHOT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const INACTIVE_REALTIME_VOICE_STATE: RealtimeVoiceState = {
  phase: "inactive",
  sessionId: null,
  threadId: null,
  ownerClaimId: null,
  source: null,
  voice: null,
  requestedModel: null,
  actualModel: null,
  activity: null,
  barrier: {
    requestAccepted: false,
    backendStarted: false,
    webRtcConnected: false,
    dataSessionInitialized: false,
  },
  inputMuted: false,
  outputMuted: false,
  error: null,
};

export interface IsolatedBrowserProfile {
  readonly id: string;
  readonly rootDir: string;
  readonly homeDir: string;
  readonly workspaceRoot: null;
  readonly firstLaunchStore: {
    readonly appSettingsKey: "moss:app-settings:v1";
    readonly registeredWorkspaceRoots: readonly [];
  };
}

interface StorageSnapshot {
  readonly local: ReadonlyArray<readonly [string, string]>;
  readonly session: ReadonlyArray<readonly [string, string]>;
}

function snapshotStorage(storage: Storage): ReadonlyArray<readonly [string, string]> {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .map((key) => [key, storage.getItem(key) ?? ""] as const);
}

function restoreStorage(storage: Storage, entries: ReadonlyArray<readonly [string, string]>): void {
  storage.clear();
  for (const [key, value] of entries) storage.setItem(key, value);
}

function resetClientStoresForFreshProfile(): void {
  useStore.setState(initialState);
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useWorkspacePathsStore.setState({
    homeDir: null,
    chatWorkspaceRoot: null,
    studioWorkspaceRoot: null,
  });
}

function emptyShellSnapshot(): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 0,
    spaces: [],
    projects: [],
    threads: [],
    updatedAt: EMPTY_SNAPSHOT_TIMESTAMP,
  };
}

function emptyReadModel(): OrchestrationReadModel {
  const shell = emptyShellSnapshot();
  return {
    snapshotSequence: shell.snapshotSequence,
    spaces: shell.spaces.map((space) => ({ ...space, deletedAt: null })),
    projects: [],
    threads: [],
    updatedAt: shell.updatedAt,
  };
}

function fallbackNativeMethod(namespace: string, method: string): unknown {
  if (method.startsWith("on")) return () => () => undefined;
  if (method === "subscribeNormalizedSessionEvents" || method.startsWith("subscribe")) {
    return () => undefined;
  }
  if (method === "unsubscribeShell" || method === "unsubscribeThread") {
    return async () => undefined;
  }
  if (method === "getShellSnapshot") return async () => emptyShellSnapshot();
  if (method === "getSnapshot" || method === "repairState") return async () => emptyReadModel();
  if (method === "getThreadDetailSnapshot") return async () => ({ status: "not-found" });
  if (method === "replayEvents") return async () => [];
  if (method === "dispatchCommand") return async () => ({ sequence: 0 });
  if (namespace === "automation" && method === "list") {
    return async () => ({ definitions: [], runs: [] });
  }
  // Contract-shaped list endpoints: server.listProviderUsage and server.listMcpConnectors
  // return bare arrays.
  if (method === "listProviderUsage" || method === "listMcpConnectors") return async () => [];
  if (method.startsWith("list")) return async () => ({ data: [], entries: [], items: [] });
  if (method.startsWith("get")) return async () => null;
  return async () => undefined;
}

function proxyNativeNamespace(namespace: string, value: object): object {
  return new Proxy(value, {
    get(target, property, receiver) {
      const current = Reflect.get(target, property, receiver);
      return current === undefined ? fallbackNativeMethod(namespace, String(property)) : current;
    },
  });
}

function createGeneratedRouteNativeApi(
  fixture: PluginLibraryNativeFixture,
  cwd: string | null | undefined,
  homeDir: string,
): NativeApi {
  const base = fixture.nativeApi() as unknown as Record<PropertyKey, unknown>;
  const server = base.server as Record<PropertyKey, unknown>;

  base.realtimeVoice = {
    listVoices: async () => ({ defaultVoice: "arbor", preferredTransport: "webrtc", voices: [] }),
    claim: async () => ({
      ownerClaimId: "generated-route-fixture-claim",
      expiresAt: 0,
      preferredTransport: "webrtc",
    }),
    releaseClaim: async () => ({ accepted: false }),
    start: async () => {
      throw new Error("Realtime Voice is unavailable in the generated route fixture.");
    },
    reportClientState: async () => INACTIVE_REALTIME_VOICE_STATE,
    resolveScreenContext: async () => ({ accepted: false }),
    appendText: async () => ({ accepted: false }),
    appendSpeech: async () => ({ accepted: false }),
    stop: async () => ({ accepted: false }),
    getState: async () => INACTIVE_REALTIME_VOICE_STATE,
    onEvent: () => () => undefined,
    editKeybindings: async () => ({ applied: 0, failed: 0, results: [] }) as never,
  } satisfies NativeApi["realtimeVoice"];

  server.getMossCloudAccountState = async () => unconfiguredMossCloudAccountState;
  server.getMossAccountSession = async () => unconfiguredMossPhoneAccountState;
  server.getMossEnterpriseKeyState = async () => ({
    configured: false,
    authenticated: false,
    keyPrefix: null,
    verifiedAt: null,
    modelCount: 0,
    active: false,
  });
  server.listWorktrees = async () => ({ worktrees: [] });

  const orchestration = {
    getSnapshot: async () => emptyReadModel(),
    getShellSnapshot: async () => emptyShellSnapshot(),
    getThreadDetailSnapshot: async () => ({ status: "not-found" }),
    dispatchCommand: async () => ({ sequence: 0 }),
    importThread: async () => ({ status: "not-found" }),
    repairState: async () => emptyReadModel(),
    replayEvents: async () => [],
    subscribeShell: async () => undefined,
    unsubscribeShell: async () => undefined,
    subscribeThread: async () => undefined,
    unsubscribeThread: async () => undefined,
    onDomainEvent: () => () => undefined,
    onShellEvent: () => () => undefined,
    onThreadEvent: () => () => undefined,
  };
  base.orchestration = orchestration;

  // The generated shell mounts background subscriptions beyond the plugin page itself. Keep
  // those calls at a deterministic native boundary; the focused assertions still inspect the
  // real projects/provider calls made by the import adapter.
  const namespaced = new Proxy(base, {
    get(target, property, receiver) {
      const current = Reflect.get(target, property, receiver);
      if (current !== undefined && current !== null && typeof current === "object") {
        return proxyNativeNamespace(String(property), current);
      }
      if (current !== undefined) return current;
      return proxyNativeNamespace(String(property), {});
    },
  });

  // The config query is the source of truth for the dialog cwd. The cast keeps the test fixture
  // able to model a fresh user with no registered workspace without changing contracts.
  const configuredApi = namespaced as unknown as NativeApi;
  const configuredServer = configuredApi.server as unknown as {
    getConfig: () => Promise<Record<string, unknown>>;
  };
  const resolvedCwd = cwd === undefined ? "/repo/project" : cwd;
  configuredServer.getConfig = async () => ({
    cwd: resolvedCwd,
    homeDir,
    chatWorkspaceRoot: null,
    studioWorkspaceRoot: null,
    worktreesDir: "/repo/.worktrees",
    keybindingsConfigPath: "/repo/project/.moss-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
  });

  return configuredApi;
}

export async function mountGeneratedPluginApp(input: {
  readonly fixture: PluginLibraryNativeFixture;
  readonly initialEntries?: readonly string[];
  readonly cwd?: string | null;
  readonly freshUser?: boolean;
  readonly locale?: "en" | "zh-CN";
  /** Configure only server responses before the real generated routes mount. */
  readonly configureNativeApi?: (api: NativeApi) => void;
}) {
  const previousNativeApi = window.nativeApi;
  const storageSnapshot: StorageSnapshot = {
    local: snapshotStorage(localStorage),
    session: snapshotStorage(sessionStorage),
  };
  const previousDocumentLocale = snapshotBrowserDocumentLocale();
  const previousStoreState = useStore.getState();
  const previousComposerDraftState = useComposerDraftStore.getState();
  const previousWorkspacePathsState = useWorkspacePathsStore.getState();
  const profileId = `plugin-import-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const profileRoot = `/fixture/plugin-import-profiles/${profileId}`;
  const profile: IsolatedBrowserProfile = {
    id: profileId,
    rootDir: profileRoot,
    homeDir: `${profileRoot}/home`,
    workspaceRoot: null,
    firstLaunchStore: {
      appSettingsKey: "moss:app-settings:v1",
      registeredWorkspaceRoots: [],
    },
  };

  if (input.freshUser) {
    localStorage.clear();
    sessionStorage.clear();
    resetClientStoresForFreshProfile();
    // Locale is the only seeded preference; no workspace/profile registration is seeded.
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ localeOverride: "en" }));
  } else {
    const rawSettings = localStorage.getItem("moss:app-settings:v1");
    let settings: Record<string, unknown> = {};
    if (rawSettings) {
      try {
        const parsed = JSON.parse(rawSettings) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        }
      } catch {
        settings = {};
      }
    }
    localStorage.setItem(
      "moss:app-settings:v1",
      JSON.stringify({ ...settings, localeOverride: input.locale ?? "en" }),
    );
  }

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
  });
  let mountedRouter: ReturnType<typeof getRouter> | undefined;
  let unmountScreen: (() => Promise<void>) | undefined;
  try {
    window.nativeApi = createGeneratedRouteNativeApi(input.fixture, input.cwd, profile.homeDir);
    input.configureNativeApi?.(window.nativeApi);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [...(input.initialEntries ?? ["/skills"])] }),
    );
    mountedRouter = router;
    await router.load();
    document.body.append(host);
    const screen = await render(<RouterProvider router={router} />, { container: host });
    unmountScreen = screen.unmount;

    return {
      fixture: input.fixture,
      host,
      profile,
      router,
      async cleanup() {
        await screen.unmount();
        router.cancelMatches();
        await resetWsNativeApiForTest();
        host.remove();
        useStore.setState(previousStoreState);
        useComposerDraftStore.setState(previousComposerDraftState);
        useWorkspacePathsStore.setState(previousWorkspacePathsState);
        if (previousNativeApi) window.nativeApi = previousNativeApi;
        else delete window.nativeApi;
        restoreStorage(localStorage, storageSnapshot.local);
        restoreStorage(sessionStorage, storageSnapshot.session);
        restoreBrowserDocumentLocale(previousDocumentLocale);
        document.body.innerHTML = "";
      },
    };
  } catch (error) {
    await unmountScreen?.();
    mountedRouter?.cancelMatches();
    await resetWsNativeApiForTest();
    host.remove();
    useStore.setState(previousStoreState);
    useComposerDraftStore.setState(previousComposerDraftState);
    useWorkspacePathsStore.setState(previousWorkspacePathsState);
    if (previousNativeApi) window.nativeApi = previousNativeApi;
    else delete window.nativeApi;
    restoreStorage(localStorage, storageSnapshot.local);
    restoreStorage(sessionStorage, storageSnapshot.session);
    restoreBrowserDocumentLocale(previousDocumentLocale);
    document.body.innerHTML = "";
    throw error;
  }
}
