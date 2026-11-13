// FILE: sheetPalette.ts
// Purpose: The literal colours of the 电子表格 editor: what its canvas paints (paper cells, frame
//          headers, ink-10 % lines, the accent, the table header band) and the chart hues used
//          where a surface sets no chart tokens.
// Layer: Web theme (colour definitions live here; components name them)
// Exports: SHEET_CANVAS_COLORS, SHEET_CHART_FALLBACKS, SHEET_INK, SHEET_WHITE, ENGINE_DEFAULT_INK.
// Why: A canvas cannot read CSS tokens, so the light sheet's colours are written once, from the
//      Moss paper theme (paper #fcfcfb, card #fdfdfc, ink #141413, accent #2a78d6); the dark
//      sheet is the same canvas turned by a CSS filter.

export const SHEET_INK = "#141413";
export const SHEET_WHITE = "#FFFFFF";
/** The engine's own default text colour, which means "no colour set". */
export const ENGINE_DEFAULT_INK = "#000000";

export const SHEET_CANVAS_COLORS = {
  paper: "#FDFDFC",
  frame: "#F4F4F2",
  line: "#E6E6E3",
  lineStrong: "#D4D4D1",
  ink: SHEET_INK,
  inkSecondary: "#71716E",
  accent: "#2A78D6",
  selectedHeader: "#E3ECF8",
  tableHeader: "#F1F1EF",
  checkboxEdge: "#A6A6A2",
  white: SHEET_WHITE,
  flash: "rgba(42, 120, 214, 0.14)",
  /** The corner mark of a cell that shows an error (Moss red 600). */
  error: "#C2352A",
} as const;

/** Moss's 600 shades, behind the chart palette tokens. */
export const SHEET_CHART_FALLBACKS = [
  "#2A6AC9",
  "#1E7B75",
  "#C25F12",
  "#6B47B8",
  "#B23A7C",
  "#2A8540",
] as const;

/** The ink a custom chart's code draws with, light and dark (it cannot read CSS tokens). */
export const SHEET_CUSTOM_CHART_INK = {
  light: { ink: "#141413", muted: "#71716E", grid: "#E6E6E3" },
  dark: { ink: "#ECECEA", muted: "#A3A39F", grid: "#3A3A37" },
} as const;
