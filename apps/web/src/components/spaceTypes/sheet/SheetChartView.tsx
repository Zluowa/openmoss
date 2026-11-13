// FILE: SheetChartView.tsx
// Purpose: Draws one 电子表格 chart (bar, stacked bar, line, pie, or an agent's custom code) from its cells, and lets a
//          person select, move, resize and delete it over the grid.
// Layer: 资料空间 电子表格 (types stream)
// Exports: SheetChartView, chartSeries.
// Why: A chart is redrawn from cells whenever they change, so it never goes stale. The look
//      follows the house rules for charts: title, two type sizes, 16 px margins, the legend
//      under the plot, round-ended bars, theme colours that read light and dark.

import type { SheetChart, SheetScalar } from "@moss/shared/spaceItems/sheetWorkbook";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import { SHEET_CHART_FALLBACKS } from "~/theme/sheetPalette";
import { SheetCustomChart } from "./SheetCustomChart";

export interface ChartCell {
  readonly value: SheetScalar;
  readonly text: string;
}

// The chart palette tokens, with Moss's 600 shades where a surface sets none.
const HUES = SHEET_CHART_FALLBACKS.map((fallback, i) => `var(--iui-chart-${i + 1}, ${fallback})`);

/** Series of a grid: the first row names them, the first column labels the points. */
export function chartSeries(rows: readonly (readonly ChartCell[])[]) {
  const [head = [], ...below] = rows;
  const body = below.filter((row) => (row[0]?.text ?? "") !== "");
  const series = head
    .map((cell, i) => ({ name: cell.text || `系列 ${i}`, i }))
    .filter((s) => s.i > 0 && body.some((row) => typeof row[s.i]?.value === "number"));
  return { body, series };
}

function niceTicks(least: number, most: number) {
  const span = most - least || 1;
  const p = 10 ** Math.floor(Math.log10(span / 4));
  const step = p * ([1, 2, 2.5, 5, 10].find((m) => m * p * 4 >= span) ?? 10);
  const first = Math.floor(least / step);
  const count = Math.ceil(most / step) - first + 1;
  return Array.from({ length: Math.max(2, count) }, (_, n) => (n + first) * step);
}
const short = (n: number, span: number) =>
  new Intl.NumberFormat("zh-CN", {
    notation: span < 10_000 ? "standard" : "compact",
    maximumSignificantDigits: 3,
  }).format(n);

function ChartDrawing(props: {
  chart: SheetChart;
  rows: readonly (readonly ChartCell[])[];
  width: number;
  height: number;
}) {
  const { chart, width: W, height: H } = props;
  const [off, setOff] = useState<number[]>([]);
  /** The category under the pointer, for the tooltip. */
  const [hover, setHover] = useState<number | null>(null);
  const { body, series: all } = useMemo(() => chartSeries(props.rows), [props.rows]);
  const series = all.filter((s) => all.length === 1 || !off.includes(s.i));
  const gray = "var(--color-text-secondary, currentColor)";
  const ink = "var(--color-text-foreground, currentColor)";
  const title = chart.name;
  const legend = chart.kind !== "pie" && all.length > 1;
  const num = (row: readonly ChartCell[], i: number) =>
    typeof row[i]?.value === "number" ? (row[i]!.value as number) : 0;
  if (body.length === 0 || all.length === 0)
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-ui-sm text-muted-foreground">
        这些单元格里没有能画成图表的数字。
      </div>
    );
  const legendRow = legend ? (
    <g>
      {all.map((s, k) => {
        const x = 16 + all.slice(0, k).reduce((sum, t) => sum + 34 + 7 * t.name.length, 0);
        return (
          <g
            key={s.i}
            opacity={off.includes(s.i) ? 0.4 : 1}
            onClick={() =>
              setOff((o) => (o.includes(s.i) ? o.filter((i) => i !== s.i) : [...o, s.i]))
            }
            className="cursor-pointer"
          >
            <rect
              x={x - 4}
              y={H - 35}
              width={30 + 7 * s.name.length}
              height={24}
              fill="transparent"
            />
            <rect
              x={x}
              y={H - 28}
              width={10}
              height={10}
              rx={2}
              fill={HUES[all.indexOf(s) % HUES.length]}
            />
            <text x={x + 16} y={H - 19} fill={gray} fontSize={12}>
              {s.name}
            </text>
          </g>
        );
      })}
    </g>
  ) : null;
  const header = (
    <text x={16} y={27} fontSize={14} fontWeight={500} fill={ink}>
      {title}
    </text>
  );
  if (chart.kind === "pie") {
    const s = all[0]!;
    const values = body.map((row) => Math.max(0, num(row, s.i)));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2;
    const cy = 44 + (H - 60) / 2;
    const radius = Math.max(10, Math.min(W - 160, H - 76) / 2);
    let angle = -Math.PI / 2;
    return (
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={title}
        fontSize={12}
      >
        {header}
        {values.map((v, j) => {
          const a0 = angle;
          const a1 = angle + (v / total) * Math.PI * 2;
          angle = a1;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const mid = (a0 + a1) / 2;
          const path =
            v >= total
              ? `M${cx} ${cy - radius}A${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius}Z`
              : `M${cx} ${cy}L${cx + radius * Math.cos(a0)} ${cy + radius * Math.sin(a0)}A${radius} ${radius} 0 ${large} 1 ${cx + radius * Math.cos(a1)} ${cy + radius * Math.sin(a1)}Z`;
          const lx = cx + (radius + 10) * Math.cos(mid);
          const ly = cy + (radius + 10) * Math.sin(mid);
          return (
            <g key={j}>
              <path
                d={path}
                fill={HUES[j % HUES.length]}
                stroke="var(--color-background)"
                strokeWidth={1}
              />
              {v / total >= 0.04 ? (
                <text
                  x={lx}
                  y={ly + 4}
                  textAnchor={Math.cos(mid) >= 0 ? "start" : "end"}
                  fill={gray}
                >
                  {`${body[j]![0]!.text} ${Math.round((v / total) * 100)}%`}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    );
  }
  const stacked = chart.kind === "stackedBar";
  const totals = body.map((row) => series.reduce((sum, s) => sum + num(row, s.i), 0));
  const values = stacked ? totals : body.flatMap((row) => series.map((s) => num(row, s.i)));
  const most = Math.max(0, ...values);
  const least = Math.min(
    0,
    ...(stacked ? body.flatMap((row) => series.map((s) => num(row, s.i))) : values),
  );
  const ticks = niceTicks(least, most);
  const span = ticks.at(-1)! - ticks[0]!;
  const tickLabel = (t: number) => short(t, span);
  const left = 24 + Math.max(...ticks.map((t) => tickLabel(t).length)) * 7;
  const y0 = 52;
  const h = H - (legend ? 116 : 86);
  const w = W - 16 - left;
  const y = (v: number) => y0 + h - (h * (v - ticks[0]!)) / (span || 1);
  const band = w / Math.max(1, body.length);
  const n = stacked ? 1 : Math.max(1, series.length);
  const gap = Math.min(2, band / 8 / n);
  const bar = Math.max(2, Math.min(20, (band * 0.75) / n - gap));
  const labelWidth = 7 * Math.max(...body.map((row) => row[0]!.text.length));
  const every = Math.ceil((labelWidth + 8) / band);
  const barPath = (x: number, from: number, to: number, roundTop: boolean) => {
    const top = Math.min(y(from), y(to));
    const bottom = Math.max(y(from), y(to));
    const t = bottom - top;
    const q = Math.min(4, bar / 4, t);
    if (!roundTop || q <= 0) return `M${x} ${bottom}V${top}H${x + bar}V${bottom}Z`;
    return `M${x} ${bottom}V${top + q}A${q} ${q} 0 0 1 ${x + q} ${top}H${x + bar - q}A${q} ${q} 0 0 1 ${x + bar} ${top + q}V${bottom}Z`;
  };
  return (
    <div className="relative h-full w-full">
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={title}
        fontSize={12}
      >
        {header}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={W - 16}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--color-border-strong)" : "var(--color-border)"}
            />
            <text x={left - 8} y={y(t) + 4} textAnchor="end" fill={gray}>
              {tickLabel(t)}
            </text>
          </g>
        ))}
        {chart.kind === "line"
          ? series.map((s) => {
              const hue = HUES[all.indexOf(s) % HUES.length];
              const points = body.map(
                (row, j) => `${left + j * band + band / 2},${y(num(row, s.i))}`,
              );
              const last = body.length - 1;
              return (
                <g key={s.i}>
                  <polyline
                    points={points.join(" ")}
                    fill="none"
                    stroke={hue}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                  <circle
                    cx={left + last * band + band / 2}
                    cy={y(num(body[last]!, s.i))}
                    r={4}
                    fill={hue}
                  />
                </g>
              );
            })
          : body.map((row, j) => {
              let base = 0;
              return (
                <g key={j}>
                  {series.map((s, k) => {
                    const v = num(row, s.i);
                    const hue = HUES[all.indexOf(s) % HUES.length];
                    if (stacked) {
                      const x = left + j * band + (band - bar) / 2;
                      const from = base;
                      base += v;
                      return (
                        <path
                          key={s.i}
                          d={barPath(x, from, base, k === series.length - 1)}
                          fill={hue}
                        >
                          <title>{`${row[0]!.text}，${s.name}：${row[s.i]?.text ?? ""}`}</title>
                        </path>
                      );
                    }
                    const x =
                      left + j * band + (band - n * bar - (n - 1) * gap) / 2 + k * (bar + gap);
                    return (
                      <path key={s.i} d={barPath(x, 0, v, true)} fill={hue}>
                        <title>{`${row[0]!.text}，${s.name}：${row[s.i]?.text ?? ""}`}</title>
                      </path>
                    );
                  })}
                </g>
              );
            })}
        {body.map((row, j) =>
          j % every === 0 && j * band + labelWidth <= w + band ? (
            <text
              key={j}
              x={left + j * band + (every > 1 ? 0 : band / 2)}
              y={y0 + h + 16}
              textAnchor={every > 1 ? "start" : "middle"}
              fill={gray}
            >
              {row[0]!.text}
            </text>
          ) : null,
        )}
        {hover !== null ? (
          <line
            x1={left + hover * band + band / 2}
            x2={left + hover * band + band / 2}
            y1={y0}
            y2={y0 + h}
            stroke="var(--color-border-strong)"
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        ) : null}
        {body.map((_, j) => (
          <rect
            key={`hit-${j}`}
            x={left + j * band}
            y={y0}
            width={band}
            height={h}
            fill="transparent"
            data-chart-hit={j}
            onPointerEnter={() => setHover(j)}
            onPointerLeave={() => setHover((now) => (now === j ? null : now))}
          />
        ))}
        {legendRow}
      </svg>
      {hover !== null && body[hover] ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 flex min-w-28 flex-col gap-0.5 rounded-control border border-border bg-popover px-2 py-1.5 text-ui-sm shadow-md"
          style={{
            left: `${((left + hover * band + band / 2) / W) * 100}%`,
            top: `${(y0 / H) * 100}%`,
            transform:
              hover >= body.length / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <span className="font-medium">{body[hover]![0]!.text}</span>
          {series.map((s) => (
            <span key={s.i} className="flex items-center gap-1.5 tabular-nums">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: HUES[all.indexOf(s) % HUES.length] }}
              />
              <span className="text-muted-foreground">{s.name}</span>
              <span className="ml-auto pl-3">{body[hover]![s.i]?.text ?? ""}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SheetChartView(props: {
  chart: SheetChart;
  rows: readonly (readonly ChartCell[])[];
  left: number;
  top: number;
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  /** Called once a drag ends, with the chart's new place and size in pixels from where it started. */
  onMove: (dx: number, dy: number, dw: number, dh: number) => void;
}) {
  const drag = useRef<{ x: number; y: number; mode: "move" | "resize" } | null>(null);
  const [delta, setDelta] = useState({ dx: 0, dy: 0, dw: 0, dh: 0 });
  const begin = (mode: "move" | "resize") => (event: ReactPointerEvent) => {
    event.stopPropagation();
    props.onSelect();
    if (props.readOnly || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, mode };
  };
  const moveTo = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    setDelta(d.mode === "move" ? { dx, dy, dw: 0, dh: 0 } : { dx: 0, dy: 0, dw: dx, dh: dy });
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    const final = delta;
    setDelta({ dx: 0, dy: 0, dw: 0, dh: 0 });
    if (final.dx || final.dy || final.dw || final.dh)
      props.onMove(final.dx, final.dy, final.dw, final.dh);
  };
  const width = Math.max(120, props.chart.width + delta.dw);
  const height = Math.max(80, props.chart.height + delta.dh);
  return (
    <div
      role="figure"
      aria-label={props.chart.name}
      data-sheet-chart={props.chart.id}
      className={cn(
        "pointer-events-auto absolute select-none overflow-hidden rounded-inline border bg-background",
        props.selected ? "border-primary ring-1 ring-primary" : "border-border",
        props.readOnly ? "" : "cursor-move",
      )}
      style={{ left: props.left + delta.dx, top: props.top + delta.dy, width, height }}
      onPointerDown={begin("move")}
      onPointerMove={moveTo}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {props.chart.kind === "custom" ? (
        <SheetCustomChart chart={props.chart} rows={props.rows} width={width} height={height} />
      ) : (
        <ChartDrawing chart={props.chart} rows={props.rows} width={width} height={height} />
      )}
      {props.selected && !props.readOnly ? (
        <span
          aria-hidden
          className="absolute right-0 bottom-0 size-3 cursor-nwse-resize rounded-tl-inline border-t border-l border-primary bg-background"
          onPointerDown={begin("resize")}
          onPointerMove={moveTo}
          onPointerUp={end}
        />
      ) : null}
    </div>
  );
}
