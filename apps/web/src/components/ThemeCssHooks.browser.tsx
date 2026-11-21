// FILE: ThemeCssHooks.browser.tsx
// Purpose: Every theme hook on the chat screen and in Settings shows a rule set on it. Mounts the
//          real app, applies theme CSS the way a theme does (`applyThemeCss`, or a theme an agent
//          published through server settings), and reads the result off a screenshot.
// Layer: Web appearance tests (full app, mocked server). The hooks it proves are listed in
//        test/themeHookCoverage.ts; theme/themeCssHooks.test.ts checks that list covers the guide.
// Why: on 2026-11-17 an agent put a picture on `[data-messages-timeline-root]`, a hook on an
//   element without a box, and nothing showed. A source scan cannot catch that; pixels can.

import "../index.css";

import {
  DEVICE_WS_METHODS,
  COMPUTER_WS_METHODS,
  GUEST_SHARE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type MossPublishedTheme,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ServerSettingsView,
  type ThreadId,
  type WsWelcomePayload,
  WS_METHODS,
} from "@moss/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws, http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetThemeSnapshotCacheForTests } from "../hooks/useTheme";
import { getRouter } from "../router";
import { openSettings, settingsDialogStore } from "../settingsDialogStore";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
  createFullscreenTestHost,
} from "../test/browserHarness";
import {
  CHAT_HOOKS,
  MASK_PROBED_HOOKS,
  OUTLINE_PROBED_HOOKS,
  SETTINGS_HOOKS,
} from "../test/themeHookCoverage";
import {
  PROBE_CSS_COLOR,
  PROBE_RGB,
  type ViewportPixels,
  captureViewportPixels,
  colorShare,
  firstBoxedElement,
  measureThemeHook,
  probeImageDataUrl,
  settleThemeChange,
  type ThemeHookProbe,
  waitForPaint,
} from "../test/themeHookPaint";
import { DEFAULT_THEME_STATE, serializeThemeState, type ThemeVariant } from "../theme/theme.logic";
import { applyThemeCss } from "../theme/themeCss";
import { resetWsNativeApiForTest } from "../wsNativeApi";

const THREAD_ID = "thread-theme-hooks" as ThreadId;
const PROJECT_ID = "project-theme-hooks" as ProjectId;
const NOW_ISO = "2026-11-17T04:00:00.000Z";
const SHOTS = "__screenshots__/theme-hooks";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  serverSettings: ServerSettingsView;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;

function message(id: string, role: "user" | "assistant", text: string, offsetSeconds: number) {
  const at = new Date(Date.parse(NOW_ISO) + offsetSeconds * 1000).toISOString();
  return {
    id: id as MessageId,
    role,
    text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: at,
    updatedAt: at,
  };
}

function withSecondThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const [thread] = snapshot.threads;
  if (!thread || !thread.session) return snapshot;
  const otherId = "thread-theme-hooks-other" as ThreadId;
  return {
    ...snapshot,
    threads: [
      ...snapshot.threads,
      {
        ...thread,
        id: otherId,
        title: "Another chat",
        messages: [],
        session: { ...thread.session, threadId: otherId },
      },
    ],
  };
}

function createSnapshot(): OrchestrationReadModel {
  return withSecondThread({
    snapshotSequence: 1,
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Chat background",
        modelSelection: { provider: "codex", model: "gpt-5" },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [
          message("msg-user", "user", "Put a picture behind the chat.", 0),
          message(
            "msg-assistant",
            "assistant",
            'Done. The rule I set:\n\n```css\n[data-workspace-area="conversation"] {\n  background-color: #fafafa;\n}\n```\n\nTell me how it looks.',
            5,
          ),
        ],
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
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  });
}

function buildFixture(agentTheme?: MossPublishedTheme): TestFixture {
  return {
    snapshot: createSnapshot(),
    serverConfig: createBrowserTestServerConfig(NOW_ISO),
    serverSettings: {
      ...createBrowserTestServerSettings(NOW_ISO),
      ...(agentTheme ? { agentTheme } : {}),
    },
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) return fixture.snapshot;
  if (tag === WS_METHODS.serverGetSettings) return fixture.serverSettings;
  if (tag === WS_METHODS.serverGetConfig) return fixture.serverConfig;
  if (tag === WS_METHODS.projectsListDevServers) return { servers: [] };
  if (tag === WS_METHODS.automationList) return { definitions: [], runs: [] };
  if (tag === WS_METHODS.todoList) return { todos: [] };
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) return { entries: [], truncated: false };
  return {};
}

// Pictures the mocked server's theme image route serves, by id.
const servedThemePictures = new Map<string, Uint8Array>();

async function pngBytesOf(width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = PROBE_CSS_COLOR;
  context.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** The id the server stores a PNG under: its SHA-256 and its type. */
async function themePictureId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return `${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}.png`;
}

/** The CSS-pixel box of the probe colour inside `area`, or null. */
function probeColorBounds(
  pixels: ViewportPixels,
  area: DOMRect,
): { width: number; height: number } | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const x0 = Math.max(0, Math.floor(area.left * pixels.scale));
  const y0 = Math.max(0, Math.floor(area.top * pixels.scale));
  const x1 = Math.min(pixels.width, Math.ceil(area.right * pixels.scale));
  const y1 = Math.min(pixels.height, Math.ceil(area.bottom * pixels.scale));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * pixels.width + x) * 4;
      if (
        Math.abs(pixels.data[offset]! - PROBE_RGB[0]) <= 12 &&
        Math.abs(pixels.data[offset + 1]! - PROBE_RGB[1]) <= 12 &&
        Math.abs(pixels.data[offset + 2]! - PROBE_RGB[2]) <= 12
      ) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left) return null;
  return {
    width: (right - left + 1) / pixels.scale,
    height: (bottom - top + 1) / pixels.scale,
  };
}

const wsLink = ws.link(/ws(s)?:\/\/.*/);
let sendSettingsUpdate: ((settings: TestFixture["serverSettings"]) => void) | undefined;
const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = readEffectRpcClientMessage(client, event.data);
      if (parsed.kind !== "request") return;
      const body = flattenEffectRpcRequestPayload(parsed.request.tag, parsed.request.payload);
      const method = body._tag;
      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerSettings) {
        const send = (settings: TestFixture["serverSettings"]) =>
          sendEffectRpcChunk(client, parsed.request.id, { settings });
        sendSettingsUpdate = send;
        send(fixture.serverSettings);
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in body) {
        const thread = fixture.snapshot.threads.find((entry) => entry.id === body.threadId);
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: { snapshotSequence: fixture.snapshot.snapshotSequence, thread },
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerKeepAwake ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents ||
        method === WS_METHODS.subscribeTodoEvents ||
        method === WS_METHODS.realtimeVoiceSubscribe ||
        method === DEVICE_WS_METHODS.subscribeEvents ||
        method === COMPUTER_WS_METHODS.subscribeEvents ||
        method === GUEST_SHARE_WS_METHODS.subscribe
      ) {
        // Infinite subscriptions stay open; an Exit would read as a dead socket.
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(method));
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/theme-images/:id", ({ params }) => {
    const bytes = servedThemePictures.get(String(params.id));
    return bytes
      ? new HttpResponse(bytes.slice().buffer, { headers: { "Content-Type": "image/png" } })
      : new HttpResponse(null, { status: 404 });
  }),
);

async function waitForWsMockInterception(): Promise<void> {
  await vi.waitFor(
    async () => {
      const socket = new WebSocket(`ws://${window.location.host}/__mock-interception-probe`);
      try {
        await vi.waitFor(() => expect(wsLink.clients.size).toBeGreaterThan(0), {
          timeout: 1_000,
          interval: 16,
        });
      } finally {
        socket.close();
      }
    },
    { timeout: 30_000, interval: 250 },
  );
}

function installTheme(variant: ThemeVariant): void {
  localStorage.setItem(
    "moss:theme",
    serializeThemeState({ ...DEFAULT_THEME_STATE, mode: variant }),
  );
  resetThemeSnapshotCacheForTests();
}

async function mountApp(variant: ThemeVariant, timeoutMs = 60_000) {
  const config = fixture.serverConfig;
  acknowledgeStartupAnnouncementsForTest(config);
  installTheme(variant);
  const host = createFullscreenTestHost();
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_ID}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });
  const cleanup = async () => {
    await screen.unmount();
    if (host.isConnected) host.remove();
    await router.options.context.queryClient.cancelQueries();
    router.options.context.queryClient.clear();
  };
  try {
    await vi.waitFor(
      () => {
        expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        expect(document.querySelectorAll('[data-message-role="assistant"]').length).toBe(1);
        expect(document.querySelector(".chat-markdown-codeblock")).toBeTruthy();
      },
      { timeout: timeoutMs, interval: 16 },
    );
    await document.fonts.ready;
    await waitForPaint();
  } catch (cause) {
    await cleanup();
    throw cause;
  }
  return { cleanup };
}

/** Share of a hook's visible box a probe background paints on screen. */
async function measureHook(selector: string, probe?: ThemeHookProbe) {
  return measureThemeHook(selector, {
    ...(probe ? { probe } : {}),
    minShare: MIN_VISIBLE_SHARE,
    onNotShown: async () => {
      await page.screenshot({
        path: `${SHOTS}/not-shown-${selector.replace(/[^a-z]+/gi, "-")}.png`,
      });
    },
  });
}

// A hook whose element is mostly covered by its own children still has to show some of a
// background set on it; anything above this share is plainly visible.
const MIN_VISIBLE_SHARE = 0.03;

vi.setConfig({ hookTimeout: 150_000, testTimeout: 120_000 });

describe("theme hooks on the chat screen", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
    await waitForWsMockInterception();
    // Warm the route chunks once so the real mounts start warm.
    try {
      const warmup = await mountApp("light", 80_000);
      await warmup.cleanup();
    } catch {
      // A still-cold mount fails loudly in the test itself.
    }
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
    // The stored-theme cases adopt an agent theme into `moss:theme`; leave no theme CSS behind
    // for the next file (the theme editor tests open their CSS box only when it is empty).
    localStorage.clear();
    applyThemeCss("");
    resetThemeSnapshotCacheForTests();
    window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    sendSettingsUpdate = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
    applyThemeCss("");
    settingsDialogStore.setState({ isOpen: false });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      shellSnapshotSequence: 0,
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
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
  });

  it("applies a theme published after the chat has opened without reloading", async () => {
    fixture = buildFixture();
    const app = await mountApp("light");
    try {
      await vi.waitFor(() => expect(sendSettingsUpdate).toBeTypeOf("function"));
      expect(document.documentElement.dataset.themeVariant).toBe("light");
      fixture = buildFixture({
        revision: "published-live",
        publishedAt: NOW_ISO,
        appearance: "dark",
        dark: {
          css: '[data-workspace-area="conversation"] { background-color: #294d3a !important; }',
        },
      });
      sendSettingsUpdate?.(fixture.serverSettings);

      await vi.waitFor(() => {
        expect(document.documentElement.dataset.themeVariant).toBe("dark");
        const conversation = document.querySelector('[data-workspace-area="conversation"]')!;
        expect(getComputedStyle(conversation).backgroundColor).toBe("rgb(41, 77, 58)");
      });
    } finally {
      await app.cleanup();
    }
  });

  afterEach(() => {
    applyThemeCss("");
    document.body.innerHTML = "";
  });

  for (const variant of ["light", "dark"] as const) {
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "narrow", width: 820, height: 900 },
    ]) {
      it(`a background on each chat hook shows (${variant}, ${viewport.name})`, async () => {
        fixture = buildFixture();
        await page.viewport(viewport.width, viewport.height);
        const mounted = await mountApp(variant);
        try {
          const results: Record<string, { boxed: boolean; share: number }> = {};
          for (const selector of CHAT_HOOKS) {
            // The sidebar collapses at narrow widths; it is proven at desktop width.
            if (viewport.name === "narrow" && /sidebar|thread-item/.test(selector)) continue;
            results[selector] = await measureHook(
              selector,
              OUTLINE_PROBED_HOOKS.has(selector)
                ? "outline"
                : MASK_PROBED_HOOKS.has(selector)
                  ? "mask"
                  : undefined,
            );
          }
          console.info(`chat hooks ${variant} ${viewport.name}`, JSON.stringify(results));
          for (const [selector, result] of Object.entries(results)) {
            expect.soft(result.boxed, `${selector} has a box`).toBe(true);
            expect
              .soft(result.share, `${selector} shows a background set on it`)
              .toBeGreaterThan(MASK_PROBED_HOOKS.has(selector) ? 0.6 : MIN_VISIBLE_SHARE);
          }
        } finally {
          await mounted.cleanup();
        }
      });
    }

    it(`a background on each Settings hook shows (${variant})`, async () => {
      fixture = buildFixture();
      await page.viewport(1440, 900);
      const mounted = await mountApp(variant);
      try {
        openSettings({ section: "appearance" });
        await vi.waitFor(
          () => {
            expect(firstBoxedElement("[data-settings-dialog]")).toBeTruthy();
            expect(firstBoxedElement('[data-slot="switch"]')).toBeTruthy();
            expect(firstBoxedElement('[data-slot="select-trigger"]')).toBeTruthy();
          },
          { timeout: 20_000, interval: 50 },
        );
        // Let the dialog's open animation settle before reading pixels.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const results: Record<string, { boxed: boolean; share: number }> = {};
        for (const selector of SETTINGS_HOOKS)
          results[selector] = await measureHook(
            selector,
            OUTLINE_PROBED_HOOKS.has(selector) ? "outline" : undefined,
          );
        console.info(`settings hooks ${variant}`, JSON.stringify(results));
        for (const [selector, result] of Object.entries(results)) {
          expect.soft(result.boxed, `${selector} has a box`).toBe(true);
          expect
            .soft(result.share, `${selector} shows a background set on it`)
            .toBeGreaterThan(MIN_VISIBLE_SHARE);
        }
      } finally {
        await mounted.cleanup();
      }
    });

    // The owner's stored theme from 2026-11-17, with a synthetic picture of the same size in
    // place of theirs. It must show without anyone asking the agent again.
    it(`the stored chat-background theme shows its picture at the bottom right (${variant})`, async () => {
      const picture = probeImageDataUrl(224, 336);
      const css =
        `[data-messages-timeline-root]{background-image:url(${picture}) !important;` +
        "background-repeat:no-repeat !important;" +
        "background-position:right 1.5rem bottom 1rem !important;" +
        "background-size:auto min(88vh,900px) !important;}";
      fixture = buildFixture({
        revision: "57ed73c9-91a5-4f9b-8c84-3a4de9001be2",
        publishedAt: "2026-11-17T04:37:08.081Z",
        light: { css },
        dark: { css },
      });
      await page.viewport(1440, 900);
      const mounted = await mountApp(variant);
      try {
        const root = document.querySelector<HTMLElement>('[data-messages-timeline-root="true"]');
        expect(root).toBeTruthy();
        await vi.waitFor(() => expect(getComputedStyle(root!).backgroundImage).toMatch(/^url\(/), {
          timeout: 10_000,
          interval: 50,
        });
        await waitForPaint();
        const box = root!.getBoundingClientRect();
        expect(getComputedStyle(root!).display).not.toBe("contents");
        expect(box.width).toBeGreaterThan(400);
        expect(box.height).toBeGreaterThan(400);
        const pixels = await captureViewportPixels();
        // A strip at the bottom right of the chat area, inside where the picture sits.
        const strip = {
          left: box.right - 24 - 120,
          top: box.bottom - 16 - 300,
          width: 100,
          height: 120,
        };
        expect(colorShare(pixels, strip)).toBeGreaterThan(0.6);
        // The left side of the chat area stays clear.
        expect(
          colorShare(pixels, { left: box.left + 8, top: box.top + 8, width: 60, height: 60 }),
        ).toBe(0);
        await page.screenshot({ path: `${SHOTS}/stored-chat-background-${variant}.png` });
        // The picture is a background, so the messages and the composer stay on top of it.
        for (const selector of ["[data-user-message-bubble]", ".chat-markdown p"]) {
          const text = document.querySelector<HTMLElement>(selector)!;
          const rect = text.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
          expect(hit && text.contains(hit), `${selector} is on top`).toBe(true);
        }
        const composer = document.querySelector<HTMLElement>("[data-composer-editor]")!;
        const composerRect = composer.getBoundingClientRect();
        expect(
          composer.contains(document.elementFromPoint(composerRect.left + 8, composerRect.top + 4)),
        ).toBe(true);
      } finally {
        await mounted.cleanup();
      }
    });

    // A picture file stored by moss_theme_set or Settings > Add picture, at full quality. The
    // settings carry only its reference; the route serves the bytes.
    it(`a stored picture file shows behind the chat at its natural size (${variant})`, async () => {
      const picture = await pngBytesOf(300, 450);
      const id = await themePictureId(picture);
      servedThemePictures.set(id, picture);
      const missing = `${"9".repeat(64)}.png`;
      const css =
        `[data-workspace-area="conversation"] { background: url(moss-theme-image:${id}) right 24px bottom 16px no-repeat !important; }\n` +
        `[data-chat-header] { background-image: url(moss-theme-image:${missing}) !important; }`;
      fixture = buildFixture({
        revision: "picture-file",
        publishedAt: "2026-11-17T06:00:00.000Z",
        light: { css },
        dark: { css },
      });
      expect(JSON.stringify(fixture.serverSettings).length).toBeLessThan(20_000);
      await page.viewport(1440, 900);
      const mounted = await mountApp(variant);
      try {
        const area = document.querySelector<HTMLElement>('[data-workspace-area="conversation"]')!;
        const address = `${window.location.origin}/api/theme-images/${id}`;
        await vi.waitFor(
          () => expect(getComputedStyle(area).backgroundImage).toBe(`url("${address}")`),
          {
            timeout: 10_000,
            interval: 50,
          },
        );
        // The picture loaded, from Moss's own route, at its natural size.
        const loaded = new Image();
        loaded.src = address;
        await loaded.decode();
        expect([loaded.naturalWidth, loaded.naturalHeight]).toEqual([300, 450]);
        await settleThemeChange();
        const pixels = await captureViewportPixels();
        const box = area.getBoundingClientRect();
        const painted = probeColorBounds(pixels, box);
        expect(painted).not.toBeNull();
        expect(Math.abs(painted!.width - 300)).toBeLessThanOrEqual(3);
        expect(Math.abs(painted!.height - 450)).toBeLessThanOrEqual(3);
        // A reference to a picture this computer does not have shows nothing and breaks nothing.
        expect(firstBoxedElement("[data-chat-header]")).toBeTruthy();
        expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      } finally {
        servedThemePictures.clear();
        await mounted.cleanup();
      }
    });

    // Screenshots for review with a real picture. Copy one to
    // apps/web/src/components/__screenshots__/theme-picture-fixture.png (git ignores it) to run.
    it(`a real picture file behind the chat, for review (${variant})`, async (context) => {
      const response = await fetch(
        new URL("./__screenshots__/theme-picture-fixture.png", import.meta.url),
      ).catch(() => null);
      const bytes =
        response?.ok && response.headers.get("content-type")?.startsWith("image/")
          ? new Uint8Array(await response.arrayBuffer())
          : null;
      if (!bytes) {
        context.skip();
        return;
      }
      const id = await themePictureId(bytes);
      servedThemePictures.set(id, bytes);
      const css = `[data-workspace-area="conversation"] { background: url(moss-theme-image:${id}) right 1.5rem bottom 1rem / auto min(88vh, 900px) no-repeat !important; }`;
      fixture = buildFixture({
        revision: "picture-review",
        publishedAt: "2026-11-17T06:00:00.000Z",
        light: { css },
        dark: { css },
      });
      await page.viewport(1440, 900);
      const mounted = await mountApp(variant);
      try {
        const loaded = new Image();
        loaded.src = `${window.location.origin}/api/theme-images/${id}`;
        await loaded.decode();
        expect(loaded.naturalWidth).toBeGreaterThan(0);
        await settleThemeChange();
        await page.screenshot({ path: `${SHOTS}/picture-file-${variant}.png` });
      } finally {
        servedThemePictures.clear();
        await mounted.cleanup();
      }
    });
  }
});
