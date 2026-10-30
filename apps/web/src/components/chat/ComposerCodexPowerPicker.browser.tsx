import "../../index.css";

import { type ProviderModelDescriptor } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { commands, page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { MossLocalizationProvider } from "../../localization";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY } from "../../uiLocale";
import { Menu, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { ComposerCodexPowerPicker } from "./ComposerCodexPowerPicker";
import {
  resolveComposerCodexPowerOptions,
  resolveComposerPowerOptions,
  type ComposerCodexPowerChoice,
  type ComposerCodexPowerOptions,
} from "./composerCodexPowerOptions";

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

const RUNTIME_MODELS: ProviderModelDescriptor[] = [
  {
    slug: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    supportedReasoningEfforts: [
      { value: "low" },
      { value: "medium" },
      { value: "high" },
      { value: "xhigh" },
    ],
    defaultReasoningEffort: "low",
  },
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    supportedReasoningEfforts: [
      { value: "low" },
      { value: "medium" },
      { value: "high" },
      { value: "xhigh" },
      { value: "ultra" },
    ],
    defaultReasoningEffort: "medium",
  },
];

const POWER = resolveComposerCodexPowerOptions({
  runtimeModels: RUNTIME_MODELS,
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
});

function PowerHarness(props: {
  locale?: "en" | "zh-CN";
  side?: "top" | "bottom";
  selectedIndex?: number | null;
  initialFastModeEnabled?: boolean;
  /** Override the Codex bundle with any vendor's resolved ladder. */
  power?: ComposerCodexPowerOptions;
  localizeEffortLabel?: (choice: ComposerCodexPowerChoice) => string;
  onChange?: (choice: ComposerCodexPowerChoice) => void;
  onFastModeChange?: (enabled: boolean) => void;
}) {
  const power = props.power ?? POWER;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(
    props.selectedIndex === undefined ? power.selectedIndex : props.selectedIndex,
  );
  const [fastModeEnabled, setFastModeEnabled] = useState(props.initialFastModeEnabled ?? false);
  const [open, setOpen] = useState(true);
  const selectedChoice =
    selectedIndex === null ? null : (power.choices[selectedIndex] ?? power.fallbackChoice);
  const handleChange = (choice: ComposerCodexPowerChoice) => {
    const nextIndex = power.choices.indexOf(choice);
    setSelectedIndex(nextIndex >= 0 ? nextIndex : power.fallbackIndex);
    props.onChange?.(choice);
  };
  const handleFastModeChange = (enabled: boolean) => {
    setFastModeEnabled(enabled);
    props.onFastModeChange?.(enabled);
  };
  const locale = props.locale ?? "en";
  const popup = (
    <ComposerCodexPowerPicker
      advancedContent={
        <div data-codex-power-advanced-fixture="true">
          <div role="menuitem">Model</div>
          <div role="menuitem">Reasoning effort</div>
          <div role="menuitem">Speed</div>
        </div>
      }
      choices={power.choices}
      fallbackIndex={power.fallbackIndex}
      fastModeEnabled={fastModeEnabled}
      onFastModeChange={handleFastModeChange}
      onPowerChange={handleChange}
      onReset={handleChange}
      onRequestClose={() => setOpen(false)}
      selectedIndex={selectedIndex}
      {...(props.localizeEffortLabel ? { localizeEffortLabel: props.localizeEffortLabel } : {})}
    />
  );

  return (
    <>
      <div style={{ paddingTop: props.side === "bottom" ? "100px" : "600px" }}>
        <Menu open={open} onOpenChange={setOpen}>
          <MenuTrigger render={<button type="button">Open picker</button>}>Open picker</MenuTrigger>
          <ComposerPickerMenuPopup align="start" side={props.side ?? "top"} fixedWidth>
            {popup}
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
      <output data-codex-power-selected={selectedChoice?.label ?? "none"}>
        {selectedChoice?.label ?? "none"}
      </output>
      <span data-codex-power-locale={locale} />
    </>
  );
}

async function renderHarness(
  node: ReactNode,
  locale: "en" | "zh-CN" = "en",
  direction: "ltr" | "rtl" = "ltr",
) {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
  const previousDirection = document.body.getAttribute("dir");
  document.body.setAttribute("dir", direction);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>{node}</MossLocalizationProvider>
    </QueryClientProvider>,
  );
  return {
    screen,
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      document.body.innerHTML = "";
      if (previousDirection === null) {
        document.body.removeAttribute("dir");
      } else {
        document.body.setAttribute("dir", previousDirection);
      }
    },
  };
}

function readRotationDegrees(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  const match = transform.match(/^matrix(?:3d)?\(([^)]+)\)$/u);
  if (!match) return Number.NaN;
  const matchedValues = match[1];
  if (!matchedValues) return Number.NaN;
  const values = matchedValues.split(",").map(Number);
  const a = values[0] ?? Number.NaN;
  const b = values[1] ?? Number.NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  const rotation = Math.atan2(b, a) * (180 / Math.PI);
  return Math.round(rotation);
}

function readTranslateY(element: HTMLElement): number {
  const translate = getComputedStyle(element).translate.trim();
  if (translate === "none" || translate.length === 0) return 0;
  const values = translate.split(/\s+/u).map(Number.parseFloat);
  return Number.isFinite(values[1]) ? values[1]! : 0;
}

describe("ComposerCodexPowerPicker", () => {
  it("opens compact, keeps both panels mounted, and toggles advanced in place", async () => {
    const mounted = await renderHarness(<PowerHarness />);
    try {
      const picker = document.querySelector<HTMLElement>('[data-codex-power-picker="true"]');
      expect(picker?.dataset.codexPowerView).toBe("compact");
      expect(document.querySelectorAll("[data-codex-power-panel]").length).toBe(2);
      expect(document.querySelector(".composer-codex-power__title")).toBeNull();
      expect(
        getComputedStyle(document.querySelector<HTMLElement>(".composer-codex-power__fast-item")!)
          .width,
      ).toBe("32px");
      const pickerElement = picker!;
      expect(document.querySelector('[data-codex-power-header-controls="true"]')).toHaveAttribute(
        "data-codex-power-controls-state",
        "compact",
      );
      expect(
        document
          .querySelector<HTMLElement>('[data-codex-power-header-controls="true"]')
          ?.getBoundingClientRect().height,
      ).toBe(36);
      await vi.waitFor(() => {
        expect(getComputedStyle(pickerElement).height).not.toBe("auto");
      });
      expect(
        getComputedStyle(document.querySelector<HTMLElement>("[data-codex-power-panel-track]")!)
          .flexDirection,
      ).toBe("column-reverse");
      expect(
        document.querySelector<HTMLElement>('[data-codex-power-visual-slider="true"]'),
      ).toHaveAttribute("aria-hidden", "true");
      const track = document.querySelector<HTMLElement>(".composer-codex-power__track");
      expect(getComputedStyle(track!).height).toBe("24px");
      expect(getComputedStyle(track!).borderRadius).toBe("12px");
      expect(getComputedStyle(track!).overflow).toBe("hidden");
      expect(
        document
          .querySelector<HTMLElement>('[data-codex-power-slider-frame="true"]')
          ?.getBoundingClientRect().height,
      ).toBe(32);
      expect(
        document
          .querySelector<HTMLElement>('[data-codex-power-visual-slider="true"]')
          ?.getBoundingClientRect().height,
      ).toBe(28);
      const thumb = document.querySelector<HTMLElement>(".composer-codex-power__thumb");
      expect(thumb?.getBoundingClientRect().height).toBe(28);
      expect(thumb?.getBoundingClientRect().width).toBe(28);
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      expect(ticks).toHaveLength(6);
      // Every tick under or before the thumb reads as selected, the rest as unselected.
      expect(ticks.map((tick) => tick.dataset.selected)).toEqual([
        "true",
        "true",
        "true",
        "false",
        "false",
        "false",
      ]);
      const selectedTick = ticks[0]!;
      const unselectedTick = ticks[5]!;
      expect(getComputedStyle(selectedTick).width).toBe("4px");
      expect(getComputedStyle(selectedTick).backgroundColor).toMatch(/^rgba\(255, 255, 255, 0\.3/u);
      expect(getComputedStyle(unselectedTick).backgroundColor).not.toBe(
        getComputedStyle(selectedTick).backgroundColor,
      );
      // The 28px thumb is inset so it overhangs the 24px track by 1px at each end, and the
      // end ticks are pulled inward by the same 13px so nothing is clipped by the track.
      const trackRect = track!.getBoundingClientRect();
      const firstTickRect = selectedTick.getBoundingClientRect();
      const lastTickRect = unselectedTick.getBoundingClientRect();
      expect(firstTickRect.left + firstTickRect.width / 2 - trackRect.left).toBeCloseTo(13, 0);
      expect(trackRect.right - (lastTickRect.left + lastTickRect.width / 2)).toBeCloseTo(13, 0);
      await vi.waitFor(() => {
        const thumbRect = thumb!.getBoundingClientRect();
        // Index 2 of 6 sits at 40%, corrected by the 13px inset scaled toward the middle.
        const expectedCenter = trackRect.left + trackRect.width * 0.4 + 2.6;
        expect(Math.abs(thumbRect.left + thumbRect.width / 2 - expectedCenter)).toBeLessThan(1);
      });
      // The blue range fill is visible and ends under the thumb center.
      const range = document.querySelector<HTMLElement>('[data-codex-power-range="true"]');
      expect(range).not.toBeNull();
      const rangeColor = getComputedStyle(range!).backgroundColor;
      expect(rangeColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(rangeColor).not.toBe("transparent");
      await vi.waitFor(() => {
        const rangeRect = range!.getBoundingClientRect();
        const thumbRect = thumb!.getBoundingClientRect();
        expect(Math.abs(rangeRect.right - (thumbRect.left + thumbRect.width / 2))).toBeLessThan(1);
      });
      expect(document.querySelector('[data-codex-power-max-fill="true"]')).toBeNull();
      expect(
        getComputedStyle(
          document.querySelector<HTMLElement>('[data-codex-power-keyboard-item="true"]')!,
        ).pointerEvents,
      ).toBe("none");
      expect(document.querySelectorAll('[aria-live="polite"]').length).toBe(1);
      expect(
        document.querySelector('[data-codex-power-panel="advanced"]')?.getAttribute("inert"),
      ).toBe("");
      const chevron = document.querySelector<HTMLElement>('[data-codex-power-chevron="true"]');
      expect(readRotationDegrees(chevron!)).toBe(0);

      await page.getByRole("menuitem", { name: "Show advanced options", exact: true }).click();
      expect(picker?.dataset.codexPowerView).toBe("advanced");
      expect(document.querySelector('[data-codex-power-header-controls="true"]')).toHaveAttribute(
        "data-codex-power-controls-state",
        "advanced",
      );
      expect(
        document
          .querySelector<HTMLElement>('[data-codex-power-header-controls="true"]')
          ?.getBoundingClientRect().height,
        // Transformed DOMRects can differ by floating point subtraction noise;
        // keep the 40px contract within 0.0005px, well below one layout subpixel.
      ).toBeCloseTo(40, 3);
      await expect.poll(() => readRotationDegrees(chevron!), { timeout: 1_000 }).toBe(-90);
      expect(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-codex-power-advanced-fixture="true"] [role="menuitem"]',
          ),
        ).map((item) => item.textContent?.trim()),
      ).toEqual(["Model", "Reasoning effort", "Speed"]);
      expect(
        document.querySelector('[data-codex-power-panel="compact"]')?.getAttribute("aria-hidden"),
      ).toBe("true");
      expect(
        document.querySelector('[data-codex-power-panel="compact"]')?.getAttribute("inert"),
      ).toBe("");
      expect(document.querySelector('[data-codex-power-fast-control="true"]')).toHaveAttribute(
        "data-expanded",
        "false",
      );
      expect(document.querySelector('[data-codex-power-toggle="true"]')).toHaveAttribute(
        "aria-hidden",
        "false",
      );
      expect(document.querySelector('[data-codex-power-toggle="true"]')).not.toHaveAttribute(
        "inert",
      );
      expect(document.querySelector('[data-codex-power-fast-control="true"]')).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(document.querySelector('[data-codex-power-fast-control="true"]')).toHaveAttribute(
        "inert",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the frozen tertiary, blue, and purple Fast control states", async () => {
    const rootStyle = document.documentElement.style;
    const variableNames = [
      "--color-text-tertiary",
      "--color-text-foreground-tertiary",
      "--color-chart-blue",
      "--color-chart-purple",
    ];
    const previousValues = new Map(
      variableNames.map((name) => [name, rootStyle.getPropertyValue(name)]),
    );
    rootStyle.setProperty("--color-text-tertiary", "rgb(10, 10, 10)");
    rootStyle.setProperty("--color-text-foreground-tertiary", "rgb(10, 10, 10)");
    rootStyle.setProperty("--color-chart-blue", "rgb(20, 30, 40)");
    rootStyle.setProperty("--color-chart-purple", "rgb(50, 60, 70)");
    const compact = await renderHarness(<PowerHarness />);
    let fastColor = "";
    try {
      const fast = document.querySelector<HTMLElement>('[data-codex-power-fast-item="true"]');
      expect(fast).toHaveAttribute("data-fast-mode-enabled", "false");
      expect(getComputedStyle(fast!).color).toBe("rgb(10, 10, 10)");
      const defaultColor = getComputedStyle(fast!).color;
      await page.getByRole("menuitemcheckbox", { name: "Enable fast mode", exact: true }).click();
      fastColor = getComputedStyle(fast!).color;
      expect(fast).toHaveAttribute("data-fast-mode-enabled", "true");
      expect(fastColor).toBe("rgb(20, 30, 40)");
      expect(fastColor).not.toBe(defaultColor);
    } finally {
      await compact.cleanup();
    }

    const ultraIndex = POWER.choices.findIndex((choice) => choice.isUltra);
    const ultra = await renderHarness(
      <PowerHarness selectedIndex={ultraIndex} initialFastModeEnabled />,
    );
    try {
      const fast = document.querySelector<HTMLElement>('[data-codex-power-fast-item="true"]');
      expect(fast).toHaveAttribute("data-fast-mode-enabled", "true");
      expect(fast).toHaveAttribute("data-max-power-selection", "true");
      expect(getComputedStyle(fast!).color).toBe("rgb(50, 60, 70)");
      expect(getComputedStyle(fast!).color).not.toBe(fastColor);
    } finally {
      await ultra.cleanup();
      for (const [name, value] of previousValues) {
        if (value.length === 0) rootStyle.removeProperty(name);
        else rootStyle.setProperty(name, value);
      }
    }
  });

  it("opens advanced for an unrepresented pair and Reset selects one fallback while staying open", async () => {
    const onChange = vi.fn();
    const onFastModeChange = vi.fn();
    const mounted = await renderHarness(
      <PowerHarness
        selectedIndex={null}
        initialFastModeEnabled
        onChange={onChange}
        onFastModeChange={onFastModeChange}
      />,
    );
    try {
      const picker = document.querySelector<HTMLElement>('[data-codex-power-picker="true"]');
      expect(picker?.dataset.codexPowerView).toBe("advanced");
      expect(document.querySelector('[data-codex-power-header-controls="true"]')).toHaveAttribute(
        "data-codex-power-controls-state",
        "advanced-reset",
      );
      expect(
        document
          .querySelector<HTMLElement>('[data-codex-power-header-controls="true"]')
          ?.getBoundingClientRect().height,
      ).toBe(32);
      expect(onChange).not.toHaveBeenCalled();
      await page.getByRole("menuitem", { name: "Reset to default", exact: true }).click();
      expect(onChange).toHaveBeenCalledOnce();
      expect(onFastModeChange).not.toHaveBeenCalled();
      expect(
        page.getByRole("menuitemcheckbox", { name: "Enable standard mode", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      expect(picker?.dataset.codexPowerView).toBe("compact");
      expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("steps with the hidden Power menu item, announces status, keeps pointer changes open, and toggles Fast independently", async () => {
    const onChange = vi.fn();
    const onFastModeChange = vi.fn();
    const mounted = await renderHarness(
      <PowerHarness onChange={onChange} onFastModeChange={onFastModeChange} />,
    );
    try {
      const keyboardItem = document.querySelector<HTMLElement>(
        '[data-codex-power-keyboard-item="true"]',
      );
      expect(keyboardItem).not.toBeNull();
      keyboardItem?.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).toHaveBeenCalledOnce();
      expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toContain(
        "of 6",
      );
      await page.getByRole("menuitemcheckbox", { name: "Enable fast mode", exact: true }).click();
      expect(onFastModeChange).toHaveBeenCalledOnce();
      const fastItem = page.getByRole("menuitemcheckbox", {
        name: "Enable standard mode",
        exact: true,
      });
      const descriptionId = fastItem.element().getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      expect(document.getElementById(descriptionId!)).toHaveTextContent("More usage");
      await fastItem.hover();
      await expect
        .poll(
          () =>
            Array.from(document.querySelectorAll<HTMLElement>('[data-slot="tooltip-popup"]')).some(
              (popup) =>
                popup.textContent?.includes("1.5x speed") &&
                popup.textContent?.includes("More usage"),
            ),
          { timeout: 1_000 },
        )
        .toBe(true);
      expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
      keyboardItem?.focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => document.querySelector('[data-slot="menu-popup"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the picker open for pointer/track and wheel changes and exposes endpoint labels", async () => {
    const onChange = vi.fn();
    const mounted = await renderHarness(<PowerHarness onChange={onChange} />);
    try {
      const frame = document.querySelector<HTMLElement>('[data-codex-power-visual-slider="true"]');
      expect(frame).not.toBeNull();
      vi.spyOn(frame!, "setPointerCapture").mockImplementation(() => {});
      const track = document.querySelector<HTMLElement>(".composer-codex-power__track");
      expect(track?.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(track?.getBoundingClientRect().height).toBe(24);
      const rect = track!.getBoundingClientRect();
      // Pressing on the current thumb position does not change the value by itself.
      const thumbX = rect.left + rect.width * 0.4 + 2.6;
      const centerY = rect.top + rect.height / 2;
      frame?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: thumbX,
          clientY: centerY,
        }),
      );
      expect(onChange).not.toHaveBeenCalled();
      frame?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: 1,
          clientX: thumbX + 5,
          clientY: centerY,
        }),
      );
      const endpoints = document.querySelector<HTMLElement>('[data-codex-power-endpoints="true"]');
      expect(endpoints).not.toBeNull();
      await vi.waitFor(() => {
        expect(getComputedStyle(endpoints!).opacity).toBe("1");
      });
      expect(document.querySelector('[data-codex-power-toggle="true"]')).toHaveAttribute(
        "data-expanded",
        "false",
      );
      expect(document.querySelector('[data-codex-power-fast-control="true"]')).toHaveAttribute(
        "data-expanded",
        "false",
      );
      frame?.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: thumbX + 5, clientY: centerY }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-codex-power-endpoints="true"]')).toHaveAttribute(
          "data-expanded",
          "false",
        );
      });
      expect(document.querySelector('[data-codex-power-toggle="true"]')).toHaveAttribute(
        "data-expanded",
        "true",
      );

      frame?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: thumbX,
          clientY: centerY,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 170));
      expect(document.querySelector('[data-codex-power-endpoints="true"]')).toHaveAttribute(
        "data-expanded",
        "true",
      );
      frame?.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: thumbX, clientY: centerY }),
      );

      // Tapping a tick jumps straight to it and keeps the menu open.
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      const targetTick = ticks[4]!;
      const tickRect = targetTick.getBoundingClientRect();
      targetTick.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: tickRect.left + tickRect.width / 2,
          clientY: tickRect.top + tickRect.height / 2,
        }),
      );
      targetTick.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: tickRect.left + tickRect.width / 2,
          clientY: tickRect.top + tickRect.height / 2,
        }),
      );
      expect(onChange).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(document.querySelector("[data-codex-power-selected]")?.textContent).toBe(
          "5.6 Sol Extra High",
        );
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
      // Tick fills follow the new position.
      expect(ticks.map((tick) => tick.dataset.selected)).toEqual([
        "true",
        "true",
        "true",
        "true",
        "true",
        "false",
      ]);

      const beforeWheel = onChange.mock.calls.length;
      const belowThreshold = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 10,
      });
      frame?.dispatchEvent(belowThreshold);
      expect(belowThreshold.defaultPrevented).toBe(true);
      expect(onChange.mock.calls.length).toBe(beforeWheel);

      const reachesThreshold = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 20,
      });
      frame?.dispatchEvent(reachesThreshold);
      expect(reachesThreshold.defaultPrevented).toBe(true);
      expect(onChange.mock.calls.length).toBe(beforeWheel + 1);

      const largeDelta = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 60,
      });
      frame?.dispatchEvent(largeDelta);
      expect(onChange.mock.calls.length).toBe(beforeWheel + 2);

      const ctrlWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: 120,
      });
      frame?.dispatchEvent(ctrlWheel);
      expect(ctrlWheel.defaultPrevented).toBe(false);
      expect(onChange.mock.calls.length).toBe(beforeWheel + 2);

      frame?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -30 }),
      );
      const invertedWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 30,
      });
      Object.defineProperty(invertedWheel, "webkitDirectionInvertedFromDevice", { value: true });
      frame?.dispatchEvent(invertedWheel);
      expect(onChange.mock.calls.length).toBe(beforeWheel + 4);
      // Down, down, (ctrl ignored), up, inverted-up: back where the tick tap left us.
      await vi.waitFor(() => {
        expect(document.querySelector("[data-codex-power-selected]")?.textContent).toBe(
          "5.6 Sol Extra High",
        );
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("announces Ultra for a real drag and restores the controls row after two seconds", async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    const onChange = vi.fn();
    const mounted = await renderHarness(<PowerHarness selectedIndex={0} onChange={onChange} />);
    try {
      const control = document.querySelector<HTMLElement>(
        '[data-codex-power-visual-slider="true"]',
      );
      expect(control).not.toBeNull();
      expect(control).toHaveAttribute("data-max", "false");
      const rect = control!.getBoundingClientRect();
      const pointerId = 41;
      vi.spyOn(control!, "setPointerCapture").mockImplementation(() => {});
      control!.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          clientX: rect.left + 1,
          clientY: rect.top + rect.height / 2,
          pointerId,
          pointerType: "mouse",
        }),
      );
      for (const offset of [0.35, 0.7, 0.98]) {
        document.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            buttons: 1,
            clientX: rect.left + rect.width * offset,
            clientY: rect.top + rect.height / 2,
            pointerId,
            pointerType: "mouse",
          }),
        );
      }
      await vi.waitFor(() => {
        expect(document.querySelector('[data-codex-power-warning-control="true"]')).toHaveAttribute(
          "data-expanded",
          "true",
        );
      });
      expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toContain(
        "Consumes usage limits faster",
      );
      expect(onChange).toHaveBeenCalled();
      expect(control).toHaveAttribute("data-max", "true");
      expect(control).toHaveAttribute("data-dragging", "true");
      expect(control).toHaveAttribute("data-endpoint-labels-visible", "true");
      // Reaching Ultra by hand paints the purple field and fires the thumb burst once.
      expect(document.querySelector('[data-codex-power-max-fill="true"]')).toHaveAttribute(
        "data-reveal",
        "true",
      );
      expect(document.querySelectorAll('[data-codex-power-max-burst="true"] > span').length).toBe(
        16,
      );
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      expect(ticks.every((tick) => tick.dataset.selected === "true")).toBe(true);
      await vi.waitFor(() => {
        expect(getComputedStyle(ticks[0]!).opacity).toBe("0");
      });
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: rect.right - 1,
          clientY: rect.top + rect.height / 2,
          pointerId,
          pointerType: "mouse",
        }),
      );
      document.querySelector<HTMLElement>('[data-codex-power-slider-frame="true"]')?.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: rect.right - 1,
          clientY: rect.top + rect.height / 2,
          pointerId,
          pointerType: "mouse",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_050));
      expect(document.querySelector('[data-codex-power-warning-control="true"]')).toHaveAttribute(
        "data-expanded",
        "false",
      );
      expect(document.querySelector(".composer-codex-power__fast-item")).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("matches frozen top/bottom and RTL chevron placement", async () => {
    const cases = [
      { side: "top" as const, direction: "ltr" as const, advancedRotation: -90 },
      { side: "bottom" as const, direction: "ltr" as const, advancedRotation: 90 },
      { side: "top" as const, direction: "rtl" as const, advancedRotation: 90 },
    ];
    for (const testCase of cases) {
      const mounted = await renderHarness(
        <PowerHarness side={testCase.side} />,
        "en",
        testCase.direction,
      );
      try {
        const positioner = document.querySelector<HTMLElement>('[data-slot="menu-positioner"]');
        expect(positioner?.getAttribute("data-side")).toBe(testCase.side);
        const chevron = document.querySelector<HTMLElement>('[data-codex-power-chevron="true"]');
        expect(readRotationDegrees(chevron!)).toBe(0);
        const toggleControl = document.querySelector<HTMLElement>(
          '[data-codex-power-toggle="true"]',
        );
        const fastControl = document.querySelector<HTMLElement>(
          '[data-codex-power-fast-control="true"]',
        );
        const endpointControl = document.querySelector<HTMLElement>(
          '[data-codex-power-endpoints="true"]',
        );
        const warningControl = document.querySelector<HTMLElement>(
          '[data-codex-power-warning-control="true"]',
        );
        const compactOffset = testCase.side === "top" ? 0 : 4;
        expect(
          document
            .querySelector<HTMLElement>('[data-codex-power-panel="compact"]')
            ?.getBoundingClientRect().height,
        ).toBe(testCase.side === "top" ? 40 : 36);
        expect(readTranslateY(toggleControl!)).toBe(compactOffset);
        expect(readTranslateY(endpointControl!)).toBe(compactOffset);
        expect(readTranslateY(warningControl!)).toBe(compactOffset);
        expect(readTranslateY(fastControl!)).toBe(compactOffset);
        await page.getByRole("menuitem", { name: "Show advanced options", exact: true }).click();
        await expect
          .poll(() => readRotationDegrees(chevron!), { timeout: 1_000 })
          .toBe(testCase.advancedRotation);
        // Expanded, the Advanced toggle sits 4px lower when the menu opens upward so it
        // clears the divider above the compact panel; the Fast toggle keeps its offset.
        await expect
          .poll(() => readTranslateY(toggleControl!), { timeout: 1_000 })
          .toBe(testCase.side === "top" ? 4 : 0);
        await expect
          .poll(() => readTranslateY(fastControl!), { timeout: 1_000 })
          .toBe(testCase.side === "top" ? 0 : 4);
      } finally {
        await mounted.cleanup();
      }
    }
  });

  it("renders English and Simplified Chinese labels with top-side placement", async () => {
    for (const locale of ["en" as const, "zh-CN" as const]) {
      const mounted = await renderHarness(<PowerHarness locale={locale} />, locale);
      try {
        expect(
          document
            .querySelector('[data-codex-power-keyboard-item="true"]')
            ?.getAttribute("aria-label"),
        ).toBe(locale === "en" ? "Power" : "功率");
        expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toContain(
          locale === "en" ? "Standard" : "标准",
        );
        const positioner = document.querySelector<HTMLElement>('[data-slot="menu-positioner"]');
        expect(positioner?.getAttribute("data-side")).toBe("top");
      } finally {
        await mounted.cleanup();
      }
    }
  });

  it("speaks another vendor's effort vocabulary through localizeEffortLabel", async () => {
    const claude = resolveComposerPowerOptions({
      provider: "claudeAgent",
      model: "claude-opus-4-8",
      modelLabel: "Opus 4.8",
      optionId: "effort",
      effortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
      effort: "high",
      defaultEffort: "medium",
    });
    const zh: Record<string, string> = { low: "低", medium: "中等", high: "高", max: "最大" };
    const onChange = vi.fn();
    const mounted = await renderHarness(
      <PowerHarness
        power={claude}
        localizeEffortLabel={(choice) => zh[choice.reasoningEffort] ?? choice.effortLabel}
        onChange={onChange}
      />,
    );
    try {
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      expect(ticks).toHaveLength(4);
      expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toBe(
        "Opus 4.8 高, 3 of 4.",
      );
      // "max" is not Codex Ultra: no usage warning, no purple field, no ultra tick class.
      expect(ticks[3]).not.toHaveClass("composer-codex-power__tick--ultra");
      const keyboardItem = document.querySelector<HTMLElement>(
        '[data-codex-power-keyboard-item="true"]',
      );
      keyboardItem?.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange.mock.calls[0]?.[0]).toMatchObject({
        model: "claude-opus-4-8",
        optionId: "effort",
        reasoningEffort: "max",
        isUltra: false,
      });
      await vi.waitFor(() => {
        expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toBe(
          "Opus 4.8 最大, 4 of 4.",
        );
      });
      expect(document.querySelector('[data-codex-power-max-fill="true"]')).toBeNull();
      expect(document.querySelector('[data-codex-power-warning-control="true"]')).toHaveAttribute(
        "data-expanded",
        "false",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the vendor label for efforts Codex has no name for", async () => {
    const withMax = resolveComposerPowerOptions({
      provider: "codex",
      model: "gpt-5.5",
      modelLabel: "5.5",
      optionId: "reasoningEffort",
      effortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
      effort: "max",
      runtimeModels: [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          supportedReasoningEfforts: [
            { value: "low" },
            { value: "medium" },
            { value: "high" },
            { value: "max" },
          ],
        },
      ],
    });
    const mounted = await renderHarness(<PowerHarness power={withMax} />);
    try {
      // Known efforts use Codex's Light/Standard/Extended names; "max" keeps its own label.
      expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toBe(
        "5.5 Max, 4 of 4.",
      );
      const keyboardItem = document.querySelector<HTMLElement>(
        '[data-codex-power-keyboard-item="true"]',
      );
      keyboardItem?.focus();
      await userEvent.keyboard("{ArrowLeft}");
      await vi.waitFor(() => {
        expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toBe(
          "5.5 Extended, 3 of 4.",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the compact surface for a two-stop ladder", async () => {
    const twoStop = resolveComposerPowerOptions({
      provider: "gemini",
      model: "gemini-3-pro",
      modelLabel: "Gemini 3 Pro",
      optionId: "thinkingLevel",
      effortLevels: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      effort: "low",
    });
    const mounted = await renderHarness(
      <PowerHarness power={twoStop} localizeEffortLabel={(choice) => choice.effortLabel} />,
    );
    try {
      expect(document.querySelector('[data-codex-power-picker="true"]')).not.toBeNull();
      expect(document.querySelectorAll("[data-codex-power-tick]")).toHaveLength(2);
      expect(document.querySelector("[data-codex-power-live-status]")?.textContent).toBe(
        "Gemini 3 Pro Low, 1 of 2.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dismisses the Ultra warning as soon as a lower stop is chosen", async () => {
    const ultraIndex = POWER.choices.findIndex((choice) => choice.isUltra);
    const mounted = await renderHarness(<PowerHarness selectedIndex={ultraIndex - 1} />);
    try {
      const slider = document.querySelector<HTMLElement>(
        '[data-codex-power-visual-slider="true"]',
      )!;
      vi.spyOn(slider, "setPointerCapture").mockImplementation(() => {});
      const ticks = Array.from(document.querySelectorAll<HTMLElement>("[data-codex-power-tick]"));
      const rect = slider.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const at = (index: number) => ticks[index]!.getBoundingClientRect().left + 2;
      // Drag from Extra High onto Ultra so the warning fires...
      slider.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: at(ultraIndex - 1),
          clientY: y,
        }),
      );
      slider.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: 1,
          clientX: at(ultraIndex),
          clientY: y,
        }),
      );
      slider.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: at(ultraIndex), clientY: y }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-codex-power-warning-control="true"]')).toHaveAttribute(
          "data-expanded",
          "true",
        );
      });
      // ...then tap Standard well before the 2s timer: the warning goes away immediately.
      slider.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: at(2),
          clientY: y,
        }),
      );
      slider.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: at(2), clientY: y }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-codex-power-warning-control="true"]')).toHaveAttribute(
          "data-expanded",
          "false",
        );
        expect(document.querySelector('[data-codex-power-toggle="true"]')).toHaveAttribute(
          "data-expanded",
          "true",
        );
      });
      expect(document.querySelector("[data-codex-power-selected]")?.textContent).toBe(
        "5.6 Sol Standard",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("removes picker motion when reduced motion is requested", async () => {
    await motionCommands.emulateReducedMotion("reduce");
    const mounted = await renderHarness(<PowerHarness />);
    try {
      const picker = document.querySelector<HTMLElement>('[data-codex-power-picker="true"]');
      const panelTrack = document.querySelector<HTMLElement>(
        '[data-codex-power-panel-track="true"]',
      );
      expect(getComputedStyle(picker!).transitionDuration).toBe("0s");
      expect(getComputedStyle(panelTrack!).transitionDuration).toBe("0s");
      expect(
        getComputedStyle(document.querySelector<HTMLElement>(".composer-codex-power__thumb")!)
          .transitionDuration,
      ).toBe("0s");
    } finally {
      await mounted.cleanup();
      await motionCommands.emulateReducedMotion("no-preference");
    }
  });
});
