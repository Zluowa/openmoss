// FILE: SheetGroupMarks.tsx
// Purpose: The outline of grouped rows and columns, drawn in the header gutters over the grid: a
//          thin bracket along an open group and a small −/+ that folds or unfolds it.
// Layer: 资料空间 电子表格 (overlay)
// Exports: SheetGroupMarks.

import { columnName, type SheetGroup } from "@moss/shared/spaceItems/sheetWorkbook";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";

type Box = { left: number; top: number; width: number; height: number };

const MARK = 12;

export function SheetGroupMarks(props: {
  readonly rowGroups: readonly SheetGroup[];
  readonly columnGroups: readonly SheetGroup[];
  /** Where a cell is on screen, relative to the grid (hidden rows and columns take no room). */
  readonly cellBox: (r: number, c: number) => Box | null;
  /** The top left of the cell area (after the row numbers and column letters). */
  readonly origin: { readonly left: number; readonly top: number } | null;
  readonly readOnly: boolean;
  readonly onFold: (axis: "row" | "column", group: SheetGroup) => void;
}) {
  const origin = props.origin;
  if (!origin || (!props.rowGroups.length && !props.columnGroups.length)) return null;
  const mark = (axis: "row" | "column", group: SheetGroup, style: CSSProperties) => {
    const span =
      axis === "row"
        ? `第 ${group.start + 1}–${group.end + 1} 行`
        : `${columnName(group.start)}–${columnName(group.end)} 列`;
    return (
      <Button
        key={`${axis}-${group.start}-${group.end}`}
        type="button"
        size="icon-xs"
        variant="outline"
        disabled={props.readOnly}
        aria-label={group.collapsed ? `展开${span}` : `收起${span}`}
        aria-expanded={!group.collapsed}
        data-sheet-group-toggle={axis}
        className="pointer-events-auto absolute flex items-center justify-center rounded-inline bg-background p-0 text-ui-2xs leading-none text-muted-foreground"
        style={{ width: MARK, height: MARK, minWidth: MARK, minHeight: MARK, ...style }}
        onClick={() => props.onFold(axis, group)}
      >
        {group.collapsed ? "+" : "−"}
      </Button>
    );
  };
  return (
    <>
      {props.rowGroups.map((group) => {
        const first = props.cellBox(group.start, 0);
        const last = props.cellBox(group.end, 0);
        const after = props.cellBox(group.end + 1, 0);
        const x = origin.left - 46;
        const at = after ? after.top + (after.height - MARK) / 2 : null;
        return (
          <span key={`row-${group.start}-${group.end}`}>
            {!group.collapsed && first && last ? (
              <span
                aria-hidden
                className={cn("absolute border-l border-t border-b border-strong")}
                style={{
                  left: x + MARK / 2,
                  top: Math.max(origin.top, first.top + 4),
                  width: 4,
                  height: Math.max(
                    0,
                    last.top + last.height - 4 - Math.max(origin.top, first.top + 4),
                  ),
                }}
              />
            ) : null}
            {at !== null && at >= origin.top - MARK / 2
              ? mark("row", group, { left: x, top: at })
              : null}
          </span>
        );
      })}
      {props.columnGroups.map((group) => {
        const first = props.cellBox(0, group.start);
        const last = props.cellBox(0, group.end);
        const after = props.cellBox(0, group.end + 1);
        const y = origin.top - 26;
        const at = after ? after.left + (after.width - MARK) / 2 : null;
        return (
          <span key={`column-${group.start}-${group.end}`}>
            {!group.collapsed && first && last ? (
              <span
                aria-hidden
                className="absolute border-l border-r border-t border-strong"
                style={{
                  top: y + MARK / 2,
                  left: Math.max(origin.left, first.left + 4),
                  height: 4,
                  width: Math.max(
                    0,
                    last.left + last.width - 4 - Math.max(origin.left, first.left + 4),
                  ),
                }}
              />
            ) : null}
            {at !== null && at >= origin.left - MARK / 2
              ? mark("column", group, { left: at, top: y })
              : null}
          </span>
        );
      })}
    </>
  );
}
