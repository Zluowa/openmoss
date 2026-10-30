export const RIGHT_DOCK_DEFAULT_WIDTH = 600;
export const RIGHT_DOCK_MIN_WIDTH = 320;
export const RIGHT_DOCK_WIDTH_STORAGE_KEY = "app-shell:right-panel-width:v3";

const RIGHT_DOCK_ADAPTIVE_MAIN_CONTENT_RESERVE = 500;
const RIGHT_DOCK_ADAPTIVE_MAX_WIDTH = 640;
const RIGHT_DOCK_ADAPTIVE_HEIGHT_MULTIPLIER = 16 / 10;
const RIGHT_DOCK_REGULAR_MAIN_CONTENT_MIN_WIDTH = 352;

export type RightDockWidthMode = "regular" | "full";

export function resolveAdaptiveRightDockDefaultWidth(input: {
  defaultWidth: number;
  mainContentWidth: number;
  shellHeight: number;
}): number {
  if (input.defaultWidth !== RIGHT_DOCK_DEFAULT_WIDTH) {
    return input.defaultWidth;
  }

  return Math.max(
    RIGHT_DOCK_MIN_WIDTH,
    Math.min(
      input.shellHeight * RIGHT_DOCK_ADAPTIVE_HEIGHT_MULTIPLIER,
      input.mainContentWidth - RIGHT_DOCK_ADAPTIVE_MAIN_CONTENT_RESERVE,
    ),
    Math.min(
      RIGHT_DOCK_ADAPTIVE_MAX_WIDTH,
      input.mainContentWidth - RIGHT_DOCK_REGULAR_MAIN_CONTENT_MIN_WIDTH,
    ),
  );
}

function resolveRightDockAvailableWidth(
  mainContentWidth: number,
  widthMode: RightDockWidthMode,
): number {
  return widthMode === "full"
    ? Math.max(RIGHT_DOCK_MIN_WIDTH, mainContentWidth)
    : Math.max(RIGHT_DOCK_MIN_WIDTH, mainContentWidth - RIGHT_DOCK_REGULAR_MAIN_CONTENT_MIN_WIDTH);
}

export function resolveRightDockWidthBounds(
  mainContentWidth: number,
  widthMode: RightDockWidthMode,
): { minimum: number; maximum: number } {
  const maximum = resolveRightDockAvailableWidth(mainContentWidth, widthMode);
  return {
    maximum,
    minimum: Math.min(RIGHT_DOCK_MIN_WIDTH, maximum),
  };
}

export function clampRightDockWidth(
  width: number,
  mainContentWidth: number,
  widthMode: RightDockWidthMode = "regular",
): number {
  const candidate = Number.isFinite(width) ? width : RIGHT_DOCK_DEFAULT_WIDTH;
  const maximum = resolveRightDockAvailableWidth(mainContentWidth, widthMode);
  return Math.max(Math.min(RIGHT_DOCK_MIN_WIDTH, maximum), Math.min(candidate, maximum));
}

function clampRatio(ratio: number): number {
  return Math.max(0, Math.min(1, ratio));
}

export function normalizeRightDockWidth(
  width: number,
  mainContentWidth: number,
  widthMode: RightDockWidthMode = "regular",
): number {
  const bounds = resolveRightDockWidthBounds(mainContentWidth, widthMode);
  const range = bounds.maximum - bounds.minimum;
  if (range === 0) {
    return 0;
  }

  return clampRatio(
    (clampRightDockWidth(width, mainContentWidth, widthMode) - bounds.minimum) / range,
  );
}

export function resolveRightDockWidthFromRatio(
  ratio: number,
  mainContentWidth: number,
  widthMode: RightDockWidthMode = "regular",
): number {
  const bounds = resolveRightDockWidthBounds(mainContentWidth, widthMode);
  return clampRightDockWidth(
    bounds.minimum + clampRatio(ratio) * (bounds.maximum - bounds.minimum),
    mainContentWidth,
    widthMode,
  );
}

export function resolvePersistedRightDockWidthRatio(input: {
  storedValue: number | null;
  defaultWidth: number;
  mainContentWidth: number;
  shellHeight: number;
  widthMode: RightDockWidthMode;
}): number {
  if (input.storedValue !== null && Number.isFinite(input.storedValue)) {
    return input.storedValue <= 1
      ? clampRatio(input.storedValue)
      : normalizeRightDockWidth(input.storedValue, input.mainContentWidth, input.widthMode);
  }

  return normalizeRightDockWidth(
    resolveAdaptiveRightDockDefaultWidth(input),
    input.mainContentWidth,
    input.widthMode,
  );
}
