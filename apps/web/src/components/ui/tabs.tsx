// FILE: tabs.tsx
// Purpose: The one tab strip. `tabs` is the 资料空间 home look (28 high, radius 8, 14 px, the
//          selected tab a 5% ink tint); `segmented` is the same part on a hairline track
//          (`SpaceToolbarSegmented`: a 28 high track, 24 high segments at radius 6).
//          A tab may carry a quieter trailing count. It switches views inside a page; things a
//          person opens and closes (the dock's panes, open chats) are the pane strip
//          (`SurfaceContentTabs`) instead.
//          It replaces `PillTabs` (now an alias of this part) and keeps its API; arrow keys, Home
//          and End move the selection like any tablist. Each tab is UI SDK's button with Moss's look.
// Layer: UI primitive
// Exports: Tabs, TabItem

import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { TAB_IDLE_SURFACE_CLASS_NAME, TAB_SELECTED_SURFACE_CLASS_NAME } from "~/surfaceStyles";

export interface TabItem<TId extends string> {
  readonly id: TId;
  readonly label: string;
  /** Rides after the label, quieter: a count (a filter's rows, a page's changed lines). */
  readonly trailing?: ReactNode;
  /** The tab's accessible name when it differs from `label` (a short label with its count). */
  readonly accessibleLabel?: string;
  /** An icon before the label. */
  readonly leading?: ReactNode;
  /** `data-*` hooks for tests and agent bridges that find a tab by its own name. */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>;
}

export function Tabs<TId extends string>({
  ariaLabel,
  tabs,
  selected,
  onSelect,
  variant = "tabs",
  testId,
  className,
}: {
  readonly ariaLabel: string;
  readonly tabs: ReadonlyArray<TabItem<TId>>;
  readonly selected: TId;
  readonly onSelect: (id: TId) => void;
  readonly variant?: "tabs" | "segmented";
  readonly testId?: string;
  readonly className?: string;
}) {
  const refs = useRef(new Map<TId, HTMLElement>());
  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLElement>) => {
    const last = tabs.length - 1;
    const nextIndex =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const next = nextIndex === null ? undefined : tabs[nextIndex];
    if (!next) return;
    event.preventDefault();
    refs.current.get(next.id)?.focus();
    onSelect(next.id);
  };
  const segmented = variant === "segmented";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 items-center overflow-x-auto",
        segmented
          ? "h-7 w-fit gap-px rounded-control border border-[color:var(--color-border)] p-px"
          : "gap-1",
        className,
      )}
      data-slot="tabs"
      data-variant={variant}
      data-testid={testId}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === selected;
        return (
          <ButtonPrimitive
            key={tab.id}
            ref={(button: HTMLElement | null) => {
              if (button) refs.current.set(tab.id, button);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            {...(tab.accessibleLabel ? { "aria-label": tab.accessibleLabel } : {})}
            {...tab.dataAttributes}
            tabIndex={active ? 0 : -1}
            onClick={() => {
              onSelect(tab.id);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLElement>) => handleKeyDown(index, event)}
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap text-ui outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
              segmented ? "h-6 rounded-control-xs px-2" : "h-7 rounded-control px-2.5",
              active ? TAB_SELECTED_SURFACE_CLASS_NAME : TAB_IDLE_SURFACE_CLASS_NAME,
            )}
            data-slot="tab"
          >
            {tab.leading != null ? (
              <span
                className="flex shrink-0 items-center"
                data-slot="tab-leading"
                aria-hidden="true"
              >
                {tab.leading}
              </span>
            ) : null}
            {tab.label}
            {tab.trailing != null ? (
              <span className="tabular-nums text-muted-foreground/70" data-slot="tab-trailing">
                {tab.trailing}
              </span>
            ) : null}
          </ButtonPrimitive>
        );
      })}
    </div>
  );
}
