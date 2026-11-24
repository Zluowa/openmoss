// FILE: ChatView.geometry.browser.tsx
// Purpose: Full-app ChatView browser tests for the [geometry:linux] cases (pixel and layout checks run in the geometry lane).
//          The shared fixture is src/test/chatViewBrowserHarness.tsx; every ChatView.*.browser.tsx
//          keeps the one suite name, so case names (and the CI partitions) are unchanged.

import { MessageId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_VIEWPORT_MATRIX,
  DEFAULT_VIEWPORT,
  TEXT_VIEWPORT_MATRIX,
  THREAD_ID,
  type UserRowMeasurement,
  createSnapshotForTargetUser,
  createSnapshotWithLongAssistantResponse,
  mountChatView,
  withProjectScripts,
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

  // Other widths are covered by the resize test below, which checks that the
  // collapsed row keeps the same height across the whole viewport matrix.
  it.each([TEXT_VIEWPORT_MATRIX[0]])(
    "[geometry:linux] clamps long user messages to twelve rendered lines at the $name viewport",
    async (viewport) => {
      const userText = "x".repeat(3_200);
      const targetMessageId = `msg-user-target-long-${viewport.name}` as MessageId;
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

      try {
        await mounted.measureUserRow(targetMessageId);
        const row = document.querySelector<HTMLElement>(
          `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
        )!;
        const clamp = row.querySelector<HTMLElement>('[data-user-message-clamp="true"]')!;
        expect(clamp).toBeTruthy();
        const text = clamp.firstElementChild!;
        const lineHeightPx = Number.parseFloat(getComputedStyle(text).lineHeight);
        expect(lineHeightPx).toBeGreaterThan(0);
        expect(clamp.scrollHeight).toBeGreaterThan(clamp.clientHeight);
        expect(
          Math.abs(clamp.getBoundingClientRect().height - 12 * lineHeightPx),
        ).toBeLessThanOrEqual(1);
        expect(row.querySelector('button[aria-expanded="false"]')?.textContent).toBe("Show more");
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("[geometry:linux] tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-resize" as MessageId;
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const measurements: UserRowMeasurement[] = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        measurements.push(measurement);
      }

      expect(
        new Set(measurements.map((measurement) => Math.round(measurement.timelineWidthMeasuredPx)))
          .size,
      ).toBeGreaterThanOrEqual(3);

      const byMeasuredWidth = measurements.toSorted(
        (left, right) => left.timelineWidthMeasuredPx - right.timelineWidthMeasuredPx,
      );
      const narrowest = byMeasuredWidth[0]!;
      const widest = byMeasuredWidth.at(-1)!;
      expect(narrowest.timelineWidthMeasuredPx).toBeLessThan(widest.timelineWidthMeasuredPx);
      // Both widths exceed the 12-line limit, so the collapsed row stays the same height.
      expect(
        Math.abs(narrowest.measuredRowHeightPx - widest.measuredRowHeightPx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] collapses header actions into overflow before they can overlap the thread title", async () => {
    const longTitle =
      'remove "ago" from the sidebar while the diff panel stays open on smaller viewports';
    const headerOverflowSnapshot = (() => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-overflow-target" as MessageId,
        targetText: "header overflow",
      });

      return withProjectScripts(
        {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { title: longTitle }) : thread,
          ),
        },
        [
          {
            id: "dev-server",
            name: "Dev",
            command: "bun run dev",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      );
    })();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: headerOverflowSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await vi.waitFor(
        () => {
          const title = document.querySelector<HTMLElement>(`h2[title='${longTitle}']`);
          const overflowButton = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle environment panel"]',
          );

          expect(title, "Unable to find the chat header title.").toBeTruthy();
          expect(overflowButton, "Unable to find the header overflow trigger.").toBeTruthy();

          const titleRight = title!.getBoundingClientRect().right;
          const actionsLeft = overflowButton!.getBoundingClientRect().left;
          expect(titleRight).toBeLessThanOrEqual(actionsLeft + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] keeps the composer visible while a long assistant response forces a viewport relayout", async () => {
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotWithLongAssistantResponse(),
    });

    try {
      const desktopLayout = await mounted.measureLayout();
      expect(desktopLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(desktopLayout.scrollHeightPx).toBeGreaterThan(desktopLayout.scrollClientHeightPx);
      expect(desktopLayout.composerBottomPx).toBeLessThanOrEqual(desktopLayout.hostHeightPx + 1);

      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[2]);
      const mobileLayout = await mounted.measureLayout();
      expect(mobileLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(mobileLayout.scrollHeightPx).toBeGreaterThan(mobileLayout.scrollClientHeightPx);
      expect(mobileLayout.composerBottomPx).toBeLessThanOrEqual(mobileLayout.hostHeightPx + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(ATTACHMENT_VIEWPORT_MATRIX)(
    "[geometry:linux] keeps user attachments inside their rendered row at the $name viewport",
    async (viewport) => {
      const targetMessageId = `msg-user-target-attachments-${viewport.name}` as MessageId;
      const userText = "message with image attachments";
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

      try {
        await mounted.measureUserRow(targetMessageId);
        const row = document.querySelector<HTMLElement>(
          `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
        )!;
        const rowRect = row.getBoundingClientRect();
        const thumbnails = Array.from(
          row.querySelectorAll<HTMLButtonElement>('button[aria-label^="Preview "]'),
        );
        expect(thumbnails).toHaveLength(3);
        const rects = thumbnails.map((thumbnail) => thumbnail.getBoundingClientRect());
        for (const rect of rects) {
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.left).toBeGreaterThanOrEqual(rowRect.left - 1);
          expect(rect.right).toBeLessThanOrEqual(rowRect.right + 1);
          expect(rect.top).toBeGreaterThanOrEqual(rowRect.top - 1);
          expect(rect.bottom).toBeLessThanOrEqual(rowRect.bottom + 1);
        }
        expect(
          Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top)),
        ).toBeLessThanOrEqual(1);
      } finally {
        await mounted.cleanup();
      }
    },
  );
});
