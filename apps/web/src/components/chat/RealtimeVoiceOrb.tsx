// FILE: RealtimeVoiceOrb.tsx
// Purpose: Mount the clean-room WebGL Realtime Voice orb with a Canvas2D fallback.
// Layer: Realtime Voice presentation

import type { RealtimeVoiceActivity, RealtimeVoicePhase } from "@synara/contracts";
import { useEffect, useRef } from "react";

import {
  RealtimeVoiceOrbRenderer,
  type RealtimeVoiceOrbInputs,
} from "../../lib/realtimeVoiceOrbRenderer";
import type { RealtimeVoiceOutputSignal } from "../../lib/realtimeVoiceWebRtc";

const DEFAULT_CANVAS_SIZE = 152;
const DEFAULT_LAYOUT_SIZE = 112;

export function RealtimeVoiceOrb(props: {
  readonly phase: RealtimeVoicePhase;
  readonly activity: RealtimeVoiceActivity | null;
  readonly readOutputSignal?: () => RealtimeVoiceOutputSignal;
  /** Fixed time makes preview and visual-regression frames deterministic. */
  readonly previewTimeMs?: number | "live";
  readonly previewAudioLevel?: number;
  readonly glowEnabled?: boolean;
  /** Compatibility alias for the optimistic startup surface. */
  readonly optimistic?: boolean;
  /** Visual footprint reserved by the host surface. Defaults to the 112px live-stage size. */
  readonly layoutSize?: number;
  /** WebGL canvas size. Defaults to the 152px live-stage canvas. */
  readonly canvasSize?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<RealtimeVoiceOrbRenderer | null>(null);
  const layoutSize = props.layoutSize ?? DEFAULT_LAYOUT_SIZE;
  const canvasSize = props.canvasSize ?? DEFAULT_CANVAS_SIZE;
  const canvasOverflow = (canvasSize - layoutSize) / 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Changing a canvas bitmap dimension resets its rendering context. Apply
    // the requested geometry before constructing the matching renderer.
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const renderer = new RealtimeVoiceOrbRenderer(canvas);
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [canvasSize]);

  useEffect(() => {
    const inputs: RealtimeVoiceOrbInputs = {
      phase: props.phase,
      activity: props.activity,
      previewAudioLevel: props.previewAudioLevel ?? 0,
      ...(props.readOutputSignal ? { readPublishedAudioLevels: props.readOutputSignal } : {}),
      ...(typeof props.previewTimeMs === "number" ? { previewTimeMs: props.previewTimeMs } : {}),
    };
    rendererRef.current?.setInputs(inputs);
  }, [
    props.activity,
    props.phase,
    props.previewAudioLevel,
    props.previewTimeMs,
    props.readOutputSignal,
  ]);

  const glowEnabled = props.glowEnabled ?? !props.optimistic;

  return (
    <div
      aria-hidden="true"
      className="relative shrink-0"
      data-chromatic="ignore"
      data-realtime-voice-orb="true"
      style={{ width: layoutSize, height: layoutSize }}
    >
      <canvas
        ref={canvasRef}
        width={canvasSize}
        height={canvasSize}
        className="pointer-events-none absolute block max-w-none"
        style={{
          top: -canvasOverflow,
          left: -canvasOverflow,
          width: canvasSize,
          height: canvasSize,
          filter: glowEnabled ? "drop-shadow(0 0 4px rgb(154 154 249 / 55%))" : undefined,
        }}
      />
    </div>
  );
}
