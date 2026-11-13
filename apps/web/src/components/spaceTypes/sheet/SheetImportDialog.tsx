// FILE: SheetImportDialog.tsx
// Purpose: What a CSV / TSV file shows before it lands in a 电子表格: how it was read (lines,
//          separator), where it goes (a new sheet, under the current sheet's rows, or in place of
//          them), whether the first row is headings, each column's name and type or "不导入", and a
//          preview of the first rows as they will be.
// Layer: 资料空间 电子表格 (dialog)
// Exports: SheetImportDialog.

import { formatSheetNumber } from "@moss/shared/spaceItems/sheetValues";
import { useMemo, useState } from "react";

import { SparklesIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Choice } from "./sheetControls";
import {
  IMPORT_COLUMN_TYPES,
  importedRows,
  importSummary,
  readImportRows,
  type ImportColumnType,
  type ImportMode,
  type ImportPlan,
  type ImportSeparator,
} from "./sheetImport.logic";

const PREVIEW_ROWS = 6;
const PREVIEW_COLUMNS = 8;

function shown(value: { v: unknown; s?: { format?: string } }): string {
  if (value.v === null || value.v === undefined) return "";
  if (typeof value.v === "number" && value.s?.format)
    return formatSheetNumber(value.s.format, value.v);
  if (typeof value.v === "boolean") return value.v ? "TRUE" : "FALSE";
  return String(value.v);
}

export function SheetImportDialog(props: {
  readonly fileName: string;
  readonly text: string;
  readonly firstPlan: ImportPlan;
  readonly firstRows: string[][];
  readonly activeSheetName: string;
  /** The current sheet's headings (its first row), for matching columns and rows. */
  readonly activeSheetHeadings: readonly string[];
  readonly onImport: (plan: ImportPlan, rows: string[][]) => void;
  /** Hands the file to Moss, which reads it and imports it its own way. */
  readonly onAskMoss?: (() => void) | null;
  readonly onCancel: () => void;
}) {
  const [plan, setPlan] = useState(props.firstPlan);
  const [rows, setRows] = useState(props.firstRows);
  const preview = useMemo(() => {
    const { headings, data } = importedRows(plan, rows.slice(0, PREVIEW_ROWS + 1));
    return { headings, data: data.slice(0, PREVIEW_ROWS) };
  }, [plan, rows]);
  const included = plan.columns.filter((column) => column.included).length;
  const sheetHeadings = new Set(props.activeSheetHeadings.map((h) => h.trim().toLowerCase()));
  /** File columns with a heading of the same name in the current sheet. */
  const matchable = plan.columns.filter(
    (column) =>
      column.included && plan.headings && sheetHeadings.has(column.name.trim().toLowerCase()),
  );
  const setSeparator = (separator: ImportSeparator) => {
    const next = readImportRows(props.text, separator);
    const width = Math.max(1, ...next.map((row) => row.length));
    setRows(next);
    setPlan({
      ...plan,
      separator,
      columns: Array.from({ length: width }, (_, index) => ({
        index,
        name: (plan.headings ? next[0]?.[index]?.trim() : "") || `第 ${index + 1} 列`,
        type: "auto" as ImportColumnType,
        included: true,
      })),
    });
  };
  const setHeadings = (headings: boolean) =>
    setPlan({
      ...plan,
      headings,
      columns: plan.columns.map((column) => ({
        ...column,
        name: (headings ? rows[0]?.[column.index]?.trim() : "") || `第 ${column.index + 1} 列`,
      })),
    });
  const modes: readonly { value: ImportMode; label: string; detail: string }[] = [
    { value: "newSheet", label: "新工作表", detail: "把文件放在一张单独的工作表上" },
    {
      value: "append",
      label: `添加到“${props.activeSheetName}”`,
      detail: "接在现有的行下面，按标题对上列",
    },
    {
      value: "update",
      label: `更新“${props.activeSheetName}”的行`,
      detail: "按一列对上：对上的行换成文件里的，其余的加在下面",
    },
    {
      value: "replace",
      label: `替换“${props.activeSheetName}”的行`,
      detail: "保留标题行，其余的行换成文件里的",
    },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogPopup className="max-w-3xl" showCloseButton>
        <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-5" data-sheet-import>
          <div className="flex flex-col gap-1">
            <DialogTitle>导入 {props.fileName}</DialogTitle>
            <DialogDescription>
              {importSummary(rows, plan.separator)}。先看一眼，改好列的类型、标题或放在哪里再导入。
            </DialogDescription>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-muted-foreground">导入为</span>
            <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="导入为">
              {modes.map((mode) => (
                <Button
                  key={mode.value}
                  type="button"
                  variant="outline"
                  role="radio"
                  aria-checked={plan.mode === mode.value}
                  className={cn(
                    "h-auto flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left font-normal",
                    plan.mode === mode.value && "ring-2 ring-ring",
                  )}
                  onClick={() =>
                    setPlan({
                      ...plan,
                      mode: mode.value,
                      ...(mode.value === "update" && plan.matchBy === undefined && matchable.length
                        ? { matchBy: matchable[0]!.index }
                        : {}),
                    })
                  }
                >
                  <span className="text-ui font-medium">{mode.label}</span>
                  <span className="text-ui-sm text-muted-foreground">{mode.detail}</span>
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            {plan.mode === "newSheet" ? (
              <label className="flex flex-col gap-1">
                <span className="text-ui-sm text-muted-foreground">新工作表的名称</span>
                <Input
                  size="sm"
                  value={plan.sheetName}
                  maxLength={100}
                  className="w-56"
                  onChange={(event) => setPlan({ ...plan, sheetName: event.target.value })}
                />
              </label>
            ) : null}
            {plan.mode === "update" ? (
              <div className="flex flex-col gap-1">
                <span className="text-ui-sm text-muted-foreground">按这一列对上行</span>
                {matchable.length ? (
                  <Choice
                    label="按这一列对上行"
                    value={String(plan.matchBy ?? matchable[0]!.index)}
                    options={matchable.map((column) => ({
                      value: String(column.index),
                      label: column.name,
                    }))}
                    onChange={(value) => setPlan({ ...plan, matchBy: Number(value) })}
                    className="w-44"
                  />
                ) : (
                  <span className="text-ui-sm text-destructive">
                    文件里没有和“{props.activeSheetName}”同名的列。勾选“第一行是标题”，或改列名。
                  </span>
                )}
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <span className="text-ui-sm text-muted-foreground">分隔符</span>
              <Choice
                label="分隔符"
                value={plan.separator === "\t" ? "tab" : plan.separator}
                options={[
                  { value: ",", label: "逗号" },
                  { value: ";", label: "分号" },
                  { value: "tab", label: "制表符" },
                ]}
                onChange={(value) =>
                  setSeparator(value === "tab" ? "\t" : (value as ImportSeparator))
                }
                className="w-28"
              />
            </div>
            <label className="flex h-7 cursor-pointer items-center gap-2 text-ui">
              <Checkbox
                checked={plan.headings}
                onCheckedChange={(checked) => setHeadings(checked === true)}
                aria-label="第一行是标题"
              />
              第一行是标题
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-muted-foreground">
              列（导入 {included} / {plan.columns.length} 列）
            </span>
            <div className="flex flex-col divide-y divide-border rounded-control border border-border">
              {plan.columns.map((column, i) => (
                <div
                  key={column.index}
                  className="flex items-center gap-2 px-2 py-1.5"
                  data-import-column
                >
                  <Checkbox
                    checked={column.included}
                    aria-label={`导入“${column.name}”`}
                    onCheckedChange={(checked) =>
                      setPlan({
                        ...plan,
                        columns: plan.columns.map((c, j) =>
                          j === i ? { ...c, included: checked === true } : c,
                        ),
                      })
                    }
                  />
                  <Input
                    size="sm"
                    aria-label={`第 ${i + 1} 列的名称`}
                    value={column.name}
                    disabled={!column.included || !plan.headings}
                    className="min-w-0 flex-1"
                    onChange={(event) =>
                      setPlan({
                        ...plan,
                        columns: plan.columns.map((c, j) =>
                          j === i ? { ...c, name: event.target.value } : c,
                        ),
                      })
                    }
                  />
                  <Choice
                    label={`“${column.name}”的类型`}
                    value={column.type}
                    options={IMPORT_COLUMN_TYPES}
                    onChange={(type) =>
                      setPlan({
                        ...plan,
                        columns: plan.columns.map((c, j) =>
                          j === i ? { ...c, type: type as ImportColumnType } : c,
                        ),
                      })
                    }
                    className="w-28"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-muted-foreground">预览</span>
            <div className="overflow-x-auto rounded-control border border-border">
              <table
                className="w-full border-collapse text-ui-sm tabular-nums"
                aria-label="导入预览"
              >
                {preview.headings ? (
                  <thead>
                    <tr className="bg-muted/50">
                      {preview.headings.slice(0, PREVIEW_COLUMNS).map((heading, i) => (
                        <th
                          key={i}
                          className="border-b border-border px-2 py-1 text-left font-medium"
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                ) : null}
                <tbody>
                  {preview.data.map((row, r) => (
                    <tr key={r} className="border-b border-border last:border-b-0">
                      {row.slice(0, PREVIEW_COLUMNS).map((value, c) => (
                        <td
                          key={c}
                          className={cn(
                            "max-w-48 truncate px-2 py-1",
                            typeof value.v === "number" && "text-right",
                          )}
                        >
                          {shown(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length - (plan.headings ? 1 : 0) > PREVIEW_ROWS ? (
              <span className="text-ui-sm text-muted-foreground">
                还有 {rows.length - (plan.headings ? 1 : 0) - PREVIEW_ROWS} 行没有显示。
              </span>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            {props.onAskMoss ? (
              <Button
                type="button"
                variant="ghost"
                className="me-auto"
                data-testid="sheet-import-moss"
                onClick={props.onAskMoss}
              >
                <SparklesIcon aria-hidden /> 让 Moss 导入
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              放弃
            </Button>
            <Button
              type="button"
              disabled={included === 0 || (plan.mode === "update" && !matchable.length)}
              data-testid="sheet-import-apply"
              onClick={() =>
                props.onImport(
                  plan.mode === "update" && plan.matchBy === undefined
                    ? { ...plan, matchBy: matchable[0]!.index }
                    : plan,
                  rows,
                )
              }
            >
              导入
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
