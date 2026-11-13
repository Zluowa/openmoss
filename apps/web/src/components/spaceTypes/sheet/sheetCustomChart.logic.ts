// FILE: sheetCustomChart.logic.ts
// Purpose: The page a custom chart's code runs in: a content policy that reaches nothing, the
//          chart's cells and colours as window.MOSS_CHART, and the code guarded against errors.
// Layer: 资料空间 电子表格 (chart)
// Exports: customChartDocument.

import type { SheetChart } from "@moss/shared/spaceItems/sheetWorkbook";

import { SHEET_CHART_FALLBACKS, SHEET_CUSTOM_CHART_INK } from "~/theme/sheetPalette";
import type { ChartCell } from "./SheetChartView";

const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** JSON that can sit inside a <script> element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</gu, "\\u003c");

export function customChartDocument(input: {
  readonly chart: SheetChart;
  readonly rows: readonly (readonly ChartCell[])[];
  readonly width: number;
  readonly height: number;
  readonly dark: boolean;
}): string {
  const ink = SHEET_CUSTOM_CHART_INK[input.dark ? "dark" : "light"];
  const data = {
    name: input.chart.name,
    caption: input.chart.caption,
    width: input.width,
    height: input.height,
    rows: input.rows.map((row) => row.map((cell) => ({ value: cell.value, text: cell.text }))),
    colors: [...SHEET_CHART_FALLBACKS],
    ink: ink.ink,
    muted: ink.muted,
    grid: ink.grid,
    dark: input.dark,
  };
  const code = (input.chart.code ?? "").replace(/<\/script/giu, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;color:${ink.ink};font:12px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}#chart{width:100%;height:100%}</style>
</head><body><div id="chart"></div>
<script>window.MOSS_CHART=${scriptJson(data)};</script>
<script>try{${code}
}catch(error){document.getElementById("chart").textContent="这个图表的代码出错了："+(error&&error.message)}</script>
</body></html>`;
}
