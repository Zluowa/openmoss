// FILE: ComposerCodexPowerSlider.tsx
// Purpose: Visual slider for the compact Codex power picker. Owns pointer, wheel, and
//   hover interaction over the 24px track, animates the thumb / blue range with motion
//   values, and reports interaction state upward so the header controls can respond.
// Layer: Chat composer presentation
// Depends on: composerCodexPowerSliderGeometry (pure math), motion/react.
// Accessibility: The whole surface is aria-hidden. Keyboard and screen-reader access is
//   provided by the hidden Power menu item rendered by ComposerCodexPowerPicker.

import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "~/lib/utils";
import {
  consumePowerWheel,
  createPowerWheelAccumulator,
  POWER_SLIDER_ENDPOINT_HOLD_MS,
  POWER_SLIDER_ENDPOINT_MOVE_PX,
  POWER_SLIDER_THUMB_PRESSED_SCALE,
  powerIndexFromPointer,
  powerIndexToPercent,
  powerRangeTransform,
  powerThumbLeft,
} from "./composerCodexPowerSliderGeometry";

export type ComposerCodexPowerSliderChangeReason = "track" | "drag" | "wheel";

export type ComposerCodexPowerSliderOption = {
  readonly id: string;
  readonly isMax: boolean;
};

export type ComposerCodexPowerSliderProps = {
  readonly options: ReadonlyArray<ComposerCodexPowerSliderOption>;
  readonly selectedIndex: number;
  /** True while the compact view is the visible panel; motion is paused otherwise. */
  readonly active: boolean;
  readonly disabled: boolean;
  readonly fastModeEnabled: boolean;
  readonly reducedMotion: boolean;
  readonly transitionsReady: boolean;
  readonly onSelectIndex: (index: number, reason: ComposerCodexPowerSliderChangeReason) => void;
  /** Fired once when a drag (not a tap) first reaches the max option. */
  readonly onDragToMax?: () => void;
  readonly onEndpointLabelsVisibleChange?: (visible: boolean) => void;
  readonly onDraggingChange?: (dragging: boolean) => void;
};

type InteractionState = {
  readonly pointerDown: boolean;
  readonly dragging: boolean;
  readonly endpointLabelsVisible: boolean;
  readonly thumbHovered: boolean;
  /** Increments each time an interaction enters the max option; 0 = not at max. */
  readonly maxBurstKey: number;
};

type InteractionAction =
  | { type: "pointer_down" }
  | { type: "pointer_move" }
  | { type: "pointer_up" }
  | { type: "show_endpoint_labels" }
  | { type: "thumb_hover"; hovered: boolean }
  | { type: "value"; atMax: boolean; enteredMax: boolean };

const INITIAL_INTERACTION: InteractionState = {
  pointerDown: false,
  dragging: false,
  endpointLabelsVisible: false,
  thumbHovered: false,
  maxBurstKey: 0,
};

function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
  switch (action.type) {
    case "pointer_down":
      return { ...state, pointerDown: true, dragging: false, endpointLabelsVisible: false };
    case "pointer_move":
      return state.pointerDown && !state.dragging ? { ...state, dragging: true } : state;
    case "pointer_up":
      return {
        ...state,
        pointerDown: false,
        dragging: false,
        endpointLabelsVisible: false,
        thumbHovered: false,
      };
    case "show_endpoint_labels":
      return state.pointerDown && !state.endpointLabelsVisible
        ? { ...state, endpointLabelsVisible: true }
        : state;
    case "thumb_hover":
      return state.thumbHovered === action.hovered
        ? state
        : { ...state, thumbHovered: action.hovered };
    case "value":
      return {
        ...state,
        maxBurstKey: action.enteredMax
          ? state.maxBurstKey + 1
          : action.atMax
            ? state.maxBurstKey
            : 0,
      };
  }
}

const SETTLE_TRANSITION = { duration: 0.3, ease: [0.23, 1, 0.32, 1] as const };
const DRAG_TRANSITION = { duration: 0.15, ease: [0.23, 1, 0.32, 1] as const };
const INSTANT_TRANSITION = { duration: 0 };
const THUMB_PRESS_SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 1 } as const;
const THUMB_RELEASE_SPRING = { type: "spring", stiffness: 220, damping: 26, mass: 1 } as const;
const BURST_PARTICLES = Array.from({ length: 16 }, (_, index) => index);

export const ComposerCodexPowerSlider = memo(function ComposerCodexPowerSlider(
  props: ComposerCodexPowerSliderProps,
) {
  const {
    options,
    selectedIndex,
    active,
    disabled,
    fastModeEnabled,
    reducedMotion,
    transitionsReady,
    onSelectIndex,
    onDragToMax,
    onEndpointLabelsVisibleChange,
    onDraggingChange,
  } = props;
  const count = options.length;
  const lastIndex = count - 1;
  const inert = disabled || count <= 1;
  const [interaction, dispatch] = useReducer(interactionReducer, INITIAL_INTERACTION);
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedRef = useRef(false);
  const selectedIndexRef = useRef(selectedIndex);
  const wheelRef = useRef(createPowerWheelAccumulator());
  selectedIndexRef.current = selectedIndex;

  const percent = powerIndexToPercent(selectedIndex, count);
  const selected = options[selectedIndex];
  const isMax = lastIndex > 0 && selected?.isMax === true;
  const percentValue = useMotionValue(percent);
  const thumbLeft = useTransform(percentValue, powerThumbLeft);
  const rangeTransform = useTransform(percentValue, (value) =>
    powerRangeTransform(value, lastIndex),
  );

  useEffect(() => {
    if (!active || reducedMotion) {
      percentValue.jump(percent);
      return;
    }
    const controls = animate(
      percentValue,
      percent,
      interaction.dragging ? DRAG_TRANSITION : SETTLE_TRANSITION,
    );
    return () => controls.stop();
  }, [active, interaction.dragging, percent, percentValue, reducedMotion]);

  useEffect(() => {
    onEndpointLabelsVisibleChange?.(interaction.endpointLabelsVisible && !inert);
  }, [inert, interaction.endpointLabelsVisible, onEndpointLabelsVisibleChange]);

  useEffect(() => {
    onDraggingChange?.(interaction.dragging && !inert);
  }, [inert, interaction.dragging, onDraggingChange]);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const selectIndex = useCallback(
    (nextIndex: number, reason: ComposerCodexPowerSliderChangeReason) => {
      const option = options[nextIndex];
      if (inert || !option || nextIndex === selectedIndexRef.current) return;
      const wasMax = options[selectedIndexRef.current]?.isMax === true;
      const nowMax = lastIndex > 0 && option.isMax;
      const enteredMaxByDrag = nowMax && !wasMax && movedRef.current;
      selectedIndexRef.current = nextIndex;
      dispatch({ type: "value", atMax: nowMax, enteredMax: nowMax && !wasMax });
      onSelectIndex(nextIndex, reason);
      // Queue the external warning after the slider has recorded the new value. The
      // warning and the purple max field should never expose an intermediate frame in
      // which the parent says "Ultra" while the slider still reports its old burst key.
      if (enteredMaxByDrag) onDragToMax?.();
    },
    [inert, lastIndex, onDragToMax, onSelectIndex, options],
  );

  const indexFromEvent = useCallback(
    (clientX: number) => {
      const root = rootRef.current;
      if (!root) return selectedIndexRef.current;
      const rect = root.getBoundingClientRect();
      return powerIndexFromPointer(clientX, rect.left, rect.width, count);
    },
    [count],
  );

  const detachWindowRef = useRef<(() => void) | null>(null);

  const endPointer = useCallback(() => {
    clearHoldTimer();
    detachWindowRef.current?.();
    pointerStartRef.current = null;
    movedRef.current = false;
    dispatch({ type: "pointer_up" });
  }, [clearHoldTimer]);

  const handlePointerTravel = useCallback(
    (clientX: number, clientY: number, buttons: number) => {
      const start = pointerStartRef.current;
      if (!start || inert || buttons === 0) return;
      movedRef.current = true;
      const moved = Math.hypot(clientX - start.x, clientY - start.y);
      if (moved >= POWER_SLIDER_ENDPOINT_MOVE_PX) {
        clearHoldTimer();
        dispatch({ type: "pointer_move" });
        dispatch({ type: "show_endpoint_labels" });
      }
      selectIndex(indexFromEvent(clientX), "drag");
    },
    [clearHoldTimer, indexFromEvent, inert, selectIndex],
  );

  const travelRef = useRef(handlePointerTravel);
  travelRef.current = handlePointerTravel;
  const endPointerRef = useRef(endPointer);
  endPointerRef.current = endPointer;

  // Pointer capture keeps real drags on the root; the window listeners make the same
  // drag observable when the pointer leaves the element or capture is unavailable.
  // They are attached in the pointerdown handler itself so that a move which follows
  // the press synchronously is never missed.
  const attachWindowListeners = useCallback(() => {
    detachWindowRef.current?.();
    const onMove = (event: PointerEvent) => {
      travelRef.current(event.clientX, event.clientY, event.buttons);
    };
    const onEnd = () => endPointerRef.current();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    detachWindowRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      detachWindowRef.current = null;
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (inert || event.button !== 0) return;
      event.preventDefault();
      movedRef.current = false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events may not carry a live pointer; window listeners cover this case.
      }
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      attachWindowListeners();
      dispatch({ type: "pointer_down" });
      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        dispatch({ type: "show_endpoint_labels" });
      }, POWER_SLIDER_ENDPOINT_HOLD_MS);
      selectIndex(indexFromEvent(event.clientX), "track");
    },
    [attachWindowListeners, clearHoldTimer, indexFromEvent, inert, selectIndex],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handlePointerTravel(event.clientX, event.clientY, event.buttons);
    },
    [handlePointerTravel],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      endPointer();
    },
    [endPointer],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || inert) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = consumePowerWheel(wheelRef.current, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        timeStamp: event.timeStamp,
        pixelDelta: event.deltaMode === WheelEvent.DOM_DELTA_PIXEL,
        invertedFromDevice:
          (event as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean })
            .webkitDirectionInvertedFromDevice === true,
      });
      if (direction === 0) return;
      const next = Math.max(0, Math.min(selectedIndexRef.current + direction, lastIndex));
      if (next === selectedIndexRef.current) {
        wheelRef.current.accumulatedDelta = 0;
        return;
      }
      selectIndex(next, "wheel");
      endPointer();
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [endPointer, inert, lastIndex, selectIndex]);

  useLayoutEffect(() => {
    return () => {
      clearHoldTimer();
      detachWindowRef.current?.();
    };
  }, [clearHoldTimer]);

  const pressed = !inert && (interaction.thumbHovered || interaction.pointerDown);
  const thumbScale = !reducedMotion && pressed ? POWER_SLIDER_THUMB_PRESSED_SCALE : 1;
  const thumbSpring = reducedMotion
    ? INSTANT_TRANSITION
    : pressed
      ? THUMB_PRESS_SPRING
      : THUMB_RELEASE_SPRING;
  const showBurst = isMax && interaction.maxBurstKey > 0 && !reducedMotion;
  const ticks = useMemo(
    () =>
      options.map((option, index) => (
        <span
          aria-hidden="true"
          className={cn(
            "composer-codex-power__tick",
            option.isMax && "composer-codex-power__tick--ultra",
          )}
          data-codex-power-tick={index}
          data-selected={index <= selectedIndex ? "true" : "false"}
          key={option.id}
          style={{ left: powerThumbLeft(powerIndexToPercent(index, count)) }}
        />
      )),
    [count, options, selectedIndex],
  );

  if (!selected) return null;

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="composer-codex-power__slider"
      data-codex-power-visual-slider="true"
      data-disabled={inert ? "true" : undefined}
      data-dragging={!inert && interaction.dragging ? "true" : "false"}
      data-endpoint-labels-visible={!inert && interaction.endpointLabelsVisible ? "true" : "false"}
      data-fast-mode={fastModeEnabled ? "true" : "false"}
      data-max={isMax ? "true" : "false"}
      data-pointer-down={!inert && interaction.pointerDown ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-transitions-ready={transitionsReady ? "true" : "false"}
      dir="ltr"
      onClick={(event) => event.stopPropagation()}
      onLostPointerCapture={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
    >
      <div className="composer-codex-power__track" data-codex-power-track="true">
        <motion.span
          aria-hidden="true"
          className="composer-codex-power__range"
          data-codex-power-range="true"
          style={{ transform: rangeTransform }}
        >
          <AnimatePresence initial={false}>
            {isMax ? (
              <motion.span
                key="max-fill"
                animate={{ opacity: 1 }}
                className="composer-codex-power__max-fill"
                data-codex-power-max-fill="true"
                data-reveal={showBurst ? "true" : "false"}
                exit={{ opacity: 0 }}
                initial={{ opacity: 0 }}
                transition={reducedMotion ? INSTANT_TRANSITION : SETTLE_TRANSITION}
              />
            ) : null}
          </AnimatePresence>
        </motion.span>
        <div className="composer-codex-power__tick-rail">{ticks}</div>
      </div>
      <div aria-hidden="true" className="composer-codex-power__thumb-rail">
        <motion.span className="composer-codex-power__thumb-scale" style={{ left: thumbLeft }}>
          {showBurst ? (
            <span
              className="composer-codex-power__max-burst"
              data-codex-power-max-burst="true"
              key={interaction.maxBurstKey}
            >
              {BURST_PARTICLES.map((particle) => (
                <span key={particle} />
              ))}
            </span>
          ) : null}
          <motion.span
            animate={{ scale: thumbScale }}
            className="composer-codex-power__thumb-spring"
            initial={false}
            transition={thumbSpring}
          >
            <span
              className={cn(
                "composer-codex-power__thumb",
                isMax && "composer-codex-power__thumb--ultra",
              )}
            />
          </motion.span>
        </motion.span>
      </div>
      <motion.span
        aria-hidden="true"
        className="composer-codex-power__thumb-input"
        data-codex-power-thumb-input="true"
        onPointerEnter={() => {
          if (!inert) dispatch({ type: "thumb_hover", hovered: true });
        }}
        onPointerLeave={() => dispatch({ type: "thumb_hover", hovered: false })}
        style={{ left: thumbLeft }}
      />
    </div>
  );
});
