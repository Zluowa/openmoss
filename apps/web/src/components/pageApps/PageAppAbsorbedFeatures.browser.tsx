// FILE: PageAppAbsorbedFeatures.browser.tsx
// Purpose: Real headless Chromium verification & visual screenshots for:
//          1) Claude-aligned floating MarkupToolbar (expanded bar + DOM element picker) over Novel Reader
//          2) Claude-aligned PageCommentsLayer (comments split button, NewCommentCard, @Moss, Avatar Pin, All comments)
//          3) Version history + pin stable / follow latest dropdown
//          4) Unified 资料空间-aligned PageAppList (SpaceMasonryGrid, SpaceItemCard, filter Menu, grid/list view, desktop shortcuts)
//          5) Embed anti-duplicate-heading footer
// Layer: Web browser tests

import "../../index.css";

import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import type {
  DesktopPageAppsBridge,
  InstalledDesktopPageApp,
  PageApp,
  PageAppId,
  PageAppPublicationSummary,
  PageAppsOpenFrameResult,
  PageAppVersion,
  ThreadId,
} from "@moss/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { MossLocaleScope } from "~/localization";
import { usePageCommentsStore } from "~/pageCommentsStore";
import { useThreadSendRequestStore } from "~/threadSendRequestStore";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { AppPageFrame } from "./AppPageFrame";
import { pageAppsClient } from "./pageAppsClient";
import { clearPageAppPreviewCacheForTests } from "./PageAppThumbnail";
import { PageAppList } from "./PageAppList";

vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

const SHOT_DIR = "../../../.tmp/absorbed-features";
const THREAD_ID = "thread-absorbed-1" as ThreadId;
const READER_APP_ID = "app-novel-reader-starter" as PageAppId;
const TRACKER_APP_ID = "app-tracker-pub" as PageAppId;
const TODO_APP_ID = "app-todo-space" as PageAppId;

function buildNovelReaderFixtureHtml(parentOrigin: string): string {
  const rawHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>静读 · 小说阅读器</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #f6efe2; color: #3d3126; }
    .bar { height: 48px; padding: 0 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #ddd0ba; background: #efe5d3; }
    .bar h1 { margin: 0; font-size: 15px; font-weight: 600; }
    .actions { display: flex; gap: 8px; font-size: 12px; color: #7a6a58; }
    .pill { padding: 3px 10px; border-radius: 6px; border: 1px solid #ddd0ba; background: #f6efe2; }
    .wrap { display: grid; grid-template-columns: 240px 1fr; min-height: 460px; }
    .toc { border-right: 1px solid #ddd0ba; padding: 14px; background: #efe5d3; font-size: 12.5px; }
    .toc-item { padding: 8px 10px; border-radius: 6px; margin-bottom: 4px; }
    .toc-item.active { background: rgba(180, 83, 9, 0.14); color: #b45309; font-weight: 600; }
    .paper { padding: 28px 40px; font-family: "Noto Serif SC", Georgia, serif; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; line-height: 1.9; font-size: 16px; }
    h2 { margin: 0 0 16px; font-size: 22px; }
    p { margin: 0 0 14px; text-align: justify; }
  </style>
</head>
<body>
  <header class="bar">
    <div style="display:flex;align-items:center;gap:10px;">
      <span class="pill">书架</span>
      <h1 data-moss-top-heading="true">静读 · 小说阅读器</h1>
    </div>
    <div class="actions">
      <span class="pill">导入 TXT/MD</span>
      <span class="pill">双栏翻页中</span>
      <span class="pill">暖黄护眼</span>
      <span class="pill">导出笔记</span>
    </div>
  </header>
  <div class="wrap">
    <aside class="toc">
      <div class="toc-item active">第一章 · 巳正，望楼传讯</div>
      <div class="toc-item">第二章 · 午初，西市暗流</div>
      <div class="toc-item">第三章 · 未正，大案牍术</div>
    </aside>
    <main class="paper">
      <h2 id="chapter-heading">第一章 · 巳正，望楼传讯</h2>
      <div class="cols">
        <div>
          <p id="para-pick-target">天宝三载，上元节将至。长安一百零八坊撤去宵禁前的最后一轮鼓声尚未敲响，靖安司大厅中央的微缩沙盘模型已然点亮。</p>
          <p>望楼上的旗手单膝跪在木垛边，双臂举起一面青底白纹方旗，三百步外另一座望楼的木窗立刻开启。</p>
        </div>
        <div>
          <p id="para-comment-target">张小敬站在舆图左侧的案几前，指尖停在怀远坊西市交界处，看似平静的灯市底下早已暗流涌动。</p>
          <p>只要亥时花萼楼的灯火亮起，整座城的命运就会压在最后那半柱香里。</p>
        </div>
      </div>
    </main>
  </div>
</body>
</html>`;
  return injectPageAppFrameRuntime(rawHtml, buildPageAppFrameRuntime({ parentOrigin }));
}

function makeApp(overrides: Partial<PageApp> = {}): PageApp {
  const now = "2026-11-27T08:00:00.000Z";
  return {
    id: READER_APP_ID,
    scopeSpaceId: null,
    spaceId: null,
    title: "静读 · 小说阅读器",
    description: "原生小说阅读器",
    revision: 3,
    pinnedRevision: null,
    starterId: "moss-novel-reader-v1",
    capabilities: {},
    favorite: false,
    thumbnail: null,
    sourceThreadId: null,
    htmlChars: 4200,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function installDesktopMock(initial: InstalledDesktopPageApp[]) {
  let installed = [...initial];
  const setDesktopShortcut = vi.fn<NonNullable<DesktopPageAppsBridge["setDesktopShortcut"]>>(
    async (input) => {
      installed = installed.map((entry) => {
        if (entry.appId !== input.appId && entry.installId !== input.installId) return entry;
        const places = input.enabled
          ? Array.from(new Set([...entry.places, "desktop" as const]))
          : entry.places.filter((place) => place !== "desktop");
        return { ...entry, places };
      });
      const updated =
        installed.find((e) => e.appId === input.appId || e.installId === input.installId) ?? null;
      return {
        updated: Boolean(updated),
        app: updated,
        desktopShortcutEnabled: Boolean(updated?.places.includes("desktop")),
      };
    },
  );
  const bridge: DesktopPageAppsBridge = {
    isAvailable: vi.fn(async () => true),
    installFromPage: vi.fn(async () => ({ status: "cancelled" as const })),
    requestInstall: vi.fn(async () => ({ status: "cancelled" as const })),
    isInstalled: vi.fn(async (id) => installed.some((e) => e.appId === id)),
    getInstalled: vi.fn(async (id) => installed.find((e) => e.appId === id) ?? null),
    listInstalled: vi.fn(async () => installed),
    openInstalled: vi.fn(async () => ({ opened: true, windowId: 10 })),
    uninstall: vi.fn(async () => ({
      uninstalled: true,
      removedAppIds: [],
      removedInstallIds: [],
    })),
    setDesktopShortcut,
    showInFolder: vi.fn(async () => true),
    openPermissions: vi.fn(async () => undefined),
    getPermissions: vi.fn(async (input) => ({
      appId: input.appId,
      revision: 1,
      contentHash: null,
      declared: [],
      states: {},
      details: {},
    })),
    requestPermissions: vi.fn(async () => ({})),
    setPermission: vi.fn(async (input) => ({
      appId: input.appId,
      revision: 1,
      contentHash: null,
      declared: [],
      states: {},
      details: {},
    })),
    syncAppVersion: vi.fn(async () => ({ invalidated: false, reloaded: false })),
    reportAppGone: vi.fn(async () => undefined),
    offerInMenu: vi.fn(async () => undefined),
    onPickedInMenu: vi.fn(() => () => undefined),
    onInstalledChanged: vi.fn(() => () => undefined),
    invokeDesktopApi: vi.fn(async () => null),
  };
  (window as { desktopBridge?: unknown }).desktopBridge = { pageApps: bridge };
  return { bridge, setDesktopShortcut };
}

describe("Absorbed OpenMausBot & Native Novel Reader Features", () => {
  const createdUrls: string[] = [];

  beforeEach(() => {
    clearPageAppPreviewCacheForTests();
    useComposerDraftStore.setState({ draftsByThreadId: {} });
    usePageCommentsStore.setState({ commentsByPage: {} });
    useThreadSendRequestStore.setState({ requests: [] });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    delete (window as { desktopBridge?: unknown }).desktopBridge;
    for (const url of createdUrls.splice(0)) URL.revokeObjectURL(url);
  });

  it("shares Claude-aligned floating MarkupToolbar, PageCommentsLayer, and version pinning inside Novel Reader", async () => {
    await page.viewport(1280, 780);
    const readerHtml = buildNovelReaderFixtureHtml(window.location.origin);
    const blobUrl = URL.createObjectURL(
      new Blob([readerHtml], { type: "text/html;charset=utf-8" }),
    );
    createdUrls.push(blobUrl);

    let activeApp = makeApp({ revision: 3, pinnedRevision: null });
    const makeOpenFrameResult = (app: PageApp, servedRev: number): PageAppsOpenFrameResult => ({
      app,
      revision: servedRev,
      capabilities: {},
      frameUrl: blobUrl,
      frameOrigin: window.location.origin,
      ownOrigin: true,
      offlineReady: true,
      expiresAt: "2026-11-28T00:00:00.000Z",
      viewer: { id: "owner", name: "Hongyan", level: "owner", isOwner: true },
      consent: {},
    });

    vi.spyOn(pageAppsClient, "openFrame").mockImplementation(async () =>
      makeOpenFrameResult(activeApp, activeApp.pinnedRevision ?? activeApp.revision),
    );
    const versionsList: PageAppVersion[] = [
      {
        appId: READER_APP_ID,
        revision: 3,
        title: "静读 · 小说阅读器",
        description: "最新版",
        capabilities: {},
        htmlChars: 4200,
        operation: "update",
        author: "local-user",
        authorThreadId: null,
        createdAt: "2026-11-27T08:00:00.000Z",
      },
      {
        appId: READER_APP_ID,
        revision: 1,
        title: "静读 · 初版稳定",
        description: "初版",
        capabilities: {},
        htmlChars: 3900,
        operation: "starter",
        author: "local-user",
        authorThreadId: null,
        createdAt: "2026-11-27T07:00:00.000Z",
      },
    ];
    vi.spyOn(pageAppsClient, "versions").mockResolvedValue({ versions: versionsList });
    const mutateSpy = vi.spyOn(pageAppsClient, "mutate").mockImplementation(async (input) => {
      if (input.op === "pin-version") {
        activeApp = { ...activeApp, pinnedRevision: input.revision };
      }
      return { app: activeApp };
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <TooltipProvider>
          <SidebarProvider open>
            <div className="h-[740px] w-full bg-[var(--background)]">
              <AppPageFrame appPageId={READER_APP_ID} mode="full" topBar hostThreadId={THREAD_ID} />
            </div>
          </SidebarProvider>
        </TooltipProvider>
      </MossLocaleScope>,
    );

    const frame = screen.container.querySelector("iframe") as HTMLIFrameElement;
    await expect.poll(() => frame.contentDocument?.querySelector("#para-pick-target")).toBeTruthy();

    // 1. Floating MarkupToolbar + DOM pick + expanded drawing bar
    const annotateBtn = screen.container.querySelector(
      "[data-browser-annotate]",
    ) as HTMLButtonElement;
    await userEvent.click(annotateBtn);
    await expect.poll(() => document.querySelector("[data-markup-toolbar]")).toBeTruthy();

    // Pick paragraph while in select mode -> lands in composerDraftStore + marker layer
    const targetPara = frame.contentDocument!.querySelector("#para-pick-target") as HTMLElement;
    targetPara.click();
    await expect
      .poll(
        () =>
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.browserAnnotations.length ??
          0,
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          frame.contentDocument?.querySelector('[data-moss-marker-layer="true"]')?.children
            .length ?? 0,
      )
      .toBe(1);

    // Switch to Pen tool -> toolbar expands to full Claude-aligned bar (color, stroke width, undo/redo/clear, add to chat)
    const penBtn = document.querySelector('[data-sketch-tool="pen"]') as HTMLButtonElement;
    await userEvent.click(penBtn);
    await expect
      .poll(() => document.querySelector("[data-markup-toolbar]")?.getAttribute("data-layout"))
      .toBe("full");

    // Draw a freehand highlight stroke on the MarkupCanvas host ([data-markup-canvas] handles pointer events)
    await expect
      .poll(() =>
        document.querySelector('[data-testid="page-app-markup-canvas"] [data-markup-canvas]'),
      )
      .toBeTruthy();
    const canvasHost = document.querySelector(
      '[data-testid="page-app-markup-canvas"] [data-markup-canvas]',
    ) as HTMLElement;
    const canvasRect = canvasHost.getBoundingClientRect();
    const sx = canvasRect.left + 680;
    const sy = canvasRect.top + 190;
    canvasHost.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        clientX: sx,
        clientY: sy,
        button: 0,
        buttons: 1,
      }),
    );
    canvasHost.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: sx + 220,
        clientY: sy + 50,
        buttons: 1,
      }),
    );
    canvasHost.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 1,
        clientX: sx + 220,
        clientY: sy + 50,
      }),
    );

    // Wait for Undo/Redo/Clear controls and enabled Add-to-chat button on the expanded bar
    await expect.element(page.getByRole("button", { name: "撤销" })).toBeVisible();
    await new Promise((r) => setTimeout(r, 180));
    await page.screenshot({ path: `${SHOT_DIR}/absorbed-01-novel-reader-and-markup.png` });

    // Close markup mode cleanly via Escape + confirmation Discard button
    await userEvent.keyboard("{Escape}");
    const discardDialog = page.getByRole("alertdialog");
    await expect.element(discardDialog).toBeVisible();
    await userEvent.click(discardDialog.getByRole("button").nth(1));

    // 2. Claude-aligned PageCommentsLayer: toggle comments split button, pick element, post with @Moss, open All comments
    const commentsToggle = document.querySelector(
      "[data-page-comments-toggle]",
    ) as HTMLButtonElement;
    expect(commentsToggle).not.toBeNull();
    await userEvent.click(commentsToggle);
    expect(commentsToggle.getAttribute("aria-pressed")).toBe("true");

    const frameLoc = page.frameLocator(page.elementLocator(frame));
    await frameLoc.getByText(/张小敬站在舆图左侧/).click();

    const commentField = page.getByRole("textbox", { name: "Comment" });
    await expect.element(commentField).toBeVisible();
    await userEvent.type(commentField, "@Moss 帮我把这段字号调大一些");
    await expect.element(page.getByText("@Moss", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Post comment" }).click();

    // Verify comment sent to thread + Avatar CommentPin + ThreadCard + All comments panel
    await expect.poll(() => useThreadSendRequestStore.getState().requests.length).toBe(1);
    expect(useThreadSendRequestStore.getState().requests[0]?.message).toContain(
      "帮我把这段字号调大一些",
    );
    await expect.element(page.getByRole("group", { name: "Comment thread" })).toBeVisible();
    await expect.poll(() => document.querySelector("[data-page-comment-pin]")).toBeTruthy();

    await new Promise((r) => setTimeout(r, 320));
    await page.screenshot({ path: `${SHOT_DIR}/absorbed-02-page-comments-and-pins.png` });

    // Open All comments panel from the comments split menu and verify thread summary
    await page.getByRole("button", { name: "评论选项" }).click();
    await page.getByRole("menuitem", { name: "全部评论" }).click();
    await expect.element(page.getByRole("dialog", { name: "All comments" })).toBeVisible();

    // Close comments panel first, then thread card, before opening Version History dropdown
    await userEvent.click(page.getByRole("button", { name: "Close comments", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Close comment", exact: true }));
    await userEvent.click(commentsToggle);
    await expect.poll(() => document.querySelector("[data-page-comments-panel]")).toBeNull();

    // 3. Version History & Pin Stable dropdown -> verify Follow Latest + pin v1
    const versionTrigger = page.getByTestId("page-app-version-menu-trigger");
    await versionTrigger.click();
    await expect.element(page.getByTestId("page-app-version-follow-latest")).toBeVisible();
    await expect.element(page.getByTestId("page-app-version-item-1")).toBeVisible();

    await page.screenshot({ path: `${SHOT_DIR}/absorbed-03-version-pin-menu.png` });

    await page.getByTestId("page-app-version-item-1").click();
    await expect
      .element(page.getByTestId("page-app-version-pinned-badge"))
      .toHaveTextContent("已锁定");
    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: "pin-version", revision: 1 }),
    );
  });

  function makeCanvasCoverDataUrl(kind: "board" | "ai-todo"): string {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 960, 600);
    if (kind === "board") {
      grad.addColorStop(0, "rgb(239, 246, 255)");
      grad.addColorStop(1, "rgb(219, 234, 254)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 960, 600);
      // Clean miniature dashboard cards
      ctx.fillStyle = "rgb(255, 255, 255)";
      ctx.fillRect(64, 64, 250, 140);
      ctx.fillRect(350, 64, 250, 140);
      ctx.fillRect(636, 64, 260, 140);
      ctx.fillRect(64, 240, 832, 280);
      ctx.fillStyle = "rgb(37, 99, 235)";
      ctx.fillRect(96, 100, 90, 16);
      ctx.fillStyle = "rgb(16, 185, 129)";
      ctx.fillRect(382, 100, 110, 16);
      ctx.fillStyle = "rgb(245, 158, 11)";
      ctx.fillRect(668, 100, 80, 16);
      ctx.fillStyle = "rgb(96, 165, 250)";
      for (let i = 0; i < 6; i++) {
        const barH = 70 + ((i * 47) % 140);
        ctx.fillRect(110 + i * 125, 470 - barH, 68, barH);
      }
    } else {
      grad.addColorStop(0, "rgb(254, 243, 199)");
      grad.addColorStop(0.55, "rgb(253, 230, 138)");
      grad.addColorStop(1, "rgb(252, 211, 77)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 960, 600);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.beginPath();
      ctx.arc(270, 290, 170, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(217, 119, 6, 0.22)";
      ctx.beginPath();
      ctx.arc(690, 220, 150, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgb(255, 255, 255)";
      ctx.fillRect(280, 110, 400, 380);
      ctx.fillStyle = "rgb(217, 119, 6)";
      ctx.fillRect(330, 170, 190, 26);
      ctx.fillStyle = "rgb(229, 231, 235)";
      ctx.fillRect(330, 236, 290, 22);
      ctx.fillRect(330, 292, 250, 22);
      ctx.fillRect(330, 348, 270, 22);
    }
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  const TODO_LIVE_PREVIEW_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><style>
  body { margin: 0; padding: 36px 48px; background: rgb(252, 252, 253); color: rgb(24, 24, 27); font-family: -apple-system, sans-serif; }
  h1 { margin: 0 0 18px; font-size: 28px; }
  .item { display: flex; align-items: center; gap: 14px; padding: 14px 18px; margin-bottom: 12px; border-radius: 10px; border: 1px solid rgb(228, 228, 231); background: rgb(255, 255, 255); font-size: 18px; }
  .box { width: 20px; height: 20px; border-radius: 5px; border: 2px solid rgb(22, 163, 74); background: rgba(22, 163, 74, 0.14); }
</style></head><body><h1>每日工作待办清单</h1><div class="item"><span class="box"></span><span>确认上午产品设计与排期评审</span></div><div class="item"><span class="box"></span><span>整理阅读笔记并生成周度摘要</span></div><div class="item"><span class="box"></span><span>跟进桌面应用封面预览体验</span></div></body></html>`;

  it("renders 资料空间-unified PageAppList with live previews, AI cover generation, filter, and desktop shortcuts", async () => {
    await page.viewport(1280, 760);
    const { setDesktopShortcut } = installDesktopMock([
      {
        installId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        appId: TRACKER_APP_ID,
        name: "项目周报看板",
        revision: 2,
        places: ["start-menu", "desktop"],
        installedAt: "2026-11-27T06:00:00.000Z",
      },
    ]);

    const boardThumb = makeCanvasCoverDataUrl("board");
    const aiCoverArtwork = makeCanvasCoverDataUrl("ai-todo");

    const starterApp = makeApp({ favorite: true, thumbnail: null });
    const publishedApp = makeApp({
      id: TRACKER_APP_ID,
      title: "项目周报看板",
      starterId: null,
      revision: 2,
      thumbnail: boardThumb,
    });
    let todoApp = makeApp({
      id: TODO_APP_ID,
      title: "每日工作待办清单",
      starterId: null,
      revision: 1,
      thumbnail: null,
    });
    const pubSummary: PageAppPublicationSummary = {
      appId: TRACKER_APP_ID,
      slug: "weekly-board",
      url: "https://moss.local/s/weekly-board",
      visibility: "public",
      liveRevision: 2,
      publishedAt: "2026-11-27T07:00:00.000Z",
      updatedAt: "2026-11-27T07:00:00.000Z",
    };

    const listSpy = vi.spyOn(pageAppsClient, "list").mockImplementation(async () => ({
      apps: [starterApp, publishedApp, todoApp],
    }));
    vi.spyOn(pageAppsClient, "listPublished").mockResolvedValue({ publications: [pubSummary] });
    vi.spyOn(pageAppsClient, "read").mockImplementation(async ({ appId }) => ({
      app: appId === READER_APP_ID ? starterApp : todoApp,
      revision: 1,
      html:
        appId === READER_APP_ID
          ? buildNovelReaderFixtureHtml(window.location.origin)
          : TODO_LIVE_PREVIEW_HTML,
      capabilities: {},
    }));
    const generateCoverSpy = vi
      .spyOn(pageAppsClient, "generateCover")
      .mockImplementation(async ({ appId }) => ({
        app: appId === TODO_APP_ID ? todoApp : starterApp,
        imageDataUrl: aiCoverArtwork,
        modelId: "gpt-image-2.5-flare",
        prompt: "Clean editorial app cover illustration for 每日工作待办清单",
      }));
    const mutateSpy = vi.spyOn(pageAppsClient, "mutate").mockImplementation(async (input) => {
      if (input.op === "set-thumbnail" && input.appId === TODO_APP_ID) {
        todoApp = { ...todoApp, thumbnail: input.thumbnail };
        return { app: todoApp };
      }
      return { app: starterApp };
    });

    await render(
      <MossLocaleScope locale="zh-CN">
        <TooltipProvider>
          <SidebarProvider open>
            <div className="h-[720px] w-full bg-[var(--background)]">
              <PageAppList />
            </div>
          </SidebarProvider>
        </TooltipProvider>
      </MossLocaleScope>,
    );

    await expect
      .element(page.getByTestId(`page-app-starter-badge-${READER_APP_ID}`))
      .toHaveTextContent("示例");
    await expect
      .element(page.getByTestId(`page-app-installed-badge-${TRACKER_APP_ID}`))
      .toHaveTextContent("已安装");
    await expect
      .element(page.getByTestId(`page-app-published-badge-${TRACKER_APP_ID}`))
      .toHaveTextContent("已分享");

    // Cards without thumbnails render live scaled static HTML previews; saved cover renders its image
    await expect
      .poll(() => document.querySelectorAll('[data-page-app-live-preview="true"]').length)
      .toBe(2);
    expect(
      page
        .getByTestId(`page-app-card-${TRACKER_APP_ID}`)
        .element()
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe(boardThumb);

    // All three SpaceMasonryGrid cards match in height for balanced 资料空间 alignment
    await new Promise((r) => setTimeout(r, 220));
    const h1 = page
      .getByTestId(`page-app-card-${READER_APP_ID}`)
      .element()
      .getBoundingClientRect().height;
    const h2 = page
      .getByTestId(`page-app-card-${TRACKER_APP_ID}`)
      .element()
      .getBoundingClientRect().height;
    const h3 = page
      .getByTestId(`page-app-card-${TODO_APP_ID}`)
      .element()
      .getBoundingClientRect().height;
    expect(Math.abs(h1 - h2)).toBeLessThanOrEqual(2);
    expect(Math.abs(h2 - h3)).toBeLessThanOrEqual(2);

    await page.screenshot({ path: `${SHOT_DIR}/absorbed-04-unified-apps-hub.png` });

    // Generate AI Cover for 每日工作待办清单 -> encodes valid JPEG -> replaces live preview with AI artwork
    await page.getByTestId(`page-app-card-desktop-menu-trigger-${TODO_APP_ID}`).click();
    await page.getByTestId(`page-app-card-generate-cover-${TODO_APP_ID}`).click();
    await expect.poll(() => generateCoverSpy.mock.calls.length).toBe(1);
    await expect.poll(() => mutateSpy.mock.calls.length).toBe(1);
    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "set-thumbnail",
        appId: TODO_APP_ID,
        thumbnail: expect.stringMatching(/^data:image\/jpeg;base64,/u),
      }),
      undefined,
    );
    await expect
      .poll(() => page.getByTestId(`page-app-card-${TODO_APP_ID}`).element().querySelector("img"))
      .toBeTruthy();

    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: `${SHOT_DIR}/absorbed-05-ai-cover-generated.png` });

    // Reset AI cover back to live HTML preview cleanly
    await page.getByTestId(`page-app-card-desktop-menu-trigger-${TODO_APP_ID}`).click();
    await page.getByTestId(`page-app-card-reset-cover-${TODO_APP_ID}`).click();
    await expect
      .poll(() =>
        page
          .getByTestId(`page-app-card-${TODO_APP_ID}`)
          .element()
          .querySelector('[data-page-app-live-preview="true"]'),
      )
      .toBeTruthy();
    void listSpy;

    // Switch to List View -> SpaceListHeader renders cleanly
    await page.getByTestId("page-app-view-list").click();
    await expect.element(page.getByRole("columnheader", { name: "名称" })).toBeVisible();
    await page.getByTestId("page-app-view-grid").click();

    // Open 资料空间 filter Menu -> choose 已安装 -> hides uninstalled cards
    await page.getByTestId("page-app-filter-trigger").click();
    await page.getByTestId("page-app-filter-installed").click();
    await expect.element(page.getByTestId(`page-app-card-${TRACKER_APP_ID}`)).toBeVisible();
    await expect
      .poll(() => document.querySelector(`[data-testid="page-app-card-${READER_APP_ID}"]`))
      .toBeNull();

    // Open desktop menu and toggle desktop shortcut off
    await page.getByTestId(`page-app-card-desktop-menu-trigger-${TRACKER_APP_ID}`).click();
    await page.getByTestId(`page-app-card-desktop-shortcut-${TRACKER_APP_ID}`).click();
    await expect.poll(() => setDesktopShortcut.mock.calls.length).toBe(1);
    expect(setDesktopShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ appId: TRACKER_APP_ID, enabled: false }),
    );
  });

  it("omits duplicate title in embed mode footer when top heading is detected", async () => {
    const readerHtml = buildNovelReaderFixtureHtml(window.location.origin);
    const blobUrl = URL.createObjectURL(
      new Blob([readerHtml], { type: "text/html;charset=utf-8" }),
    );
    createdUrls.push(blobUrl);

    const app = makeApp();
    vi.spyOn(pageAppsClient, "openFrame").mockResolvedValue({
      app,
      revision: 3,
      capabilities: {},
      frameUrl: blobUrl,
      frameOrigin: window.location.origin,
      ownOrigin: true,
      offlineReady: true,
      expiresAt: "2026-11-28T00:00:00.000Z",
      viewer: { id: "owner", name: "我", level: "owner", isOwner: true },
      consent: {},
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <TooltipProvider>
          <SidebarProvider open>
            <div className="p-4">
              <AppPageFrame appPageId={READER_APP_ID} mode="embed" height={420} />
            </div>
          </SidebarProvider>
        </TooltipProvider>
      </MossLocaleScope>,
    );

    await expect
      .poll(() => screen.container.querySelector('[data-has-top-heading="true"]'))
      .toBeTruthy();
    const embedFooter = screen.container.querySelector('[data-has-top-heading="true"]')!;
    expect(embedFooter.textContent).not.toContain("静读 · 小说阅读器");
  });
});
