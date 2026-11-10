// FILE: htmlRenderSurfaces.ts
// Purpose: Places a thread's `html_render` pages when an agent keeps one visual current on a
//   named surface: the surface's newest page shows where the surface first appeared, and its
//   later publications become notes that point there.
// Layer: Web chat logic (pure)
// Exports: HtmlRenderPublication, PlacedHtmlRender, latestHtmlRenderBySurface, placeHtmlRenders

import type { HtmlRenderReference } from "@moss/shared/htmlRender";

/** A thread entry, oldest first, that may carry a page published with `html_render`. */
export interface HtmlRenderPublication {
  readonly id: string;
  readonly turnId?: string | null | undefined;
  readonly htmlRender?: HtmlRenderReference | undefined;
}

/** How one publication shows in the transcript. */
export interface PlacedHtmlRender {
  readonly id: string;
  /** The page to show. A note keeps the page its own publication published. */
  readonly htmlRender: HtmlRenderReference;
  /**
   * Set on a later publication of a surface, which shows as a note: the id of the
   * publication that shows the surface's newest page.
   */
  readonly liveId?: string;
}

/** Each surface's newest page. */
export function latestHtmlRenderBySurface(
  publications: ReadonlyArray<HtmlRenderPublication>,
): ReadonlyMap<string, HtmlRenderReference> {
  const latest = new Map<string, HtmlRenderReference>();
  for (const { htmlRender } of publications) {
    if (htmlRender?.surface !== undefined) latest.set(htmlRender.surface, htmlRender);
  }
  return latest;
}

// Where each surface first appeared, and the publications that keep a note: the last
// one of every later turn. The first turn keeps none, as it already shows the page, and
// a publication without a turn always keeps its note.
function surfacePlaces(publications: ReadonlyArray<HtmlRenderPublication>) {
  const firstIds = new Map<string, string>();
  const firstTurnIds = new Map<string, string | null>();
  const lastIdByTurn = new Map<string, string>();
  const turnlessNoteIds: string[] = [];
  for (const { id, turnId, htmlRender } of publications) {
    const surface = htmlRender?.surface;
    if (surface === undefined) continue;
    if (!firstIds.has(surface)) {
      firstIds.set(surface, id);
      firstTurnIds.set(surface, turnId ?? null);
    } else if (turnId == null) {
      turnlessNoteIds.push(id);
    } else if (turnId !== firstTurnIds.get(surface)) {
      // A surface never holds a space, so the key cannot collide.
      lastIdByTurn.set(`${surface} ${turnId}`, id);
    }
  }
  return { firstIds, noteIds: new Set([...lastIdByTurn.values(), ...turnlessNoteIds]) };
}

/**
 * Places every published page in one pass over a thread's entries, keyed by entry id.
 * An entry missing from the result shows nothing. A page without a surface shows as
 * published, so threads from before surfaces look as they always did.
 */
export function placeHtmlRenders(
  publications: ReadonlyArray<HtmlRenderPublication>,
): ReadonlyMap<string, PlacedHtmlRender> {
  const latest = latestHtmlRenderBySurface(publications);
  const { firstIds, noteIds } = surfacePlaces(publications);
  const placed = new Map<string, PlacedHtmlRender>();
  for (const { id, htmlRender } of publications) {
    if (htmlRender === undefined) continue;
    const surface = htmlRender.surface;
    const firstId = surface === undefined ? undefined : firstIds.get(surface);
    if (surface === undefined || firstId === undefined) {
      placed.set(id, { id, htmlRender });
    } else if (id === firstId) {
      placed.set(id, { id, htmlRender: latest.get(surface) ?? htmlRender });
    } else if (noteIds.has(id)) {
      placed.set(id, { id, htmlRender, liveId: firstId });
    }
  }
  return placed;
}
