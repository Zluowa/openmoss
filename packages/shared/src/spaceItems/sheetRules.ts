// FILE: sheetRules.ts
// Purpose: Works out what a sheet's conditional-format rules give each cell: a fill, a font
//          colour and font looks, or a colour from a colour scale.
// Layer: Shared model (the editor paints the result over the grid; tests)
// Exports: evaluateSheetRules, RuleLook.
// Why: Rules go by what cells hold, so their look is computed on every change rather than
//      stored in cells; the first rule in the list wins each property.

import type {
  Sheet,
  SheetRule,
  SheetRuleCondition,
  SheetRuleOperand,
  SheetScalar,
} from "./sheetWorkbook";
import { dateToSerial } from "./sheetValues";

export interface RuleLook {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: "single" | "double";
}

const ERRORS = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|ERROR!|SPILL!|CALC!)$/u;

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa
    .map((x, i) =>
      Math.round(x + (pb[i]! - x) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function evaluateSheetRules(sheet: Sheet, now: Date = new Date()): Map<string, RuleLook> {
  const out = new Map<string, RuleLook>();
  if (!sheet.rules?.length) return out;
  const values = new Map<string, SheetScalar>(
    sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell.v]),
  );
  const today = dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const valueAt = (r: number, c: number) => values.get(`${r}:${c}`) ?? null;
  const operand = (o: SheetRuleOperand, r: number): number | null => {
    if (o.kind === "number") return o.number;
    if (o.kind === "daysFromToday") return today + o.days;
    const v = valueAt(r, o.c);
    return typeof v === "number" ? v : null;
  };
  const cellsOf = (rule: SheetRule) => {
    const list: [number, number][] = [];
    for (const range of rule.ranges)
      for (let r = range.r0; r <= Math.min(range.r1, range.r0 + 20_000); r++)
        for (let c = range.c0; c <= range.c1; c++) list.push([r, c]);
    return list;
  };
  const put = (r: number, c: number, look: RuleLook) => {
    const key = `${r}:${c}`;
    const current = out.get(key) ?? {};
    // The first rule that gives a property keeps it.
    for (const [name, value] of Object.entries(look))
      if (value !== undefined && (current as Record<string, unknown>)[name] === undefined)
        (current as Record<string, unknown>)[name] = value;
    out.set(key, current);
  };
  for (const rule of sheet.rules) {
    const cells = cellsOf(rule);
    if (rule.effect.kind === "colorScale") {
      const numbers = cells
        .map(([r, c]) => valueAt(r, c))
        .filter((v): v is number => typeof v === "number");
      if (numbers.length === 0) continue;
      const sorted = [...numbers].sort((a, b) => a - b);
      const at = (anchor: (typeof rule.effect)["lowest"]["anchor"]) =>
        anchor.kind === "smallestNumber"
          ? sorted[0]!
          : anchor.kind === "largestNumber"
            ? sorted.at(-1)!
            : anchor.kind === "number"
              ? anchor.number
              : percentile(sorted, anchor.percentile);
      const stops = [rule.effect.lowest, rule.effect.middle, rule.effect.highest]
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({ at: at(s.anchor), color: s.color ?? "#FFFFFF", none: s.color === null }));
      for (const [r, c] of cells) {
        const v = valueAt(r, c);
        if (typeof v !== "number") continue;
        let color = stops[0]!.color;
        if (v >= stops.at(-1)!.at) color = stops.at(-1)!.color;
        else
          for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i]!;
            const b = stops[i + 1]!;
            if (v >= a.at && v <= b.at) {
              color = mix(a.color, b.color, b.at === a.at ? 1 : (v - a.at) / (b.at - a.at));
              break;
            }
          }
        if (color !== "#FFFFFF") put(r, c, { fill: color });
      }
      continue;
    }
    const effect = rule.effect;
    // Tests over all of the rule's cells (largest, smallest, repeats) are worked out once.
    const pool = cells.map(([r, c]) => valueAt(r, c));
    const numbers = pool.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    const counts = new Map<string, number>();
    for (const v of pool)
      if (v !== null && v !== "")
        counts.set(String(v).toLowerCase(), (counts.get(String(v).toLowerCase()) ?? 0) + 1);
    const holds = (condition: SheetRuleCondition, v: SheetScalar, r: number): boolean => {
      const blank = v === null || v === "";
      switch (condition.kind) {
        case "isBlank":
          return blank;
        case "isNotBlank":
          return !blank;
        case "isAnError":
          return typeof v === "string" && ERRORS.test(v);
        case "appearsMoreThanOnce":
          return !blank && (counts.get(String(v).toLowerCase()) ?? 0) > 1;
        case "booleanIs":
          return v === condition.value;
        case "textIs":
        case "textIsNot":
        case "textContains":
        case "textDoesNotContain":
        case "textStartsWith":
        case "textEndsWith": {
          const text = blank ? "" : String(v).toLowerCase();
          const want = condition.text.toLowerCase();
          if (condition.kind === "textIs") return text === want;
          if (condition.kind === "textIsNot") return text !== want;
          if (condition.kind === "textContains") return text.includes(want);
          if (condition.kind === "textDoesNotContain") return !text.includes(want);
          if (condition.kind === "textStartsWith") return text.startsWith(want);
          return text.endsWith(want);
        }
        case "numberIs": {
          if (typeof v !== "number") return false;
          const o = operand(condition.operand, r);
          if (o === null) return false;
          switch (condition.comparison) {
            case "equalTo":
              return v === o;
            case "notEqualTo":
              return v !== o;
            case "greaterThan":
              return v > o;
            case "greaterThanOrEqualTo":
              return v >= o;
            case "lessThan":
              return v < o;
            case "lessThanOrEqualTo":
              return v <= o;
          }
          return false;
        }
        case "numberIsBetween":
        case "numberIsNotBetween": {
          if (typeof v !== "number") return false;
          const a = operand(condition.oneEnd, r);
          const b = operand(condition.otherEnd, r);
          if (a === null || b === null) return false;
          const inside = v >= Math.min(a, b) && v <= Math.max(a, b);
          return condition.kind === "numberIsBetween" ? inside : !inside;
        }
        case "isAmongTheLargest":
          return (
            typeof v === "number" &&
            numbers.length > 0 &&
            v >= numbers[Math.max(0, numbers.length - condition.count)]!
          );
        case "isAmongTheSmallest":
          return (
            typeof v === "number" &&
            numbers.length > 0 &&
            v <= numbers[Math.min(numbers.length - 1, condition.count - 1)]!
          );
      }
    };
    for (const [r, c] of cells) {
      const ok = effect.allOf.every((test) =>
        holds(
          test.condition,
          test.tested.kind === "sameRowInColumn" ? valueAt(r, test.tested.c) : valueAt(r, c),
          r,
        ),
      );
      if (ok) put(r, c, { ...effect.format });
    }
  }
  return out;
}
