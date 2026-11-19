// FILE: SubagentSurfaces.zhCN.browser.tsx
// Purpose: Every sub-agent surface a person sees, rendered in Chinese with finished
//          sub-agents: the transcript's run card (expanded), the side panel list and the
//          sub-agent's own tab header. No English word or unit that Moss itself writes may
//          remain (effort "max", "19s", "Done in …"); names and the model's text are theirs.
// Layer: Browser test

import "../../index.css";

import { ThreadId, TurnId } from "@moss/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "../../localization";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../../localization/zhCN";
import { makeThread } from "../../storeTestFixtures";
import type { WorkLogEntry } from "../../session-logic";
import {
  runningSubagentRosterItem,
  subagentRosterItem,
} from "./environment/subagentRosterFixtures";
import { SubagentRunCard } from "./SubagentRunCard";
import { SubagentsList } from "./SubagentsDockPane";
import { SubagentThreadIntro } from "./SubagentThreadIntro";
import { SubagentRunContext, type SubagentRunContextValue } from "./subagentRunContext";

const parent = ThreadId.makeUnsafe("parent");
const launchedAt = "2026-10-10T00:00:00.000Z";
const names = ["answer_a", "answer_b", "answer_c"] as const;
const settled = [
  "2026-10-10T00:00:19.000Z",
  "2026-10-10T00:00:16.000Z",
  "2026-10-10T00:00:32.000Z",
];

// The tester's run: three finished sub-agents on GPT-6.1 Terra at max effort.
const entry: WorkLogEntry = {
  id: "subagent-run:launch",
  createdAt: launchedAt,
  turnId: TurnId.makeUnsafe("turn"),
  label: "Subagents",
  tone: "info",
  subagents: names.map((name) => ({
    threadId: name,
    resolvedThreadId: ThreadId.makeUnsafe(`subagent:parent:${name}`),
    nickname: name,
    model: "gpt-6.1-terra",
    effort: "max",
    rawStatus: "completed",
    lifecycle: "completed" as const,
  })),
  subagentRun: {
    members: names.map((name, index) => ({
      key: name,
      launchedAt,
      latestStep: null,
      outcome: "completed" as const,
      failure: null,
      settledAt: settled[index]!,
    })),
  },
};

const context: SubagentRunContextValue = {
  parentThreadId: parent,
  liveTurnId: null,
  threads: names.map((name, index) =>
    makeThread({
      id: ThreadId.makeUnsafe(`subagent:parent:${name}`),
      parentThreadId: parent,
      sourceThreadId: parent,
      subagentNickname: name,
      createdAt: launchedAt,
      updatedAt: settled[index]!,
    }),
  ),
  backgroundedProviderThreadIds: new Set(),
  taskEndByToolUseId: new Map(),
  visibility: null,
  onOpenThread: vi.fn(),
  onStop: vi.fn(),
};

/** Latin words Moss might still write; names, models and the model's own text are excluded. */
const MOSS_ENGLISH =
  /\b(?:max|xhigh|high|medium|low|minimal|Done|done|Running|running|Failed|failed|Stopped|stopped|Starting|Interrupted|Waiting|subagents?|nested|background|tokens?|tools?|ago|Completed|Open|Stop|Message|Show|more|less|in|after)\b|\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|d)\b/;

function visibleText(root: Element): string {
  return (root as HTMLElement).innerText.replace(/answer_[abc]|GPT-6\.1 Terra|GPT-6\.1|Terra/g, "");
}

beforeEach(async () => {
  await page.viewport(1101, 782);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:01:00.000Z"));
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
});

afterEach(async () => {
  await cleanup();
  uninstallZhCnUiLocalization();
  document.documentElement.lang = "en";
  delete document.documentElement.dataset.mossLocale;
  vi.useRealTimers();
});

it("the transcript's sub-agent card, opened, is Chinese all through", async () => {
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <SubagentRunContext.Provider value={context}>
        <SubagentRunCard workEntry={entry} />
      </SubagentRunContext.Provider>
    </MossLocaleScope>,
  );
  const header = screen.container.querySelector<HTMLElement>("button[aria-expanded]");
  if (header?.getAttribute("aria-expanded") === "false") header.click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("answer_c"));
  await vi.waitFor(() => {
    const text = visibleText(screen.container);
    expect(text).toContain("最大");
    expect(text).toContain("19 秒");
    expect(text).toContain("32 秒");
    expect(text).not.toMatch(MOSS_ENGLISH);
  });
});

it("the side panel's sub-agent rows are Chinese all through", async () => {
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <SubagentsList
        roster={{
          active: [
            runningSubagentRosterItem("answer_c", {
              modelLabel: "GPT-6.1 Terra · max",
              startedAt: "2026-10-10T00:00:00.000Z",
            }),
          ],
          previous: [
            subagentRosterItem("answer_a", {
              modelLabel: "GPT-6.1 Terra · max",
              startedAt: "2026-10-10T00:00:00.000Z",
              settledAt: "2026-10-10T00:00:19.000Z",
              durationMs: 19_000,
              totalTokens: 12_400,
              toolUses: 3,
            }),
          ],
        }}
        parent={null}
        nowMs={Date.parse("2026-10-10T00:00:42.000Z")}
        onOpen={() => {}}
        onStop={() => {}}
        onBackground={() => {}}
      />
    </MossLocaleScope>,
  );
  await vi.waitFor(() => {
    const text = visibleText(screen.container);
    expect(text).toContain("最大");
    expect(text).not.toMatch(MOSS_ENGLISH);
  });
  const titles = [...screen.container.querySelectorAll<HTMLElement>("[title]")].map(
    (element) => element.title,
  );
  // The finished row's tooltip carries its totals, in the same words as the workflow card.
  expect(titles.some((title) => title.includes("12k 个令牌 · 3 次工具调用"))).toBe(true);
  for (const title of titles) {
    expect(title.replace(/answer_[abc]|GPT-6\.1 Terra/g, "")).not.toMatch(MOSS_ENGLISH);
  }
});

it("the sub-agent's own tab header says 已完成 · 用时 19 秒 and 最大", async () => {
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <SubagentThreadIntro
        subagent={{
          parentThreadId: parent,
          parentTitle: "幂等性解释与例子",
          role: null,
          modelLabel: "GPT-6.1 Terra · max",
          provider: "codex",
          statusKind: "completed",
          startedAt: launchedAt,
          endedAt: "2026-10-10T00:00:19.000Z",
        }}
      />
    </MossLocaleScope>,
  );
  await vi.waitFor(() => {
    const text = visibleText(screen.container);
    expect(text).toContain("已完成 · 用时 19 秒");
    expect(text).toContain("最大");
    expect(text).not.toMatch(MOSS_ENGLISH);
  });
});
