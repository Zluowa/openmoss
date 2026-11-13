import { describe, expect, it } from "vitest";

import { applySheetEdits, readSheetWorkbook, SheetEditRefusal } from "./sheetEdits";
import { nowSerial } from "./sheetFormulaFunctions";
import { dateToSerial } from "./sheetValues";
import {
  delocalizeNumberText,
  localizeNumberText,
  parseSheetWorkbook,
  type SheetWorkbook,
} from "./sheetWorkbook";

const book = (extra: Partial<SheetWorkbook> = {}): SheetWorkbook =>
  parseSheetWorkbook({
    version: 1,
    sheets: [{ id: "s1", name: "账", cells: [{ r: 0, c: 0, v: 1234.5 }] }],
    ...extra,
  });

describe("a Sheet's locale and time zone", () => {
  it("writes numbers with the locale's marks and reads them back", () => {
    expect(localizeNumberText("1,234.50", "de-DE")).toBe("1.234,50");
    expect(localizeNumberText("¥1,234.50", "fr-FR")).toBe("¥1 234,50");
    expect(localizeNumberText("1,234.50", "zh-CN")).toBe("1,234.50");
    expect(localizeNumberText("2026-03-15", "de-DE")).toBe("2026-03-15");
    expect(delocalizeNumberText("1.234,5", "de-DE")).toBe("1234.5");
    expect(delocalizeNumberText("12,5%", "de-DE")).toBe("12.5%");
    expect(delocalizeNumberText("1 234,5", "fr-FR")).toBe("1234.5");
    expect(delocalizeNumberText("15.03.2026", "de-DE")).toBe("2026-03-15");
    expect(delocalizeNumberText("31/12/26", "en-GB")).toBe("2026-12-31");
    expect(delocalizeNumberText("03/04/2026", "en-US")).toBe("03/04/2026");
    expect(delocalizeNumberText("2026/3/5", "zh-CN")).toBe("2026-03-05");
    expect(delocalizeNumberText("1,5", "en-US")).toBe("1,5");
  });

  it("writes month names in the locale's language", () => {
    expect(localizeNumberText("Mar 15, 2026", "zh-CN")).toContain("3月");
    expect(localizeNumberText("March 2026", "fr-FR")).toBe("mars 2026");
    expect(localizeNumberText("Mar 15, 2026", "en-GB")).toBe("Mar 15, 2026");
    expect(localizeNumberText("Marketing", "de-DE")).toBe("Marketing");
  });

  it("keeps the locale and time zone in the workbook and refuses ones it does not know", () => {
    expect(book({ locale: "de-DE", timeZone: "Europe/Berlin" })).toMatchObject({
      locale: "de-DE",
      timeZone: "Europe/Berlin",
    });
    expect(() => book({ locale: "xx-XX" as never })).toThrow("locale");
    expect(() => book({ timeZone: "Mars/Olympus" })).toThrow("timeZone");
  });

  it("lets an agent read and set them", () => {
    expect(readSheetWorkbook(book(), 1, { kind: "readSheets" })).toMatchObject({
      locale: "zh-CN",
      timeZone: null,
    });
    const next = applySheetEdits(book(), [
      { kind: "setLocale", locale: "de-DE" },
      { kind: "setTimeZone", timeZone: "America/New_York" },
    ]).workbook;
    expect(next).toMatchObject({ locale: "de-DE", timeZone: "America/New_York" });
    // Other edits keep them.
    const later = applySheetEdits(next, [
      { kind: "writeCells", sheet: "账", topLeft: "B1", rows: [["x"]] },
    ]).workbook;
    expect(later).toMatchObject({ locale: "de-DE", timeZone: "America/New_York" });
    const back = applySheetEdits(later, [
      { kind: "setLocale", locale: "zh-CN" },
      { kind: "setTimeZone", timeZone: null },
    ]).workbook;
    expect(back.locale).toBeUndefined();
    expect(back.timeZone).toBeUndefined();
    expect(() => applySheetEdits(book(), [{ kind: "setTimeZone", timeZone: "Nowhere" }])).toThrow(
      SheetEditRefusal,
    );
  });

  it("works out TODAY and NOW in the Sheet's time zone", () => {
    // 2026-03-15 23:30 in UTC is already March 16 in Shanghai.
    const at = new Date(Date.UTC(2026, 2, 15, 23, 30, 0));
    expect(Math.floor(nowSerial(at, "Asia/Shanghai"))).toBe(dateToSerial(2026, 3, 16));
    expect(Math.floor(nowSerial(at, "America/New_York"))).toBe(dateToSerial(2026, 3, 15));
    expect(nowSerial(at, "UTC") - dateToSerial(2026, 3, 15)).toBeCloseTo(23.5 / 24, 6);
  });
});
