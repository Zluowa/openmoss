// FILE: ProfileStatRows.tsx
// Purpose: The stat tiles, label/value rows and share bars used by Profile and by
//          Settings → Usage → Analytics.
// Layer: Web profile components
// Exports: StatTile, StatTileGrid, InsightRow, ModelUsageRow

import type { ReactNode } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

export interface StatTileProps {
  label: string;
  value: string | null;
  /** Optional muted context under the label, e.g. "42.2M per active day". */
  detail?: string;
}

export function StatTile({ label, value, detail }: StatTileProps) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 px-3 py-3">
      {value === null ? (
        <Skeleton className="h-4 w-12" />
      ) : (
        <span className="text-ui-lg leading-snug font-normal tabular-nums text-foreground">
          {value}
        </span>
      )}
      <span className="text-ui leading-snug font-normal text-muted-foreground">{label}</span>
      {detail ? (
        <span className="max-w-full truncate text-ui-sm leading-snug text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

const STAT_TILE_GRID_BASE =
  "grid grid-cols-2 divide-x divide-y divide-border/50 overflow-hidden rounded-card border border-border/60";

export function StatTileGrid({
  tiles,
  fitContainer = false,
}: {
  tiles: readonly StatTileProps[];
  /**
   * Pick the column count from the grid's own width instead of the window's, for
   * grids in columns narrower than the window (settings).
   */
  fitContainer?: boolean;
}) {
  const grid = (
    <div
      className={cn(
        STAT_TILE_GRID_BASE,
        fitContainer
          ? "@lg:grid-cols-3 @2xl:grid-cols-5 @2xl:divide-y-0"
          : "sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0",
      )}
    >
      {tiles.map((tile) => (
        <StatTile key={tile.label} {...tile} />
      ))}
    </div>
  );
  return fitContainer ? <div className="@container">{grid}</div> : grid;
}

export function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-ui leading-snug text-muted-foreground">{label}</dt>
      <dd className="truncate text-ui leading-snug font-normal tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

export function ModelUsageRow({
  icon,
  model,
  percent,
  detail,
  stat,
  barColor,
}: {
  /** Leading mark, e.g. `<ProviderIcon />`; null for none. */
  icon: ReactNode;
  model: string;
  percent: number;
  /** Muted text after the name, e.g. "42 turns". */
  detail?: string;
  /** Right-hand stat; defaults to "{percent}%". */
  stat?: string;
  /** Bar color; defaults to the accent (`--info`). */
  barColor?: string;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-ui leading-snug">
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate">{model}</span>
          {detail ? <span className="shrink-0 text-muted-foreground">{detail}</span> : null}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{stat ?? `${percent}%`}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--info)]"
          style={{
            width: `${Math.min(100, Math.max(2, percent))}%`,
            ...(barColor ? { background: barColor } : {}),
          }}
        />
      </div>
    </li>
  );
}
