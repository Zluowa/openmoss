// FILE: designSize.ts
// Purpose: Watches an element's size for the 设计 canvas, player and thumbnails. The new size is
//          applied on the next frame and only when it changed, so a layout that reacts to it
//          never starts a resize-observer loop.
// Layer: Web components (browser only)

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

export function observeSize(
  element: HTMLElement,
  onSize: (size: ElementSize) => void,
): { disconnect: () => void } {
  let frame = 0;
  let last: ElementSize | null = null;
  const report = () => {
    frame = 0;
    const size = { width: element.clientWidth, height: element.clientHeight };
    if (last && last.width === size.width && last.height === size.height) return;
    last = size;
    onSize(size);
  };
  const observer = new ResizeObserver(() => {
    if (frame === 0) frame = requestAnimationFrame(report);
  });
  observer.observe(element);
  // The first size is known now; later ones follow the observer.
  report();
  return {
    disconnect: () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    },
  };
}
