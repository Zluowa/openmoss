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
  "M10 2.9032C14.3713 2.9032 17.915 6.4469 17.915 10.8182C17.915 15.1896 14.3713 18.7333 10 18.7333C5.62867 18.7333 2.08496 15.1896 2.08496 10.8182C2.08496 6.4469 5.62867 2.9032 10 2.9032ZM10 4.23328C6.3632 4.23328 3.41504 7.18144 3.41504 10.8182C3.41504 14.455 6.3632 17.4032 10 17.4032C13.6368 17.4032 16.585 14.455 16.585 10.8182C16.585 7.18144 13.6368 4.23328 10 4.23328Z";
const IN_PROGRESS_TASK_PATHS = [
  "M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z",
  "M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z",
] as const;
const COMPLETED_TASK_PATHS = [
  "M12.1599 7.63617C12.3713 7.33596 12.7863 7.26372 13.0866 7.47504C13.3867 7.68642 13.4589 8.10153 13.2477 8.40179L9.28876 14.0268C9.17264 14.1917 8.98808 14.2954 8.7868 14.308C8.61044 14.319 8.43764 14.2592 8.30634 14.144L8.25262 14.0912L6.16962 11.7993L6.08954 11.6918C5.93136 11.4259 5.97666 11.0761 6.21454 10.8598C6.45225 10.6439 6.80379 10.6326 7.05341 10.8149L7.15399 10.9047L8.67841 12.5815L12.1599 7.63617Z",
  "M9.99506 2.81226C14.3664 2.81226 17.9101 6.35596 17.9101 10.7273C17.9101 15.0986 14.3664 18.6423 9.99506 18.6423C5.62372 18.6423 2.08002 15.0986 2.08002 10.7273C2.08002 6.35596 5.62372 2.81226 9.99506 2.81226ZM9.99506 4.14233C6.35826 4.14233 3.4101 7.0905 3.4101 10.7273C3.4101 14.3641 6.35826 17.3123 9.99506 17.3123C13.6319 17.3123 16.58 14.3641 16.58 10.7273C16.58 7.0905 13.6319 4.14233 9.99506 4.14233Z",
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
        <path d={COMPLETED_TASK_PATHS[0]} fill="currentColor" />
        <path
          clipRule="evenodd"
          d={COMPLETED_TASK_PATHS[1]}
          fill="currentColor"
          fillRule="evenodd"
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
