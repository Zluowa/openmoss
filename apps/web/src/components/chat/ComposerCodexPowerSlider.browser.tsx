import "../../index.css";

import { useState } from "react";
import { commands } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ComposerCodexPowerSlider,
  type ComposerCodexPowerSliderChangeReason,
  type ComposerCodexPowerSliderOption,
} from "./ComposerCodexPowerSlider";
import { powerIndexToPercent, powerThumbInsetPx } from "./composerCodexPowerSliderGeometry";

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

const SIX_OPTIONS: ComposerCodexPowerSliderOption[] = [
  { id: "terra-low", isMax: false },
  { id: "sol-low", isMax: false },
  { id: "sol-medium", isMax: false },
  { id: "sol-high", isMax: false },
  { id: "sol-xhigh", isMax: false },
  { id: "sol-ultra", isMax: true },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Harness(props: {
  options?: ComposerCodexPowerSliderOption[];
  initialIndex?: number;
  disabled?: boolean;
  reducedMotion?: boolean;
  fastModeEnabled?: boolean;
  onSelect?: (index: number, reason: ComposerCodexPowerSliderChangeReason) => void;
  onDragToMax?: () => void;
  onEndpointLabelsVisibleChange?: (visible: boolean) => void;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const options = props.options ?? SIX_OPTIONS;
  const [selectedIndex, setSelectedIndex] = useState(props.initialIndex ?? 0);
  return (
    <div style={{ width: 240, padding: 40 }}>
      <ComposerCodexPowerSlider
        active
        disabled={props.disabled ?? false}
        fastModeEnabled={props.fastModeEnabled ?? false}
        onDragToMax={props.onDragToMax ?? (() => {})}
        onDraggingChange={props.onDraggingChange ?? (() => {})}
        onEndpointLabelsVisibleChange={props.onEndpointLabelsVisibleChange ?? (() => {})}
        onSelectIndex={(index, reason) => {
          setSelectedIndex(index);
          props.onSelect?.(index, reason);
        }}
        options={options}
        reducedMotion={props.reducedMotion ?? false}
        selectedIndex={selectedIndex}
        transitionsReady
      />
      <output data-selected-index={selectedIndex}>{selectedIndex}</output>
    </div>
  );
}

function root(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-codex-power-visual-slider="true"]')!;
}

function trackRect(): DOMRect {
  return document
    .querySelector<HTMLElement>(".composer-codex-power__track")!
    .getBoundingClientRect();
}

function thumbCenterX(): number {
  const rect = document
    .querySelector<HTMLElement>(".composer-codex-power__thumb")!
    .getBoundingClientRect();
  return rect.left + rect.width / 2 - trackRect().left;
}

function expectedCenterX(index: number, count: number): number {
  const percent = powerIndexToPercent(index, count);
  return (trackRect().width * percent) / 100 + powerThumbInsetPx(percent);
}

function pointer(type: string, target: EventTarget, init: PointerEventInit): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      ...init,
    }),
  );
}

describe("ComposerCodexPowerSlider", () => {
  it("lays out a two-stop ladder with the same inset geometry as the six-stop one", async () => {
    const screen = await render(
      <Harness
        options={[
          { id: "low", isMax: false },
          { id: "high", isMax: false },
        ]}
        initialIndex={1}
      />,
    );
    try {
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      expect(ticks).toHaveLength(2);
      const rect = trackRect();
      const centers = ticks.map((tick) => tick.getBoundingClientRect().left + 2 - rect.left);
      expect(centers[0]).toBeCloseTo(13, 0);
      expect(centers[1]).toBeCloseTo(rect.width - 13, 0);
      await vi.waitFor(() => {
        expect(Math.abs(thumbCenterX() - (rect.width - 13))).toBeLessThan(1);
      });
      // At the last stop the fill runs to the track edge so no grey shows behind the thumb.
      const range = document.querySelector<HTMLElement>('[data-codex-power-range="true"]')!;
      expect(range.getBoundingClientRect().right - rect.left).toBeCloseTo(rect.width, 0);
      expect(ticks.map((tick) => tick.dataset.selected)).toEqual(["true", "true"]);
    } finally {
      await screen.unmount();
    }
  });

  it("treats a tap as a track selection and only a real drag as reaching max", async () => {
    const onSelect = vi.fn();
    const onDragToMax = vi.fn();
    const screen = await render(<Harness onSelect={onSelect} onDragToMax={onDragToMax} />);
    try {
      const slider = root();
      vi.spyOn(slider, "setPointerCapture").mockImplementation(() => {});
      const rect = trackRect();
      const y = rect.top + rect.height / 2;
      // Tap straight onto the max tick.
      const maxX = rect.left + expectedCenterX(5, 6);
      pointer("pointerdown", slider, { button: 0, buttons: 1, clientX: maxX, clientY: y });
      pointer("pointerup", slider, { clientX: maxX, clientY: y });
      expect(onSelect).toHaveBeenLastCalledWith(5, "track");
      expect(onDragToMax).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(slider.dataset.max).toBe("true");
      });
      // Any interaction that lands on max bursts and sweeps the field in; only the usage
      // warning is reserved for a drag. An initially-max mount never bursts (see below).
      const fill = document.querySelector<HTMLElement>('[data-codex-power-max-fill="true"]');
      expect(fill).toHaveAttribute("data-reveal", "true");
      expect(document.querySelectorAll('[data-codex-power-max-burst="true"] > span').length).toBe(
        16,
      );

      // Back to the first stop, then drag across to max.
      const firstX = rect.left + expectedCenterX(0, 6);
      pointer("pointerdown", slider, { button: 0, buttons: 1, clientX: firstX, clientY: y });
      pointer("pointerup", slider, { clientX: firstX, clientY: y });
      expect(onSelect).toHaveBeenLastCalledWith(0, "track");
      await vi.waitFor(() => {
        expect(slider.dataset.max).toBe("false");
      });
      pointer("pointerdown", slider, { button: 0, buttons: 1, clientX: firstX, clientY: y });
      for (const fraction of [0.3, 0.6, 0.9, 1]) {
        pointer("pointermove", slider, {
          buttons: 1,
          clientX: firstX + (maxX - firstX) * fraction,
          clientY: y,
        });
      }
      expect(onDragToMax).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenLastCalledWith(5, "drag");
      await vi.waitFor(() => {
        expect(slider.dataset.dragging).toBe("true");
        expect(slider.dataset.pointerDown).toBe("true");
        expect(slider.dataset.endpointLabelsVisible).toBe("true");
        expect(document.querySelectorAll('[data-codex-power-max-burst="true"] > span').length).toBe(
          16,
        );
        expect(document.querySelector('[data-codex-power-max-fill="true"]')).toHaveAttribute(
          "data-reveal",
          "true",
        );
      });
      pointer("pointerup", slider, { clientX: maxX, clientY: y });
      await vi.waitFor(() => {
        expect(slider.dataset.dragging).toBe("false");
        expect(slider.dataset.pointerDown).toBe("false");
        expect(slider.dataset.endpointLabelsVisible).toBe("false");
      });
      // Dragging back off max and onto it again bursts again; tapping never does.
      pointer("pointerdown", slider, { button: 0, buttons: 1, clientX: maxX, clientY: y });
      pointer("pointermove", slider, { buttons: 1, clientX: firstX, clientY: y });
      pointer("pointermove", slider, { buttons: 1, clientX: maxX, clientY: y });
      pointer("pointerup", slider, { clientX: maxX, clientY: y });
      expect(onDragToMax).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps following a drag through window events after the pointer leaves the slider", async () => {
    const onSelect = vi.fn();
    const onDragging = vi.fn();
    const screen = await render(<Harness onSelect={onSelect} onDraggingChange={onDragging} />);
    try {
      const slider = root();
      vi.spyOn(slider, "setPointerCapture").mockImplementation(() => {});
      const rect = trackRect();
      const y = rect.top + rect.height / 2;
      pointer("pointerdown", slider, {
        button: 0,
        buttons: 1,
        clientX: rect.left + 13,
        clientY: y,
      });
      // Far outside the element: still tracked, clamped to the last stop.
      pointer("pointermove", window, { buttons: 1, clientX: rect.right + 400, clientY: y + 300 });
      expect(onSelect).toHaveBeenLastCalledWith(5, "drag");
      await vi.waitFor(() => {
        expect(onDragging).toHaveBeenLastCalledWith(true);
      });
      pointer("pointermove", window, { buttons: 1, clientX: rect.left - 400, clientY: y });
      expect(onSelect).toHaveBeenLastCalledWith(0, "drag");
      // A move without any button held is ignored (stale hover after release elsewhere).
      pointer("pointermove", window, { buttons: 0, clientX: rect.right, clientY: y });
      expect(onSelect).toHaveBeenLastCalledWith(0, "drag");
      pointer("pointerup", window, { clientX: rect.left - 400, clientY: y });
      await vi.waitFor(() => {
        expect(onDragging).toHaveBeenLastCalledWith(false);
      });
      expect(slider.dataset.pointerDown).toBe("false");
      // After release, window moves no longer drive the value.
      const calls = onSelect.mock.calls.length;
      pointer("pointermove", window, { buttons: 1, clientX: rect.right, clientY: y });
      expect(onSelect.mock.calls.length).toBe(calls);
    } finally {
      await screen.unmount();
    }
  });

  it("reveals the endpoint labels after a 150ms hold without movement", async () => {
    const onEndpoints = vi.fn();
    const screen = await render(<Harness onEndpointLabelsVisibleChange={onEndpoints} />);
    try {
      const slider = root();
      vi.spyOn(slider, "setPointerCapture").mockImplementation(() => {});
      const rect = trackRect();
      const y = rect.top + rect.height / 2;
      pointer("pointerdown", slider, {
        button: 0,
        buttons: 1,
        clientX: rect.left + 13,
        clientY: y,
      });
      await sleep(80);
      expect(slider.dataset.endpointLabelsVisible).toBe("false");
      await sleep(120);
      expect(slider.dataset.endpointLabelsVisible).toBe("true");
      expect(onEndpoints).toHaveBeenLastCalledWith(true);
      pointer("pointerup", slider, { clientX: rect.left + 13, clientY: y });
      await vi.waitFor(() => {
        expect(onEndpoints).toHaveBeenLastCalledWith(false);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("springs the thumb to 32px while hovered or pressed and back to 28px", async () => {
    const screen = await render(<Harness initialIndex={2} />);
    try {
      const input = document.querySelector<HTMLElement>('[data-codex-power-thumb-input="true"]')!;
      const thumb = document.querySelector<HTMLElement>(".composer-codex-power__thumb")!;
      expect(thumb.getBoundingClientRect().width).toBeCloseTo(28, 0);
      // React derives onPointerEnter/Leave from pointerover/pointerout pairs.
      pointer("pointerover", input, { relatedTarget: document.body });
      await vi.waitFor(() => {
        expect(thumb.getBoundingClientRect().width).toBeGreaterThan(31.5);
      });
      pointer("pointerout", input, { relatedTarget: document.body });
      await vi.waitFor(
        () => {
          expect(thumb.getBoundingClientRect().width).toBeLessThan(28.5);
        },
        { timeout: 2_000 },
      );
      // The hit target itself never grows: it stays a 28px circle riding the thumb.
      expect(input.getBoundingClientRect().width).toBe(28);
    } finally {
      await screen.unmount();
    }
  });

  it("ignores every interaction while disabled and dims the surface", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness disabled onSelect={onSelect} />);
    try {
      const slider = root();
      expect(slider.dataset.disabled).toBe("true");
      expect(getComputedStyle(slider).opacity).toBe("0.6");
      const rect = trackRect();
      const y = rect.top + rect.height / 2;
      pointer("pointerdown", slider, {
        button: 0,
        buttons: 1,
        clientX: rect.right - 13,
        clientY: y,
      });
      pointer("pointermove", slider, { buttons: 1, clientX: rect.right, clientY: y });
      pointer("pointerup", slider, { clientX: rect.right, clientY: y });
      slider.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -90 }),
      );
      expect(onSelect).not.toHaveBeenCalled();
      expect(slider.dataset.pointerDown).toBe("false");
      expect(slider.dataset.endpointLabelsVisible).toBe("false");
      expect(
        getComputedStyle(document.querySelector<HTMLElement>("[data-codex-power-tick]")!)
          .pointerEvents,
      ).toBe("none");
    } finally {
      await screen.unmount();
    }
  });

  it("steps by wheel on the dominant axis, honors inversion, and leaves ctrl-zoom alone", () => {
    return (async () => {
      const onSelect = vi.fn();
      const screen = await render(<Harness initialIndex={2} onSelect={onSelect} />);
      try {
        const slider = root();
        const wheel = (init: WheelEventInit & { inverted?: boolean }) => {
          const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
          if (init.inverted) {
            Object.defineProperty(event, "webkitDirectionInvertedFromDevice", { value: true });
          }
          slider.dispatchEvent(event);
          return event;
        };
        // Horizontal wins when larger: +40px right → one step up.
        expect(wheel({ deltaX: 40, deltaY: 5 }).defaultPrevented).toBe(true);
        expect(onSelect).toHaveBeenLastCalledWith(3, "wheel");
        // Vertical scroll-down moves left; inverted device flips it back.
        wheel({ deltaY: 40 });
        expect(onSelect).toHaveBeenLastCalledWith(2, "wheel");
        wheel({ deltaY: 40, inverted: true });
        expect(onSelect).toHaveBeenLastCalledWith(3, "wheel");
        // Line-mode deltas count as a full step each.
        wheel({ deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE });
        expect(onSelect).toHaveBeenLastCalledWith(4, "wheel");
        const calls = onSelect.mock.calls.length;
        const zoom = wheel({ deltaY: -200, ctrlKey: true });
        expect(zoom.defaultPrevented).toBe(false);
        expect(onSelect.mock.calls.length).toBe(calls);
      } finally {
        await screen.unmount();
      }
    })();
  });

  it("glides between stops normally and jumps when motion is reduced", async () => {
    const animated = await render(<Harness initialIndex={0} />);
    try {
      const rect = trackRect();
      const y = rect.top + rect.height / 2;
      const slider = root();
      vi.spyOn(slider, "setPointerCapture").mockImplementation(() => {});
      const target = rect.left + expectedCenterX(5, 6);
      pointer("pointerdown", slider, { button: 0, buttons: 1, clientX: target, clientY: y });
      pointer("pointerup", slider, { clientX: target, clientY: y });
      await sleep(60);
      const midFlight = thumbCenterX();
      expect(midFlight).toBeGreaterThan(13);
      expect(midFlight).toBeLessThan(expectedCenterX(5, 6) - 1);
      await vi.waitFor(() => {
        expect(Math.abs(thumbCenterX() - expectedCenterX(5, 6))).toBeLessThan(0.75);
      });
    } finally {
      await animated.unmount();
    }

    await motionCommands.emulateReducedMotion("reduce");
    const reduced = await render(<Harness initialIndex={0} reducedMotion />);
    try {
      const rect = trackRect();
      const y = rect.top + rect.height / 2;
      const slider = root();
      expect(slider.dataset.reducedMotion).toBe("true");
      vi.spyOn(slider, "setPointerCapture").mockImplementation(() => {});
      const target = rect.left + expectedCenterX(5, 6);
      pointer("pointerdown", slider, { button: 0, buttons: 1, clientX: target, clientY: y });
      pointer("pointerup", slider, { clientX: target, clientY: y });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(Math.abs(thumbCenterX() - expectedCenterX(5, 6))).toBeLessThan(0.75);
      // No burst particles and no reveal sweep under reduced motion.
      expect(document.querySelector('[data-codex-power-max-burst="true"]')).toBeNull();
      expect(document.querySelector('[data-codex-power-max-fill="true"]')).toHaveAttribute(
        "data-reveal",
        "false",
      );
    } finally {
      await reduced.unmount();
      await motionCommands.emulateReducedMotion("no-preference");
    }
  });

  it("reflects fast mode and max on the root for styling hooks", async () => {
    const screen = await render(<Harness initialIndex={5} fastModeEnabled />);
    try {
      const slider = root();
      expect(slider.dataset.fastMode).toBe("true");
      expect(slider.dataset.max).toBe("true");
      // Opening already on max shows the field quietly: no burst, no reveal sweep.
      expect(document.querySelector('[data-codex-power-max-burst="true"]')).toBeNull();
      expect(document.querySelector('[data-codex-power-max-fill="true"]')).toHaveAttribute(
        "data-reveal",
        "false",
      );
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      expect(ticks.every((tick) => tick.dataset.selected === "true")).toBe(true);
      await vi.waitFor(() => {
        expect(getComputedStyle(ticks[0]!).opacity).toBe("0");
      });
    } finally {
      await screen.unmount();
    }
  });
});
