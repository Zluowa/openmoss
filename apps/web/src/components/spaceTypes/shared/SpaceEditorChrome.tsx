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
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { Menu, MenuItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuTrigger } from "../../ui/menu";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../../chat/ComposerPickerMenuPopup";
import { PAGE_CHROME_PILL_CLASS_NAME } from "../../pages/chrome/pageChromeStyles";
import { SpaceInlineRename } from "../../space/SpaceInlineRename";

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

export interface SpaceTitleMenuExportItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface SpaceTitleMenuHostCapabilities {
  readonly onVersionHistory?: (() => void) | undefined;
  readonly exportItems?: readonly SpaceTitleMenuExportItem[] | undefined;
  readonly comments?:
    | {
        readonly open: boolean;
        readonly onToggle: () => void;
        readonly disabled?: boolean;
      }
    | undefined;
  readonly languageAction?:
    | {
        readonly label: string;
        readonly onSelect: () => void;
      }
    | undefined;
}

/**
 * The unified title pill and menu shared by every 资料空间 type (文档, 幻灯片, 电子表格, 设计,
 * 数据看板, 应用页, 画布). 重命名 turns it into a field in place; the top level keeps Claude's
 * uniform item shape using actions each type supports.
 */
export function SpaceTitleMenu(props: {
  readonly title: string;
  readonly untitled: string;
  readonly icon: LucideIcon;
  readonly readOnly: boolean;
  readonly menuLabel?: string | undefined;
  readonly inlineRenameLabel?: string | undefined;
  readonly pillKind?: "page" | "space" | undefined;
  readonly onRename: (title: string) => void;
  readonly onVersionHistory?: (() => void) | undefined;
  readonly onDuplicate?: (() => void) | undefined;
  readonly exportItems?: readonly SpaceTitleMenuExportItem[] | undefined;
  readonly comments?:
    | {
        readonly open: boolean;
        readonly onToggle: () => void;
        readonly disabled?: boolean;
      }
    | undefined;
  readonly languageMenu?: ReactNode | undefined;
  readonly languageAction?:
    | {
        readonly label: string;
        readonly onSelect: () => void;
      }
    | undefined;
  readonly onSaveAsTemplate?: (() => void) | undefined;
  readonly moreMenu?: ReactNode | undefined;
  readonly onTrash?: (() => void) | undefined;
}) {
  const Icon = props.icon;
  const [renaming, setRenaming] = useState(false);
  const shown = props.title.trim() || props.untitled;
  const pagePillAttr = props.pillKind === "page" ? "" : undefined;
  if (renaming) {
    return (
      <span
        className={cn(PAGE_CHROME_PILL_CLASS_NAME, "max-w-[min(22rem,100%)] min-w-0 shrink pe-1")}
        data-space-title-pill
        data-page-title-pill={pagePillAttr}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <SpaceInlineRename
          value={props.title}
          label={props.inlineRenameLabel ?? "名称"}
          onCommit={props.onRename}
          onDone={() => setRenaming(false)}
          className="h-6 w-56 px-1.5 text-ui-sm"
        />
      </span>
    );
  }
  const hasExport = Boolean(props.exportItems && props.exportItems.length > 0);
  const hasDelete = Boolean(props.onTrash && !props.readOnly);
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
            aria-label={`${shown} ${props.menuLabel ?? "菜单"}`}
            data-space-title-pill
            data-page-title-pill={pagePillAttr}
          />
        }
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{shown}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" className="w-52 min-w-52">
        <MenuItem disabled={props.readOnly} onClick={() => setRenaming(true)}>
          重命名
        </MenuItem>
        {props.onVersionHistory ? (
          <MenuItem onClick={props.onVersionHistory}>版本历史</MenuItem>
        ) : null}
        {props.onDuplicate ? (
          <MenuItem disabled={props.readOnly} onClick={props.onDuplicate}>
            复制
          </MenuItem>
        ) : null}
        {hasExport ? (
          <MenuSub>
            <MenuSubTrigger>导出</MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-48 min-w-48">
              {props.exportItems!.map((item) => (
                <MenuItem key={item.id} onClick={item.onSelect}>
                  {item.label}
                </MenuItem>
              ))}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        ) : null}
        {props.comments ? (
          <MenuItem disabled={props.comments.disabled} onClick={props.comments.onToggle}>
            {props.comments.open ? "隐藏评论" : "显示评论"}
          </MenuItem>
        ) : null}
        {props.languageMenu ?? null}
        {props.languageAction ? (
          <MenuItem onClick={props.languageAction.onSelect}>{props.languageAction.label}</MenuItem>
        ) : null}
        {props.onSaveAsTemplate ? (
          <MenuItem disabled={props.readOnly} onClick={props.onSaveAsTemplate}>
            存为模板
          </MenuItem>
        ) : null}
        {props.moreMenu ?? null}
        {hasDelete ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onTrash}>
              删除
            </MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/**
 * Unified calm 44px Claude-style top bar shared across 文档 and typed Space artifacts. Keeps one
 * subtle hairline row with Back/leading navigation, kind icon, editable title, save status,
 * lifted editor-specific actions (`hostActions`), trailing controls, and the `问 Moss` Dock pill.
 */
export function SpaceUnifiedTopChrome(props: {
  readonly icon?: LucideIcon | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
  readonly leadingActions?: ReactNode;
  readonly titleSlot: ReactNode;
  readonly statusSlot?: ReactNode;
  readonly hostActions?: ReactNode;
  readonly trailingActions?: ReactNode;
  readonly dock?: SpaceCanvasDockController | null | undefined;
  readonly ariaLabel?: string | undefined;
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
      aria-label={props.ariaLabel ?? "画布工具栏"}
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
        {props.leadingActions}
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
        <div className="flex min-w-0 items-center gap-2">{props.titleSlot}</div>
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
