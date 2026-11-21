// FILE: appSnapWindowReturn.ts
// Purpose: Reliably restores and focuses Moss's main window when returning from an AppSnap capture.
// Layer: Desktop main-process helper (pure)

export interface AppSnapReturnWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  isFocused(): boolean;
  focus(): void;
  moveTop?(): void;
  isAlwaysOnTop?(): boolean;
  setAlwaysOnTop?(flag: boolean, level?: "normal" | "floating" | "pop-up-menu"): void;
}

export interface AppSnapWindowReturnOptions {
  readonly platform: NodeJS.Platform;
  readonly showApp?: () => void;
  readonly focusApp?: (options: { steal: boolean }) => void;
}

/**
 * Brings the Moss main window reliably to the foreground after an explicit
 * global AppSnap gesture. On Windows, plain `focus()` often only flashes the
 * taskbar when another application owns focus; toggling topmost briefly forces
 * foreground activation while restoring the window's original topmost flag.
 */
export function bringMainWindowToFrontForAppSnap(
  window: AppSnapReturnWindowLike,
  options: AppSnapWindowReturnOptions,
): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) {
    window.restore();
  }
  if (options.platform === "win32") {
    const needsForegroundLift =
      !window.isFocused() && !window.isAlwaysOnTop?.() && Boolean(window.setAlwaysOnTop);
    if (needsForegroundLift && window.setAlwaysOnTop) {
      try {
        // Elevate z-order BEFORE the single show() so a hidden/occluded window
        // surfaces directly to the foreground without flashing behind the
        // captured app for a frame.
        window.setAlwaysOnTop(true, "pop-up-menu");
        if (!window.isVisible()) {
          window.show();
        }
        window.moveTop?.();
        window.focus();
      } finally {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(false);
        }
      }
      return;
    }
    if (!window.isVisible()) {
      window.show();
    }
    window.moveTop?.();
    window.focus();
    return;
  }
  if (!window.isVisible()) {
    window.show();
  }
  if (options.platform === "darwin") {
    options.showApp?.();
    options.focusApp?.({ steal: true });
    window.focus();
    return;
  }
  window.focus();
}
