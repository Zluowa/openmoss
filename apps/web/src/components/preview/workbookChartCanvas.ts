import type { WorkbookChart } from "~/lib/preview/workbookModel";

const PIE_COLORS = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const label = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);

export function drawWorkbookChart(
  context: CanvasRenderingContext2D,
  chart: WorkbookChart,
  x: number,
  y: number,
  width: number,
  height: number,
  zoom: number,
) {
  if (width <= 0 || height <= 0) return;
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.fillStyle = "white";
  context.fillRect(x, y, width, height);
  context.strokeStyle = "#d9d9d9";
  context.lineWidth = 0.7;
  context.strokeRect(x, y, width, height);
  context.fillStyle = "#404040";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${16 * zoom}px Arial, sans-serif`;
  if (chart.title) context.fillText(chart.title, x + width / 2, y + 22 * zoom, width - 20 * zoom);
  const top = y + (chart.title ? 48 : 20) * zoom;
  const bottom = y + height - (chart.legend ? 62 : 36) * zoom;
  const left = x + 54 * zoom,
    right = x + width - 24 * zoom;
  const plotWidth = Math.max(1, right - left),
    plotHeight = Math.max(1, bottom - top);
  context.font = `${11 * zoom}px Arial, sans-serif`;
  if (chart.kind === "pie" || chart.kind === "doughnut") {
    const values = chart.series[0]?.values ?? [];
    const total = values.reduce<number>((sum, value) => sum + Math.max(0, value ?? 0), 0);
    const radius = Math.min(plotWidth, plotHeight) / 2;
    const cx = (left + right) / 2,
      cy = (top + bottom) / 2;
    let angle = -Math.PI / 2;
    values.forEach((value, index) => {
      const next = angle + (total ? (Math.max(0, value ?? 0) / total) * Math.PI * 2 : 0);
      context.beginPath();
      context.moveTo(cx, cy);
      context.arc(cx, cy, radius, angle, next);
      context.closePath();
      context.fillStyle = PIE_COLORS[index % PIE_COLORS.length]!;
      context.fill();
      context.strokeStyle = "white";
      context.lineWidth = zoom;
      context.stroke();
      if (chart.showValues && value) {
        const middle = (angle + next) / 2;
        context.fillStyle = "white";
        context.fillText(
          label(value),
          cx + Math.cos(middle) * radius * 0.72,
          cy + Math.sin(middle) * radius * 0.72,
        );
      }
      angle = next;
    });
    if (chart.kind === "doughnut") {
      context.beginPath();
      context.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
      context.fillStyle = "white";
      context.fill();
    }
  } else {
    const length = Math.max(1, chart.categories.length);
    const stacked = chart.grouping !== "standard";
    const percent = chart.grouping === "percentStacked";
    const positives = new Array<number>(length).fill(0),
      negatives = new Array<number>(length).fill(0);
    const totals = new Array<number>(length).fill(0);
    for (const series of chart.series)
      series.values.forEach((value, index) => {
        totals[index] = (totals[index] ?? 0) + Math.abs(value ?? 0);
      });
    let minimum = 0,
      maximum = 0;
    for (const series of chart.series)
      series.values.forEach((raw, index) => {
        const value = percent ? (raw ?? 0) / (totals[index] || 1) : (raw ?? 0);
        if (stacked) {
          if (value >= 0) positives[index] = (positives[index] ?? 0) + value;
          else negatives[index] = (negatives[index] ?? 0) + value;
          maximum = Math.max(maximum, positives[index] ?? 0);
          minimum = Math.min(minimum, negatives[index] ?? 0);
        } else {
          maximum = Math.max(maximum, value);
          minimum = Math.min(minimum, value);
        }
      });
    if (minimum === maximum) maximum = minimum + 1;
    if (!percent) {
      const step = 10 ** Math.floor(Math.log10(maximum - minimum)) / 2;
      maximum = Math.ceil(maximum / step) * step;
      minimum = Math.floor(minimum / step) * step;
    }
    const axis = (value: number) =>
      chart.horizontal
        ? left + ((value - minimum) / (maximum - minimum)) * plotWidth
        : bottom - ((value - minimum) / (maximum - minimum)) * plotHeight;
    context.lineWidth = 0.7;
    context.strokeStyle = "#e6e6e6";
    context.fillStyle = "#595959";
    for (let tick = 0; tick <= 5; tick += 1) {
      const value = minimum + (tick / 5) * (maximum - minimum),
        position = axis(value);
      context.beginPath();
      if (chart.horizontal) {
        context.moveTo(position, top);
        context.lineTo(position, bottom);
        context.textAlign = "center";
        context.fillText(
          percent ? `${Math.round(value * 100)}%` : label(value),
          position,
          bottom + 16 * zoom,
        );
      } else {
        context.moveTo(left, position);
        context.lineTo(right, position);
        context.textAlign = "right";
        context.fillText(
          percent ? `${Math.round(value * 100)}%` : label(value),
          left - 8 * zoom,
          position,
        );
      }
      context.stroke();
    }
    const categorySpan = (chart.horizontal ? plotHeight : plotWidth) / length;
    const category = (index: number) =>
      chart.horizontal ? top + categorySpan * (index + 0.5) : left + categorySpan * (index + 0.5);
    const stride = Math.max(
      1,
      Math.ceil(
        length / Math.max(1, Math.floor((chart.horizontal ? plotHeight : plotWidth) / (55 * zoom))),
      ),
    );
    chart.categories.forEach((text, index) => {
      if (index % stride) return;
      context.textAlign = chart.horizontal ? "right" : "center";
      context.fillText(
        text,
        chart.horizontal ? left - 8 * zoom : category(index),
        chart.horizontal ? category(index) : bottom + 16 * zoom,
        chart.horizontal ? 45 * zoom : categorySpan * stride - 4,
      );
    });
    positives.fill(0);
    negatives.fill(0);
    chart.series.forEach((series, seriesIndex) => {
      const points: { x: number; y: number; base: number }[] = [];
      series.values.forEach((raw, index) => {
        if (raw === null) return;
        const value = percent ? raw / (totals[index] || 1) : raw;
        const base = stacked ? (value >= 0 ? (positives[index] ?? 0) : (negatives[index] ?? 0)) : 0;
        const end = value + base;
        if (stacked) {
          if (value >= 0) positives[index] = end;
          else negatives[index] = end;
        }
        const position = category(index);
        if (chart.kind === "bar") {
          const thickness = (categorySpan * 0.7) / (stacked ? 1 : chart.series.length);
          const categoryOffset = -categorySpan * 0.35 + thickness * (stacked ? 0 : seriesIndex);
          context.fillStyle = series.color;
          if (chart.horizontal)
            context.fillRect(
              Math.min(axis(base), axis(end)),
              position + categoryOffset,
              Math.abs(axis(end) - axis(base)),
              thickness,
            );
          else
            context.fillRect(
              position + categoryOffset,
              Math.min(axis(base), axis(end)),
              thickness,
              Math.abs(axis(end) - axis(base)),
            );
          if (chart.showValues) {
            context.fillStyle = "#404040";
            context.textAlign = "center";
            context.fillText(
              label(raw),
              chart.horizontal ? axis(end) + 12 * zoom : position + categoryOffset + thickness / 2,
              chart.horizontal ? position + categoryOffset + thickness / 2 : axis(end) - 8 * zoom,
            );
          }
        } else points.push({ x: position, y: axis(end), base: axis(base) });
      });
      if (chart.kind === "line" || chart.kind === "area") {
        context.beginPath();
        points.forEach((point, index) =>
          index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
        );
        if (chart.kind === "area" && points.length) {
          for (let i = points.length - 1; i >= 0; i -= 1)
            context.lineTo(points[i]!.x, points[i]!.base);
          context.closePath();
          context.fillStyle = series.color;
          context.globalAlpha = 0.65;
          context.fill();
          context.globalAlpha = 1;
        }
        context.strokeStyle = series.color;
        context.lineWidth = 2 * zoom;
        context.stroke();
        if (chart.kind === "line")
          for (const point of points) {
            context.beginPath();
            context.arc(point.x, point.y, 2.5 * zoom, 0, Math.PI * 2);
            context.fillStyle = series.color;
            context.fill();
          }
      }
      if (chart.kind === "scatter") {
        const xs = series.xValues ?? series.values.map((_, i) => i + 1);
        let low = 0,
          high = 1;
        for (const value of xs) {
          if (value !== null) {
            low = Math.min(low, value);
            high = Math.max(high, value);
          }
        }
        series.values.forEach((value, index) => {
          if (value === null || xs[index] === null || xs[index] === undefined) return;
          context.beginPath();
          context.arc(
            left + ((xs[index]! - low) / (high - low)) * plotWidth,
            axis(value),
            3 * zoom,
            0,
            Math.PI * 2,
          );
          context.fillStyle = series.color;
          context.fill();
        });
      }
    });
  }
  if (chart.legend) {
    const entries =
      chart.kind === "pie" || chart.kind === "doughnut"
        ? chart.categories.map((name, index) => ({
            name,
            color: PIE_COLORS[index % PIE_COLORS.length]!,
          }))
        : chart.series;
    context.font = `${11 * zoom}px Arial, sans-serif`;
    let legendX = x + 20 * zoom,
      legendY = y + height - 20 * zoom;
    for (const entry of entries) {
      const itemWidth = context.measureText(entry.name).width + 30 * zoom;
      if (legendX + itemWidth > x + width - 10 * zoom) {
        legendX = x + 20 * zoom;
        legendY += 15 * zoom;
      }
      context.fillStyle = entry.color;
      context.fillRect(legendX, legendY - 4 * zoom, 10 * zoom, 8 * zoom);
      context.fillStyle = "#595959";
      context.textAlign = "left";
      context.fillText(entry.name, legendX + 15 * zoom, legendY);
      legendX += itemWidth;
    }
  }
  context.restore();
}
