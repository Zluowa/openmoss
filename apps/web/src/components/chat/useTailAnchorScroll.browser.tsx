import { MessageId, TurnId } from "@synara/contracts";
import { useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { deriveTimelineEntries, type WorkLogEntry } from "../../session-logic";
import type { ChatMessage, ProposedPlan } from "../../types";

import { useTailAnchorScroll } from "./useTailAnchorScroll";

const ANCHOR_ID = MessageId.makeUnsafe("delayed-steer");

function DelayedLayout({
  contentRevision,
  messageRevision,
  onFinished,
  anchorScrollInFlightRef,
  animateAnchorSlide = false,
  responseHeight = 180,
  entryTransformOrigin,
}: {
  contentRevision: unknown;
  messageRevision: unknown;
  onFinished: () => void;
  anchorScrollInFlightRef?: RefObject<boolean>;
  animateAnchorSlide?: boolean;
  responseHeight?: number;
  entryTransformOrigin?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef({ getScrollableNode: (): HTMLElement => containerRef.current! });
  useTailAnchorScroll({
    listRef,
    timelineRootRef: rootRef,
    anchorMessageId: ANCHOR_ID,
    animateAnchorSlide,
    anchorScrollInFlightRef,
    contentChangeSignal: contentRevision,
    messageChangeSignal: messageRevision,
    onAnchorSlideFinished: onFinished,
  });
  return (
    <div ref={rootRef}>
      <div
        ref={containerRef}
        data-testid="viewport"
        style={{ height: 200, overflow: "auto", overflowAnchor: "none" }}
      >
        <div data-testid="delayed-content" style={{ height: 300 }} />
        <div
          data-message-id={ANCHOR_ID}
          className={entryTransformOrigin ? "chat-message-send-enter" : undefined}
          style={{
            height: 20,
            ...(entryTransformOrigin
              ? {
                  animation: "none",
                  transform: "translateY(3px) scale(0.992)",
                  transformOrigin: entryTransformOrigin,
                }
              : {}),
          }}
        />
        <div data-testid="response" style={{ height: responseHeight }} />
      </div>
    </div>
  );
}

it("holds a steer while newly received content is still waiting for layout", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={0} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
    const anchor = host.querySelector<HTMLElement>(`[data-message-id="${ANCHOR_ID}"]`)!;
    const offset = () => anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    // A new chunk reaches React before deferred Markdown changes the row height.
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={1} messageRevision={1} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinished).not.toHaveBeenCalled();

    host.querySelector<HTMLElement>('[data-testid="delayed-content"]')!.style.height = "350px";
    await vi.advanceTimersByTimeAsync(16);
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "ends a maximum hold during overflow confirmation without overriding detached=%s",
  async (detached) => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onFinished = vi.fn();
    const anchorScrollInFlightRef = { current: false };
    try {
      const renderRevision = (revision: number) =>
        flushSync(() =>
          root.render(
            <DelayedLayout
              contentRevision={0}
              messageRevision={revision}
              onFinished={onFinished}
              anchorScrollInFlightRef={anchorScrollInFlightRef}
            />,
          ),
        );
      renderRevision(0);
      // Message arrivals keep the hold active. Their deferred Markdown layout can
      // finish just before its hard deadline, without another message arriving.
      for (let revision = 1; revision <= 8; revision += 1) {
        await vi.advanceTimersByTimeAsync(350);
        renderRevision(revision);
      }
      await vi.advanceTimersByTimeAsync(195);
      expect(onFinished).not.toHaveBeenCalled();
      const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
      if (detached) {
        // ChatTranscriptScroll clears this shared ownership ref synchronously on
        // wheel, pointer, touch, and keyboard navigation before React rerenders.
        anchorScrollInFlightRef.current = false;
        viewport.scrollTop = 100;
      }
      host.querySelector<HTMLElement>('[data-testid="response"]')!.style.height = "2000px";
      // One mutation correction and one frame straddle the 3s hold deadline,
      // before the usual three-frame overflow confirmation can finish.
      await vi.advanceTimersByTimeAsync(16);
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(anchorScrollInFlightRef.current).toBe(false);
      if (detached) expect(viewport.scrollTop).toBe(100);
      else
        expect(
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        ).toBeLessThanOrEqual(1);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  },
);

it("releases a glide at its deadline when no reserve can make the anchor reachable", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  const anchorScrollInFlightRef = { current: false };
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout
          contentRevision={0}
          messageRevision={0}
          onFinished={onFinished}
          anchorScrollInFlightRef={anchorScrollInFlightRef}
          animateAnchorSlide
          responseHeight={0}
        />,
      ),
    );
    await vi.advanceTimersByTimeAsync(2_992);
    expect(onFinished).not.toHaveBeenCalled();
    expect(anchorScrollInFlightRef.current).toBe(true);
    await vi.advanceTimersByTimeAsync(16);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(anchorScrollInFlightRef.current).toBe(false);
    const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(
      1,
    );
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

it.each(["50% 0px", "50% 20px"])(
  "starts a reachable glide while the send decoration transforms around %s",
  async (transformOrigin) => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onFinished = vi.fn();
    try {
      flushSync(() =>
        root.render(
          <DelayedLayout
            contentRevision={0}
            messageRevision={0}
            onFinished={onFinished}
            animateAnchorSlide
            entryTransformOrigin={transformOrigin}
          />,
        ),
      );
      const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
      const anchor = host.querySelector<HTMLElement>(`[data-message-id="${ANCHOR_ID}"]`)!;
      // Freeze the actual send-entry transform at its opening pose. Its visual
      // displacement does not change the native reserve or the layout target.
      // The glide must not wait for this decoration to finish before starting.
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      expect(maxScrollTop).toBe(300);
      await vi.advanceTimersByTimeAsync(240);
      expect(viewport.scrollTop).toBeGreaterThan(200);
      expect(viewport.scrollTop).toBeLessThan(maxScrollTop);
      await vi.advanceTimersByTimeAsync(320);
      expect(viewport.scrollTop).toBe(maxScrollTop);
      // The hook preserves the visual affordance instead of disabling it to
      // make the row appear reachable.
      expect(anchor.style.transform).toBe("translateY(3px) scale(0.992)");
      expect(
        anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      ).toBeGreaterThan(3 - 0.01);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  },
);

it("does not let tool or work activity extend the anchor hold", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={0} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(onFinished).not.toHaveBeenCalled();

    // Tool or work activity updates the full timeline without a new message.
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={1} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(onFinished).not.toHaveBeenCalled();

    // The original message hold window should expire; the work activity did not restart it.
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinished).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

const SEGMENT_DATE = "2026-09-13T00:00:00.000Z";
const segmentedMessages: ChatMessage[] = [
  {
    id: MessageId.makeUnsafe("segmented-assistant"),
    role: "assistant",
    text: "ABCD",
    createdAt: SEGMENT_DATE,
    turnId: TurnId.makeUnsafe("plan-turn"),
    streaming: false,
    textSegments: ["A", "B", "C", "D"].map((text, index) => ({
      text,
      sequence: index * 10,
      startedAt: SEGMENT_DATE,
      endedAt: SEGMENT_DATE,
    })),
  },
];
const segmentPlans: ProposedPlan[] = [
  {
    id: "plan",
    turnId: TurnId.makeUnsafe("plan-turn"),
    planMarkdown: "# Plan",
    createdAt: SEGMENT_DATE,
    updatedAt: SEGMENT_DATE,
    implementedAt: null,
    implementationThreadId: null,
  },
];
const segmentWork: WorkLogEntry = {
  id: "intervening-tool",
  label: "Running tool",
  tone: "tool",
  sequence: 15,
  createdAt: SEGMENT_DATE,
};

function SourceMessageLayout({
  messages,
  plans,
  work,
  onFinished,
}: {
  messages: ChatMessage[];
  plans: ProposedPlan[];
  work: WorkLogEntry[];
  onFinished: () => void;
}) {
  // Match ChatView: the message signal comes from the source array, before
  // plans and work rows clone or split its presentation entries.
  const entries = deriveTimelineEntries(messages, plans, work);
  return (
    <DelayedLayout contentRevision={entries} messageRevision={messages} onFinished={onFinished} />
  );
}

it.each(["plan-linked segment clones", "late tool insertion"])(
  "releases the message hold despite %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onFinished = vi.fn();
    const plans = scenario === "plan-linked segment clones" ? segmentPlans : [];
    const initialWork = scenario === "plan-linked segment clones" ? [segmentWork] : [];
    try {
      flushSync(() =>
        root.render(
          <SourceMessageLayout
            messages={segmentedMessages}
            plans={plans}
            work={initialWork}
            onFinished={onFinished}
          />,
        ),
      );
      await vi.advanceTimersByTimeAsync(400);
      flushSync(() =>
        root.render(
          <SourceMessageLayout
            messages={segmentedMessages}
            plans={plans}
            work={[{ ...segmentWork, label: "Tool completed" }]}
            onFinished={onFinished}
          />,
        ),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(onFinished).toHaveBeenCalledTimes(1);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  },
);
