// FILE: AppPageNonInvasiveOverlay.browser.tsx
// Purpose: Real headless Chromium verification & visual screenshots of Moss's non-invasive,
//          shared host-layer floating chat (4 states) + iframe text selection comment-to-Moss flow
//          across clean pure-content Page Apps.
// Layer: Web browser tests

import "../../index.css";

import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import type {
  MessageId,
  NativeApi,
  PageApp,
  PageAppId,
  ProjectId,
  ThreadId,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { usePageCommentsStore } from "~/pageCommentsStore";
import { initialState } from "~/storeState";
import { useStore } from "~/store";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";
import type { ChatMessage } from "~/types";
import { RealtimeVoiceControllerProvider } from "../chat/RealtimeVoiceControllerProvider";
import { SidebarProvider } from "../ui/sidebar";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import {
  SpaceCanvasChatDockHost,
  type SpaceCanvasActiveArtifact,
} from "../space/SpaceCanvasChatDock";
import { AppPageFrame } from "./AppPageFrame";
import { pageAppsClient } from "./pageAppsClient";

const SHOT_DIR = "../../../.tmp/non-invasive-ui";

function buildCleanWechatReadHtml(): string {
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
      background: #f9f6ef;
      color: #26231d;
      font-family: "Songti SC", "Noto Serif SC", "PingFang SC", -apple-system, serif;
      line-height: 1.9;
    }
    .reader { max-width: 720px; margin: 0 auto; }
    .meta {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 14px; margin-bottom: 28px;
      border-bottom: 1px solid rgba(38, 35, 29, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px; color: #7a7263;
    }
    .chapter-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: rgba(34, 197, 94, 0.12); color: #15803d; font-weight: 600;
    }
    h1 { font-size: 28px; margin: 0 0 8px; font-weight: 700; letter-spacing: -0.01em; }
    .author { font-size: 14px; color: #7a7263; margin-bottom: 28px; }
    p { font-size: 17px; margin: 0 0 20px; text-align: justify; }
    .note-foot {
      margin-top: 28px; padding-top: 14px;
      border-top: 1px dashed rgba(38, 35, 29, 0.12);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px; color: #8b8273;
    }
  </style>
</head>
<body>
  <article class="reader">
    <div class="meta">
      <span class="chapter-pill">微信阅读 · 第三章</span>
      <span>精读进度 42% · 无干扰阅读模式</span>
    </div>
    <h1>系统思考与慢决策</h1>
    <div class="author">沉思录精选集 · 第二节</div>
    <p>真正高效的阅读，并不在于一天翻完多少页，而是在遇到与自己过往经验相冲突的观点时，停下来把关键推理链路拆解清楚。</p>
    <p>当外部信息密度过高时，决定判断质量的往往不是即时反应速度，而是你是否留出了安静重读核心段落的时间。</p>
    <p><span id="target-quote">把复杂系统拆成可验证的小循环，比一次性追求完美蓝图更容易落地。</span></p>
    <p class="note-foot">页面内无任何预设 AI 侧栏，划词评论、右上语音与右下角气泡均由 Moss 宿主统一提供。</p>
  </article>
</body>
</html>`;
  return injectPageAppFrameRuntime(
    rawHtml,
    buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
  );
}

function buildCleanMeetingRoomHtml(): string {
  const rawHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>智能会议室 · 产品评审</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 40px 56px 96px;
      background: #f8fafc;
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      line-height: 1.7;
    }
    .room { max-width: 760px; margin: 0 auto; }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .pill { padding: 4px 12px; border-radius: 999px; background: #e0f2fe; color: #0369a1; font-size: 13px; font-weight: 600; }
    h1 { margin: 0 0 18px; font-size: 26px; font-weight: 700; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 20px 24px; margin-bottom: 14px; }
    .card h2 { margin: 0 0 8px; font-size: 16px; }
    .row { font-size: 14px; color: #475569; margin: 4px 0; }
  </style>
</head>
<body>
  <section class="room">
    <div class="top">
      <span class="pill">进行中 · 3 人参会</span>
      <span style="font-size:13px;color:#64748b;">15:00 – 15:45</span>
    </div>
    <h1>下周版本交付节奏与体验走查</h1>
    <div class="card">
      <h2>议题一：全局非侵入式 Moss 气泡适配</h2>
      <div class="row">• 所有资料空间与独立应用页统一右下角收起气泡，不入侵应用内部排版。</div>
      <div class="row">• 会议中可随时点开右下角 Moss 气泡整理纪要或追问议题细节。</div>
    </div>
    <div class="card">
      <h2>议题二：关键待办与负责人确认</h2>
      <div class="row">• 设计对齐：周三前完成桌面端与移动端细节抽检。</div>
    </div>
  </section>
</body>
</html>`;
  return injectPageAppFrameRuntime(
    rawHtml,
    buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
  );
}

describe("Non-invasive Page App floating Moss chat & selection comment overlay", () => {
  const createdUrls: string[] = [];
  let previousApi: NativeApi | undefined;

  beforeEach(async () => {
    window.localStorage.clear();
    usePageCommentsStore.setState({ commentsByPage: {} });
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
            message?: { messageId?: MessageId; text?: string };
          };
          const now = "2026-11-27T06:00:00.000Z";
          if (cmd.type === "thread.create" && cmd.threadId) {
            const tid = cmd.threadId;
            const pid = cmd.projectId ?? ("proj-1" as ProjectId);
            useStore.setState((prev) => ({
              threadIds: prev.threadIds?.includes(tid)
                ? prev.threadIds
                : [...(prev.threadIds ?? []), tid],
              sidebarThreadSummaryById: {
                ...prev.sidebarThreadSummaryById,
                [tid]: {
                  id: tid,
                  projectId: pid,
                  title: cmd.title || "微信阅读 · 极简书房",
                  modelSelection: { provider: "codex", model: "gpt-5.4" },
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  session: null,
                  latestTurn: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  latestUserMessageAt: now,
                  hasPendingApprovals: false,
                  hasPendingUserInput: false,
                  hasActionableProposedPlan: false,
                  hasLiveTailWork: false,
                  pendingBackgroundWorkCount: 0,
                },
              },
              threadShellById: {
                ...(prev.threadShellById ?? {}),
                [tid]: {
                  id: tid,
                  codexThreadId: null,
                  projectId: pid,
                  title: cmd.title || "微信阅读 · 极简书房",
                  modelSelection: { provider: "codex", model: "gpt-5.4" },
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
              text: cmd.message?.text ?? "请把这一条拆成两步可执行待办",
              createdAt: now,
              streaming: false,
            };
            const assistantMsg: ChatMessage = {
              id: assistantMsgId,
              role: "assistant",
              text: "已结合你划选的「把复杂系统拆成可验证的小循环」整理出 2 条读后启发：\n1. 先跑通最小验证闭环，再逐步叠加复杂功能\n2. 每次迭代保留清晰反馈信号，避免盲目扩张",
              createdAt: "2026-11-27T06:00:02.000Z",
              completedAt: "2026-11-27T06:00:02.000Z",
              streaming: false,
            };
            useStore.setState((prev) => ({
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
            }));
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
          id: "proj-1" as ProjectId,
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
      threadIds: ["thread-companion-1" as ThreadId],
      sidebarThreadSummaryById: {
        ["thread-companion-1" as ThreadId]: {
          id: "thread-companion-1" as ThreadId,
          projectId: "proj-1" as ProjectId,
          title: "微信阅读 · 极简书房",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          session: null,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: "2026-11-27T05:00:00.000Z",
            startedAt: "2026-11-27T05:00:00.000Z",
            completedAt: "2026-11-27T05:00:04.000Z",
            assistantMessageId: null,
          },
          createdAt: "2026-11-27T05:00:00.000Z",
          updatedAt: "2026-11-27T05:00:04.000Z",
          archivedAt: null,
          latestUserMessageAt: "2026-11-27T05:00:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasLiveTailWork: false,
          pendingBackgroundWorkCount: 0,
        },
      },
    });
    await page.viewport(1280, 800);
  });

  afterEach(async () => {
    for (const url of createdUrls.splice(0)) {
      URL.revokeObjectURL(url);
    }
    vi.restoreAllMocks();
    if (previousApi) window.nativeApi = previousApi;
    else delete window.nativeApi;
    window.localStorage.clear();
    await cleanup();
  });

  it("renders ONLY the new non-invasive floating UI (compact -> bubble -> selection comment-to-Moss -> live chat) in WeChat Read", async () => {
    const html = buildCleanWechatReadHtml();
    const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    createdUrls.push(blobUrl);

    const fakeApp: PageApp = {
      id: "app-reader-clean" as PageAppId,
      scopeSpaceId: null,
      spaceId: null,
      title: "微信阅读 · 深度精读",
      description: "Pure WeChat Read without bespoke AI sidebar",
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
    const callSpy = vi
      .spyOn(pageAppsClient, "call")
      .mockResolvedValue({ value: { ok: true, id: "c-1" } });

    function Harness() {
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
        <RealtimeVoiceControllerProvider>
          <ToastProvider>
            <TooltipProvider>
              <SidebarProvider open={false}>
                <div
                  ref={containerRef}
                  style={{ position: "fixed", inset: 0, display: "flex", overflow: "hidden" }}
                >
                  <SpaceCanvasChatDockHost
                    artifact={artifact}
                    containerRef={containerRef}
                    floatingLauncher="compact"
                    keepItemOpen
                  >
                    {(dock) => (
                      <AppPageFrame appPageId={fakeApp.id} mode="full" topBar dock={dock} />
                    )}
                  </SpaceCanvasChatDockHost>
                </div>
              </SidebarProvider>
            </TooltipProvider>
          </ToastProvider>
        </RealtimeVoiceControllerProvider>
      );
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: Harness });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    await render(
      <QueryClientProvider client={client}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <RouterProvider router={router} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    const compactBar = document.querySelector<HTMLElement>('[data-space-dock-launcher="compact"]');
    expect(compactBar).not.toBeNull();
    await expect.element(page.getByPlaceholder("随心输入")).toBeVisible();

    const iframeEl = document.querySelector("iframe") as HTMLIFrameElement;
    await expect
      .poll(() => Boolean(iframeEl?.contentDocument?.getElementById("target-quote")))
      .toBe(true);

    // Ensure zero old in-app MossCompanionDrawer / MossSelectionAsk chrome exists inside WeChat Read
    expect(
      iframeEl.contentDocument?.querySelector("moss-companion-drawer, moss-selection-ask"),
    ).toBeNull();

    // 1. Capture Screenshot 1: Pure WeChat Read + compact bottom-right Moss bar (`— 新聊天` / `随心输入`)
    await page.screenshot({
      path: `${SHOT_DIR}/non-invasive-01-wechat-read-compact.png`,
    });

    // 2. Click minimize (`—`) -> collapses into unobtrusive circular bubble
    await userEvent.click(document.querySelector("[data-space-dock-minimize]")!);
    await expect
      .poll(() => Boolean(document.querySelector('[data-space-dock-launcher="minimized"]')))
      .toBe(true);
    await page.screenshot({
      path: `${SHOT_DIR}/non-invasive-02-wechat-read-bubble.png`,
    });

    // Re-expand compact bar from circular bubble
    await userEvent.click(document.querySelector("[data-space-dock-expand-bubble]")!);
    await expect
      .poll(() => Boolean(document.querySelector('[data-space-dock-launcher="compact"]')))
      .toBe(true);

    // 3. Highlight book passage inside WeChat Read -> host selection bubble + comment-to-Moss card
    const doc = iframeEl.contentDocument!;
    const targetSpan = doc.getElementById("target-quote")!;
    const textNode = targetSpan.firstChild!;
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
    const sendCheckbox = page.getByTestId("page-app-comment-send-to-moss");
    await expect.element(sendCheckbox).toBeChecked();

    await userEvent.type(page.getByLabelText("评论内容"), "请结合书中上下文提炼两条落地建议");
    await page.screenshot({
      path: `${SHOT_DIR}/non-invasive-03-wechat-read-comment.png`,
    });

    // 4. Submit comment -> persists comment, sends to Moss, and opens expanded floating conversation window
    await userEvent.click(page.getByTestId("page-app-comment-post"));
    await expect
      .poll(() => {
        const stored =
          usePageCommentsStore.getState().commentsByPage[`page-app:${fakeApp.id}`] ?? [];
        return stored.length;
      })
      .toBe(1);
    const savedComment =
      usePageCommentsStore.getState().commentsByPage[`page-app:${fakeApp.id}`]![0]!;
    expect(savedComment.body).toBe("请结合书中上下文提炼两条落地建议");
    expect(savedComment.sentToAgentAt).not.toBeNull();
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "comments", method: "add" }),
    );

    await expect
      .poll(
        () =>
          document.querySelector<HTMLElement>('[data-space-canvas-dock="pip"]')?.textContent ?? "",
      )
      .toContain("2 条读后启发");
    const pipDock = document.querySelector<HTMLElement>('[data-space-canvas-dock="pip"]');
    expect(pipDock).not.toBeNull();
    expect(pipDock?.textContent ?? "").not.toContain("当前未检测到可用智能体");
    await page.screenshot({
      path: `${SHOT_DIR}/non-invasive-04-wechat-read-live-chat.png`,
    });
  });

  it("overlays the exact same universal corner Moss bubble on ANY other pure app (e.g. Smart Meeting Room)", async () => {
    const html = buildCleanMeetingRoomHtml();
    const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    createdUrls.push(blobUrl);

    const meetingApp: PageApp = {
      id: "app-meeting-clean" as PageAppId,
      scopeSpaceId: null,
      spaceId: null,
      title: "智能会议室 · 产品评审",
      description: "Pure meeting room app",
      revision: 1,
      capabilities: { db: {}, ai: {} },
      favorite: false,
      thumbnail: null,
      sourceThreadId: null,
      htmlChars: html.length,
      trashedAt: null,
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
    };

    vi.spyOn(pageAppsClient, "openFrame").mockResolvedValue({
      app: meetingApp,
      revision: 1,
      viewer: { id: "owner", name: "林溪", level: "owner", isOwner: true },
      capabilities: { db: {}, ai: {} },
      consent: {},
      frameUrl: blobUrl,
      frameOrigin: window.location.origin,
      ownOrigin: true,
      offlineReady: true,
      expiresAt: "2026-11-28T00:00:00.000Z",
    });

    function MeetingHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const artifact = useMemo<SpaceCanvasActiveArtifact>(
        () => ({
          kind: "app",
          itemId: meetingApp.id,
          title: meetingApp.title,
          scopeSpaceId: null,
          account: "default",
        }),
        [],
      );
      return (
        <RealtimeVoiceControllerProvider>
          <ToastProvider>
            <TooltipProvider>
              <SidebarProvider open={false}>
                <div
                  ref={containerRef}
                  style={{ position: "fixed", inset: 0, display: "flex", overflow: "hidden" }}
                >
                  <SpaceCanvasChatDockHost
                    artifact={artifact}
                    containerRef={containerRef}
                    floatingLauncher="minimized"
                    keepItemOpen
                  >
                    {(dock) => (
                      <AppPageFrame appPageId={meetingApp.id} mode="full" topBar dock={dock} />
                    )}
                  </SpaceCanvasChatDockHost>
                </div>
              </SidebarProvider>
            </TooltipProvider>
          </ToastProvider>
        </RealtimeVoiceControllerProvider>
      );
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: MeetingHarness });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    await render(
      <QueryClientProvider client={client}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <RouterProvider router={router} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    const iframeEl = document.querySelector("iframe") as HTMLIFrameElement;
    await expect.poll(() => Boolean(iframeEl?.contentDocument?.querySelector(".room"))).toBe(true);
    const bubble = document.querySelector<HTMLElement>('[data-space-dock-launcher="minimized"]');
    expect(bubble).not.toBeNull();
    await page.screenshot({
      path: `${SHOT_DIR}/non-invasive-05-any-app-meeting-bubble.png`,
    });

    // Clicking the universal bubble on any app opens the compact bar cleanly
    await userEvent.click(document.querySelector("[data-space-dock-expand-bubble]")!);
    await expect
      .poll(() => Boolean(document.querySelector('[data-space-dock-launcher="compact"]')))
      .toBe(true);
  });
});
