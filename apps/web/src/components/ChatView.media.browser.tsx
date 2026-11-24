// FILE: ChatView.media.browser.tsx
// Purpose: Full-app ChatView browser tests for images and the 画布 in a chat: generated images, the lightbox, Canvas, image-generation limits.
//          The shared fixture is src/test/chatViewBrowserHarness.tsx; every ChatView.*.browser.tsx
//          keeps the one suite name, so case names (and the CI partitions) are unchanged.

import { translateMoss } from "../localization";
import {
  EventId,
  MessageId,
  type OrchestrationReadModel,
  TurnId,
  WS_METHODS,
} from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRightDockStore } from "../rightDockStore";
import { closeSettings, settingsDialogStore } from "../settingsDialogStore";
import { useStore } from "../store";
import { sendEffectRpcChunk } from "../test/effectRpcWebSocketMock";
import { makeDomainEvent } from "../storeTestFixtures";
import { resetCanvasAgentOpsForTests } from "./chat/canvasAgentOps";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_VIEWPORT,
  GENERATED_IMAGE_PREVIEW_B21_RECEIPT_DIR,
  GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR,
  IMAGE_GENERATION_LIMIT_RECEIPT_DIR,
  type MountedChatView,
  NOW_ISO,
  OTHER_THREAD_ID,
  THREAD_ID,
  addThreadToSnapshot,
  configureMossManagedDefaults,
  createGeneratedImagePreviewTouchEvent,
  createSnapshotForTargetUser,
  createSnapshotWithGeneratedImagePreview,
  domainEventStream,
  expectGeneratedImagePreviewControlRectsInBounds,
  expectGeneratedImagePreviewReceipt,
  fixture,
  installImageLimitDiagnostics,
  isoAt,
  localImageDownloadRequests,
  makeProviderUsageSnapshot,
  motionCommands,
  mountChatView,
  nextFrame,
  openGeneratedImageEditorFromGallery,
  openGeneratedImageFocusPane,
  readImageLimitThemeReceipt,
  setDomainEventStream,
  setImageLimitFixtureTheme,
  shownGeneratedImagePreviewPane,
  waitForElement,
  waitForGeneratedImagePreviewControlsReady,
  waitForGeneratedImagePreviewDockSettled,
  waitForLayout,
  withAccountRateLimitActivity,
  withImageGenerationCompletionActivity,
  withImageGenerationLimitActivity,
  withMissingCanvasBundle,
  wsRequests,
  installChatViewFixture,
} from "../test/chatViewBrowserHarness";

// Off for every test but the title-bar one, which needs the desktop app's own title-bar
// chrome: the back/forward arrows, the cluster's reserved box and, on Windows, the band over
// 图像 and 资料空间. All three ask `~/lib/desktopTitleBar`, switched on for that test only;
// everything else stays the web build.
vi.mock("~/lib/desktopTitleBar", async (importOriginal) => {
  const { desktopTitleBar } = await import("../test/chatViewBrowserMocks");
  const actual = await importOriginal<typeof import("~/lib/desktopTitleBar")>();
  return {
    desktopTitleBarControlsShown: () => desktopTitleBar.on || actual.desktopTitleBarControlsShown(),
    desktopTitleBarBandShown: () => desktopTitleBar.on || actual.desktopTitleBarBandShown(),
  };
});

vi.mock("../lib/realtimeVoiceWebRtc", async () => {
  const { realtimeVoiceChatHarness } = await import("../test/chatViewBrowserMocks");
  return {
    RealtimeVoiceWebRtcClient: class FakeRealtimeVoiceWebRtcClient {
      snapshot = {
        webRtcConnected: true,
        dataSessionInitialized: true,
        inputMuted: false,
        outputMuted: false,
      };

      constructor() {
        realtimeVoiceChatHarness.webRtcConstructed();
      }

      async prepare() {
        return { offerSdp: "moss-chat-shell-browser-offer", inputDeviceId: null };
      }

      async applyAnswer() {}

      setInputMuted(inputMuted: boolean) {
        this.snapshot = { ...this.snapshot, inputMuted };
      }

      setOutputMuted(outputMuted: boolean) {
        this.snapshot = { ...this.snapshot, outputMuted };
      }

      async replaceMicrophone() {
        return null;
      }

      async dispose() {
        realtimeVoiceChatHarness.webRtcDisposed();
      }
    },
  };
});

vi.mock("../lib/realtimeVoiceWebSocket", async () => {
  const { realtimeVoiceChatHarness } = await import("../test/chatViewBrowserMocks");
  return {
    RealtimeVoiceWebSocketClient: class FakeRealtimeVoiceWebSocketClient {
      snapshot = {
        webRtcConnected: false,
        dataSessionInitialized: false,
        inputMuted: false,
        outputMuted: false,
      };

      constructor() {
        realtimeVoiceChatHarness.webSocketConstructed();
      }

      async prepare() {
        return { inputDeviceId: null };
      }

      async connect() {}

      setInputMuted(inputMuted: boolean) {
        this.snapshot = { ...this.snapshot, inputMuted };
      }

      setOutputMuted(outputMuted: boolean) {
        this.snapshot = { ...this.snapshot, outputMuted };
      }

      async replaceMicrophone() {
        return null;
      }

      async dispose() {
        realtimeVoiceChatHarness.webSocketDisposed();
      }
    },
  };
});

describe("ChatView transcript geometry (full app)", () => {
  installChatViewFixture();

  it.each([
    { theme: "light", locale: "en" },
    { theme: "dark", locale: "zh-CN" },
  ] as const)(
    "opens generated transcript images in a full-window $theme $locale lightbox and keeps Canvas explicit",
    async ({ theme, locale }) => {
      useRightDockStore.setState({ dockStateByThreadId: {} });
      setImageLimitFixtureTheme(theme);
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
      const dialogName = translateMoss(locale, "chat.imageLightbox.title");
      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: theme === "light" ? 1200 : 390, height: 760 },
        snapshot: createSnapshotWithGeneratedImagePreview(),
      });
      try {
        const thumbnail = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-testid="generated-image-thumbnail"][data-image-id="generated-preview-two"]',
            ),
          "Unable to find the second generated thumbnail.",
        );
        thumbnail.click();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull();
        const preview = await vi.waitFor(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="generated-image-preview"]',
          );
          expect(button?.dataset.imageId).toBe("generated-preview-two");
          return button!;
        });
        preview.focus();
        const image = preview.querySelector("img");
        expect(image).not.toBeNull();
        image!.click();
        await expect.element(page.getByRole("dialog", { name: dialogName })).toBeVisible();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        await vi.waitFor(() => {
          expect(dialog.getBoundingClientRect().width).toBe(window.innerWidth);
          expect(dialog.getBoundingClientRect().height).toBe(window.innerHeight);
        });
        await expect
          .element(page.getByRole("dialog").getByRole("img", { name: "generated-preview-two.png" }))
          .toBeVisible();
        expect(document.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull();
        expect(
          useRightDockStore
            .getState()
            .dockStateByThreadId[THREAD_ID]?.panes.some((pane) => pane.kind === "canvas") ?? false,
        ).toBe(false);
        await userEvent.keyboard("{ArrowLeft}");
        await expect
          .element(page.getByRole("dialog").getByRole("img", { name: "generated-preview-one.png" }))
          .toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect
          .element(page.getByRole("dialog", { name: dialogName }))
          .not.toBeInTheDocument();
        // Role queries can exclude a hidden popup before its exit animation
        // finishes. Wait for the actual lightbox node to unmount as well.
        await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
        expect(document.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull();
        const canvasButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-testid="generated-image-open-canvas"]',
            ),
          "Unable to find the explicit gallery Canvas chip.",
        );
        expect(canvasButton.textContent).toContain(
          translateMoss(locale, "chat.generatedImage.canvas"),
        );
        canvasButton.click();
        await vi.waitFor(() => {
          const pane = document.querySelector<HTMLElement>(
            '[data-testid="generated-image-preview-pane"]',
          );
          expect(pane?.dataset.generatedImagePreviewView).toBe("playground");
          const canvasPane = useRightDockStore
            .getState()
            .dockStateByThreadId[THREAD_ID]?.panes.find((candidate) => candidate.kind === "canvas");
          expect(canvasPane?.imagePreview?.activeImageId).toBe(
            "turn-generated-image-preview:generated-preview-two",
          );
          // Mobile Canvas/sidebar sheets also use role="dialog".
          expect(document.querySelector('[data-testid="image-lightbox-viewport"]')).toBeNull();
        });
      } finally {
        await mounted.cleanup();
        setImageLimitFixtureTheme("light");
      }
    },
  );

  it("shows the conversation's 画布 beside the chat within seconds after an agent opens it", async () => {
    useRightDockStore.setState({ dockStateByThreadId: {} });
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    setDomainEventStream(null);
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_200, height: 760 },
      snapshot: createSnapshotWithGeneratedImagePreview(),
    });
    try {
      await withMissingCanvasBundle(async () => {
        await vi.waitFor(() => expect(domainEventStream).not.toBeNull());
        // What the server appends when the agent calls moss_canvas_open.
        sendEffectRpcChunk(
          domainEventStream!.client,
          domainEventStream!.requestId,
          makeDomainEvent(
            "thread.activity-appended",
            {
              threadId: THREAD_ID,
              activity: {
                id: EventId.makeUnsafe("agent:canvas-open-browser-case:canvas-open"),
                createdAt: isoAt(10_000),
                kind: "canvas.open.requested",
                summary: "Open conversation Canvas",
                tone: "info",
                turnId: null,
                payload: { source: "moss-mcp-canvas", threadId: THREAD_ID },
              },
            },
            { sequence: 10_000 },
          ),
        );
        const sentAt = performance.now();
        await vi.waitFor(
          () => {
            const panel = document.querySelector<HTMLElement>('[data-testid="right-dock-panel"]');
            const workspace = panel?.querySelector<HTMLElement>(
              "[data-conversation-image-workspace]",
            );
            const chat = document.querySelector<HTMLElement>("[data-right-dock-main-content]");
            expect(workspace).not.toBeNull();
            expect(workspace!.closest("[inert]")).toBeNull();
            expect(workspace!.getBoundingClientRect().width).toBeGreaterThan(300);
            expect(workspace!.getBoundingClientRect().height).toBeGreaterThan(400);
            // The chat stays on screen beside it.
            expect(chat?.getAttribute("data-app-shell-right-panel-full-width")).toBe("false");
            expect(chat!.getBoundingClientRect().width).toBeGreaterThan(300);
          },
          { timeout: 3_000, interval: 16 },
        );
        expect(performance.now() - sentAt).toBeLessThan(3_000);
        expect(
          useRightDockStore
            .getState()
            .dockStateByThreadId[THREAD_ID]?.panes.filter((pane) => pane.kind === "canvas"),
        ).toHaveLength(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens 画布 for an agent's first edit of a turn, keeps it closed once the person closes it, and opens it next turn", async () => {
    useRightDockStore.setState({ dockStateByThreadId: {} });
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    setDomainEventStream(null);
    resetCanvasAgentOpsForTests();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_200, height: 760 },
      snapshot: createSnapshotWithGeneratedImagePreview(),
    });
    let sequence = 20_000;
    const agentEdit = (requestId: string, turnId: string) =>
      sendEffectRpcChunk(
        domainEventStream!.client,
        domainEventStream!.requestId,
        makeDomainEvent(
          "thread.activity-appended",
          {
            threadId: THREAD_ID,
            activity: {
              id: EventId.makeUnsafe(`agent:${requestId}:canvas.ops.requested`),
              createdAt: isoAt(sequence),
              kind: "canvas.ops.requested",
              summary: "Edit conversation Canvas",
              tone: "info",
              turnId: TurnId.makeUnsafe(turnId),
              payload: {
                source: "moss-mcp-canvas",
                threadId: THREAD_ID,
                requestId,
                ops: [{ op: "addNote", text: "代理写入" }],
              },
            },
          },
          { sequence: sequence++ },
        ),
      );
    const canvasShown = () => {
      const workspace = document.querySelector<HTMLElement>(
        '[data-testid="right-dock-panel"] [data-conversation-image-workspace]',
      );
      return Boolean(
        workspace && !workspace.closest("[inert]") && workspace.getBoundingClientRect().width > 300,
      );
    };
    try {
      await withMissingCanvasBundle(async () => {
        await vi.waitFor(() => expect(domainEventStream).not.toBeNull());
        // The agent's first edit of the turn opens the 画布 beside the chat.
        agentEdit("canvas-ops:turn-a-1", "turn-agent-a");
        await vi.waitFor(() => expect(canvasShown()).toBe(true), { timeout: 3_000 });
        // The person closes it.
        await page.getByRole("button", { name: "Close Canvas", exact: true }).click();
        await vi.waitFor(() => expect(canvasShown()).toBe(false));
        // A later edit of the same turn does not open it again.
        agentEdit("canvas-ops:turn-a-2", "turn-agent-a");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(canvasShown()).toBe(false);
        expect(
          useRightDockStore
            .getState()
            .dockStateByThreadId[THREAD_ID]?.panes.filter((pane) => pane.kind === "canvas") ?? [],
        ).toHaveLength(0);
        // The next turn's first edit may open it again.
        agentEdit("canvas-ops:turn-b-1", "turn-agent-b");
        await vi.waitFor(() => expect(canvasShown()).toBe(true), { timeout: 3_000 });
        // Already open when a turn starts (left open from turn B): its first edit goes there; once
        // the person closes it, a later edit of that turn does not reopen it.
        agentEdit("canvas-ops:turn-c-1", "turn-agent-c");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(canvasShown()).toBe(true);
        await page.getByRole("button", { name: "Close Canvas", exact: true }).click();
        await vi.waitFor(() => expect(canvasShown()).toBe(false));
        agentEdit("canvas-ops:turn-c-2", "turn-agent-c");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(canvasShown()).toBe(false);
        // Opened by the person (the launcher's action) before a turn: the same.
        useRightDockStore.getState().openPane(THREAD_ID, { kind: "canvas" });
        await vi.waitFor(() => expect(canvasShown()).toBe(true), { timeout: 3_000 });
        agentEdit("canvas-ops:turn-d-1", "turn-agent-d");
        await new Promise((resolve) => setTimeout(resolve, 300));
        await page.getByRole("button", { name: "Close Canvas", exact: true }).click();
        await vi.waitFor(() => expect(canvasShown()).toBe(false));
        agentEdit("canvas-ops:turn-d-2", "turn-agent-d");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(canvasShown()).toBe(false);
        expect(
          useRightDockStore
            .getState()
            .dockStateByThreadId[THREAD_ID]?.panes.filter((pane) => pane.kind === "canvas") ?? [],
        ).toHaveLength(0);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("covers generated image preview B2.1 controls and full-width rail", async () => {
    useRightDockStore.setState({ dockStateByThreadId: {} });
    const coachmarkKey = "has-dismissed-image-canvas-view-coachmark-v1";
    const desktopViewport = { ...DEFAULT_VIEWPORT, width: 1_200, height: 760 };
    const narrowViewport = {
      ...DEFAULT_VIEWPORT,
      name: "generated-image-preview-b21-390",
      width: 390,
      height: 760,
    };
    const snapshot = createSnapshotWithGeneratedImagePreview({ imageCount: 8 });
    setImageLimitFixtureTheme("light");
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    // Coachmark behavior has its own B2.2a coverage. Keep it from covering the
    // zoom/download controls when the B2.1 pane becomes regular-width or mobile.
    localStorage.setItem(coachmarkKey, "1");
    let mounted: MountedChatView | null = await mountChatView({
      viewport: desktopViewport,
      snapshot,
    });

    try {
      const generatedGallery = await vi.waitFor(
        () => {
          const galleries = document.querySelectorAll<HTMLElement>(
            '[data-testid="generated-image-gallery"]',
          );
          expect(galleries).toHaveLength(1);
          expect(
            galleries[0]?.querySelectorAll('[data-testid="generated-image-preview"]'),
          ).toHaveLength(1);
          expect(
            galleries[0]?.querySelectorAll('[data-testid="generated-image-thumbnail"]'),
          ).toHaveLength(8);
          return galleries[0]!;
        },
        { timeout: 8_000, interval: 16 },
      );
      const imageIds = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(
        (ordinal) => `generated-preview-${ordinal}`,
      );
      const thumbnails = [
        ...generatedGallery.querySelectorAll<HTMLButtonElement>(
          '[data-testid="generated-image-thumbnail"]',
        ),
      ];
      expect(thumbnails.map((thumbnail) => thumbnail.getAttribute("data-image-id"))).toEqual(
        imageIds,
      );
      for (const [index, thumbnail] of thumbnails.entries()) {
        expect(new URL(thumbnail.querySelector("img")!.src).searchParams.get("path")).toBe(
          `/tmp/${imageIds[index]}.png`,
        );
        thumbnail.click();
        await vi.waitFor(() => {
          expect(generatedGallery.getAttribute("data-selected-image-id")).toBe(imageIds[index]);
          const preview = generatedGallery.querySelector('[data-testid="generated-image-preview"]');
          expect(preview?.getAttribute("data-image-id")).toBe(imageIds[index]);
          expect(new URL(preview!.querySelector("img")!.src).searchParams.get("path")).toBe(
            `/tmp/${imageIds[index]}.png`,
          );
          expect(thumbnail.getAttribute("aria-pressed")).toBe("true");
          expect(
            generatedGallery.querySelectorAll(
              '[data-testid="generated-image-thumbnail"][aria-pressed="true"]',
            ),
          ).toHaveLength(1);
        });
      }
      thumbnails[0]!.click();
      await vi.waitFor(() => {
        const preview = generatedGallery.querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview"]',
        );
        expect(preview?.getAttribute("data-image-id")).toBe(imageIds[0]);
        expect(thumbnails[0]?.getAttribute("aria-pressed")).toBe("true");
        return preview!;
      });
      await openGeneratedImageEditorFromGallery();

      const previewPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the B2.1 generated image preview pane.",
      );
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-status")).toBe("loaded");
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("fit");
        expect(
          document.querySelector('[data-testid="generated-image-preview-zoom-trigger"]'),
        ).not.toBeNull();
      });
      // The 画布 chip opens beside the chat; only the expand control widens it.
      await waitForGeneratedImagePreviewDockSettled(false);
      expect(previewPane.getAttribute("data-image-id")).toBe(
        "turn-generated-image-preview:generated-preview-one",
      );
      const routeMainContent = document.querySelector<HTMLElement>(
        "[data-right-dock-main-content]",
      );
      expect(routeMainContent).not.toBeNull();
      const routeRegularContract = (() => {
        const style = getComputedStyle(routeMainContent!);
        return {
          flex: style.flex,
          minWidth: style.minWidth,
          overflow: style.overflow,
          width: style.width,
          inlineFlex: routeMainContent!.style.getPropertyValue("flex"),
          inlineMinWidth: routeMainContent!.style.getPropertyValue("min-width"),
          inlineOverflow: routeMainContent!.style.getPropertyValue("overflow"),
          inlineWidth: routeMainContent!.style.getPropertyValue("width"),
        };
      })();

      const regularDownload = document.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-download"]',
      );
      expect(regularDownload?.getAttribute("data-download-url")).toContain("download=1");
      expect(regularDownload?.getAttribute("data-download-name")).toBe("generated-preview-one.png");
      const pathnameBeforeDownload = mounted.router.state.location.pathname;
      localImageDownloadRequests.length = 0;
      regularDownload?.click();
      await vi.waitFor(() => expect(localImageDownloadRequests).toHaveLength(1));
      expect(localImageDownloadRequests[0]).toContain("download=1");
      expect(mounted.router.state.location.pathname).toBe(pathnameBeforeDownload);
      expect(document.body.textContent).not.toContain("Could not download image");
      const regularFitScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B21_RECEIPT_DIR}/light-regular-fit.png`,
      });
      expect(regularFitScreenshot).toContain("light-regular-fit.png");

      const regularWidthToggle = document.querySelector<HTMLButtonElement>(
        '[data-testid="right-dock-width-toggle"]',
      );
      expect(regularWidthToggle).not.toBeNull();
      regularWidthToggle?.click();
      await waitForGeneratedImagePreviewDockSettled(true);
      expect(document.querySelector('[data-testid="generated-image-preview-rail"]')).not.toBeNull();
      if (
        document
          .querySelector('[data-testid="generated-image-preview-zoom-trigger"]')
          ?.getAttribute("aria-expanded") !== "true"
      ) {
        await page.getByTestId("generated-image-preview-zoom-trigger").click();
      }
      const zoomMenu = await waitForElement(
        () =>
          document.querySelector<HTMLElement>('[data-testid="generated-image-preview-zoom-menu"]'),
        "Unable to find the B2.1 zoom menu.",
      );
      for (const zoomPercent of [25, 50, 100, 150, 200]) {
        expect(
          zoomMenu.querySelector(
            `[data-testid="generated-image-preview-zoom-option-${zoomPercent}"]`,
          ),
        ).not.toBeNull();
      }
      expect(zoomMenu.textContent).toContain("Zoom to fit");
      const lightMenuScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B21_RECEIPT_DIR}/light-full-width-menu-open.png`,
      });
      expect(lightMenuScreenshot).toContain("light-full-width-menu-open.png");

      await page.getByTestId("generated-image-preview-zoom-option-150").click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("manual");
        expect(previewPane.getAttribute("data-image-zoom-percent")).toBe("150");
      });

      const firstRailTile = document.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-rail-tile-turn-generated-image-preview:generated-preview-one"]',
      );
      const secondRailTile = document.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-rail-tile-turn-generated-image-preview:generated-preview-two"]',
      );
      expect(firstRailTile).not.toBeNull();
      expect(secondRailTile).not.toBeNull();
      secondRailTile?.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("fit");
      });
      firstRailTile?.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        );
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("fit");
      });
      await waitForGeneratedImagePreviewControlsReady();

      await page.getByTestId("generated-image-preview-zoom-trigger").click();
      await page.getByTestId("generated-image-preview-zoom-option-150").click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("manual");
        expect(previewPane.getAttribute("data-image-zoom-percent")).toBe("150");
      });
      if (
        document
          .querySelector('[data-testid="generated-image-preview-zoom-trigger"]')
          ?.getAttribute("aria-expanded") !== "true"
      ) {
        await page.getByTestId("generated-image-preview-zoom-trigger").click();
      }
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="generated-image-preview-zoom-fit"]'),
        ).not.toBeNull();
      });
      document
        .querySelector<HTMLElement>('[data-testid="generated-image-preview-zoom-fit"]')
        ?.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("fit");
        expect(
          document.querySelector<HTMLElement>('[data-testid="generated-image-preview-scroll"]')
            ?.scrollLeft,
        ).toBe(0);
      });

      document.querySelector<HTMLButtonElement>('[data-testid="right-dock-width-toggle"]')?.click();
      await waitForGeneratedImagePreviewDockSettled(false);
      expect(routeMainContent?.getAttribute("data-app-shell-right-panel-full-width")).toBe("false");
      const routeRestoredStyle = getComputedStyle(routeMainContent!);
      expect({
        flex: routeRestoredStyle.flex,
        minWidth: routeRestoredStyle.minWidth,
        overflow: routeRestoredStyle.overflow,
        width: routeRestoredStyle.width,
        inlineFlex: routeMainContent!.style.getPropertyValue("flex"),
        inlineMinWidth: routeMainContent!.style.getPropertyValue("min-width"),
        inlineOverflow: routeMainContent!.style.getPropertyValue("overflow"),
        inlineWidth: routeMainContent!.style.getPropertyValue("width"),
      }).toEqual(routeRegularContract);
      expect(document.querySelector('[data-testid="generated-image-preview-rail"]')).toBeNull();
      const scroll = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-scroll"]'),
        "Unable to find the B2.1 image scroll surface.",
      );
      const wheelRect = scroll.getBoundingClientRect();
      const zoomWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: wheelRect.left + wheelRect.width * 0.75,
        clientY: wheelRect.top + wheelRect.height * 0.5,
        ctrlKey: true,
        deltaY: -10_000,
      });
      scroll.dispatchEvent(zoomWheel);
      expect(zoomWheel.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("manual");
        expect(previewPane.getAttribute("data-image-zoom-percent")).toBe("400");
        expect(previewPane.getAttribute("data-image-overflow")).toBe("true");
        expect(scroll.className).toContain("overflow-auto");
      });
      const image = await waitForElement(
        () => previewPane.querySelector<HTMLImageElement>("img:not([alt=''])"),
        "Unable to find the B2.1 primary image.",
      );
      const imageRect = image.getBoundingClientRect();
      const initialScrollLeft = scroll.scrollLeft;
      image.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: imageRect.left + imageRect.width / 2,
          clientY: imageRect.top + imageRect.height / 2,
          pointerId: 21,
          pointerType: "mouse",
        }),
      );
      image.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: imageRect.left + imageRect.width / 2 - 40,
          clientY: imageRect.top + imageRect.height / 2,
          pointerId: 21,
          pointerType: "mouse",
        }),
      );
      image.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          clientX: imageRect.left + imageRect.width / 2 - 40,
          clientY: imageRect.top + imageRect.height / 2,
          pointerId: 21,
          pointerType: "mouse",
        }),
      );
      expect(scroll.scrollLeft).not.toBe(initialScrollLeft);

      const focalImage = await waitForElement(
        () => previewPane.querySelector<HTMLImageElement>("img:not([alt=''])"),
        "Unable to find the B2.1 focal-zoom image.",
      );
      const focalScrollRect = scroll.getBoundingClientRect();
      const focalImageRectBefore = focalImage.getBoundingClientRect();
      const focalPoint = {
        clientX: Math.min(
          focalScrollRect.right - 24,
          Math.max(
            focalScrollRect.left + 24,
            focalImageRectBefore.left + focalImageRectBefore.width * 0.72,
          ),
        ),
        clientY: Math.min(
          focalScrollRect.bottom - 24,
          Math.max(
            focalScrollRect.top + 24,
            focalImageRectBefore.top + focalImageRectBefore.height * 0.37,
          ),
        ),
      };
      const normalizedBefore = {
        x: (focalPoint.clientX - focalImageRectBefore.left) / focalImageRectBefore.width,
        y: (focalPoint.clientY - focalImageRectBefore.top) / focalImageRectBefore.height,
      };
      const focalWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: focalPoint.clientX,
        clientY: focalPoint.clientY,
        ctrlKey: true,
        deltaY: 20,
      });
      scroll.dispatchEvent(focalWheel);
      expect(focalWheel.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("manual");
        expect(Number(previewPane.getAttribute("data-image-zoom-percent"))).toBeLessThan(400);
      });
      const focalImageRectAfter = focalImage.getBoundingClientRect();
      const normalizedAfter = {
        x: (focalPoint.clientX - focalImageRectAfter.left) / focalImageRectAfter.width,
        y: (focalPoint.clientY - focalImageRectAfter.top) / focalImageRectAfter.height,
      };
      expect(Math.abs(normalizedAfter.x - normalizedBefore.x)).toBeLessThan(0.04);
      expect(Math.abs(normalizedAfter.y - normalizedBefore.y)).toBeLessThan(0.04);
    } finally {
      await mounted?.cleanup();
      mounted = null;
      // Reset through the store's event path too: its snapshot is cached
      // module-wide and would otherwise leak "dark" into the next mount.
      setImageLimitFixtureTheme("light");
      localStorage.removeItem("moss:theme");
      localStorage.removeItem("moss:activity-onboarding:v1");
      localStorage.removeItem(coachmarkKey);
    }

    // Unmounting leaves the durable dock open in the store. Start the dark run
    // with the transcript visible so its Canvas chip can receive a real click.
    useRightDockStore.setState({ dockStateByThreadId: {} });
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    localStorage.setItem(coachmarkKey, "1");
    mounted = await mountChatView({ viewport: desktopViewport, snapshot });
    setImageLimitFixtureTheme("dark");
    try {
      const generatedPreview = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="generated-image-preview"]'),
        "Unable to find the dark B2.1 generated image preview thumbnail.",
      );
      await openGeneratedImageFocusPane(generatedPreview);
      const previewPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the dark B2.1 generated image preview pane.",
      );
      await vi.waitFor(() => expect(previewPane.getAttribute("data-image-status")).toBe("loaded"));
      await waitForGeneratedImagePreviewDockSettled(false);
      document.querySelector<HTMLButtonElement>('[data-testid="right-dock-width-toggle"]')?.click();
      await waitForGeneratedImagePreviewDockSettled(true);
      const rail = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-rail"]'),
        "Unable to find the dark B2.1 image rail.",
      );
      const tiles = [...rail.querySelectorAll<HTMLButtonElement>("button")];
      expect(tiles).toHaveLength(8);
      const previewStyle = getComputedStyle(previewPane);
      expect(previewStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      const zoomTrigger = document.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-zoom-trigger"]',
      );
      expect(zoomTrigger).not.toBeNull();
      expect(getComputedStyle(zoomTrigger!).color).not.toBe(previewStyle.backgroundColor);
      const activeTileStyle = getComputedStyle(tiles[0]!);
      const inactiveTileStyle = getComputedStyle(tiles[1]!);
      expect(activeTileStyle.opacity).toBe("1");
      expect(inactiveTileStyle.opacity).toBe("0.34");
      expect(activeTileStyle.transform).not.toBe("none");
      expect(inactiveTileStyle.transform).not.toBe("none");
      expect(activeTileStyle.transitionDuration).toBe("0.12s");
      await motionCommands.emulateReducedMotion("reduce");
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const reducedTileStyle = getComputedStyle(tiles[0]!);
      expect(
        reducedTileStyle.transitionProperty === "none" ||
          reducedTileStyle.transitionDuration === "0s",
      ).toBe(true);
      await motionCommands.emulateReducedMotion("no-preference");
      tiles[1]?.click();
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        ),
      );
      await waitForGeneratedImagePreviewControlsReady();
      expectGeneratedImagePreviewControlRectsInBounds();
      const darkRailScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B21_RECEIPT_DIR}/dark-full-width-rail-active.png`,
      });
      expect(darkRailScreenshot).toContain("dark-full-width-rail-active.png");

      const pinchScroll = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-scroll"]'),
        "Unable to find the dark B2.1 pinch scroll surface.",
      );
      await page.getByTestId("generated-image-preview-zoom-trigger").click();
      await page.getByTestId("generated-image-preview-zoom-option-100").click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("manual");
        expect(previewPane.getAttribute("data-image-zoom-percent")).toBe("100");
      });
      const pinchStart = createGeneratedImagePreviewTouchEvent("touchstart", pinchScroll, [
        { identifier: 1, clientX: 200, clientY: 260 },
        { identifier: 2, clientX: 300, clientY: 260 },
      ]);
      const pinchMove = createGeneratedImagePreviewTouchEvent("touchmove", pinchScroll, [
        { identifier: 1, clientX: 175, clientY: 260 },
        { identifier: 2, clientX: 325, clientY: 260 },
      ]);
      if (pinchStart && pinchMove) {
        pinchScroll.dispatchEvent(pinchStart);
        pinchScroll.dispatchEvent(pinchMove);
        expect(pinchMove.defaultPrevented).toBe(true);
        await vi.waitFor(() =>
          expect(previewPane.getAttribute("data-image-zoom-percent")).toBe("150"),
        );
        const pinchEnd = createGeneratedImagePreviewTouchEvent("touchend", pinchScroll, []);
        expect(pinchEnd).not.toBeNull();
        pinchEnd && pinchScroll.dispatchEvent(pinchEnd);
        const trailingClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        const pinchImage = pinchScroll.querySelector<HTMLImageElement>("img:not([alt=''])");
        expect(pinchImage).not.toBeNull();
        pinchImage?.dispatchEvent(trailingClick);
        expect(trailingClick.defaultPrevented).toBe(true);
      } else {
        console.warn(
          "B2.1 residual: Chromium TouchEvent construction unavailable; pinch is covered by pure logic tests.",
        );
      }

      const dispatchRailArrow = async (
        fromIndex: number,
        key: "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp",
        toIndex: number,
        expectedImageId: string,
      ) => {
        tiles[fromIndex]?.focus();
        tiles[fromIndex]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
        await vi.waitFor(() => {
          expect(previewPane.getAttribute("data-image-id")).toBe(expectedImageId);
          expect(document.activeElement).toBe(tiles[toIndex]);
        });
      };
      await dispatchRailArrow(
        1,
        "ArrowRight",
        2,
        "turn-generated-image-preview:generated-preview-three",
      );
      await dispatchRailArrow(
        2,
        "ArrowDown",
        3,
        "turn-generated-image-preview:generated-preview-four",
      );
      await dispatchRailArrow(
        3,
        "ArrowLeft",
        2,
        "turn-generated-image-preview:generated-preview-three",
      );
      await dispatchRailArrow(
        2,
        "ArrowUp",
        1,
        "turn-generated-image-preview:generated-preview-two",
      );
      tiles[0]?.click();
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        ),
      );
      tiles[0]?.focus();
      tiles[0]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        );
        expect(document.activeElement).toBe(tiles[0]);
      });
      tiles.at(-1)?.click();
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-eight",
        ),
      );
      tiles.at(-1)?.focus();
      tiles
        .at(-1)
        ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-eight",
        );
        expect(document.activeElement).toBe(tiles.at(-1));
      });
      tiles[1]?.click();
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        ),
      );
      rail.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -60 }));
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        ),
      );
      rail.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 60 }));
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        ),
      );

      rail.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 10_000 }),
      );
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-eight",
        ),
      );
      const lastTile = tiles.at(-1);
      expect(lastTile).not.toBeUndefined();
      const lastTileRect = lastTile!.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      expect(lastTileRect.bottom).toBeGreaterThan(railRect.top);
      expect(lastTileRect.top).toBeLessThan(railRect.bottom);
      expect(
        Math.abs(lastTileRect.top + lastTileRect.height / 2 - (railRect.top + railRect.height / 2)),
      ).toBeLessThan(40);
      rail.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -10_000 }),
      );
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        ),
      );
      const firstTileRect = tiles[0]!.getBoundingClientRect();
      expect(firstTileRect.bottom).toBeGreaterThan(railRect.top);
      expect(firstTileRect.top).toBeLessThan(railRect.bottom);
      await waitForGeneratedImagePreviewControlsReady();
      expect(previewPane.getAttribute("data-image-status")).toBe("loaded");
      const ctrlRailWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -20,
        clientX: railRect.left + railRect.width / 2,
        clientY: railRect.top + railRect.height / 2,
      });
      rail.dispatchEvent(ctrlRailWheel);
      expect(ctrlRailWheel.defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-image-zoom-mode")).toBe("manual"),
      );

      document.querySelector<HTMLButtonElement>('[data-testid="right-dock-width-toggle"]')?.click();
      await waitForGeneratedImagePreviewDockSettled(false);
      // Close the desktop pane before resizing so the mobile entry exercises
      // the gallery chip too, rather than relying on a detached desktop node.
      await page
        .getByTestId("right-dock-panel")
        .getByTestId("chat-header-right-dock-toggle")
        .click();
      await vi.waitFor(() => {
        expect(shownGeneratedImagePreviewPane()).toBeNull();
      });
      await mounted.setViewport(narrowViewport);
      await openGeneratedImageEditorFromGallery();
      const mobilePreviewPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the mobile B2.1 generated image preview pane.",
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="generated-image-preview-rail"]')).toBeNull();
        expect(mobilePreviewPane.getAttribute("data-generated-image-preview-full-width")).toBe(
          "false",
        );
      });
      expectGeneratedImagePreviewReceipt({ mobile: true });
      expect(mobilePreviewPane).not.toBeNull();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="generated-image-preview-zoom-trigger"]'),
        ).not.toBeNull();
        expect(
          document.querySelector('[data-testid="generated-image-preview-download"]'),
        ).not.toBeNull();
      });
      const mobilePaneRect = mobilePreviewPane!.getBoundingClientRect();
      const mobileZoomRect = document
        .querySelector<HTMLElement>('[data-testid="generated-image-preview-zoom-trigger"]')
        ?.getBoundingClientRect();
      const mobileDownloadRect = document
        .querySelector<HTMLElement>('[data-testid="generated-image-preview-download"]')
        ?.getBoundingClientRect();
      expect(mobileZoomRect?.right).toBeLessThanOrEqual(mobilePaneRect.right + 1);
      expect(mobileDownloadRect?.right).toBeLessThanOrEqual(mobilePaneRect.right + 1);
      const darkMobileScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B21_RECEIPT_DIR}/dark-390-no-overlap.png`,
      });
      expect(darkMobileScreenshot).toContain("dark-390-no-overlap.png");
    } finally {
      await motionCommands.emulateReducedMotion("no-preference");
      await mounted?.cleanup();
      // Reset through the store's event path too: its snapshot is cached
      // module-wide and would otherwise leak "dark" into the next mount.
      setImageLimitFixtureTheme("light");
      localStorage.removeItem("moss:theme");
      localStorage.removeItem("moss:activity-onboarding:v1");
      localStorage.removeItem(coachmarkKey);
    }
  });

  it("covers B2.2a reduced-motion coachmark and transition behavior", async () => {
    const desktopViewport = { ...DEFAULT_VIEWPORT, width: 1_200, height: 760 };
    const snapshot = createSnapshotWithGeneratedImagePreview({ imageCount: 4 });
    const coachmarkKey = "has-dismissed-image-canvas-view-coachmark-v1";
    setImageLimitFixtureTheme("light");
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    localStorage.removeItem(coachmarkKey);
    await motionCommands.emulateReducedMotion("reduce");
    let mounted: MountedChatView | null = await mountChatView({
      viewport: desktopViewport,
      snapshot,
    });
    const animateSpy =
      typeof Element.prototype.animate === "function"
        ? vi.spyOn(Element.prototype, "animate")
        : null;
    try {
      const generatedPreview = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="generated-image-preview"]'),
        "Unable to find the reduced-motion generated image preview thumbnail.",
      );
      await openGeneratedImageFocusPane(generatedPreview);
      const previewPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the reduced-motion preview pane.",
      );
      await vi.waitFor(() => expect(previewPane.getAttribute("data-image-status")).toBe("loaded"));
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid="generated-image-preview-canvas-coachmark"]'),
        ).not.toBeNull(),
      );
      const canvasToggle = previewPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-playground"]',
      );
      canvasToggle?.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(previewPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
      });
      expect(animateSpy).not.toHaveBeenCalled();
    } finally {
      animateSpy?.mockRestore();
      await mounted?.cleanup();
      mounted = null;
      await motionCommands.emulateReducedMotion("no-preference");
      localStorage.removeItem("moss:theme");
      localStorage.removeItem("moss:activity-onboarding:v1");
      localStorage.removeItem(coachmarkKey);
      localStorage.removeItem("moss:right-dock-state:v1");
    }
  });

  it("covers B2.2a focused and Canvas host missing-bundle views with durable view state", async () => {
    const desktopViewport = { ...DEFAULT_VIEWPORT, width: 1_200, height: 760 };
    const narrowViewport = {
      ...DEFAULT_VIEWPORT,
      name: "generated-image-preview-b22-390",
      width: 390,
      height: 760,
    };
    const snapshot = createSnapshotWithGeneratedImagePreview({ imageCount: 4 });
    const coachmarkKey = "has-dismissed-image-canvas-view-coachmark-v1";
    const expectedImages = ["one", "two", "three", "four"].map((ordinal) => ({
      id: `turn-generated-image-preview:generated-preview-${ordinal}`,
      path: `/tmp/generated-preview-${ordinal}.png`,
      name: `generated-preview-${ordinal}.png`,
    }));
    const imagePreview = () =>
      useRightDockStore
        .getState()
        .dockStateByThreadId[THREAD_ID]?.panes.find((pane) => pane.kind === "canvas")?.imagePreview;
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
    onTestFinished(() => canvasFetch.mockRestore());
    const expectCanvasUnavailable = async (activeImageId: string) => {
      // This fixture deliberately omits the complete Canvas bundle. It proves
      // host wiring and durable state, not the embedded app's runtime features.
      await expect.element(page.getByText("画布工作区暂不可用", { exact: true })).toBeVisible();
      expect(document.querySelector("[data-conversation-image-workspace]")).not.toBeNull();
      expect(document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
      expect(document.querySelector('[data-testid="generated-image-playground"]')).toBeNull();
      expect(canvasRequests.length).toBeGreaterThan(0);
      for (const request of canvasRequests) {
        expect(request.url.origin).toBe(window.location.origin);
        expect(request.url.pathname).toBe("/canvas/");
        expect(request.init).toMatchObject({ method: "GET", credentials: "omit" });
        expect(Object.fromEntries(request.url.searchParams)).toEqual({
          moss_host: "1",
          moss_thread: THREAD_ID,
          projectId: `thread:${THREAD_ID}`,
          projectKey: THREAD_ID,
        });
      }
      expect(imagePreview()).toMatchObject({
        view: "playground",
        activeImageId,
        images: expectedImages,
        groupId: "turn-generated-image-preview",
        createdAt: "2026-03-04T12:16:40.000Z",
        cwd: "/repo/project",
      });
    };
    setImageLimitFixtureTheme("light");
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    localStorage.removeItem(coachmarkKey);
    useRightDockStore.setState({ dockStateByThreadId: {} });
    let mounted: MountedChatView | null = await mountChatView({
      viewport: desktopViewport,
      snapshot,
    });

    try {
      const generatedPreview = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="generated-image-preview"]'),
        "Unable to find the B2.2a generated image preview thumbnail.",
      );
      await openGeneratedImageFocusPane(generatedPreview);
      const previewPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the B2.2a generated image preview pane.",
      );
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-status")).toBe("loaded");
        expect(previewPane.getAttribute("data-generated-image-preview-view")).toBe("single");
      });

      const coachmark = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="generated-image-preview-canvas-coachmark"]',
          ),
        "Unable to find the first-use Canvas coachmark.",
      );
      expect(coachmark.textContent).toContain("Try Canvas view");
      expect(coachmark.className).toContain(
        "relative max-w-64 !rounded-card !border-0 !bg-text-info px-4 py-3 !text-inverse shadow-lg dark:!text-default",
      );
      expect(coachmark.className).toContain(
        "before:pointer-events-none before:absolute before:-left-1.5 before:top-1/2 before:h-3 before:w-3",
      );
      expect(coachmark.className).toContain("before:-translate-y-1/2 before:rotate-45");
      const coachmarkTitle = coachmark.querySelector("p");
      expect(coachmarkTitle?.className).toContain(
        "text-base leading-[18px] font-medium tracking-[-0.08px]",
      );
      const coachmarkBody = coachmark.querySelectorAll("p")[1];
      expect(coachmarkBody?.className).toContain(
        "pe-4 text-base leading-[18px] tracking-[-0.08px]",
      );
      const coachmarkDismiss = coachmark.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-canvas-coachmark-dismiss"]',
      );
      expect(coachmarkDismiss).not.toBeNull();
      expect(coachmarkDismiss?.className).toContain("h-6 w-6");
      expect(coachmarkDismiss?.className).not.toContain("underline");
      const lightInfoProbe = document.createElement("span");
      lightInfoProbe.className = "bg-info";
      const lightInverseProbe = document.createElement("span");
      lightInverseProbe.className = "text-primary-foreground";
      document.body.append(lightInfoProbe, lightInverseProbe);
      try {
        const lightCoachmarkStyle = getComputedStyle(coachmark);
        const lightInfoBackground = getComputedStyle(lightInfoProbe).backgroundColor;
        const lightInverseInk = getComputedStyle(lightInverseProbe).color;
        expect(lightCoachmarkStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(lightCoachmarkStyle.backgroundColor).toBe(lightInfoBackground);
        expect(getComputedStyle(coachmark, "::before").backgroundColor).toBe(lightInfoBackground);
        expect(lightCoachmarkStyle.color).toBe(lightInverseInk);
      } finally {
        lightInfoProbe.remove();
        lightInverseProbe.remove();
      }
      const lightCoachmarkScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR}/light-coachmark.png`,
      });
      expect(lightCoachmarkScreenshot).toContain("light-coachmark.png");

      const canvasToggle = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="generated-image-preview-view-playground"]',
          ),
        "Unable to find the Canvas view toggle.",
      );
      expect(canvasToggle.getAttribute("aria-pressed")).toBe("false");
      canvasToggle.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(previewPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
        expect(canvasToggle.disabled).toBe(false);
        expect(
          previewPane.querySelector<HTMLButtonElement>(
            '[data-testid="generated-image-preview-view-single"]',
          )?.disabled,
        ).toBe(false);
      });
      // The 画布 view stays beside the chat: only the expand control widens the dock.
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-generated-image-preview-full-width")).toBe("false");
        expect(
          document
            .querySelector("[data-right-dock-main-content]")
            ?.getAttribute("data-app-shell-right-panel-full-width"),
        ).toBe("false");
      });
      await vi.waitFor(() =>
        expect(previewPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        ),
      );
      // The hosted Canvas has its own toolbars, so the tip never covers them.
      expect(
        document.querySelector('[data-testid="generated-image-preview-canvas-coachmark"]'),
      ).toBeNull();
      // Dismissed from the focused view, it stays dismissed.
      previewPane
        .querySelector<HTMLButtonElement>('[data-testid="generated-image-preview-view-single"]')!
        .click();
      const focusedCoachmark = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="generated-image-preview-canvas-coachmark"]',
          ),
        "Canvas coachmark did not return in the focused view.",
      );
      expect(focusedCoachmark.textContent).toContain("Try Canvas view");
      focusedCoachmark
        .querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview-canvas-coachmark-dismiss"]',
        )
        ?.click();
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid="generated-image-preview-canvas-coachmark"]'),
        ).toBeNull(),
      );
      expect(localStorage.getItem(coachmarkKey)).toBe("1");
      previewPane
        .querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview-view-playground"]',
        )!
        .click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(previewPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
      });
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-one");

      previewPane.focus();
      const canvasArrow = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
      });
      previewPane.dispatchEvent(canvasArrow);
      expect(canvasArrow.defaultPrevented).toBe(false);
      expect(previewPane.getAttribute("data-image-id")).toBe(
        "turn-generated-image-preview:generated-preview-one",
      );

      const focusedViewToggle = previewPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-single"]',
      );
      expect(focusedViewToggle).not.toBeNull();
      focusedViewToggle!.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-generated-image-preview-view")).toBe("single");
        expect(previewPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
        expect(previewPane.getAttribute("data-image-status")).toBe("loaded");
      });
      // The rail is a full-width affordance; the person widens the 画布 with the expand control.
      document.querySelector<HTMLButtonElement>('[data-testid="right-dock-width-toggle"]')?.click();
      await waitForGeneratedImagePreviewDockSettled(true);
      const secondRailTile = await waitForElement(
        () =>
          previewPane.querySelector<HTMLButtonElement>(
            '[data-testid="generated-image-preview-rail-tile-turn-generated-image-preview:generated-preview-two"]',
          ),
        "Unable to find the real focused-view rail's second image.",
      );
      secondRailTile.click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
        expect(previewPane.getAttribute("data-image-status")).toBe("loaded");
        expect(secondRailTile.getAttribute("aria-current")).toBe("true");
      });
      // The same control gives the chat back.
      document.querySelector<HTMLButtonElement>('[data-testid="right-dock-width-toggle"]')?.click();
      await waitForGeneratedImagePreviewDockSettled(false);
      previewPane
        .querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview-view-playground"]',
        )!
        .click();
      await vi.waitFor(() => {
        expect(previewPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(previewPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
        expect(previewPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
      });
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-two");

      const rightDockStorageKey = "moss:right-dock-state:v1";
      const persistedDockStateRaw = localStorage.getItem(rightDockStorageKey) ?? "{}";
      const persistedCanvasState = JSON.parse(persistedDockStateRaw);
      const persistedDockStateByThreadId =
        persistedCanvasState.state?.dockStateByThreadId ?? persistedCanvasState.dockStateByThreadId;
      const persistedPreview = persistedDockStateByThreadId?.[THREAD_ID]?.panes?.find(
        (pane: { kind?: string }) => pane.kind === "canvas",
      )?.imagePreview;
      expect(persistedPreview?.view).toBe("playground");
      expect(persistedPreview?.activeImageId).toBe(
        "turn-generated-image-preview:generated-preview-two",
      );
      expect(persistedPreview?.images).toEqual(expectedImages);
      expect(persistedPreview?.cwd).toBe("/repo/project");
      expect(persistedPreview?.groupId).toBe("turn-generated-image-preview");
      expect(persistedPreview?.createdAt).toBe("2026-03-04T12:16:40.000Z");
      expect(JSON.stringify(persistedPreview)).not.toContain("token");
      expect(JSON.stringify(persistedPreview)).not.toContain("previewUrl");
      expect(
        persistedPreview?.images?.every(
          (image: { groupId?: unknown; createdAt?: unknown }) =>
            image.groupId === undefined && image.createdAt === undefined,
        ),
      ).toBe(true);

      useRightDockStore.setState({ dockStateByThreadId: {} });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull(),
      );
      localStorage.setItem(rightDockStorageKey, persistedDockStateRaw);
      await useRightDockStore.persist.rehydrate();
      const rehydratedPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to rehydrate the persisted Canvas pane.",
      );
      await vi.waitFor(() => {
        expect(rehydratedPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(rehydratedPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
        expect(rehydratedPane.getAttribute("data-generated-image-preview-full-width")).toBe(
          "false",
        );
      });
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-two");

      useRightDockStore.getState().setDockOpen(THREAD_ID, false);
      await vi.waitFor(() => expect(shownGeneratedImagePreviewPane()).toBeNull());
      useRightDockStore.getState().setDockOpen(THREAD_ID, true);
      const reopenedPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to reopen the persisted Canvas pane.",
      );
      await vi.waitFor(() => {
        expect(reopenedPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(reopenedPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
      });
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-two");
      const focusedToggle = reopenedPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-single"]',
      );
      focusedToggle?.click();
      await waitForGeneratedImagePreviewDockSettled(false);
      document.querySelector<HTMLButtonElement>('[data-testid="right-dock-width-toggle"]')?.click();
      await waitForGeneratedImagePreviewDockSettled(true);
      await vi.waitFor(() => {
        expect(reopenedPane.getAttribute("data-generated-image-preview-view")).toBe("single");
        expect(reopenedPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
        expect(reopenedPane.getAttribute("data-image-status")).toBe("loaded");
        expect(reopenedPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
        expect(
          document.querySelector('[data-testid="generated-image-preview-rail"]'),
        ).not.toBeNull();
      });
      const lightFocusedScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR}/light-focused-full-width.png`,
      });
      expect(lightFocusedScreenshot).toContain("light-focused-full-width.png");
      expect(
        reopenedPane.querySelector('[data-testid="generated-image-preview-canvas-coachmark"]'),
      ).toBeNull();
      reopenedPane
        .querySelector<HTMLButtonElement>('[data-testid="generated-image-preview-view-playground"]')
        ?.click();
      await vi.waitFor(() => {
        expect(reopenedPane.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(reopenedPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
      });
      await mounted.setViewport(narrowViewport);
      const lightCompactPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the light compact Canvas pane.",
      );
      await vi.waitFor(() => {
        expect(lightCompactPane.getAttribute("data-generated-image-preview-view")).toBe(
          "playground",
        );
        expect(lightCompactPane.getAttribute("data-generated-image-preview-full-width")).toBe(
          "false",
        );
        expect(lightCompactPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
      });
      expect(lightCompactPane.getAttribute("data-image-id")).toBe(
        "turn-generated-image-preview:generated-preview-two",
      );
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-two");
      const lightCompactFocusedToggle = lightCompactPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-single"]',
      );
      expect(lightCompactFocusedToggle).not.toBeNull();
      lightCompactFocusedToggle!.click();
      await vi.waitFor(() => {
        expect(lightCompactPane.getAttribute("data-generated-image-preview-view")).toBe("single");
        expect(lightCompactPane.getAttribute("data-image-status")).toBe("loaded");
        expect(lightCompactPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
        const image = lightCompactPane.querySelector<HTMLImageElement>("img[data-image-id]");
        expect(image?.complete).toBe(true);
        expect(image?.naturalWidth).toBeGreaterThan(0);
        expect(new URL(image!.src).searchParams.get("path")).toBe("/tmp/generated-preview-two.png");
      });
      const lightCompactCanvasToggle = lightCompactPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-playground"]',
      );
      expect(lightCompactCanvasToggle).not.toBeNull();
      lightCompactCanvasToggle!.click();
      await vi.waitFor(() => {
        expect(lightCompactPane.getAttribute("data-generated-image-preview-view")).toBe(
          "playground",
        );
        expect(lightCompactPane.getAttribute("data-generated-image-preview-full-width")).toBe(
          "false",
        );
        expect(lightCompactPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
        expect(lightCompactPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-two",
        );
      });
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-two");
      const lightCompactRect = lightCompactPane.getBoundingClientRect();
      const lightCompactComposer = document.querySelector<HTMLElement>('[data-testid="composer"]');
      expect(lightCompactRect.right).toBeLessThanOrEqual(window.innerWidth + 1);
      if (lightCompactComposer) {
        expect(lightCompactRect.bottom).toBeLessThanOrEqual(
          lightCompactComposer.getBoundingClientRect().top + 1,
        );
      }
      const lightCompactScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR}/light-390-canvas.png`,
      });
      expect(lightCompactScreenshot).toContain("light-390-canvas.png");
    } finally {
      await mounted?.cleanup();
      mounted = null;
      useRightDockStore.setState({ dockStateByThreadId: {} });
      localStorage.removeItem("moss:theme");
      localStorage.removeItem("moss:activity-onboarding:v1");
      localStorage.removeItem("moss:right-dock-state:v1");
    }

    setImageLimitFixtureTheme("dark");
    localStorage.setItem("moss:activity-onboarding:v1", "seen");
    localStorage.removeItem(coachmarkKey);
    useRightDockStore.setState({ dockStateByThreadId: {} });
    mounted = await mountChatView({ viewport: desktopViewport, snapshot });
    // MERGE-ADAPT(2026-10-08): upstream's theme store refreshes its cached snapshot only
    // inside storage-event handlers, and no useTheme subscriber is mounted while the tree
    // above is unmounted — re-dispatch now that ChatView's useTheme effect is live so the
    // dark class actually lands (main's per-read keyed cache made the pre-mount write stick).
    setImageLimitFixtureTheme("dark");
    try {
      const darkPreview = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-testid="generated-image-preview"]'),
        "Unable to find the dark B2.2a generated image preview thumbnail.",
      );
      await openGeneratedImageFocusPane(darkPreview);
      const darkPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the dark B2.2a preview pane.",
      );
      await vi.waitFor(() => expect(darkPane.getAttribute("data-image-status")).toBe("loaded"));
      const darkCoachmark = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="generated-image-preview-canvas-coachmark"]',
          ),
        "Unable to find the dark Canvas coachmark.",
      );
      const darkInfoProbe = document.createElement("span");
      darkInfoProbe.className = "bg-info";
      const darkDefaultProbe = document.createElement("span");
      darkDefaultProbe.className = "text-default";
      document.body.append(darkInfoProbe, darkDefaultProbe);
      try {
        const darkCoachmarkStyle = getComputedStyle(darkCoachmark);
        const darkInfoBackground = getComputedStyle(darkInfoProbe).backgroundColor;
        const darkDefaultInk = getComputedStyle(darkDefaultProbe).color;
        expect(darkCoachmarkStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(darkCoachmarkStyle.backgroundColor).toBe(darkInfoBackground);
        expect(getComputedStyle(darkCoachmark, "::before").backgroundColor).toBe(
          darkInfoBackground,
        );
        expect(darkCoachmarkStyle.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(darkCoachmarkStyle.color).toBe(darkDefaultInk);
      } finally {
        darkInfoProbe.remove();
        darkDefaultProbe.remove();
      }
      darkCoachmark
        .querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview-canvas-coachmark-dismiss"]',
        )
        ?.click();
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid="generated-image-preview-canvas-coachmark"]'),
        ).toBeNull(),
      );
      darkPane
        .querySelector<HTMLButtonElement>('[data-testid="generated-image-preview-view-playground"]')
        ?.click();
      // The 画布 view stays beside the chat: only the expand control widens the dock.
      await vi.waitFor(() => {
        expect(darkPane.getAttribute("data-generated-image-preview-full-width")).toBe("false");
        expect(
          document
            .querySelector("[data-right-dock-main-content]")
            ?.getAttribute("data-app-shell-right-panel-full-width"),
        ).toBe("false");
      });
      await vi.waitFor(() =>
        expect(darkPane.getAttribute("data-generated-image-preview-view")).toBe("playground"),
      );
      await vi.waitFor(() => {
        expect(darkPane.getAttribute("data-image-status")).toBe("loaded");
        expect(darkPane.getAttribute("data-generated-image-preview-transitioning")).toBe("false");
      });
      expect(darkPane.getAttribute("data-image-id")).toBe(
        "turn-generated-image-preview:generated-preview-one",
      );
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-one");
      const darkDesktopScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR}/dark-canvas-desktop.png`,
      });
      expect(darkDesktopScreenshot).toContain("dark-canvas-desktop.png");
      await mounted.setViewport(narrowViewport);
      const currentDarkPane = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]'),
        "Unable to find the compact Canvas preview pane.",
      );
      await vi.waitFor(() => {
        expect(currentDarkPane.getAttribute("data-generated-image-preview-view")).toBe(
          "playground",
        );
        expect(currentDarkPane.getAttribute("data-generated-image-preview-full-width")).toBe(
          "false",
        );
        expect(currentDarkPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
      });
      expect(currentDarkPane.getAttribute("data-image-id")).toBe(
        "turn-generated-image-preview:generated-preview-one",
      );
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-one");
      const darkCompactFocusedToggle = currentDarkPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-single"]',
      );
      expect(darkCompactFocusedToggle).not.toBeNull();
      darkCompactFocusedToggle!.click();
      await vi.waitFor(() => {
        expect(currentDarkPane.getAttribute("data-generated-image-preview-view")).toBe("single");
        expect(currentDarkPane.getAttribute("data-image-status")).toBe("loaded");
        expect(currentDarkPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        );
        const image = currentDarkPane.querySelector<HTMLImageElement>("img[data-image-id]");
        expect(image?.complete).toBe(true);
        expect(image?.naturalWidth).toBeGreaterThan(0);
        expect(new URL(image!.src).searchParams.get("path")).toBe("/tmp/generated-preview-one.png");
      });
      const darkCompactCanvasToggle = currentDarkPane.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-view-playground"]',
      );
      expect(darkCompactCanvasToggle).not.toBeNull();
      darkCompactCanvasToggle!.click();
      await vi.waitFor(() => {
        expect(currentDarkPane.getAttribute("data-generated-image-preview-view")).toBe(
          "playground",
        );
        expect(currentDarkPane.getAttribute("data-generated-image-preview-full-width")).toBe(
          "false",
        );
        expect(currentDarkPane.getAttribute("data-generated-image-preview-transitioning")).toBe(
          "false",
        );
        expect(currentDarkPane.getAttribute("data-image-id")).toBe(
          "turn-generated-image-preview:generated-preview-one",
        );
      });
      await expectCanvasUnavailable("turn-generated-image-preview:generated-preview-one");
      const narrowRect = currentDarkPane.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>('[data-testid="composer"]');
      expect(narrowRect.right).toBeLessThanOrEqual(window.innerWidth + 1);
      if (composer) {
        expect(narrowRect.bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top + 1);
      }
      const darkNarrowScreenshot = await page.screenshot({
        path: `${GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR}/dark-390-canvas.png`,
      });
      expect(darkNarrowScreenshot).toContain("dark-390-canvas.png");
    } finally {
      await mounted?.cleanup();
      mounted = null;
      useRightDockStore.setState({ dockStateByThreadId: {} });
      localStorage.removeItem("moss:theme");
      localStorage.removeItem("moss:activity-onboarding:v1");
      localStorage.removeItem(coachmarkKey);
      localStorage.removeItem("moss:right-dock-state:v1");
    }
  });

  describe("B3.2 image-generation usage-limit composer host", () => {
    function imageLimitSnapshot(
      providerInstanceId = "codex",
      overrides: {
        turnId?: string;
        activityId?: string;
        createdAt?: string;
        resetsAt?: number | null;
      } = {},
    ) {
      return withImageGenerationLimitActivity(
        createSnapshotForTargetUser({
          targetMessageId: `msg-user-image-limit-${providerInstanceId}` as MessageId,
          targetText: "image limit fixture prompt",
        }),
        { providerInstanceId, ...overrides },
      );
    }

    it.each(["Free", "Go", "Plus", "ProLite"])(
      "renders the personal %s copy from a durable failure and opens only the safe usage bridge",
      async (planName) => {
        const diagnostics = installImageLimitDiagnostics();
        const openExternal = vi.fn(async () => true);
        const previousDesktopBridge = window.desktopBridge;
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: imageLimitSnapshot(),
          configureFixture: (nextFixture) => {
            nextFixture.providerUsageSnapshot = makeProviderUsageSnapshot(planName);
          },
        });
        Object.defineProperty(window, "desktopBridge", {
          configurable: true,
          writable: true,
          value: { openExternal, setTheme: vi.fn(async () => undefined) },
        });
        try {
          const banner = await waitForElement(
            () =>
              document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
            "Unable to find personal image-generation usage-limit banner.",
          );
          expect(banner.textContent).toContain("You’ve reached your image creation limit");
          expect(banner.textContent).toContain(
            planName === "Free" || planName === "Go" ? "ChatGPT Plus" : "ChatGPT Pro",
          );
          expect(
            banner.querySelector('[data-testid="image-generation-limit-primary"]'),
          ).not.toBeNull();
          expect(
            banner.querySelector('[data-testid="image-generation-limit-dismiss"]'),
          ).not.toBeNull();
          expect(
            wsRequests.some(
              (request) => request._tag === WS_METHODS.serverGetProviderUsageSnapshot,
            ),
          ).toBe(true);
          await mounted.setViewport({ ...DEFAULT_VIEWPORT, name: "image-limit-390", width: 390 });
          const narrowBanner = await waitForElement(
            () =>
              document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
            "Unable to find narrow personal image-generation banner.",
          );
          expect(
            getComputedStyle(narrowBanner.querySelector('svg, [data-slot="central-icon"]')!)
              .display,
          ).toBe("none");
          const actionRow = narrowBanner.querySelector<HTMLElement>("div.flex.gap-2.shrink-0");
          expect(actionRow?.className).toContain("max-[400px]:flex-wrap");
          const composer = document.querySelector<HTMLElement>('[data-testid="composer"]');
          expect(narrowBanner.getBoundingClientRect().bottom).toBeLessThanOrEqual(
            composer?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
          );
          await mounted.setViewport({ ...DEFAULT_VIEWPORT, name: "image-limit-light", width: 960 });
          setImageLimitFixtureTheme("light");
          await waitForLayout();
          const lightReceipt = readImageLimitThemeReceipt(narrowBanner);
          const lightDesktopScreenshot = await page.screenshot({
            path: `${IMAGE_GENERATION_LIMIT_RECEIPT_DIR}/light-desktop.png`,
          });
          expect(lightDesktopScreenshot).toContain("light-desktop.png");
          setImageLimitFixtureTheme("dark");
          await waitForLayout();
          const darkReceipt = readImageLimitThemeReceipt(narrowBanner);
          expect(darkReceipt.background).not.toBe(lightReceipt.background);
          expect(darkReceipt.foreground).not.toBe(lightReceipt.foreground);
          const darkDesktopScreenshot = await page.screenshot({
            path: `${IMAGE_GENERATION_LIMIT_RECEIPT_DIR}/dark-desktop.png`,
          });
          expect(darkDesktopScreenshot).toContain("dark-desktop.png");
          await mounted.setViewport({
            ...DEFAULT_VIEWPORT,
            name: "image-limit-dark-390",
            width: 390,
          });
          const darkNarrowScreenshot = await page.screenshot({
            path: `${IMAGE_GENERATION_LIMIT_RECEIPT_DIR}/dark-390.png`,
          });
          expect(darkNarrowScreenshot).toContain("dark-390.png");
          setImageLimitFixtureTheme("light");
          await waitForLayout();
          const lightNarrowScreenshot = await page.screenshot({
            path: `${IMAGE_GENERATION_LIMIT_RECEIPT_DIR}/light-390.png`,
          });
          expect(lightNarrowScreenshot).toContain("light-390.png");
          const primary = banner.querySelector<HTMLButtonElement>(
            '[data-testid="image-generation-limit-primary"]',
          );
          primary?.click();
          await vi.waitFor(() => {
            expect(openExternal).toHaveBeenCalledWith("https://chatgpt.com/codex/settings/usage");
            expect(
              document.querySelector('[data-testid="image-generation-limit-banner"]'),
            ).toBeNull();
          });
          diagnostics.assertHealthy();
        } finally {
          await mounted.cleanup();
          diagnostics.dispose();
          if (previousDesktopBridge) {
            Object.defineProperty(window, "desktopBridge", {
              configurable: true,
              writable: true,
              value: previousDesktopBridge,
            });
          } else {
            Reflect.deleteProperty(window, "desktopBridge");
          }
          setImageLimitFixtureTheme("light");
        }
      },
    );

    it("keeps managed Moss copy and internal usage navigation isolated from personal actions", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const openExternal = vi.fn(async () => true);
      const previousDesktopBridge = window.desktopBridge;
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: imageLimitSnapshot("codex_moss"),
        configureFixture: configureMossManagedDefaults,
      });
      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        writable: true,
        value: { openExternal, setTheme: vi.fn(async () => undefined) },
      });
      try {
        const banner = await waitForElement(
          () =>
            document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
          "Unable to find managed Moss image-generation usage-limit banner.",
        );
        expect(banner.textContent).toContain("Moss image creation limit reached");
        expect(banner.textContent).not.toContain("ChatGPT");
        expect(banner.textContent).not.toContain("credits");
        expect(
          banner.querySelector('[data-testid="image-generation-limit-primary"]'),
        ).not.toBeNull();
        expect(
          wsRequests.some((request) => request._tag === WS_METHODS.serverGetProviderUsageSnapshot),
        ).toBe(false);
        closeSettings();
        await banner
          .querySelector<HTMLButtonElement>('[data-testid="image-generation-limit-primary"]')
          ?.click();
        await vi.waitFor(() => {
          expect(settingsDialogStore.getState()).toMatchObject({
            isOpen: true,
            request: { section: "usage" },
          });
          expect(openExternal).not.toHaveBeenCalled();
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull();
        });
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
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

    it("keeps a same-turn success visible and clears after a newer different-turn success", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const failureSnapshot = imageLimitSnapshot("codex", {
        turnId: "turn-image-limit-same-turn",
        activityId: "activity-image-limit-same-turn",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: failureSnapshot,
      });
      try {
        await waitForElement(
          () =>
            document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
          "Unable to find image-generation usage-limit banner before lifecycle push.",
        );
        const sameTurnSuccess = withImageGenerationCompletionActivity(failureSnapshot, {
          providerInstanceId: "codex",
          turnId: "turn-image-limit-same-turn",
          activityId: "activity-image-success-same-turn",
          createdAt: isoAt(6),
        });
        fixture.snapshot = sameTurnSuccess;
        useStore.getState().syncServerReadModel(sameTurnSuccess);
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).not.toBeNull(),
        );
        const laterTurnSuccess = withImageGenerationCompletionActivity(sameTurnSuccess, {
          providerInstanceId: "codex",
          turnId: "turn-image-limit-next-turn",
          activityId: "activity-image-success-next-turn",
          createdAt: isoAt(7),
        });
        fixture.snapshot = laterTurnSuccess;
        useStore.getState().syncServerReadModel(laterTurnSuccess);
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull(),
        );
        expect(document.querySelector('[data-testid="generated-image-preview-pane"]')).toBeNull();
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("observes a sibling-thread failure and clears it from a newer current-thread success", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const baseSnapshot = addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-image-limit-sibling" as MessageId,
          targetText: "image limit sibling fixture prompt",
        }),
        OTHER_THREAD_ID,
      );
      const siblingFailureSnapshot = withImageGenerationLimitActivity(baseSnapshot, {
        threadId: OTHER_THREAD_ID,
        providerInstanceId: "codex",
        activityId: "activity-image-limit-sibling",
        turnId: "turn-image-limit-sibling",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: siblingFailureSnapshot,
      });
      try {
        useStore.getState().syncServerReadModel(siblingFailureSnapshot);
        const siblingBanner = await waitForElement(
          () =>
            document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
          "Unable to find sibling-thread image-generation usage-limit banner.",
        );
        expect(siblingBanner.dataset.imageGenerationLimitIdentity).toContain(
          "activity-image-limit-sibling",
        );

        const currentThreadSuccess = withImageGenerationCompletionActivity(siblingFailureSnapshot, {
          threadId: THREAD_ID,
          providerInstanceId: "codex",
          activityId: "activity-image-success-current-thread",
          turnId: "turn-image-limit-current",
          createdAt: isoAt(10),
        });
        fixture.snapshot = currentThreadSuccess;
        useStore.getState().syncServerReadModel(currentThreadSuccess);
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull(),
        );
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("suppresses an allowed rate-limit warning while the image banner is visible", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const warningSnapshot = withAccountRateLimitActivity(
        imageLimitSnapshot("codex", { activityId: "activity-image-limit-warning" }),
        "allowed_warning",
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: warningSnapshot,
      });
      try {
        await waitForElement(
          () =>
            document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
          "Unable to find image banner while allowed warning is active.",
        );
        expect(document.body.textContent).not.toContain("Approaching rate limit");

        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("lets a hard rate limit win over the image banner", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: withAccountRateLimitActivity(
          imageLimitSnapshot("codex", { activityId: "activity-image-limit-hard" }),
          "rejected",
        ),
      });
      try {
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull();
          expect(document.body.textContent).toContain("Rate limit reached.");
        });
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("hides an image banner whose structured reset has expired", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: imageLimitSnapshot("codex", {
          activityId: "activity-image-limit-expired",
          resetsAt: 1,
        }),
      });
      try {
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull(),
        );
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("hides the image banner while the selected provider health is durably unavailable", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: imageLimitSnapshot("codex", {
          activityId: "activity-image-limit-provider-health",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            providers: nextFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              status: "error" as const,
              available: false,
              authStatus: "unauthenticated" as const,
              message: "Provider health is unavailable in this fixture.",
            })),
          };
        },
      });
      try {
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull(),
        );
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("keeps provider-keyed dismissals isolated while switching personal Codex and managed Moss", async () => {
      const diagnostics = installImageLimitDiagnostics();
      const personalSnapshot = imageLimitSnapshot("codex", {
        activityId: "activity-image-limit-personal-switch",
      });
      const bothProvidersSnapshot = withImageGenerationLimitActivity(personalSnapshot, {
        providerInstanceId: "codex_moss",
        activityId: "activity-image-limit-managed-switch",
        createdAt: isoAt(2),
      });
      const switchSnapshot = {
        ...bothProvidersSnapshot,
        threads: bothProvidersSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                modelSelection: Object.assign({}, thread.modelSelection, { instanceId: "codex" }),
              })
            : thread,
        ),
      } as OrchestrationReadModel;
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: switchSnapshot,
        configureFixture: configureMossManagedDefaults,
      });
      try {
        const banner = await waitForElement(
          () =>
            document.querySelector<HTMLElement>('[data-testid="image-generation-limit-banner"]'),
          "Unable to find personal banner before provider switch.",
        );
        expect(banner.dataset.imageGenerationLimitSource).toBe("personal");
        await banner
          .querySelector<HTMLButtonElement>('[data-testid="image-generation-limit-dismiss"]')
          ?.click();
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull(),
        );
        useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
          provider: "codex",
          instanceId: "codex_moss",
          model: "gpt-5.6-sol",
        });
        await vi.waitFor(() => {
          const current = document.querySelector<HTMLElement>(
            '[data-testid="image-generation-limit-banner"]',
          );
          expect(current?.dataset.imageGenerationLimitSource).toBe("moss");
        });
        await document
          .querySelector<HTMLButtonElement>('[data-testid="image-generation-limit-dismiss"]')
          ?.click();
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull(),
        );
        useComposerDraftStore
          .getState()
          .setModelSelection(THREAD_ID, { provider: "codex", instanceId: "codex", model: "gpt-5" });
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-testid="image-generation-limit-banner"]'),
          ).toBeNull();
        });
        const newerPersonalFailure = withImageGenerationLimitActivity(switchSnapshot, {
          providerInstanceId: "codex",
          activityId: "activity-image-limit-personal-switch-newer",
          createdAt: isoAt(10),
        });
        fixture.snapshot = newerPersonalFailure;
        useStore.getState().syncServerReadModel(newerPersonalFailure);
        await vi.waitFor(() => {
          const current = document.querySelector<HTMLElement>(
            '[data-testid="image-generation-limit-banner"]',
          );
          expect(current?.dataset.imageGenerationLimitSource).toBe("personal");
          expect(current?.dataset.imageGenerationLimitIdentity).toContain(
            "activity-image-limit-personal-switch-newer",
          );
        });
        diagnostics.assertHealthy();
      } finally {
        await mounted.cleanup();
        diagnostics.dispose();
      }
    });

    it("does not flash Starting provider… or lock the composer on cached idle hydration or warm follow-up turns", async () => {
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-warm-user-1"),
        targetText: "First message",
      });
      const readySnapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                runtimeMode: "full-access",
                session: {
                  threadId: THREAD_ID,
                  status: "ready",
                  providerName: "codex",
                  providerInstanceId: "codex",
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: NOW_ISO,
                },
              }
            : thread,
        ),
      };

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: readySnapshot,
      });
      try {
        // 1. Cached idle detail hydration must neither show "Starting Codex…" nor disable the editor.
        useStore.setState((state) => ({
          ...state,
          threadDetailSyncById: {
            ...(state.threadDetailSyncById ?? {}),
            [THREAD_ID]: "cached",
          },
        }));
        await nextFrame();
        expect(document.body.textContent ?? "").not.toContain("Starting Codex");
        expect(document.body.textContent ?? "").not.toContain("正在启动 Codex");
        const editorDuringCached = document.querySelector<HTMLElement>(
          '[data-testid="composer-editor"]',
        );
        expect(editorDuringCached?.getAttribute("contenteditable")).not.toBe("false");

        // 2. Sync back to ready, then transition warm ready -> starting (follow-up or non-native steer).
        useStore.setState((state) => ({
          ...state,
          threadDetailSyncById: {
            ...(state.threadDetailSyncById ?? {}),
            [THREAD_ID]: "synced",
          },
        }));
        await nextFrame();

        const warmStartingSnapshot: OrchestrationReadModel = {
          ...readySnapshot,
          snapshotSequence: readySnapshot.snapshotSequence + 1,
          threads: readySnapshot.threads.map((thread) =>
            thread.id === THREAD_ID
              ? {
                  ...thread,
                  session: {
                    ...thread.session!,
                    status: "starting",
                    updatedAt: "2026-03-04T12:05:00.000Z",
                  },
                }
              : thread,
          ),
        };
        fixture.snapshot = warmStartingSnapshot;
        useStore.getState().syncServerReadModel(warmStartingSnapshot);
        await nextFrame();

        // Warm follow-up stays calm ("Thinking") with an editable composer — no "Starting Codex…".
        expect(document.body.textContent ?? "").not.toContain("Starting Codex");
        expect(document.body.textContent ?? "").not.toContain("正在启动 Codex");
        const editorDuringWarmStart = document.querySelector<HTMLElement>(
          '[data-testid="composer-editor"]',
        );
        expect(editorDuringWarmStart?.getAttribute("contenteditable")).not.toBe("false");
      } finally {
        await mounted.cleanup();
      }
    });
  });
});
