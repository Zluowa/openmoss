// FILE: RealtimeVoiceHandoffTarget.tsx
// Purpose: Animate a Realtime Voice orb between the main thread and the global overlay.
// Layer: Realtime Voice presentation

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type RealtimeVoicePresentationSurface = "main-thread" | "global-overlay";

export interface RealtimeVoiceHandoffPoint {
  readonly x: number;
  readonly y: number;
}

export interface RealtimeVoiceHandoffOrigin {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
}

export interface RealtimeVoiceHandoffMotion {
  readonly sequence: number;
  readonly from: RealtimeVoicePresentationSurface;
  readonly origin: RealtimeVoiceHandoffOrigin | null;
  readonly velocity: RealtimeVoiceHandoffPoint | null;
}

export interface RealtimeVoiceDetachMotion {
  readonly origin: RealtimeVoiceHandoffOrigin;
  readonly velocity: RealtimeVoiceHandoffPoint | null;
}

export interface RealtimeVoiceHandoffAnimationSpec {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
}

const HANDOFF_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampVector(point: RealtimeVoiceHandoffPoint, maximum: number): RealtimeVoiceHandoffPoint {
  const magnitude = Math.hypot(point.x, point.y);
  if (magnitude <= maximum) return point;
  const scale = maximum / magnitude;
  return { x: point.x * scale, y: point.y * scale };
}

function fallbackOffset(from: RealtimeVoicePresentationSurface): RealtimeVoiceHandoffPoint {
  return from === "global-overlay" ? { x: 0, y: -28 } : { x: 0, y: 18 };
}

export function realtimeVoiceHandoffOriginFromRect(
  rect: Pick<DOMRect, "height" | "left" | "top" | "width">,
  screen: { readonly screenX: number; readonly screenY: number },
  zoomFactor = 1,
): RealtimeVoiceHandoffOrigin {
  const screenScale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    centerX: screen.screenX + (rect.left + rect.width / 2) * screenScale,
    centerY: screen.screenY + (rect.top + rect.height / 2) * screenScale,
    height: rect.height * screenScale,
    width: rect.width * screenScale,
  };
}

export function buildRealtimeVoiceHandoffAnimation(input: {
  readonly handoff: RealtimeVoiceHandoffMotion;
  readonly surface: RealtimeVoicePresentationSurface;
  readonly target: RealtimeVoiceHandoffOrigin;
  readonly usesFadeTransition?: boolean;
  readonly zoomFactor?: number;
}): RealtimeVoiceHandoffAnimationSpec {
  const { handoff, surface, target } = input;
  const zoomFactor =
    typeof input.zoomFactor === "number" &&
    Number.isFinite(input.zoomFactor) &&
    input.zoomFactor > 0
      ? input.zoomFactor
      : 1;

  if (
    input.usesFadeTransition === true &&
    surface === "main-thread" &&
    handoff.from === "global-overlay"
  ) {
    return {
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      options: {
        duration: 200,
        easing: HANDOFF_EASING,
        fill: "backwards",
      },
    };
  }

  if (surface === "global-overlay" && handoff.from === "main-thread") {
    return {
      keyframes: [{ opacity: 0.96 }, { opacity: 1 }],
      options: {
        duration: 90,
        easing: HANDOFF_EASING,
        fill: "backwards",
      },
    };
  }

  const maximumOffset = surface === "main-thread" ? 300 : 180;
  const offset =
    handoff.origin === null
      ? fallbackOffset(handoff.from)
      : clampVector(
          {
            x: (handoff.origin.centerX - target.centerX) / zoomFactor,
            y: (handoff.origin.centerY - target.centerY) / zoomFactor,
          },
          maximumOffset,
        );

  if (surface === "main-thread" && Math.hypot(offset.x, offset.y) < 4) {
    return {
      keyframes: [
        { filter: "blur(1.5px)", opacity: 0.96 },
        { filter: "blur(0px)", opacity: 1 },
      ],
      options: {
        duration: 120,
        easing: HANDOFF_EASING,
        fill: "backwards",
      },
    };
  }

  const velocity =
    handoff.velocity === null
      ? { x: 0, y: 0 }
      : clampVector(
          {
            x: (handoff.velocity.x * 0.055) / zoomFactor,
            y: (handoff.velocity.y * 0.055) / zoomFactor,
          },
          surface === "main-thread" ? 56 : 48,
        );
  let startScale = surface === "main-thread" ? 0.86 : 0.82;
  if (handoff.origin !== null && target.width !== 0) {
    startScale = clamp(handoff.origin.width / target.width, 0.82, 1.12);
  }
  const rotation = clamp(offset.x / 40, -3, 3);
  const control = {
    x: offset.x * 0.3 + velocity.x,
    y: offset.y * 0.3 + velocity.y,
  };

  return {
    keyframes: [
      {
        opacity: surface === "main-thread" ? 0.88 : 0.82,
        transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${startScale}) rotate(${rotation}deg)`,
      },
      {
        offset: 0.46,
        opacity: 1,
        transform: `translate3d(${control.x}px, ${control.y}px, 0) scale(1.045) rotate(${rotation * -0.35}deg)`,
      },
      {
        offset: 0.8,
        opacity: 1,
        transform: `translate3d(${control.y * -0.045}px, ${control.x * 0.045 - 2}px, 0) scale(1.018) rotate(0deg)`,
      },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1) rotate(0deg)" },
    ],
    options: {
      delay: surface === "global-overlay" ? 24 : 0,
      duration: surface === "main-thread" ? 300 : 280,
      easing: HANDOFF_EASING,
      fill: "backwards",
    },
  };
}

export function useRealtimeVoiceReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reduceMotion;
}

function readDesktopZoomFactor(): number {
  const zoomFactor = window.desktopBridge?.getZoomFactor?.() ?? 1;
  return Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
}

export function useRealtimeVoiceZoomFactor(): number {
  const [zoomFactor, setZoomFactor] = useState(() =>
    typeof window === "undefined" ? 1 : readDesktopZoomFactor(),
  );

  useEffect(() => {
    const onZoomFactorChange = window.desktopBridge?.onZoomFactorChange;
    if (!onZoomFactorChange) return;
    return onZoomFactorChange((nextZoomFactor) => {
      setZoomFactor(Number.isFinite(nextZoomFactor) && nextZoomFactor > 0 ? nextZoomFactor : 1);
    });
  }, []);

  return zoomFactor;
}

export function RealtimeVoiceHandoffTarget(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly handoff: RealtimeVoiceHandoffMotion | null;
  readonly presentationAnchorRef?: (element: HTMLDivElement | null) => void;
  readonly reduceMotion?: boolean;
  readonly style?: CSSProperties;
  readonly surface: RealtimeVoicePresentationSurface;
  readonly usesFadeTransition?: boolean;
  readonly zoomFactor?: number;
}) {
  const prefersReducedMotion = useRealtimeVoiceReducedMotion();
  const desktopZoomFactor = useRealtimeVoiceZoomFactor();
  const reduceMotion = props.reduceMotion ?? prefersReducedMotion;
  const zoomFactor = props.zoomFactor ?? desktopZoomFactor;
  const usesFadeTransition = props.usesFadeTransition === true;
  const animationRef = useRef<Animation | null>(null);
  const lastSequenceRef = useRef<number | null>(null);
  const targetElementRef = useRef<HTMLDivElement | null>(null);
  const cancelOwnedAnimation = useCallback((animation: Animation | null) => {
    if (animation === null) return;
    animation.cancel();
    if (animationRef.current === animation) {
      animationRef.current = null;
    }
  }, []);

  // Keep the DOM callback stable. React invokes an old callback ref with null
  // before a newly allocated callback receives the same element; tying animation
  // ownership to that churn cancels the active sequence without restarting it.
  const targetRef = useCallback(
    (element: HTMLDivElement | null) => {
      targetElementRef.current = element;
      if (element === null) {
        cancelOwnedAnimation(animationRef.current);
      }
    },
    [cancelOwnedAnimation],
  );

  // Preserve normal callback-ref cleanup semantics for the consumer without
  // letting presentation callback identity changes own the animation lifecycle.
  useLayoutEffect(() => {
    const presentationAnchorRef = props.presentationAnchorRef;
    const element = targetElementRef.current;
    if (!presentationAnchorRef || !element) return;
    presentationAnchorRef(element);
    return () => presentationAnchorRef(null);
  }, [props.presentationAnchorRef]);

  useLayoutEffect(() => {
    const element = targetElementRef.current;
    if (props.handoff === null) {
      cancelOwnedAnimation(animationRef.current);
      lastSequenceRef.current = null;
      return;
    }
    if (element === null || reduceMotion || typeof element.animate !== "function") {
      cancelOwnedAnimation(animationRef.current);
      return;
    }
    if (lastSequenceRef.current === props.handoff.sequence) return;

    cancelOwnedAnimation(animationRef.current);
    lastSequenceRef.current = props.handoff.sequence;
    const target = realtimeVoiceHandoffOriginFromRect(
      element.getBoundingClientRect(),
      {
        screenX: window.screenX ?? 0,
        screenY: window.screenY ?? 0,
      },
      zoomFactor,
    );
    const animation = buildRealtimeVoiceHandoffAnimation({
      handoff: props.handoff,
      surface: props.surface,
      target,
      usesFadeTransition,
      zoomFactor,
    });
    animationRef.current = element.animate(animation.keyframes, animation.options);
  }, [
    cancelOwnedAnimation,
    props.handoff,
    props.surface,
    reduceMotion,
    usesFadeTransition,
    zoomFactor,
  ]);

  useEffect(
    () => () => {
      cancelOwnedAnimation(animationRef.current);
      // React StrictMode deliberately replays mount effects in development.
      // The replay cleanup owns the animation it cancels, so it must also
      // release the sequence claim; otherwise the following layout setup sees
      // the same sequence and leaves the return target with no animation.
      lastSequenceRef.current = null;
    },
    [cancelOwnedAnimation],
  );

  return (
    <div
      ref={targetRef}
      className={props.className}
      data-realtime-voice-handoff-target={props.surface}
      style={props.style}
    >
      {props.children}
    </div>
  );
}
