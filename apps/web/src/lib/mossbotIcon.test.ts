// FILE: mossbotIcon.test.ts
// Purpose: Keeps Mossbot's own mark on Central's grid and stroke, and keeps every place that
//          shows the mark on the one asset.
// Layer: Web icon tests

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { railItemGlyphs } from "~/components/AppRail";
import { MossbotIcon } from "./icons";

const webRoot = path.resolve(import.meta.dirname, "../..");
const asset = readFileSync(path.join(webRoot, "public/moss-icons/mossbot.svg"), "utf8");

describe("Mossbot mark", () => {
  it("is drawn to Central's spec: 24 grid, 1.5 stroke, current colour only", () => {
    expect(asset).toContain('viewBox="0 0 24 24"');
    const widths = [...asset.matchAll(/stroke-width="([^"]+)"/g)].map((match) => match[1]);
    expect(widths.length).toBeGreaterThan(0);
    expect(new Set(widths)).toEqual(new Set(["1.5"]));
    const colours = [...asset.matchAll(/(?:stroke|fill)="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(colours)).toEqual(new Set(["none", "currentColor"]));
    // Every stroke stays inside the 24px box with the stroke's own half-width to spare.
    const numbers = [...asset.matchAll(/d="([^"]+)"/g)]
      .flatMap((match) => match[1]!.match(/-?\d+(?:\.\d+)?/g) ?? [])
      .map(Number);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0.75);
    expect(Math.max(...numbers)).toBeLessThanOrEqual(23.25);
  });

  it("paints the Moss asset through the shared icon path", () => {
    const markup = renderToStaticMarkup(createElement(MossbotIcon, { className: "size-5" }));
    expect(markup).toContain("/moss-icons/mossbot.svg");
    expect(markup).toContain('data-slot="central-icon"');
  });

  it("is the rail glyph, idle and active alike", () => {
    const glyphs = railItemGlyphs("mossbot");
    expect(glyphs.idle).toBe(MossbotIcon);
    expect(glyphs.active).toBe(MossbotIcon);
  });
});
