// @vitest-environment browser
// FILE: SingleChatSurface.browser.tsx
// Purpose: Prove the exported SingleChatSurface owns the real right-dock host contract.

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  type NativeApi,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ServerSettings,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { createBrowserTestServerConfig } from "../../test/browserHarness";
import { useStore } from "../../store";
import { useRightDockStore } from "../../rightDockStore";
import {
  getMcpAppDockEntries,
  makeMcpAppDockEntryId,
  registerMcpAppDockEntry,
  requestMcpAppDisplayMode,
  resetMcpAppDockRegistryForTests,
} from "../../lib/mcpAppDockRegistry";
import { SidebarProvider } from "../ui/sidebar";
import { RealtimeVoiceControllerProvider } from "./RealtimeVoiceControllerProvider";
import { SingleChatSurface } from "./SingleChatSurface";

const surfaceHarness = vi.hoisted(() => ({ useRealChatView: false }));
const SurfaceStub = vi.hoisted(() => () => <div data-single-chat-surface-child="true" />);

vi.mock("./ChatThreadSurfacePrimitives", async () => {
  const actual = await vi.importActual<typeof import("./ChatThreadSurfacePrimitives")>(
    "./ChatThreadSurfacePrimitives",
  );
  return {
    ...actual,
    ChatMountLoader: SurfaceStub,
    DeferredChatView: (props: Parameters<typeof actual.DeferredChatView>[0]) =>
      surfaceHarness.useRealChatView ? <actual.DeferredChatView {...props} /> : <SurfaceStub />,
    LazyBrowserPanel: SurfaceStub,
    LazyDevicePanel: SurfaceStub,
    LazyDiffPanel: SurfaceStub,
    noopChatSurfaceAction: () => undefined,
  };
});

vi.mock("../../hooks/useBrowserPanelDesktopBridge", () => ({
  useBrowserPanelDesktopBridge: () => undefined,
}));

vi.mock("../../hooks/useDeviceEventBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useDeviceEventBridge")>()),
  useDeviceEventBridge: () => undefined,
}));

vi.mock("../../hooks/useDeviceSupport", () => ({
  useDeviceSupport: () => false,
}));

vi.mock("../../hooks/useDockPaneRuntimeActivation", () => ({
  useDockPaneRuntimeActivation: () => ({
    activePaneRuntimeMode: "live",
    requestActivePaneLive: () => undefined,
    requestImmediateHydration: () => undefined,
  }),
}));

vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    handleNewThread: async () => null,
  }),
}));

vi.mock("../../hooks/useRepoDiffTotals", () => ({
  useRepoDiffTotals: () => ({
    additions: 0,
    deletions: 0,
    fileCount: 0,
    hasChanges: false,
  }),
}));

vi.mock("../pullRequest/usePullRequestPaneStateIcon", () => ({
  usePullRequestPaneStateIcon: () => null,
}));

const THREAD_ID = "single-chat-surface-host" as ThreadId;
const PROJECT_ID = "single-chat-surface-project" as ProjectId;
const CHECKED_AT = "2026-08-28T00:00:00.000Z";

function makeNamespace(defaults: Record<string, unknown> = {}) {
  const fallback = vi.fn(async () => ({}));
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(defaults, {
    get(target, key: string | symbol) {
      if (key in target) return Reflect.get(target, key);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const value =
        typeof key === "string" && key.startsWith("on") ? () => () => undefined : fallback;
      cache.set(key, value);
      return value;
    },
  });
}

function makeNativeApi(
  options: {
    config?: ServerConfig;
    settings?: ServerSettings;
    providerUsageSnapshot?: unknown;
    openExternal?: (url: string) => Promise<boolean>;
  } = {},
): NativeApi {
  const config = options.config ?? createBrowserTestServerConfig(CHECKED_AT);
  const settings = options.settings ?? DEFAULT_SERVER_SETTINGS;
  return {
    dialogs: makeNamespace({
      confirm: vi.fn(async () => false),
      pickFolder: vi.fn(async () => null),
    }) as NativeApi["dialogs"],
    terminal: makeNamespace() as NativeApi["terminal"],
    projects: makeNamespace({
      searchEntries: vi.fn(async () => ({ entries: [] })),
    }) as NativeApi["projects"],
    filesystem: makeNamespace() as NativeApi["filesystem"],
    studio: makeNamespace() as NativeApi["studio"],
    shell: makeNamespace({
      openExternal: options.openExternal ?? (async () => true),
    }) as NativeApi["shell"],
    git: makeNamespace() as NativeApi["git"],
    pullRequests: makeNamespace() as NativeApi["pullRequests"],
    contextMenu: makeNamespace() as NativeApi["contextMenu"],
    server: makeNamespace({
      getConfig: vi.fn(async () => config),
      getEnvironment: vi.fn(async () => ({ platform: { os: "linux" } })),
      getSettings: vi.fn(async () => settings satisfies ServerSettings),
      getAuthSession: vi.fn(async () => ({ authenticated: false })),
      getMossAccountSession: vi.fn(async () => ({ status: "signed-out" })),
      getMossCloudAccountState: vi.fn(async () => ({ status: "signed-out" })),
      getMossEnterpriseKeyState: vi.fn(async () => ({ status: "unconfigured" })),
      getProviderUsageSnapshot: vi.fn(async () => options.providerUsageSnapshot ?? null),
      listProviderUsage: vi.fn(async () => []),
      listMcpConnectors: vi.fn(async () => []),
    }) as NativeApi["server"],
    orchestration: makeNamespace({
      dispatchCommand: vi.fn(async () => undefined),
      getShellSnapshot: vi.fn(async () => undefined),
      subscribeThread: vi.fn(async () => undefined),
      subscribeShell: vi.fn(async () => undefined),
      unsubscribeThread: vi.fn(async () => undefined),
      unsubscribeShell: vi.fn(async () => undefined),
    }) as NativeApi["orchestration"],
    realtimeVoice: makeNamespace({
      getState: vi.fn(async () => ({
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
      })),
      listVoices: vi.fn(async () => ({
        defaultVoice: "maple",
        preferredTransport: "webrtc",
        voices: [],
      })),
      onEvent: () => () => undefined,
    }) as NativeApi["realtimeVoice"],
  } as unknown as NativeApi;
}

function makeSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Single surface project",
        workspaceRoot: "/tmp/single-chat-surface",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Single surface thread",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: CHECKED_AT,
        },
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
        deletedAt: null,
        handoff: null,
      },
    ],
    updatedAt: CHECKED_AT,
  } as unknown as OrchestrationReadModel;
}

function makeManagedSnapshot(): OrchestrationReadModel {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection: { instanceId: "codex_moss", model: "gpt-5.6-sol" },
            session: Object.assign({}, thread.session!, {
              providerName: "codex",
              providerInstanceId: "codex_moss",
            }),
            activities: [
              {
                id: EventId.makeUnsafe("single-surface-image-limit"),
                tone: "error" as const,
                kind: "tool.completed",
                summary: "Image generation failed",
                payload: {
                  itemType: "image_generation",
                  providerInstanceId: "codex_moss",
                  status: "failed",
                  data: {
                    kind: "codex.image_generation.usage_limit",
                    type: "usageLimitExceeded",
                    limitId: "image_gen",
                    resetsAt: null,
                  },
                },
                turnId: TurnId.makeUnsafe("single-surface-image-turn"),
                sequence: 1,
                createdAt: CHECKED_AT,
              },
            ],
          })
        : thread,
    ),
  } as unknown as OrchestrationReadModel;
}

function makeManagedSettings(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [
          {
            id: "moss",
            label: "Moss",
            homePath: "/tmp/codex-moss",
            shadowHomePath: "",
          },
        ],
        selectedAccountId: "moss",
      },
    },
    providerInstances: {
      codex_moss: {
        driver: "codex",
        displayName: "Moss",
        enabled: true,
        config: {
          homePath: "/tmp/codex-moss",
          accountId: "moss",
          customModels: ["gpt-5.6-sol"],
          modelAllowlist: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          managed: true,
        },
      },
    },
  };
}

function makeManagedConfig(): ServerConfig {
  const config = createBrowserTestServerConfig(CHECKED_AT);
  return {
    ...config,
    providers: [
      ...config.providers,
      {
        provider: "codex",
        instanceId: "codex_moss",
        driver: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: CHECKED_AT,
      },
    ],
  };
}

function makeImageDockState() {
  const pane = {
    id: "single-chat-surface-image-preview",
    kind: "imagePreview" as const,
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    filePath: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    pullRequestNumber: null,
    pullRequestInitialTab: null,
    imagePreview: {
      images: [
        { id: "single-image-one", path: "/tmp/single-image-one.png", name: "one.png" },
        { id: "single-image-two", path: "/tmp/single-image-two.png", name: "two.png" },
      ],
      activeImageId: "single-image-one",
      cwd: "/tmp",
      conversationTitle: "Single surface thread",
      view: "single" as const,
    },
  };
  return {
    open: true,
    panes: [pane],
    activePaneId: pane.id,
  };
}

function createHost(width = 960): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = `box-sizing:border-box;width:${width}px;height:720px;display:flex;overflow:hidden;background:#f6f6f6;color:#202020`;
  document.body.append(host);
  return host;
}

async function mountSurface(
  options: {
    width?: number;
    height?: number;
    snapshot?: OrchestrationReadModel;
    nativeApi?: Parameters<typeof makeNativeApi>[0];
    useRealChatView?: boolean;
    openImageDock?: boolean;
  } = {},
) {
  const width = options.width ?? 960;
  const height = options.height ?? 720;
  await page.viewport(width, height);
  const snapshot = options.snapshot ?? makeSnapshot();
  surfaceHarness.useRealChatView = options.useRealChatView ?? false;
  window.nativeApi = makeNativeApi(options.nativeApi);
  useStore.getState().syncServerReadModel(snapshot);
  const imageDockState = makeImageDockState();
  imageDockState.open = false;
  useRightDockStore.setState({
    dockStateByThreadId: {
      [THREAD_ID]: imageDockState,
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => {
      const surface = (
        <QueryClientProvider client={queryClient}>
          <SidebarProvider defaultOpen={false}>
            <SingleChatSurface threadId={THREAD_ID} search={{}} projectId={PROJECT_ID} />
          </SidebarProvider>
        </QueryClientProvider>
      );
      return surfaceHarness.useRealChatView ? (
        <RealtimeVoiceControllerProvider>{surface}</RealtimeVoiceControllerProvider>
      ) : (
        surface
      );
    },
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div data-single-chat-surface-settings="true" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const host = createHost(width);
  const screen = await render(<RouterProvider router={router} />, { container: host });
  await vi.waitFor(() => {
    expect(host.querySelector("[data-right-dock-main-content]")).not.toBeNull();
  });
  if (options.openImageDock ?? true) {
    useRightDockStore.getState().setDockOpen(THREAD_ID, true);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="generated-image-preview-pane"]')).not.toBeNull();
    });
  }
  return {
    host,
    router,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
      useRightDockStore.setState({
        dockStateByThreadId: {},
      });
      useStore.setState({
        shellSnapshotSequence: 0,
        spaces: [],
        projects: [],
        threadIds: [],
        threadShellById: {},
        threadSessionById: {},
        threadTurnStateById: {},
        messageIdsByThreadId: {},
        messageByThreadId: {},
        activityIdsByThreadId: {},
        activityByThreadId: {},
        proposedPlanIdsByThreadId: {},
        proposedPlanByThreadId: {},
        turnDiffIdsByThreadId: {},
        turnDiffSummaryByThreadId: {},
        threadDetailSyncById: {},
        deletedProjectIdsById: {},
        deletedThreadIdsById: {},
        sidebarThreadSummaryById: {},
        threadsHydrated: false,
      });
      surfaceHarness.useRealChatView = false;
      delete window.nativeApi;
    },
  };
}

function readContract(host: HTMLElement) {
  const main = host.querySelector<HTMLElement>("[data-right-dock-main-content]");
  if (!main) throw new Error("SingleChatSurface main-content contract is missing");
  const style = getComputedStyle(main);
  return {
    flex: style.flex,
    minWidth: style.minWidth,
    overflow: style.overflow,
    width: style.width,
    inlineFlex: main.style.getPropertyValue("flex"),
    inlineMinWidth: main.style.getPropertyValue("min-width"),
    inlineOverflow: main.style.getPropertyValue("overflow"),
    inlineWidth: main.style.getPropertyValue("width"),
  };
}

async function waitForSettledFrames(element: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    const animations = [element, element.closest("[data-testid='right-dock-panel']")]
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .flatMap((node) => node.getAnimations())
      .filter((animation) => animation.playState === "running");
    expect(animations).toHaveLength(0);
  });
  const rights: number[] = [];
  const widths: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rect = element.getBoundingClientRect();
    rights.push(rect.right);
    widths.push(rect.width);
  }
  expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
}

afterEach(() => {
  document.body.replaceChildren();
  resetMcpAppDockRegistryForTests();
  delete window.nativeApi;
});

describe("SingleChatSurface right-dock host contract", () => {
  it("keeps the dock open when a newer fullscreen request supersedes a pending close", async () => {
    const mounted = await mountSurface({ width: 390, height: 720, openImageDock: false });
    const inline = document.createElement("div");
    inline.style.cssText = "width:640px;height:240px;position:relative";
    mounted.host.append(inline);
    const id = makeMcpAppDockEntryId(THREAD_ID, "race-call", "ui://race");
    const setFrameVisibility = vi.fn();
    const unregister = registerMcpAppDockEntry({
      id,
      threadId: THREAD_ID,
      title: "Race App",
      getInlineContainer: () => inline,
      layoutFrameTo: (_target, displayMode) =>
        displayMode === "inline" ? new Promise<boolean>(() => undefined) : true,
      setFrameVisibility,
    });
    try {
      await requestMcpAppDisplayMode(id, "fullscreen");
      await vi.waitFor(() => {
        expect(getMcpAppDockEntries(THREAD_ID)).toMatchObject([
          { id, displayMode: "fullscreen", selected: true },
        ]);
      });
      useRightDockStore.getState().setDockOpen(THREAD_ID, false);
      await vi.waitFor(() => expect(setFrameVisibility).toHaveBeenLastCalledWith(false));
      useRightDockStore.getState().setDockOpen(THREAD_ID, true);
      await vi.waitFor(() => expect(setFrameVisibility).toHaveBeenLastCalledWith(true));
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(getMcpAppDockEntries(THREAD_ID)).toMatchObject([
          { id, displayMode: "fullscreen", requestedDisplayMode: "inline", selected: true },
        ]);
      });

      await expect(requestMcpAppDisplayMode(id, "fullscreen")).resolves.toEqual({
        mode: "fullscreen",
      });
      await vi.waitFor(() => {
        expect(getMcpAppDockEntries(THREAD_ID)).toMatchObject([
          { id, displayMode: "fullscreen", requestedDisplayMode: null, selected: true },
        ]);
        expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]?.open).toBe(true);
      });
    } finally {
      await unregister();
      inline.remove();
      await mounted.cleanup();
    }
  });

  it("mounts the exported host, toggles full width, and restores the regular surface", async () => {
    const mounted = await mountSurface({ width: 1_200 });
    try {
      const host = mounted.host;
      const hostWidth = 1_200;
      const main = host.querySelector<HTMLElement>("[data-right-dock-main-content]");
      const panel = host.querySelector<HTMLElement>('[data-testid="right-dock-panel"]');
      const pane = host.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]');
      const widthToggle = host.querySelector<HTMLButtonElement>(
        '[data-testid="right-dock-width-toggle"]',
      );
      expect(main).not.toBeNull();
      expect(panel).not.toBeNull();
      expect(pane).not.toBeNull();
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      // Images intentionally open full width. The width toggle establishes the
      // user's regular layout before exercising its round-trip restoration.
      await vi.waitFor(() =>
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("true"),
      );
      expect(widthToggle).not.toBeNull();
      widthToggle?.click();
      await vi.waitFor(() =>
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("false"),
      );
      await waitForSettledFrames(panel!);
      expect(getComputedStyle(main!).overflow).toBe("visible");
      const regularContract = readContract(host);
      const regularRect = main!.getBoundingClientRect();
      expect(regularRect.width).toBeGreaterThan(0);
      expect(widthToggle).not.toBeNull();

      widthToggle?.click();
      await vi.waitFor(() => {
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("true");
        expect(getComputedStyle(main!).flex).toMatch(/0 0 auto|none/);
        expect(getComputedStyle(main!).width).toBe("0px");
        expect(getComputedStyle(main!).overflow).toBe("hidden");
        expect(panel!.getBoundingClientRect().right).toBeLessThanOrEqual(hostWidth + 1);
        expect(pane!.getBoundingClientRect().right).toBeLessThanOrEqual(hostWidth + 1);
        expect(panel!.getBoundingClientRect().width).toBeGreaterThan(700);
      });
      await waitForSettledFrames(panel!);

      widthToggle?.click();
      await vi.waitFor(() => {
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("false");
        const restoredRect = main!.getBoundingClientRect();
        expect(restoredRect.width).toBeGreaterThan(0);
        expect(panel!.getBoundingClientRect().right).toBeLessThanOrEqual(hostWidth + 1);
      });
      await waitForSettledFrames(panel!);
      expect(readContract(host)).toEqual(regularContract);

      widthToggle?.click();
      await vi.waitFor(() => {
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("true");
        expect(pane?.getAttribute("data-generated-image-preview-full-width")).toBe("true");
      });
      useRightDockStore.getState().setDockOpen(THREAD_ID, false);
      await vi.waitFor(() => {
        const currentPane = host.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("false");
        expect(currentPane).toBeNull();
        expect(getComputedStyle(main!).overflow).toBe("visible");
        const closedContract = readContract(host);
        expect({
          flex: closedContract.flex,
          minWidth: closedContract.minWidth,
          overflow: closedContract.overflow,
          inlineFlex: closedContract.inlineFlex,
          inlineMinWidth: closedContract.inlineMinWidth,
          inlineOverflow: closedContract.inlineOverflow,
          inlineWidth: closedContract.inlineWidth,
        }).toEqual({
          flex: regularContract.flex,
          minWidth: regularContract.minWidth,
          overflow: regularContract.overflow,
          inlineFlex: regularContract.inlineFlex,
          inlineMinWidth: regularContract.inlineMinWidth,
          inlineOverflow: regularContract.inlineOverflow,
          inlineWidth: regularContract.inlineWidth,
        });
        expect(main!.getBoundingClientRect().width).toBe(host.getBoundingClientRect().width);
        expect(main?.style.cssText).toBe("");
      });
      await waitForSettledFrames(panel!);

      useRightDockStore.getState().setDockOpen(THREAD_ID, true);
      await vi.waitFor(() => {
        const currentPane = host.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("true");
        expect(currentPane?.getAttribute("data-generated-image-preview-full-width")).toBe("true");
        expect(getComputedStyle(main!).overflow).toBe("hidden");
      });
      await waitForSettledFrames(panel!);

      widthToggle?.click();
      await vi.waitFor(() => {
        const currentPane = host.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(main?.getAttribute("data-app-shell-right-panel-full-width")).toBe("false");
        expect(currentPane?.getAttribute("data-generated-image-preview-full-width")).toBe("false");
        expect(getComputedStyle(main!).overflow).toBe("visible");
      });
      await waitForSettledFrames(panel!);
      expect(readContract(host)).toEqual(regularContract);
    } finally {
      await mounted.cleanup();
    }
  });

  it("exercises the exported host Canvas missing-bundle and compact-sheet lifecycle", async () => {
    localStorage.removeItem("has-dismissed-image-canvas-view-coachmark-v1");
    const nativeFetch = window.fetch.bind(window);
    const canvasRequests: { url: URL; init: RequestInit | undefined }[] = [];
    const canvasFetch = vi.spyOn(window, "fetch").mockImplementation((input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href,
      );
      if (url.origin === window.location.origin && url.pathname === "/canvas/") {
        canvasRequests.push({ url, init });
        return Promise.resolve(new Response("Canvas bundle missing", { status: 503 }));
      }
      return nativeFetch(input, init);
    });
    let mounted: Awaited<ReturnType<typeof mountSurface>> | null = null;
    try {
      mounted = await mountSurface({ width: 1_200 });
      const host = mounted.host;
      const imagePreview = () =>
        useRightDockStore
          .getState()
          .dockStateByThreadId[THREAD_ID]?.panes.find((current) => current.kind === "imagePreview")
          ?.imagePreview;
      const expectedImages = makeImageDockState().panes[0]!.imagePreview.images;
      const pane = await vi.waitFor(() => {
        const current = host.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(current).not.toBeNull();
        return current!;
      });
      await vi.waitFor(() =>
        expect(pane.getAttribute("data-generated-image-preview-view")).toBe("single"),
      );
      const canvasToggle = pane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-playground"]',
      );
      expect(canvasToggle).not.toBeNull();
      canvasToggle?.click();
      await vi.waitFor(() => {
        expect(pane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(pane.getAttribute("data-generated-image-preview-full-width")).toBe("true");
        expect(
          host
            .querySelector("[data-app-shell-right-panel-full-width]")
            ?.getAttribute("data-app-shell-right-panel-full-width"),
        ).toBe("true");
      });
      // The exported host uses the complete Canvas app. This component fixture
      // deliberately omits its bundle; it must report that failure visibly.
      await expect.element(page.getByText("画布工作区暂不可用", { exact: true })).toBeVisible();
      expect(host.querySelector("[data-conversation-image-workspace]")).not.toBeNull();
      expect(host.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
      expect(host.querySelector('[data-testid="generated-image-playground"]')).toBeNull();
      expect(canvasRequests).toHaveLength(1);
      expect(canvasRequests[0]!.init).toMatchObject({ method: "GET", credentials: "omit" });
      expect(Object.fromEntries(canvasRequests[0]!.url.searchParams)).toEqual({
        moss_host: "1",
        moss_thread: THREAD_ID,
        projectId: `thread:${THREAD_ID}`,
        projectKey: THREAD_ID,
      });
      expect(imagePreview()).toMatchObject({
        activeImageId: "single-image-one",
        images: expectedImages,
        view: "playground",
      });
      for (const label of ["Comment", "Multi-select", "Remove", "Resize", "Add to chat"]) {
        expect(pane.querySelector(`[aria-label="${label}"]`)).toBeNull();
      }

      useRightDockStore.getState().setDockOpen(THREAD_ID, false);
      await vi.waitFor(() =>
        expect(host.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull(),
      );
      useRightDockStore.getState().setDockOpen(THREAD_ID, true);
      const reopened = await vi.waitFor(() => {
        const current = host.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(current).not.toBeNull();
        return current!;
      });
      await vi.waitFor(() =>
        expect(reopened.getAttribute("data-generated-image-preview-view")).toBe("playground"),
      );
      await expect.element(page.getByText("画布工作区暂不可用", { exact: true })).toBeVisible();
      expect(imagePreview()?.images).toEqual(expectedImages);
      const focusedToggle = reopened.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-single"]',
      );
      focusedToggle?.click();
      await vi.waitFor(() => {
        expect(reopened.getAttribute("data-generated-image-preview-view")).toBe("single");
        expect(reopened.getAttribute("data-generated-image-preview-full-width")).toBe("true");
        expect(host.querySelector('[data-testid="generated-image-preview-rail"]')).not.toBeNull();
      });

      host.style.width = "390px";
      await page.viewport(390, 720);
      await vi.waitFor(() => {
        const current = document.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(current?.getAttribute("data-generated-image-preview-full-width")).toBe("false");
      });
      const compactPane = document.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-pane"]',
      );
      compactPane
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview-view-playground"]',
        )
        ?.click();
      await vi.waitFor(() => {
        const current = document.querySelector<HTMLElement>(
          '[data-testid="generated-image-preview-pane"]',
        );
        expect(current?.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(current?.getAttribute("data-generated-image-preview-full-width")).toBe("false");
        expect(current?.getAttribute("data-generated-image-preview-transitioning")).toBe("false");
        expect(
          document
            .querySelector("[data-app-shell-right-panel-full-width]")
            ?.getAttribute("data-app-shell-right-panel-full-width"),
        ).toBe("false");
      });
      await expect.element(page.getByText("画布工作区暂不可用", { exact: true })).toBeVisible();
      expect(imagePreview()).toMatchObject({
        activeImageId: "single-image-one",
        images: expectedImages,
        view: "playground",
      });
    } finally {
      await mounted?.cleanup();
      canvasFetch.mockRestore();
      localStorage.removeItem("has-dismissed-image-canvas-view-coachmark-v1");
    }
  });

  it("mounts the durable image-limit banner through the exported SingleChatSurface host", async () => {
    const consoleErrors = vi.spyOn(console, "error");
    const consoleWarnings = vi.spyOn(console, "warn");
    const runtimeErrors: string[] = [];
    const onWindowError = (event: ErrorEvent) => {
      runtimeErrors.push(
        event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message,
      );
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      runtimeErrors.push(
        event.reason instanceof Error
          ? (event.reason.stack ?? event.reason.message)
          : String(event.reason),
      );
    };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    const openExternal = vi.fn(async () => true);
    const previousDesktopBridge = window.desktopBridge;
    const mounted = await mountSurface({
      snapshot: makeManagedSnapshot(),
      useRealChatView: true,
      openImageDock: false,
      nativeApi: {
        config: makeManagedConfig(),
        settings: makeManagedSettings(),
      },
    });
    try {
      const banner = await vi.waitFor(() => {
        const value = mounted.host.querySelector<HTMLElement>(
          '[data-testid="image-generation-limit-banner"]',
        );
        expect(value).not.toBeNull();
        return value!;
      });
      expect(mounted.host.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull();
      expect(banner.textContent).toContain("Moss image creation limit reached");
      expect(banner.textContent).not.toContain("ChatGPT");
      expect(banner.textContent).not.toContain("credits");
      const description = banner.querySelector<HTMLElement>("p:nth-of-type(2)");
      const bannerStyle = getComputedStyle(banner);
      expect(bannerStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(bannerStyle.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(bannerStyle.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(description!).color).not.toBe("rgba(0, 0, 0, 0)");
      const lightScreenshot = await page.screenshot({
        path: "../../../.tmp/ui-parity/HEL-46-image-gen-limit-b32/single-surface-light-desktop.png",
      });
      expect(lightScreenshot).toContain("single-surface-light-desktop.png");

      await page.viewport(390, 720);
      mounted.host.style.width = "390px";
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      expect(
        getComputedStyle(banner.querySelector('svg, [data-slot="central-icon"]')!).display,
      ).toBe("none");
      expect(banner.getBoundingClientRect().right).toBeLessThanOrEqual(391);
      const composer = mounted.host.querySelector<HTMLElement>('[data-testid="composer"]');
      expect(banner.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        composer?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      );
      const narrowScreenshot = await page.screenshot({
        path: "../../../.tmp/ui-parity/HEL-46-image-gen-limit-b32/single-surface-light-390.png",
      });
      expect(narrowScreenshot).toContain("single-surface-light-390.png");

      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        writable: true,
        value: {
          openExternal,
          setTheme: vi.fn(async () => undefined),
        },
      });
      await banner
        .querySelector<HTMLButtonElement>('[data-testid="image-generation-limit-primary"]')
        ?.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/settings");
        expect(mounted.router.state.location.search).toMatchObject({ section: "usage" });
        expect(openExternal).not.toHaveBeenCalled();
        expect(
          mounted.host.querySelector('[data-testid="image-generation-limit-banner"]'),
        ).toBeNull();
      });

      const knownDiagnostic = /(ResizeObserver|LegendList)/iu;
      const consoleDiagnostics = [
        ...consoleErrors.mock.calls.map((args) => args.map(String).join(" ")),
        ...consoleWarnings.mock.calls.map((args) => args.map(String).join(" ")),
        ...runtimeErrors,
      ];
      expect(
        consoleDiagnostics.filter((message) => !knownDiagnostic.test(message)),
        "Unexpected SingleChatSurface browser console/page/React diagnostics",
      ).toEqual([]);
    } finally {
      await mounted.cleanup();
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      consoleErrors.mockRestore();
      consoleWarnings.mockRestore();
      if (previousDesktopBridge) {
        Object.defineProperty(window, "desktopBridge", {
          configurable: true,
          writable: true,
          value: previousDesktopBridge,
        });
      } else {
        Reflect.deleteProperty(window, "desktopBridge");
      }
    }
  });
});
