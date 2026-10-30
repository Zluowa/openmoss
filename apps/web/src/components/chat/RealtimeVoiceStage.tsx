// FILE: RealtimeVoiceStage.tsx
// Purpose: Present the Codex-shaped transparent Realtime Voice orb stage above the composer.
// Layer: Chat composer presentation

import type { RealtimeVoiceQuotaSnapshot, RealtimeVoiceState } from "@synara/contracts";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

import type { RealtimeVoiceOutputSignal } from "../../lib/realtimeVoiceWebRtc";
import {
  RealtimeVoiceHandoffTarget,
  type RealtimeVoiceDetachMotion,
  type RealtimeVoiceHandoffMotion,
  type RealtimeVoiceHandoffPoint,
  realtimeVoiceHandoffOriginFromRect,
  useRealtimeVoiceReducedMotion,
  useRealtimeVoiceZoomFactor,
} from "./RealtimeVoiceHandoffTarget";
import { RealtimeVoiceConnectingPulse } from "./RealtimeVoiceLaunchOverlay";
import { RealtimeVoiceOrb } from "./RealtimeVoiceOrb";

const DETACH_DISTANCE_PX = 52;
const DETACH_VISUAL_DEAD_ZONE_PX = 12;
const DETACH_VELOCITY_PX_PER_SECOND = 720;
const VELOCITY_SAMPLE_WINDOW_MS = 160;
const DRAG_ELASTIC_FACTOR = 0.46;

interface DragSample extends RealtimeVoiceHandoffPoint {
  readonly timeMs: number;
}

interface OrbDragState {
  readonly pointerId: number;
  readonly start: RealtimeVoiceHandoffPoint;
  readonly samples: DragSample[];
  offset: RealtimeVoiceHandoffPoint;
}

export function shouldDetachRealtimeVoiceOrb(input: {
  readonly offset: RealtimeVoiceHandoffPoint;
  readonly velocity: RealtimeVoiceHandoffPoint | null;
}): boolean {
  return (
    Math.hypot(input.offset.x, input.offset.y) >= DETACH_DISTANCE_PX ||
    (input.velocity !== null &&
      Math.hypot(input.velocity.x, input.velocity.y) >= DETACH_VELOCITY_PX_PER_SECOND)
  );
}

export function realtimeVoiceOrbDragProgress(offset: RealtimeVoiceHandoffPoint): number {
  const distance = Math.hypot(offset.x, offset.y);
  return Math.min(
    1,
    Math.max(
      0,
      (distance - DETACH_VISUAL_DEAD_ZONE_PX) / (DETACH_DISTANCE_PX - DETACH_VISUAL_DEAD_ZONE_PX),
    ),
  );
}

function realtimeVoiceOrbDragOpacity(progress: number): number {
  if (progress <= 0.35) return (progress / 0.35) * 0.04;
  return 0.04 + ((progress - 0.35) / 0.65) * 0.2;
}

function realtimeVoiceOrbDragScale(progress: number): number {
  if (progress <= 0.72) return 1 + (progress / 0.72) * 0.01;
  return 1.01 + ((progress - 0.72) / 0.28) * 0.02;
}

function dragVelocity(samples: readonly DragSample[]): RealtimeVoiceHandoffPoint | null {
  const last = samples.at(-1);
  if (!last) return null;
  const first = samples.find((sample) => last.timeMs - sample.timeMs > 0);
  if (!first) return null;
  const elapsedSeconds = Math.max(8, last.timeMs - first.timeMs) / 1_000;
  return {
    x: (last.x - first.x) / elapsedSeconds,
    y: (last.y - first.y) / elapsedSeconds,
  };
}

function RealtimeVoiceDraggableOrb(props: {
  readonly children: ReactNode;
  readonly onDetach: (motion: RealtimeVoiceDetachMotion) => void;
  readonly reduceMotion?: boolean;
}) {
  const prefersReducedMotion = useRealtimeVoiceReducedMotion();
  const reduceMotion = props.reduceMotion ?? prefersReducedMotion;
  const zoomFactor = useRealtimeVoiceZoomFactor();
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const orbContentRef = useRef<HTMLSpanElement | null>(null);
  const dragHighlightRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<OrbDragState | null>(null);
  const snapAnimationRef = useRef<Animation | null>(null);

  const resetTransform = (animate: boolean) => {
    const orb = orbRef.current;
    if (!orb) return;
    const from = orb.style.transform;
    snapAnimationRef.current?.cancel();
    snapAnimationRef.current = null;
    orb.style.transform = "";
    if (orbContentRef.current) orbContentRef.current.style.transform = "";
    if (dragHighlightRef.current) {
      dragHighlightRef.current.style.opacity = "0";
      dragHighlightRef.current.style.transform = "translate3d(-21%, 0, 0) rotate(12deg)";
    }
    if (!animate || reduceMotion || !from || typeof orb.animate !== "function") return;
    const animation = orb.animate(
      [
        { transform: from },
        { transform: "translate3d(-2px, 0, 0) scale(1.01)", offset: 0.72 },
        { transform: "none" },
      ],
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
    snapAnimationRef.current = animation;
    animation.onfinish = () => {
      if (snapAnimationRef.current === animation) snapAnimationRef.current = null;
    };
    animation.oncancel = () => {
      if (snapAnimationRef.current === animation) snapAnimationRef.current = null;
    };
  };

  const samplePointer = (event: ReactPointerEvent<HTMLButtonElement>, drag: OrbDragState) => {
    const sample = { x: event.screenX, y: event.screenY, timeMs: event.timeStamp };
    drag.samples.push(sample);
    while (
      drag.samples.length > 2 &&
      sample.timeMs - (drag.samples[0]?.timeMs ?? sample.timeMs) > VELOCITY_SAMPLE_WINDOW_MS
    ) {
      drag.samples.shift();
    }
    drag.offset = {
      x: event.screenX - drag.start.x,
      y: event.screenY - drag.start.y,
    };
    return sample;
  };

  const updateTransform = (offset: RealtimeVoiceHandoffPoint) => {
    const orb = orbRef.current;
    if (!orb) return;
    if (reduceMotion) return;
    const visualOffset = {
      x: offset.x * DRAG_ELASTIC_FACTOR,
      y: offset.y * DRAG_ELASTIC_FACTOR,
    };
    const rotateX = Math.max(-3, Math.min(3, -offset.y / 18));
    const rotateY = Math.max(-3, Math.min(3, offset.x / 18));
    const progress = realtimeVoiceOrbDragProgress(offset);
    orb.style.transform = `translate3d(${visualOffset.x}px, ${visualOffset.y}px, 0)`;
    if (orbContentRef.current) {
      orbContentRef.current.style.transform = `perspective(180px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${realtimeVoiceOrbDragScale(progress)})`;
    }
    if (dragHighlightRef.current) {
      dragHighlightRef.current.style.opacity = `${realtimeVoiceOrbDragOpacity(progress)}`;
      dragHighlightRef.current.style.transform = `translate3d(${(progress - 0.5) * 42}%, 0, 0) rotate(12deg)`;
    }
  };

  const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>, allowDetach: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    samplePointer(event, drag);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const velocity = dragVelocity(drag.samples);
    if (allowDetach && shouldDetachRealtimeVoiceOrb({ offset: drag.offset, velocity })) {
      const orb = orbRef.current;
      if (orb) {
        props.onDetach({
          origin: realtimeVoiceHandoffOriginFromRect(
            orb.getBoundingClientRect(),
            {
              screenX: window.screenX ?? 0,
              screenY: window.screenY ?? 0,
            },
            zoomFactor,
          ),
          velocity:
            velocity === null ? null : { x: velocity.x * zoomFactor, y: velocity.y * zoomFactor },
        });
      }
      resetTransform(false);
      return;
    }
    resetTransform(true);
  };

  useEffect(
    () => () => {
      snapAnimationRef.current?.cancel();
      snapAnimationRef.current = null;
    },
    [],
  );

  return (
    <button
      type="button"
      ref={orbRef}
      className="relative block size-28 cursor-grab touch-none appearance-none rounded-full border-0 bg-transparent p-0 text-inherit outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]/60"
      aria-label="Move voice chat to floating overlay"
      data-realtime-voice-draggable-orb="true"
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const orb = orbRef.current;
        if (!orb) return;
        props.onDetach({
          origin: realtimeVoiceHandoffOriginFromRect(
            orb.getBoundingClientRect(),
            {
              screenX: window.screenX ?? 0,
              screenY: window.screenY ?? 0,
            },
            zoomFactor,
          ),
          velocity: { x: 0, y: 0 },
        });
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        snapAnimationRef.current?.cancel();
        snapAnimationRef.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          start: { x: event.screenX, y: event.screenY },
          samples: [{ x: event.screenX, y: event.screenY, timeMs: event.timeStamp }],
          offset: { x: 0, y: 0 },
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        samplePointer(event, drag);
        updateTransform(drag.offset);
      }}
      onPointerUp={(event) => finishPointer(event, true)}
      onPointerCancel={(event) => finishPointer(event, false)}
      onLostPointerCapture={(event) => finishPointer(event, false)}
    >
      <span
        ref={orbContentRef}
        className="pointer-events-none relative block size-full"
        data-realtime-voice-draggable-orb-content="true"
      >
        {props.children}
        <span
          ref={dragHighlightRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-[18%] rounded-full bg-[linear-gradient(112deg,transparent_30%,rgba(255,255,255,0.38)_49%,transparent_68%)] opacity-0 mix-blend-screen"
          data-realtime-voice-drag-highlight="true"
          style={{ transform: "translate3d(-21%, 0, 0) rotate(12deg)" }}
        />
      </span>
    </button>
  );
}

function statusLabel(state: RealtimeVoiceState): string {
  if (state.phase === "reserving" || state.phase === "presenting") return "Preparing voice chat";
  if (state.phase === "starting") return "Connecting voice chat";
  if (state.phase === "stopping") return "Ending voice chat";
  if (state.activity === "speaking") return "Speaking";
  if (state.activity === "thinking") return "Thinking";
  return "Listening";
}

function quotaLabel(quota: RealtimeVoiceQuotaSnapshot | null): string | null {
  if (!quota) return null;
  if (quota.estimatedMinutesRemaining !== null) {
    return `About ${quota.estimatedMinutesRemaining} min remaining`;
  }
  if (quota.planLimitNanoUsd !== null) {
    const remaining = Math.max(
      0,
      quota.planLimitNanoUsd - quota.planUsedNanoUsd - quota.planReservedNanoUsd,
    );
    return `$${(remaining / 1_000_000_000).toFixed(2)} voice allowance remaining`;
  }
  return null;
}

export function RealtimeVoiceStage(props: {
  readonly state: RealtimeVoiceState;
  readonly transcript: string;
  readonly quota: RealtimeVoiceQuotaSnapshot | null;
  readonly readOutputSignal: () => RealtimeVoiceOutputSignal;
  readonly handoff?: RealtimeVoiceHandoffMotion | null;
  readonly presentationAnchorRef?: (element: HTMLDivElement | null) => void;
  readonly canDetachToGlobalOverlay?: boolean;
  readonly onDetachToGlobalOverlay?: (motion: RealtimeVoiceDetachMotion) => void;
  readonly onConnectionHandoffComplete?: () => void;
  readonly usesFadeTransition?: boolean;
  readonly reduceMotion?: boolean;
  /** Pins the clean-room shader clock for deterministic visual regression captures. */
  readonly previewTimeMs?: number;
}) {
  const prefersReducedMotion = useRealtimeVoiceReducedMotion();
  const reduceMotion = props.reduceMotion ?? prefersReducedMotion;
  const isConnecting =
    props.state.phase === "reserving" ||
    props.state.phase === "presenting" ||
    props.state.phase === "starting";

  useEffect(() => {
    if (isConnecting || props.onConnectionHandoffComplete === undefined) return;
    const frame = window.requestAnimationFrame(props.onConnectionHandoffComplete);
    return () => window.cancelAnimationFrame(frame);
  }, [isConnecting, props.onConnectionHandoffComplete]);

  const label = statusLabel(props.state);
  const remaining = quotaLabel(props.quota);
  const latestTranscript = props.transcript.trim().split("\n").at(-1);
  const orb = (
    <RealtimeVoiceHandoffTarget
      className="relative shrink-0"
      handoff={props.handoff ?? null}
      {...(props.presentationAnchorRef === undefined
        ? {}
        : { presentationAnchorRef: props.presentationAnchorRef })}
      style={{ width: 112, height: 112 }}
      surface="main-thread"
      {...(props.usesFadeTransition === undefined
        ? {}
        : { usesFadeTransition: props.usesFadeTransition })}
    >
      <div aria-hidden="true" className="relative flex size-full items-center justify-center">
        {isConnecting ? (
          <RealtimeVoiceConnectingPulse reduceMotion={reduceMotion} />
        ) : (
          <RealtimeVoiceOrb
            phase={props.state.phase}
            activity={props.state.activity}
            glowEnabled={false}
            readOutputSignal={props.readOutputSignal}
            {...(props.previewTimeMs === undefined ? {} : { previewTimeMs: props.previewTimeMs })}
          />
        )}
      </div>
    </RealtimeVoiceHandoffTarget>
  );

  return (
    <section
      className="relative mb-2 flex w-full items-end justify-center overflow-visible"
      style={{ height: 208, paddingRight: 48, paddingBottom: 12, paddingLeft: 48 }}
      aria-label="Realtime Voice"
      data-moss-realtime-voice-stage="true"
      data-phase={props.state.phase}
    >
      {props.canDetachToGlobalOverlay && props.onDetachToGlobalOverlay ? (
        <RealtimeVoiceDraggableOrb
          onDetach={props.onDetachToGlobalOverlay}
          reduceMotion={reduceMotion}
        >
          {orb}
        </RealtimeVoiceDraggableOrb>
      ) : (
        orb
      )}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {label}
        {latestTranscript ? `. ${latestTranscript}` : remaining ? `. ${remaining}` : ""}
      </div>
    </section>
  );
}
