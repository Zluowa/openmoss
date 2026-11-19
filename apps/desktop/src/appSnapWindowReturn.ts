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
  if (!window.isVisible()) {
    window.show();
  }
  if (options.platform === "darwin") {
    options.showApp?.();
    options.focusApp?.({ steal: true });
    window.focus();
    return;
  }
  if (options.platform === "win32") {
    window.moveTop?.();
    if (!window.isFocused() && !window.isAlwaysOnTop?.() && window.setAlwaysOnTop) {
      try {
        window.setAlwaysOnTop(true, "pop-up-menu");
        window.show();
        window.focus();
      } finally {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(false);
        }
      }
      return;
    }
    window.focus();
    return;
  }
  window.focus();
}
