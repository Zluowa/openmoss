// FILE: TimelineTodoPlanRow.tsx
// Purpose: Render Codex's compact todo-list checklist transcript primitive.
// Layer: Web chat presentation component
// Exports: TimelineTodoPlanRow

import { useEffect, useState, type CSSProperties } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "../../localization";
import type { TaskListTaskSnapshot } from "../../workLog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveTodoPlanPresentation } from "./todoPlanPresentation";

const TODO_PLAN_TOOLTIP_MAX_WIDTH = "min(24rem, var(--available-width, 100vw), calc(100vw - 16px))";
const TODO_PLAN_TOOLTIP_MAX_HEIGHT = "min(var(--available-height, 100vh), calc(100vh - 16px))";
const TODO_PLAN_EDGE_FADE_DISTANCE = "1rem";

const PENDING_TASK_PATH =
  "M10 2.75a7.75 7.75 0 1 1 0 15.5a7.75 7.75 0 0 1 0-15.5Zm0 1.35a6.4 6.4 0 1 0 0 12.8a6.4 6.4 0 0 0 0-12.8Z";
const IN_PROGRESS_TASK_PATHS = [
  "M12 4a8 8 0 1 1 0 16a8 8 0 1 1 0-16Zm0 2a6 6 0 1 0 0 12a6 6 0 1 0 0-12Z",
  "M12 4a8 8 0 1 1-8 8h2a6 6 0 1 0 6-6Z",
] as const;
const COMPLETED_TASK_PATHS = [
  "M10 2.75a7.75 7.75 0 1 1 0 15.5a7.75 7.75 0 0 1 0-15.5Zm0 1.35a6.4 6.4 0 1 0 0 12.8a6.4 6.4 0 0 0 0-12.8Z",
  "M6.75 10.75l2.25 2.4 4.25-5.15",
] as const;

const DONUT_STYLE: CSSProperties = {
  transition: "stroke-dashoffset 120ms ease-out, opacity 120ms ease-out",
};

export function TodoPlanProgressDonut(props: { percent: number; reducedMotion: boolean }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const clampedPercent = Math.max(0, Math.min(100, props.percent));
  const dashOffset = mounted ? 100 - clampedPercent : 100;
  return (
    <svg
      aria-hidden="true"
      className="size-3 shrink-0 text-chart-blue"
      data-todo-plan-donut="true"
      data-todo-plan-donut-percent={String(clampedPercent)}
      fill="none"
      height="12"
      viewBox="0 0 12 12"
      width="12"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle
        cx="6"
        cy="6"
        fill="none"
        opacity="0.16"
        r="5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle
        cx="6"
        cy="6"
        data-todo-plan-donut-foreground="true"
        fill="none"
        opacity={clampedPercent > 0 ? "1" : "0"}
        pathLength="100"
        r="5"
        stroke="currentColor"
        strokeDasharray="100"
        strokeDashoffset={String(dashOffset)}
        strokeLinecap="round"
        strokeWidth="2"
        style={props.reducedMotion ? { transition: "none" } : DONUT_STYLE}
        transform="rotate(-90 6 6)"
      />
    </svg>
  );
}

function TodoPlanTaskIcon(props: {
  status: TaskListTaskSnapshot["status"];
  reducedMotion: boolean;
}) {
  if (props.status === "completed") {
    return (
      <svg
        aria-hidden="true"
        className="icon-xs"
        data-todo-plan-task-icon="completed"
        fill="none"
        height="21"
        viewBox="0 0 20 21"
        width="20"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          clipRule="evenodd"
          d={COMPLETED_TASK_PATHS[0]}
          fill="currentColor"
          fillRule="evenodd"
        />
        <path
          d={COMPLETED_TASK_PATHS[1]}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
      </svg>
    );
  }
  if (props.status === "inProgress") {
    return (
      <svg
        aria-hidden="true"
        className={cn("icon-xs", !props.reducedMotion && "animate-spin")}
        data-todo-plan-task-icon="in-progress"
        fill="none"
        height="24"
        viewBox="0 0 24 24"
        width="24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d={IN_PROGRESS_TASK_PATHS[0]} fill="currentColor" opacity="0.3" />
        <path d={IN_PROGRESS_TASK_PATHS[1]} fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      className="icon-xs"
      data-todo-plan-task-icon="pending"
      fill="none"
      height="21"
      viewBox="0 0 20 21"
      width="20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path clipRule="evenodd" d={PENDING_TASK_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

function TodoPlanTooltipContent(props: {
  tasks: ReadonlyArray<TaskListTaskSnapshot>;
  reducedMotion: boolean;
}) {
  return (
    <div
      className="flex min-h-0 max-w-80 flex-1 flex-col overflow-hidden rounded-xl"
      data-todo-plan-tooltip="true"
      style={{ maxHeight: TODO_PLAN_TOOLTIP_MAX_HEIGHT }}
    >
      <div
        className="vertical-scroll-fade-mask scroll-fade-y flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2 [--scroll-fade-size:1rem]"
        data-todo-plan-tooltip-scroll="true"
        aria-label="Task list"
        role="region"
        tabIndex={0}
        style={
          {
            "--scroll-fade-size": TODO_PLAN_EDGE_FADE_DISTANCE,
          } as CSSProperties
        }
      >
        {props.tasks.map((task, index) => (
          <div
            className="flex max-w-80 min-w-0 items-start gap-2"
            data-todo-plan-task-row={String(index + 1)}
            key={`${index}:${task.task}`}
          >
            <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden">
              <TodoPlanTaskIcon reducedMotion={props.reducedMotion} status={task.status} />
            </span>
            <span
              className={cn(
                "text-size-chat max-w-72 min-w-0 break-words leading-4",
                task.status === "completed" ? "text-tertiary" : "text-codex-secondary",
              )}
              style={{
                color:
                  task.status === "completed"
                    ? "var(--color-text-foreground-tertiary, var(--color-text-foreground-secondary))"
                    : "var(--color-text-foreground-secondary)",
              }}
            >
              {task.task}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TimelineTodoPlanRow(props: {
  tasks: ReadonlyArray<TaskListTaskSnapshot>;
  fontSizePx?: number;
}) {
  const { format } = useTranslation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const presentation = resolveTodoPlanPresentation(props.tasks);
  if (props.tasks.length === 0) {
    return <div className="size-1 rounded-full bg-chart-blue" data-todo-plan-empty="true" />;
  }
  if (!presentation) {
    return null;
  }

  const label = format("chat.todoPlan.pillProgress", {
    stepNumber: presentation.stepNumber,
    stepCount: presentation.stepCount,
  });
  return (
    <div
      className="min-w-0 text-size-chat text-codex-secondary"
      data-todo-plan-row="true"
      data-todo-plan-step={String(presentation.stepNumber)}
      data-todo-plan-step-count={String(presentation.stepCount)}
      style={props.fontSizePx === undefined ? undefined : { fontSize: `${props.fontSizePx}px` }}
    >
      <Tooltip disableHoverablePopup={false}>
        <TooltipTrigger
          closeOnClick={false}
          delay={0}
          render={
            <button
              aria-label={label}
              className="-my-1.5 inline-flex max-w-full min-w-0 cursor-interaction border-0 bg-transparent p-0 py-1.5 text-start text-codex-secondary outline-none hover:text-default focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none"
              data-todo-plan-trigger="true"
              type="button"
            />
          }
        >
          <span
            className="flex max-w-full min-w-0 items-center gap-1.5 text-size-chat text-codex-secondary"
            style={{ color: "var(--color-text-foreground-secondary)" }}
          >
            <TodoPlanProgressDonut percent={presentation.percent} reducedMotion={reducedMotion} />
            <span className="tabular-nums whitespace-nowrap">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipPopup
          side="top"
          sideOffset={8}
          variant="rich"
          viewportClassName="p-0"
          className={cn(
            "max-w-full p-0 motion-reduce:transition-none",
            reducedMotion && "transition-none duration-0",
          )}
          style={{ maxWidth: TODO_PLAN_TOOLTIP_MAX_WIDTH }}
        >
          <TodoPlanTooltipContent reducedMotion={reducedMotion} tasks={props.tasks} />
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
