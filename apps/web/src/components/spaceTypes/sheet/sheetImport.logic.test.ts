import { parseSheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";
import { describe, expect, it } from "vitest";

import {
  applyImportPlan,
  firstImportPlan,
  importSummary,
  importValue,
  readImportRows,
  type ImportPlan,
} from "./sheetImport.logic";

const CSV = '项目,金额,占比,日期\n房租,"3,000",50%,2026-03-01\n伙食,1200,20%,2026-03-02\n,,,\n';

const current = parseSheetWorkbook({
  version: 1,
  sheets: [
    {
      id: "s1",
      name: "账",
      cells: [
        { r: 0, c: 0, v: "金额" },
        { r: 0, c: 1, v: "项目" },
        { r: 1, c: 0, v: 99 },
        { r: 1, c: 1, v: "旧的" },
      ],
    },
  ],
});

const at = (
  workbook: ReturnType<typeof parseSheetWorkbook>,
  sheetId: string,
  r: number,
  c: number,
) =>
  workbook.sheets.find((s) => s.id === sheetId)?.cells.find((cell) => cell.r === r && cell.c === c);

describe("CSV import dialog", () => {
  it("reads the file, finds the headings and names the columns", () => {
    const { plan, rows } = firstImportPlan(CSV, "三月.csv");
    expect(rows).toHaveLength(3);
    expect(plan).toMatchObject({
      separator: ",",
      headings: true,
      mode: "newSheet",
      sheetName: "三月",
    });
    expect(plan.columns.map((c) => c.name)).toEqual(["项目", "金额", "占比", "日期"]);
    expect(importSummary(rows, plan.separator)).toBe("3 行，用逗号分隔");
    expect(readImportRows("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads each field as its column's type; what does not fit stays text", () => {
    expect(importValue("3,000", "auto")).toEqual({ v: 3000, s: { format: "#,##0" } });
    expect(importValue("50%", "auto").v).toBe(0.5);
    expect(importValue("02139", "text")).toEqual({ v: "02139" });
    expect(importValue("50", "percent")).toMatchObject({ v: 0.5, s: { format: "0%" } });
    expect(importValue("1200", "currency")).toMatchObject({ v: 1200, s: { format: "¥#,##0.00" } });
    expect(importValue("待定", "number")).toEqual({ v: "待定" });
    expect(importValue("2026-03-01", "date").s?.format).toBe("yyyy-mm-dd");
    expect(importValue("=SUM(A1:A2)", "auto")).toEqual({ v: "=SUM(A1:A2)" });
    expect(importValue("  ", "auto")).toEqual({ v: null });
  });

  it("puts the file on a new sheet with bold, frozen headings and leaves out unticked columns", () => {
    const { plan, rows } = firstImportPlan(CSV, "三月.csv");
    const outcome = applyImportPlan(
      {
        ...plan,
        columns: plan.columns.map((c) => (c.index === 2 ? { ...c, included: false } : c)),
      },
      rows,
      current,
      "s1",
    );
    const sheet = outcome.workbook.sheets.find((s) => s.id === outcome.sheetId)!;
    expect(sheet).toMatchObject({ name: "三月", frozenRows: 1 });
    expect(outcome.workbook.sheets).toHaveLength(2);
    expect(at(outcome.workbook, sheet.id, 0, 1)).toMatchObject({ v: "金额", s: { bold: true } });
    expect(at(outcome.workbook, sheet.id, 1, 1)?.v).toBe(3000);
    // 占比 was left out, so 日期 moves next to 金额.
    expect(at(outcome.workbook, sheet.id, 0, 2)?.v).toBe("日期");
    expect(outcome.rowCount).toBe(2);
  });

  it("adds rows under the current sheet's rows, matching columns by heading", () => {
    const { plan, rows } = firstImportPlan(CSV, "三月.csv");
    const outcome = applyImportPlan({ ...plan, mode: "append" }, rows, current, "s1");
    expect(outcome.sheetId).toBe("s1");
    expect(at(outcome.workbook, "s1", 2, 0)?.v).toBe(3000);
    expect(at(outcome.workbook, "s1", 2, 1)?.v).toBe("房租");
    expect(at(outcome.workbook, "s1", 1, 1)?.v).toBe("旧的");
    expect(outcome.unmatched).toEqual(["占比", "日期"]);
  });

  it("replaces the current sheet's rows and keeps its headings", () => {
    const { plan, rows } = firstImportPlan(CSV, "三月.csv");
    const outcome = applyImportPlan({ ...plan, mode: "replace" }, rows, current, "s1");
    expect(at(outcome.workbook, "s1", 0, 0)?.v).toBe("金额");
    expect(at(outcome.workbook, "s1", 1, 1)?.v).toBe("房租");
    expect(at(outcome.workbook, "s1", 2, 1)?.v).toBe("伙食");
    expect(outcome.workbook.sheets[0]!.cells.some((cell) => cell.v === "旧的")).toBe(false);
  });

  it("takes a file without headings by position", () => {
    const plan: ImportPlan = {
      ...firstImportPlan("1,2\n3,4", "n.csv").plan,
      mode: "append",
    };
    expect(plan.headings).toBe(false);
    const outcome = applyImportPlan(plan, readImportRows("1,2\n3,4", ","), current, "s1");
    expect(at(outcome.workbook, "s1", 2, 0)?.v).toBe(1);
    expect(at(outcome.workbook, "s1", 3, 1)?.v).toBe(4);
  });

  it("updates the rows that match by a column and adds the rest", () => {
    const ledger = parseSheetWorkbook({
      version: 1,
      sheets: [
        {
          id: "s1",
          name: "账",
          cells: [
            { r: 0, c: 0, v: "项目" },
            { r: 0, c: 1, v: "金额" },
            { r: 1, c: 0, v: "房租" },
            { r: 1, c: 1, v: 2800 },
            { r: 2, c: 0, v: "水电" },
            { r: 2, c: 1, v: 300 },
          ],
        },
      ],
    });
    const { plan, rows } = firstImportPlan(CSV, "三月.csv");
    const outcome = applyImportPlan({ ...plan, mode: "update", matchBy: 0 }, rows, ledger, "s1");
    expect(outcome).toMatchObject({ updated: 1, added: 1, unmatched: ["占比", "日期"] });
    expect(at(outcome.workbook, "s1", 1, 1)?.v).toBe(3000);
    expect(at(outcome.workbook, "s1", 2, 1)?.v).toBe(300);
    expect(at(outcome.workbook, "s1", 3, 0)?.v).toBe("伙食");
    expect(at(outcome.workbook, "s1", 3, 1)?.v).toBe(1200);
    expect(() =>
      applyImportPlan(
        { ...plan, mode: "update", matchBy: 0 },
        rows,
        parseSheetWorkbook({
          version: 1,
          sheets: [
            {
              id: "s1",
              name: "账",
              cells: [
                { r: 0, c: 0, v: "项目" },
                { r: 1, c: 0, v: "房租" },
                { r: 2, c: 0, v: "房租" },
              ],
            },
          ],
        }),
        "s1",
      ),
    ).toThrow("重复");
  });

  it("refuses an empty file", () => {
    expect(() => firstImportPlan("\n\n", "empty.csv")).toThrow("这个文件是空的。");
  });
});
