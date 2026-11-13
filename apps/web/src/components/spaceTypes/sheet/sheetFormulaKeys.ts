// FILE: sheetFormulaKeys.ts
// Purpose: Keys a spreadsheet person expects while writing a formula and moving around the
//          editor: F4 cycles the reference under the caret through A1 → $A$1 → A$1 → $A1, and F6
//          moves between the formula row, the grid, the tool card and the sheet bar.
// Layer: 资料空间 电子表格 (pure logic + one DOM helper)
// Exports: toggleReferenceAt, nextSheetPart.

const REFERENCE = /\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/gu;
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/u;
const WORD = /[A-Za-z0-9_]/u;

/** The four ways a reference can be anchored, in the order F4 steps through them. */
const STEPS: readonly (readonly [column: boolean, row: boolean])[] = [
  [false, false],
  [true, true],
  [false, true],
  [true, false],
];

function anchorCell(cell: string, [column, row]: readonly [boolean, boolean]) {
  const match = CELL.exec(cell);
  if (!match) return cell;
  return `${column ? "$" : ""}${match[2]}${row ? "$" : ""}${match[4]}`;
}

/**
 * Switches the reference at (or just before) the caret to its next anchoring. Both ends of a
 * range move together, taking the first end's step. Text that is not a formula, or a caret
 * away from any reference, comes back unchanged (null).
 */
export function toggleReferenceAt(
  text: string,
  caret: number,
): { readonly text: string; readonly caret: number } | null {
  if (!text.startsWith("=")) return null;
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret < start || caret > end) continue;
    const before = text[start - 1] ?? "";
    const after = text[end] ?? "";
    // Part of a longer name (LOG10, a function call) or inside a quoted string is not a reference.
    if (WORD.test(before) || WORD.test(after) || after === "(") continue;
    const quotes = (text.slice(0, start).match(/"/gu) ?? []).length;
    if (quotes % 2 === 1) continue;
    const parts = match[0].split(":");
    const first = CELL.exec(parts[0]!);
    if (!first) return null;
    const now = STEPS.findIndex(([column, row]) => column === !!first[1] && row === !!first[3]);
    const next = STEPS[(now + 1) % STEPS.length]!;
    const replaced = parts.map((part) => anchorCell(part, next)).join(":");
    return {
      text: text.slice(0, start) + replaced + text.slice(end),
      caret: start + replaced.length,
    };
  }
  return null;
}

/** The editor's parts in the order F6 visits them. */
const PARTS = [
  "[data-sheet-formula-row] input",
  "[data-sheet-grid]",
  "[data-sheet-tools]",
  "[data-sheet-bar]",
] as const;

const FOCUSABLE =
  'input:not([disabled]),textarea:not([disabled]),button:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

/**
 * Moves focus to the next (or, going back, the previous) part of the editor that is on screen,
 * starting from the part that holds focus now. Returns false when there was nowhere to go.
 */
export function nextSheetPart(root: HTMLElement, back: boolean): boolean {
  const parts = PARTS.map((selector) => root.querySelector<HTMLElement>(selector)).filter(
    (part): part is HTMLElement => part !== null,
  );
  if (!parts.length) return false;
  const active = document.activeElement;
  // The tool card sits inside the grid's box, so the innermost part that holds focus counts.
  const here = parts.findLastIndex((part) => part === active || part.contains(active));
  const n = parts.length;
  // From outside every part, F6 starts at the first part and Shift+F6 at the last.
  const from = here >= 0 ? here : back ? 0 : -1;
  for (let i = 1; i <= n; i++) {
    const part = parts[(((from + (back ? -i : i)) % n) + n) % n]!;
    const target = part.matches(FOCUSABLE) ? part : part.querySelector<HTMLElement>(FOCUSABLE);
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}
