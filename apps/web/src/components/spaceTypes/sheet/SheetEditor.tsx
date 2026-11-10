// FILE: SheetEditor.tsx
// Purpose: The 电子表格 editor: a full spreadsheet (formulas, formatting, several sheets) on
//          the Fortune-sheet engine (MIT), with .xlsx / .csv import and export.
// Layer: 资料空间 电子表格 (types stream). Loaded lazily; the host saves the workbook.

import "@fortune-sheet/react/dist/index.css";

import { Workbook } from "@fortune-sheet/react";
import type { Sheet as EngineSheet } from "@fortune-sheet/core";
import { type ComponentRef, useMemo, useRef, useState } from "react";

import type { SheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";

import { downloadBlob } from "~/lib/browserDownload";
import { DownloadIcon, FileAddIcon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "../../ui/menu";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { fromEngineSheets, toEngineSheets } from "./sheetEngine";
import { computeWorkbookFormulas } from "./sheetFormulas";

const TOOLBAR = [
  "undo",
  "redo",
  "|",
  "format-painter",
  "clear-format",
  "|",
  "currency-format",
  "percentage-format",
  "number-decrease",
  "number-increase",
  "format",
  "|",
  "font-size",
  "|",
  "bold",
  "italic",
  "strike-through",
  "|",
  "font-color",
  "background",
  "border",
  "merge-cell",
  "|",
  "horizontal-align",
  "vertical-align",
  "text-wrap",
  "|",
  "freeze",
  "sort",
  "filter",
  "|",
  "quick-formula",
];

function safeName(title: string, extension: string) {
  return `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").trim() || "电子表格"}.${extension}`;
}

export function SheetEditor(props: {
  workbook: SheetWorkbook;
  title: string;
  readOnly?: boolean;
  onChange: (workbook: SheetWorkbook) => void;
  /** Replaces the whole workbook (import); the editor remounts with the new data. */
  onReplace: (workbook: SheetWorkbook) => void;
}) {
  // Typed from the component: the package's WorkbookInstance export disagrees with its own ref
  // prop under exactOptionalPropertyTypes.
  const engine = useRef<ComponentRef<typeof Workbook>>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The engine owns live state; it is seeded once per mount (the host remounts on import).
  const initial = useMemo(() => toEngineSheets(computeWorkbookFormulas(props.workbook)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = (): SheetWorkbook => {
    const sheets = engine.current?.getAllSheets();
    return sheets ? fromEngineSheets(sheets) : props.workbook;
  };

  const exportAs = async (format: "xlsx" | "csv") => {
    setError(null);
    setBusy(format === "xlsx" ? "正在导出 Excel…" : "正在导出 CSV…");
    try {
      const { workbookToXlsx, workbookSheetToCsv } = await import("./sheetXlsx");
      const workbook = current();
      if (format === "xlsx") {
        const bytes = await workbookToXlsx(workbook);
        downloadBlob(
          new Blob([bytes as BlobPart], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          safeName(props.title, "xlsx"),
        );
      } else {
        downloadBlob(
          new Blob([workbookSheetToCsv(workbook)], { type: "text/csv;charset=utf-8" }),
          safeName(props.title, "csv"),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? `导出失败：${cause.message}` : "导出失败。");
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    setError(null);
    setBusy("正在导入…");
    try {
      const { xlsxToWorkbook, csvToWorkbook } = await import("./sheetXlsx");
      const workbook = /\.csv$/iu.test(file.name)
        ? csvToWorkbook(
            await file.text(),
            file.name.replace(/\.csv$/iu, "").slice(0, 31) || "工作表1",
          )
        : await xlsxToWorkbook(await file.arrayBuffer());
      props.onReplace(workbook);
    } catch (cause) {
      setError(cause instanceof Error ? `导入失败：${cause.message}` : "导入失败。");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-sheet-editor>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        {props.readOnly ? null : (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
          >
            <FileAddIcon /> 导入
          </Button>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost" disabled={busy !== null} />}>
            <DownloadIcon /> 导出
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" className="w-48 min-w-48">
            <MenuGroup>
              <MenuItem onClick={() => void exportAs("xlsx")}>Excel 工作簿（.xlsx）</MenuItem>
              <MenuItem onClick={() => void exportAs("csv")}>CSV（当前第一张表）</MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
        {busy ? (
          <span role="status" className="text-ui-sm text-muted-foreground">
            {busy}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="text-ui-sm text-destructive">
            {error}
          </span>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1" data-sheet-engine>
        <Workbook
          ref={engine}
          data={initial}
          lang="zh"
          allowEdit={!props.readOnly}
          showToolbar={!props.readOnly}
          toolbarItems={TOOLBAR}
          row={100}
          column={26}
          onChange={(sheets: EngineSheet[]) => {
            if (props.readOnly) return;
            try {
              props.onChange(fromEngineSheets(sheets));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "无法保存这次修改。");
            }
          }}
        />
      </div>
    </div>
  );
}
