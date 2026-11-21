// FILE: appSnapArrival.ts
// Purpose: Coordinates GPU-composited return-to-window, fly-to-composer, and attachment
//          settle animations for live AppSnap captures while respecting prefers-reduced-motion.
// Layer: Web UI motion helper

export const APP_SNAP_WINDOW_RETURN_MS = 220;
export const APP_SNAP_FLIGHT_DURATION_MS = 240;
export const APP_SNAP_SETTLE_DURATION_MS = 210;

const RECENT_CAPTURE_TTL_MS = 2_000;
const WINDOW_RETURN_ANIMATION_CLASS = "appsnap-window-return";
const WINDOW_RETURN_FALLBACK_MS = 280;
const VISIBILITY_WAIT_CAP_MS = 180;
const IMAGE_DECODE_CAP_MS = 45;
const FLIGHT_SAFETY_BUFFER_MS = 400;

export type AppSnapCaptureMotionPhase = "idle" | "entering" | "flying" | "settling";

export interface AppSnapSourceWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AppSnapFlightPayload {
  readonly captureId: string;
  readonly previewUrl: string;
  readonly appName: string;
  readonly windowTitle: string | null;
  readonly appIconDataUrl: string | null;
  readonly sourceWindowBounds: AppSnapSourceWindowBounds | null;
  readonly withReturnVeil: boolean;
}

export interface AppSnapFlightRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface AppSnapFlightVector {
  readonly startDx: number;
  readonly startDy: number;
  readonly startScale: number;
  readonly midDx: number;
  readonly midDy: number;
  readonly midScale: number;
  readonly durationMs: number;
}

interface LiveCaptureArrivalRecord {
  readonly expiresAt: number;
  readonly withReturnVeil: boolean;
}

const recentlyArrivedCaptures = new Map<string, LiveCaptureArrivalRecord>();
const settlingCaptures = new Map<string, number>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const arrivalListeners = new Set<() => void>();

let activeFlight: AppSnapFlightPayload | null = null;
let activeFlightFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let windowReturnCleanupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWindowReturnCancel: (() => void) | null = null;
let activeWindowReturnTarget: HTMLElement | null = null;
let activeWindowReturnEndListener: (() => void) | null = null;

function emitArrivalChange(): void {
  for (const listener of arrivalListeners) {
    listener();
  }
}

export function prefersAppSnapReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pruneExpiredCaptures(nowMs: number): void {
  for (const [id, record] of recentlyArrivedCaptures) {
    if (record.expiresAt <= nowMs) {
      recentlyArrivedCaptures.delete(id);
    }
  }
  for (const [id, expiresAt] of settlingCaptures) {
    if (expiresAt <= nowMs) {
      settlingCaptures.delete(id);
    }
  }
}

/** Subscribe to live AppSnap flight and settle phase transitions (`useSyncExternalStore`). */
export function subscribeAppSnapArrival(listener: () => void): () => void {
  arrivalListeners.add(listener);
  return () => {
    arrivalListeners.delete(listener);
  };
}

/** Snapshot of the currently flying live AppSnap preview, or `null` when idle. */
export function getActiveAppSnapFlight(): AppSnapFlightPayload | null {
  return activeFlight;
}

/** Marks a live AppSnap capture so its composer card plays a one-shot entrance transition. */
export function markAppSnapCaptureArrived(
  captureId: string,
  nowMs = Date.now(),
  options: { readonly withReturnVeil?: boolean } = {},
): void {
  if (captureId.trim().length === 0) return;
  pruneExpiredCaptures(nowMs);
  recentlyArrivedCaptures.set(captureId, {
    expiresAt: nowMs + RECENT_CAPTURE_TTL_MS,
    withReturnVeil: options.withReturnVeil ?? false,
  });
  emitArrivalChange();
}

/** True only for freshly arrived live captures (never for hydrated drafts after reload). */
export function isRecentlyArrivedAppSnapCapture(
  captureId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!captureId) return false;
  const record = recentlyArrivedCaptures.get(captureId);
  if (record === undefined) return false;
  if (record.expiresAt <= nowMs) {
    recentlyArrivedCaptures.delete(captureId);
    return false;
  }
  return true;
}

export function shouldUseAppSnapReturnVeil(captureId: string | null | undefined): boolean {
  if (!captureId) return false;
  return recentlyArrivedCaptures.get(captureId)?.withReturnVeil === true;
}

/**
 * Resolves the live motion phase for a specific AppSnap chip in the composer:
 * - `"flying"`: the GPU flight card is gliding toward this chip's reserved box.
 * - `"settling"`: the flight card just landed; play the tactile settle cushion + sheen.
 * - `"entering"`: freshly arrived live capture without an active flight overlay.
 * - `"idle"`: hydrated or settled attachment (zero motion).
 */
export function getAppSnapCaptureMotionPhase(
  captureId: string | null | undefined,
  nowMs = Date.now(),
): AppSnapCaptureMotionPhase {
  if (!captureId || prefersAppSnapReducedMotion()) return "idle";
  if (activeFlight?.captureId === captureId) return "flying";
  const settleUntil = settlingCaptures.get(captureId);
  if (settleUntil !== undefined) {
    if (settleUntil > nowMs) return "settling";
    settlingCaptures.delete(captureId);
  }
  if (isRecentlyArrivedAppSnapCapture(captureId, nowMs)) return "entering";
  return "idle";
}

function clearActiveFlightTimer(): void {
  if (activeFlightFallbackTimer !== null) {
    clearTimeout(activeFlightFallbackTimer);
    activeFlightFallbackTimer = null;
  }
}

/**
 * Computes pure GPU-composited FLIP transform offsets from an upper-viewport
 * preview launch point down into the exact composer attachment chip rect.
 */
export function computeAppSnapFlightVector(input: {
  readonly targetRect: AppSnapFlightRect;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly sourceWindowBounds?: AppSnapSourceWindowBounds | null;
  readonly screenWidth?: number;
}): AppSnapFlightVector {
  const viewportWidth = Math.max(320, input.viewport.width);
  const viewportHeight = Math.max(240, input.viewport.height);
  const targetCenterX = input.targetRect.left + input.targetRect.width / 2;
  const targetCenterY = input.targetRect.top + input.targetRect.height / 2;

  let originX = viewportWidth * 0.5;
  if (
    input.sourceWindowBounds &&
    input.sourceWindowBounds.width > 0 &&
    Number.isFinite(input.sourceWindowBounds.x)
  ) {
    const referenceScreenWidth = Math.max(
      viewportWidth,
      input.screenWidth ?? input.sourceWindowBounds.x + input.sourceWindowBounds.width,
    );
    const normalizedCenter = Math.min(
      1,
      Math.max(
        0,
        (input.sourceWindowBounds.x + input.sourceWindowBounds.width / 2) / referenceScreenWidth,
      ),
    );
    const horizontalBias = (normalizedCenter - 0.5) * viewportWidth * 0.34;
    originX = Math.min(
      viewportWidth * 0.72,
      Math.max(viewportWidth * 0.28, viewportWidth * 0.5 + horizontalBias),
    );
  }

  const minGlideUp = Math.min(180, viewportHeight * 0.26);
  const preferredOriginY = Math.min(targetCenterY - minGlideUp, viewportHeight * 0.3);
  const originY = Math.max(84, Math.min(targetCenterY - 96, preferredOriginY));

  const startDx = Math.round(originX - targetCenterX);
  const startDy = Math.round(originY - targetCenterY);
  const startScale = 1.52;

  return {
    startDx,
    startDy,
    startScale,
    midDx: Math.round(startDx * 0.74),
    midDy: Math.round(startDy * 0.78),
    midScale: 1.34,
    durationMs: APP_SNAP_FLIGHT_DURATION_MS,
  };
}

/**
 * Waits until the document is visible and one paint frame has ticked so return
 * animations never fire and finish invisibly while Windows DWM is still raising
 * an occluded or minimized Moss window.
 */
export function waitForAppSnapVisibleFrame(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();

  const waitVisible =
    document.visibilityState === "hidden"
      ? new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisibility);
            resolve();
          };
          const onVisibility = () => {
            if (document.visibilityState !== "hidden") finish();
          };
          const timer = setTimeout(finish, VISIBILITY_WAIT_CAP_MS);
          document.addEventListener("visibilitychange", onVisibility);
        })
      : Promise.resolve();

  return waitVisible.then(
    () =>
      new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          resolve();
        }
      }),
  );
}

/**
 * Pre-decodes the captured blob preview URL off the main paint path (bounded so
 * it never stalls) so the flying thumbnail renders crisp pixels on frame 1.
 */
export function predecodeAppSnapPreview(previewUrl: string): Promise<void> {
  if (typeof Image === "undefined" || previewUrl.length === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, IMAGE_DECODE_CAP_MS);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = previewUrl;
      if (typeof image.decode === "function") {
        void image.decode().then(finish, finish);
      } else {
        finish();
      }
    } catch {
      finish();
    }
  });
}

/** Starts a live GPU-composited fly-to-composer animation for a newly attached AppSnap. */
export function launchAppSnapFlight(payload: AppSnapFlightPayload): boolean {
  if (typeof document === "undefined" || prefersAppSnapReducedMotion()) {
    return false;
  }
  if (payload.captureId.trim().length === 0 || payload.previewUrl.trim().length === 0) {
    return false;
  }
  clearActiveFlightTimer();
  activeFlight = payload;
  activeFlightFallbackTimer = setTimeout(() => {
    completeAppSnapFlight(payload.captureId);
  }, APP_SNAP_FLIGHT_DURATION_MS + FLIGHT_SAFETY_BUFFER_MS);
  emitArrivalChange();
  return true;
}

/** Completes the flight for `captureId` and triggers the chip's tactile settle phase. */
export function completeAppSnapFlight(captureId: string): void {
  const wasActive = activeFlight?.captureId === captureId;
  if (wasActive) {
    clearActiveFlightTimer();
    activeFlight = null;
  }
  recentlyArrivedCaptures.delete(captureId);

  if (wasActive && !prefersAppSnapReducedMotion()) {
    const existingTimer = settleTimers.get(captureId);
    if (existingTimer) clearTimeout(existingTimer);
    settlingCaptures.set(captureId, Date.now() + APP_SNAP_SETTLE_DURATION_MS + 40);
    const timer = setTimeout(() => {
      settleTimers.delete(captureId);
      settlingCaptures.delete(captureId);
      emitArrivalChange();
    }, APP_SNAP_SETTLE_DURATION_MS + 40);
    settleTimers.set(captureId, timer);
  }
  emitArrivalChange();
}

function clearPendingWindowReturn(): void {
  pendingWindowReturnCancel?.();
  pendingWindowReturnCancel = null;
}

function clearWindowReturnAnimation(): void {
  clearPendingWindowReturn();
  if (windowReturnCleanupTimer !== null) {
    clearTimeout(windowReturnCleanupTimer);
    windowReturnCleanupTimer = null;
  }
  if (activeWindowReturnTarget && activeWindowReturnEndListener) {
    activeWindowReturnTarget.removeEventListener("animationend", activeWindowReturnEndListener);
  }
  activeWindowReturnTarget?.classList.remove(WINDOW_RETURN_ANIMATION_CLASS);
  activeWindowReturnTarget = null;
  activeWindowReturnEndListener = null;
}

/**
 * Plays a one-shot, GPU-composited reveal on the Moss root container when a
 * global AppSnap capture brings Moss back to the foreground. Cleans up its
 * class immediately on animationend so no transform stacking context lingers.
 */
export function triggerAppSnapWindowReturnAnimation(): boolean {
  if (typeof document === "undefined" || prefersAppSnapReducedMotion()) {
    return false;
  }
  const target = document.getElementById("root") ?? document.body;
  if (!target) return false;

  clearWindowReturnAnimation();
  // Restart cleanly if two captures arrive back-to-back.
  void target.offsetWidth;
  target.classList.add(WINDOW_RETURN_ANIMATION_CLASS);
  activeWindowReturnTarget = target;
  const onEnd = () => {
    clearWindowReturnAnimation();
  };
  activeWindowReturnEndListener = onEnd;
  target.addEventListener("animationend", onEnd, { once: true });
  windowReturnCleanupTimer = setTimeout(clearWindowReturnAnimation, WINDOW_RETURN_FALLBACK_MS);
  return true;
}

/**
 * Defers the window-return reveal until the window is actually visible on
 * screen when returning from an occluded/minimized state on Windows, so the
 * animation is seen by the user rather than played off-screen.
 */
export function scheduleAppSnapWindowReturnAnimation(): void {
  if (typeof document === "undefined" || prefersAppSnapReducedMotion()) {
    return;
  }
  clearPendingWindowReturn();
  if (document.visibilityState !== "hidden") {
    triggerAppSnapWindowReturnAnimation();
    return;
  }
  let cancelled = false;
  pendingWindowReturnCancel = () => {
    cancelled = true;
  };
  void waitForAppSnapVisibleFrame().then(() => {
    if (cancelled) return;
    pendingWindowReturnCancel = null;
    triggerAppSnapWindowReturnAnimation();
  });
}

/** Test-only reset for deterministic unit/browser suites. */
export function resetAppSnapArrivalStateForTests(): void {
  recentlyArrivedCaptures.clear();
  settlingCaptures.clear();
  for (const timer of settleTimers.values()) {
    clearTimeout(timer);
  }
  settleTimers.clear();
  clearActiveFlightTimer();
  activeFlight = null;
  clearWindowReturnAnimation();
  emitArrivalChange();
}
