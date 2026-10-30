// FILE: realtimeVoiceOverlay.ts
// Purpose: Owns the fail-closed state, geometry, and static document for the desktop voice overlay.
// Layer: Electron overlay support

import type {
  DesktopRealtimeVoiceOverlayAudioSignal,
  DesktopRealtimeVoiceOverlayCommand,
  DesktopRealtimeVoiceOverlayCommandRequest,
  DesktopRealtimeVoiceOverlayHandoff,
  DesktopRealtimeVoiceOverlayPresentation,
  DesktopRealtimeVoiceOverlayPublication,
  DesktopRealtimeVoiceOverlaySnapshot,
  RealtimeVoiceActivity,
  RealtimeVoicePhase,
} from "@synara/contracts";
import {
  REALTIME_VOICE_ORB_FRAGMENT_SHADER_SOURCE,
  REALTIME_VOICE_ORB_VERTEX_SHADER_SOURCE,
} from "@synara/shared/realtimeVoiceOrbShader";

export const REALTIME_VOICE_OVERLAY_PRELOAD_ARGUMENT = "--moss-realtime-voice-overlay";
export const REALTIME_VOICE_OVERLAY_SESSION_PARTITION = "moss-realtime-voice-overlay";
/** Build 5973 keeps active, native-composition, and older setup geometry distinct. */
export const REALTIME_VOICE_OVERLAY_VIEWPORTS = {
  compact: { width: 356, height: 320 },
  native: { width: 384, height: 400 },
  legacySetup: { width: 408, height: 400 },
} as const;
export const REALTIME_VOICE_OVERLAY_SIZE = REALTIME_VOICE_OVERLAY_VIEWPORTS.compact;
export const REALTIME_VOICE_OVERLAY_ORB_SIZE = { width: 112, height: 112 } as const;
/**
 * The current native compact overlay has four explicit attachment quadrants.
 * `top-*` means the activity tray attaches above the orb, so the orb itself
 * occupies the lower row. Build 5973's live global voice presentation is
 * `top-start`: its 112px alpha bounds start at (20,176) inside 356x320.
 */
export type DesktopRealtimeVoiceOverlayPlacement =
  | "top-start"
  | "top-end"
  | "bottom-start"
  | "bottom-end";

export const REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE = "avatar-overlay-layout-changed" as const;
export const REALTIME_VOICE_OVERLAY_POINTER_DRAG_IPC_CHANNEL =
  "desktop:realtime-voice-overlay-pointer-drag" as const;
export const REALTIME_VOICE_OVERLAY_DRAG_THRESHOLD_PX = 4;
export const REALTIME_VOICE_OVERLAY_RELEASE_SAMPLE_WINDOW_MS = 100;
export const REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPAN_MS = 16;
export const REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPEED_PX_PER_SECOND = 320;
export const REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND = 1_600;

export const REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES = {
  "top-start": {
    slot: { left: 20, top: 176, width: 112, height: 121 },
    controlsHitRegion: { left: 9, top: 243, width: 94, height: 38 },
    orbCenterOffset: { x: 76, y: 232 },
  },
  "top-end": {
    slot: { left: 224, top: 176, width: 112, height: 121 },
    controlsHitRegion: { left: 213, top: 243, width: 94, height: 38 },
    orbCenterOffset: { x: 280, y: 232 },
  },
  "bottom-start": {
    slot: { left: 20, top: 32, width: 112, height: 121 },
    controlsHitRegion: { left: 9, top: 99, width: 94, height: 38 },
    orbCenterOffset: { x: 76, y: 88 },
  },
  "bottom-end": {
    slot: { left: 224, top: 32, width: 112, height: 121 },
    controlsHitRegion: { left: 213, top: 99, width: 94, height: 38 },
    orbCenterOffset: { x: 280, y: 88 },
  },
} as const satisfies Record<
  DesktopRealtimeVoiceOverlayPlacement,
  DesktopRealtimeVoiceOverlayGeometry
>;

export const REALTIME_VOICE_OVERLAY_PLACEMENT = "top-start" as const;
export const REALTIME_VOICE_OVERLAY_SLOT =
  REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES[REALTIME_VOICE_OVERLAY_PLACEMENT].slot;
export const REALTIME_VOICE_OVERLAY_ORB_CENTER_OFFSET = {
  ...REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES[REALTIME_VOICE_OVERLAY_PLACEMENT].orbCenterOffset,
} as const;
/**
 * Maximum attached-pill hit region across its -16px to -20px reveal motion.
 * Width includes three 28px controls, two 2px gaps, 2px padding, and a 1px border.
 */
export const REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION =
  REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES[REALTIME_VOICE_OVERLAY_PLACEMENT].controlsHitRegion;
/** Static non-active layouts; never infer these from the active compact slot. */
export const REALTIME_VOICE_OVERLAY_STATIC_GEOMETRIES = {
  native: {
    slot: { left: 244, top: 207, width: 112, height: 121 },
    controlsHitRegion: { left: 233, top: 274, width: 94, height: 38 },
    orbCenterOffset: { x: 300, y: 263 },
  },
  legacySetup: {
    slot: { left: 268, top: 271, width: 112, height: 121 },
    controlsHitRegion: { left: 257, top: 338, width: 94, height: 38 },
    orbCenterOffset: { x: 324, y: 327 },
  },
} as const;
export const REALTIME_VOICE_OVERLAY_WORK_AREA_MARGIN = 16;

const REALTIME_VOICE_PHASES = new Set<RealtimeVoicePhase>([
  "inactive",
  "reserving",
  "presenting",
  "starting",
  "active",
  "stopping",
  "failed",
]);
const REALTIME_VOICE_ACTIVITIES = new Set<RealtimeVoiceActivity>([
  "listening",
  "thinking",
  "speaking",
]);
const REALTIME_VOICE_OVERLAY_COMMANDS = new Set<DesktopRealtimeVoiceOverlayCommand>([
  "toggle",
  "stop",
  "focus",
  "handoff",
  "toggle-input-mute",
  "toggle-output-mute",
]);

export interface DesktopRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopPoint {
  readonly x: number;
  readonly y: number;
}

export type DesktopRealtimeVoiceOverlayPointerDragEvent =
  | {
      readonly type: "avatar-overlay-drag-start";
      readonly pointerId: number;
      readonly pointerScreenX: number;
      readonly pointerScreenY: number;
      readonly pointerWindowX: number;
      readonly pointerWindowY: number;
    }
  | {
      readonly type: "avatar-overlay-drag-move" | "avatar-overlay-drag-end";
      readonly pointerId: number;
      readonly pointerScreenX: number;
      readonly pointerScreenY: number;
    }
  | {
      readonly type: "avatar-overlay-drag-release";
      readonly velocityX: number;
      readonly velocityY: number;
    };

export interface DesktopRealtimeVoiceOverlayPointerSample {
  readonly screenX: number;
  readonly screenY: number;
  readonly timeMs: number;
}

export interface DesktopRealtimeVoiceOverlayGeometry {
  readonly slot: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly controlsHitRegion: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly orbCenterOffset: DesktopPoint;
}

function isDesktopRealtimeVoiceOverlayPlacement(
  value: unknown,
): value is DesktopRealtimeVoiceOverlayPlacement {
  return (
    value === "top-start" ||
    value === "top-end" ||
    value === "bottom-start" ||
    value === "bottom-end"
  );
}

function isBoundedOverlayPointerCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
}

export function normalizeDesktopRealtimeVoiceOverlayPointerDragEvent(
  value: unknown,
): DesktopRealtimeVoiceOverlayPointerDragEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "avatar-overlay-drag-start" &&
    candidate.type !== "avatar-overlay-drag-move" &&
    candidate.type !== "avatar-overlay-drag-end" &&
    candidate.type !== "avatar-overlay-drag-release"
  ) {
    return null;
  }
  if (candidate.type === "avatar-overlay-drag-release") {
    if (
      typeof candidate.velocityX !== "number" ||
      !Number.isFinite(candidate.velocityX) ||
      typeof candidate.velocityY !== "number" ||
      !Number.isFinite(candidate.velocityY) ||
      Math.hypot(candidate.velocityX, candidate.velocityY) >
        REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND + Number.EPSILON
    ) {
      return null;
    }
    return {
      type: candidate.type,
      velocityX: candidate.velocityX,
      velocityY: candidate.velocityY,
    };
  }
  if (
    typeof candidate.pointerId !== "number" ||
    !Number.isSafeInteger(candidate.pointerId) ||
    candidate.pointerId < 0 ||
    !isBoundedOverlayPointerCoordinate(candidate.pointerScreenX) ||
    !isBoundedOverlayPointerCoordinate(candidate.pointerScreenY)
  ) {
    return null;
  }
  if (candidate.type === "avatar-overlay-drag-start") {
    if (
      !isBoundedOverlayPointerCoordinate(candidate.pointerWindowX) ||
      !isBoundedOverlayPointerCoordinate(candidate.pointerWindowY)
    ) {
      return null;
    }
    return {
      type: candidate.type,
      pointerId: candidate.pointerId,
      pointerScreenX: candidate.pointerScreenX,
      pointerScreenY: candidate.pointerScreenY,
      pointerWindowX: candidate.pointerWindowX,
      pointerWindowY: candidate.pointerWindowY,
    };
  }
  return {
    type: candidate.type,
    pointerId: candidate.pointerId,
    pointerScreenX: candidate.pointerScreenX,
    pointerScreenY: candidate.pointerScreenY,
  };
}

/** Reconstructs Codex's bounded release fling from the most recent pointer samples. */
export function resolveDesktopRealtimeVoiceOverlayReleaseVelocity(
  samples: readonly DesktopRealtimeVoiceOverlayPointerSample[],
): DesktopPoint | null {
  const latest = samples.at(-1);
  if (
    !latest ||
    !Number.isFinite(latest.screenX) ||
    !Number.isFinite(latest.screenY) ||
    !Number.isFinite(latest.timeMs)
  ) {
    return null;
  }
  const oldest = samples.find(
    (sample) =>
      Number.isFinite(sample.screenX) &&
      Number.isFinite(sample.screenY) &&
      Number.isFinite(sample.timeMs) &&
      latest.timeMs - sample.timeMs <= REALTIME_VOICE_OVERLAY_RELEASE_SAMPLE_WINDOW_MS &&
      latest.timeMs - sample.timeMs > REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPAN_MS,
  );
  if (!oldest) return null;
  const elapsedSeconds = (latest.timeMs - oldest.timeMs) / 1_000;
  const velocity = {
    x: (latest.screenX - oldest.screenX) / elapsedSeconds,
    y: (latest.screenY - oldest.screenY) / elapsedSeconds,
  };
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed < REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPEED_PX_PER_SECOND) return null;
  if (speed <= REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND) return velocity;
  const scale = REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND / speed;
  return { x: velocity.x * scale, y: velocity.y * scale };
}

/** Selects only measured static layouts; unknown viewport sizes stay fully click-through. */
export function resolveDesktopRealtimeVoiceOverlayGeometry(
  viewport: Pick<DesktopRectangle, "width" | "height"> = REALTIME_VOICE_OVERLAY_SIZE,
  placement: DesktopRealtimeVoiceOverlayPlacement = REALTIME_VOICE_OVERLAY_PLACEMENT,
): DesktopRealtimeVoiceOverlayGeometry | null {
  if (
    viewport.width === REALTIME_VOICE_OVERLAY_VIEWPORTS.compact.width &&
    viewport.height === REALTIME_VOICE_OVERLAY_VIEWPORTS.compact.height
  ) {
    return REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES[placement] ?? null;
  }
  if (
    viewport.width === REALTIME_VOICE_OVERLAY_VIEWPORTS.native.width &&
    viewport.height === REALTIME_VOICE_OVERLAY_VIEWPORTS.native.height
  ) {
    return REALTIME_VOICE_OVERLAY_STATIC_GEOMETRIES.native;
  }
  if (
    viewport.width === REALTIME_VOICE_OVERLAY_VIEWPORTS.legacySetup.width &&
    viewport.height === REALTIME_VOICE_OVERLAY_VIEWPORTS.legacySetup.height
  ) {
    return REALTIME_VOICE_OVERLAY_STATIC_GEOMETRIES.legacySetup;
  }
  return null;
}

/**
 * Codex names the quadrant for the attachment direction: an orb in the lower
 * half uses `top-*` because its tray attaches above it.
 */
export function resolveDesktopRealtimeVoiceOverlayPlacement(
  orbCenter: DesktopPoint,
  workArea: DesktopRectangle,
): DesktopRealtimeVoiceOverlayPlacement {
  const vertical = orbCenter.y < workArea.y + workArea.height / 2 ? "bottom" : "top";
  const horizontal = orbCenter.x < workArea.x + workArea.width / 2 ? "start" : "end";
  const placement = `${vertical}-${horizontal}`;
  return isDesktopRealtimeVoiceOverlayPlacement(placement)
    ? placement
    : REALTIME_VOICE_OVERLAY_PLACEMENT;
}

/** Keeps the dragged orb under the pointer while its 356x320 viewport flips quadrants. */
export function resolveDesktopRealtimeVoiceOverlayDragLayout(input: {
  readonly pointerScreenPoint: DesktopPoint;
  readonly pointerOffsetInOrb: DesktopPoint;
  readonly workArea: DesktopRectangle;
}): {
  readonly bounds: DesktopRectangle;
  readonly placement: DesktopRealtimeVoiceOverlayPlacement;
} {
  const workRight = input.workArea.x + Math.max(1, input.workArea.width);
  const workBottom = input.workArea.y + Math.max(1, input.workArea.height);
  const maximumOrbX = Math.max(input.workArea.x, workRight - REALTIME_VOICE_OVERLAY_SLOT.width);
  const maximumOrbY = Math.max(input.workArea.y, workBottom - REALTIME_VOICE_OVERLAY_SLOT.height);
  const orbX = Math.min(
    maximumOrbX,
    Math.max(input.workArea.x, Math.round(input.pointerScreenPoint.x - input.pointerOffsetInOrb.x)),
  );
  const orbY = Math.min(
    maximumOrbY,
    Math.max(input.workArea.y, Math.round(input.pointerScreenPoint.y - input.pointerOffsetInOrb.y)),
  );
  const placement = resolveDesktopRealtimeVoiceOverlayPlacement(
    {
      x: orbX + REALTIME_VOICE_OVERLAY_SLOT.width / 2,
      y: orbY + REALTIME_VOICE_OVERLAY_SLOT.height / 2,
    },
    input.workArea,
  );
  const geometry = REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES[placement];
  const maximumWindowX = Math.max(input.workArea.x, workRight - REALTIME_VOICE_OVERLAY_SIZE.width);
  const maximumWindowY = Math.max(
    input.workArea.y,
    workBottom - REALTIME_VOICE_OVERLAY_SIZE.height,
  );
  return {
    placement,
    bounds: {
      x: Math.min(maximumWindowX, Math.max(input.workArea.x, orbX - geometry.slot.left)),
      y: Math.min(maximumWindowY, Math.max(input.workArea.y, orbY - geometry.slot.top)),
      ...REALTIME_VOICE_OVERLAY_SIZE,
    },
  };
}

function isDesktopPointInsideRectangle(
  point: DesktopPoint,
  rectangle: Pick<DesktopRectangle, "x" | "y" | "width" | "height">,
): boolean {
  return (
    point.x >= rectangle.x &&
    point.x <= rectangle.x + rectangle.width &&
    point.y >= rectangle.y &&
    point.y <= rectangle.y + rectangle.height
  );
}

/** Shared renderer/main-process hit contract for the otherwise transparent viewport. */
export function isDesktopRealtimeVoiceOverlayInteractivePoint(
  point: DesktopPoint,
  viewport: Pick<DesktopRectangle, "width" | "height"> = REALTIME_VOICE_OVERLAY_SIZE,
  placement: DesktopRealtimeVoiceOverlayPlacement = REALTIME_VOICE_OVERLAY_PLACEMENT,
): boolean {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    point.x < 0 ||
    point.y < 0 ||
    point.x > viewport.width ||
    point.y > viewport.height
  ) {
    return false;
  }
  const geometry = resolveDesktopRealtimeVoiceOverlayGeometry(viewport, placement);
  if (geometry === null) return false;
  const slot = {
    x: geometry.slot.left,
    y: geometry.slot.top,
    width: geometry.slot.width,
    height: geometry.slot.height,
  };
  const controls = {
    x: geometry.controlsHitRegion.left,
    y: geometry.controlsHitRegion.top,
    width: geometry.controlsHitRegion.width,
    height: geometry.controlsHitRegion.height,
  };
  return (
    isDesktopPointInsideRectangle(point, slot) || isDesktopPointInsideRectangle(point, controls)
  );
}

export function isDesktopRealtimeVoiceOverlayInteractiveScreenPoint(
  point: DesktopPoint,
  windowBounds: DesktopRectangle,
  placement: DesktopRealtimeVoiceOverlayPlacement = REALTIME_VOICE_OVERLAY_PLACEMENT,
): boolean {
  return isDesktopRealtimeVoiceOverlayInteractivePoint(
    { x: point.x - windowBounds.x, y: point.y - windowBounds.y },
    windowBounds,
    placement,
  );
}

function normalizeDesktopRealtimeVoiceOverlayAudioSignal(
  value: unknown,
): DesktopRealtimeVoiceOverlayAudioSignal | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const channels = [candidate.low, candidate.mid, candidate.high, candidate.overall];
  if (
    channels.some(
      (channel) =>
        typeof channel !== "number" || !Number.isFinite(channel) || channel < 0 || channel > 1,
    )
  ) {
    return undefined;
  }
  return {
    low: candidate.low as number,
    mid: candidate.mid as number,
    high: candidate.high as number,
    overall: candidate.overall as number,
  };
}

export function isDesktopRealtimeVoiceOverlayCommand(
  value: unknown,
): value is DesktopRealtimeVoiceOverlayCommand {
  return (
    typeof value === "string" &&
    REALTIME_VOICE_OVERLAY_COMMANDS.has(value as DesktopRealtimeVoiceOverlayCommand)
  );
}

export function normalizeDesktopRealtimeVoiceOverlayCommandRequest(
  value: unknown,
): DesktopRealtimeVoiceOverlayCommandRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isDesktopRealtimeVoiceOverlayCommand(candidate.command) ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 ||
    typeof candidate.generation !== "number" ||
    !Number.isSafeInteger(candidate.generation) ||
    candidate.generation < 0
  ) {
    return null;
  }
  return {
    command: candidate.command,
    revision: candidate.revision,
    generation: candidate.generation,
  };
}

/**
 * Treat `undefined` as invalid input and `null` as the explicit hide command.
 * The error is bounded because it crosses into a long-lived always-on-top UI.
 */
export function normalizeDesktopRealtimeVoiceOverlaySnapshot(
  value: unknown,
): DesktopRealtimeVoiceOverlaySnapshot | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;

  const candidate = value as Record<string, unknown>;
  const audioSignal = normalizeDesktopRealtimeVoiceOverlayAudioSignal(candidate.audioSignal);
  if (
    typeof candidate.phase !== "string" ||
    !REALTIME_VOICE_PHASES.has(candidate.phase as RealtimeVoicePhase) ||
    (candidate.activity !== null &&
      (typeof candidate.activity !== "string" ||
        !REALTIME_VOICE_ACTIVITIES.has(candidate.activity as RealtimeVoiceActivity))) ||
    typeof candidate.inputMuted !== "boolean" ||
    typeof candidate.outputMuted !== "boolean" ||
    (candidate.error !== null && typeof candidate.error !== "string")
  ) {
    return undefined;
  }

  const normalizedError =
    typeof candidate.error === "string"
      ? candidate.error.trim().replaceAll(/\s+/gu, " ").slice(0, 300) || null
      : null;
  const snapshot: DesktopRealtimeVoiceOverlaySnapshot = {
    phase: candidate.phase as RealtimeVoicePhase,
    activity: candidate.activity as RealtimeVoiceActivity | null,
    inputMuted: candidate.inputMuted,
    outputMuted: candidate.outputMuted,
    error: normalizedError,
  };
  if ("audioSignal" in candidate) {
    if (audioSignal === undefined) return undefined;
    return { ...snapshot, audioSignal };
  }
  return snapshot;
}

export function normalizeDesktopRealtimeVoiceOverlayPublication(
  value: unknown,
): DesktopRealtimeVoiceOverlayPublication | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const snapshot = normalizeDesktopRealtimeVoiceOverlaySnapshot(candidate.snapshot);
  const handoff = normalizeDesktopRealtimeVoiceOverlayHandoff(candidate.handoff);
  if (
    snapshot === undefined ||
    handoff === undefined ||
    typeof candidate.mediaOwnerActive !== "boolean"
  ) {
    return null;
  }
  return { snapshot, mediaOwnerActive: candidate.mediaOwnerActive, handoff };
}

function isBoundedFiniteNumber(value: unknown, maximumAbsoluteValue: number): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= maximumAbsoluteValue
  );
}

export function normalizeDesktopRealtimeVoiceOverlayHandoff(
  value: unknown,
): DesktopRealtimeVoiceOverlayHandoff | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sequence !== "number" ||
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence < 1 ||
    (candidate.from !== "main-thread" && candidate.from !== "global-overlay")
  ) {
    return undefined;
  }

  let origin: DesktopRealtimeVoiceOverlayHandoff["origin"] = null;
  if (candidate.origin !== null) {
    if (typeof candidate.origin !== "object" || candidate.origin === null) return undefined;
    const input = candidate.origin as Record<string, unknown>;
    if (
      !isBoundedFiniteNumber(input.centerX, 10_000_000) ||
      !isBoundedFiniteNumber(input.centerY, 10_000_000) ||
      !isBoundedFiniteNumber(input.width, 10_000) ||
      input.width <= 0 ||
      !isBoundedFiniteNumber(input.height, 10_000) ||
      input.height <= 0
    ) {
      return undefined;
    }
    origin = {
      centerX: input.centerX,
      centerY: input.centerY,
      width: input.width,
      height: input.height,
    };
  }

  let velocity: DesktopRealtimeVoiceOverlayHandoff["velocity"] = null;
  if (candidate.velocity !== null) {
    if (typeof candidate.velocity !== "object" || candidate.velocity === null) return undefined;
    const input = candidate.velocity as Record<string, unknown>;
    if (!isBoundedFiniteNumber(input.x, 100_000) || !isBoundedFiniteNumber(input.y, 100_000)) {
      return undefined;
    }
    velocity = { x: input.x, y: input.y };
  }

  return {
    sequence: candidate.sequence,
    from: candidate.from,
    origin,
    velocity,
  };
}

export function shouldShowDesktopRealtimeVoiceOverlay(
  snapshot: DesktopRealtimeVoiceOverlaySnapshot | null,
): boolean {
  return snapshot !== null && snapshot.phase !== "inactive";
}

/** The hidden main renderer owns WebRTC even when presentation is handed off. */
export function shouldThrottleDesktopRealtimeVoiceOwner(
  presentation: Pick<DesktopRealtimeVoiceOverlayPresentation, "mediaOwnerActive">,
): boolean {
  return !presentation.mediaOwnerActive;
}

/**
 * Accept state churn within one visible media generation, but never commands
 * from before the overlay was most recently shown or from a future revision.
 */
export function isDesktopRealtimeVoiceOverlayCommandRequestCurrent(
  request: DesktopRealtimeVoiceOverlayCommandRequest,
  presentation: Pick<DesktopRealtimeVoiceOverlayPresentation, "generation" | "revision">,
  visibleRevisionFloor: number | null,
): boolean {
  return (
    visibleRevisionFloor !== null &&
    request.generation === presentation.generation &&
    request.revision >= visibleRevisionFloor &&
    request.revision <= presentation.revision
  );
}

/** Anchors the compact surface inside the selected display's bottom-right work area. */
export function resolveDesktopRealtimeVoiceOverlayBounds(
  workArea: DesktopRectangle,
  requestedSize: { readonly width: number; readonly height: number } = REALTIME_VOICE_OVERLAY_SIZE,
  requestedMargin = REALTIME_VOICE_OVERLAY_WORK_AREA_MARGIN,
): DesktopRectangle {
  const workWidth = Math.max(1, Math.floor(workArea.width));
  const workHeight = Math.max(1, Math.floor(workArea.height));
  const width = Math.min(workWidth, Math.max(1, Math.floor(requestedSize.width)));
  const height = Math.min(workHeight, Math.max(1, Math.floor(requestedSize.height)));
  const availableX = Math.max(0, workWidth - width);
  const availableY = Math.max(0, workHeight - height);
  const margin = Math.max(0, Math.floor(requestedMargin));
  return {
    x: Math.floor(workArea.x) + availableX - Math.min(margin, availableX),
    y: Math.floor(workArea.y) + availableY - Math.min(margin, availableY),
    width,
    height,
  };
}

export function resolveDesktopRealtimeVoiceOverlayHandoffStartBounds(
  origin: NonNullable<DesktopRealtimeVoiceOverlayHandoff["origin"]>,
  size: { readonly width: number; readonly height: number } = REALTIME_VOICE_OVERLAY_SIZE,
  orbCenterOffset: {
    readonly x: number;
    readonly y: number;
  } = REALTIME_VOICE_OVERLAY_ORB_CENTER_OFFSET,
): DesktopRectangle {
  return {
    x: Math.round(origin.centerX - orbCenterOffset.x),
    y: Math.round(origin.centerY - orbCenterOffset.y),
    width: size.width,
    height: size.height,
  };
}

export function resolveDesktopRealtimeVoiceOverlayHandoffTargetBounds(
  origin: NonNullable<DesktopRealtimeVoiceOverlayHandoff["origin"]>,
  resolveWorkArea: (point: { readonly x: number; readonly y: number }) => DesktopRectangle,
): DesktopRectangle {
  return resolveDesktopRealtimeVoiceOverlayBounds(
    resolveWorkArea({ x: origin.centerX, y: origin.centerY }),
  );
}

/** Cubic Hermite motion keeps the release velocity continuous into the native panel. */
export function resolveDesktopRealtimeVoiceOverlayHandoffPosition(input: {
  readonly from: Pick<DesktopRectangle, "x" | "y">;
  readonly to: Pick<DesktopRectangle, "x" | "y">;
  readonly velocity: DesktopRealtimeVoiceOverlayHandoff["velocity"];
  readonly progress: number;
  readonly durationMs: number;
}): { readonly x: number; readonly y: number } {
  const progress = Math.min(1, Math.max(0, input.progress));
  const squared = progress * progress;
  const cubed = squared * progress;
  const startWeight = 2 * cubed - 3 * squared + 1;
  const tangentWeight = cubed - 2 * squared + progress;
  const endWeight = -2 * cubed + 3 * squared;
  const durationSeconds = Math.max(0, input.durationMs) / 1_000;
  const velocityX = (input.velocity?.x ?? 0) * durationSeconds;
  const velocityY = (input.velocity?.y ?? 0) * durationSeconds;
  return {
    x: Math.round(startWeight * input.from.x + tangentWeight * velocityX + endWeight * input.to.x),
    y: Math.round(startWeight * input.from.y + tangentWeight * velocityY + endWeight * input.to.y),
  };
}

/** Process-lifetime revision source used for initial-load and reload replay. */
export class DesktopRealtimeVoiceOverlayStateModel {
  #presentation: DesktopRealtimeVoiceOverlayPresentation = {
    revision: 0,
    generation: 0,
    mediaOwnerActive: false,
    handoff: null,
    snapshot: null,
  };

  get current(): DesktopRealtimeVoiceOverlayPresentation {
    return this.#presentation;
  }

  update(value: unknown): DesktopRealtimeVoiceOverlayPresentation | null {
    const publication = normalizeDesktopRealtimeVoiceOverlayPublication(value);
    if (publication === null) return null;
    const revision =
      this.#presentation.revision >= Number.MAX_SAFE_INTEGER ? 1 : this.#presentation.revision + 1;
    const generation =
      publication.mediaOwnerActive && !this.#presentation.mediaOwnerActive
        ? this.#presentation.generation >= Number.MAX_SAFE_INTEGER
          ? 1
          : this.#presentation.generation + 1
        : this.#presentation.generation;
    this.#presentation = { revision, generation, ...publication };
    return this.#presentation;
  }
}

export interface DesktopRealtimeVoiceOwnerPendingMessages {
  readonly toggle: boolean;
  readonly commands: readonly {
    readonly command: DesktopRealtimeVoiceOverlayCommand;
    readonly handoff: DesktopRealtimeVoiceOverlayHandoff | null;
  }[];
}

/** Binds deferred overlay commands to one process-owned media generation. */
export class DesktopRealtimeVoiceOwnerMessageBuffer {
  readonly #subscriptions = new Set<"toggle" | "command">();
  #toggle = false;
  #commands: Array<{
    readonly command: DesktopRealtimeVoiceOverlayCommand;
    readonly generation: number;
    readonly revision: number;
    readonly handoff: DesktopRealtimeVoiceOverlayHandoff | null;
  }> = [];

  subscribe(kind: "toggle" | "command"): void {
    this.#subscriptions.add(kind);
  }

  unsubscribe(kind: "toggle" | "command"): void {
    this.#subscriptions.delete(kind);
  }

  hasSubscription(kind: "toggle" | "command"): boolean {
    return this.#subscriptions.has(kind);
  }

  queueToggle(): void {
    this.#toggle = !this.#toggle;
  }

  queueCommand(
    command: DesktopRealtimeVoiceOverlayCommand,
    generation: number,
    revision: number,
    handoff: DesktopRealtimeVoiceOverlayHandoff | null = null,
  ): void {
    this.#commands.push({ command, generation, revision, handoff });
    if (this.#commands.length > 16) this.#commands.shift();
  }

  clearOverlayCommands(): void {
    this.#commands = [];
  }

  resetForOwnerReload(options: { readonly preserveToggle?: boolean } = {}): void {
    this.#subscriptions.clear();
    if (!options.preserveToggle) this.#toggle = false;
    this.#commands = [];
  }

  drain(
    currentGeneration: number,
    visibleRevisionFloor: number,
    currentRevision: number,
  ): DesktopRealtimeVoiceOwnerPendingMessages {
    const toggle = this.#subscriptions.has("toggle") && this.#toggle;
    if (toggle) this.#toggle = false;
    const commands = this.#subscriptions.has("command")
      ? this.#commands
          .filter(
            (entry) =>
              entry.generation === currentGeneration &&
              entry.revision >= visibleRevisionFloor &&
              entry.revision <= currentRevision,
          )
          .map(({ command, handoff }) => ({ command, handoff }))
      : [];
    if (this.#subscriptions.has("command")) this.#commands = [];
    return { toggle, commands };
  }
}

/**
 * A constant data document keeps the auxiliary renderer independent from the
 * app router and local WebSocket transport. Its preload exposes one narrow IPC
 * bridge and no `desktopBridge`/`nativeApi` object.
 */
export interface DesktopRealtimeVoiceOverlayDocumentOptions {
  /** Freezes animation for screenshot/render-contract tests only. */
  readonly deterministicTimeMs?: number;
}

export function buildDesktopRealtimeVoiceOverlayUrl(
  options: DesktopRealtimeVoiceOverlayDocumentOptions = {},
): string {
  const deterministicTimeMs =
    typeof options.deterministicTimeMs === "number" &&
    Number.isFinite(options.deterministicTimeMs) &&
    options.deterministicTimeMs >= 0 &&
    options.deterministicTimeMs <= 3_600_000
      ? options.deterministicTimeMs
      : null;
  const vertexShaderSource = JSON.stringify(REALTIME_VOICE_ORB_VERTEX_SHADER_SOURCE);
  const fragmentShaderSource = JSON.stringify(REALTIME_VOICE_ORB_FRAGMENT_SHADER_SOURCE);
  const compactPlacementGeometries = JSON.stringify(REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES);
  const interactiveHitRegions = JSON.stringify([
    {
      x: REALTIME_VOICE_OVERLAY_SLOT.left,
      y: REALTIME_VOICE_OVERLAY_SLOT.top,
      width: REALTIME_VOICE_OVERLAY_SLOT.width,
      height: REALTIME_VOICE_OVERLAY_SLOT.height,
    },
    {
      x: REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION.left,
      y: REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION.top,
      width: REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION.width,
      height: REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION.height,
    },
  ]);
  const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; media-src 'none'; img-src 'none'" />
  <meta name="color-scheme" content="light dark" />
  <title>Moss Realtime Voice</title>
  <style>
    :root {
      color-scheme: light dark;
      --overlay-control-bg: rgba(255,255,255,.86);
      --overlay-control-border: rgba(255,255,255,.75);
      --overlay-control-fg: #202020;
      --overlay-control-hover-bg: rgba(255,255,255,.96);
      --overlay-control-pressed-bg: rgba(32,32,32,.12);
      --overlay-focus: rgba(51,156,255,.7);
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { color: #202020; }
    .surface {
      position: relative; width: 100%; height: 100%;
      animation: handoff-in 280ms cubic-bezier(.22,1,.36,1) 24ms both;
    }
    .orb-slot {
      position: absolute; top: ${REALTIME_VOICE_OVERLAY_SLOT.top}px; left: ${REALTIME_VOICE_OVERLAY_SLOT.left}px;
      width: ${REALTIME_VOICE_OVERLAY_SLOT.width}px; height: ${REALTIME_VOICE_OVERLAY_SLOT.height}px;
    }
    .orb-button {
      position: absolute; top: 0; left: 0; width: ${REALTIME_VOICE_OVERLAY_ORB_SIZE.width}px;
      height: ${REALTIME_VOICE_OVERLAY_ORB_SIZE.height}px; margin: 0; padding: 0;
      overflow: visible; border: 0; border-radius: 50%; background: transparent; cursor: pointer;
      touch-action: none; user-select: none; -webkit-user-select: none;
    }
    .orb-canvas {
      position: absolute; top: -20px; left: -20px; display: block; width: 152px; height: 152px;
      max-width: none; pointer-events: none;
      filter: drop-shadow(0 0 3px rgb(154 154 249 / 55%));
      transition: opacity 90ms ease-out;
    }
    .orb-button[data-renderer="css"]::before {
      content: ""; position: absolute; inset: 12px; border-radius: 50%;
      background: linear-gradient(155deg,#0181fe 5%,#a4efff 54%,#fffdef 96%);
    }
    .controls {
      position: absolute; left: 50%; bottom: 0; display: flex; gap: 2px; padding: 2px;
      margin-left: -20px; border: 1px solid transparent; border-radius: 999px;
      background: transparent; box-shadow: none;
      backdrop-filter: none; -webkit-backdrop-filter: none;
      transform: translateX(-50%) translateY(-16px); opacity: 0; filter: blur(1px); pointer-events: none;
      transition: opacity 90ms ease-out, filter 120ms ease-out, transform 280ms cubic-bezier(.22,1,.36,1);
    }
    .orb-slot:hover .controls, .orb-slot:focus-within .controls,
    body[data-pointer-interactive="true"] .controls {
      opacity: 1; filter: blur(0); pointer-events: auto; transform: translateX(-50%) translateY(-20px);
    }
    body:not([data-phase="active"]) .controls {
      opacity: 1; filter: blur(0); pointer-events: auto; transform: translateX(-50%) translateY(-20px);
    }
    .control {
      display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
      border: 1px solid var(--overlay-control-border); border-radius: 999px;
      background: var(--overlay-control-bg); color: var(--overlay-control-fg); cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,.2);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    }
    .control svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
    .control:hover { background: var(--overlay-control-hover-bg); }
    .control:active { transform: translateY(1px); }
    .control:focus-visible, .orb-button:focus-visible { outline: 2px solid var(--overlay-focus); outline-offset: 1px; }
    .control:disabled { cursor: wait; opacity: .6; }
    .control[aria-pressed="true"] { background: var(--overlay-control-pressed-bg); }
    body:not([data-phase="active"]) .mute-control { display: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    @keyframes handoff-in { from { opacity: 0; filter: blur(2px); transform: translateY(-8px) scale(.96); } }
    @media (prefers-color-scheme: dark) { :root { --overlay-control-bg: rgba(32,32,32,.86); --overlay-control-border: rgba(255,255,255,.2); --overlay-control-fg: #f7f7f7; --overlay-control-hover-bg: rgba(45,45,45,.94); --overlay-control-pressed-bg: rgba(255,255,255,.14); } body { color: #f7f7f7; } }
    @media (prefers-reduced-motion: reduce) { .surface { animation: none !important; } .controls, .orb-canvas { transition: none; } .control:active { transform: none; } }
    @media (prefers-reduced-transparency: reduce) { .control { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; } }
    @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) { .control { background: #202020; } }
    @media (forced-colors: active) { .orb-button { border: 3px solid Highlight; } .orb-canvas { opacity: 0; filter: none; } .orb-button[data-renderer="css"]::before { display: none; } .control { border: 1px solid ButtonText; background: ButtonFace; color: ButtonText; box-shadow: none; forced-color-adjust: auto; } .stop { background: Highlight; color: HighlightText; } .control:focus-visible, .orb-button:focus-visible { outline-color: Highlight; } }
  </style>
</head>
<body data-phase="starting" data-activity="thinking">
  <main class="surface" role="region" aria-label="Moss Realtime Voice controls">
    <div class="orb-slot" data-overlay-hit-region="voice">
      <button type="button" class="orb-button" data-command="handoff" aria-label="Open Realtime Voice in the Moss task">
        <canvas class="orb-canvas" width="152" height="152" aria-hidden="true"></canvas>
      </button>
      <div class="controls" data-overlay-hit-region="controls" aria-label="Voice actions">
        <button type="button" class="control mute-control" data-command="toggle-output-mute" aria-label="Mute voice output" aria-pressed="false">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3z"/><path d="M13 7.2c1.5 1.5 1.5 4.1 0 5.6"/></svg>
        </button>
        <button type="button" class="control mute-control" data-command="toggle-input-mute" aria-label="Mute microphone" aria-pressed="false">
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="3" width="6" height="9" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7.5 17.5h5"/></svg>
        </button>
        <button type="button" class="control stop" data-command="stop" aria-label="End Realtime Voice">
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>
    </div>
    <div id="status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">Connecting voice chat</div>
    <div id="detail" class="sr-only">Voice remains connected during task handoff</div>
  </main>
  <script>
    (() => {
      "use strict";
      const vertexShaderSource = ${vertexShaderSource};
      const fragmentShaderSource = ${fragmentShaderSource};
      const configuredTimeMs = ${deterministicTimeMs === null ? "null" : String(deterministicTimeMs)};
      const frameIntervalMs = 1000 / 30;
      const placementGeometries = ${compactPlacementGeometries};
      const defaultPlacement = ${JSON.stringify(REALTIME_VOICE_OVERLAY_PLACEMENT)};
      const layoutChangedType = ${JSON.stringify(REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE)};
      const dragThresholdPx = ${REALTIME_VOICE_OVERLAY_DRAG_THRESHOLD_PX};
      const releaseSampleWindowMs = ${REALTIME_VOICE_OVERLAY_RELEASE_SAMPLE_WINDOW_MS};
      const releaseMinSpanMs = ${REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPAN_MS};
      const releaseMinSpeed = ${REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPEED_PX_PER_SECOND};
      const releaseMaxSpeed = ${REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND};
      let interactiveHitRegions = ${interactiveHitRegions};
      const bridge = window.realtimeVoiceOverlay;
      const surface = document.querySelector(".surface");
      const orbSlot = document.querySelector(".orb-slot");
      const orbButton = document.querySelector(".orb-button");
      const canvas = document.querySelector(".orb-canvas");
      const status = document.getElementById("status");
      const detail = document.getElementById("detail");
      const buttons = Array.from(document.querySelectorAll("button[data-command]"));
      const inputMute = document.querySelector('[data-command="toggle-input-mute"]');
      const outputMute = document.querySelector('[data-command="toggle-output-mute"]');
      let pointerInteractive = false;
      let lastPointerPoint = null;
      let placement = defaultPlacement;
      let orbPointerDrag = null;
      let revision = -1;
      let generation = 0;
      let snapshot = { phase: "starting", activity: "thinking", inputMuted: false, outputMuted: false, error: null };
      let latestHandoffSequence = 0;
      let animationFrame = 0;
      let lastScheduledTimeMs = 0;
      let lastFrameTimeSeconds = 0;
      let manualTimeMs = configuredTimeMs;
      let state = { listen: 0, speak: 0, think: 1 };
      let audio = new Float32Array(4);
      let cumulativeAudio = new Float32Array(4);
      let micLevel = 0;
      let outputLevel = 0;
      let gl = null;
      let program = null;
      let uniforms = null;
      let fallbackContext = null;
      const setPlacement = (nextPlacement) => {
        const geometry = placementGeometries[nextPlacement];
        if (!geometry) return false;
        placement = nextPlacement;
        document.body.dataset.placement = placement;
        orbSlot.style.left = geometry.slot.left + "px";
        orbSlot.style.top = geometry.slot.top + "px";
        interactiveHitRegions = [
          {
            x: geometry.slot.left,
            y: geometry.slot.top,
            width: geometry.slot.width,
            height: geometry.slot.height,
          },
          {
            x: geometry.controlsHitRegion.left,
            y: geometry.controlsHitRegion.top,
            width: geometry.controlsHitRegion.width,
            height: geometry.controlsHitRegion.height,
          },
        ];
        reconcilePointerInteractivityAtLastPoint();
        return true;
      };
      const consumeAvatarOverlayLayoutChanged = (message) => {
        if (!message || message.type !== layoutChangedType || !message.layout) return;
        setPlacement(message.layout.placement);
      };
      const pointerSample = (event) => ({
        screenX: event.screenX,
        screenY: event.screenY,
        timeMs: event.timeStamp,
      });
      const trimPointerSamples = (samples) => {
        const latest = samples.at(-1);
        return latest
          ? samples.filter((sample) => latest.timeMs - sample.timeMs <= releaseSampleWindowMs)
          : samples;
      };
      const releaseVelocity = (samples) => {
        const latest = samples.at(-1);
        if (!latest) return null;
        const oldest = samples.find((sample) =>
          latest.timeMs - sample.timeMs <= releaseSampleWindowMs &&
          latest.timeMs - sample.timeMs > releaseMinSpanMs
        );
        if (!oldest) return null;
        const elapsedSeconds = (latest.timeMs - oldest.timeMs) / 1000;
        const velocity = {
          x: (latest.screenX - oldest.screenX) / elapsedSeconds,
          y: (latest.screenY - oldest.screenY) / elapsedSeconds,
        };
        const speed = Math.hypot(velocity.x, velocity.y);
        if (speed < releaseMinSpeed) return null;
        if (speed <= releaseMaxSpeed) return velocity;
        const scale = releaseMaxSpeed / speed;
        return { x: velocity.x * scale, y: velocity.y * scale };
      };
      const publishPointerInteractivity = (interactive) => {
        document.body.dataset.pointerInteractive = interactive ? "true" : "false";
        if (pointerInteractive === interactive) return;
        pointerInteractive = interactive;
        if (bridge && typeof bridge.setPointerInteractive === "function") {
          bridge.setPointerInteractive(interactive);
        }
      };
      const isInteractivePoint = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return interactiveHitRegions.some((region) =>
          x >= region.x && x <= region.x + region.width &&
          y >= region.y && y <= region.y + region.height
        );
      };
      const reconcilePointerInteractivity = (event) => {
        lastPointerPoint = { x: event.clientX, y: event.clientY };
        publishPointerInteractivity(isInteractivePoint(event.clientX, event.clientY));
      };
      const reconcilePointerInteractivityAtLastPoint = () => {
        publishPointerInteractivity(
          lastPointerPoint !== null && isInteractivePoint(lastPointerPoint.x, lastPointerPoint.y)
        );
      };
      const clamp01 = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      const smoothingFactor = (deltaSeconds, timeConstant) => {
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0;
        if (!Number.isFinite(timeConstant) || timeConstant <= 0) return 1;
        return 1 - Math.exp(-deltaSeconds / timeConstant);
      };
      const corePhase = (phase) => {
        if (phase === "reserving" || phase === "presenting" || phase === "starting") return "starting";
        if (phase === "active" || phase === "stopping") return phase;
        return "inactive";
      };
      const stateTargets = (value) => {
        const phase = corePhase(value.phase);
        if (phase === "inactive") return { listen: 0, speak: 0, think: 0 };
        if (phase === "starting") return { listen: 0, speak: 0, think: 1 };
        if (phase === "stopping") return { listen: .35, speak: 0, think: 0 };
        if (value.activity === "thinking") return { listen: .65, speak: 0, think: 1 };
        if (value.activity === "speaking") return { listen: .2, speak: 1, think: 0 };
        return { listen: 1, speak: 0, think: 0 };
      };
      const smoothstep = (edge0, edge1, value) => {
        const progress = clamp01((value - edge0) / (edge1 - edge0));
        return progress * progress * (3 - 2 * progress);
      };
      const syntheticAudio = (activity, timeSeconds) => {
        const level = activity === "speaking" ? .42 : 0;
        const slowPulse = smoothstep(.08, .72, Math.sin(timeSeconds * .78) * .5 + .5);
        const voicePulse = .58 + Math.sin(timeSeconds * 3.1 + .6) * .17 + Math.sin(timeSeconds * 4.2 + 2.1) * .12;
        const speaking = activity === "speaking" ? level * (.08 + slowPulse * Math.max(.24, voicePulse)) : 0;
        const overall = clamp01(speaking);
        return new Float32Array([
          overall * (.82 + Math.sin(timeSeconds * 1.1) * .14),
          overall * (.76 + Math.sin(timeSeconds * 1.5 + 1.2) * .16),
          overall * (.68 + Math.sin(timeSeconds * 1.9 + 2.1) * .18),
          overall,
        ]);
      };
      const compileShader = (context, type, source) => {
        const shader = context.createShader(type);
        if (!shader) return null;
        context.shaderSource(shader, source);
        context.compileShader(shader);
        if (context.getShaderParameter(shader, context.COMPILE_STATUS)) return shader;
        context.deleteShader(shader);
        return null;
      };
      const initializeRenderer = () => {
        try {
          gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, premultipliedAlpha: false });
        } catch {
          gl = null;
        }
        if (!gl) {
          try { fallbackContext = canvas.getContext("2d"); } catch { fallbackContext = null; }
          orbButton.dataset.renderer = fallbackContext ? "canvas2d" : "css";
          return;
        }
        const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
        program = gl.createProgram();
        if (!vertexShader || !fragmentShader || !program) {
          orbButton.dataset.renderer = "css";
          gl = null;
          program = null;
          return;
        }
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          orbButton.dataset.renderer = "css";
          gl = null;
          program = null;
          return;
        }
        const position = gl.getAttribLocation(program, "a_position");
        const buffer = gl.createBuffer();
        const locations = {
          audio: gl.getUniformLocation(program, "u_audio"),
          cumulativeAudio: gl.getUniformLocation(program, "u_cumulativeAudio"),
          micLevel: gl.getUniformLocation(program, "u_micLevel"),
          outputLevel: gl.getUniformLocation(program, "u_outputLevel"),
          resolution: gl.getUniformLocation(program, "u_resolution"),
          stateListen: gl.getUniformLocation(program, "u_stateListen"),
          stateSpeak: gl.getUniformLocation(program, "u_stateSpeak"),
          stateThink: gl.getUniformLocation(program, "u_stateThink"),
          time: gl.getUniformLocation(program, "u_time"),
        };
        if (position < 0 || !buffer || Object.values(locations).some((location) => location === null)) {
          orbButton.dataset.renderer = "css";
          gl = null;
          program = null;
          return;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
        gl.useProgram(program);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        uniforms = locations;
        orbButton.dataset.renderer = "webgl";
      };
      const resizeCanvas = () => {
        const ratio = Math.min(1.5, Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
        const width = Math.max(1, Math.round(152 * ratio));
        const height = Math.max(1, Math.round(152 * ratio));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      };
      const updateState = (deltaSeconds, deterministic) => {
        const target = stateTargets(snapshot);
        const smoothing = deterministic ? 1 : smoothingFactor(deltaSeconds, .28);
        state.listen += (target.listen - state.listen) * smoothing;
        state.speak += (target.speak - state.speak) * smoothing;
        state.think = Math.max(
          state.think + (target.think - state.think) * smoothing,
          corePhase(snapshot.phase) === "starting" ? .6 : 0,
        );
      };
      const normalizedSignal = () => {
        const signal = snapshot.audioSignal;
        if (!signal || corePhase(snapshot.phase) === "inactive") return null;
        const channels = [signal.low, signal.mid, signal.high, signal.overall];
        if (channels.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null;
        return channels;
      };
      const updateAudio = (deltaSeconds, timeSeconds, deterministic) => {
        const published = normalizedSignal();
        if (published) {
          const frameScale = deltaSeconds * 60;
          const longSmoothing = deterministic ? 1 : smoothingFactor(deltaSeconds, 2);
          for (let index = 0; index < 4; index += 1) {
            const level = published[index];
            const target = level * frameScale;
            audio[index] += (target - audio[index]) * longSmoothing;
            cumulativeAudio[index] += level * frameScale * 40 * longSmoothing;
          }
          const maximumLevel = Math.max(...published);
          const micSmoothing = deterministic ? 1 : smoothingFactor(deltaSeconds, maximumLevel > micLevel ? .12 : .32);
          const outputSmoothing = deterministic ? 1 : smoothingFactor(deltaSeconds, published[3] > outputLevel ? .09 : .3);
          micLevel += (maximumLevel - micLevel) * micSmoothing;
          outputLevel += (published[3] - outputLevel) * outputSmoothing;
          return;
        }
        const synthetic = syntheticAudio(snapshot.activity, timeSeconds);
        if (deterministic) {
          for (let index = 0; index < 4; index += 1) {
            audio[index] = synthetic[index];
            cumulativeAudio[index] = synthetic[index] * timeSeconds * 2.5;
          }
          micLevel = synthetic[3];
          outputLevel = synthetic[3];
          return;
        }
        for (let index = 0; index < 4; index += 1) {
          const target = synthetic[index];
          const smoothing = smoothingFactor(deltaSeconds, target > audio[index] ? .24 : .72);
          audio[index] += (target - audio[index]) * smoothing;
          cumulativeAudio[index] += audio[index] * deltaSeconds * (snapshot.activity === "speaking" ? 7 : 3.5);
        }
        const overall = synthetic[3];
        micLevel += (overall - micLevel) * smoothingFactor(deltaSeconds, overall > micLevel ? .26 : .8);
        outputLevel += (0 - outputLevel) * smoothingFactor(deltaSeconds, .3);
      };
      const renderCanvasFallback = (timeSeconds) => {
        if (!fallbackContext) return;
        const radius = Math.min(canvas.width, canvas.height) * .29;
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2 + Math.sin(timeSeconds * .36) * 1.5;
        fallbackContext.clearRect(0, 0, canvas.width, canvas.height);
        const gradient = fallbackContext.createLinearGradient(centerX - radius * .7, centerY - radius, centerX + radius * .55, centerY + radius);
        gradient.addColorStop(0, "rgba(1, 129, 254, 1)");
        gradient.addColorStop(.46, "rgba(164, 239, 255, 0.98)");
        gradient.addColorStop(1, "rgba(255, 253, 239, 0.98)");
        fallbackContext.fillStyle = gradient;
        fallbackContext.beginPath();
        fallbackContext.arc(centerX, centerY, radius * (1 + outputLevel * .12), 0, Math.PI * 2);
        fallbackContext.fill();
      };
      const render = (timeMs, deterministic) => {
        const timeSeconds = timeMs / 1000;
        const deltaSeconds = deterministic || lastFrameTimeSeconds === 0 ? .016 : Math.max(0, Math.min(.05, timeSeconds - lastFrameTimeSeconds));
        lastFrameTimeSeconds = timeSeconds;
        updateState(deltaSeconds, deterministic);
        updateAudio(deltaSeconds, timeSeconds, deterministic);
        resizeCanvas();
        if (!gl || !program || !uniforms) {
          renderCanvasFallback(timeSeconds);
          return;
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(program);
        gl.uniform1f(uniforms.time, timeSeconds);
        gl.uniform1f(uniforms.micLevel, micLevel);
        gl.uniform1f(uniforms.outputLevel, outputLevel);
        gl.uniform1f(uniforms.stateListen, state.listen);
        gl.uniform1f(uniforms.stateThink, state.think);
        gl.uniform1f(uniforms.stateSpeak, state.speak);
        gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
        gl.uniform4fv(uniforms.audio, audio);
        gl.uniform4fv(uniforms.cumulativeAudio, cumulativeAudio);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };
      const schedule = () => {
        if (animationFrame || manualTimeMs !== null) return;
        animationFrame = requestAnimationFrame(onAnimationFrame);
      };
      const onAnimationFrame = (timeMs) => {
        animationFrame = 0;
        if (lastScheduledTimeMs === 0 || timeMs - lastScheduledTimeMs >= frameIntervalMs) {
          lastScheduledTimeMs = timeMs;
          render(timeMs, false);
        }
        schedule();
      };
      const label = (snapshot) => {
        if (snapshot.phase === "reserving" || snapshot.phase === "presenting") return "Preparing voice chat";
        if (snapshot.phase === "starting") return "Connecting voice chat";
        if (snapshot.phase === "stopping") return "Ending voice chat";
        if (snapshot.phase === "failed") return "Voice chat needs attention";
        if (snapshot.activity === "speaking") return "Moss is speaking";
        if (snapshot.activity === "thinking") return "Moss is thinking";
        return "Moss is listening";
      };
      const apply = (presentation) => {
        if (!presentation || !Number.isSafeInteger(presentation.revision) || presentation.revision < revision) return;
        consumeAvatarOverlayLayoutChanged(presentation);
        revision = presentation.revision;
        generation = presentation.generation;
        const nextSnapshot = presentation.snapshot;
        if (!nextSnapshot) return;
        snapshot = nextSnapshot;
        document.body.dataset.phase = snapshot.phase;
        document.body.dataset.activity = snapshot.activity || "idle";
        status.textContent = label(snapshot);
        detail.textContent = snapshot.error || [snapshot.inputMuted ? "Microphone muted" : "Microphone on", snapshot.outputMuted ? "Output muted" : "Output on"].join(" · ");
        inputMute.setAttribute("aria-pressed", String(snapshot.inputMuted));
        inputMute.setAttribute("aria-label", snapshot.inputMuted ? "Unmute microphone" : "Mute microphone");
        outputMute.setAttribute("aria-pressed", String(snapshot.outputMuted));
        outputMute.setAttribute("aria-label", snapshot.outputMuted ? "Unmute voice output" : "Mute voice output");
        const handoff = presentation.handoff;
        if (handoff && Number.isSafeInteger(handoff.sequence) && handoff.sequence > latestHandoffSequence) {
          latestHandoffSequence = handoff.sequence;
          surface.style.animation = "none";
          void surface.offsetWidth;
          surface.style.animation = "";
        }
        if (manualTimeMs !== null) render(manualTimeMs, true);
      };
      initializeRenderer();
      resizeCanvas();
      setPlacement(defaultPlacement);
      window.addEventListener("mousemove", reconcilePointerInteractivity, { passive: true });
      window.addEventListener("resize", reconcilePointerInteractivityAtLastPoint, { passive: true });
      window.addEventListener("mouseleave", () => {
        lastPointerPoint = null;
        publishPointerInteractivity(false);
      });
      document.addEventListener("focusin", reconcilePointerInteractivityAtLastPoint);
      document.addEventListener("focusout", () => {
        window.requestAnimationFrame(reconcilePointerInteractivityAtLastPoint);
      });
      if (manualTimeMs !== null) render(manualTimeMs, true);
      else schedule();
      Object.defineProperty(window, "__mossRealtimeVoiceOverlayTest", {
        configurable: false,
        enumerable: false,
        value: Object.freeze({
          renderAt(timeMs) {
            if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 3600000) return false;
            manualTimeMs = timeMs;
            if (animationFrame) cancelAnimationFrame(animationFrame);
            animationFrame = 0;
            render(timeMs, true);
            return true;
          },
          resume() {
            manualTimeMs = null;
            lastFrameTimeSeconds = 0;
            lastScheduledTimeMs = 0;
            schedule();
          },
          renderer: () => orbButton.dataset.renderer || "unavailable",
        }),
      });
      if (!bridge) {
        status.textContent = "Voice controls unavailable";
        detail.textContent = "Return to the main Moss window";
        buttons.forEach((button) => { button.disabled = true; });
        return;
      }
      const unsubscribe = bridge.onState(apply);
      bridge.getState().then(apply).catch(() => {
        status.textContent = "Voice status unavailable";
      });
      const sendButtonCommand = async (button) => {
        button.disabled = true;
        try {
          const accepted = await bridge.sendCommand({ command: button.dataset.command, revision, generation });
          if (!accepted) detail.textContent = "The main Moss task is not ready";
        } finally {
          button.disabled = false;
        }
      };
      const captureOrbPointer = (pointerId) => {
        try { orbButton.setPointerCapture?.(pointerId); } catch {}
      };
      const releaseOrbPointer = (pointerId) => {
        try {
          if (orbButton.hasPointerCapture?.(pointerId)) orbButton.releasePointerCapture?.(pointerId);
        } catch {}
      };
      const finishOrbPointerDrag = (event, shouldHandoff) => {
        const drag = orbPointerDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const samples = trimPointerSamples([...drag.samples, pointerSample(event)]);
        const velocity = shouldHandoff && drag.hasMoved ? releaseVelocity(samples) : null;
        orbPointerDrag = null;
        releaseOrbPointer(event.pointerId);
        bridge.sendPointerDrag?.({
          type: "avatar-overlay-drag-end",
          pointerId: event.pointerId,
          pointerScreenX: event.screenX,
          pointerScreenY: event.screenY,
        });
        if (velocity) {
          bridge.sendPointerDrag?.({
            type: "avatar-overlay-drag-release",
            velocityX: velocity.x,
            velocityY: velocity.y,
          });
        }
        if (shouldHandoff && !drag.hasMoved) void sendButtonCommand(orbButton);
      };
      orbButton.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || typeof bridge.sendPointerDrag !== "function") return;
        event.preventDefault();
        event.stopPropagation();
        captureOrbPointer(event.pointerId);
        orbPointerDrag = {
          pointerId: event.pointerId,
          startScreenX: event.screenX,
          startScreenY: event.screenY,
          screenX: event.screenX,
          screenY: event.screenY,
          hasMoved: false,
          samples: [pointerSample(event)],
        };
        bridge.sendPointerDrag({
          type: "avatar-overlay-drag-start",
          pointerId: event.pointerId,
          pointerScreenX: event.screenX,
          pointerScreenY: event.screenY,
          pointerWindowX: event.clientX,
          pointerWindowY: event.clientY,
        });
      });
      orbButton.addEventListener("pointermove", (event) => {
        const drag = orbPointerDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.samples = trimPointerSamples([...drag.samples, pointerSample(event)]);
        const deltaX = event.screenX - drag.startScreenX;
        const deltaY = event.screenY - drag.startScreenY;
        if (!drag.hasMoved && Math.abs(deltaX) < dragThresholdPx && Math.abs(deltaY) < dragThresholdPx) {
          return;
        }
        event.preventDefault();
        drag.hasMoved = true;
        drag.screenX = event.screenX;
        drag.screenY = event.screenY;
        bridge.sendPointerDrag({
          type: "avatar-overlay-drag-move",
          pointerId: event.pointerId,
          pointerScreenX: event.screenX,
          pointerScreenY: event.screenY,
        });
      });
      orbButton.addEventListener("pointerup", (event) => {
        event.preventDefault();
        finishOrbPointerDrag(event, true);
      });
      orbButton.addEventListener("pointercancel", (event) => {
        finishOrbPointerDrag(event, false);
      });
      orbButton.addEventListener("lostpointercapture", (event) => {
        finishOrbPointerDrag(event, false);
      });
      window.addEventListener("pointerup", (event) => {
        finishOrbPointerDrag(event, true);
      });
      window.addEventListener("pointercancel", (event) => {
        finishOrbPointerDrag(event, false);
      });
      buttons.forEach((button) => {
        button.addEventListener("click", (event) => {
          if (button === orbButton) {
            // Pointer activation is resolved on pointerup so a drag can never
            // fall through to the handoff command. detail=0 preserves keyboard activation.
            event.preventDefault();
            if (event.detail === 0) void sendButtonCommand(button);
            return;
          }
          void sendButtonCommand(button);
        });
      });
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void bridge.sendCommand({ command: "handoff", revision, generation });
        }
      });
      window.addEventListener("unload", () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        if (orbPointerDrag) {
          bridge.sendPointerDrag?.({
            type: "avatar-overlay-drag-end",
            pointerId: orbPointerDrag.pointerId,
            pointerScreenX: orbPointerDrag.screenX,
            pointerScreenY: orbPointerDrag.screenY,
          });
          orbPointerDrag = null;
        }
        publishPointerInteractivity(false);
        unsubscribe();
      }, { once: true });
    })();
  </script>
</body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(document)}`;
}
