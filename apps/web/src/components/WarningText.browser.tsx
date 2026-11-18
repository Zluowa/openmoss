// FILE: WarningText.browser.tsx
// Purpose: Warning text (`text-warning`, `--color-text-warning`) is Moss's own amber and stays
//          readable on the app's surface in light and dark, through the real theme store.
// Layer: Web browser test

import "../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserThemeFixture, installBrowserFixtureTheme } from "../test/browserThemeFixture";

/** sRGB channels 0-255 from a computed colour: rgb(), rgba() or color(srgb …). */
function channels(color: string): [number, number, number] {
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(color);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  const rgb = /rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`Unreadable colour ${color}`);
}

function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = channels(color).map((value) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  document.body.innerHTML = "";
});

describe("warning text", () => {
  for (const variant of ["light", "dark"] as const) {
    it(`is Moss's amber and readable on the surface (${variant})`, async () => {
      restore = installBrowserFixtureTheme(variant);
      await render(
        <BrowserThemeFixture>
          <div data-testid="surface" style={{ background: "var(--background)", padding: 16 }}>
            <span data-testid="warning" className="text-warning">
              需要你的确认
            </span>
          </div>
        </BrowserThemeFixture>,
      );
      await expect
        .poll(() => document.documentElement.classList.contains("dark"))
        .toBe(variant === "dark");
      const warning = getComputedStyle(document.querySelector('[data-testid="warning"]')!).color;
      const surface = getComputedStyle(
        document.querySelector('[data-testid="surface"]')!,
      ).backgroundColor;
      expect(contrast(warning, surface)).toBeGreaterThanOrEqual(4.5);
      // An amber: red well above blue, not the surface's own ink.
      const [r, , b] = channels(warning);
      expect(r - b).toBeGreaterThan(60);
    });
  }
});
