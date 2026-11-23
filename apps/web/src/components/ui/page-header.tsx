// FILE: page-header.tsx
// Purpose: The top of a page: its one title (22/28, `PAGE_TITLE_CLASS_NAME`) on the left and
//          the page's actions on the right, with `TasksPageHeader`'s row spacing.
// Layer: UI primitive
// Exports: PageHeader

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

export function PageHeader({
  title,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly actions?: ReactNode;
  /** Lines the header up with the page's content (its width and side padding). */
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-ui-gap-sm gap-y-ui-gap-xs pt-ui-pad-xs pb-ui-pad-lg",
        className,
      )}
      data-slot="page-header"
    >
      <h1 className={cn("min-w-0 flex-1 truncate", PAGE_TITLE_CLASS_NAME)}>{title}</h1>
      {actions != null ? (
        <div className="flex shrink-0 items-center gap-ui-gap-xs" data-slot="page-header-actions">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
