// FILE: ActivityHeatmap.tsx
// Purpose: GitHub-style contribution heatmap shared by the Profile page and the
// shareable card. Renders columns of week × weekday cells with pre-bucketed
// intensity. Sizing uses inline px so html-to-image reproduces it exactly.
// Layer: web profile feature.

import { type CSSProperties } from "react";
import type { ProfileHeatmapCell } from "@synara/contracts";
import type { MossLocaleCode } from "~/appSettings";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatCompact, formatShortDate } from "./profileFormatting";

// Single-hue ramp built from the theme accent (`--info`, defaults to blue-500) for the
// in-app page (level 0 → 4). Mixes toward transparent so it sits well on light/dark.
export const APP_HEATMAP_INTENSITY_CLASSES: readonly string[] = [
  "bg-[color-mix(in_srgb,var(--color-border)_62%,transparent)] dark:bg-white/[0.06]",
  "bg-[color-mix(in_srgb,var(--info)_24%,transparent)]",
  "bg-[color-mix(in_srgb,var(--info)_46%,transparent)]",
  "bg-[color-mix(in_srgb,var(--info)_72%,transparent)]",
  "bg-[var(--info)]",
];

export type ProfileActivityView = "daily" | "weekly" | "cumulative";

// Accent ramp for the exported card. Mixes toward white so the steps stay opaque on the
// card's white background and reproduce identically via html-to-image. Level 0 mirrors the
// in-app heatmap's empty cell (`bg-muted/70`, i.e. black ~2.8%) flattened to an opaque color
// on white, so the exported image matches the empty-box color shown in the app.
export const CARD_HEATMAP_INTENSITY_CLASSES: readonly string[] = [
  "bg-[color-mix(in_srgb,black_2.8%,white)]",
  "bg-[color-mix(in_srgb,var(--info)_22%,white)]",
  "bg-[color-mix(in_srgb,var(--info)_45%,white)]",
  "bg-[color-mix(in_srgb,var(--info)_70%,white)]",
  "bg-[var(--info)]",
];

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

interface ActivityHeatmapProps {
  readonly cells: ReadonlyArray<ProfileHeatmapCell>;
  readonly cellSize?: number;
  readonly gap?: number;
  readonly radius?: number;
  readonly intensityClasses?: readonly string[];
  readonly showMonths?: boolean;
  readonly monthsPosition?: "top" | "bottom";
  readonly monthLabelClassName?: string;
  /**
   * Stretch columns to fill the container width (responsive square cells) instead
   * of using a fixed `cellSize`. Used by the in-app panel so the grid never scrolls
   * horizontally; the exported card keeps fixed px so html-to-image is exact.
   */
  readonly fill?: boolean;
  /**
   * In `fill` mode, stretch week columns across the container. When set, `maxCellSize`
   * caps each square cell's maximum size; columns shrink below that cap if needed so the
   * grid never overflows horizontally.
   */
  readonly maxCellSize?: number;
  /** Show a styled tooltip on hover. Leave off for the exported card (html-to-image). */
  readonly tooltip?: boolean;
  /** Noun used in the tooltip, e.g. "prompts" or "tokens". */
  readonly tooltipUnit?: string;
  /** UI locale used for Profile-specific compact count units. */
  readonly locale?: MossLocaleCode;
  /** Daily squares, weekly bars, or running cumulative weekly bars. */
  readonly view?: ProfileActivityView;
  /** Staggered cell entrance used by the interactive profile page, never share-card export. */
  readonly animated?: boolean;
  readonly className?: string;
}

function heatmapTooltipText(
  count: number,
  day: string,
  unit: string,
  locale: MossLocaleCode,
  view: ProfileActivityView,
): string {
  const date = formatShortDate(day) ?? day;
  if (view === "weekly") {
    return `${formatCompact(count, locale)} ${unit} on week of ${date}`;
  }
  if (view === "cumulative") {
    return `${formatCompact(count, locale)} ${unit} through week of ${date}`;
  }
  if (count <= 0) {
    return `No ${unit} on ${date}`;
  }
  const noun = count === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${formatCompact(count, locale)} ${noun} on ${date}`;
}

function dailyIntensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function weeklyFillRows(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil((count / max) * 7));
}

function clampIntensity(value: number): number {
  return Math.max(0, Math.min(4, Math.round(value)));
}

type Slot =
  | { readonly kind: "cell"; readonly cell: ProfileHeatmapCell }
  | { readonly kind: "pad"; readonly id: string };

interface Column {
  readonly key: string;
  readonly slots: ReadonlyArray<Slot>;
}

export function ActivityHeatmap({
  cells,
  cellSize: cellSizeProp,
  gap: gapProp,
  radius: radiusProp,
  intensityClasses: intensityClassesProp,
  showMonths: showMonthsProp,
  monthsPosition: monthsPositionProp,
  monthLabelClassName,
  fill: fillProp,
  maxCellSize,
  tooltip: tooltipProp,
  tooltipUnit: tooltipUnitProp,
  locale: localeProp,
  view: viewProp,
  animated: animatedProp,
  className,
}: ActivityHeatmapProps) {
  const cellSize = cellSizeProp ?? 13;
  const gap = gapProp ?? 3;
  const radius = radiusProp ?? 4;
  const intensityClasses = intensityClassesProp ?? APP_HEATMAP_INTENSITY_CLASSES;
  const showMonths = showMonthsProp ?? false;
  const monthsPosition = monthsPositionProp ?? "top";
  const fill = fillProp ?? false;
  const tooltip = tooltipProp ?? false;
  const tooltipUnit = tooltipUnitProp ?? "prompts";
  const locale = localeProp ?? "en";
  const view = viewProp ?? "daily";
  const animated = animatedProp ?? false;
  const columns: Column[] = [];
  if (cells.length > 0) {
    const slots: Slot[] = [];
    for (let index = 0; index < cells[0]!.weekday; index += 1) {
      slots.push({ kind: "pad", id: `pad-lead-${index}` });
    }
    for (const cell of cells) {
      slots.push({ kind: "cell", cell });
    }
    while (slots.length % 7 !== 0) {
      slots.push({ kind: "pad", id: `pad-tail-${slots.length}` });
    }

    for (let index = 0; index < slots.length; index += 7) {
      const week = slots.slice(index, index + 7);
      const firstCell = week.find(
        (slot): slot is Extract<Slot, { kind: "cell" }> => slot.kind === "cell",
      );
      columns.push({ key: firstCell ? firstCell.cell.day : `col-${index}`, slots: week });
    }
  }

  const dailyMax = cells.reduce((max, cell) => Math.max(max, cell.count), 0);
  const weeklyCounts = columns.map((column) =>
    column.slots.reduce(
      (sum, slot) => sum + (slot.kind === "cell" ? Math.max(0, slot.cell.count) : 0),
      0,
    ),
  );
  const cumulativeCounts = weeklyCounts.reduce<number[]>((running, count) => {
    running.push((running.at(-1) ?? 0) + count);
    return running;
  }, []);
  const selectedWeeklyCounts = view === "cumulative" ? cumulativeCounts : weeklyCounts;
  const weeklyMax = selectedWeeklyCounts.reduce((max, count) => Math.max(max, count), 0);

  let previousMonth = -1;
  const monthByColumn: (string | null)[] = columns.map((column) => {
    const firstCell = column.slots.find(
      (slot): slot is Extract<Slot, { kind: "cell" }> => slot.kind === "cell",
    );
    if (!firstCell) {
      return null;
    }
    const monthIndex = Number(firstCell.cell.day.split("-")[1]) - 1;
    if (monthIndex === previousMonth || monthIndex < 0) {
      return null;
    }
    previousMonth = monthIndex;
    return MONTH_LABELS[monthIndex] ?? null;
  });

  const columnCount = columns.length;
  const responsiveFill = fill && maxCellSize != null;
  const resolvedCellSize = fill ? (maxCellSize ?? cellSize) : cellSize;

  const columnStyle: CSSProperties = { gap: `${gap}px` };
  const cellStyle: CSSProperties = fill
    ? { borderRadius: `${radius}px` }
    : {
        width: `${resolvedCellSize}px`,
        height: `${resolvedCellSize}px`,
        borderRadius: `${radius}px`,
      };
  const cellClass = fill ? "aspect-square w-full min-w-0" : "shrink-0";
  const fillColumnStyle: CSSProperties = responsiveFill
    ? { ...columnStyle, flex: "1 1 0%", maxWidth: `${maxCellSize}px`, minWidth: 0 }
    : columnStyle;
  const columnClass = fill ? "flex min-w-0 flex-1 flex-col" : "flex shrink-0 flex-col";
  const monthLabelWidth: CSSProperties | undefined = fill
    ? responsiveFill
      ? { flex: "1 1 0%", maxWidth: `${maxCellSize}px`, minWidth: 0 }
      : undefined
    : { width: `${resolvedCellSize}px` };
  const monthLabelClass = fill ? "min-w-0 flex-1" : "shrink-0";
  const rowClass = fill ? "flex w-full min-w-0" : "flex w-max";
  const gridWidth =
    !fill && columnCount > 0
      ? columnCount * resolvedCellSize + Math.max(0, columnCount - 1) * gap
      : 0;
  const rowStyle: CSSProperties = {
    ...columnStyle,
    ...(gridWidth > 0 ? { width: `${gridWidth}px` } : {}),
  };

  const monthRow = showMonths ? (
    <div className={rowClass} style={rowStyle}>
      {columns.map((column, index) => (
        <div
          key={column.key}
          className={cn(
            "overflow-visible whitespace-nowrap text-ui-xs font-medium leading-none text-muted-foreground",
            monthLabelClass,
            monthLabelClassName,
          )}
          style={monthLabelWidth}
        >
          {monthByColumn[index] ?? ""}
        </div>
      ))}
    </div>
  ) : null;

  const renderCell = (slot: Slot, columnIndex: number, rowIndex: number) => {
    if (view === "daily" && slot.kind !== "cell") {
      return (
        <div
          key={`${view}:${slot.id}`}
          className={cn(cellClass, "bg-transparent")}
          style={cellStyle}
        />
      );
    }

    const count = slot.kind === "cell" ? slot.cell.count : 0;
    const level =
      view === "daily"
        ? animated
          ? dailyIntensity(count, dailyMax)
          : clampIntensity(slot.kind === "cell" ? slot.cell.intensity : 0)
        : rowIndex >= 7 - weeklyFillRows(selectedWeeklyCounts[columnIndex] ?? 0, weeklyMax)
          ? 4
          : 0;
    const key = slot.kind === "cell" ? slot.cell.day : slot.id;
    const resolvedStyle: CSSProperties = animated
      ? { ...cellStyle, animationDelay: `${columnIndex * 8 + rowIndex * 12}ms` }
      : cellStyle;
    const cellClassName = cn(
      cellClass,
      "profile-activity-cell",
      animated && "profile-activity-cell--animated",
      intensityClasses[level] ?? intensityClasses[0],
    );
    const cell = (
      <div
        key={`${view}:${key}`}
        className={cellClassName}
        data-profile-activity-level={level}
        style={resolvedStyle}
        title={
          !tooltip && slot.kind === "cell"
            ? `${slot.cell.day} · ${count.toLocaleString()}`
            : undefined
        }
      />
    );

    if (view !== "daily" || !tooltip || slot.kind !== "cell") {
      return cell;
    }

    return (
      <Tooltip key={`${view}:${key}`}>
        {/* delay={0}: profile tooltips should track the pointer without a dwell delay. */}
        <TooltipTrigger delay={0} render={cell} />
        <TooltipPopup side="top" sideOffset={6}>
          {heatmapTooltipText(count, slot.cell.day, tooltipUnit, locale, view)}
        </TooltipPopup>
      </Tooltip>
    );
  };

  const renderColumn = (column: Column, columnIndex: number) => {
    const columnBody = (
      <div key={`${view}:${column.key}`} className={columnClass} style={fillColumnStyle}>
        {column.slots.map((slot, rowIndex) => renderCell(slot, columnIndex, rowIndex))}
      </div>
    );
    if (view === "daily" || !tooltip) {
      return columnBody;
    }

    const firstCell = column.slots.find(
      (slot): slot is Extract<Slot, { kind: "cell" }> => slot.kind === "cell",
    );
    const day = firstCell?.cell.day ?? column.key;
    const count = selectedWeeklyCounts[columnIndex] ?? 0;
    return (
      <Tooltip key={`${view}:${column.key}`}>
        <TooltipTrigger delay={0} render={columnBody} />
        <TooltipPopup side="top" sideOffset={6}>
          {heatmapTooltipText(count, day, tooltipUnit, locale, view)}
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <div
      role="img"
      aria-label={`${tooltipUnit} activity`}
      className={cn(fill ? "flex w-full min-w-0 flex-col" : "inline-flex flex-col", className)}
      data-profile-activity-view={view}
      style={{ gap: `${gap}px` }}
    >
      {showMonths && monthsPosition === "top" ? monthRow : null}
      <div className={rowClass} style={rowStyle}>
        {columns.map(renderColumn)}
      </div>
      {showMonths && monthsPosition === "bottom" ? monthRow : null}
    </div>
  );
}
