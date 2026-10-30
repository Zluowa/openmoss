// FILE: bootstrapPaint.ts
// Purpose: Lets the static startup shell paint before the full React module graph loads.

type RequestFrame = (callback: FrameRequestCallback) => number;
type BootstrapImage = Pick<HTMLImageElement, "decode">;
type MinimumVisibilityWait = () => Promise<void>;

const waitForMinimumBootstrapVisibility: MinimumVisibilityWait = () =>
  new Promise((resolve) => {
    window.setTimeout(resolve, 120);
  });

/**
 * Two animation frames guarantee that one compositor paint can happen between
 * callbacks. This keeps a cold desktop/Vite transform from presenting an empty
 * native window while the main application module graph is still loading.
 */
export async function waitForBootstrapPaint(
  requestFrame: RequestFrame = window.requestAnimationFrame.bind(window),
  image: BootstrapImage | null = document.querySelector<HTMLImageElement>(
    "img.app-boot-splash__icon",
  ),
  waitForMinimumVisibility: MinimumVisibilityWait = waitForMinimumBootstrapVisibility,
): Promise<void> {
  try {
    await image?.decode();
  } catch {
    // A missing/corrupt optional splash must not prevent the application from
    // opening. The two-frame boundary still gives fallback CSS a chance to paint.
  }

  await new Promise<void>((resolve) => {
    requestFrame(() => {
      requestFrame(() => resolve());
    });
  });
  // Electron may execute hidden-window rAF callbacks before WindowServer has
  // retained a visible compositor frame. Keep the self-contained mark present
  // briefly after that boundary before the heavy module graph can block paint.
  await waitForMinimumVisibility();
}
