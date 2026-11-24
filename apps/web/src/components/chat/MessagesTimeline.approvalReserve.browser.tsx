// FILE: MessagesTimeline.approvalReserve.browser.tsx
// Purpose: Walk row WALK-H1 H-2. In a fresh chat the person sends a message, the
//          agent thinks, then its first approval card comes up above the composer.
//          The transcript must keep the sent message and the work so far in view
//          above the card; it used to scroll them off the top and leave about
//          290 px of blank space between the last row and the composer.
// Layer: Vitest browser tests
//
// The harness wires the same parts ChatView does: the measured composer overlay
// (useComposerOverlayHeight) becomes the transcript's bottom inset, the real
// transcript-scroll hook reacts to that inset, and the approval card is the real
// ComposerPendingApprovalPanel inside the overlay. ChatView.browser.tsx is not
// used: it is frozen while it is split (PR #891).

import "../../index.css";

import { ApprovalRequestId, MessageId, ThreadId, TurnId } from "@moss/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import type { PendingApproval } from "../../pendingInteractionDerivation";
import type { TimelineEntry } from "../../session-logic";
import {
  WORK_RUN_TURN_ID,
  workRunActivities,
  workRunEntries,
} from "../../test/fixtures/providerWorkRun.fixture";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { composerTranscriptBottomInsetPx, useComposerOverlayHeight } from "./composerOverlay";
import { MessagesTimeline } from "./MessagesTimeline";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

// The walker's window: a fresh profile opens at the desktop default, 1100 × 780.
const WINDOW_WIDTH_PX = 1100;
const WINDOW_HEIGHT_PX = 780;
// The chat header above the transcript.
const HEADER_HEIGHT_PX = 48;
// The idle composer (editor plus footer row) floating over the transcript bottom.
const COMPOSER_HEIGHT_PX = 120;

const THREAD_ID = ThreadId.makeUnsafe("thread-walk-h1");
const TURN_ID = TurnId.makeUnsafe(WORK_RUN_TURN_ID);
const SENT_MESSAGE_ID = MessageId.makeUnsafe("walk-h1-full-message");
const SENT_TEXT =
  "帮我看看这个项目，读一下说明，给 index.js 加减法和乘法，再看看 missing.txt [[WALK:FULL]]";

const FIRST_APPROVAL: PendingApproval = {
  requestId: ApprovalRequestId.makeUnsafe("walk-h1-approval-1"),
  lifecycleGeneration: "walk-h1-generation",
  requestKind: "command",
  createdAt: "2026-11-24T11:45:03.000Z",
  detail: "Get-ChildItem -Name",
};

function sentMessage(): TimelineEntry {
  return {
    id: "entry-walk-h1-sent",
    kind: "message",
    createdAt: "2026-11-24T11:45:00.000Z",
    message: {
      id: SENT_MESSAGE_ID,
      role: "user",
      text: SENT_TEXT,
      turnId: TURN_ID,
      createdAt: "2026-11-24T11:45:00.000Z",
      streaming: false,
    },
  };
}

function reasoningEntries(): TimelineEntry[] {
  return workRunEntries(
    workRunActivities(
      "codex",
      [{ kind: "think", text: "**查看项目结构**\n\n先列出目录，再读 README.md。" }],
      Date.UTC(2026, 10, 24, 11, 45, 1),
    ),
  ).map((entry) => ({
    id: `entry-${entry.id}`,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
}

interface WalkHandle {
  send: () => void;
  think: () => void;
  requestApproval: () => void;
  listRef: React.RefObject<LegendListRef | null>;
}

function WalkH1Chat({ handleRef }: { handleRef: { current: WalkHandle | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [tailAnchorMessageId, setTailAnchorMessageId] = useState<MessageId | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const isWorking = entries.length > 0;
  const { overlayRef, overlayHeightPx, overlayBottomClearancePx } = useComposerOverlayHeight();
  const insetPx = composerTranscriptBottomInsetPx(overlayHeightPx);
  const scroll = useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: entries,
    hasStreamingAssistantText: false,
    composerTranscriptInsetPx: insetPx,
    isInactiveSplitPane: false,
  });

  handleRef.current = {
    listRef,
    send: () => {
      setEntries([sentMessage()]);
      setTailAnchorMessageId(SENT_MESSAGE_ID);
    },
    think: () => setEntries((current) => [...current, ...reasoningEntries()]),
    requestApproval: () => setApproval(FIRST_APPROVAL),
  };

  return (
    <div style={{ height: WINDOW_HEIGHT_PX - HEADER_HEIGHT_PX, position: "relative" }}>
      <MessagesTimeline
        hasMessages={entries.length > 0}
        isWorking={isWorking}
        suppressWorkingIndicator={approval?.requestKind === "command"}
        awaitingUser={approval !== null}
        activeTurnInProgress={isWorking}
        activeTurnId={TURN_ID}
        activeTurnStartedAt={isWorking ? "2026-11-24T11:45:00.000Z" : null}
        listRef={listRef}
        tailAnchorMessageId={tailAnchorMessageId}
        tailAnchorScrollInFlightRef={scroll.tailAnchorScrollInFlightRef}
        followLiveOutput={!scroll.isUserScrollDetached}
        onIsAtEndChange={scroll.onIsAtEndChange}
        onMessagesScroll={scroll.onMessagesScrollBase}
        onMessagesWheel={scroll.onMessagesWheelBase}
        timelineEntries={entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-11-24T11:45:05.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        contentInsetBottomPx={insetPx}
        contentInsetBottomClearancePx={overlayBottomClearancePx}
      />
      <div
        ref={overlayRef}
        data-walk-composer-overlay="true"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      >
        {approval ? (
          <ComposerPendingApprovalPanel
            approval={approval}
            pendingCount={1}
            isResponding={false}
            onRespond={async () => {}}
          />
        ) : null}
        <div className="chat-composer-surface" style={{ height: COMPOSER_HEIGHT_PX }}>
          <div data-chat-composer-footer="true" style={{ height: 40 }} />
        </div>
      </div>
    </div>
  );
}

function nextPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function scrollContainer(handle: WalkHandle): HTMLElement {
  const node: unknown = handle.listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) throw new Error("scroll container not available");
  return node;
}

function overlay(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-walk-composer-overlay="true"]')!;
}

/** What a person sees in one frame: where the sent message is, and the blank above the composer. */
function measure(handle: WalkHandle) {
  const container = scrollContainer(handle);
  const viewportTop = container.getBoundingClientRect().top;
  const composerTop = overlay().getBoundingClientRect().top;
  const sent = document.querySelector<HTMLElement>(`[data-message-id="${SENT_MESSAGE_ID}"]`);
  const sentRect = sent?.getBoundingClientRect() ?? null;
  const reasoning = container.querySelector<HTMLElement>('[data-timeline-row-kind="reasoning"]');
  const reasoningRect = reasoning?.getBoundingClientRect() ?? null;
  // The lowest painted transcript content: the bottom of every rendered row's
  // content (not LegendList's own containers, which span reserved space too).
  let contentBottom = viewportTop;
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-message-id], [data-timeline-row-kind]",
  )) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0) contentBottom = Math.max(contentBottom, rect.bottom);
  }
  return {
    sentTopFromViewportTop: sentRect ? sentRect.top - viewportTop : null,
    sentVisible: sentRect !== null && sentRect.bottom > viewportTop && sentRect.top < composerTop,
    reasoningTopFromViewportTop: reasoningRect ? reasoningRect.top - viewportTop : null,
    reasoningVisible:
      reasoningRect !== null &&
      reasoningRect.top >= viewportTop &&
      reasoningRect.bottom <= composerTop,
    blankAboveComposerPx: Math.max(0, composerTop - contentBottom),
    composerTop,
  };
}

describe("MessagesTimeline approval reserve", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("WALK-H1 H-2: the first approval card leaves the sent message and the work above it, with no blank scroll", async () => {
    await page.viewport(WINDOW_WIDTH_PX, WINDOW_HEIGHT_PX);
    const handleRef: { current: WalkHandle | null } = { current: null };
    const screen = await render(<WalkH1Chat handleRef={handleRef} />);
    const handle = () => {
      if (!handleRef.current) throw new Error("harness not mounted");
      return handleRef.current;
    };

    try {
      // 1) Send the full message in the fresh chat; the turn runs.
      handle().send();
      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      const topGapPx =
        Number.parseFloat(getComputedStyle(scrollContainer(handle())).paddingTop) || 0;
      const anchoredAtTop = () => {
        const { sentTopFromViewportTop } = measure(handle());
        return sentTopFromViewportTop !== null && Math.abs(sentTopFromViewportTop - topGapPx) <= 1;
      };

      // The agent starts thinking.
      await expect.poll(anchoredAtTop, { timeout: 5_000 }).toBe(true);
      handle().think();
      await expect
        .poll(() => document.querySelectorAll('[data-timeline-row-kind="reasoning"]').length, {
          timeout: 5_000,
        })
        .toBeGreaterThan(0);
      await expect.poll(anchoredAtTop, { timeout: 5_000 }).toBe(true);
      // Let the transcript come fully to rest before the card arrives.
      for (let frame = 0; frame < 30; frame += 1) await nextPaintedFrame();
      const before = measure(handle());
      expect(before.sentVisible).toBe(true);
      expect(before.reasoningVisible).toBe(true);

      // 2) The first approval card comes up above the composer. Every painted
      //    frame from here on is what the person sees while the card waits.
      handle().requestApproval();
      const frames: ReturnType<typeof measure>[] = [];
      for (let frame = 0; frame < 45; frame += 1) {
        await nextPaintedFrame();
        frames.push(measure(handle()));
      }
      await expect.element(page.getByRole("button", { name: /Allow once/u })).toBeVisible();
      const after = frames.at(-1)!;
      const cardGrowthPx = before.composerTop - after.composerTop;
      // The real card grows the measured composer overlay by its own height.
      expect(cardGrowthPx).toBeGreaterThan(100);

      console.info(
        `WALK-H1 H-2: card ${Math.round(cardGrowthPx)} px; blank above composer ${Math.round(
          before.blankAboveComposerPx,
        )} → ${Math.round(after.blankAboveComposerPx)} px; sent message top ${Math.round(
          before.sentTopFromViewportTop ?? Number.NaN,
        )} → ${Math.round(after.sentTopFromViewportTop ?? Number.NaN)} px`,
      );

      // The sent message stays where it was, at the top, in every frame once the
      // card has been measured (no frame scrolls it away and back).
      const measuredFrames = frames.filter(
        (frame) => Math.abs(frame.composerTop - after.composerTop) <= 1,
      );
      expect(measuredFrames.length).toBeGreaterThan(30);
      for (const frame of measuredFrames) {
        expect(frame.sentVisible).toBe(true);
        expect(
          Math.abs((frame.sentTopFromViewportTop ?? Number.NaN) - topGapPx),
        ).toBeLessThanOrEqual(1);
        // The work so far stays where it was, fully above the card.
        expect(frame.reasoningVisible).toBe(true);
        expect(
          Math.abs(
            (frame.reasoningTopFromViewportTop ?? Number.NaN) -
              (before.reasoningTopFromViewportTop ?? Number.NaN),
          ),
        ).toBeLessThanOrEqual(1);
        // The card's height comes out of the blank below the work, so the blank
        // shrinks instead of the content being scrolled away to make room.
        expect(frame.blankAboveComposerPx).toBeLessThan(before.blankAboveComposerPx - 100);
      }
    } finally {
      await screen.unmount();
    }
  });
});
