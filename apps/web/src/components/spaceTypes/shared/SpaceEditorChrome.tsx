// FILE: SpaceEditorChrome.tsx
// Purpose: Chrome every typed 资料空间 editor shares, so 幻灯片 / 电子表格 / 设计 / 数据看板 read as
//          one product: the toolbar icon button (28 px chrome, 16 px icon, tooltip with its
//          shortcut, pressed state, attention dot), a two-way segmented switch, and the right
//          side panel (DockPaneHeader row, close button, scrolling body).
// Layer: Web 资料空间 typed editors, shared parts
// Exports: SpaceToolbarButton, SpaceToolbarSegmented, SpaceSidePanel, SpaceToolbarDivider

import type { ReactNode } from "react";

import type { LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../../chat/chatHeaderControls";
import { DockPaneHeader } from "../../chat/DockPaneHeader";
import { IconButton } from "../../ui/icon-button";

/** Toolbar button: icon only, label as its tooltip (and the shortcut, when it has one). */
export function SpaceToolbarButton(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tooltip?: string;
  readonly shortcut?: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** Why it is disabled, shown as its tooltip. */
  readonly disabledReason?: string;
  readonly busy?: boolean;
  /** A small dot on the icon (something needs attention). */
  readonly attention?: boolean;
  readonly onClick: () => void;
  readonly testId?: string;
}) {
  const Icon = props.icon;
  const tip =
    props.disabled && props.disabledReason ? props.disabledReason : (props.tooltip ?? props.label);
  return (
    <IconButton
      size="icon-xs"
      variant="chrome"
      label={props.label}
      tooltip={
        props.shortcut ? (
          <span className="flex items-center gap-2">
            {tip}
            <span className="text-muted-foreground">{props.shortcut}</span>
          </span>
        ) : (
          tip
        )
      }
      tooltipSide="bottom"
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      data-pressed={props.pressed ? "" : undefined}
      disabled={props.disabled}
      data-testid={props.testId}
      className={cn(
        DOCK_HEADER_ICON_BUTTON_CLASS,
        "relative",
        props.pressed ? "text-foreground" : "text-muted-foreground",
      )}
      onClick={props.onClick}
    >
      <Icon className={cn("size-4", props.busy && "motion-safe:animate-spin")} aria-hidden />
      {props.attention ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--color-text-warning)]"
        />
      ) : null}
    </IconButton>
  );
}

/** Two (or more) icon choices in one bordered group, one of them on. */
export function SpaceToolbarSegmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly icon: LucideIcon;
    readonly label: string;
    readonly disabled?: boolean;
    readonly disabledReason?: string;
  }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className="flex h-7 items-center gap-px rounded-control border border-border p-px"
    >
      {props.options.map((option) => {
        const Icon = option.icon;
        const on = option.value === props.value;
        return (
          <IconButton
            key={option.value}
            size="icon-xs"
            variant="ghost"
            role="radio"
            aria-checked={on}
            label={option.label}
            tooltip={
              option.disabled && option.disabledReason ? option.disabledReason : option.label
            }
            tooltipSide="bottom"
            disabled={option.disabled}
            className={cn(
              "size-6 rounded-control-xs",
              on
                ? "bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => {
              if (!on) props.onChange(option.value);
            }}
          >
            <Icon className="size-4" aria-hidden />
          </IconButton>
        );
      })}
    </div>
  );
}

export function SpaceToolbarDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

/** Right side panel of an editor: one title row, a close button, a body that scrolls. */
export function SpaceSidePanel(props: {
  readonly title: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly width?: number;
  readonly testId?: string;
}) {
  return (
    <aside
      data-testid={props.testId}
      className="flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width: props.width ?? 320 }}
    >
      <DockPaneHeader
        title={props.title}
        actions={props.actions}
        onClose={props.onClose}
        closeLabel={props.closeLabel}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
      {props.footer}
    </aside>
  );
}
