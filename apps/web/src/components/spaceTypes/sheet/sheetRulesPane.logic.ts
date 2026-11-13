// FILE: sheetRulesPane.logic.ts
// Purpose: The 条件格式 pane's model: rules in the form agents read and write them
//          (readConditionalFormats / replaceConditionalFormats), a plain Chinese summary of each,
//          ready-made looks and colour scales, and a new rule for the selection.
// Layer: 资料空间 电子表格 (pure logic)
// Exports: PaneRule, PaneCondition, PaneTest, PaneColor, PaneFormat, describeRule, rulePreview,
//          newHighlightRule, newColorScaleRule, HIGHLIGHT_PRESETS, SCALE_PRESETS, CONDITION_CHOICES,
//          conditionNeeds.
// Why: The pane edits the same rule list an agent does, through the same edit, so a rule made by
//      hand and one made by Moss are one thing.

import {
  SHEET_PALETTE,
  type SheetHue,
  type SheetShade,
} from "@moss/shared/spaceItems/sheetWorkbook";

import { SHEET_WHITE } from "~/theme/sheetPalette";

export type PaneColor =
  | { readonly kind: "none" }
  | { readonly kind: "standard"; readonly hue: SheetHue; readonly shade: SheetShade }
  | { readonly kind: "rgb"; readonly hex: string };

export interface PaneFormat {
  readonly fillColor?: PaneColor;
  readonly font?: {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly strikethrough?: boolean;
    readonly color?: PaneColor;
  };
}

export type PaneOperand =
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "daysFromToday"; readonly days: number }
  | { readonly kind: "sameRowInColumn"; readonly c: string };

export type PaneCondition =
  | { readonly kind: "isBlank" | "isNotBlank" | "isAnError" | "appearsMoreThanOnce" }
  | {
      readonly kind:
        | "textIs"
        | "textIsNot"
        | "textContains"
        | "textDoesNotContain"
        | "textStartsWith"
        | "textEndsWith";
      readonly text: string;
    }
  | { readonly kind: "booleanIs"; readonly value: boolean }
  | {
      readonly kind: "numberIs";
      readonly comparison:
        | "equalTo"
        | "notEqualTo"
        | "greaterThan"
        | "greaterThanOrEqualTo"
        | "lessThan"
        | "lessThanOrEqualTo";
      readonly operand: PaneOperand;
    }
  | {
      readonly kind: "numberIsBetween" | "numberIsNotBetween";
      readonly oneEnd: PaneOperand;
      readonly otherEnd: PaneOperand;
    };

export interface PaneTest {
  readonly tested:
    | { readonly kind: "theCellItself" }
    | { readonly kind: "sameRowInColumn"; readonly c: string };
  readonly condition: PaneCondition;
}

type Anchor =
  | { readonly kind: "smallestNumber" }
  | { readonly kind: "largestNumber" }
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "percentile"; readonly percentile: number };
interface Stop {
  readonly anchor: Anchor;
  readonly color: PaneColor;
}

export type PaneRule =
  | {
      readonly cells: readonly string[];
      readonly effect: {
        readonly kind: "formatWhere";
        readonly allOf: readonly PaneTest[];
        readonly format: PaneFormat;
      };
    }
  | {
      readonly cells: readonly string[];
      readonly effect: {
        readonly kind: "colorScale";
        readonly lowest: Stop;
        readonly middle: Stop | null;
        readonly highest: Stop;
      };
    };

export function paneColorHex(color: PaneColor | undefined): string | null {
  if (!color || color.kind === "none") return null;
  if (color.kind === "rgb") return color.hex;
  return SHEET_PALETTE[color.hue][color.shade];
}

const standard = (hue: SheetHue, shade: SheetShade): PaneColor => ({
  kind: "standard",
  hue,
  shade,
});

/** Ready-made looks, as a spreadsheet person knows them. */
export const HIGHLIGHT_PRESETS: readonly { readonly label: string; readonly format: PaneFormat }[] =
  [
    {
      label: "浅红底，深红字",
      format: { fillColor: standard("red", 100), font: { color: standard("red", 800) } },
    },
    {
      label: "浅黄底，深黄字",
      format: { fillColor: standard("yellow", 100), font: { color: standard("yellow", 800) } },
    },
    {
      label: "浅绿底，深绿字",
      format: { fillColor: standard("green", 100), font: { color: standard("green", 800) } },
    },
    { label: "浅蓝底", format: { fillColor: standard("blue", 100) } },
    { label: "红字", format: { font: { color: standard("red", 600) } } },
    { label: "加粗", format: { font: { bold: true } } },
    {
      label: "灰字加删除线",
      format: { font: { color: standard("gray", 600), strikethrough: true } },
    },
  ];

const lowest = (color: PaneColor): Stop => ({ anchor: { kind: "smallestNumber" }, color });
const middle = (color: PaneColor): Stop => ({
  anchor: { kind: "percentile", percentile: 50 },
  color,
});
const highest = (color: PaneColor): Stop => ({ anchor: { kind: "largestNumber" }, color });
const WHITE: PaneColor = { kind: "rgb", hex: SHEET_WHITE.toLowerCase() };

export const SCALE_PRESETS: readonly {
  readonly label: string;
  readonly lowest: Stop;
  readonly middle: Stop | null;
  readonly highest: Stop;
}[] = [
  {
    label: "白 → 绿",
    lowest: lowest(WHITE),
    middle: null,
    highest: highest(standard("green", 400)),
  },
  { label: "白 → 红", lowest: lowest(WHITE), middle: null, highest: highest(standard("red", 400)) },
  {
    label: "红 → 黄 → 绿",
    lowest: lowest(standard("red", 300)),
    middle: middle(standard("yellow", 200)),
    highest: highest(standard("green", 300)),
  },
  {
    label: "绿 → 黄 → 红",
    lowest: lowest(standard("green", 300)),
    middle: middle(standard("yellow", 200)),
    highest: highest(standard("red", 300)),
  },
  {
    label: "蓝 → 白 → 红",
    lowest: lowest(standard("blue", 300)),
    middle: middle(WHITE),
    highest: highest(standard("red", 300)),
  },
];

/** The conditions the pane offers, in the order a person looks for them. */
export const CONDITION_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "numberIs:greaterThan", label: "大于" },
  { value: "numberIs:greaterThanOrEqualTo", label: "大于或等于" },
  { value: "numberIs:lessThan", label: "小于" },
  { value: "numberIs:lessThanOrEqualTo", label: "小于或等于" },
  { value: "numberIs:equalTo", label: "等于" },
  { value: "numberIs:notEqualTo", label: "不等于" },
  { value: "numberIsBetween", label: "介于" },
  { value: "numberIsNotBetween", label: "不介于" },
  { value: "textContains", label: "文字包含" },
  { value: "textDoesNotContain", label: "文字不包含" },
  { value: "textIs", label: "文字是" },
  { value: "textIsNot", label: "文字不是" },
  { value: "textStartsWith", label: "文字开头是" },
  { value: "textEndsWith", label: "文字结尾是" },
  { value: "isBlank", label: "为空" },
  { value: "isNotBlank", label: "不为空" },
  { value: "appearsMoreThanOnce", label: "出现不止一次" },
  { value: "isAnError", label: "是错误" },
  { value: "booleanIs:true", label: "已勾选" },
  { value: "booleanIs:false", label: "未勾选" },
];

export function conditionChoice(condition: PaneCondition): string {
  if (condition.kind === "numberIs") return `numberIs:${condition.comparison}`;
  if (condition.kind === "booleanIs") return `booleanIs:${condition.value}`;
  return condition.kind;
}

/** What a condition needs typed in: nothing, one value, two ends, or text. */
export function conditionNeeds(choice: string): "none" | "operand" | "between" | "text" {
  if (choice.startsWith("numberIs:")) return "operand";
  if (choice === "numberIsBetween" || choice === "numberIsNotBetween") return "between";
  if (choice.startsWith("text")) return "text";
  return "none";
}

/** A condition for a choice, keeping what the person typed where it still fits. */
export function conditionFor(choice: string, previous: PaneCondition): PaneCondition {
  const operand: PaneOperand =
    previous.kind === "numberIs"
      ? previous.operand
      : previous.kind === "numberIsBetween" || previous.kind === "numberIsNotBetween"
        ? previous.oneEnd
        : { kind: "number", number: 0 };
  const text = "text" in previous ? previous.text : "";
  if (choice.startsWith("numberIs:"))
    return { kind: "numberIs", comparison: choice.slice(9) as never, operand };
  if (choice === "numberIsBetween" || choice === "numberIsNotBetween")
    return {
      kind: choice,
      oneEnd: operand,
      otherEnd:
        previous.kind === "numberIsBetween" || previous.kind === "numberIsNotBetween"
          ? previous.otherEnd
          : { kind: "number", number: 100 },
    };
  if (choice.startsWith("booleanIs:")) return { kind: "booleanIs", value: choice.endsWith("true") };
  if (choice.startsWith("text")) return { kind: choice as never, text };
  return { kind: choice as never };
}

const COMPARISON_WORDS: Record<string, string> = {
  equalTo: "等于",
  notEqualTo: "不等于",
  greaterThan: "大于",
  greaterThanOrEqualTo: "至少为",
  lessThan: "小于",
  lessThanOrEqualTo: "至多为",
};

function operandText(operand: PaneOperand): string {
  if (operand.kind === "number") return String(operand.number);
  if (operand.kind === "sameRowInColumn") return `${operand.c} 列`;
  if (operand.days === 0) return "今天";
  return operand.days > 0 ? `${operand.days} 天后` : `${-operand.days} 天前`;
}

function testText(test: PaneTest): string {
  const who = test.tested.kind === "sameRowInColumn" ? `${test.tested.c} 列` : "单元格";
  const c = test.condition;
  switch (c.kind) {
    case "isBlank":
      return `${who}为空`;
    case "isNotBlank":
      return `${who}不为空`;
    case "isAnError":
      return `${who}是错误`;
    case "appearsMoreThanOnce":
      return `${who}出现不止一次`;
    case "booleanIs":
      return `${who}${c.value ? "已勾选" : "未勾选"}`;
    case "textIs":
      return `${who}是“${c.text}”`;
    case "textIsNot":
      return `${who}不是“${c.text}”`;
    case "textContains":
      return `${who}包含“${c.text}”`;
    case "textDoesNotContain":
      return `${who}不包含“${c.text}”`;
    case "textStartsWith":
      return `${who}以“${c.text}”开头`;
    case "textEndsWith":
      return `${who}以“${c.text}”结尾`;
    case "numberIs":
      return `${who}${COMPARISON_WORDS[c.comparison] ?? c.comparison} ${operandText(c.operand)}`;
    case "numberIsBetween":
      return `${who}介于 ${operandText(c.oneEnd)} 和 ${operandText(c.otherEnd)} 之间`;
    case "numberIsNotBetween":
      return `${who}不在 ${operandText(c.oneEnd)} 和 ${operandText(c.otherEnd)} 之间`;
  }
}

/** "C2:C7 · 单元格大于 1000", "色阶 · B2:B20". */
export function describeRule(rule: PaneRule): string {
  const cells = rule.cells.join("、");
  if (rule.effect.kind === "colorScale") return `色阶 · ${cells}`;
  return `${rule.effect.allOf.map(testText).join("，且")} · ${cells}`;
}

/** The look a rule gives, for its swatch in the list. */
export function rulePreview(rule: PaneRule): {
  readonly fill: string | null;
  readonly color: string | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly gradient: string | null;
} {
  if (rule.effect.kind === "colorScale") {
    const stops = [rule.effect.lowest, rule.effect.middle, rule.effect.highest]
      .filter((stop): stop is Stop => stop !== null)
      .map((stop) => paneColorHex(stop.color) ?? "transparent");
    return {
      fill: null,
      color: null,
      bold: false,
      italic: false,
      strike: false,
      gradient: `linear-gradient(90deg, ${stops.join(", ")})`,
    };
  }
  const f = rule.effect.format;
  return {
    fill: paneColorHex(f.fillColor),
    color: paneColorHex(f.font?.color),
    bold: f.font?.bold === true,
    italic: f.font?.italic === true,
    strike: f.font?.strikethrough === true,
    gradient: null,
  };
}

export function newHighlightRule(cells: string): PaneRule {
  return {
    cells: [cells],
    effect: {
      kind: "formatWhere",
      allOf: [
        {
          tested: { kind: "theCellItself" },
          condition: {
            kind: "numberIs",
            comparison: "greaterThan",
            operand: { kind: "number", number: 0 },
          },
        },
      ],
      format: HIGHLIGHT_PRESETS[0]!.format,
    },
  };
}

export function newColorScaleRule(cells: string): PaneRule {
  const preset = SCALE_PRESETS[2]!;
  return {
    cells: [cells],
    effect: {
      kind: "colorScale",
      lowest: preset.lowest,
      middle: preset.middle,
      highest: preset.highest,
    },
  };
}

/** Moves a rule one place up or down (higher rules win). */
export function moveRule(rules: readonly PaneRule[], index: number, step: -1 | 1): PaneRule[] {
  const next = [...rules];
  const to = index + step;
  if (to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
