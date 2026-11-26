// FILE: useMeasuredElementHeight.ts
// Purpose: Shares measured content height for chat disclosures.
// Layer: Web chat presentation hook

import { useCallback, useEffect, useRef, useState } from "react";

function borderBoxBlockSize(entry: ResizeObserverEntry): number | undefined {
  const borderBoxSize = entry.borderBoxSize as unknown as
    | readonly ResizeObserverSize[]
    | { blockSize?: number }
    | undefined;
  return Array.isArray(borderBoxSize)
    ? borderBoxSize[0]?.blockSize
    : borderBoxSize && "blockSize" in borderBoxSize
      ? borderBoxSize.blockSize
      : undefined;
}

export function useMeasuredElementHeight<T extends HTMLElement = HTMLDivElement>(): {
  measuredHeight: number;
  measuredElementRef: (element: T | null) => void;
} {
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const measuredHeightRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const setNormalizedHeight = useCallback((nextHeight: number) => {
    if (!Number.isFinite(nextHeight)) return;
    const normalizedHeight = Math.max(0, nextHeight);
    if (measuredHeightRef.current === normalizedHeight) return;
    measuredHeightRef.current = normalizedHeight;
    setMeasuredHeight(normalizedHeight);
  }, []);

  const measuredElementRef = useCallback(
    (element: T | null) => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (rafIdRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (!element) return;

      // Seed the target synchronously before Motion starts the first open.
      setNormalizedHeight(element.scrollHeight);
      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const height = borderBoxBlockSize(entry) ?? entry.contentRect.height;
        if (typeof requestAnimationFrame !== "function") {
          setNormalizedHeight(height);
          return;
        }
        if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          setNormalizedHeight(height);
        });
      });
      observer.observe(element);
      resizeObserverRef.current = observer;
    },
    [setNormalizedHeight],
  );

  useEffect(
    () => () => {
      if (rafIdRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    },
    [],
  );

  return { measuredHeight, measuredElementRef };
}
