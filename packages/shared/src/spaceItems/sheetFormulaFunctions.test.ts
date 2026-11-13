import { describe, expect, it } from "vitest";

import { matchesCriterion } from "./sheetFormulaFunctions";
import { computeWorkbookFormulas } from "./sheetFormulas";
import { parseSheetWorkbook, type SheetCell } from "./sheetWorkbook";

const data: SheetCell[] = [
  ["项目", "类别", "金额", "状态"],
  ["房租", "固定", 3000, "已付"],
  ["伙食", "日常", 1720, "超支"],
  ["交通", "日常", 260, "已付"],
  ["学习", "成长", 480, ""],
].flatMap((row, r) => row.map((v, c) => ({ r, c, v })));

function results(formulas: readonly string[]) {
  const workbook = computeWorkbookFormulas(
    parseSheetWorkbook({
      version: 1,
      sheets: [
        {
          id: "s1",
          name: "账",
          cells: [...data, ...formulas.map((f, i): SheetCell => ({ r: 10 + i, c: 0, v: null, f }))],
        },
      ],
    }),
  );
  return formulas.map(
    (_, i) => workbook.sheets[0]!.cells.find((cell) => cell.r === 10 + i && cell.c === 0)?.v,
  );
}

describe("Moss formula functions", () => {
  it("looks up with XLOOKUP, down a column or across a row, with a fallback", () => {
    expect(
      results([
        '=XLOOKUP("伙食",A2:A5,C2:C5)',
        '=XLOOKUP("水电",A2:A5,C2:C5,"没有")',
        '=XLOOKUP("水电",A2:A5,C2:C5)',
        '=XLOOKUP("金额",A1:D1,A3:D3)',
        '=XLOOKUP(500,C2:C5,A2:A5,"无",-1)',
        '=IFERROR(XLOOKUP("水电",A2:A5,C2:C5),0)',
      ]),
    ).toEqual([1720, "没有", "#N/A", 1720, "学习", 0]);
  });

  it("catches errors with IFERROR and IFNA, also from a cell that shows one", () => {
    expect(
      results([
        "=1/0",
        '=IFERROR(A11,"除不了")',
        "=ISERROR(A11)",
        '=IFNA(XLOOKUP("无",A2:A5,C2:C5),"找不到")',
        "=IFNA(A11,1)",
        "=ISERR(A11)",
        "=IFERROR(1/0,0)",
      ]),
    ).toEqual(["#DIV/0!", "除不了", true, "找不到", "#DIV/0!", true, 0]);
  });

  it("joins text with TEXTJOIN, skipping blanks when asked", () => {
    expect(results(['=TEXTJOIN("、",TRUE,D2:D5)', '=TEXTJOIN("|",FALSE,D4:D5)'])).toEqual([
      "已付、超支、已付",
      "已付|",
    ]);
  });

  it("finds the largest and smallest by conditions with MAXIFS and MINIFS", () => {
    expect(
      results([
        '=MAXIFS(C2:C5,B2:B5,"日常")',
        '=MINIFS(C2:C5,B2:B5,"日常")',
        '=MAXIFS(C2:C5,C2:C5,"<1000",D2:D5,"已付")',
        '=MINIFS(C2:C5,B2:B5,"不存在")',
      ]),
    ).toEqual([1720, 260, 260, 0]);
  });

  it("writes numbers in a format with TEXT and keeps HYPERLINK's label", () => {
    expect(
      results([
        '=TEXT(C2,"#,##0")',
        '=TEXT(0.256,"0.0%")',
        '=TEXT(A2,"0")',
        '=HYPERLINK("https://example.com","官网")',
        '=HYPERLINK("https://example.com")',
      ]),
    ).toEqual(["3,000", "25.6%", "房租", "官网", "https://example.com"]);
  });

  it("reads criteria the way COUNTIF does", () => {
    expect(matchesCriterion(5, ">3")).toBe(true);
    expect(matchesCriterion("5", ">3")).toBe(false);
    expect(matchesCriterion("Done", "done")).toBe(true);
    expect(matchesCriterion("已付款", "已付*")).toBe(true);
    expect(matchesCriterion("x", "<>x")).toBe(false);
    expect(matchesCriterion("", "")).toBe(true);
    expect(matchesCriterion(3, 3)).toBe(true);
  });
});
