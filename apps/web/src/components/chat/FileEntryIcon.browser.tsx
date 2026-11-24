// FILE: FileEntryIcon.browser.tsx
// Purpose: The dock's file list as a person sees it (WALK-2 N2-3): every file type in one line
//          glyph style and one muted colour, the folder's colour.
// Layer: Browser UI test

import "../../index.css";

import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { FileEntryIcon } from "./FileEntryIcon";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
});

const FILES = ["data.json", "index.js", "photo.png", "README.md", "style.css"];

it.each(["light", "dark"] as const)(
  "draws json, js, png, md and css icons in the folder's muted colour (%s)",
  async (mode) => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    await render(
      <ul>
        <li data-probe="folder">
          <FileEntryIcon pathValue="demo" kind="directory" />
        </li>
        {FILES.map((file) => (
          <li key={file} data-probe={file}>
            <FileEntryIcon pathValue={file} kind="file" />
          </li>
        ))}
      </ul>,
    );
    const glyph = (probe: string) =>
      document.querySelector<HTMLElement>(`[data-probe="${probe}"]`)!.firstElementChild!;
    const folderColor = getComputedStyle(glyph("folder")).color;
    for (const file of FILES) {
      const icon = glyph(file);
      expect(icon.getBoundingClientRect().width, file).toBeGreaterThan(0);
      expect(getComputedStyle(icon).color, file).toBe(folderColor);
      expect((icon as HTMLElement).style.color, file).toBe("");
    }
  },
);

it("draws each file kind as a line glyph: the mask it paints is strokes, never a filled mark", async () => {
  await render(
    <ul>
      {FILES.map((file) => (
        <li key={file} data-probe={file}>
          <FileEntryIcon pathValue={file} kind="file" />
        </li>
      ))}
    </ul>,
  );
  for (const file of FILES) {
    const icon = document.querySelector<HTMLElement>(`[data-probe="${file}"]`)!.firstElementChild!;
    const style = getComputedStyle(icon);
    const mask =
      style.getPropertyValue("mask-image") || style.getPropertyValue("-webkit-mask-image");
    const url = /url\("?([^")]+)"?\)/.exec(mask)?.[1];
    expect(url, file).toBeTruthy();
    const svg = new DOMParser().parseFromString(await (await fetch(url!)).text(), "image/svg+xml");
    const shapes = [
      ...svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon"),
    ];
    expect(shapes.length, file).toBeGreaterThan(0);
    // Outline: every shape is stroked; nothing paints a solid fill (the old JS tile, JSON spiral).
    for (const shape of shapes) {
      const stroke =
        shape.getAttribute("stroke") ?? shape.closest("[stroke]")?.getAttribute("stroke");
      expect(stroke, `${file} stroke`).toBeTruthy();
      const fill = shape.getAttribute("fill") ?? shape.closest("[fill]")?.getAttribute("fill");
      expect(fill === null || fill === "none", `${file} fill=${fill}`).toBe(true);
    }
  }
});
