// FILE: SheetCustomChart.tsx
// Purpose: A chart drawn by code an agent wrote (kind "custom"), the way Claude's Sheets lets
//          Claude write a chart's widget: the code draws into #chart from window.MOSS_CHART (the
//          chart's cells, size and colours) and is drawn again whenever its cells change.
// Layer: 资料空间 电子表格 (chart)
// Exports: SheetCustomChart.
// Why: The code runs in a frame with scripts only (no same origin) and a content policy that
//      lets it reach nothing — no network, no other frames — so a sheet's numbers cannot leave.

import type { SheetChart } from "@moss/shared/spaceItems/sheetWorkbook";
import { useMemo } from "react";

import { useTheme } from "~/hooks/useTheme";
import type { ChartCell } from "./SheetChartView";
import { customChartDocument } from "./sheetCustomChart.logic";

export function SheetCustomChart(props: {
  readonly chart: SheetChart;
  readonly rows: readonly (readonly ChartCell[])[];
  readonly width: number;
  readonly height: number;
}) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const doc = useMemo(
    () =>
      customChartDocument({
        chart: props.chart,
        rows: props.rows,
        width: props.width,
        height: props.height,
        dark,
      }),
    [props.chart, props.rows, props.width, props.height, dark],
  );
  return (
    <iframe
      title={props.chart.name}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      data-sheet-custom-chart
      // The frame shows the chart; moving and resizing stay with the chart's box.
      className="pointer-events-none block size-full border-0"
    />
  );
}
