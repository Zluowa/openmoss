// FILE: SlideView.tsx
// Purpose: Paints one deck-v2 slide (1920×1080) scaled to a given width: text with paragraphs,
//          lists and shrink-to-fit, pictures with crop, shapes, lines, tables and charts.
// Layer: 资料空间 幻灯片 (read-only renderer)
// Why: Thumbnails, 从模板开始 previews, present mode, the guest view and PDF/PNG export all
//      paint through this one component, so they agree with each other. The Moss Canvas deck
//      editor follows the same text metrics (slides/DECK-SCHEMA.md §4).

import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  embedDocument,
  MOSS_FONT_FALLBACK,
  resolveColor,
  slideIconUrl,
  resolveTextStyle,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type ChartElement,
  type DeckTheme,
  type Fill,
  type LineElement,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type SlideShape,
  type Stroke,
  type TableElement,
  type TextBody,
} from "@moss/shared/spaceItems/slidesDeck";

const fontStack = (font: string) => `"${font.replaceAll('"', "")}", ${MOSS_FONT_FALLBACK}`;
const alphaHex = (opacity: number) =>
  Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");

export function fillCss(fill: Fill | undefined, theme: DeckTheme): string | undefined {
  if (!fill) return undefined;
  switch (fill.type) {
    case "solid": {
      const color = resolveColor(fill.color, theme);
      return fill.opacity === undefined || fill.opacity >= 1
        ? color
        : `${color}${alphaHex(fill.opacity)}`;
    }
    case "gradient":
      return `linear-gradient(${fill.angle}deg, ${resolveColor(fill.from, theme)}, ${resolveColor(fill.to, theme)})`;
    case "image":
      return `center / ${fill.fit} no-repeat url("${fill.src.replaceAll('"', "%22")}")`;
    case "none":
      return "transparent";
  }
}

const borderCss = (border: Stroke | undefined, theme: DeckTheme) =>
  border && border.width > 0
    ? `${border.width}px ${border.dash === "solid" ? "solid" : border.dash === "dash" ? "dashed" : "dotted"} ${resolveColor(border.color, theme)}`
    : undefined;

function boxStyle(element: SlideElement, theme: DeckTheme): CSSProperties {
  return {
    position: "absolute",
    left: element.x,
    top: element.y,
    width: element.w,
    height: element.h,
    ...(element.rotation ? { transform: `rotate(${element.rotation}deg)` } : {}),
    ...(element.opacity !== undefined ? { opacity: element.opacity } : {}),
    ...(element.shadow
      ? {
          filter: `drop-shadow(${element.shadow.x}px ${element.shadow.y}px ${element.shadow.blur / 2}px ${resolveColor(element.shadow.color, theme)}${alphaHex(element.shadow.opacity)})`,
        }
      : {}),
  };
}

const VALIGN = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

/** Text body: paragraphs of runs; lists; vertical alignment; shrink-to-fit by measurement. */
function TextBodyView(props: {
  body: TextBody;
  theme: DeckTheme;
  height: number;
  padding?: number | undefined;
}) {
  const { body, theme } = props;
  const style = resolveTextStyle(body, theme);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const signature = JSON.stringify(body);
  useLayoutEffect(() => {
    const element = inner.current;
    if (body.autofit !== "shrink" || !element) {
      setScale(1);
      return;
    }
    // Shrink in 5 % steps until the text fits its box (never below 40 %).
    let next = 1;
    const room = props.height - (props.padding ?? 0) * 2;
    element.style.fontSize = `${style.size}px`;
    while (next > 0.4 && element.scrollHeight > room + 1) {
      next = Math.round((next - 0.05) * 100) / 100;
      element.style.fontSize = `${style.size * next}px`;
    }
    setScale(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, props.height, style.size]);
  let number = 0;
  return (
    <div
      style={{
        position: "absolute",
        inset: props.padding ?? 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: VALIGN[body.vAlign],
        overflow: body.autofit === "grow" ? "visible" : "hidden",
      }}
    >
      <div
        ref={inner}
        style={{
          fontFamily: fontStack(style.font),
          fontSize: style.size * scale,
          fontWeight: style.weight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing ? `${style.letterSpacing / 100}em` : undefined,
          color: style.color,
          textAlign: body.align,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {body.paragraphs.map((paragraph, index) => {
          number = paragraph.list === "number" ? number + 1 : 0;
          const level = paragraph.level ?? 0;
          const marker =
            paragraph.list === "bullet" ? "•" : paragraph.list === "number" ? `${number}.` : null;
          return (
            <div
              key={index}
              style={{
                textAlign: paragraph.align ?? body.align,
                minHeight: `${style.lineHeight}em`,
                ...(marker || level
                  ? { paddingLeft: `${1.2 * (level + (marker ? 1 : 0))}em`, position: "relative" }
                  : {}),
              }}
            >
              {marker ? (
                <span style={{ position: "absolute", left: `${1.2 * level}em`, width: "1.2em" }}>
                  {marker}
                </span>
              ) : null}
              {paragraph.runs.map((run, r) => (
                <span
                  key={r}
                  style={{
                    fontWeight: run.bold ? 700 : undefined,
                    fontStyle: run.italic ? "italic" : undefined,
                    textDecoration:
                      [run.underline ? "underline" : "", run.strike ? "line-through" : ""]
                        .filter(Boolean)
                        .join(" ") || undefined,
                    color: run.color ? resolveColor(run.color, theme) : undefined,
                    fontSize: run.size ? run.size * scale : undefined,
                    fontFamily: run.font ? fontStack(run.font) : undefined,
                  }}
                >
                  {run.text}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function shapePath(shape: SlideShape, w: number, h: number, radius = 0): string {
  const r = Math.min(radius || Math.min(w, h) * 0.12, w / 2, h / 2);
  switch (shape) {
    case "rect":
      return `M0 0H${w}V${h}H0Z`;
    case "roundRect":
      return `M${r} 0H${w - r}Q${w} 0 ${w} ${r}V${h - r}Q${w} ${h} ${w - r} ${h}H${r}Q0 ${h} 0 ${h - r}V${r}Q0 0 ${r} 0Z`;
    case "ellipse":
      return `M0 ${h / 2}A${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2}A${w / 2} ${h / 2} 0 1 0 0 ${h / 2}Z`;
    case "diamond":
      return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
    case "triangle":
      return `M${w / 2} 0L${w} ${h}H0Z`;
    case "arrowRight": {
      const head = Math.min(w * 0.4, h);
      return `M0 ${h * 0.3}H${w - head}V0L${w} ${h / 2}L${w - head} ${h}V${h * 0.7}H0Z`;
    }
    case "arrowLeft": {
      const head = Math.min(w * 0.4, h);
      return `M${w} ${h * 0.3}H${head}V0L0 ${h / 2}L${head} ${h}V${h * 0.7}H${w}Z`;
    }
    case "arrowUp": {
      const head = Math.min(h * 0.4, w);
      return `M${w * 0.3} ${h}V${head}H0L${w / 2} 0L${w} ${head}H${w * 0.7}V${h}Z`;
    }
    case "arrowDown": {
      const head = Math.min(h * 0.4, w);
      return `M${w * 0.3} 0V${h - head}H0L${w / 2} ${h}L${w} ${h - head}H${w * 0.7}V0Z`;
    }
  }
}

const dashArray = (dash: Stroke["dash"], width: number) =>
  dash === "dash"
    ? `${width * 4} ${width * 3}`
    : dash === "dot"
      ? `${width} ${width * 2}`
      : undefined;

function ShapeView({ element, theme }: { element: ShapeElement; theme: DeckTheme }) {
  const fill = element.fill;
  const id = `fill-${element.id}`;
  const paint =
    fill?.type === "solid"
      ? resolveColor(fill.color, theme)
      : fill?.type === "gradient" || fill?.type === "image"
        ? `url(#${id})`
        : "none";
  const border = element.border;
  return (
    <>
      <svg
        width={element.w}
        height={element.h}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {fill?.type === "gradient" ? (
          <defs>
            <linearGradient id={id} gradientTransform={`rotate(${fill.angle - 90} .5 .5)`}>
              <stop offset="0" stopColor={resolveColor(fill.from, theme)} />
              <stop offset="1" stopColor={resolveColor(fill.to, theme)} />
            </linearGradient>
          </defs>
        ) : fill?.type === "image" ? (
          <defs>
            <pattern id={id} width="1" height="1" patternContentUnits="objectBoundingBox">
              <image
                href={fill.src}
                width="1"
                height="1"
                preserveAspectRatio={fill.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"}
              />
            </pattern>
          </defs>
        ) : null}
        <path
          d={shapePath(element.shape, element.w, element.h, element.radius)}
          fill={paint}
          fillOpacity={fill?.type === "solid" ? (fill.opacity ?? 1) : 1}
          stroke={border && border.width > 0 ? resolveColor(border.color, theme) : "none"}
          strokeWidth={border?.width ?? 0}
          strokeDasharray={border ? dashArray(border.dash, border.width) : undefined}
        />
      </svg>
      {element.body ? (
        <TextBodyView
          body={element.body}
          theme={theme}
          height={element.h}
          padding={element.padding ?? 24}
        />
      ) : null}
    </>
  );
}

function LineView({ element, theme }: { element: LineElement; theme: DeckTheme }) {
  const [a, b] = element.points;
  const color = resolveColor(element.stroke.color, theme);
  const width = element.stroke.width;
  const marker = (end: "start" | "end") => {
    const kind = end === "start" ? element.startArrow : element.endArrow;
    if (!kind || kind === "none") return null;
    const [far, to] = end === "end" ? [a, b] : [b, a];
    // An elbow ends with a horizontal segment from the middle column.
    const from = element.route === "elbow" ? { x: (a.x + b.x) / 2, y: to.y } : far;
    const size = Math.max(10, width * 4);
    if (kind === "dot") return <circle cx={to.x} cy={to.y} r={size / 2.5} fill={color} />;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const left = {
      x: to.x - size * Math.cos(angle - 0.45),
      y: to.y - size * Math.sin(angle - 0.45),
    };
    const right = {
      x: to.x - size * Math.cos(angle + 0.45),
      y: to.y - size * Math.sin(angle + 0.45),
    };
    return <path d={`M${to.x} ${to.y}L${left.x} ${left.y}L${right.x} ${right.y}Z`} fill={color} />;
  };
  return (
    <svg
      width={SLIDE_WIDTH}
      height={SLIDE_HEIGHT}
      data-element-id={element.id}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        overflow: "visible",
        pointerEvents: "none",
        opacity: element.opacity,
      }}
    >
      <path
        d={
          element.route === "elbow"
            ? `M${a.x} ${a.y}H${(a.x + b.x) / 2}V${b.y}H${b.x}`
            : `M${a.x} ${a.y}L${b.x} ${b.y}`
        }
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dashArray(element.stroke.dash, width)}
        strokeOpacity={element.stroke.opacity ?? 1}
      />
      {marker("start")}
      {marker("end")}
    </svg>
  );
}

function TableView({ element, theme }: { element: TableElement; theme: DeckTheme }) {
  const border = borderCss(element.style.border, theme) ?? "none";
  return (
    <table
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        borderCollapse: "collapse",
        tableLayout: "fixed",
      }}
    >
      <colgroup>
        {element.columns.map((width, i) => (
          <col key={i} style={{ width }} />
        ))}
      </colgroup>
      <tbody>
        {element.rows.map((row, r) => {
          const header = element.header && r === 0;
          const band =
            element.banded && !header && r % 2 === 0 ? element.style.bandFill : undefined;
          return (
            <tr key={r} style={{ height: row.height }}>
              {row.cells.map((cell, c) => (
                <td
                  key={c}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  style={{
                    position: "relative",
                    border,
                    padding: 0,
                    background: cell.fill
                      ? resolveColor(cell.fill, theme)
                      : header
                        ? resolveColor(element.style.headerFill, theme)
                        : band
                          ? resolveColor(band, theme)
                          : undefined,
                  }}
                >
                  <TextBodyView
                    body={{
                      ...cell.body,
                      size: cell.body.size ?? element.style.fontSize,
                      ...(header
                        ? {
                            color: cell.body.color ?? element.style.headerText,
                            weight: cell.body.weight ?? 600,
                          }
                        : {}),
                    }}
                    theme={theme}
                    height={row.height}
                    padding={12}
                  />
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ChartView({ element, theme }: { element: ChartElement; theme: DeckTheme }) {
  const palette = [
    theme.colors.accent,
    theme.colors.accent2 ?? theme.colors.muted,
    theme.colors.text,
    theme.colors.muted,
  ];
  const seriesColor = (i: number) =>
    resolveColor(element.series[i]?.color ?? palette[i % palette.length]!, theme);
  const sliceColor = (i: number) => resolveColor(palette[i % palette.length]!, theme);
  const { w, h } = element;
  const font = {
    fontFamily: fontStack(theme.fonts.body),
    fontSize: 18,
    fill: resolveColor(theme.colors.muted, theme),
  };
  const legendH = element.legend ? 40 : 0;
  if (element.kind === "pie" || element.kind === "donut") {
    const values = element.series[0]?.values ?? [];
    const total = values.reduce((sum, v) => sum + Math.max(0, v), 0) || 1;
    const r = Math.max(4, Math.min(w, h - legendH) / 2 - 8);
    const cx = w / 2;
    const cy = (h - legendH) / 2;
    let angle = -Math.PI / 2;
    const point = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    return (
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
        {values.map((value, i) => {
          const sweep = (Math.max(0, value) / total) * Math.PI * 2;
          const start = angle;
          angle += sweep;
          return sweep >= Math.PI * 2 - 1e-6 ? (
            <circle key={i} cx={cx} cy={cy} r={r} fill={sliceColor(i)} />
          ) : (
            <path
              key={i}
              d={`M${cx} ${cy}L${point(start)}A${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle)}Z`}
              fill={sliceColor(i)}
            />
          );
        })}
        {element.kind === "donut" ? (
          <circle
            cx={cx}
            cy={cy}
            r={r * 0.55}
            fill={resolveColor(theme.colors.background, theme)}
          />
        ) : null}
        {element.legend
          ? element.labels.map((label, i) => (
              <g
                key={i}
                transform={`translate(${(w / Math.max(1, element.labels.length)) * i + 8}, ${h - 14})`}
              >
                <rect width={14} height={14} y={-12} rx={3} fill={sliceColor(i)} />
                <text x={20} {...font}>
                  {label}
                </text>
              </g>
            ))
          : null}
      </svg>
    );
  }
  const all = element.series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const left = 64;
  const plotW = Math.max(1, w - left - 8);
  const plotH = Math.max(1, h - 44 - legendH);
  const y = (v: number) => 8 + plotH - ((v - min) / span) * plotH;
  const x = (v: number) => left + ((v - min) / span) * plotW;
  const n = Math.max(1, element.labels.length);
  const horizontal = element.kind === "bar";
  const group = (horizontal ? plotH : plotW) / n;
  const bar = (group * 0.7) / Math.max(1, element.series.length);
  const ticks = [min, min + span / 2, max];
  const tickLabel = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
      {ticks.map((tick, i) =>
        horizontal ? (
          <line
            key={i}
            x1={x(tick)}
            x2={x(tick)}
            y1={8}
            y2={8 + plotH}
            stroke={font.fill}
            strokeOpacity={0.2}
          />
        ) : (
          <g key={i}>
            <line
              x1={left}
              x2={w - 8}
              y1={y(tick)}
              y2={y(tick)}
              stroke={font.fill}
              strokeOpacity={0.2}
            />
            <text x={left - 10} y={y(tick) + 6} textAnchor="end" {...font}>
              {tickLabel(tick)}
            </text>
          </g>
        ),
      )}
      {element.labels.map((label, i) =>
        horizontal ? (
          <text key={i} x={left - 10} y={8 + group * i + group / 2 + 6} textAnchor="end" {...font}>
            {label}
          </text>
        ) : (
          <text
            key={i}
            x={left + group * i + group / 2}
            y={8 + plotH + 28}
            textAnchor="middle"
            {...font}
          >
            {label}
          </text>
        ),
      )}
      {element.series.map((series, s) =>
        element.kind === "line" ? (
          <g key={s}>
            <polyline
              fill="none"
              stroke={seriesColor(s)}
              strokeWidth={4}
              strokeLinejoin="round"
              points={series.values
                .map((v, i) => `${left + group * i + group / 2},${y(v)}`)
                .join(" ")}
            />
            {series.values.map((v, i) => (
              <circle
                key={i}
                cx={left + group * i + group / 2}
                cy={y(v)}
                r={6}
                fill={seriesColor(s)}
              />
            ))}
          </g>
        ) : (
          <g key={s}>
            {series.values.map((v, i) => {
              const offset = group * i + group * 0.15 + bar * s;
              return horizontal ? (
                <rect
                  key={i}
                  x={x(Math.min(0, v))}
                  y={8 + offset}
                  width={Math.abs(x(v) - x(0))}
                  height={bar}
                  rx={4}
                  fill={seriesColor(s)}
                />
              ) : (
                <g key={i}>
                  <rect
                    x={left + offset}
                    y={Math.min(y(v), y(0))}
                    width={bar}
                    height={Math.abs(y(0) - y(v))}
                    rx={4}
                    fill={seriesColor(s)}
                  />
                  {element.showValues ? (
                    <text x={left + offset + bar / 2} y={y(v) - 8} textAnchor="middle" {...font}>
                      {v}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        ),
      )}
      {element.legend
        ? element.series.map((series, s) => (
            <g key={s} transform={`translate(${left + s * 200}, ${h - 14})`}>
              <rect width={14} height={14} y={-12} rx={3} fill={seriesColor(s)} />
              <text x={20} {...font}>
                {series.name}
              </text>
            </g>
          ))
        : null}
    </svg>
  );
}

/** An icon element: Moss's glyph as a mask, painted in the element's colour. */
function IconView(props: { name: string; color: string }) {
  const url = slideIconUrl(props.name);
  const mask = url ? `url("${url}") center / contain no-repeat` : undefined;
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        background: props.color,
        mask,
        WebkitMask: mask,
      }}
    />
  );
}

/** A still for an embed outside a live view (thumbnails, PDF): it cannot be painted to pixels. */
function EmbedStill(props: { title: string | undefined; theme: DeckTheme }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `color-mix(in srgb, ${props.theme.colors.text} 5%, transparent)`,
        color: props.theme.colors.muted,
        fontSize: 28,
      }}
    >
      {props.title ? `网页嵌入 · ${props.title}` : "网页嵌入"}
    </div>
  );
}

function ElementView(props: {
  element: SlideElement;
  theme: DeckTheme;
  highlight: boolean;
  live: boolean;
  build: BuildState | undefined;
}) {
  const { element, theme } = props;
  if (element.type === "line") return <LineView element={element} theme={theme} />;
  const framed = element.type !== "shape";
  const style: CSSProperties = {
    ...boxStyle(element, theme),
    boxSizing: "border-box",
    ...(framed && element.fill ? { background: fillCss(element.fill, theme) } : {}),
    ...(framed && borderCss(element.border, theme)
      ? { border: borderCss(element.border, theme) }
      : {}),
    ...(framed && element.radius ? { borderRadius: element.radius, overflow: "hidden" } : {}),
    ...(props.highlight
      ? { outline: "6px solid var(--color-accent, #3b82f6)", outlineOffset: 6 }
      : {}),
  };
  let content: ReactNode = null;
  switch (element.type) {
    case "text":
      content = (
        <TextBodyView
          body={element.body}
          theme={theme}
          height={element.h}
          padding={element.padding}
        />
      );
      break;
    case "shape":
      content = <ShapeView element={element} theme={theme} />;
      break;
    case "image": {
      const crop = element.crop;
      const visibleW = crop ? 1 - crop.l - crop.r : 1;
      const visibleH = crop ? 1 - crop.t - crop.b : 1;
      content = crop ? (
        <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
          <img
            alt={element.alt ?? ""}
            src={element.src}
            draggable={false}
            style={{
              position: "absolute",
              left: `${(-crop.l / visibleW) * 100}%`,
              top: `${(-crop.t / visibleH) * 100}%`,
              width: `${(1 / visibleW) * 100}%`,
              height: `${(1 / visibleH) * 100}%`,
            }}
          />
        </div>
      ) : (
        <img
          alt={element.alt ?? ""}
          src={element.src}
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: element.fit,
          }}
        />
      );
      break;
    }
    case "table":
      content = <TableView element={element} theme={theme} />;
      break;
    case "chart":
      content = <ChartView element={element} theme={theme} />;
      break;
    case "icon":
      content = (
        <IconView name={element.name} color={resolveColor(element.color ?? "@text", theme)} />
      );
      break;
    case "video":
      content = props.live ? (
        <video
          src={element.src}
          poster={element.poster}
          autoPlay={element.autoplay === true}
          loop={element.loop === true}
          muted={element.muted === true}
          controls
          playsInline
          onLoadedMetadata={(event) => {
            if (element.start) event.currentTarget.currentTime = element.start;
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      ) : element.poster ? (
        <img
          alt={element.alt ?? ""}
          src={element.poster}
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      ) : (
        <div style={{ position: "absolute", inset: 0, background: "rgb(17 17 16)" }} />
      );
      break;
    case "embed":
      content = props.live ? (
        <iframe
          title={element.title ?? "网页嵌入"}
          sandbox="allow-scripts"
          srcDoc={embedDocument(element.html)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            pointerEvents: "none",
          }}
        />
      ) : (
        <EmbedStill title={element.title} theme={theme} />
      );
      break;
  }
  const build = props.build ? buildStyle(element, props.build) : null;
  return (
    <div
      style={build ? { ...style, ...build } : style}
      data-element-id={element.id}
      data-build={build ? (element.build?.effect ?? undefined) : undefined}
    >
      {content}
    </div>
  );
}

/** 演示 builds: the step shown now; elements with a later `order` are not there yet. */
export interface BuildState {
  readonly step: number;
}
const BUILD_FROM: Record<string, string> = {
  fade: "none",
  rise: "translateY(48px)",
  drop: "translateY(-48px)",
  left: "translateX(-96px)",
  right: "translateX(96px)",
  scale: "scale(0.85)",
  pop: "scale(0.6)",
};
function buildStyle(element: SlideElement, state: BuildState): CSSProperties | null {
  const build = element.build;
  if (!build) return null;
  if (build.order > state.step) return { opacity: 0, visibility: "hidden" };
  if (build.order === state.step)
    return {
      animation: `moss-build-${build.effect} ${build.effect === "pop" ? 420 : 520}ms cubic-bezier(0.2, 0.8, 0.2, 1) both`,
      ["--moss-build-from" as string]: BUILD_FROM[build.effect] ?? "none",
    };
  return null;
}
/** Keyframes the build animations use (one copy per page). */
export const BUILD_KEYFRAMES = Object.keys(BUILD_FROM)
  .map(
    (effect) =>
      `@keyframes moss-build-${effect}{from{opacity:0;transform:var(--moss-build-from)}to{opacity:1;transform:none}}`,
  )
  .join("\n");
/** The build steps a slide has (sorted orders), for paging through it in 演示. */
export function buildSteps(slide: Slide): number[] {
  return [...new Set(slide.elements.flatMap((e) => (e.build ? [e.build.order] : [])))].sort(
    (a, b) => a - b,
  );
}

/** One slide at `width` px (16:9). `highlight` outlines elements a proposed change touches. */
export const SlideView = memo(function SlideView(props: {
  slide: Slide;
  theme: DeckTheme;
  width: number;
  highlight?: ReadonlySet<string>;
  className?: string;
  /** Plays videos and runs web embeds (演示, the viewer); off for thumbnails and exports. */
  live?: boolean;
  /** 演示 only: which build step is showing. */
  build?: BuildState;
}) {
  const scale = props.width / SLIDE_WIDTH;
  return (
    <div
      className={props.className}
      data-slide-id={props.slide.id}
      style={{
        position: "relative",
        width: props.width,
        height: Math.round(SLIDE_HEIGHT * scale),
        overflow: "hidden",
        background: fillCss(props.slide.background, props.theme) ?? props.theme.colors.background,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        {props.slide.elements.map((element) => (
          <ElementView
            key={element.id}
            element={element}
            theme={props.theme}
            highlight={props.highlight?.has(element.id) ?? false}
            live={props.live === true}
            build={props.build}
          />
        ))}
      </div>
    </div>
  );
});

/** The slide a 资料空间 card shows: the deck's cover slide, else the first visible one. */
export function coverSlide(deck: {
  coverSlideId?: string;
  slides: readonly Slide[];
}): Slide | null {
  return (
    deck.slides.find((slide) => slide.id === deck.coverSlideId) ??
    deck.slides.find((slide) => !slide.hidden) ??
    deck.slides[0] ??
    null
  );
}
