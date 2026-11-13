// FILE: pill-tabs.tsx
// Purpose: Shared pill tab navigation with arrow, Home and End keyboard selection.
// Layer: Shared UI
import { useRef, type KeyboardEvent } from "react";
import { cn } from "~/lib/utils";

export interface PillTab<TId extends string> {
  readonly id: TId;
  readonly label: string;
}

/**
 * Shared directory and settings tabs. Only the selected pill carries a tint;
 * its height grows with the chosen UI font. Arrow keys, Home and End
 * move the selection like any tablist.
 */
export function PillTabs<TId extends string>({
  ariaLabel,
  tabs,
  selected,
  onSelect,
  testId,
  compact = false,
}: {
  readonly ariaLabel: string;
  readonly tabs: ReadonlyArray<PillTab<TId>>;
  readonly selected: TId;
  readonly onSelect: (id: TId) => void;
  readonly testId?: string;
  /** Smaller pills for a narrow side panel, so five tabs fit in 320 px. */
  readonly compact?: boolean;
}) {
  const refs = useRef(new Map<TId, HTMLButtonElement>());
  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
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
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
      data-testid={testId}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(button) => {
              if (button) refs.current.set(tab.id, button);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            className={cn(
              "inline-flex shrink-0 items-center rounded-full leading-normal outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
              compact ? "min-h-7 px-2.5 py-1 text-ui" : "min-h-9 px-3 py-1.5 text-ui-lg sm:px-4",
              active
                ? "bg-foreground/[0.06] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
