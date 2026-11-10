import { describe, expect, it } from "vitest";

import { newLayoutFaults } from "./deckLayoutCheck";
import { parseSlidesDeck, type SlidesDeck } from "./slidesDeck";

const text = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => ({
  id,
  type: "text",
  x,
  y,
  w,
  h,
  body: { paragraphs: [{ runs: [{ text: id }] }] },
  ...extra,
});
const deck = (elements: object[]): SlidesDeck =>
  parseSlidesDeck({ version: 2, slides: [{ id: "s1", elements }] });

describe("deck layout check", () => {
  it("reports content boxes a change made cover each other", () => {
    const before = deck([text("title", 128, 200, 900, 160), text("chart", 1100, 200, 600, 500)]);
    const after = deck([text("title", 128, 200, 1200, 160), text("chart", 1100, 200, 600, 500)]);
    const faults = newLayoutFaults(before, after);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ slideId: "s1", kind: "overlap" });
    expect([...faults[0]!.elementIds].sort()).toEqual(["chart", "title"]);
  });

  it("leaves out faults the slide already had and grouped elements", () => {
    const both = [text("a", 100, 100, 400, 200), text("b", 300, 150, 400, 200)];
    expect(newLayoutFaults(deck(both), deck(both))).toEqual([]);
    const grouped = deck([
      text("a", 100, 100, 400, 200, { groupId: "g" }),
      text("b", 300, 150, 400, 200, { groupId: "g" }),
    ]);
    expect(newLayoutFaults(null, grouped)).toEqual([]);
  });

  it("reports an element pushed off the slide, allowing a small bleed", () => {
    expect(newLayoutFaults(null, deck([text("edge", -6, 0, 400, 100)]))).toEqual([]);
    const faults = newLayoutFaults(null, deck([text("out", 1700, 900, 400, 300)]));
    expect(faults).toEqual([expect.objectContaining({ kind: "off-slide", elementIds: ["out"] })]);
  });
});
