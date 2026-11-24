// FILE: SpaceEditorChrome.tsx
// Purpose: Chrome every typed 资料空间 editor shares, so 幻灯片 / 电子表格 / 设计 / 数据看板 read as
//          one product: the toolbar icon button (28 px chrome, 16 px icon, tooltip with its
//          shortcut, pressed state, attention dot), a two-way segmented switch, and the right
//          side panel (DockPaneHeader row, close button, scrolling body).
// Layer: Web 资料空间 typed editors, shared parts
// Exports: SpaceToolbarButton, SpaceToolbarSegmented, SpaceSidePanel, SpaceToolbarDivider

import { type ReactNode, useState } from "react";

import { ArrowLeftIcon, ChevronDownIcon, type LucideIcon, SparklesIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { SpaceCanvasDockController } from "../../space/spaceCanvasDockContract";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../../chat/chatHeaderControls";
import { DockPaneHeader } from "../../chat/DockPaneHeader";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { PAGE_CHROME_PILL_CLASS_NAME } from "../../pages/chrome/pageChromeStyles";
import { SpaceInlineRename } from "../../space/SpaceInlineRename";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";

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

/**
 * The title of a typed editor: the same pill and menu as a document's title (Claude: one title
 * menu). 重命名 turns it into a field in place; 存为模板 lives here, not as a bar button.
 */
export function SpaceTitleMenu(props: {
  readonly title: string;
  readonly untitled: string;
  readonly icon: LucideIcon;
  readonly readOnly: boolean;
  readonly onRename: (title: string) => void;
  readonly onSaveAsTemplate?: (() => void) | undefined;
}) {
  const Icon = props.icon;
  const [renaming, setRenaming] = useState(false);
  const shown = props.title.trim() || props.untitled;
  if (renaming) {
    return (
      <span
        className={cn(PAGE_CHROME_PILL_CLASS_NAME, "max-w-[min(22rem,100%)] min-w-0 shrink pe-1")}
        data-space-title-pill
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <SpaceInlineRename
          value={props.title}
          label="名称"
          onCommit={props.onRename}
          onDone={() => setRenaming(false)}
          className="h-6 w-56 px-1.5 text-ui-sm"
        />
      </span>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              PAGE_CHROME_PILL_CLASS_NAME,
              "max-w-[min(22rem,100%)] min-w-0 shrink font-normal",
            )}
            aria-label={`${shown} 菜单`}
            data-space-title-pill
          />
        }
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{shown}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" className="w-48 min-w-48">
        <MenuItem disabled={props.readOnly} onClick={() => setRenaming(true)}>
          重命名
        </MenuItem>
        {props.onSaveAsTemplate ? (
          <MenuItem disabled={props.readOnly} onClick={props.onSaveAsTemplate}>
            存为模板
          </MenuItem>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/**
 * Unified calm 44px Claude-style top bar shared across typed Space artifacts. Keeps one
 * subtle hairline row with Back navigation, kind icon, editable title, save status, lifted
 * editor-specific actions (`onHostActionsChange`), and the `问 Moss` Dock toggle pill.
 */
export function SpaceUnifiedTopChrome(props: {
  readonly icon?: LucideIcon | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
  readonly titleSlot: ReactNode;
  readonly statusSlot?: ReactNode;
  readonly hostActions?: ReactNode;
  readonly trailingActions?: ReactNode;
  readonly dock?: SpaceCanvasDockController | null | undefined;
  readonly testId?: string;
}) {
  const Icon = props.icon;
  const dock = props.dock ?? null;
  const dockOpen = Boolean(dock && dock.state !== "collapsed");
  const handleToggleDock = () => {
    if (!dock) return;
    if (dock.state === "collapsed") {
      void dock.ask();
    } else {
      dock.setState("collapsed");
    }
  };
  return (
    <header
      role="toolbar"
      aria-label="画布工具栏"
      data-space-unified-chrome
      data-testid={props.testId}
      className="flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background/95 px-3 select-none"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {props.onBack ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label={props.backLabel ?? "返回资料空间"}
            tooltip={props.backLabel ?? "返回资料空间"}
            tooltipSide="bottom"
            onClick={props.onBack}
          >
            <ArrowLeftIcon className="size-4" />
          </IconButton>
        ) : null}
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
        <div className="flex min-w-0 flex-1 items-center gap-2">{props.titleSlot}</div>
        {props.statusSlot ? (
          <div className="flex shrink-0 items-center gap-2">{props.statusSlot}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5" data-space-unified-chrome-actions>
        {props.hostActions}
        {props.trailingActions}
        {dock ? (
          <Button
            size="xs"
            variant={dockOpen ? "secondary" : "outline"}
            aria-pressed={dockOpen}
            aria-label="问 Moss"
            data-space-dock-toggle
            onClick={handleToggleDock}
            className="h-7 gap-1.5 rounded-full px-2.5 text-ui-sm font-medium tabular-nums"
          >
            <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
            <span>{dock.busy && dock.statusLabel ? dock.statusLabel : "问 Moss"}</span>
            {dock.busy ? (
              <span
                className="size-1.5 shrink-0 rounded-full animate-pulse bg-primary"
                aria-hidden
              />
            ) : null}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
