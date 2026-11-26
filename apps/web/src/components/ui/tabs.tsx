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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { scrollTabIntoView } from "~/lib/tabStrip";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { TAB_IDLE_SURFACE_CLASS_NAME, TAB_SELECTED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { useHorizontalWheelScroll } from "../chat/chatHeaderControls";
import { Button } from "./button";

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
  const stripRef = useRef<HTMLDivElement | null>(null);
  const { locale } = useTranslation();
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const segmented = variant === "segmented";
  useHorizontalWheelScroll(stripRef);

  const updateOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || segmented) {
      setOverflow((current) =>
        current.left || current.right ? { left: false, right: false } : current,
      );
      return;
    }
    const left = strip.scrollLeft > 2;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2;
    setOverflow((current) =>
      current.left === left && current.right === right ? current : { left, right },
    );
  }, [segmented]);

  useEffect(() => {
    if (segmented) return;
    const strip = stripRef.current;
    if (!strip) return;
    updateOverflow();
    const handleScroll = () => updateOverflow();
    strip.addEventListener("scroll", handleScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => updateOverflow()) : null;
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
    };
  }, [segmented, tabs, updateOverflow]);

  useEffect(() => {
    if (segmented) return;
    const strip = stripRef.current;
    const activeButton = refs.current.get(selected);
    if (strip && activeButton) {
      scrollTabIntoView(strip, activeButton);
    }
    updateOverflow();
  }, [segmented, selected, tabs, updateOverflow]);

  const scrollStripBy = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    const step = Math.max(160, Math.round(strip.clientWidth * 0.6));
    strip.scrollBy({ left: direction * step, behavior: "smooth" });
  };

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

  const tabButtons = tabs.map((tab, index) => {
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
          <span className="flex shrink-0 items-center" data-slot="tab-leading" aria-hidden="true">
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
  });

  if (segmented) {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          "flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "h-7 w-fit gap-px rounded-control border border-[color:var(--color-border)] p-px",
          className,
        )}
        data-slot="tabs"
        data-variant={variant}
        data-testid={testId}
      >
        {tabButtons}
      </div>
    );
  }

  return (
    <div
      className="relative flex min-w-0 max-w-full items-center gap-1"
      data-slot="tabs-scroll-shell"
    >
      {overflow.left ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          shape="capsule"
          tabIndex={-1}
          data-testid={testId ? `${testId}-scroll-left` : undefined}
          aria-label={locale === "zh-CN" ? "向左滚动标签" : "Scroll tabs left"}
          onClick={() => scrollStripBy(-1)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
      <div
        ref={stripRef}
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-contain [scrollbar-width:none] scroll-fade-x [--scroll-fade-size:1.5rem] [&::-webkit-scrollbar]:hidden",
          className,
        )}
        data-slot="tabs"
        data-variant={variant}
        data-testid={testId}
      >
        {tabButtons}
      </div>
      {overflow.right ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          shape="capsule"
          tabIndex={-1}
          data-testid={testId ? `${testId}-scroll-right` : undefined}
          aria-label={locale === "zh-CN" ? "向右滚动标签" : "Scroll tabs right"}
          onClick={() => scrollStripBy(1)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
