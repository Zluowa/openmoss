// FILE: AppPageSidebarConversationState.browser.tsx
// Purpose: Real headless Chromium verification & side-by-side screenshots proving Moss's
//          sidebar conversation states differ accurately between:
//          (1) Current conversation page (`/$threadId` + app open in RightDock) -> `selected`
//          (2) Standalone App Page (`/apps/$appId` + ThreadSidebar) -> hidden pre-send, then `app-companion` ("应用中") -> `selected` on click -> `app-origin` on leaving
//          (3) Standalone Space App (`资料空间` + SpaceSidebar) -> stays in 资料空间 with live indicator on `最近`
// Layer: Web browser tests

import "../../index.css";

import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@moss/shared/desktopChrome";
import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import type {
  MessageId,
  NativeApi,
  Page,
  PageApp,
  PageAppId,
  ProjectId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useTheme } from "~/hooks/useTheme";
import { MossLocalizationProvider } from "~/localization";
import { resetActiveCompanionDockForTests } from "~/lib/pageAi/activeCompanionDock";
import { artifactAssistantThreadKey, pageAssistantThreads } from "~/lib/pageAi/pageAssistantThread";
import { initialState } from "~/storeState";
import { StoreProvider, useStore } from "~/store";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";
import type { ChatMessage } from "~/types";
import { AppRailSlotProvider } from "../AppRail";
import { AppShellTopStrip } from "../AppShellTopStrip";
import { CHAT_BACKGROUND_CLASS_NAME } from "../chat/composerPickerStyles";
import { PageAppDockPane } from "../chat/PageAppDockPane";
import { RealtimeVoiceControllerProvider } from "../chat/RealtimeVoiceControllerProvider";
import ThreadSidebar from "../Sidebar";
import { SidebarLeadingControlsDock } from "../SidebarHeaderNavigationControls";
import { SpaceSidebar } from "../space/SpaceSidebar";
import { appItem, type SpaceItem } from "../space/spaceItems";
import {
  SpaceCanvasChatDockHost,
  type SpaceCanvasActiveArtifact,
} from "../space/SpaceCanvasChatDock";
import { Badge } from "../ui/badge";
import { SidebarProvider } from "../ui/sidebar";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { AppPageFrame } from "./AppPageFrame";
import { pageAppsClient } from "./pageAppsClient";

const SHOT_DIR = "../../../.tmp/sidebar-states";
const PROJECT_ID = "proj-1" as ProjectId;
const MAIN_THREAD_ID = "thread-main-1" as ThreadId;
const OTHER_THREAD_ID = "thread-other-1" as ThreadId;
const READER_APP_ID = "app-reader-state" as PageAppId;
const READER_APP_KEY = artifactAssistantThreadKey("default", null, "app", READER_APP_ID);

function buildPureWechatReadHtml(theme: "light" | "dark" = "light"): string {
  const isDark = theme === "dark";
  const palette = isDark
    ? {
        bg: "#171719",
        ink: "#e6e4de",
        muted: "#9a978f",
        border: "rgba(255, 255, 255, 0.09)",
        pillBg: "rgba(74, 222, 128, 0.14)",
        pillInk: "#4ade80",
      }
    : {
        bg: "#f9f6ef",
        ink: "#26231d",
        muted: "#7a7263",
        border: "rgba(38, 35, 29, 0.1)",
        pillBg: "rgba(34, 197, 94, 0.12)",
        pillInk: "#15803d",
      };
  const rawHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>微信阅读 · 深度精读</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 40px 56px 96px;
      background: ${palette.bg};
      color: ${palette.ink};
      font-family: "Songti SC", "Noto Serif SC", "PingFang SC", -apple-system, serif;
      line-height: 1.9;
    }
    .reader { max-width: 720px; margin: 0 auto; }
    .meta {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 14px; margin-bottom: 28px;
      border-bottom: 1px solid ${palette.border};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px; color: ${palette.muted};
    }
    .chapter-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: ${palette.pillBg}; color: ${palette.pillInk}; font-weight: 600;
    }
    h1 { font-size: 28px; margin: 0 0 8px; font-weight: 700; }
    .author { font-size: 14px; color: ${palette.muted}; margin-bottom: 28px; }
    p { font-size: 17px; margin: 0 0 20px; text-align: justify; }
  </style>
</head>
<body>
  <article class="reader">
    <div class="meta">
      <span class="chapter-pill">微信阅读 · 第三章</span>
      <span>精读进度 42%</span>
    </div>
    <h1>系统思考与慢决策</h1>
    <div class="author">沉思录精选集 · 第二节</div>
    <p id="target-paragraph">真正高效的阅读，是在遇到与自己过往经验相冲突的观点时，停下来把关键推理链路拆解清楚。</p>
    <p>把复杂系统拆成可验证的小循环，比一次性追求完美蓝图更容易落地。</p>
  </article>
</body>
</html>`;
  return injectPageAppFrameRuntime(
    rawHtml,
    buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
  );
}

describe("Sidebar conversation states across entry points", () => {
  const createdUrls: string[] = [];
  let previousApi: NativeApi | undefined;

  function setupAppFrameMock(fakeApp: PageApp, html: string) {
    const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    createdUrls.push(blobUrl);
    vi.spyOn(pageAppsClient, "openFrame").mockResolvedValue({
      app: fakeApp,
      revision: 1,
      viewer: { id: "owner", name: "林溪", level: "owner", isOwner: true },
      capabilities: { db: {}, ai: {}, comments: {} },
      consent: {},
      frameUrl: blobUrl,
      frameOrigin: window.location.origin,
      ownOrigin: true,
      offlineReady: true,
      expiresAt: "2026-11-28T00:00:00.000Z",
    });
  }

  function makeThreadSummary(
    id: ThreadId,
    title: string,
    opts?: { listedAfterFirstSend?: true; sent?: boolean; updatedAt?: string },
  ) {
    const now = opts?.updatedAt ?? "2026-11-27T08:00:00.000Z";
    const sent = opts?.sent ?? true;
    return {
      id,
      projectId: PROJECT_ID,
      title,
      modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      session: null,
      latestTurn: sent
        ? {
            turnId: `turn-${id}` as TurnId,
            state: "completed" as const,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          }
        : null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestUserMessageAt: sent ? now : null,
      ...(opts?.listedAfterFirstSend ? { listedAfterFirstSend: true } : {}),
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      hasLiveTailWork: false,
      pendingBackgroundWorkCount: 0,
    };
  }

  beforeEach(async () => {
    window.localStorage.clear();
    pageAssistantThreads.forget(READER_APP_KEY);
    pageAssistantThreads.resetForTests();
    resetActiveCompanionDockForTests();
    window.localStorage.setItem(
      "moss:app-settings:v1",
      JSON.stringify({
        showChatsSection: false,
        showStudioSection: false,
        sidebarProjectSortOrder: "updated_at",
        sidebarThreadSortOrder: "updated_at",
      }),
    );

    previousApi = window.nativeApi;
    const fixture = createDataSpaceFixture();
    let seq = 1;
    const apiRecord = {
      ...fixture.api,
      orchestration: {
        getSnapshot: vi.fn(),
        getTurnDiff: vi.fn(async () => ({ diff: "" })),
        getFullThreadDiff: vi.fn(async () => ({ diff: "" })),
        replayEvents: vi.fn(async () => []),
        onDomainEvent: vi.fn(() => () => undefined),
        dispatchCommand: vi.fn(async (rawCmd: unknown) => {
          seq += 1;
          const cmd = rawCmd as {
            type?: string;
            threadId?: ThreadId;
            projectId?: ProjectId;
            title?: string;
            listedAfterFirstSend?: boolean;
            message?: { messageId?: MessageId; text?: string };
          };
          const now = "2026-11-27T08:05:00.000Z";
          if (cmd.type === "thread.create" && cmd.threadId) {
            const tid = cmd.threadId;
            const pid = cmd.projectId ?? PROJECT_ID;
            const summary = {
              ...makeThreadSummary(tid, cmd.title || "微信阅读 · 深度精读", {
                ...(cmd.listedAfterFirstSend ? { listedAfterFirstSend: true } : {}),
                sent: !cmd.listedAfterFirstSend,
                updatedAt: now,
              }),
              projectId: pid,
            };
            useStore.setState((prev) => ({
              threadIds: prev.threadIds?.includes(tid)
                ? prev.threadIds
                : [...(prev.threadIds ?? []), tid],
              sidebarThreadSummaryById: {
                ...prev.sidebarThreadSummaryById,
                [tid]: summary,
              },
              threadShellById: {
                ...(prev.threadShellById ?? {}),
                [tid]: {
                  id: tid,
                  codexThreadId: null,
                  projectId: pid,
                  title: summary.title,
                  modelSelection: summary.modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  envMode: "local",
                  branch: null,
                  worktreePath: null,
                  workingDirectory: "D:/ceshi",
                  error: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
              threadDetailSyncById: {
                ...(prev.threadDetailSyncById ?? {}),
                [tid]: "synced",
              },
              messageIdsByThreadId: {
                ...(prev.messageIdsByThreadId ?? {}),
                [tid]: prev.messageIdsByThreadId?.[tid] ?? [],
              },
              messageByThreadId: {
                ...(prev.messageByThreadId ?? {}),
                [tid]: prev.messageByThreadId?.[tid] ?? {},
              },
            }));
          } else if (cmd.type === "thread.turn.start" && cmd.threadId) {
            const tid = cmd.threadId;
            const userMsgId = (cmd.message?.messageId ?? `msg-u-${seq}`) as MessageId;
            const assistantMsgId = `msg-a-${seq}` as MessageId;
            const userMsg: ChatMessage = {
              id: userMsgId,
              role: "user",
              text: cmd.message?.text ?? "请帮我总结第三章的核心论点",
              createdAt: now,
              streaming: false,
            };
            const assistantMsg: ChatMessage = {
              id: assistantMsgId,
              role: "assistant",
              text: "第三章的核心是：在复杂系统里用慢决策替代本能反应，通过小步可验证闭环持续校准认知。",
              createdAt: "2026-11-27T08:05:02.000Z",
              completedAt: "2026-11-27T08:05:02.000Z",
              streaming: false,
            };
            useStore.setState((prev) => {
              const existing = prev.sidebarThreadSummaryById[tid];
              return {
                sidebarThreadSummaryById: existing
                  ? {
                      ...prev.sidebarThreadSummaryById,
                      [tid]: {
                        ...existing,
                        updatedAt: "2026-11-27T08:05:02.000Z",
                        latestUserMessageAt: now,
                        lastVisitedAt: "2026-11-27T08:05:02.000Z",
                        latestTurn: {
                          turnId: `turn-${seq}` as TurnId,
                          state: "completed",
                          requestedAt: now,
                          startedAt: now,
                          completedAt: "2026-11-27T08:05:02.000Z",
                          assistantMessageId: assistantMsgId,
                        },
                      },
                    }
                  : prev.sidebarThreadSummaryById,
                messageIdsByThreadId: {
                  ...(prev.messageIdsByThreadId ?? {}),
                  [tid]: [...(prev.messageIdsByThreadId?.[tid] ?? []), userMsgId, assistantMsgId],
                },
                messageByThreadId: {
                  ...(prev.messageByThreadId ?? {}),
                  [tid]: {
                    ...(prev.messageByThreadId?.[tid] ?? {}),
                    [userMsgId]: userMsg,
                    [assistantMsgId]: assistantMsg,
                  },
                },
                threadDetailSyncById: {
                  ...(prev.threadDetailSyncById ?? {}),
                  [tid]: "synced",
                },
              };
            });
          }
          return { sequence: seq };
        }),
      } as unknown as NativeApi["orchestration"],
      provider: {
        ...fixture.api.provider,
        getComposerCapabilities: vi.fn(async ({ provider }: { provider: string }) => ({
          provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: false,
        })),
      } as unknown as NativeApi["provider"],
      realtimeVoice: {
        onEvent: () => () => undefined,
        listVoices: async () => ({
          voices: [],
          defaultVoice: "",
          preferredTransport: "websocket-pcm16",
        }),
        getState: async () => ({
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
        }),
      } as unknown as NativeApi["realtimeVoice"],
      dialogs: { confirm: async () => true } as unknown as NativeApi["dialogs"],
      shell: { openExternal: async () => undefined } as unknown as NativeApi["shell"],
    };
    const noopProxy: unknown = new Proxy(() => async () => ({}), {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        if (prop === "onEvent" || prop === "onDomainEvent") return () => () => undefined;
        return noopProxy;
      },
      apply: () => Promise.resolve({}),
    });
    window.nativeApi = new Proxy(apiRecord as Record<string, unknown>, {
      get: (target, property) => Reflect.get(target, property) ?? noopProxy,
    }) as unknown as NativeApi;

    useStore.setState({
      ...initialState,
      threadsHydrated: true,
      projects: [
        {
          id: PROJECT_ID,
          kind: "project",
          name: "Moss Studio",
          remoteName: "origin",
          folderName: "ceshi",
          localName: null,
          cwd: "D:/ceshi",
          defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
          expanded: true,
          scripts: [],
          createdAt: "2026-11-27T00:00:00.000Z",
          updatedAt: "2026-11-27T00:00:00.000Z",
        },
      ],
      threadIds: [MAIN_THREAD_ID, OTHER_THREAD_ID],
      sidebarThreadSummaryById: {
        [MAIN_THREAD_ID]: makeThreadSummary(MAIN_THREAD_ID, "日常研发探讨", {
          updatedAt: "2026-11-27T07:50:00.000Z",
        }),
        [OTHER_THREAD_ID]: makeThreadSummary(OTHER_THREAD_ID, "周报与里程碑整理", {
          updatedAt: "2026-11-27T07:40:00.000Z",
        }),
      },
    });
    useStore.getState().setAllProjectsExpanded(true);
    await page.viewport(1440, 900);
  });

  afterEach(async () => {
    for (const url of createdUrls.splice(0)) {
      URL.revokeObjectURL(url);
    }
    vi.restoreAllMocks();
    pageAssistantThreads.forget(READER_APP_KEY);
    pageAssistantThreads.resetForTests();
    resetActiveCompanionDockForTests();
    if (previousApi) window.nativeApi = previousApi;
    else delete window.nativeApi;
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-theme-mode");
    document.documentElement.removeAttribute("data-theme-variant");
    window.localStorage.clear();
    await cleanup();
  });

  function buildFakeReaderApp(theme: "light" | "dark" = "light"): PageApp {
    const html = buildPureWechatReadHtml(theme);
    setupAppFrameMock(
      {
        id: READER_APP_ID,
        scopeSpaceId: null,
        spaceId: null,
        title: "微信阅读 · 深度精读",
        description: "Pure WeChat Read",
        revision: 1,
        capabilities: { db: {}, ai: {}, comments: {} },
        favorite: false,
        thumbnail: null,
        sourceThreadId: null,
        htmlChars: html.length,
        trashedAt: null,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:00.000Z",
      },
      html,
    );
    return {
      id: READER_APP_ID,
      scopeSpaceId: null,
      spaceId: null,
      title: "微信阅读 · 深度精读",
      description: "Pure WeChat Read",
      revision: 1,
      capabilities: { db: {}, ai: {}, comments: {} },
      favorite: false,
      thumbnail: null,
      sourceThreadId: null,
      htmlChars: html.length,
      trashedAt: null,
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
    };
  }

  function ThemeSync({ mode }: { mode: "light" | "dark" }) {
    const { setTheme } = useTheme();
    useEffect(() => {
      setTheme(mode);
      return () => {
        if (mode === "dark") {
          setTheme("light");
        }
      };
    }, [mode, setTheme]);
    return null;
  }

  async function mountTestRouter(
    initialEntry: string,
    fakeApp: PageApp,
    themeMode: "light" | "dark" = "light",
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const recentSpaceApp: SpaceItem = appItem({
      ...fakeApp,
      favorite: false,
    } as never);
    const noop = () => undefined;

    function DesktopShellRoot() {
      const [railSlot, setRailSlot] = useState<HTMLDivElement | null>(null);
      const [routeColumn, setRouteColumn] = useState<HTMLDivElement | null>(null);
      const pathname = useLocation({ select: (location) => location.pathname });
      const isSpaceRoute = pathname === "/space";

      return (
        <RealtimeVoiceControllerProvider>
          <ToastProvider>
            <TooltipProvider>
              <SidebarProvider
                defaultOpen
                open
                className="h-svh w-screen overflow-hidden bg-[var(--app-rail-shell-background)] text-foreground"
                style={
                  {
                    "--app-top-strip-height": `${CHAT_SURFACE_HEADER_HEIGHT_PX}px`,
                  } as CSSProperties
                }
                data-sidebar-side="left"
                data-sidebar-layout="rail"
              >
                <ThemeSync mode={themeMode} />
                <AppRailSlotProvider value={railSlot}>
                  <SidebarLeadingControlsDock routeColumn={routeColumn} railSlot={railSlot}>
                    <div className="flex min-h-0 shrink-0 flex-col">
                      <AppShellTopStrip />
                      <div className="flex min-h-0 flex-1">
                        <div ref={setRailSlot} className="flex shrink-0" />
                        {isSpaceRoute ? (
                          <>
                            <div className="hidden" aria-hidden="true">
                              <ThreadSidebar />
                            </div>
                            <div className="app-rail-panel relative flex min-h-0 shrink-0 overflow-hidden [contain:paint]">
                              <SpaceSidebar
                                scopeSpaceId={null as SpaceId | null}
                                section={{ type: "all" }}
                                openKey={`app:${fakeApp.id}`}
                                recent={[recentSpaceApp]}
                                spaces={[]}
                                pages={[] as Page[]}
                                onSection={noop}
                                onOpen={noop}
                                onOpenPage={noop}
                                onCreate={noop}
                                onCreateSubpage={noop}
                                onRenameSpace={noop}
                                onSpaceIcon={noop}
                                onTrashSpace={noop}
                                onClose={noop}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="app-rail-panel relative flex min-h-0 shrink-0 overflow-hidden [contain:paint]">
                            <div data-testid="thread-sidebar" className="h-full w-[264px] shrink-0">
                              <ThreadSidebar />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div
                      ref={setRouteColumn}
                      className="relative flex h-svh min-h-0 min-w-0 flex-1"
                    >
                      <div aria-hidden className="app-rail-header-divider" />
                      <main
                        className={
                          "chat-content-card relative flex min-h-0 min-w-0 flex-1 overflow-hidden " +
                          CHAT_BACKGROUND_CLASS_NAME
                        }
                      >
                        <Outlet />
                      </main>
                    </div>
                  </SidebarLeadingControlsDock>
                </AppRailSlotProvider>
              </SidebarProvider>
            </TooltipProvider>
          </ToastProvider>
        </RealtimeVoiceControllerProvider>
      );
    }

    const rootRoute = createRootRoute({
      component: DesktopShellRoot,
    });

    function ThreadChatRouteView() {
      const threadId = useParams({
        strict: false,
        select: (params) => params.threadId ?? MAIN_THREAD_ID,
      });
      const activeTitle =
        useStore((s) => s.sidebarThreadSummaryById[threadId as ThreadId]?.title) ?? "对话";
      return (
        <div className="flex h-full min-w-0 flex-1 overflow-hidden">
          <section
            data-testid="current-chat-pane"
            className="flex min-w-0 flex-1 flex-col border-r border-[color:var(--app-surface-divider)]"
          >
            <header className="flex h-11 shrink-0 items-center justify-between border-b border-[color:var(--app-surface-divider)] px-4">
              <span className="truncate text-ui font-medium">{activeTitle}</span>
              <Badge size="sm" variant="default" className="text-muted-foreground">
                当前对话页 · 右栏应用已停靠
              </Badge>
            </header>
            <div className="flex flex-1 flex-col gap-3 p-5 text-ui">
              <div className="ml-auto max-w-[80%] rounded-composer bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-3.5 py-2 text-foreground">
                帮我在右侧打开微信阅读并同步总结第三章要点
              </div>
              <div className="max-w-[85%] rounded-panel border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3.5 py-2.5 text-foreground">
                已在右侧分栏打开《微信阅读 · 深度精读》，划选文本后的评论和提问会直接发入当前对话。
              </div>
            </div>
          </section>
          <aside className="flex h-full w-[52%] min-w-0 shrink-0 flex-col overflow-hidden">
            <PageAppDockPane
              threadId={threadId as ThreadId}
              pageApp={{ appId: fakeApp.id, title: fakeApp.title }}
              onClose={() => undefined}
            />
          </aside>
        </div>
      );
    }

    function StandaloneAppRouteView() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const artifact = useMemo<SpaceCanvasActiveArtifact>(
        () => ({
          kind: "app",
          itemId: fakeApp.id,
          title: fakeApp.title,
          scopeSpaceId: null,
          account: "default",
        }),
        [],
      );
      return (
        <div ref={containerRef} className="relative flex h-full min-w-0 flex-1 overflow-hidden">
          <SpaceCanvasChatDockHost
            artifact={artifact}
            containerRef={containerRef}
            floatingLauncher="compact"
            keepItemOpen
          >
            {(dock) => <AppPageFrame appPageId={fakeApp.id} mode="full" topBar dock={dock} />}
          </SpaceCanvasChatDockHost>
        </div>
      );
    }

    function StandaloneSpaceRouteView() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const artifact = useMemo<SpaceCanvasActiveArtifact>(
        () => ({
          kind: "app",
          itemId: fakeApp.id,
          title: fakeApp.title,
          scopeSpaceId: null,
          account: "default",
        }),
        [],
      );
      return (
        <div ref={containerRef} className="relative flex h-full min-w-0 flex-1 overflow-hidden">
          <SpaceCanvasChatDockHost
            artifact={artifact}
            containerRef={containerRef}
            floatingLauncher="compact"
            keepItemOpen
          >
            {(dock) => (
              <AppPageFrame appPageId={fakeApp.id} mode="full" topBar={false} dock={dock} />
            )}
          </SpaceCanvasChatDockHost>
        </div>
      );
    }

    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$threadId",
      component: ThreadChatRouteView,
    });
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/apps/$appId",
      component: StandaloneAppRouteView,
    });
    const spaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/space",
      component: StandaloneSpaceRouteView,
    });

    const router = createRouter({
      routeTree: rootRoute.addChildren([threadRoute, appRoute, spaceRoute]),
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
      defaultPreload: false,
      Wrap: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <StoreProvider>
            <MossLocalizationProvider localeOverride="zh-CN">{children}</MossLocalizationProvider>
          </StoreProvider>
        </QueryClientProvider>
      ),
    });

    await router.load();
    await render(<RouterProvider router={router} />);
    return {
      router,
      async waitForFrameReady() {
        await expect
          .poll(() =>
            Boolean(
              document.querySelector("iframe")?.contentDocument?.querySelector("article.reader"),
            ),
          )
          .toBe(true);
      },
    };
  }

  it("Scenario 1: from current chat page with app docked on right, left sidebar marks the active thread as selected without app-companion badge", async () => {
    const fakeApp = buildFakeReaderApp();
    const { waitForFrameReady } = await mountTestRouter(`/${MAIN_THREAD_ID}`, fakeApp);
    await waitForFrameReady();

    // No floating bottom-right Moss overlay when inside a host conversation's right dock
    expect(document.querySelector("[data-space-dock-launcher]")).toBeNull();
    expect(document.querySelector(`[data-page-app-dock-pane="${fakeApp.id}"]`)).not.toBeNull();

    await expect
      .poll(
        () => document.querySelector('[data-sidebar-thread-state="selected"]')?.textContent ?? "",
      )
      .toContain("日常研发探讨");

    const selectedRow = document.querySelector<HTMLElement>(
      '[data-sidebar-thread-state="selected"]',
    )!;
    expect(selectedRow.getAttribute("data-active")).toBe("true");
    expect(selectedRow.querySelector("[data-sidebar-app-companion-badge]")).toBeNull();

    await page.screenshot({
      path: `${SHOT_DIR}/sidebar-state-01-current-chat-page.png`,
    });
  });

  it("Scenario 2: entering standalone from an app page hides warm-up pre-send, shows app-companion state while chatting, and transitions to selected / app-origin", async () => {
    const fakeApp = buildFakeReaderApp();
    const { router, waitForFrameReady } = await mountTestRouter(`/apps/${fakeApp.id}`, fakeApp);
    await waitForFrameReady();

    // Normal threads visible; no app companion row before first send
    await expect
      .poll(() => document.querySelector('[data-testid="thread-sidebar"]')?.textContent ?? "")
      .toContain("日常研发探讨");
    expect(document.querySelector('[data-sidebar-thread-state="app-companion"]')).toBeNull();

    // Open the floating PiP first -> triggers warm-up creation (listedAfterFirstSend: true)
    await userEvent.click(document.querySelector("[data-space-dock-compact-title]")!);
    await expect
      .poll(() => {
        const hostEl = document.querySelector<HTMLElement>("[data-space-dock-thread-id]");
        return hostEl?.dataset.spaceDockThreadId ?? "";
      })
      .not.toBe("");

    const companionThreadId = document.querySelector<HTMLElement>("[data-space-dock-thread-id]")!
      .dataset.spaceDockThreadId! as ThreadId;

    // Warm-up thread exists in store with listedAfterFirstSend=true, so sidebar still hides it!
    expect(
      useStore.getState().sidebarThreadSummaryById[companionThreadId]?.listedAfterFirstSend,
    ).toBe(true);
    expect(
      document.querySelector('[data-testid="thread-sidebar"]')?.textContent ?? "",
    ).not.toContain(fakeApp.title);

    // Send first real turn directly from the floating PiP composer
    const pipEditor = document.querySelector<HTMLElement>(
      '[data-space-canvas-dock="pip"] [contenteditable="true"]',
    )!;
    expect(pipEditor).not.toBeNull();
    await userEvent.click(pipEditor);
    await userEvent.type(pipEditor, "请帮我总结第三章的核心论点");
    const submitBtn = document.querySelector<HTMLButtonElement>(
      '[data-space-canvas-dock="pip"] button[type="submit"]',
    )!;
    expect(submitBtn).not.toBeNull();
    await userEvent.click(submitBtn);

    // Wait for assistant reply in the floating PiP window
    await expect
      .poll(
        () =>
          document.querySelector<HTMLElement>('[data-space-canvas-dock="pip"]')?.textContent ?? "",
      )
      .toContain("慢决策替代本能反应");

    // Now the started standalone app thread appears in the left sidebar in `app-companion` state!
    await expect
      .poll(
        () =>
          document.querySelector('[data-sidebar-thread-state="app-companion"]')?.textContent ?? "",
      )
      .toContain(fakeApp.title);

    const companionRow = document.querySelector<HTMLElement>(
      '[data-sidebar-thread-state="app-companion"]',
    )!;
    expect(companionRow.getAttribute("data-active")).toBe("false");
    expect(companionRow.querySelector('[data-sidebar-app-origin-icon="companion"]')).not.toBeNull();
    expect(companionRow.querySelector("[data-sidebar-app-companion-badge]")?.textContent).toBe(
      "应用中",
    );

    // Verify zero rows in the sidebar are in full `selected` state while on /apps/$appId
    expect(document.querySelector('[data-sidebar-thread-state="selected"]')).toBeNull();

    await page.screenshot({
      path: `${SHOT_DIR}/sidebar-state-02-standalone-app-chatting.png`,
    });

    // Clicking the app-companion row promotes it to the current chat page (`selected`)
    await userEvent.click(companionRow);
    await expect.poll(() => router.state.location.pathname).toBe(`/${companionThreadId}`);
    await expect
      .poll(
        () => document.querySelector('[data-sidebar-thread-state="selected"]')?.textContent ?? "",
      )
      .toContain(fakeApp.title);
    expect(document.querySelector("[data-sidebar-app-companion-badge]")).toBeNull();

    // Switching to another unrelated chat thread shows the app thread in `app-origin` state
    await router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD_ID } });
    await expect
      .poll(
        () => document.querySelector('[data-sidebar-thread-state="selected"]')?.textContent ?? "",
      )
      .toContain("周报与里程碑整理");
    await expect
      .poll(
        () => document.querySelector('[data-sidebar-thread-state="app-origin"]')?.textContent ?? "",
      )
      .toContain(fakeApp.title);
    expect(document.querySelector('[data-sidebar-app-origin-icon="origin"]')).not.toBeNull();
  });

  it("Scenario 3: entering standalone from 资料空间 keeps SpaceSidebar active and shows live companion chat indicator in 最近", async () => {
    const fakeApp = buildFakeReaderApp();
    const { waitForFrameReady } = await mountTestRouter("/space", fakeApp);
    await waitForFrameReady();

    const spaceSidebar = document.querySelector<HTMLElement>("[data-space-sidebar]");
    expect(spaceSidebar).not.toBeNull();
    expect(document.querySelector('[data-testid="thread-sidebar"]')).toBeNull();

    // Send a prompt from the compact bar -> opens floating PiP & attaches companion chat indicator in SpaceSidebar
    await userEvent.type(
      document.querySelector("[data-space-dock-compact-input]")!,
      "提炼本章三条可执行清单",
    );
    await userEvent.click(document.querySelector("[data-space-dock-compact-send]")!);

    await expect
      .poll(
        () =>
          document.querySelector<HTMLElement>('[data-space-canvas-dock="pip"]')?.textContent ?? "",
      )
      .toContain("慢决策替代本能反应");

    await expect
      .poll(() =>
        spaceSidebar?.querySelector('[data-space-item-chat-status="active"]') ? "ok" : "",
      )
      .toBe("ok");

    await page.screenshot({
      path: `${SHOT_DIR}/sidebar-state-03-standalone-space-sidebar.png`,
    });
  });

  it("Scenario 4: dark theme renders the full Moss desktop rail shell, compact bar, selection comment composer, PiP window, and app-companion badge cleanly", async () => {
    const fakeApp = buildFakeReaderApp("dark");
    const { waitForFrameReady } = await mountTestRouter(`/apps/${fakeApp.id}`, fakeApp, "dark");
    await waitForFrameReady();

    await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
    await expect
      .poll(() => document.querySelector('[data-testid="thread-sidebar"]')?.textContent ?? "")
      .toContain("日常研发探讨");

    const iframeEl = document.querySelector("iframe") as HTMLIFrameElement;
    const doc = iframeEl.contentDocument!;
    const targetP = doc.getElementById("target-paragraph")!;
    const textNode = targetP.firstChild!;
    const range = doc.createRange();
    range.selectNodeContents(textNode);
    const sel = iframeEl.contentWindow!.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    doc.dispatchEvent(new Event("selectionchange"));
    doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    const commentBtn = page.getByTestId("page-app-selection-comment-btn");
    await expect.element(commentBtn).toBeVisible();
    await userEvent.click(commentBtn);

    const commentCard = page.getByTestId("page-app-comment-composer");
    await expect.element(commentCard).toBeVisible();
    await expect.element(page.getByTestId("page-app-comment-send-to-moss")).toBeChecked();
    await expect
      .poll(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="page-app-comment-composer"]');
        return el ? getComputedStyle(el).opacity : "0";
      })
      .toBe("1");

    await page.screenshot({
      path: `${SHOT_DIR}/sidebar-state-05-dark-theme-compact-and-comment.png`,
    });

    await userEvent.keyboard("{Escape}");
    await expect
      .poll(() => document.querySelector('[data-testid="page-app-comment-composer"]'))
      .toBeNull();

    await userEvent.type(
      document.querySelector("[data-space-dock-compact-input]")!,
      "用一句话总结这段话的核心论点",
    );
    await userEvent.click(document.querySelector("[data-space-dock-compact-send]")!);

    await expect
      .poll(
        () =>
          document.querySelector<HTMLElement>('[data-space-canvas-dock="pip"]')?.textContent ?? "",
      )
      .toContain("慢决策替代本能反应");

    await expect
      .poll(
        () =>
          document.querySelector('[data-sidebar-thread-state="app-companion"]')?.textContent ?? "",
      )
      .toContain(fakeApp.title);

    await page.screenshot({
      path: `${SHOT_DIR}/sidebar-state-04-dark-theme-app-and-sidebar.png`,
    });
  });
});
