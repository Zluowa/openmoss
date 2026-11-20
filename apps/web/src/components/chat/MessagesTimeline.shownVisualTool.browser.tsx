// FILE: MessagesTimeline.shownVisualTool.browser.tsx
// Purpose: A 「已生成图表」 tool row (`moss_show_visual`) opens onto the chart it published,
//          never onto the tool's JSON reply to the agent, a `json null` pane or the
//          「部分 MCP 结果内容已截断」 note. Payloads are the owner's 2026-11-20 chat (trimmed).
// Layer: Browser UI test

import "../../index.css";

import { MessageId, type NativeApi, ThreadId, TurnId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import type { TimelineEntry } from "../../session-logic";
import { makeActivity } from "../../storeTestFixtures";
import { deriveWorkLogEntries } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";

vi.mock("~/env", () => ({ isElectron: true }));

const THREAD_ID = ThreadId.makeUnsafe("d939cf4a-a0dc-43ff-a386-327bcc7a787d");
const TURN_ID = "01a1f850-a8ee-7103-9d25-d0316a821026";
const VISUAL_ID = "vis_62243c837266e6cba034f0eb2ac68ec8";
const TITLE = "雨蚁 × ONE｜可点击的会后执行看板";
const SOURCE =
  'root = Card([header])\nheader = CardHeader("雨蚁 × ONE｜会后执行看板", "2026 年 11 月 8 日")';
const EMBED = "```moss-visual\n" + VISUAL_ID + "\n```";

const visualShown = makeActivity({
  id: "gateway:62243c837266e6cba034f0eb2ac68ec8:inline-visual",
  createdAt: "2026-11-20T09:40:36.489Z",
  kind: "moss-visual.shown",
  summary: `Visual: ${TITLE}`,
  tone: "info",
  turnId: TURN_ID,
  sequence: 887,
  payload: {
    visualId: VISUAL_ID,
    format: "openui",
    title: TITLE,
    height: 320,
    byteLength: 14340,
    sha256: "20f4b3306d63f310e455f3c95802dd6810ea17e1949fe97e20a649dfb7739bd6",
  },
});

// The tool call as Codex reported it: the large `openui` argument made Moss shorten the
// record (`truncation.truncated`), and Codex sends `structuredContent: null`.
const toolCompleted = makeActivity({
  id: "7628fdaa-7b83-4c6e-a96b-f1c5cf9d5f46",
  createdAt: "2026-11-20T09:40:38.370Z",
  kind: "tool.completed",
  summary: "Moss: Moss Show Visual",
  tone: "tool",
  turnId: TURN_ID,
  sequence: 9370,
  payload: {
    itemType: "mcp_tool_call",
    status: "completed",
    title: "Moss: Moss Show Visual",
    data: {
      kind: "codex.mcp_tool_call",
      version: 1,
      callId: "exec-fbe213b2-3768-48b5-b0ca-50ad98f7f3a5",
      server: "moss",
      tool: "moss_show_visual",
      status: "completed",
      durationMs: 17,
      arguments: { title: TITLE, openui: SOURCE },
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                visualId: VISUAL_ID,
                title: TITLE,
                embed: EMBED,
                message: `Place the visual in your reply by writing this block on its own lines where it belongs:\n${EMBED}\nState the key finding in words around it; do not describe the visual or say where it is.`,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: null,
      },
      truncation: { truncated: true, deferredBinary: false, originalJsonChars: 10001 },
    },
  },
});

function timelineEntries(): TimelineEntry[] {
  const work = deriveWorkLogEntries([visualShown, toolCompleted], undefined).map(
    (entry): TimelineEntry => ({ id: entry.id, kind: "work", createdAt: entry.createdAt, entry }),
  );
  return [
    ...work,
    {
      id: "entry-reply",
      kind: "message",
      createdAt: "2026-11-20T09:41:25.640Z",
      message: {
        id: MessageId.makeUnsafe("assistant:reply"),
        role: "assistant",
        text: `已重新生成看板。\n\n${EMBED}\n\n新版通过了 Moss 的组件校验。`,
        createdAt: "2026-11-20T09:41:25.640Z",
        streaming: false,
        turnId: TurnId.makeUnsafe(TURN_ID),
      },
    },
  ];
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

it("opens 已生成图表 onto the chart, not the tool's JSON", async () => {
  vi.stubGlobal("nativeApi", {
    orchestration: {
      getInlineVisual: vi.fn(async () => ({ visualId: VISUAL_ID, html: SOURCE })),
    },
  } as unknown as NativeApi);
  const client = new QueryClient();
  const screen = await render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="zh-CN">
        <div style={{ width: 760, height: 900 }}>
          <MessagesTimeline
            hasMessages
            isWorking={false}
            activeTurnInProgress={false}
            activeTurnStartedAt={null}
            threadId={THREAD_ID}
            timelineEntries={timelineEntries()}
            turnDiffSummaryByAssistantMessageId={new Map()}
            nowIso="2026-11-20T09:42:00.000Z"
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
        </div>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
  cleanup = async () => {
    await screen.unmount();
    client.clear();
  };

  // The settled turn folds its work under its header; open it as a person would.
  const turnHeader = page.getByRole("button", { name: /已工作|之前的/u });
  if ((await turnHeader.all()).length > 0) await turnHeader.first().click();
  const row = page.getByRole("button", { name: "已生成图表", exact: true });
  await expect.element(row).toBeVisible();
  await row.click();

  const result = page.getByTestId("shown-visual-result");
  await expect.element(result).toBeVisible();
  // The chart itself: the published card's header, drawn with a real box.
  await expect.element(result.getByText("2026 年 11 月 8 日")).toBeVisible();
  const box = result.element().getBoundingClientRect();
  expect(box.width).toBeGreaterThan(200);
  expect(box.height).toBeGreaterThan(40);

  // The opened row pushes the reply down instead of drawing under it.
  const reply = page.getByText("已重新生成看板。").element();
  await expect
    .poll(() => reply.getBoundingClientRect().top - result.element().getBoundingClientRect().bottom)
    .toBeGreaterThanOrEqual(0);

  const text = document.body.textContent ?? "";
  expect(text).not.toContain('"visualId"');
  expect(text).not.toContain("Place the visual in your reply");
  expect(text).not.toContain("部分 MCP 结果内容已截断");
  expect(document.querySelector('[data-mcp-content-type="structured"]')).toBeNull();

  await page.screenshot({ path: "__screenshots__/devs-1120/shown-visual-tool-row.png" });
});
