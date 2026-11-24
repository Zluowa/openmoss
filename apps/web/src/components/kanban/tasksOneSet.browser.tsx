// FILE: tasksOneSet.browser.tsx
// Purpose: 任务与看板 on the shared parts (WO-24): a card and a task title are the shared hit area,
//          icon-only marks and buttons are named by the Moss tooltip (no native title), the
//          starting state turns the shared spinner, the filter's dot is the shared status dot,
//          and the quiet text actions are the shared ghost Button.
// Layer: Tasks and kanban presentation browser regression

import "../../index.css";

import type { ThreadId } from "@moss/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useKanbanUiStore } from "../../kanbanUiStore";
import { TaskTextAction } from "../tasks/TaskCardPrimitives";
import { TaskRowTitle, type useTaskRename } from "../tasks/TaskRowTitle";
import { KanbanCardView } from "./KanbanCardView";
import { KanbanFilterMenu } from "./KanbanFilterMenu";
import type { KanbanCard } from "./kanban.logic";

const NOW_MS = Date.parse("2026-11-24T06:00:00.000Z");

const STARTING_CARD = {
  cardId: "thread:t-1",
  threadId: "t-1" as ThreadId,
  projectId: "project-1" as KanbanCard["projectId"],
  column: "inProgress",
  title: "Add sub and mul",
  providerInstanceId: "codex",
  provider: "codex",
  isTerminal: false,
  branch: null,
  envMode: "worktree",
  worktreePath: "/repo/.worktrees/t-1",
  thread: null,
  draftPrompt: "",
  draftHasAttachments: false,
  sortTimestamp: NOW_MS,
  timestamp: new Date(NOW_MS).toISOString(),
  activeWorkStartedAt: null,
  isOptimisticDispatch: true,
} satisfies KanbanCard;

/** The Moss tooltip shows `text` when the pointer rests on `trigger`. */
async function expectMossTooltip(trigger: Element, text: string) {
  await userEvent.hover(page.elementLocator(trigger));
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>("[data-slot='tooltip-popup']")].map(
        (popup) => popup.textContent,
      ),
    )
    .toContain(text);
}

/** The weight a type role resolves to in Moss's CSS. */
function roleWeight(className: string): string {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const weight = getComputedStyle(probe).fontWeight;
  probe.remove();
  return weight;
}

afterEach(async () => {
  await cleanup();
  useKanbanUiStore.setState({ kanbanNeedsReviewFilter: false });
});

it("draws a card as the shared hit area, names its worktree mark with the Moss tooltip, and turns the shared spinner while starting", async () => {
  const onOpen = vi.fn();
  await render(
    <div className="w-80 p-4">
      <KanbanCardView
        card={STARTING_CARD}
        prByThreadId={new Map()}
        onOpen={onOpen}
        nowMs={NOW_MS}
      />
    </div>,
  );
  const card = page.getByRole("button", { name: /Add sub and mul/ });
  await expect.element(card).toBeVisible();
  const element = card.element() as HTMLElement;
  expect(element.hasAttribute("data-hit-area")).toBe(true);
  expect(element.querySelector("[title]")).toBeNull();
  const mark = page.getByRole("img", { name: "Worktree", exact: true }).element();
  await expectMossTooltip(mark, "Worktree");
  expect(
    element.querySelector("[role='status'][aria-label='Loading'].animate-spin"),
  ).not.toBeNull();
  await card.click();
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("names the filter with the Moss tooltip and marks an active filter with the shared status dot", async () => {
  useKanbanUiStore.setState({ kanbanNeedsReviewFilter: true });
  await render(<KanbanFilterMenu />);
  const filter = page.getByRole("button", { name: "Filter", exact: true });
  await expect.element(filter).toBeVisible();
  expect(filter.element().hasAttribute("title")).toBe(false);
  // The shared StatusDot: a 6 px round mark in the accent ink.
  const dot = filter.element().querySelector<HTMLElement>("span.rounded-full[aria-hidden]")!;
  expect(dot.getBoundingClientRect().width).toBe(6);
  expect(dot.getBoundingClientRect().height).toBe(6);
  expect(getComputedStyle(dot).borderTopLeftRadius).not.toBe("0px");
  await expectMossTooltip(filter.element(), "Filter");
});

it("keeps a task title a plain hit area with no rename hint; double-click and F2 still rename", async () => {
  const startEditing = vi.fn();
  const rename = {
    isEditing: false,
    draftTitle: "",
    setDraftTitle: () => {},
    startEditing,
    commitTitle: () => {},
    handleTitleKeyDown: () => {},
  } as unknown as ReturnType<typeof useTaskRename>;
  await render(<TaskRowTitle title="Write the README" isDone={false} rename={rename} />);
  const title = page.getByRole("button", { name: "Write the README", exact: true });
  await expect.element(title).toBeVisible();
  expect(title.element().hasAttribute("data-hit-area")).toBe(true);
  expect(title.element().hasAttribute("title")).toBe(false);
  await userEvent.dblClick(title);
  expect(startEditing).toHaveBeenCalledTimes(1);
  (title.element() as HTMLElement).focus();
  await userEvent.keyboard("{F2}");
  expect(startEditing).toHaveBeenCalledTimes(2);
});

it("draws a quiet text action as the shared ghost Button at 13 px and the normal weight", async () => {
  await render(<TaskTextAction>More options</TaskTextAction>);
  const action = page.getByRole("button", { name: "More options", exact: true });
  await expect.element(action).toBeVisible();
  const element = action.element() as HTMLElement;
  expect(element.getAttribute("data-slot")).toBe("button");
  expect(getComputedStyle(element).fontSize).toBe("13px");
  expect(getComputedStyle(element).fontWeight).toBe(roleWeight("font-normal"));
});
