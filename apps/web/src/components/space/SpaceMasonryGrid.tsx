// FILE: SpaceMasonryGrid.tsx
// Purpose: The 资料空间's card grid: equal columns, each card as tall as its content (a tall
//          picture stays tall, a short note stays short), read left to right.
// Layer: Space UI
// Why: CSS columns would read top to bottom and break tab order. Here cards stay in a grid in
//      their own order; each measures itself and spans that many thin rows.

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

/** Grid row unit; a card spans its height in these, plus the gap. */
const ROW_PX = 4;
const GAP_PX = 20;

export function SpaceMasonryGrid(props: {
  className?: string;
  children: ReadonlyArray<{ readonly key: string; readonly node: ReactNode }>;
  "data-space-grid"?: boolean;
}) {
  return (
    <div
      data-space-grid={props["data-space-grid"] ? "" : undefined}
      className={cn(
        "grid [grid-template-columns:repeat(auto-fill,minmax(min(100%,max(14rem,22%)),1fr))]",
        props.className,
      )}
      style={{ gridAutoRows: ROW_PX, columnGap: GAP_PX }}
    >
      {props.children.map((child) => (
        <MasonryCell key={child.key}>{child.node}</MasonryCell>
      ))}
    </div>
  );
}

function MasonryCell(props: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [span, setSpan] = useState(60);
  useLayoutEffect(() => {
    const cell = ref.current;
    if (!cell) return;
    const measure = () => {
      const height = cell.firstElementChild?.getBoundingClientRect().height ?? 0;
      setSpan(Math.max(1, Math.ceil((height + GAP_PX) / ROW_PX)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (cell.firstElementChild) observer.observe(cell.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="min-w-0" style={{ gridRowEnd: `span ${span}` }}>
      {props.children}
    </div>
  );
}
