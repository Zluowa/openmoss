// FILE: SubagentMark.browser.tsx
// Purpose: What a person sees of the subagent marks, read back from real Chromium paint: at 16 px
//          in light and dark every mark paints, two agents in a row differ in colour, eighteen
//          agents wear eighteen marks that differ pixel by pixel, the transcript row shows the
//          marks in order of first appearance, and the pinwheel turns only while its agent works
//          (never under reduced motion).
// Layer: Web browser test

import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { captureViewportPixels, type ViewportPixels } from "../../test/themeHookPaint";
import { InlineSubagentActivity } from "./InlineSubagentActivity";
import { SubagentMark } from "./SubagentMark";
import { SUBAGENT_MARK_TONES } from "~/theme/subagentMarkColors";

import {
  registerSubagentMarkOrder,
  resetSubagentMarkOrderForTests,
  subagentMarkAppearance,
} from "./subagentMarkOrder";

const motion = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};

const AGENTS = Array.from({ length: 18 }, (_, index) => `019a${index.toString(16)}-agent-thread`);

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

function drawing(testId: string): Element {
  return document.querySelector(`[data-testid="${testId}"] svg`)!;
}

function setTheme(theme: "light" | "dark") {
  // As the app shell does (apps/web/index.html): body declares both schemes, so only the
  // root's .dark class tells the theme apart, never the system preference.
  document.body.style.colorScheme = "light dark";
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function linear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** OKLab a/b hue angle of an sRGB colour, in degrees. */
function hueOf([r, g, b]: readonly number[]): number {
  const [lr, lg, lb] = [linear(r!), linear(g!), linear(b!)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

/** The mark's box as device pixels (RGB), straight from the screenshot. */
function boxPixels(pixels: ViewportPixels, element: Element): number[][] {
  const rect = element.getBoundingClientRect();
  const out: number[][] = [];
  const x0 = Math.round(rect.left * pixels.scale);
  const y0 = Math.round(rect.top * pixels.scale);
  const size = Math.round(rect.width * pixels.scale);
  for (let y = y0; y < y0 + size; y += 1) {
    for (let x = x0; x < x0 + size; x += 1) {
      const offset = (y * pixels.width + x) * 4;
      out.push([pixels.data[offset]!, pixels.data[offset + 1]!, pixels.data[offset + 2]!]);
    }
  }
  return out;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

async function renderFamily(theme: "light" | "dark") {
  setTheme(theme);
  await page.viewport(900, 300);
  registerSubagentMarkOrder(
    "parent-chat",
    AGENTS.map((threadId) => ({ subagents: [{ threadId }] })),
  );
  await render(
    <div style={{ background: "var(--background)", padding: 24, display: "flex", gap: 8 }}>
      {AGENTS.map((seed) => (
        <SubagentMark key={seed} seed={seed} data-testid="mark" />
      ))}
      <span data-testid="background" className="inline-block size-4" />
    </div>,
  );
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  const marks = [...document.querySelectorAll('[data-testid="mark"]')];
  const pixels = await captureViewportPixels();
  const background = boxPixels(pixels, document.querySelector('[data-testid="background"]')!)[0]!;
  return { marks, pixels, background };
}

afterEach(async () => {
  setTheme("light");
  resetSubagentMarkOrderForTests();
  await motion.emulateReducedMotion("no-preference");
  document.body.innerHTML = "";
});

describe("subagent marks", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`paint at 16 px, change colour from one agent to the next and all differ (${theme})`, async () => {
      const { marks, pixels, background } = await renderFamily(theme);
      expect(marks).toHaveLength(18);
      // Each part paints the tone of this theme (the app's .dark class), not the other theme's.
      for (const [index, mark] of marks.entries()) {
        const tone = SUBAGENT_MARK_TONES[subagentMarkAppearance(index).tone]![theme];
        const fills = new Set(
          [...mark.querySelectorAll("path")].map((path) => getComputedStyle(path).fill),
        );
        expect(fills, `mark ${index}`).toEqual(new Set([rgb(tone.face), rgb(tone.fold)]));
      }
      const boxes = marks.map((mark) => {
        expect([(mark as HTMLElement).offsetWidth, (mark as HTMLElement).offsetHeight]).toEqual([
          16, 16,
        ]);
        return boxPixels(pixels, mark);
      });

      // Each mark paints a real share of its box, in colour that stands out from the page.
      const hues: number[] = [];
      for (const [index, box] of boxes.entries()) {
        const painted = box.filter((pixel) => distance(pixel, background) > 60);
        expect(painted.length / box.length, `mark ${index}`).toBeGreaterThan(0.25);
        const mean = [0, 1, 2].map(
          (channel) => painted.reduce((sum, pixel) => sum + pixel[channel]!, 0) / painted.length,
        );
        hues.push(hueOf(mean));
      }

      // Two agents in a row never share a colour family.
      for (let index = 1; index < hues.length; index += 1) {
        const gap = Math.abs(hues[index]! - hues[index - 1]!);
        expect(Math.min(gap, 360 - gap), `agents ${index} and ${index + 1}`).toBeGreaterThan(60);
      }

      // Every pair of the eighteen differs pixel by pixel (mean RGB distance, 0..1).
      let closest = Infinity;
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const sum = boxes[a]!.reduce(
            (total, pixel, offset) => total + distance(pixel, boxes[b]![offset]!) / 441.7,
            0,
          );
          closest = Math.min(closest, sum / boxes[a]!.length);
        }
      }
      expect(closest).toBeGreaterThan(0.06);
    });
  }

  it("shows the transcript row's marks in order of first appearance", async () => {
    registerSubagentMarkOrder("parent-chat", [
      { subagents: [{ threadId: "maple" }] },
      { subagents: [{ threadId: "cedar" }, { threadId: "birch" }, { threadId: "rowan" }] },
    ]);
    await render(
      <InlineSubagentActivity
        status="active"
        items={["cedar", "birch", "maple", "rowan"].map((id) => ({
          id,
          label: id,
          accentColor: "default",
        }))}
      />,
    );
    const chips = [...document.querySelectorAll("[data-subagent-chip]")];
    expect(chips.map((chip) => chip.getAttribute("data-subagent-mark-index"))).toEqual([
      "1",
      "2",
      "0",
      "3",
    ]);
    const outlines = new Set(chips.map((chip) => chip.getAttribute("data-subagent-mark-shape")));
    expect(outlines.size).toBe(4);
  });

  it("turns while its subagent works, and stays still under reduced motion", async () => {
    await render(
      <div>
        <SubagentMark seed="working" running data-testid="running" />
        <SubagentMark seed="resting" data-testid="resting" />
      </div>,
    );
    await expect
      .poll(() =>
        drawing("running")
          .getAnimations()
          .map((animation) => animation.playState),
      )
      .toEqual(["running"]);
    expect(drawing("resting").getAnimations()).toHaveLength(0);

    await motion.emulateReducedMotion("reduce");
    await expect.poll(() => drawing("running").getAnimations()).toHaveLength(0);
  });
});
