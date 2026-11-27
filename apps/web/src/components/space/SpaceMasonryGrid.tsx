// FILE: SpaceMasonryGrid.tsx
// Purpose: Adaptive balanced masonry grid for 资料空间 items: maintains shortest-column flow
//          across container resizes and Ctrl+wheel card scaling with silky GPU-composited
//          transitions and zero jitter on initial paint.
// Layer: Space UI

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";

import {
  computeMasonryMetrics,
  DEFAULT_MASONRY_TARGET_WIDTH,
  layoutMasonryItems,
} from "./spaceMasonryLayout";

export function SpaceMasonryGrid(props: {
  className?: string;
  targetColumnWidth?: number | undefined;
  children: ReadonlyArray<{ readonly key: string; readonly node: ReactNode }>;
  "data-space-grid"?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const keyByElement = useRef(new WeakMap<Element, string>());
  const heightsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number | null>(null);

  const [containerWidth, setContainerWidth] = useState(960);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [animated, setAnimated] = useState(false);

  const scheduleReflow = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setMeasureVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => {
      cancelAnimationFrame(id);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Track container width cleanly across sidebar toggles & window resizes.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const syncWidth = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setContainerWidth((prev) => (prev === next ? prev : next));
    };
    syncWidth();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncWidth);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Maintain one shared ResizeObserver for every active masonry cell.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = keyByElement.current.get(entry.target);
        if (!key) continue;
        const height = Math.round(entry.target.getBoundingClientRect().height);
        if (height > 0 && heightsRef.current.get(key) !== height) {
          heightsRef.current.set(key, height);
          changed = true;
        }
      }
      if (changed) scheduleReflow();
    });
    observerRef.current = ro;
    for (const [key, cell] of cellRefs.current.entries()) {
      keyByElement.current.set(cell, key);
      ro.observe(cell);
    }
    return () => {
      ro.disconnect();
      observerRef.current = null;
    };
  }, [scheduleReflow]);

  const targetWidth = props.targetColumnWidth ?? DEFAULT_MASONRY_TARGET_WIDTH;
  const metrics = useMemo(
    () => computeMasonryMetrics(containerWidth, targetWidth),
    [containerWidth, targetWidth],
  );

  const keys = useMemo(() => props.children.map((child) => child.key), [props.children]);

  // Synchronously capture initial rendered cell heights before browser paint when cards mount.
  useLayoutEffect(() => {
    const activeKeys = new Set(keys);
    let changed = false;
    for (const key of heightsRef.current.keys()) {
      if (!activeKeys.has(key)) {
        heightsRef.current.delete(key);
        changed = true;
      }
    }
    for (const [key, cell] of cellRefs.current.entries()) {
      if (!activeKeys.has(key)) continue;
      const height = Math.round(cell.getBoundingClientRect().height);
      if (height > 0 && heightsRef.current.get(key) !== height) {
        heightsRef.current.set(key, height);
        changed = true;
      }
    }
    if (changed) {
      setMeasureVersion((v) => v + 1);
    }
  }, [keys, metrics.columnWidth]);

  const layout = useMemo(() => {
    void measureVersion;
    return layoutMasonryItems(keys, heightsRef.current, metrics);
  }, [keys, metrics, measureVersion]);

  const setCellRef = useCallback((key: string, node: HTMLDivElement | null) => {
    const prev = cellRefs.current.get(key);
    if (prev && prev !== node) {
      observerRef.current?.unobserve(prev);
      cellRefs.current.delete(key);
    }
    if (node) {
      cellRefs.current.set(key, node);
      keyByElement.current.set(node, key);
      observerRef.current?.observe(node);
    }
  }, []);

  return (
    <div
      ref={containerRef}
      data-space-grid={props["data-space-grid"] ? "" : undefined}
      data-masonry-columns={metrics.columnCount}
      data-masonry-col-width={Math.round(metrics.columnWidth)}
      className={cn("relative w-full", props.className)}
      style={{
        height: layout.totalHeight,
        transition: animated ? "height 260ms cubic-bezier(0.22, 1, 0.36, 1)" : undefined,
      }}
    >
      {props.children.map((child, index) => {
        const pos = layout.positions.get(child.key) ?? {
          x: (index % metrics.columnCount) * (metrics.columnWidth + metrics.gap),
          y: 0,
          width: metrics.columnWidth,
          column: index % metrics.columnCount,
        };
        return (
          <div
            key={child.key}
            ref={(node) => setCellRef(child.key, node)}
            data-space-masonry-item={child.key}
            className="min-w-0 will-change-transform motion-reduce:transition-none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: pos.width,
              transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
              transition: animated
                ? "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), width 280ms cubic-bezier(0.22, 1, 0.36, 1)"
                : undefined,
            }}
          >
            {child.node}
          </div>
        );
      })}
    </div>
  );
}
