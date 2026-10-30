// FILE: composerCodexPowerSliderGeometry.ts
// Purpose: Pure geometry for the compact Codex power slider. The 28px thumb travels
//   inside a 24px track, so every percent position is corrected by an inset that keeps
//   the thumb 1px past the track edge at both ends. Ticks, the blue range fill, and
//   the pointer-to-index mapping all share this correction so they stay aligned.
// Layer: Chat composer presentation (no React)

export const POWER_SLIDER_THUMB_SIZE_PX = 28;
export const POWER_SLIDER_TRACK_HEIGHT_PX = 24;
/** How far the thumb may overhang the track at either end. */
export const POWER_SLIDER_THUMB_OVERHANG_PX = 1;
export const POWER_SLIDER_THUMB_INSET_PX =
  POWER_SLIDER_THUMB_SIZE_PX / 2 - POWER_SLIDER_THUMB_OVERHANG_PX;

/** Wheel pixels needed to move one step and the idle gap that resets accumulation. */
export const POWER_SLIDER_WHEEL_STEP_PX = 30;
export const POWER_SLIDER_WHEEL_RESET_MS = 160;
/** Pointer hold time or travel distance that reveals the Faster/Smarter endpoints. */
export const POWER_SLIDER_ENDPOINT_HOLD_MS = 150;
export const POWER_SLIDER_ENDPOINT_MOVE_PX = 4;
export const POWER_SLIDER_THUMB_PRESSED_SCALE = 32 / 28;

export function clampPowerIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}

export function powerIndexToPercent(index: number, count: number): number {
  const last = count - 1;
  if (last <= 0) return 0;
  return (Math.max(0, Math.min(index, last)) / last) * 100;
}

/**
 * Pixel correction applied to a percent position so the thumb center stays inside the
 * track: +13px at 0%, 0px at 50%, -13px at 100%.
 */
export function powerThumbInsetPx(percent: number): number {
  return POWER_SLIDER_THUMB_INSET_PX - (percent / 50) * POWER_SLIDER_THUMB_INSET_PX;
}

/** `left` for the visual thumb and for every tick. */
export function powerThumbLeft(percent: number): string {
  return `calc(${percent}% + ${powerThumbInsetPx(percent)}px)`;
}

/**
 * Ticks near the ends are pulled inward by the same inset, scaled down toward the
 * middle of the scale so interior ticks keep their exact percent positions.
 */
function powerTickInsetPx(percent: number, lastIndex: number): number {
  if (lastIndex <= 0) return 0;
  const stepPercent = 100 / lastIndex;
  const weight = Math.min(percent / stepPercent, (100 - percent) / stepPercent, 1);
  return powerThumbInsetPx(percent) * weight;
}

/**
 * The range fill is a full-width layer translated left so its trailing edge sits under
 * the thumb center. `scale` lets the same math drive a slightly shorter overlay.
 */
export function powerRangeTransform(percent: number, lastIndex: number, scale = 1): string {
  if (lastIndex <= 0) return `translateX(${-100 * scale}%)`;
  const inset = powerTickInsetPx(percent, lastIndex);
  return `translateX(calc(${(percent - 100) * scale}% + ${inset * scale}px))`;
}

/** Clip path for a layer that should only show up to the thumb center. */
export function powerRangeClipPath(percent: number, lastIndex: number): string {
  const inset = powerTickInsetPx(percent, lastIndex);
  return `inset(0 calc(${100 - percent}% - ${inset}px) 0 0)`;
}

/**
 * Maps a pointer x-position over the slider root to the nearest choice index. The
 * usable travel excludes half a thumb at each end, matching where the thumb can be.
 */
export function powerIndexFromPointer(
  clientX: number,
  rootLeft: number,
  rootWidth: number,
  count: number,
): number {
  const last = count - 1;
  if (last <= 0 || rootWidth <= 0) return 0;
  const half = POWER_SLIDER_THUMB_SIZE_PX / 2;
  const travel = Math.max(1, rootWidth - POWER_SLIDER_THUMB_SIZE_PX);
  const ratio = (clientX - rootLeft - half) / travel;
  return clampPowerIndex(ratio * last, count);
}

export type PowerWheelAccumulator = {
  accumulatedDelta: number;
  lastEventTime: number;
};

export function createPowerWheelAccumulator(): PowerWheelAccumulator {
  return { accumulatedDelta: 0, lastEventTime: 0 };
}

export type PowerWheelInput = {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly timeStamp: number;
  readonly pixelDelta: boolean;
  readonly invertedFromDevice: boolean;
};

/**
 * Accumulates wheel travel and returns the step direction once a full step has been
 * reached, or 0 when the event should be absorbed. Horizontal travel wins when it is
 * larger, vertical scroll-up moves the slider right, and device inversion is honored.
 */
export function consumePowerWheel(
  accumulator: PowerWheelAccumulator,
  input: PowerWheelInput,
): -1 | 0 | 1 {
  let raw = Math.abs(input.deltaX) > Math.abs(input.deltaY) ? input.deltaX : -input.deltaY;
  if (input.invertedFromDevice) raw *= -1;
  const delta = input.pixelDelta ? raw : Math.sign(raw) * POWER_SLIDER_WHEEL_STEP_PX;
  if (delta === 0) return 0;
  if (
    input.timeStamp - accumulator.lastEventTime > POWER_SLIDER_WHEEL_RESET_MS ||
    Math.sign(delta) !== Math.sign(accumulator.accumulatedDelta)
  ) {
    accumulator.accumulatedDelta = 0;
  }
  accumulator.lastEventTime = input.timeStamp;
  accumulator.accumulatedDelta += delta;
  if (Math.abs(accumulator.accumulatedDelta) < POWER_SLIDER_WHEEL_STEP_PX) return 0;
  const direction = Math.sign(accumulator.accumulatedDelta) as -1 | 1;
  accumulator.accumulatedDelta -= direction * POWER_SLIDER_WHEEL_STEP_PX;
  return direction;
}
