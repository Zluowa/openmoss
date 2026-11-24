// FILE: ApprovalAppDock.browser.tsx
// Purpose: What a person sees of the command approval card's leading mark: one drawn Moss tile
//          (a terminal window), not pictures of other apps, with ink that stands out from the
//          tile in light and dark, in the real approval card.
// Layer: Web browser test (real Chromium paint, read back from a screenshot)

import "../../index.css";

import { ApprovalRequestId } from "@moss/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { captureViewportPixels, type ViewportPixels } from "../../test/themeHookPaint";
import { ApprovalAppDock } from "./ApprovalAppDock";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

function luminance([r, g, b]: readonly number[]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function pixelAt(pixels: ViewportPixels, x: number, y: number): number[] {
  const offset = (Math.round(y * pixels.scale) * pixels.width + Math.round(x * pixels.scale)) * 4;
  return [...pixels.data.subarray(offset, offset + 3)];
}

/** The strongest contrast between `base` and any pixel inside `rect`. */
function strongestContrast(pixels: ViewportPixels, rect: DOMRect, base: number[]): number {
  let best = 1;
  for (let y = rect.top + 1; y < rect.bottom - 1; y += 0.5) {
    for (let x = rect.left + 1; x < rect.right - 1; x += 0.5) {
      best = Math.max(best, contrast(base, pixelAt(pixels, x, y)));
    }
  }
  return best;
}

/**
 * The tile is drawn as designed, not merely dark ink somewhere: the window body (viewBox point
 * 14,6, away from the prompt and the cursor) is clear, close to the tile's own fill; that fill
 * is the raised surface, set apart from what is around the tile; and the ink stands out from
 * it. An unstyled SVG (a filled black window, or no tile fill) fails in both themes.
 */
function expectDrawnTile(pixels: ViewportPixels, tile: HTMLElement) {
  const box = tile.getBoundingClientRect();
  const glyph = tile.querySelector("svg")!.getBoundingClientRect();
  const unit = glyph.width / 20;
  const tileFill = pixelAt(pixels, (box.left + glyph.left) / 2, box.top + box.height / 2);
  const around = pixelAt(pixels, box.left - 4, box.top + box.height / 2);
  const windowBody = pixelAt(pixels, glyph.left + 14 * unit, glyph.top + 6 * unit);
  expect(contrast(windowBody, tileFill), "window body is clear").toBeLessThan(1.5);
  const apart = Math.max(...tileFill.map((value, index) => Math.abs(value - around[index]!)));
  expect(apart, "tile fill is set apart from its surroundings").toBeGreaterThanOrEqual(2);
  expect(strongestContrast(pixels, glyph, tileFill), "ink stands out").toBeGreaterThanOrEqual(4.5);
}

const setTheme = (theme: "light" | "dark") =>
  document.documentElement.classList.toggle("dark", theme === "dark");

afterEach(() => {
  setTheme("light");
  document.body.innerHTML = "";
});

describe("command approval mark", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`draws a terminal tile whose ink stands out (${theme})`, async () => {
      setTheme(theme);
      await page.viewport(800, 600);
      // Drawn large (zoom 4): the tile is vector art, so contrast does not depend on size.
      await render(
        <div style={{ background: "var(--background)", padding: 24 }}>
          <div style={{ zoom: 4 }}>
            <ApprovalAppDock />
          </div>
        </div>,
      );
      const tile = document.querySelector<HTMLElement>("[data-approval-command-mark]")!;
      const box = tile.getBoundingClientRect();
      expect([Math.round(box.width), Math.round(box.height)]).toEqual([128, 128]);
      // Drawn here, not a picture loaded from elsewhere.
      expect(tile.querySelector("img")).toBeNull();
      expectDrawnTile(await captureViewportPixels(), tile);
    });

    it(`leads the real command approval card (${theme})`, async () => {
      setTheme(theme);
      await page.viewport(720, 300);
      await render(
        <div style={{ background: "var(--background)", padding: 24 }} className="w-[640px]">
          <ComposerPendingApprovalPanel
            approval={{
              requestId: ApprovalRequestId.makeUnsafe("approval-originals"),
              lifecycleGeneration: "generation-originals",
              requestKind: "command",
              createdAt: "2026-11-18T08:00:00.000Z",
              detail: 'Bash: {"command":"bun run test"}',
            }}
            pendingCount={1}
            isResponding={false}
            onRespond={async () => undefined}
          />
        </div>,
      );
      const dock = document.querySelector<HTMLElement>("[data-approval-app-dock]")!;
      expect(dock.querySelectorAll("img")).toHaveLength(0);
      const tile = dock.querySelector<HTMLElement>("[data-approval-command-mark]")!;
      expect(tile.getBoundingClientRect().width).toBe(32);
      // It sits on the card's action row, before Deny.
      const deny = [...document.querySelectorAll("button")].find((b) =>
        /Deny|拒绝/.test(b.textContent ?? ""),
      );
      expect(deny).toBeTruthy();
      expect(tile.getBoundingClientRect().right).toBeLessThan(deny!.getBoundingClientRect().left);
      // The command reads on its box, and the box is the card's own raised surface: never a
      // light box on the dark card.
      const code = document.querySelector<HTMLElement>('[data-approval-command="true"]')!;
      expect(code.innerText).toBe('Bash: {"command":"bun run test"}');
      const pixels = await captureViewportPixels();
      const codeBox = code.getBoundingClientRect();
      const boxColor = pixelAt(pixels, codeBox.left - 3, codeBox.top + codeBox.height / 2);
      const cardColor = pixelAt(
        pixels,
        tile.getBoundingClientRect().left - 6,
        tile.getBoundingClientRect().top - 6,
      );
      expect(contrast(boxColor, cardColor)).toBeLessThan(1.5);
      expect(strongestContrast(pixels, codeBox, boxColor)).toBeGreaterThanOrEqual(4.5);
      expectDrawnTile(pixels, tile);
      await page.screenshot({ path: `__screenshots__/moss-originals/approval-card-${theme}.png` });
    });
  }
});
