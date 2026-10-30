import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { readPresentation } from "./presentationModel";

function fixture(name: string) {
  const bytes = readFileSync(new URL(`./__fixtures__/${name}.pptx`, import.meta.url));
  return Uint8Array.from(bytes).buffer;
}

describe("PPTX package preview", () => {
  it("uses the relationship order and authored 4:3 size of a real reordered PPTX", async () => {
    const preview = await readPresentation(fixture("presentation-reordered"));
    try {
      expect(preview.slides).toHaveLength(3);
      expect(preview.width).toBe(960);
      expect(preview.height).toBe(720);
      expect(preview.slides[0]?.text).toContain("THIRD SLIDE");
      expect(preview.slides[1]?.text).toContain("FIRST SLIDE");
      expect(preview.slides[2]?.notes).toContain("green ellipse");
      expect(preview.slides[0]?.notes).toContain("appear first");
    } finally {
      preview.dispose();
    }
  });

  it("renders actual master, image, chart and table elements, including an image-only body", async () => {
    const preview = await readPresentation(fixture("presentation-original"));
    try {
      const first = preview.render(0);
      const svg = await (await fetch(first.url)).text();
      expect(svg).toContain("MASTER STAMP");
      expect(svg).toContain("FIRST SLIDE");
      expect(svg).toMatch(/#E53935/i);
      expect(svg).toContain("data:image/png;base64,");
      expect(svg).toContain("Q1");
      expect(svg).toContain("North");
      expect(first.partial).toBe(false);
      const second = await (await fetch(preview.render(1).url)).text();
      expect(second).toMatch(/#2E7D32/i);
      expect(second).toContain("data:image/png;base64,");
      expect(second).not.toContain("No text on this slide");
    } finally {
      preview.dispose();
    }
  });

  it("owns and revokes its cached image URLs when the file is closed or reloaded", async () => {
    const preview = await readPresentation(fixture("presentation-original"));
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const first = preview.render(0);
    expect(preview.render(0)).toBe(first);
    preview.render(1);
    preview.dispose();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(() => preview.render(0)).toThrow("closed");
    revoke.mockRestore();
  });

  it("rejects malformed files instead of reporting a successful empty presentation", async () => {
    await expect(readPresentation(new TextEncoder().encode("not a zip").buffer)).rejects.toThrow();
  });
});
