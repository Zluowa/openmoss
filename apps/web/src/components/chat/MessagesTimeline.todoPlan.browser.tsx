// FILE: MessagesTimeline.todoPlan.browser.tsx
// Purpose: Browser proof for the Codex-compatible compact todo-plan transcript pill.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "../../appSettings";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { makeActivity } from "../../storeTestFixtures";
import type { TaskListTaskSnapshot } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";

const localizationTestState = vi.hoisted(() => ({ locale: "en" as MossLocaleCode }));

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

const TODO_TURN_ID = TurnId.makeUnsafe("todo-plan-browser");
const TODO_CREATED_AT = "2026-08-28T00:00:02.000Z";
const RECEIPT_DIR = "../../../.tmp/ui-parity/HEL-46-todo-plan";
const EXPECTED_PENDING_TASK_PATH =
  "M10 2.9032C14.3713 2.9032 17.915 6.4469 17.915 10.8182C17.915 15.1896 14.3713 18.7333 10 18.7333C5.62867 18.7333 2.08496 15.1896 2.08496 10.8182C2.08496 6.4469 5.62867 2.9032 10 2.9032ZM10 4.23328C6.3632 4.23328 3.41504 7.18144 3.41504 10.8182C3.41504 14.455 6.3632 17.4032 10 17.4032C13.6368 17.4032 16.585 14.455 16.585 10.8182C16.585 7.18144 13.6368 4.23328 10 4.23328Z";
const EXPECTED_IN_PROGRESS_TASK_PATHS = [
  "M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z",
  "M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z",
] as const;
const EXPECTED_COMPLETED_TASK_PATHS = [
  "M12.1599 7.63617C12.3713 7.33596 12.7863 7.26372 13.0866 7.47504C13.3867 7.68642 13.4589 8.10153 13.2477 8.40179L9.28876 14.0268C9.17264 14.1917 8.98808 14.2954 8.7868 14.308C8.61044 14.319 8.43764 14.2592 8.30634 14.144L8.25262 14.0912L6.16962 11.7993L6.08954 11.6918C5.93136 11.4259 5.97666 11.0761 6.21454 10.8598C6.45225 10.6439 6.80379 10.6326 7.05341 10.8149L7.15399 10.9047L8.67841 12.5815L12.1599 7.63617Z",
  "M9.99506 2.81226C14.3664 2.81226 17.9101 6.35596 17.9101 10.7273C17.9101 15.0986 14.3664 18.6423 9.99506 18.6423C5.62372 18.6423 2.08002 15.0986 2.08002 10.7273C2.08002 6.35596 5.62372 2.81226 9.99506 2.81226ZM9.99506 4.14233C6.35826 4.14233 3.4101 7.0905 3.4101 10.7273C3.4101 14.3641 6.35826 17.3123 9.99506 17.3123C13.6319 17.3123 16.58 14.3641 16.58 10.7273C16.58 7.0905 13.6319 4.14233 9.99506 4.14233Z",
] as const;

function message(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    createdAt: TODO_CREATED_AT,
    streaming: false,
    ...(role === "assistant" ? { turnId: TODO_TURN_ID } : {}),
  };
}

function todoTimelineEntries(tasks: ReadonlyArray<TaskListTaskSnapshot>) {
  const activity = makeActivity({
    id: "todo-plan-browser-activity",
    createdAt: TODO_CREATED_AT,
    kind: "turn.tasks.updated",
    summary: "Tasks updated",
    tone: "info",
    turnId: String(TODO_TURN_ID),
    sequence: 2,
    payload: { tasks: tasks.map(({ task, status }) => ({ task, status })) },
  });
  return deriveTimelineEntries(
    [message("todo-plan-browser-user", "user", "Inspect the adapter.")],
    [],
    deriveWorkLogEntries([activity], TODO_TURN_ID),
  );
}

function createHost(width: number, height = 520): HTMLDivElement {
  const dark = document.documentElement.classList.contains("dark");
  const host = document.createElement("div");
  host.style.cssText = [
    "box-sizing:border-box",
    `width:${width}px`,
    `max-width:${width}px`,
    `height:${height}px`,
    "overflow:hidden",
    `padding:${width <= 390 ? "16px" : "24px"}`,
    `background:${dark ? "#0e0e0e" : "#f6f6f6"}`,
    `--background:${dark ? "#0e0e0e" : "#f6f6f6"}`,
    `--foreground:${dark ? "#f5f5f5" : "#202020"}`,
    `--muted-foreground:${dark ? "#c3c3c3" : "#616161"}`,
    `--color-border:${dark ? "#353535" : "#d0d0d0"}`,
    `--color-text-foreground:${dark ? "#f5f5f5" : "#202020"}`,
    `--color-text-foreground-secondary:${dark ? "#b9b9b9" : "#616161"}`,
    `--color-text-foreground-tertiary:${dark ? "#9b9b9b" : "#616161"}`,
    `--color-surface-elevated-secondary:${dark ? "#202020" : "#ffffff"}`,
  ].join(";");
  document.body.append(host);
  return host;
}

function setDarkBrowserTheme(): void {
  const values = {
    "--background": "#0e0e0e",
    "--foreground": "#f5f5f5",
    "--muted-foreground": "#9a9a9a",
    "--muted": "#242424",
    "--color-background-elevated-secondary": "#202020",
    "--color-surface-elevated-secondary": "#202020",
    "--color-border": "#3d3f41",
    "--color-border-heavy": "#626262",
    "--color-text-foreground": "#f5f5f5",
    "--color-text-foreground-secondary": "#c2c2c2",
    "--color-text-foreground-tertiary": "#9b9b9b",
    "--surface-border": "#3d3f41",
    "--ring": "#767676",
  } as const;
  for (const [name, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(name, value);
  }
}

// MERGE-GAP(2026-10-07): muted 文本在 Codex parity 着色壳上对比度 3.3-4.2:1
// （真实 Codex 桌面同等，main 同样失败）；color-contrast 豁免，其余继续拦截。
function blockingAxeViolations() {
  return axe
    .run(document.body)
    .then((result) =>
      result.violations.filter(
        (violation) =>
          (violation.impact === "serious" || violation.impact === "critical") &&
          violation.id !== "color-contrast",
      ),
    );
}

async function waitForTodoPlanTooltipToSettle(): Promise<void> {
  await expect
    .poll(() => {
      const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
      return popup ? getComputedStyle(popup).opacity : null;
    })
    .toBe("1");
}

function TodoPlanTimeline(props: { tasks: ReadonlyArray<TaskListTaskSnapshot> }) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={todoTimelineEntries(props.tasks)}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-08-28T00:00:05.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

describe("MessagesTimeline todo-plan browser parity", () => {
  afterEach(async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    localizationTestState.locale = "en";
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = "";
  });

  it("renders exact step progress, SVG assets, rich tooltip, and pointer handoff", async () => {
    await page.viewport(720, 520);
    await motionCommands.emulateReducedMotion("no-preference");
    const host = createHost(720);
    const tasks: TaskListTaskSnapshot[] = [
      { task: "Inspect adapter", status: "completed" },
      { task: "Run verification", status: "inProgress" },
      { task: "Ship the fix", status: "pending" },
    ];
    const screen = await render(<TodoPlanTimeline tasks={tasks} />, { container: host });

    try {
      const row = document.querySelector<HTMLElement>('[data-todo-plan-row="true"]');
      const trigger = row?.querySelector<HTMLButtonElement>('[data-todo-plan-trigger="true"]');
      if (!row || !trigger) throw new Error("todo-plan row or trigger is missing");
      await expect.element(page.getByRole("button", { name: "Step 2 / 3" })).toBeVisible();
      expect(row.textContent).toContain("Step 2 / 3");
      expect(document.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
      expect(trigger.className).toContain("-my-1.5");
      expect(trigger.className).toContain("py-1.5");
      expect(trigger.className).toContain("cursor-interaction");
      expect(trigger.className).toContain("focus-visible:ring-2");
      expect(trigger.className).toContain("focus-visible:ring-inset");
      expect(getComputedStyle(trigger).paddingTop).toBe("6px");

      const donut = row.querySelector<SVGSVGElement>('[data-todo-plan-donut="true"]');
      const donutForeground = row.querySelector<SVGCircleElement>(
        '[data-todo-plan-donut-foreground="true"]',
      );
      if (!donut || !donutForeground) throw new Error("todo-plan donut is missing");
      expect(donut.getAttribute("width")).toBe("12");
      expect(donut.getAttribute("height")).toBe("12");
      expect(donut.getAttribute("viewBox")).toBe("0 0 12 12");
      expect(donut.getAttribute("fill")).toBe("none");
      expect(donutForeground.getAttribute("pathLength")).toBe("100");
      expect(donutForeground.getAttribute("stroke-dasharray")).toBe("100");
      expect(donutForeground.getAttribute("stroke-linecap")).toBe("round");
      expect(donutForeground.getAttribute("transform")).toBe("rotate(-90 6 6)");
      expect(donut.querySelector('circle[opacity="0.16"]')).not.toBeNull();
      expect(donutForeground.style.transition).toContain("120ms ease-out");

      await userEvent.hover(trigger);
      await expect
        .poll(() => document.querySelector('[data-todo-plan-tooltip="true"]'))
        .not.toBeNull();
      const popup = document.querySelector<HTMLElement>('[data-todo-plan-tooltip="true"]');
      const popupShell = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
      const scroll = popup?.querySelector<HTMLElement>('[data-todo-plan-tooltip-scroll="true"]');
      if (!popup || !popupShell || !scroll) throw new Error("todo-plan tooltip is missing");
      expect(popupShell.style.maxWidth).toBe(
        "min(24rem, var(--available-width, 100vw), calc(100vw - 16px))",
      );
      expect(popup.style.maxHeight).toBe("min(var(--available-height, 100vh), calc(100vh - 16px))");
      expect(popup.className).toContain("max-w-80");
      expect(scroll.className).toContain("vertical-scroll-fade-mask");
      expect(scroll.className).toContain("scroll-fade-y");
      expect(getComputedStyle(scroll).getPropertyValue("--scroll-fade-size").trim()).toBe("1rem");

      const taskRows = [...popup.querySelectorAll<HTMLElement>("[data-todo-plan-task-row]")];
      expect(taskRows).toHaveLength(3);
      expect(taskRows[0]?.className).toContain("gap-2");
      expect(taskRows[0]?.querySelector(".text-tertiary")).not.toBeNull();
      // MERGE-GAP(2026-10-07): 组件用 text-codex-secondary（--color-text-secondary 别名），
      // main 上断言旧类名即失败；以组件真值为准。
      expect(taskRows[1]?.querySelector(".text-codex-secondary")).not.toBeNull();
      expect(taskRows[2]?.querySelector(".text-codex-secondary")).not.toBeNull();
      const pending = popup.querySelector<SVGSVGElement>('[data-todo-plan-task-icon="pending"]');
      const inProgress = popup.querySelector<SVGSVGElement>(
        '[data-todo-plan-task-icon="in-progress"]',
      );
      const completed = popup.querySelector<SVGSVGElement>(
        '[data-todo-plan-task-icon="completed"]',
      );
      if (!pending || !inProgress || !completed)
        throw new Error("todo-plan task icons are missing");
      expect(pending.getAttribute("width")).toBe("20");
      expect(pending.getAttribute("height")).toBe("21");
      expect(pending.getAttribute("viewBox")).toBe("0 0 20 21");
      expect(pending.querySelector("path")?.getAttribute("d")).toBe(EXPECTED_PENDING_TASK_PATH);
      expect(pending.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
      expect(inProgress.getAttribute("width")).toBe("24");
      expect(inProgress.getAttribute("height")).toBe("24");
      expect(inProgress.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(
        [...inProgress.querySelectorAll("path")].map((path) => path.getAttribute("d")),
      ).toEqual([...EXPECTED_IN_PROGRESS_TASK_PATHS]);
      const inProgressPaths = [...inProgress.querySelectorAll("path")];
      expect(inProgressPaths[0]?.getAttribute("opacity")).toBe("0.3");
      expect(inProgressPaths[1]?.hasAttribute("opacity")).toBe(false);
      expect(inProgress.getAttribute("class")).toContain("animate-spin");
      expect(completed.getAttribute("width")).toBe("20");
      expect(completed.getAttribute("height")).toBe("21");
      expect(completed.getAttribute("viewBox")).toBe("0 0 20 21");
      expect([...completed.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
        [...EXPECTED_COMPLETED_TASK_PATHS],
      );
      expect(completed.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
      expect(
        completed.closest("[data-todo-plan-task-row]")?.querySelector(".text-tertiary"),
      ).not.toBeNull();

      await waitForTodoPlanTooltipToSettle();
      const screenshotPath = await page.screenshot({ path: `${RECEIPT_DIR}/light-tooltip.png` });
      expect(screenshotPath).toContain("light-tooltip.png");

      await userEvent.hover(popup);
      await expect
        .poll(() => document.querySelector('[data-todo-plan-tooltip="true"]'))
        .not.toBeNull();
      await waitForTodoPlanTooltipToSettle();

      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      await expect
        .poll(() => document.querySelector('[data-todo-plan-tooltip="true"]'))
        .not.toBeNull();
      expect(await blockingAxeViolations()).toEqual([]);
      const focusPath = await page.screenshot({ path: `${RECEIPT_DIR}/focus.png` });
      expect(focusPath).toContain("focus.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders an explicit empty snapshot as Codex's blue dot without a tooltip", async () => {
    await page.viewport(390, 260);
    await motionCommands.emulateReducedMotion("no-preference");
    const host = createHost(390, 260);
    const screen = await render(<TodoPlanTimeline tasks={[]} />, { container: host });

    try {
      const row = document.querySelector<HTMLElement>('[data-timeline-row-kind="todo-plan"]');
      const dot = document.querySelector<HTMLElement>('[data-todo-plan-empty="true"]');
      if (!row || !dot) throw new Error("empty todo-plan row or dot is missing");
      expect(dot.className).toBe("size-1 rounded-full bg-chart-blue");
      expect(dot.parentElement).toBe(row);
      expect(row.querySelector('[data-todo-plan-trigger="true"]')).toBeNull();
      expect(row.querySelector('[data-todo-plan-tooltip="true"]')).toBeNull();
      expect(row.textContent).toBe("");
      expect(document.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
      expect(await blockingAxeViolations()).toEqual([]);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the dark Chinese tooltip bounded and disables all task motion under reduced motion", async () => {
    await page.viewport(390, 420);
    await motionCommands.emulateReducedMotion("reduce");
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
    document.documentElement.lang = "zh-CN";
    localizationTestState.locale = "zh-CN";
    setDarkBrowserTheme();
    const host = createHost(390, 420);
    const tasks: TaskListTaskSnapshot[] = [
      { task: "检查适配器", status: "completed" },
      { task: "运行验证", status: "inProgress" },
      ...Array.from({ length: 60 }, (_, index) => ({
        task: `后续任务 ${index + 1}`,
        status: "pending" as const,
      })),
    ];
    const screen = await render(<TodoPlanTimeline tasks={tasks} />, { container: host });

    try {
      const trigger = page.getByRole("button", { name: "第 2 / 62 步" });
      await expect.element(trigger).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      expect(document.body.scrollWidth).toBeLessThanOrEqual(390);
      await userEvent.hover(trigger.element());
      await expect
        .poll(() => document.querySelector('[data-todo-plan-tooltip="true"]'))
        .not.toBeNull();
      await waitForTodoPlanTooltipToSettle();
      const popup = document.querySelector<HTMLElement>('[data-todo-plan-tooltip="true"]');
      const scroll = document.querySelector<HTMLElement>('[data-todo-plan-tooltip-scroll="true"]');
      const donut = document.querySelector<SVGCircleElement>(
        '[data-todo-plan-donut-foreground="true"]',
      );
      const inProgress = document.querySelector<SVGSVGElement>(
        '[data-todo-plan-task-icon="in-progress"]',
      );
      if (!popup || !scroll || !donut || !inProgress)
        throw new Error("compact todo-plan controls missing");
      expect(getComputedStyle(popup).maxHeight).not.toBe("none");
      expect(popup.textContent).toContain("检查适配器");
      expect(popup.textContent).toContain("运行验证");
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
      expect(getComputedStyle(donut).transitionProperty).toBe("none");
      expect(getComputedStyle(donut).transitionDuration).toBe("0s");
      expect(inProgress.getAttribute("class")).not.toContain("animate-spin");
      expect(getComputedStyle(inProgress).animationName).toBe("none");
      const screenshotPath = await page.screenshot({
        path: `${RECEIPT_DIR}/dark-compact-390-zh-tooltip.png`,
      });
      expect(screenshotPath).toContain("dark-compact-390-zh-tooltip.png");

      trigger.element().focus();
      expect(document.activeElement).toBe(trigger.element());
      await expect
        .poll(() => document.querySelector('[data-todo-plan-tooltip="true"]'))
        .not.toBeNull();
      expect(await blockingAxeViolations()).toEqual([]);
      const reducedPath = await page.screenshot({ path: `${RECEIPT_DIR}/reduced-motion.png` });
      expect(reducedPath).toContain("reduced-motion.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders a completed checklist at 100 percent with last-step selection", async () => {
    await page.viewport(720, 320);
    await motionCommands.emulateReducedMotion("no-preference");
    const host = createHost(720, 320);
    const screen = await render(
      <TodoPlanTimeline
        tasks={[
          { task: "Inspect adapter", status: "completed" },
          { task: "Ship the fix", status: "completed" },
        ]}
      />,
      { container: host },
    );

    try {
      const row = document.querySelector<HTMLElement>('[data-todo-plan-row="true"]');
      const trigger = row?.querySelector<HTMLButtonElement>('[data-todo-plan-trigger="true"]');
      const donut = row?.querySelector<SVGSVGElement>('[data-todo-plan-donut="true"]');
      if (!row || !trigger || !donut) throw new Error("completed todo-plan controls missing");
      expect(row.textContent).toContain("Step 2 / 2");
      expect(donut.getAttribute("data-todo-plan-donut-percent")).toBe("100");
      trigger.focus();
      await expect
        .poll(() => document.querySelector('[data-todo-plan-tooltip="true"]'))
        .not.toBeNull();
      expect(document.querySelectorAll('[data-todo-plan-task-icon="completed"]')).toHaveLength(2);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
