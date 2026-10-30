// FILE: htmlRenderActivity.ts
// Purpose: The thread activity that records a page an agent published with `html_render`.
// Layer: Shared runtime utility
// Exports: HTML_RENDER_ACTIVITY_KIND, htmlRenderActivityPayload, htmlRenderFromActivity

import { readHtmlRenderReference, type HtmlRenderReference } from "./htmlRender";

/**
 * Provider tool results do not share one shape across Moss's adapters, so the
 * gateway records each published page as its own thread activity. Clients and
 * attachment retention read pages from this activity, never from tool output.
 */
export const HTML_RENDER_ACTIVITY_KIND = "html-render.published";

/** The activity payload for a published page, as plain JSON. */
export function htmlRenderActivityPayload(reference: HtmlRenderReference) {
  return {
    htmlRender: {
      attachmentId: reference.attachmentId,
      title: reference.title,
      height: reference.height,
      ...(reference.heights === undefined
        ? {}
        : { heights: reference.heights.map(([width, height]) => [width, height]) }),
    },
  };
}

/** The page a published-render activity carries, if this activity is one. */
export function htmlRenderFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): HtmlRenderReference | undefined {
  if (activity.kind !== HTML_RENDER_ACTIVITY_KIND) return undefined;
  if (typeof activity.payload !== "object" || activity.payload === null) return undefined;
  return readHtmlRenderReference(
    (activity.payload as { readonly htmlRender?: unknown }).htmlRender,
  );
}
