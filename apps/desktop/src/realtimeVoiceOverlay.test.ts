import { describe, expect, it } from "vitest";

import {
  buildDesktopRealtimeVoiceOverlayUrl,
  DesktopRealtimeVoiceOwnerMessageBuffer,
  DesktopRealtimeVoiceOverlayStateModel,
  isDesktopRealtimeVoiceOverlayCommand,
  isDesktopRealtimeVoiceOverlayCommandRequestCurrent,
  isDesktopRealtimeVoiceOverlayInteractivePoint,
  isDesktopRealtimeVoiceOverlayInteractiveScreenPoint,
  normalizeDesktopRealtimeVoiceOverlayCommandRequest,
  normalizeDesktopRealtimeVoiceOverlayHandoff,
  normalizeDesktopRealtimeVoiceOverlayPointerDragEvent,
  normalizeDesktopRealtimeVoiceOverlayPublication,
  normalizeDesktopRealtimeVoiceOverlaySnapshot,
  REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES,
  REALTIME_VOICE_OVERLAY_ORB_CENTER_OFFSET,
  REALTIME_VOICE_OVERLAY_PLACEMENT,
  REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION,
  REALTIME_VOICE_OVERLAY_DRAG_THRESHOLD_PX,
  REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE,
  REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND,
  REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPAN_MS,
  REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPEED_PX_PER_SECOND,
  REALTIME_VOICE_OVERLAY_RELEASE_SAMPLE_WINDOW_MS,
  REALTIME_VOICE_OVERLAY_SIZE,
  REALTIME_VOICE_OVERLAY_SLOT,
  REALTIME_VOICE_OVERLAY_STATIC_GEOMETRIES,
  REALTIME_VOICE_OVERLAY_VIEWPORTS,
  resolveDesktopRealtimeVoiceOverlayBounds,
  resolveDesktopRealtimeVoiceOverlayDragLayout,
  resolveDesktopRealtimeVoiceOverlayGeometry,
  resolveDesktopRealtimeVoiceOverlayHandoffPosition,
  resolveDesktopRealtimeVoiceOverlayHandoffStartBounds,
  resolveDesktopRealtimeVoiceOverlayHandoffTargetBounds,
  resolveDesktopRealtimeVoiceOverlayPlacement,
  resolveDesktopRealtimeVoiceOverlayReleaseVelocity,
  shouldShowDesktopRealtimeVoiceOverlay,
  shouldThrottleDesktopRealtimeVoiceOwner,
} from "./realtimeVoiceOverlay";

const activeSnapshot = {
  phase: "active" as const,
  activity: "listening" as const,
  inputMuted: false,
  outputMuted: false,
  error: null,
};

describe("Realtime Voice overlay contract guards", () => {
  it("accepts only the renderer-owner commands", () => {
    expect(
      ["toggle", "stop", "focus", "handoff", "toggle-input-mute", "toggle-output-mute"].every(
        isDesktopRealtimeVoiceOverlayCommand,
      ),
    ).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayCommand("mute")).toBe(false);
    expect(isDesktopRealtimeVoiceOverlayCommand({ command: "stop" })).toBe(false);
  });

  it("requires overlay commands to carry a process revision and media generation", () => {
    expect(
      normalizeDesktopRealtimeVoiceOverlayCommandRequest({
        command: "stop",
        revision: 3,
        generation: 2,
      }),
    ).toEqual({ command: "stop", revision: 3, generation: 2 });
    expect(
      normalizeDesktopRealtimeVoiceOverlayCommandRequest({ command: "stop", revision: 3 }),
    ).toBeNull();
    expect(
      normalizeDesktopRealtimeVoiceOverlayCommandRequest({
        command: "stop",
        revision: -1,
        generation: 2,
      }),
    ).toBeNull();
  });

  it("accepts only bounded native pointer-drag messages", () => {
    expect(
      normalizeDesktopRealtimeVoiceOverlayPointerDragEvent({
        type: "avatar-overlay-drag-start",
        pointerId: 7,
        pointerScreenX: -220,
        pointerScreenY: 744,
        pointerWindowX: 76,
        pointerWindowY: 232,
      }),
    ).toEqual({
      type: "avatar-overlay-drag-start",
      pointerId: 7,
      pointerScreenX: -220,
      pointerScreenY: 744,
      pointerWindowX: 76,
      pointerWindowY: 232,
    });
    expect(
      normalizeDesktopRealtimeVoiceOverlayPointerDragEvent({
        type: "avatar-overlay-drag-move",
        pointerId: 7,
        pointerScreenX: -216,
        pointerScreenY: 744,
      }),
    ).toEqual({
      type: "avatar-overlay-drag-move",
      pointerId: 7,
      pointerScreenX: -216,
      pointerScreenY: 744,
    });
    expect(
      normalizeDesktopRealtimeVoiceOverlayPointerDragEvent({
        type: "avatar-overlay-drag-start",
        pointerId: 7,
        pointerScreenX: Number.NaN,
        pointerScreenY: 744,
        pointerWindowX: 76,
        pointerWindowY: 232,
      }),
    ).toBeNull();
    expect(
      normalizeDesktopRealtimeVoiceOverlayPointerDragEvent({
        type: "avatar-overlay-drag-release",
        pointerId: 7,
        pointerScreenX: -216,
        pointerScreenY: 744,
      }),
    ).toBeNull();
    expect(
      normalizeDesktopRealtimeVoiceOverlayPointerDragEvent({
        type: "avatar-overlay-drag-release",
        velocityX: 960,
        velocityY: -240,
      }),
    ).toEqual({
      type: "avatar-overlay-drag-release",
      velocityX: 960,
      velocityY: -240,
    });
    expect(
      normalizeDesktopRealtimeVoiceOverlayPointerDragEvent({
        type: "avatar-overlay-drag-release",
        velocityX: 1_601,
        velocityY: 0,
      }),
    ).toBeNull();
  });

  it("accepts same-generation state churn only inside the current visible revision range", () => {
    const presentation = { generation: 3, revision: 12 };
    const request = { command: "stop" as const, generation: 3, revision: 10 };
    expect(isDesktopRealtimeVoiceOverlayCommandRequestCurrent(request, presentation, 9)).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayCommandRequestCurrent(request, presentation, 11)).toBe(
      false,
    );
    expect(
      isDesktopRealtimeVoiceOverlayCommandRequestCurrent(
        { ...request, generation: 2 },
        presentation,
        9,
      ),
    ).toBe(false);
    expect(
      isDesktopRealtimeVoiceOverlayCommandRequestCurrent(
        { ...request, revision: 13 },
        presentation,
        9,
      ),
    ).toBe(false);
  });

  it("normalizes the bounded display-only snapshot and rejects media-shaped data", () => {
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({
        ...activeSnapshot,
        error: `  ${"voice   ".repeat(100)}`,
      }),
    ).toEqual({
      ...activeSnapshot,
      error: expect.stringMatching(/^voice voice/u),
    });
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({ ...activeSnapshot, sessionId: "secret" }),
    ).toEqual(activeSnapshot);
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({ ...activeSnapshot, inputMuted: "false" }),
    ).toBeUndefined();
    expect(normalizeDesktopRealtimeVoiceOverlaySnapshot(null)).toBeNull();
  });

  it("accepts only four bounded display-energy bands and never raw audio", () => {
    const audioSignal = { low: 0, mid: 0.25, high: 0.75, overall: 1 };
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({ ...activeSnapshot, audioSignal }),
    ).toEqual({ ...activeSnapshot, audioSignal });
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({
        ...activeSnapshot,
        audioSignal: { ...audioSignal, high: 1.01 },
      }),
    ).toBeUndefined();
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({
        ...activeSnapshot,
        audioSignal: { ...audioSignal, overall: Number.NaN },
      }),
    ).toBeUndefined();
    expect(
      normalizeDesktopRealtimeVoiceOverlaySnapshot({
        ...activeSnapshot,
        audioSignal: new Float32Array([0, 0, 0, 0]),
      }),
    ).toBeUndefined();
  });

  it("normalizes the renderer publication without inferring media ownership from visibility", () => {
    expect(
      normalizeDesktopRealtimeVoiceOverlayPublication({
        snapshot: null,
        mediaOwnerActive: true,
        handoff: null,
      }),
    ).toEqual({ snapshot: null, mediaOwnerActive: true, handoff: null });
    expect(
      normalizeDesktopRealtimeVoiceOverlayPublication({ snapshot: activeSnapshot }),
    ).toBeNull();
  });

  it("bounds screen-space handoff motion before it reaches a native window", () => {
    const handoff = {
      sequence: 4,
      from: "main-thread" as const,
      origin: { centerX: -840, centerY: 420, width: 112, height: 112 },
      velocity: { x: 860, y: -120 },
    };
    expect(normalizeDesktopRealtimeVoiceOverlayHandoff(handoff)).toEqual(handoff);
    expect(
      normalizeDesktopRealtimeVoiceOverlayHandoff({
        ...handoff,
        velocity: { x: Number.POSITIVE_INFINITY, y: 0 },
      }),
    ).toBeUndefined();
  });

  it("shows active/failure phases but treats inactive and null as hidden", () => {
    expect(shouldShowDesktopRealtimeVoiceOverlay(activeSnapshot)).toBe(true);
    expect(shouldShowDesktopRealtimeVoiceOverlay({ ...activeSnapshot, phase: "failed" })).toBe(
      true,
    );
    expect(shouldShowDesktopRealtimeVoiceOverlay({ ...activeSnapshot, phase: "inactive" })).toBe(
      false,
    );
    expect(shouldShowDesktopRealtimeVoiceOverlay(null)).toBe(false);
  });
});

describe("DesktopRealtimeVoiceOverlayStateModel", () => {
  it("replays the latest state with process-owned revisions and media generations", () => {
    const model = new DesktopRealtimeVoiceOverlayStateModel();
    expect(model.current).toEqual({
      revision: 0,
      generation: 0,
      mediaOwnerActive: false,
      handoff: null,
      snapshot: null,
    });
    expect(
      model.update({ snapshot: activeSnapshot, mediaOwnerActive: true, handoff: null }),
    ).toEqual({
      revision: 1,
      generation: 1,
      mediaOwnerActive: true,
      handoff: null,
      snapshot: activeSnapshot,
    });
    expect(model.update({ snapshot: null, mediaOwnerActive: true, handoff: null })).toEqual({
      revision: 2,
      generation: 1,
      mediaOwnerActive: true,
      handoff: null,
      snapshot: null,
    });
    expect(shouldThrottleDesktopRealtimeVoiceOwner(model.current)).toBe(false);
    expect(model.update({ snapshot: null, mediaOwnerActive: false, handoff: null })).toEqual({
      revision: 3,
      generation: 1,
      mediaOwnerActive: false,
      handoff: null,
      snapshot: null,
    });
    expect(shouldThrottleDesktopRealtimeVoiceOwner(model.current)).toBe(true);
    expect(
      model.update({ snapshot: activeSnapshot, mediaOwnerActive: true, handoff: null }),
    ).toEqual({
      revision: 4,
      generation: 2,
      mediaOwnerActive: true,
      handoff: null,
      snapshot: activeSnapshot,
    });
  });

  it("does not replace replay state when an invalid publisher payload arrives", () => {
    const model = new DesktopRealtimeVoiceOverlayStateModel();
    const valid = model.update({ snapshot: activeSnapshot, mediaOwnerActive: true, handoff: null });
    expect(model.update({ snapshot: activeSnapshot })).toBeNull();
    expect(model.current).toBe(valid);
  });

  it("keeps one media generation while an active call is handed to the global overlay", () => {
    const model = new DesktopRealtimeVoiceOverlayStateModel();
    const started = model.update({
      snapshot: activeSnapshot,
      mediaOwnerActive: true,
      handoff: {
        sequence: 1,
        from: "main-thread",
        origin: { centerX: 600, centerY: 700, width: 112, height: 112 },
        velocity: { x: 0, y: -80 },
      },
    });
    const moved = model.update({
      snapshot: activeSnapshot,
      mediaOwnerActive: true,
      handoff: {
        sequence: 2,
        from: "main-thread",
        origin: { centerX: 620, centerY: 680, width: 112, height: 112 },
        velocity: { x: 40, y: -40 },
      },
    });

    expect(started?.generation).toBe(1);
    expect(moved).toMatchObject({
      generation: 1,
      mediaOwnerActive: true,
      snapshot: activeSnapshot,
    });
    expect(moved?.handoff?.sequence).toBe(2);
  });
});

describe("DesktopRealtimeVoiceOwnerMessageBuffer", () => {
  it("clears deferred overlay commands when the overlay is hidden", () => {
    const buffer = new DesktopRealtimeVoiceOwnerMessageBuffer();
    buffer.subscribe("command");
    buffer.queueCommand("stop", 1, 8);
    buffer.clearOverlayCommands();
    expect(buffer.drain(1, 8, 8).commands).toEqual([]);
  });

  it("never drains an overlay command into a later media generation or revision", () => {
    const buffer = new DesktopRealtimeVoiceOwnerMessageBuffer();
    buffer.subscribe("command");
    buffer.queueCommand("toggle-input-mute", 1, 8);
    expect(buffer.drain(2, 8, 8).commands).toEqual([]);
    buffer.queueCommand("toggle-output-mute", 2, 8);
    expect(buffer.drain(2, 9, 9).commands).toEqual([]);
  });

  it("drops subscriptions, shortcut parity, and commands on owner reload", () => {
    const buffer = new DesktopRealtimeVoiceOwnerMessageBuffer();
    buffer.subscribe("toggle");
    buffer.subscribe("command");
    buffer.queueToggle();
    buffer.queueCommand("handoff", 4, 11);
    buffer.resetForOwnerReload();
    buffer.subscribe("toggle");
    buffer.subscribe("command");
    expect(buffer.drain(4, 11, 11)).toEqual({ toggle: false, commands: [] });
  });

  it("can preserve only the initial hidden-window shortcut while clearing owner commands", () => {
    const buffer = new DesktopRealtimeVoiceOwnerMessageBuffer();
    buffer.subscribe("toggle");
    buffer.subscribe("command");
    buffer.queueToggle();
    buffer.queueCommand("stop", 1, 2);
    buffer.resetForOwnerReload({ preserveToggle: true });
    buffer.subscribe("toggle");
    buffer.subscribe("command");
    expect(buffer.drain(1, 2, 2)).toEqual({ toggle: true, commands: [] });
  });

  it("replays matching commands with their global-to-main handoff motion", () => {
    const buffer = new DesktopRealtimeVoiceOwnerMessageBuffer();
    const handoff = {
      sequence: 12,
      from: "global-overlay" as const,
      origin: { centerX: 1_400, centerY: 760, width: 180, height: 180 },
      velocity: { x: 0, y: 0 },
    };
    buffer.subscribe("command");
    buffer.queueCommand("handoff", 3, 12, handoff);
    expect(buffer.drain(3, 12, 12).commands).toEqual([{ command: "handoff", handoff }]);
  });

  it("replays a deferred command after harmless same-generation state churn", () => {
    const buffer = new DesktopRealtimeVoiceOwnerMessageBuffer();
    buffer.subscribe("command");
    buffer.queueCommand("stop", 4, 21);
    expect(buffer.drain(4, 20, 23).commands).toEqual([{ command: "stop", handoff: null }]);
  });
});

describe("Realtime Voice overlay geometry and document", () => {
  it("matches the live Codex 5973 compact viewport and visual constants", () => {
    expect(REALTIME_VOICE_OVERLAY_VIEWPORTS).toEqual({
      compact: { width: 356, height: 320 },
      native: { width: 384, height: 400 },
      legacySetup: { width: 408, height: 400 },
    });
    expect(REALTIME_VOICE_OVERLAY_SIZE).toEqual({ width: 356, height: 320 });
    expect(REALTIME_VOICE_OVERLAY_SLOT).toEqual({
      left: 20,
      top: 176,
      width: 112,
      height: 121,
    });
    expect(REALTIME_VOICE_OVERLAY_ORB_CENTER_OFFSET).toEqual({ x: 76, y: 232 });
    expect(REALTIME_VOICE_OVERLAY_CONTROLS_HIT_REGION).toEqual({
      left: 9,
      top: 243,
      width: 94,
      height: 38,
    });
    expect(REALTIME_VOICE_OVERLAY_PLACEMENT).toBe("top-start");
  });

  it("keeps active, native, and older setup geometry in separate static layers", () => {
    expect(REALTIME_VOICE_OVERLAY_STATIC_GEOMETRIES).toEqual({
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
    });
    expect(resolveDesktopRealtimeVoiceOverlayGeometry()).toEqual({
      slot: { left: 20, top: 176, width: 112, height: 121 },
      controlsHitRegion: { left: 9, top: 243, width: 94, height: 38 },
      orbCenterOffset: { x: 76, y: 232 },
    });
    expect(
      resolveDesktopRealtimeVoiceOverlayGeometry(REALTIME_VOICE_OVERLAY_VIEWPORTS.native),
    ).toEqual({
      slot: { left: 244, top: 207, width: 112, height: 121 },
      controlsHitRegion: { left: 233, top: 274, width: 94, height: 38 },
      orbCenterOffset: { x: 300, y: 263 },
    });
    expect(
      resolveDesktopRealtimeVoiceOverlayGeometry(REALTIME_VOICE_OVERLAY_VIEWPORTS.legacySetup),
    ).toEqual({
      slot: { left: 268, top: 271, width: 112, height: 121 },
      controlsHitRegion: { left: 257, top: 338, width: 94, height: 38 },
      orbCenterOffset: { x: 324, y: 327 },
    });
    expect(resolveDesktopRealtimeVoiceOverlayGeometry({ width: 357, height: 321 })).toBeNull();
  });

  it("keeps every compact attachment quadrant explicit instead of mirroring at runtime", () => {
    expect(REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES).toEqual({
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
    });
    expect(
      resolveDesktopRealtimeVoiceOverlayGeometry(
        REALTIME_VOICE_OVERLAY_VIEWPORTS.compact,
        "top-end",
      ),
    ).toBe(REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES["top-end"]);
    expect(
      resolveDesktopRealtimeVoiceOverlayGeometry(
        REALTIME_VOICE_OVERLAY_VIEWPORTS.compact,
        "bottom-start",
      ),
    ).toBe(REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES["bottom-start"]);
  });

  it("selects all four Codex attachment quadrants from the dragged orb center", () => {
    const workArea = { x: 0, y: 0, width: 1_000, height: 800 };
    expect(resolveDesktopRealtimeVoiceOverlayPlacement({ x: 100, y: 100 }, workArea)).toBe(
      "bottom-start",
    );
    expect(resolveDesktopRealtimeVoiceOverlayPlacement({ x: 900, y: 100 }, workArea)).toBe(
      "bottom-end",
    );
    expect(resolveDesktopRealtimeVoiceOverlayPlacement({ x: 100, y: 700 }, workArea)).toBe(
      "top-start",
    );
    expect(resolveDesktopRealtimeVoiceOverlayPlacement({ x: 900, y: 700 }, workArea)).toBe(
      "top-end",
    );
  });

  it("keeps the orb under the pointer while the native viewport flips placement", () => {
    const workArea = { x: 0, y: 0, width: 1_000, height: 800 };
    const lowerLeft = resolveDesktopRealtimeVoiceOverlayDragLayout({
      pointerScreenPoint: { x: 100, y: 700 },
      pointerOffsetInOrb: { x: 56, y: 56 },
      workArea,
    });
    expect(lowerLeft).toEqual({
      placement: "top-start",
      bounds: { x: 24, y: 468, width: 356, height: 320 },
    });
    expect({
      x: lowerLeft.bounds.x + REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES["top-start"].slot.left,
      y: lowerLeft.bounds.y + REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES["top-start"].slot.top,
    }).toEqual({ x: 44, y: 644 });

    const upperRight = resolveDesktopRealtimeVoiceOverlayDragLayout({
      pointerScreenPoint: { x: 900, y: 100 },
      pointerOffsetInOrb: { x: 56, y: 56 },
      workArea,
    });
    expect(upperRight).toEqual({
      placement: "bottom-end",
      bounds: { x: 620, y: 12, width: 356, height: 320 },
    });
    expect({
      x: upperRight.bounds.x + REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES["bottom-end"].slot.left,
      y: upperRight.bounds.y + REALTIME_VOICE_OVERLAY_COMPACT_GEOMETRIES["bottom-end"].slot.top,
    }).toEqual({ x: 844, y: 44 });
  });

  it("clamps the full 356x320 BrowserWindow at every edge and placement", () => {
    const workArea = { x: 0, y: 0, width: 1_000, height: 800 };
    const cases = [
      { point: { x: 0, y: 0 }, placement: "bottom-start", bounds: { x: 0, y: 0 } },
      { point: { x: 1_000, y: 0 }, placement: "bottom-end", bounds: { x: 644, y: 0 } },
      { point: { x: 0, y: 800 }, placement: "top-start", bounds: { x: 0, y: 480 } },
      { point: { x: 1_000, y: 800 }, placement: "top-end", bounds: { x: 644, y: 480 } },
    ] as const;
    for (const testCase of cases) {
      const result = resolveDesktopRealtimeVoiceOverlayDragLayout({
        pointerScreenPoint: testCase.point,
        pointerOffsetInOrb: { x: 0, y: 0 },
        workArea,
      });
      expect(result.placement).toBe(testCase.placement);
      expect({ x: result.bounds.x, y: result.bounds.y }).toEqual(testCase.bounds);
      expect(result.bounds.x).toBeGreaterThanOrEqual(workArea.x);
      expect(result.bounds.y).toBeGreaterThanOrEqual(workArea.y);
      expect(result.bounds.x + result.bounds.width).toBeLessThanOrEqual(
        workArea.x + workArea.width,
      );
      expect(result.bounds.y + result.bounds.height).toBeLessThanOrEqual(
        workArea.y + workArea.height,
      );
    }
  });

  it("matches build 5973 release sampling, minimum fling, and velocity cap", () => {
    expect({
      sampleWindowMs: REALTIME_VOICE_OVERLAY_RELEASE_SAMPLE_WINDOW_MS,
      minimumSpanMs: REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPAN_MS,
      minimumSpeed: REALTIME_VOICE_OVERLAY_RELEASE_MIN_SPEED_PX_PER_SECOND,
      maximumSpeed: REALTIME_VOICE_OVERLAY_RELEASE_MAX_SPEED_PX_PER_SECOND,
    }).toEqual({
      sampleWindowMs: 100,
      minimumSpanMs: 16,
      minimumSpeed: 320,
      maximumSpeed: 1_600,
    });
    expect(
      resolveDesktopRealtimeVoiceOverlayReleaseVelocity([
        { screenX: 0, screenY: 0, timeMs: 0 },
        { screenX: 40, screenY: 0, timeMs: 16 },
      ]),
    ).toBeNull();
    expect(
      resolveDesktopRealtimeVoiceOverlayReleaseVelocity([
        { screenX: 0, screenY: 0, timeMs: 0 },
        { screenX: 31, screenY: 0, timeMs: 100 },
      ]),
    ).toBeNull();
    expect(
      resolveDesktopRealtimeVoiceOverlayReleaseVelocity([
        { screenX: 0, screenY: 0, timeMs: 0 },
        { screenX: 32, screenY: 0, timeMs: 100 },
      ]),
    ).toEqual({ x: 320, y: 0 });
    expect(
      resolveDesktopRealtimeVoiceOverlayReleaseVelocity([
        { screenX: -100, screenY: 0, timeMs: 0 },
        { screenX: 0, screenY: 0, timeMs: 100 },
        { screenX: 200, screenY: 0, timeMs: 200 },
      ]),
    ).toEqual({ x: 1_600, y: 0 });
    const diagonal = resolveDesktopRealtimeVoiceOverlayReleaseVelocity([
      { screenX: 0, screenY: 0, timeMs: 0 },
      { screenX: 300, screenY: 400, timeMs: 100 },
    ]);
    expect(diagonal).not.toBeNull();
    expect(Math.hypot(diagonal?.x ?? 0, diagonal?.y ?? 0)).toBeCloseTo(1_600, 8);
  });

  it("initially activates only the orb/attached-controls geometry for a stationary cursor", () => {
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 76, y: 232 })).toBe(true);
    // The 11px left protrusion belongs only to the attached active-control pill.
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 12, y: 254 })).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 10, y: 10 })).toBe(false);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 348, y: 200 })).toBe(false);
    expect(
      isDesktopRealtimeVoiceOverlayInteractivePoint(
        { x: 324, y: 327 },
        REALTIME_VOICE_OVERLAY_VIEWPORTS.legacySetup,
      ),
    ).toBe(true);
    expect(
      isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 76, y: 88 }, { width: 200, height: 100 }),
    ).toBe(false);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: Number.NaN, y: 110 })).toBe(false);
  });

  it("keeps hit-test edges deterministic in both window and screen coordinates", () => {
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 20, y: 176 })).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 132, y: 297 })).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 9, y: 243 })).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 103, y: 281 })).toBe(true);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 8.99, y: 254 })).toBe(false);
    expect(isDesktopRealtimeVoiceOverlayInteractivePoint({ x: 132.01, y: 297 })).toBe(false);
    expect(
      isDesktopRealtimeVoiceOverlayInteractivePoint(
        { x: 280, y: 88 },
        REALTIME_VOICE_OVERLAY_VIEWPORTS.compact,
        "bottom-end",
      ),
    ).toBe(true);
    expect(
      isDesktopRealtimeVoiceOverlayInteractivePoint(
        { x: 76, y: 232 },
        REALTIME_VOICE_OVERLAY_VIEWPORTS.compact,
        "bottom-end",
      ),
    ).toBe(false);

    const bounds = { x: -372, y: 744, width: 356, height: 320 };
    expect(isDesktopRealtimeVoiceOverlayInteractiveScreenPoint({ x: -296, y: 976 }, bounds)).toBe(
      true,
    );
    expect(isDesktopRealtimeVoiceOverlayInteractiveScreenPoint({ x: -362, y: 754 }, bounds)).toBe(
      false,
    );
    expect(
      isDesktopRealtimeVoiceOverlayInteractiveScreenPoint({ x: -92, y: 832 }, bounds, "bottom-end"),
    ).toBe(true);
  });

  it("anchors inside negative-origin and constrained display work areas", () => {
    expect(
      resolveDesktopRealtimeVoiceOverlayBounds({ x: -1920, y: 24, width: 1920, height: 1056 }),
    ).toEqual({ x: -372, y: 744, width: 356, height: 320 });
    expect(
      resolveDesktopRealtimeVoiceOverlayBounds(
        { x: 100, y: 200, width: 200, height: 100 },
        { width: 304, height: 148 },
      ),
    ).toEqual({ x: 100, y: 200, width: 200, height: 100 });
  });

  it("starts at the true screen origin and preserves release velocity", () => {
    expect(
      resolveDesktopRealtimeVoiceOverlayHandoffStartBounds({
        centerX: -840,
        centerY: 420,
        width: 112,
        height: 112,
      }),
    ).toEqual({ x: -916, y: 188, width: 356, height: 320 });
    expect(
      resolveDesktopRealtimeVoiceOverlayHandoffPosition({
        from: { x: 0, y: 0 },
        to: { x: 1_000, y: 500 },
        velocity: { x: 800, y: -100 },
        progress: 0.5,
        durationMs: 500,
      }),
    ).toEqual({ x: 550, y: 244 });
  });

  it("settles on the handoff origin display even when the cursor is elsewhere", () => {
    const workAreas = [
      { x: -1920, y: 24, width: 1920, height: 1056 },
      { x: 0, y: 0, width: 1512, height: 982 },
    ] as const;
    expect(
      resolveDesktopRealtimeVoiceOverlayHandoffTargetBounds(
        { centerX: -840, centerY: 420, width: 112, height: 112 },
        (point) => (point.x < 0 ? workAreas[0] : workAreas[1]),
      ),
    ).toEqual({ x: -372, y: 744, width: 356, height: 320 });
  });

  it("ships an offline, accessible, reduced-motion/reduced-transparency document", () => {
    const url = buildDesktopRealtimeVoiceOverlayUrl({ deterministicTimeMs: 4_250 });
    expect(url.startsWith("data:text/html;charset=UTF-8,")).toBe(true);
    const html = decodeURIComponent(url.split(",", 2)[1] ?? "");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="End Realtime Voice"');
    expect(html).toContain("Voice remains connected during task handoff");
    expect(html).toContain('<canvas class="orb-canvas" width="152" height="152"');
    expect(html).toContain("top: 176px; left: 20px;");
    expect(html).toContain(
      "position: absolute; top: -20px; left: -20px; display: block; width: 152px; height: 152px;",
    );
    expect(html).toContain("width: 112px; height: 121px;");
    expect(html).toContain("top: 0; left: 0; width: 112px;");
    expect(html).toContain("height: 112px; margin: 0; padding: 0;");
    expect(html).toContain("width: 28px; height: 28px");
    expect(html.match(/<button type="button" class="control/gu)).toHaveLength(3);
    expect(html).toContain("gap: 2px; padding: 2px");
    expect(html).toContain("margin-left: -20px");
    expect(html).toContain("translateY(-20px)");
    expect(html).toContain('data-overlay-hit-region="voice"');
    expect(html).toContain("bridge.setPointerInteractive(interactive)");
    expect(html).toContain(`layoutChangedType = "${REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE}"`);
    expect(html).toContain("consumeAvatarOverlayLayoutChanged(presentation)");
    expect(html).toContain("orbSlot.style.left = geometry.slot.left");
    expect(html).toContain(`dragThresholdPx = ${REALTIME_VOICE_OVERLAY_DRAG_THRESHOLD_PX}`);
    expect(html).toContain("releaseSampleWindowMs = 100");
    expect(html).toContain("releaseMinSpanMs = 16");
    expect(html).toContain("releaseMinSpeed = 320");
    expect(html).toContain("releaseMaxSpeed = 1600");
    expect(html).toContain('type: "avatar-overlay-drag-release"');
    expect(html).toContain('orbButton.addEventListener("pointerdown"');
    expect(html).toContain('type: "avatar-overlay-drag-move"');
    expect(html).toContain("shouldHandoff && !drag.hasMoved");
    expect(html).not.toContain("-webkit-app-region: drag");
    expect(html).toContain('body[data-pointer-interactive="true"] .controls');
    expect(html).toContain('interactiveHitRegions = [{"x":20,"y":176,"width":112,"height":121}');
    expect(html).toContain('{"x":9,"y":243,"width":94,"height":38}');
    expect(html).not.toContain("window.innerWidth - interactiveHitLayout.viewport.width");
    expect(html).toContain(
      'window.addEventListener("resize", reconcilePointerInteractivityAtLastPoint',
    );
    expect(html).not.toContain("document.hasFocus()");
    expect(html).not.toContain("document.activeElement");
    expect(html).toContain("Math.min(1.5");
    expect(html).toContain("frameIntervalMs = 1000 / 30");
    expect(html).toContain("premultipliedAlpha: false");
    expect(html).toContain("#define FRACTAL_OCTAVES 5");
    expect(html).toContain("configuredTimeMs = 4250");
    expect(html).toContain("__mossRealtimeVoiceOverlayTest");
    expect(html).toContain('canvas.getContext("2d")');
    expect(html).toContain("revision, generation");
    expect(html).not.toContain("RTCPeerConnection");
    expect(html).not.toContain("mediaDevices");
    expect(html).not.toContain("WebSocket");
    expect(html).not.toContain("fetch(");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("prefers-reduced-transparency: reduce");
    expect(html).toContain("forced-colors: active");
  });

  it("uses neutral build-5973 controls with the active overlay orb halo", () => {
    const html = decodeURIComponent(buildDesktopRealtimeVoiceOverlayUrl().split(",", 2)[1] ?? "");
    expect(html).toContain("--overlay-control-bg: rgba(255,255,255,.86)");
    expect(html).toContain("--overlay-control-fg: #202020");
    expect(html).toContain("--overlay-control-bg: rgba(32,32,32,.86)");
    expect(html).toContain("box-shadow: 0 2px 6px rgba(0,0,0,.2)");
    expect(html).toContain("background: transparent; box-shadow: none");
    expect(html).not.toContain("#5145e5");
    expect(html).not.toContain("#4b60ff");
    expect(html).not.toContain("#3e52ef");
    expect(html).toContain("filter: drop-shadow(0 0 3px rgb(154 154 249 / 55%))");
    expect(html).not.toContain("0 8px 24px");
  });

  it("ignores invalid deterministic render times instead of embedding them", () => {
    const html = decodeURIComponent(
      buildDesktopRealtimeVoiceOverlayUrl({ deterministicTimeMs: Number.POSITIVE_INFINITY }).split(
        ",",
        2,
      )[1] ?? "",
    );
    expect(html).toContain("configuredTimeMs = null");
  });
});
