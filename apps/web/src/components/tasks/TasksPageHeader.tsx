// FILE: TasksPageHeader.tsx
// Purpose: The top of the Tasks list and the board. The window's top bar keeps only the
//          navigation controls; the page's own header row, under it, carries the page title
//          (or the open project with a back arrow), the List / Board switch, the view's one
//          filter control and New task, the way Claude desktop pages and Moss Inbox / Settings
//          put a page's actions in the page itself.
// Layer: Tasks UI component
// Exports: TasksPageHeader

import type { ReactNode } from "react";

import type { TasksViewMode } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { ArrowLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PAGE_TITLE_CLASS_NAME } from "../../surfaceStyles";
import { RouteSurfaceHeader } from "../RouteSurface";
import { NewTaskButton } from "./NewTaskButton";
import { TasksViewSwitch } from "./TasksViewSwitch";

export function TasksPageHeader({
  view,
  title = "Tasks",
  onBack,
  filter,
  onNewTask,
  newTaskDisabled,
  className,
}: {
  view: TasksViewMode;
  /** Defaults to "Tasks"; a project board shows the project's name. */
  title?: string;
  /** Shown as a back arrow before the title (a project board returns to every project). */
  onBack?: (() => void) | undefined;
  /** The view's one filter control, if it has filters. */
  filter?: ReactNode;
  onNewTask: () => void;
  newTaskDisabled?: boolean | undefined;
  /** Lines the header row up with the view's content (its width and side padding). */
  className?: string | undefined;
}) {
  return (
    <>
      <RouteSurfaceHeader divider={false} className="shrink-0" />
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-x-ui-gap-sm gap-y-ui-gap-xs pt-ui-pad-xs pb-ui-pad-lg",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-ui-gap-xs">
          {onBack ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0"
              onClick={onBack}
              aria-label="Back to all projects"
              title="Back to all projects"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : null}
          <h1 className={cn("min-w-0 truncate", PAGE_TITLE_CLASS_NAME)}>{title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-ui-gap-xs">
          {onBack ? null : <TasksViewSwitch current={view} />}
          {filter}
          <NewTaskButton disabled={newTaskDisabled} onClick={onNewTask} />
        </div>
      </div>
    </>
  );
}
