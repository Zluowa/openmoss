import type JSZip from "jszip";

import {
  getWorkbookCell,
  parseRange,
  type WorkbookChart,
  type WorkbookSheet,
} from "./workbookModel";

const CHART_COLORS = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const nodes = (element: Document | Element, name: string): Element[] =>
  Array.from(element.getElementsByTagNameNS("*", name));
const first = (element: Document | Element, name: string) => nodes(element, name)[0];
const number = (element: Document | Element, name: string, fallback = 0) =>
  Number(first(element, name)?.textContent ?? fallback);
const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");

function resolvePart(source: string, target: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return null;
  const parts = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

async function relationships(zip: JSZip, part: string): Promise<Map<string, string>> {
  const slash = part.lastIndexOf("/");
  const entry = zip.file(`${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`);
  if (!entry) return new Map();
  const result = new Map<string, string>();
  for (const relation of nodes(xml(await entry.async("text")), "Relationship")) {
    if (relation.getAttribute("TargetMode") === "External") continue;
    const target = resolvePart(part, relation.getAttribute("Target") ?? "");
    if (target) result.set(relation.getAttribute("Id") ?? "", target);
  }
  return result;
}

function referenceValues(element: Element, sheets: WorkbookSheet[]): string[] {
  const formula = first(element, "f")?.textContent ?? "";
  const bang = formula.lastIndexOf("!");
  if (bang < 0 || formula.includes("[")) return [];
  const name = formula.slice(0, bang).replace(/^'|'$/g, "").replaceAll("''", "'");
  const sheet = sheets.find((item) => item.name === name);
  const range = parseRange(formula.slice(bang + 1));
  if (
    !sheet ||
    !range ||
    (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1) > 100_000
  )
    return [];
  const result: string[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1)
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      const cell = getWorkbookCell(sheet, { row, col });
      result.push(cell?.numeric !== undefined ? String(cell.numeric) : (cell?.text ?? ""));
    }
  return result;
}

function cachedValues(element: Element | undefined, sheets: WorkbookSheet[]): string[] {
  if (!element) return [];
  const points = nodes(element, "pt");
  if (!points.length) return referenceValues(element, sheets);
  const result: string[] = [];
  for (const point of points) {
    const index = Number(point.getAttribute("idx"));
    if (Number.isInteger(index) && index >= 0 && index < 100_000)
      result[index] = first(point, "v")?.textContent ?? "";
  }
  return Array.from(result, (value) => value ?? "");
}

export function parseWorkbookChart(
  document: Document,
  sheets: WorkbookSheet[],
): Omit<WorkbookChart, "from"> | null {
  const plot = first(document, "plotArea");
  if (!plot) return null;
  const supported = [
    "barChart",
    "lineChart",
    "pieChart",
    "doughnutChart",
    "areaChart",
    "scatterChart",
  ] as const;
  const chart = Array.from(plot.children).find((child) =>
    supported.includes(child.localName as (typeof supported)[number]),
  );
  if (!chart) return null;
  // A combo chart needs distinct axes and series styles; don't silently re-label it as one chart.
  if (Array.from(plot.children).filter((child) => child.localName.endsWith("Chart")).length > 1)
    return null;
  const kind = chart.localName.replace("Chart", "") as WorkbookChart["kind"];
  const series = nodes(chart, "ser").map((item, index) => {
    const values = cachedValues(first(item, kind === "scatter" ? "yVal" : "val"), sheets).map(
      (value) => (value !== "" && Number.isFinite(Number(value)) ? Number(value) : null),
    );
    const title = first(item, "tx");
    const name = title
      ? (first(title, "v")?.textContent ??
        referenceValues(title, sheets)[0] ??
        `Series ${index + 1}`)
      : `Series ${index + 1}`;
    const fill = first(item, "spPr");
    const hex = fill ? first(fill, "srgbClr")?.getAttribute("val") : null;
    return {
      name,
      values,
      color:
        hex && /^[a-f\d]{6}$/i.test(hex) ? `#${hex}` : CHART_COLORS[index % CHART_COLORS.length]!,
      xValues:
        kind === "scatter"
          ? cachedValues(first(item, "xVal"), sheets).map((value) =>
              value !== "" && Number.isFinite(Number(value)) ? Number(value) : null,
            )
          : undefined,
    };
  });
  const firstSeries = nodes(chart, "ser")[0];
  const categories = cachedValues(firstSeries ? first(firstSeries, "cat") : undefined, sheets);
  let length = 0;
  for (const item of series) length = Math.max(length, item.values.length);
  for (let index = categories.length; index < length; index += 1)
    categories[index] = String(index + 1);
  const title = first(document, "title");
  const grouping = first(chart, "grouping")?.getAttribute("val");
  return {
    kind,
    title: title
      ? nodes(title, "t")
          .map((node) => node.textContent ?? "")
          .join("")
      : "",
    series,
    categories,
    grouping: grouping === "stacked" || grouping === "percentStacked" ? grouping : "standard",
    horizontal: first(chart, "barDir")?.getAttribute("val") === "bar",
    legend: Boolean(first(document, "legend")),
    showValues: first(chart, "showVal")?.getAttribute("val") === "1",
  };
}

export async function readWorkbookCharts(
  zip: JSZip,
  sheets: WorkbookSheet[],
  warnings: string[],
): Promise<void> {
  const workbookPart = "xl/workbook.xml";
  const workbook = xml(await zip.file(workbookPart)!.async("text"));
  const sheetRels = await relationships(zip, workbookPart);
  for (const sheetNode of nodes(workbook, "sheet")) {
    const sheet = sheets.find((item) => item.name === sheetNode.getAttribute("name"));
    const sheetPart = sheetRels.get(sheetNode.getAttribute("r:id") ?? "");
    if (!sheet || !sheetPart || !zip.file(sheetPart)) continue;
    const sheetXml = xml(await zip.file(sheetPart)!.async("text"));
    const drawingRels = await relationships(zip, sheetPart);
    for (const drawingNode of nodes(sheetXml, "drawing")) {
      const drawingPart = drawingRels.get(drawingNode.getAttribute("r:id") ?? "");
      if (!drawingPart || !zip.file(drawingPart)) continue;
      const drawing = xml(await zip.file(drawingPart)!.async("text"));
      const chartRels = await relationships(zip, drawingPart);
      for (const anchor of Array.from(drawing.documentElement.children)) {
        const chartNode = first(anchor, "chart");
        if (!chartNode) continue;
        const chartPart = chartRels.get(chartNode.getAttribute("r:id") ?? "");
        if (!chartPart || !zip.file(chartPart)) continue;
        const chart = parseWorkbookChart(xml(await zip.file(chartPart)!.async("text")), sheets);
        if (!chart) {
          warnings.push(
            `A chart in “${sheet.name}” uses a chart type or combination that cannot be rendered in this preview.`,
          );
          continue;
        }
        const point = (element: Element) => {
          const row = number(element, "row"),
            col = number(element, "col");
          return {
            row: row + number(element, "rowOff") / 9525 / (sheet.rowHeights.get(row) ?? 24),
            col: col + number(element, "colOff") / 9525 / (sheet.columnWidths.get(col) ?? 96),
          };
        };
        const from = first(anchor, "from");
        const to = first(anchor, "to");
        const ext = Array.from(anchor.children).find((node) => node.localName === "ext");
        sheet.charts.push({
          ...chart,
          from: from ? point(from) : { row: 0, col: 0 },
          to: to ? point(to) : undefined,
          width: ext ? Number(ext.getAttribute("cx")) / 9525 : undefined,
          height: ext ? Number(ext.getAttribute("cy")) / 9525 : undefined,
        });
      }
    }
  }
}
