// FILE: SheetBar.tsx
// Purpose: The 电子表格 sheet bar under the grid: 添加工作表 over the row numbers, the list of all
//          sheets, the tabs (click to open, double-click to rename, a menu for rename, copy,
//          move and delete), and the figures of the selected cells on the right.
// Layer: 资料空间 电子表格 (types stream)
// Exports: SheetBar, SelectionFigures, figuresOf.
// Why: Sheets and the quick sum of a selection are what a person checks most while working;
//      both stay in one 36 px strip.

import { formatSheetNumber } from "@moss/shared/spaceItems/sheetValues";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChevronDownIcon, FileAddIcon, ListBulletsIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../../chat/chatHeaderControls";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "../../ui/menu";

export interface SelectionFigures {
  readonly sum: number;
  readonly average: number | null;
  readonly count: number;
  readonly numbers: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly format: string | undefined;
}
type FigureKind = "sum" | "average" | "count" | "numbers" | "min" | "max";
const FIGURE_LABELS: Record<FigureKind, string> = {
  sum: "求和",
  average: "平均值",
  count: "计数",
  numbers: "数字计数",
  min: "最小值",
  max: "最大值",
};
const FIGURE_KEY = "moss.sheet.figure";

export function figuresOf(
  values: readonly unknown[],
  format: string | undefined,
): SelectionFigures | null {
  let sum = 0;
  let numbers = 0;
  let count = 0;
  let min: number | null = null;
  let max: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    count += 1;
    if (typeof value === "number" && Number.isFinite(value)) {
      numbers += 1;
      sum += value;
      min = min === null ? value : Math.min(min, value);
      max = max === null ? value : Math.max(max, value);
    }
  }
  if (count < 2 && numbers < 2) return null;
  return { sum, average: numbers ? sum / numbers : null, count, numbers, min, max, format };
}

function showFigure(figures: SelectionFigures, kind: FigureKind): string {
  const value = figures[kind];
  if (value === null) return "—";
  if (kind === "count" || kind === "numbers") return String(value);
  const rounded = Math.round(value * 1e9) / 1e9;
  return figures.format
    ? formatSheetNumber(figures.format, rounded)
    : formatSheetNumber("#,##0.##", rounded).replace(/\.$/u, "");
}

export function SheetBar(props: {
  sheets: readonly { id: string; name: string }[];
  activeId: string;
  readOnly: boolean;
  figures: SelectionFigures | null;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onImport: () => void;
  onRename: (id: string, name: string) => string | null;
  onDuplicate: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [figure, setFigure] = useState<FigureKind>(() => {
    try {
      const saved = window.localStorage.getItem(FIGURE_KEY) as FigureKind | null;
      return saved && saved in FIGURE_LABELS ? saved : "sum";
    } catch {
      return "sum";
    }
  });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const commit = () => {
    if (!renaming) return;
    const name = draft.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    const problem = props.onRename(renaming, name);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setRenaming(null);
  };
  const chooseFigure = (kind: FigureKind) => {
    setFigure(kind);
    try {
      window.localStorage.setItem(FIGURE_KEY, kind);
    } catch {
      // A private window keeps the choice for this page only.
    }
  };
  const iconButton = (label: string, icon: ReactNode, extra?: string) => (
    <IconButton
      size="icon-xs"
      variant="chrome"
      label={label}
      tooltip={label}
      tooltipSide="top"
      className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "text-muted-foreground", extra)}
    >
      {icon}
    </IconButton>
  );
  return (
    <div
      role="toolbar"
      aria-label="工作表"
      data-sheet-bar
      className="relative flex h-9 shrink-0 items-center gap-1 border-t border-border bg-[var(--color-background-elevated,var(--background))] pr-3"
    >
      <div className="flex w-12 shrink-0 justify-center">
        {props.readOnly ? null : (
          <Menu>
            <MenuTrigger
              render={iconButton("添加工作表", <PlusIcon className="size-4" aria-hidden />)}
              data-testid="sheet-add"
            />
            <ComposerPickerMenuPopup side="top" align="start" className="w-48">
              <MenuItem onClick={props.onAdd}>
                <PlusIcon aria-hidden /> 空白工作表
              </MenuItem>
              <MenuItem onClick={props.onImport}>
                <FileAddIcon aria-hidden /> 导入 CSV 或 Excel…
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        )}
      </div>
      <Menu>
        <MenuTrigger
          render={iconButton("全部工作表", <ListBulletsIcon className="size-4" aria-hidden />)}
          data-testid="sheet-all"
        />
        <ComposerPickerMenuPopup side="top" align="start" className="max-h-80 w-56 overflow-y-auto">
          <MenuGroup>
            {props.sheets.map((sheet) => (
              <MenuItem
                key={sheet.id}
                onClick={() => props.onActivate(sheet.id)}
                data-checked={sheet.id === props.activeId ? "" : undefined}
              >
                <span className="truncate">{sheet.name}</span>
              </MenuItem>
            ))}
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
      <div
        role="tablist"
        aria-label="工作表"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        {props.sheets.map((sheet, index) => {
          const active = sheet.id === props.activeId;
          if (renaming === sheet.id)
            return (
              <div key={sheet.id} className="flex shrink-0 flex-col">
                <input
                  ref={input}
                  aria-label="工作表名称"
                  value={draft}
                  maxLength={100}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") commit();
                    if (event.key === "Escape") {
                      setError(null);
                      setRenaming(null);
                    }
                  }}
                  className={cn(
                    "h-7 w-36 rounded-control border bg-background px-2 text-ui-sm outline-none",
                    error ? "border-destructive" : "border-primary",
                  )}
                />
                {error ? (
                  <span
                    role="alert"
                    className="absolute bottom-10 rounded-control bg-popover px-2 py-1 text-ui-xs text-destructive shadow-xl"
                  >
                    {error}
                  </span>
                ) : null}
              </div>
            );
          return (
            <div key={sheet.id} className="group/tab relative flex shrink-0 items-center">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                role="tab"
                aria-selected={active}
                data-sheet-tab={sheet.name}
                onClick={() => props.onActivate(sheet.id)}
                onDoubleClick={() => {
                  if (props.readOnly) return;
                  setDraft(sheet.name);
                  setError(null);
                  setRenaming(sheet.id);
                }}
                className={cn(
                  "h-7 max-w-[12.5rem] gap-1 px-2.5 font-normal",
                  active
                    ? "bg-background text-foreground ring-1 ring-border"
                    : "text-muted-foreground",
                )}
              >
                <span className="truncate">{sheet.name}</span>
              </Button>
              {active && !props.readOnly ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`${sheet.name} 的更多选项`}
                        className="-ml-1 size-6 text-muted-foreground"
                      />
                    }
                  >
                    <ChevronDownIcon className="size-3" aria-hidden />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup side="top" align="start" className="w-48">
                    <MenuItem
                      onClick={() => {
                        setDraft(sheet.name);
                        setError(null);
                        setRenaming(sheet.id);
                      }}
                    >
                      重命名
                    </MenuItem>
                    <MenuItem onClick={() => props.onDuplicate(sheet.id)}>复制</MenuItem>
                    <MenuItem disabled={index === 0} onClick={() => props.onMove(sheet.id, -1)}>
                      左移
                    </MenuItem>
                    <MenuItem
                      disabled={index === props.sheets.length - 1}
                      onClick={() => props.onMove(sheet.id, 1)}
                    >
                      右移
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      disabled={props.sheets.length === 1}
                      variant="destructive"
                      onClick={() => props.onDelete(sheet.id)}
                    >
                      删除
                      {props.sheets.length === 1 ? (
                        <span className="ms-auto ps-3 text-ui-sm text-muted-foreground tabular-nums">
                          仅剩这一张
                        </span>
                      ) : null}
                    </MenuItem>
                  </ComposerPickerMenuPopup>
                </Menu>
              ) : null}
            </div>
          );
        })}
      </div>
      {props.figures ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-sheet-figures
                className="shrink-0 gap-1 font-normal text-muted-foreground tabular-nums"
              />
            }
          >
            {FIGURE_LABELS[figure]}：{showFigure(props.figures, figure)}
            <ChevronDownIcon className="size-3" aria-hidden />
          </MenuTrigger>
          <ComposerPickerMenuPopup side="top" align="end" className="w-56">
            {(Object.keys(FIGURE_LABELS) as FigureKind[]).map((kind) => (
              <MenuItem
                key={kind}
                onClick={() => chooseFigure(kind)}
                data-checked={kind === figure ? "" : undefined}
              >
                {FIGURE_LABELS[kind]}
                <span className="ms-auto ps-3 text-ui-sm text-muted-foreground tabular-nums">
                  {showFigure(props.figures!, kind)}
                </span>
              </MenuItem>
            ))}
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
