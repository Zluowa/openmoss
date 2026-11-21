// FILE: appSnapCaptureOverlay.ts
// Purpose: Pre-warmed, click-through, GPU-composited capture feedback overlay for Windows AppSnap.
// Layer: Desktop main-process service (pure geometry/policy helpers + narrow window adapter)

export interface AppSnapScreenBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AppSnapCaptureOverlayPolicyInput {
  readonly platform: NodeJS.Platform;
  readonly reducedMotion?: boolean;
  readonly highContrast?: boolean;
  readonly offscreen?: boolean;
  readonly disabled?: boolean;
}

export interface AppSnapCaptureOverlayWindowLike {
  isDestroyed(): boolean;
  setBounds(bounds: AppSnapScreenBounds, animate?: boolean): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  executePlay(): Promise<boolean>;
}

export interface DesktopAppSnapCaptureOverlayOptions {
  readonly platform: NodeJS.Platform;
  readonly shouldShow: () => boolean;
  readonly createWindow: (htmlDataUrl: string) => Promise<AppSnapCaptureOverlayWindowLike | null>;
  readonly toDipBounds?: (bounds: AppSnapScreenBounds) => AppSnapScreenBounds;
  readonly getDisplayBounds?: (bounds: AppSnapScreenBounds) => AppSnapScreenBounds | null;
  readonly peakDelayMs?: number;
  readonly hideAfterMs?: number;
}

/**
 * Duration of the GPU-composited capture overlay highlight animation.
 * Kept within the crisp 180-280 ms window so feedback feels tactile without
 * ever dragging out the return to Moss.
 */
export const APP_SNAP_OVERLAY_ANIMATION_MS = 220;

/**
 * Brief beat at the peak of the selection highlight before Moss raises into
 * focus. Disk validation/persistence runs in parallel during this window, so
 * the user clearly registers the captured target without added stall.
 */
export const APP_SNAP_OVERLAY_PEAK_DELAY_MS = 75;

/** Auto-hide deadline after the overlay animation settles. */
export const APP_SNAP_OVERLAY_HIDE_AFTER_MS = 260;

const MIN_OVERLAY_EXTENT_PX = 32;

export function shouldShowAppSnapCaptureOverlay(input: AppSnapCaptureOverlayPolicyInput): boolean {
  if (input.platform !== "win32") return false;
  if (input.reducedMotion || input.highContrast || input.offscreen || input.disabled) return false;
  return true;
}

export function normalizeCaptureOverlayBounds(
  bounds: AppSnapScreenBounds | null | undefined,
  displayBounds?: AppSnapScreenBounds | null,
): AppSnapScreenBounds | null {
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_OVERLAY_EXTENT_PX ||
    height < MIN_OVERLAY_EXTENT_PX
  ) {
    return null;
  }

  let left = x;
  let top = y;
  let right = x + width;
  let bottom = y + height;

  if (
    displayBounds &&
    Number.isFinite(displayBounds.x) &&
    Number.isFinite(displayBounds.y) &&
    Number.isFinite(displayBounds.width) &&
    Number.isFinite(displayBounds.height) &&
    displayBounds.width > 0 &&
    displayBounds.height > 0
  ) {
    left = Math.max(left, displayBounds.x);
    top = Math.max(top, displayBounds.y);
    right = Math.min(right, displayBounds.x + displayBounds.width);
    bottom = Math.min(bottom, displayBounds.y + displayBounds.height);
  }

  const clampedWidth = Math.round(right - left);
  const clampedHeight = Math.round(bottom - top);
  if (clampedWidth < MIN_OVERLAY_EXTENT_PX || clampedHeight < MIN_OVERLAY_EXTENT_PX) {
    return null;
  }
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: clampedWidth,
    height: clampedHeight,
  };
}

/**
 * Self-contained HTML document for the transparent Windows capture highlight
 * overlay. Animates ONLY `transform` and `opacity` on the compositor thread
 * and strictly suppresses motion under `prefers-reduced-motion: reduce`.
 */
export function buildAppSnapCaptureOverlayHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    pointer-events: none;
    user-select: none;
  }
  .frame {
    position: fixed;
    inset: 4px;
    border-radius: 12px;
    opacity: 0;
    transform: scale(1.016);
    background: radial-gradient(
      120% 90% at 50% 24%,
      rgba(255, 255, 255, 0.28) 0%,
      rgba(255, 255, 255, 0.10) 64%,
      rgba(59, 130, 246, 0.08) 100%
    );
    border: 2px solid rgba(255, 255, 255, 0.92);
    box-shadow:
      inset 0 0 0 1px rgba(59, 130, 246, 0.52),
      0 0 0 1px rgba(15, 23, 42, 0.24);
  }
  .corner {
    position: absolute;
    width: 16px;
    height: 16px;
    border-color: rgba(255, 255, 255, 0.98);
    border-style: solid;
    border-width: 0;
  }
  .tl { top: 8px; left: 8px; border-top-width: 2.5px; border-left-width: 2.5px; border-top-left-radius: 5px; }
  .tr { top: 8px; right: 8px; border-top-width: 2.5px; border-right-width: 2.5px; border-top-right-radius: 5px; }
  .bl { bottom: 8px; left: 8px; border-bottom-width: 2.5px; border-left-width: 2.5px; border-bottom-left-radius: 5px; }
  .br { bottom: 8px; right: 8px; border-bottom-width: 2.5px; border-right-width: 2.5px; border-bottom-right-radius: 5px; }

  @keyframes appsnap-win-overlay-pulse {
    0% {
      opacity: 0;
      transform: scale(1.016);
    }
    24% {
      opacity: 1;
      transform: scale(1);
    }
    56% {
      opacity: 0.72;
      transform: scale(0.998);
    }
    100% {
      opacity: 0;
      transform: scale(0.992);
    }
  }

  .frame.active {
    animation: appsnap-win-overlay-pulse ${APP_SNAP_OVERLAY_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }

  @media (prefers-reduced-motion: reduce) {
    .frame,
    .frame.active {
      animation: none;
      opacity: 0;
      transform: none;
    }
  }
</style>
</head>
<body>
  <div id="frame" class="frame" aria-hidden="true">
    <span class="corner tl"></span>
    <span class="corner tr"></span>
    <span class="corner bl"></span>
    <span class="corner br"></span>
  </div>
  <script>
    window.__mossPlayAppSnapOverlay = function () {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return false;
      }
      var frame = document.getElementById("frame");
      if (!frame) return false;
      frame.classList.remove("active");
      void frame.offsetWidth;
      frame.classList.add("active");
      return true;
    };
  </script>
</body>
</html>`;
}

export function buildAppSnapCaptureOverlayDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildAppSnapCaptureOverlayHtml())}`;
}

export class DesktopAppSnapCaptureOverlay {
  readonly #options: DesktopAppSnapCaptureOverlayOptions;
  readonly #peakDelayMs: number;
  readonly #hideAfterMs: number;
  #window: AppSnapCaptureOverlayWindowLike | null = null;
  #creating: Promise<AppSnapCaptureOverlayWindowLike | null> | null = null;
  #hideTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: DesktopAppSnapCaptureOverlayOptions) {
    this.#options = options;
    this.#peakDelayMs = options.peakDelayMs ?? APP_SNAP_OVERLAY_PEAK_DELAY_MS;
    this.#hideAfterMs = options.hideAfterMs ?? APP_SNAP_OVERLAY_HIDE_AFTER_MS;
  }

  prewarm(): void {
    if (this.#disposed || this.#options.platform !== "win32") return;
    if (!this.#options.shouldShow()) return;
    void this.#ensureWindow().catch(() => undefined);
  }

  async play(bounds: AppSnapScreenBounds | null | undefined): Promise<boolean> {
    if (this.#disposed || this.#options.platform !== "win32") return false;
    if (!this.#options.shouldShow()) return false;
    if (!bounds) return false;

    const dipBounds = this.#options.toDipBounds ? this.#options.toDipBounds(bounds) : bounds;
    const displayBounds = this.#options.getDisplayBounds?.(dipBounds) ?? null;
    const targetBounds = normalizeCaptureOverlayBounds(dipBounds, displayBounds);
    if (!targetBounds) return false;

    const overlayWindow = await this.#ensureWindow();
    if (!overlayWindow || overlayWindow.isDestroyed() || this.#disposed) return false;

    this.#clearHideTimer();
    overlayWindow.setBounds(targetBounds, false);
    const played = await overlayWindow.executePlay().catch(() => false);
    if (!played || overlayWindow.isDestroyed() || this.#disposed) {
      if (!overlayWindow.isDestroyed()) overlayWindow.hide();
      return false;
    }

    overlayWindow.showInactive();
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = null;
      if (this.#window && !this.#window.isDestroyed()) {
        this.#window.hide();
      }
    }, this.#hideAfterMs);
    this.#hideTimer.unref?.();

    if (this.#peakDelayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#peakDelayMs);
        timer.unref?.();
      });
    }
    return true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearHideTimer();
    const active = this.#window;
    this.#window = null;
    this.#creating = null;
    if (active && !active.isDestroyed()) {
      active.destroy();
    }
  }

  #clearHideTimer(): void {
    if (this.#hideTimer === null) return;
    clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }

  async #ensureWindow(): Promise<AppSnapCaptureOverlayWindowLike | null> {
    if (this.#disposed) return null;
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    if (this.#creating) return this.#creating;

    const creating = this.#options
      .createWindow(buildAppSnapCaptureOverlayDataUrl())
      .then((created) => {
        if (this.#disposed) {
          if (created && !created.isDestroyed()) created.destroy();
          return null;
        }
        this.#window = created;
        return created;
      })
      .catch(() => null)
      .finally(() => {
        if (this.#creating === creating) {
          this.#creating = null;
        }
      });

    this.#creating = creating;
    return creating;
  }
}
