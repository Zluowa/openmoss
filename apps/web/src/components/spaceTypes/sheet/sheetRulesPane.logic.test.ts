import { applySheetEdits, readSheetWorkbook } from "@moss/shared/spaceItems/sheetEdits";
import { evaluateSheetRules } from "@moss/shared/spaceItems/sheetRules";
import { parseSheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";
import { describe, expect, it } from "vitest";

import {
  HIGHLIGHT_PRESETS,
  SCALE_PRESETS,
  conditionChoice,
  conditionFor,
  conditionNeeds,
  describeRule,
  moveRule,
  newColorScaleRule,
  newHighlightRule,
  type PaneRule,
} from "./sheetRulesPane.logic";

const workbook = parseSheetWorkbook({
  version: 1,
  sheets: [
    {
      id: "s1",
      name: "预算",
      cells: [
        { r: 0, c: 0, v: "项目" },
        { r: 0, c: 1, v: "预算" },
        { r: 0, c: 2, v: "实际" },
        { r: 1, c: 0, v: "房租" },
        { r: 1, c: 1, v: 3000 },
        { r: 1, c: 2, v: 3000 },
        { r: 2, c: 0, v: "伙食" },
        { r: 2, c: 1, v: 1500 },
        { r: 2, c: 2, v: 1720 },
      ],
    },
  ],
});

function save(rules: readonly PaneRule[]) {
  const read = readSheetWorkbook(workbook, 0, {
    kind: "readConditionalFormats",
    sheet: "预算",
  }) as { fingerprint: string };
  return applySheetEdits(workbook, [
    { kind: "replaceConditionalFormats", sheet: "预算", inPlaceOf: read.fingerprint, rules },
  ]).workbook;
}

describe("条件格式 pane", () => {
  it("writes rules the shared edit takes and reads them back the same", () => {
    const overBudget: PaneRule = {
      cells: ["C2:C3"],
      effect: {
        kind: "formatWhere",
        allOf: [
          {
            tested: { kind: "theCellItself" },
            condition: {
              kind: "numberIs",
              comparison: "greaterThan",
              operand: { kind: "sameRowInColumn", c: "B" },
            },
          },
        ],
        format: HIGHLIGHT_PRESETS[0]!.format,
      },
    };
    const rules = [overBudget, newColorScaleRule("B2:B3")];
    const next = save(rules);
    const back = readSheetWorkbook(next, 1, { kind: "readConditionalFormats", sheet: "预算" }) as {
      rules: PaneRule[];
    };
    expect(back.rules).toEqual(rules);
    // 伙食 spent more than its budget: its 实际 cell takes the look.
    const looks = evaluateSheetRules(next.sheets[0]!);
    expect(looks.get("2:2")?.fill).toBeTruthy();
    expect(looks.get("1:2")?.fill).toBeUndefined();
  });

  it("takes every ready-made look and colour scale", () => {
    const rules: PaneRule[] = [
      ...HIGHLIGHT_PRESETS.map(
        (preset): PaneRule => ({
          cells: ["C2:C3"],
          effect: {
            kind: "formatWhere",
            allOf: [{ tested: { kind: "theCellItself" }, condition: { kind: "isNotBlank" } }],
            format: preset.format,
          },
        }),
      ),
      ...SCALE_PRESETS.map((preset) => ({
        cells: ["B2:B3"],
        effect: {
          kind: "colorScale" as const,
          lowest: preset.lowest,
          middle: preset.middle,
          highest: preset.highest,
        },
      })),
    ];
    expect(save(rules).sheets[0]!.rules).toHaveLength(rules.length);
  });

  it("says what a rule does in plain words", () => {
    expect(describeRule(newHighlightRule("C2:C7"))).toBe("单元格大于 0 · C2:C7");
    expect(describeRule(newColorScaleRule("B2:B9"))).toBe("色阶 · B2:B9");
    expect(
      describeRule({
        cells: ["A2:D20"],
        effect: {
          kind: "formatWhere",
          allOf: [
            {
              tested: { kind: "sameRowInColumn", c: "D" },
              condition: { kind: "textIs", text: "超支" },
            },
            { tested: { kind: "theCellItself" }, condition: { kind: "isNotBlank" } },
          ],
          format: {},
        },
      }),
    ).toBe("D 列是“超支”，且单元格不为空 · A2:D20");
  });

  it("switches conditions keeping what was typed", () => {
    const greater = newHighlightRule("A1").effect;
    if (greater.kind !== "formatWhere") throw new Error("highlight expected");
    const first = greater.allOf[0]!.condition;
    expect(conditionChoice(first)).toBe("numberIs:greaterThan");
    const between = conditionFor("numberIsBetween", first);
    expect(between).toMatchObject({
      kind: "numberIsBetween",
      oneEnd: { kind: "number", number: 0 },
    });
    expect(conditionNeeds("numberIsBetween")).toBe("between");
    const text = conditionFor("textContains", { kind: "textIs", text: "完成" });
    expect(text).toEqual({ kind: "textContains", text: "完成" });
    expect(conditionFor("booleanIs:false", text)).toEqual({ kind: "booleanIs", value: false });
    expect(conditionNeeds("isBlank")).toBe("none");
  });

  it("moves a rule up or down, higher first", () => {
    const a = newHighlightRule("A1");
    const b = newColorScaleRule("B1");
    expect(moveRule([a, b], 1, -1)).toEqual([b, a]);
    expect(moveRule([a, b], 0, -1)).toEqual([a, b]);
  });
});
