// FILE: frameTracker.ts
// Purpose: Keep a widget's live frame on top of its slot. The frame cannot move in the DOM
//          (moving a webview destroys its guest), so it lives in a stable portal and follows
//          the slot: on any scroll (capture), on size changes, and every frame while the slot is
//          on screen (layout shifts above it, virtualised list moves). It is clipped to the
//          slot's scrolling ancestors and kept off the composer, so it never paints outside
//          the transcript. Size reports to the widget are debounced while the slot animates.
// Layer: Web MCP App host presentation
// Exports: McpAppFrameTracker, computeMcpAppFrameClip, MCP_APP_DIMENSIONS_SETTLE_MS

export type McpAppFrameMode = "inline" | "fullscreen";

export interface McpAppFrameRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface McpAppFrameDimensions {
  readonly width: number;
  readonly height: number;
}

/** Host-context size changes wait until the slot stopped resizing this long (dock slide). */
export const MCP_APP_DIMENSIONS_SETTLE_MS = 150;

const COMPOSER_SELECTOR = "[data-chat-composer-slot]";
const PANE_SELECTOR = "[data-right-dock-main-content]";

function rectOf(element: Element): McpAppFrameRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function intersect(a: McpAppFrameRect, b: McpAppFrameRect): McpAppFrameRect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function clipsOverflow(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    style.overflowX !== "visible" ||
    style.overflowY !== "visible" ||
    style.contain.includes("paint")
  );
}

/** Ancestors (inside the portal, or up to the document) that clip their content. */
function clippingAncestors(target: HTMLElement, stopAt: HTMLElement | null): HTMLElement[] {
  const result: HTMLElement[] = [];
  let node = target.parentElement;
  while (node && node !== document.documentElement) {
    if (node === stopAt) break;
    if (clipsOverflow(node)) result.push(node);
    node = node.parentElement;
  }
  return result;
}

/**
 * The visible part of `slot`: inside the viewport, every clipping ancestor and, for inline
 * frames, above a composer that overlaps the transcript.
 */
export function computeMcpAppFrameClip(input: {
  readonly slot: McpAppFrameRect;
  readonly viewport: McpAppFrameRect;
  readonly clippers: readonly McpAppFrameRect[];
  readonly composer: McpAppFrameRect | null;
}): McpAppFrameRect {
  let clip = intersect(input.slot, input.viewport);
  for (const clipper of input.clippers) clip = intersect(clip, clipper);
  const composer = input.composer;
  if (
    composer &&
    composer.left < clip.right &&
    composer.right > clip.left &&
    composer.top < clip.bottom &&
    composer.bottom > clip.top
  ) {
    clip = { ...clip, bottom: Math.max(clip.top, composer.top) };
  }
  return clip;
}

function currentCssZoom(element: HTMLElement): number {
  const zoom = (element as HTMLElement & { readonly currentCSSZoom?: unknown }).currentCSSZoom;
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function rectKey(rect: McpAppFrameRect): string {
  return `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
}

export interface McpAppFrameTrackerOptions {
  /** Called with the slot size once it has settled, and with the mode on every mode change. */
  readonly onDimensions: (dimensions: McpAppFrameDimensions, mode: McpAppFrameMode) => void;
  readonly zIndexFor: (mode: McpAppFrameMode) => string;
}

export class McpAppFrameTracker {
  private target: HTMLElement | null = null;
  private mode: McpAppFrameMode = "inline";
  private visible = true;
  private disposed = false;
  private clippers: HTMLElement[] = [];
  private lastKey = "";
  private watchFrame: number | null = null;
  private scheduled: number | null = null;
  private onScreen = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private dimensionsTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDimensions = "";
  private readonly onScroll = () => this.schedule();
  private readonly onResize = () => this.schedule(true);

  constructor(
    private readonly wrapper: HTMLElement,
    private readonly portal: HTMLElement,
    private readonly options: McpAppFrameTrackerOptions,
  ) {
    // Any scroll anywhere can move the slot: the transcript scroller is a descendant of the
    // portal, not the portal itself.
    document.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    window.addEventListener("resize", this.onResize);
  }

  getMode(): McpAppFrameMode {
    return this.mode;
  }

  /** Lay the frame over `target` now and keep following it. False when it cannot be placed. */
  follow(target: HTMLElement, mode: McpAppFrameMode): boolean {
    if (this.disposed || !target.isConnected || !this.portal.isConnected) return false;
    const modeChanged = mode !== this.mode || target !== this.target;
    this.target = target;
    this.mode = mode;
    this.clippers = clippingAncestors(target, null);
    this.observe(target);
    this.lastKey = "";
    this.apply();
    if (modeChanged) this.reportDimensions(true);
    return true;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.lastKey = "";
    this.apply();
  }

  /** Re-measure on the next frame (layout may have changed). */
  schedule(recomputeClippers = false): void {
    if (this.disposed || this.scheduled !== null) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = null;
      if (recomputeClippers && this.target) this.clippers = clippingAncestors(this.target, null);
      this.apply();
    });
  }

  dispose(): void {
    this.disposed = true;
    document.removeEventListener("scroll", this.onScroll, { capture: true });
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    if (this.watchFrame !== null) cancelAnimationFrame(this.watchFrame);
    if (this.scheduled !== null) cancelAnimationFrame(this.scheduled);
    if (this.dimensionsTimer !== null) clearTimeout(this.dimensionsTimer);
    this.watchFrame = null;
    this.scheduled = null;
    this.dimensionsTimer = null;
    this.target = null;
  }

  private observe(target: HTMLElement): void {
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver ??= new ResizeObserver(() => this.schedule(true));
      this.resizeObserver.disconnect();
      this.resizeObserver.observe(target);
      this.resizeObserver.observe(this.portal);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver?.disconnect();
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        this.onScreen = entry.isIntersecting;
        this.lastKey = "";
        this.apply();
        this.watch();
      });
      this.intersectionObserver.observe(target);
    }
    this.watch();
  }

  /** While the slot is on screen, follow it every frame: cheap when nothing moved. */
  private watch(): void {
    if (this.watchFrame !== null || this.disposed || !this.onScreen) return;
    const step = () => {
      this.watchFrame = null;
      if (this.disposed || !this.target || !this.onScreen) return;
      this.apply();
      this.watchFrame = requestAnimationFrame(step);
    };
    this.watchFrame = requestAnimationFrame(step);
  }

  private apply(): void {
    const target = this.target;
    const wrapper = this.wrapper;
    if (!target || this.disposed) return;
    if (!target.isConnected || !this.portal.isConnected) {
      wrapper.style.display = "none";
      return;
    }
    const slot = rectOf(target);
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const composer =
      this.mode === "inline"
        ? (target.closest(PANE_SELECTOR)?.querySelector(COMPOSER_SELECTOR) ?? null)
        : null;
    const clip = computeMcpAppFrameClip({
      slot,
      viewport,
      clippers: this.clippers.map(rectOf),
      composer: composer ? rectOf(composer) : null,
    });
    const key = `${this.mode}|${this.visible}|${rectKey(slot)}|${rectKey(clip)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const zoom = currentCssZoom(this.portal);
    const width = (slot.right - slot.left) / zoom;
    const height = (slot.bottom - slot.top) / zoom;
    const fullyClipped = clip.right <= clip.left || clip.bottom <= clip.top;
    // A hidden frame is parked, not removed: it stays displayed, at least 1 px tall and fully
    // clipped. A guest that is display:none, visibility:hidden or zero-area is not laid out
    // or animated, so a widget that starts while collapsed, behind a prompt or before its
    // first size would never measure itself and its card would stay 0 px.
    const parked = !this.visible || fullyClipped;
    wrapper.style.position = this.mode === "fullscreen" ? "fixed" : "absolute";
    wrapper.style.zIndex = this.options.zIndexFor(this.mode);
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${Math.max(height, 1)}px`;
    wrapper.style.removeProperty("right");
    wrapper.style.removeProperty("bottom");
    wrapper.style.display = "block";
    // Place by measuring the result, whatever the containing block, scroll or zoom is.
    const current = wrapper.getBoundingClientRect();
    const left = Number.parseFloat(wrapper.style.left || "0") || 0;
    const top = Number.parseFloat(wrapper.style.top || "0") || 0;
    wrapper.style.left = `${left + (slot.left - current.left) / zoom}px`;
    wrapper.style.top = `${top + (slot.top - current.top) / zoom}px`;
    const inset = [
      (clip.top - slot.top) / zoom,
      (slot.right - clip.right) / zoom,
      (slot.bottom - clip.bottom) / zoom,
      (clip.left - slot.left) / zoom,
    ].map((value) => Math.max(0, Math.round(value * 100) / 100));
    wrapper.style.clipPath = parked
      ? "inset(50%)"
      : `inset(${inset.map((value) => `${value}px`).join(" ")})`;
    // Readable by tests and diagnostics: the clip in CSS px (top right bottom left).
    wrapper.dataset.mcpAppClip = parked ? "hidden" : inset.join(" ");
    wrapper.style.visibility = "visible";
    wrapper.style.pointerEvents = parked ? "none" : "auto";
    wrapper.inert = parked;
    this.reportDimensions(false);
  }

  private reportDimensions(immediate: boolean): void {
    const target = this.target;
    if (!target) return;
    const zoom = currentCssZoom(this.portal);
    const rect = target.getBoundingClientRect();
    const dimensions = {
      width: Math.max(0, Math.round(rect.width / zoom)),
      height: Math.max(0, Math.round(rect.height / zoom)),
    };
    const key = `${this.mode}|${dimensions.width}|${this.mode === "fullscreen" ? dimensions.height : ""}`;
    if (!immediate && key === this.lastDimensions) return;
    if (this.dimensionsTimer !== null) clearTimeout(this.dimensionsTimer);
    const send = () => {
      this.dimensionsTimer = null;
      if (this.disposed) return;
      this.lastDimensions = key;
      this.options.onDimensions(dimensions, this.mode);
    };
    if (immediate) send();
    else this.dimensionsTimer = setTimeout(send, MCP_APP_DIMENSIONS_SETTLE_MS);
  }
}
