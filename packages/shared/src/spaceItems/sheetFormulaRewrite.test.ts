import { describe, expect, it } from "vitest";

import { rewriteFormula, WHOLE_COLUMN_ROWS } from "./sheetFormulaFunctions";
import { computeWorkbookFormulas } from "./sheetFormulas";
import { parseSheetWorkbook, type SheetCell, type SheetWorkbook } from "./sheetWorkbook";

const data: SheetCell[] = [
  ["项目", "金额"],
  ["房租", 3000],
  ["伙食", 1720],
  ["交通", 260],
  ["学习", 480],
].flatMap((row, r) => row.map((v, c) => ({ r, c, v })));

function results(formulas: readonly string[]) {
  const workbook: SheetWorkbook = computeWorkbookFormulas(
    parseSheetWorkbook({
      version: 1,
      sheets: [
        {
          id: "s1",
          name: "账",
          cells: [...data, ...formulas.map((f, i): SheetCell => ({ r: 10 + i, c: 3, v: null, f }))],
        },
      ],
    }),
  );
  const at = (r: number, c: number) =>
    workbook.sheets[0]!.cells.find((cell) => cell.r === r && cell.c === c)?.v ?? null;
  return { values: formulas.map((_, i) => at(10 + i, 3)), at };
}

describe("formula text the parser's grammar lacks", () => {
  it("rewrites constants, LET and open ranges, leaving strings alone", () => {
    expect(rewriteFormula("SUM({1,2;3,4})")).toBe("SUM(MOSSARRAY(2,2,1,2,3,4))");
    expect(rewriteFormula("LET(x,2,y,x*3,x+y)")).toBe("((2)+((2)*3))");
    expect(rewriteFormula("SUM(B:B)")).toBe(`SUM(B1:B${WHOLE_COLUMN_ROWS})`);
    expect(rewriteFormula("SUM('账'!B3:B)")).toBe(`SUM('账'!B3:B${WHOLE_COLUMN_ROWS})`);
    expect(rewriteFormula("SUM(A1:B2)")).toBe("SUM(A1:B2)");
    expect(rewriteFormula('CONCAT("{a:b}",A1)')).toBe('CONCAT("{a:b}",A1)');
    expect(rewriteFormula('IF(true,"TRUE",FALSE)')).toBe('IF(TRUE(),"TRUE",FALSE())');
    expect(rewriteFormula("AND(TRUE(),'TRUE'!A1,TRUE!B2,TRUEX)")).toBe(
      "AND(TRUE(),'TRUE'!A1,TRUE!B2,TRUEX)",
    );
  });

  it("works them out", () => {
    const { values } = results([
      "=SUM({1,2,3})",
      "=SUM(B:B)",
      "=SUM(B3:B)",
      "=LET(rent,B2,food,B3,rent+food)",
      "=LET(x,B2,y,x*2,x+y)",
    ]);
    expect(values).toEqual([6, 5460, 2460, 4720, 9000]);
  });

  it("spills a constant block", () => {
    const { at } = results(["={1,2;3,4}"]);
    expect([at(10, 3), at(10, 4), at(11, 3), at(11, 4)]).toEqual([1, 2, 3, 4]);
  });

  it("works out IRR, XNPV and XIRR", () => {
    const { values } = results([
      "=IRR({-100,60,60})",
      "=XNPV(0.1,{-1000,1100},{46023,46388})",
      "=XIRR({-1000,1100},{46023,46388})",
    ]);
    expect(values[0]).toBeCloseTo(0.1307, 4);
    expect(values[1]).toBeCloseTo(0, 6);
    expect(values[2]).toBeCloseTo(0.1, 6);
  });
});
