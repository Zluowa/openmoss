// WALK-12 N12-6: 任务 → 看板 while a task waited for approval, one card read 「● 等待批准」,
// a second 「等待批准」 badge and 「待你处理」; the failed task's card read 「失败」 and
// 「待你处理」. A card now carries one status, in one place, and that status says what the
// task needs from the person.

import "../../index.css";

import type { ProjectId, ThreadId, TurnId } from "@moss/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../../localization/zhCN";
import type { SidebarThreadSummary } from "../../types";
import { KanbanOverview } from "./KanbanOverview";
import { buildKanbanBoard } from "./kanban.logic";

const NOW_MS = Date.parse("2026-11-24T11:10:00.000Z");
const at = (minutesAgo: number) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();
const PROJECT_ID = "project-code" as ProjectId;

function walkThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> & Pick<SidebarThreadSummary, "title">,
): SidebarThreadSummary {
  return {
    id: id as ThreadId,
    projectId: PROJECT_ID,
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    interactionMode: "default",
    branch: "master",
    worktreePath: null,
    session: null,
    createdAt: at(10),
    updatedAt: at(8),
    latestTurn: null,
    lastVisitedAt: at(0),
    latestUserMessageAt: at(10),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

// The walker's three chats in the project 「code」: a Codex turn stopped on an approval, the
// Codex turn the gateway failed with a 500, and a finished Claude turn.
const FAILED_TITLE =
  "帮我看看这个项目，读一下说明，给 index.js 加减法和乘法，再看看 missing.txt WALK:FULL";

const THREADS: SidebarThreadSummary[] = [
  walkThread("waiting", {
    title: "WALK:FULL",
    branch: null,
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      createdAt: at(1),
      updatedAt: at(0),
    },
    latestTurn: {
      turnId: "turn-waiting" as TurnId,
      state: "running",
      assistantMessageId: null,
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: null,
    },
    hasPendingApprovals: true,
  }),
  walkThread("failed", {
    title: FAILED_TITLE,
    session: {
      provider: "codex",
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: at(9),
      updatedAt: at(8),
    },
    latestTurn: {
      turnId: "turn-failed" as TurnId,
      state: "error",
      assistantMessageId: null,
      requestedAt: at(8),
      startedAt: at(8),
      completedAt: at(8),
    },
  }),
  walkThread("done", {
    title: "看看这个项目有什么 WALK:CLAUDE",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    session: {
      provider: "claudeAgent",
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: at(7),
      updatedAt: at(6),
    },
    latestTurn: {
      turnId: "turn-done" as TurnId,
      state: "completed",
      assistantMessageId: null,
      requestedAt: at(7),
      startedAt: at(7),
      completedAt: at(6),
    },
  }),
];

/** The card (the shared hit area) titled `title`. */
function cardFor(title: string): HTMLElement {
  const card = [...document.querySelectorAll<HTMLElement>("li [data-hit-area]")].find(
    (element) => element.querySelector(".line-clamp-2")?.textContent === title,
  );
  if (!card) throw new Error(`no card for ${title}`);
  return card;
}

/** Every status a card shows: its status line, plus any other badge or status chip. */
function statusesOf(card: HTMLElement): HTMLElement[] {
  return [
    ...card.querySelectorAll<HTMLElement>(
      "[data-kanban-card-status], [data-slot='badge'], .rounded-full[class~='size-1.5']",
    ),
  ];
}

/** The text colour a class resolves to in Moss's CSS. */
function colourOf(className: string): string {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

afterEach(async () => {
  await cleanup();
  uninstallZhCnUiLocalization();
  document.documentElement.lang = "en";
  delete document.documentElement.dataset.mossLocale;
});

it.each([
  [1100, 780],
  [760, 780],
])(
  "WALK-12 N12-6: 任务 → 看板 at %ix%i shows one status per card, and it says what the person must do",
  async (width, height) => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();
    await page.viewport(width, height);
    const board = buildKanbanBoard(
      {
        projects: [{ id: PROJECT_ID, name: "code", kind: "project" }],
        threads: THREADS,
        draftThreads: [],
        composerDraftByThreadId: {},
        draftOrderByProjectId: {},
      },
      { now: NOW_MS },
    );
    await render(
      <div style={{ width, height }} className="flex">
        <KanbanOverview
          board={board}
          onOpenProject={vi.fn()}
          onOpenCard={vi.fn()}
          onNewTask={vi.fn()}
          prByThreadId={new Map()}
          nowMs={NOW_MS}
        />
      </div>,
    );

    const expected = [
      { title: "WALK:FULL", status: "等待批准", tone: "text-warning" },
      { title: FAILED_TITLE, status: "失败", tone: "text-status-failure" },
      { title: "看看这个项目有什么 WALK:CLAUDE", status: "已完成", tone: "text-muted-foreground" },
    ];
    for (const { title, status, tone } of expected) {
      await expect.poll(() => cardFor(title).textContent).toContain(status);
      const card = cardFor(title);
      const statuses = statusesOf(card);
      expect(statuses.map((element) => element.textContent)).toEqual([status]);
      const [line] = statuses as [HTMLElement];
      const box = line.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      // Inside the card, on its meta row: one place.
      const cardBox = card.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(cardBox.right);
      expect(box.left).toBeGreaterThanOrEqual(cardBox.left);
      expect(getComputedStyle(line).color).toBe(colourOf(tone));
      expect(card.textContent?.split(status).length).toBe(2);
      expect(card.textContent).not.toContain("待你处理");
    }
  },
);
