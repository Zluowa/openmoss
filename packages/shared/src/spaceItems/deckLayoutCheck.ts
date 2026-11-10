// FILE: deckLayoutCheck.ts
// Purpose: Finds layout faults a change introduced on a slide: content boxes (text, tables,
//          charts) that now cover each other, and elements pushed off the slide. Faults the
//          slide already had are left out, so an agent is told only about what it broke.
// Layer: Shared deck model (used by the slides agent tools)

import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Slide,
  type SlideElement,
  type SlidesDeck,
} from "./slidesDeck";

export interface DeckLayoutFault {
  readonly slideId: string;
  readonly kind: "overlap" | "off-slide";
  readonly elementIds: readonly string[];
  readonly message: string;
}

const CONTENT = new Set<SlideElement["type"]>(["text", "table", "chart"]);
/** Share of the smaller box that has to be covered before two boxes count as overlapping. */
const OVERLAP_SHARE = 0.04;
/** Pixels an element may hang past the slide edge (a bleed) before it counts as off-slide. */
const EDGE_SLACK = 8;

const label = (element: SlideElement) => element.name?.trim() || `${element.type} ${element.id}`;

function overlaps(a: SlideElement, b: SlideElement): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 && (w * h) / smaller > OVERLAP_SHARE;
}

function offSlide(element: SlideElement): boolean {
  if (element.type === "line") return false;
  return (
    element.x < -EDGE_SLACK ||
    element.y < -EDGE_SLACK ||
    element.x + element.w > SLIDE_WIDTH + EDGE_SLACK ||
    element.y + element.h > SLIDE_HEIGHT + EDGE_SLACK
  );
}

function slideFaults(slide: Slide): DeckLayoutFault[] {
  const faults: DeckLayoutFault[] = [];
  const content = slide.elements.filter((element) => CONTENT.has(element.type));
  for (let i = 0; i < content.length; i += 1) {
    for (let j = i + 1; j < content.length; j += 1) {
      const a = content[i]!;
      const b = content[j]!;
      // Members of one group were placed together on purpose.
      if (a.groupId && a.groupId === b.groupId) continue;
      if (overlaps(a, b))
        faults.push({
          slideId: slide.id,
          kind: "overlap",
          elementIds: [a.id, b.id],
          message: `"${label(a)}" and "${label(b)}" cover each other`,
        });
    }
  }
  for (const element of slide.elements)
    if (offSlide(element))
      faults.push({
        slideId: slide.id,
        kind: "off-slide",
        elementIds: [element.id],
        message: `"${label(element)}" runs past the slide edge`,
      });
  return faults;
}

const faultKey = (fault: DeckLayoutFault) =>
  `${fault.slideId}:${fault.kind}:${fault.elementIds.toSorted().join(",")}`;

/** Layout faults `after` has on its slides that `before` did not have. */
export function newLayoutFaults(before: SlidesDeck | null, after: SlidesDeck): DeckLayoutFault[] {
  const known = new Set(
    (before?.slides ?? []).flatMap((slide) => slideFaults(slide).map(faultKey)),
  );
  return after.slides.flatMap((slide) =>
    slideFaults(slide).filter((fault) => !known.has(faultKey(fault))),
  );
}
