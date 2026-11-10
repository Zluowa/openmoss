// FILE: MessagesTimeline.perf.browser.tsx
// Purpose: Measures a long transcript the way the desktop-chat comparison needs: mount time,
//   rows and DOM nodes kept mounted, action bars mounted before any hover, and long frames
//   while scrolling top to bottom. Writes the numbers to .tmp/ui-parity/transcript-perf.json
//   and asserts only the budgets that keep long chats cheap.
import "../../index.css";

import { MessageId } from "@moss/contracts";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const MESSAGE_PAIRS = 200;

function reply(index: number): string {
  return [
    `Reply ${index}: here is what changed in the **parser** and why.`,
    "",
    "- Reads the header once",
    "- Skips empty lines",
    "- Keeps the offsets stable",
    "",
    "```ts",
    `export function step${index}(input: string): number {`,
    "  return input.trim().length;",
    "}",
    "```",
    "",
    "That keeps the hot path short. ".repeat(6),
  ].join("\n");
}

function entries() {
  const start = Date.parse("2026-11-04T08:00:00.000Z");
  return Array.from({ length: MESSAGE_PAIRS }, (_, index) => {
    const at = (offset: number) => new Date(start + (index * 2 + offset) * 60_000).toISOString();
    return [
      {
        id: `user-${index}`,
        kind: "message" as const,
        createdAt: at(0),
        message: {
          id: MessageId.makeUnsafe(`user-${index}`),
          role: "user" as const,
          text: `Question ${index}: can you tidy the parser step ${index}?`,
          createdAt: at(0),
          streaming: false,
        },
      },
      {
        id: `assistant-${index}`,
        kind: "message" as const,
        createdAt: at(1),
        message: {
          id: MessageId.makeUnsafe(`assistant-${index}`),
          role: "assistant" as const,
          text: reply(index),
          createdAt: at(1),
          streaming: false,
        },
      },
    ];
  }).flat();
}

it("keeps a 400-message transcript cheap to mount and scroll", async () => {
  const timelineEntries = entries();
  const now = timelineEntries.at(-1)!.createdAt;
  const startedAt = performance.now();
  const result = await render(
    <div style={{ width: 860, height: 760 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={timelineEntries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={now}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>,
  );
  try {
    await expect
      .poll(() => document.body.textContent?.includes(`Reply ${MESSAGE_PAIRS - 1}:`))
      .toBe(true);
    await nextFrame();
    const mountMs = performance.now() - startedAt;
    const transcript = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
    const countMounted = () => ({
      messageRows: transcript.querySelectorAll("[data-message-id]").length,
      domNodes: transcript.querySelectorAll("*").length,
      actionBars: transcript.querySelectorAll("[data-message-action-row]").length,
      actionPlaceholders: transcript.querySelectorAll("[data-message-actions-placeholder]").length,
    });
    const atBottom = countMounted();

    let maxMounted = countMounted();
    // Scroll from the top in fixed steps, one step per frame, and time the frames.
    const scrollPass = async (step: (viewport: number) => number, limit: number) => {
      transcript.scrollTop = 0;
      await nextFrame();
      await nextFrame();
      const frameTimes: number[] = [];
      let previous = await nextFrame();
      for (let top = 0; top <= transcript.scrollHeight && frameTimes.length < limit; ) {
        top += step(transcript.clientHeight);
        transcript.scrollTop = top;
        const stamp = await nextFrame();
        frameTimes.push(stamp - previous);
        previous = stamp;
        const mounted = countMounted();
        if (mounted.domNodes > maxMounted.domNodes) maxMounted = mounted;
      }
      const sorted = [...frameTimes].sort((left, right) => left - right);
      return {
        frames: frameTimes.length,
        frameMsMedian: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        frameMsP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        longFrames: frameTimes.filter((time) => time > 50).length,
      };
    };
    // A mouse wheel moves about 120px a frame; a scrollbar drag jumps whole screens.
    const wheel = await scrollPass(() => 120, 400);
    const jumps = await scrollPass((viewport) => viewport, 400);
    const metrics = {
      messages: timelineEntries.length,
      mountMs: Math.round(mountMs),
      atBottom,
      maxMountedWhileScrolling: maxMounted,
      wheel,
      jumps,
    };
    await commands.writeFile(
      "../../.tmp/ui-parity/transcript-perf.json",
      `${JSON.stringify(metrics, null, 2)}\n`,
    );

    // Virtualized: a small window of rows, not the whole chat.
    expect(maxMounted.messageRows).toBeLessThan(80);
    // Action bars wait for a hover: far fewer bars than mounted messages.
    expect(atBottom.actionBars).toBeLessThan(atBottom.messageRows);
  } finally {
    await result.unmount();
  }
});
