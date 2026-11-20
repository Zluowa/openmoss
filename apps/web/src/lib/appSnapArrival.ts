// FILE: appSnapArrival.ts
// Purpose: Coordinates restrained Moss-style return-to-window and attachment entrance
//          animations for live AppSnap captures while respecting prefers-reduced-motion.
// Layer: Web UI motion helper

const RECENT_CAPTURE_TTL_MS = 1_500;
const WINDOW_RETURN_ANIMATION_CLASS = "appsnap-window-return";
const WINDOW_RETURN_FALLBACK_MS = 280;

const recentlyArrivedCaptures = new Map<string, number>();
let windowReturnCleanupTimer: ReturnType<typeof setTimeout> | null = null;
let activeWindowReturnTarget: HTMLElement | null = null;
let activeWindowReturnEndListener: (() => void) | null = null;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pruneExpiredCaptures(nowMs: number): void {
  for (const [id, expiresAt] of recentlyArrivedCaptures) {
    if (expiresAt <= nowMs) {
      recentlyArrivedCaptures.delete(id);
    }
  }
}

/** Marks a live AppSnap capture so its composer card plays a one-shot entrance transition. */
export function markAppSnapCaptureArrived(captureId: string, nowMs = Date.now()): void {
  if (captureId.trim().length === 0) return;
  pruneExpiredCaptures(nowMs);
  recentlyArrivedCaptures.set(captureId, nowMs + RECENT_CAPTURE_TTL_MS);
}

/** True only for freshly arrived live captures (never for hydrated drafts after reload). */
export function isRecentlyArrivedAppSnapCapture(
  captureId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!captureId) return false;
  const expiresAt = recentlyArrivedCaptures.get(captureId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= nowMs) {
    recentlyArrivedCaptures.delete(captureId);
    return false;
  }
  return true;
}

function clearWindowReturnAnimation(): void {
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
  if (typeof document === "undefined" || prefersReducedMotion()) {
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

/** Test-only reset for deterministic unit/browser suites. */
export function resetAppSnapArrivalStateForTests(): void {
  recentlyArrivedCaptures.clear();
  clearWindowReturnAnimation();
}
