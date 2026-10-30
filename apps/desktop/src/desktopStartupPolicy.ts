// FILE: desktopStartupPolicy.ts
// Purpose: Keeps explicit background launches on the normal startup path without taking focus.
// Layer: Desktop startup utility

/** Only the explicit standalone switch changes startup visibility. */
export function isBackgroundDesktopLaunch(argv: readonly string[]): boolean {
  return argv.includes("--background");
}

interface DesktopStartupWindow {
  center: () => void;
  maximize: () => void;
  show: () => void;
  showInactive: () => void;
}

export interface DesktopStartupShowOptions {
  readonly background?: boolean;
  readonly center?: boolean;
  readonly maximized?: boolean;
  /** Preserve the caller's existing foreground focus/restore behavior. */
  readonly focus?: () => void;
}

/** Shared by ready-to-show and the deferred renderer-load fallback. */
export function showDesktopStartupWindow(
  window: DesktopStartupWindow,
  options: DesktopStartupShowOptions = {},
): void {
  if (options.center) window.center();
  // Electron maximizes a hidden window without focusing it. Do this before the
  // final reveal so the background path never needs show(), restore() or focus().
  if (options.maximized) window.maximize();
  if (options.background) {
    window.showInactive();
  } else if (options.focus) {
    options.focus();
  } else {
    window.show();
  }
}

interface DesktopQuitConfirmationWindow extends DesktopStartupWindow {
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
}

/** Present the normal quit confirmation without activating a background launch. */
export function showDesktopQuitConfirmationWindow(
  window: DesktopQuitConfirmationWindow,
  options: Pick<DesktopStartupShowOptions, "background"> = {},
): void {
  showDesktopStartupWindow(window, {
    // An inactive reveal also preserves focus when Moss is already foreground.
    // Avoid a focus-state snapshot that could race a switch to another app.
    background: options.background === true,
    focus: () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  });
}

/** Background second-instance launches still deliver explicit auth callbacks. */
export function handleDesktopSecondInstance(
  argv: readonly string[],
  handlers: {
    readonly queueAuthCallback: (argv: readonly string[]) => void;
    readonly focusWindow: () => void;
  },
): void {
  handlers.queueAuthCallback(argv);
  if (!isBackgroundDesktopLaunch(argv)) handlers.focusWindow();
}
