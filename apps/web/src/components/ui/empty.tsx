// FILE: empty.tsx
// Purpose: The empty state: one quiet line where content will appear, and at most one action.
//          No illustration. Spacing of the settings status empty state
//          (`SettingsEmptyState layout="status"`: 14 px, 24 px above and below); the line reads
//          like a settings row title and an optional second line like its description.
// Layer: UI primitive
// Exports: Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent

import { cn } from "~/lib/utils";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-ui-gap-sm px-4 py-6 text-center text-ui text-muted-foreground",
        className,
      )}
      data-slot="empty"
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex max-w-sm flex-col items-center text-center", className)}
      data-slot="empty-header"
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-ui font-medium text-foreground", className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      className={cn(
        "text-ui text-muted-foreground [&>a:hover]:text-foreground [&>a]:underline [&>a]:underline-offset-4",
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 max-w-sm flex-col items-center gap-ui-gap-xs", className)}
      data-slot="empty-content"
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent };
