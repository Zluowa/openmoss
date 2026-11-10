// FILE: htmlDocumentSource.ts
// Purpose: Where the viewer pane reads an HTML document's own bytes from, for "source" and
//          "save".
// Layer: Web lib
// Why: The owner's pane fetches the frame's own signed URL. A shared conversation's guest page
//      cannot: the share serves a frame document only to a frame, so the guest page sets a
//      resolver that points at the share's `file` route instead. The app itself never sets it.

import type { RightDockHtmlDocument } from "~/rightDockStore.logic";

let sourceUrlResolver: ((document: RightDockHtmlDocument) => string | null) | null = null;

export function setHtmlDocumentSourceUrlResolver(
  resolver: ((document: RightDockHtmlDocument) => string | null) | null,
): void {
  sourceUrlResolver = resolver;
}

/** The resolver a host installed, or null when the frame's own URL serves the source. */
export function htmlDocumentSourceUrlResolver():
  | ((document: RightDockHtmlDocument) => string | null)
  | null {
  return sourceUrlResolver;
}
