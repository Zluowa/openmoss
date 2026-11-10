// FILE: inlineVisualHosting.ts
// Purpose: Lets a surface that cannot reach the owner's Moss over RPC say where an inline
//          visual's source and frame document load from.
// Layer: Web lib
// Why: The shared conversation's guest page renders the owner's transcript components but has no
//      RPC: it reads a visual's source through the share's `file` route and runs an HTML visual
//      from the share's `render` route. A served frame keeps the desktop guarantee in a browser:
//      the visual's own policy blocks every fetch, and the guest page's `frame-src 'self'`
//      blocks the frame from navigating itself anywhere else, before any request leaves. The
//      app itself never sets this.

import type { InlineVisualAppearance } from "@moss/shared/inlineVisual";

import { resolveWsHttpUrl } from "./wsHttpUrl";

export interface InlineVisualHost {
  /** The stored source (OpenUI, component JSON or HTML), as the RPC returns it. */
  readonly source: (visualId: string) => Promise<string>;
  /** A served frame document for an HTML visual; null when the owner cannot serve it. */
  readonly frameUrl: (visual: {
    readonly threadId: string;
    readonly visualId: string;
    readonly appearance: InlineVisualAppearance;
  }) => Promise<string | null>;
}

let host: InlineVisualHost | null = null;

export function setInlineVisualHost(next: InlineVisualHost | null): void {
  host = next;
}

export function inlineVisualHost(): InlineVisualHost | null {
  return host;
}

/**
 * The web app's own frame address for an HTML visual, minted by the owner's server
 * (`/api/inline-visual`): a short-lived signed URL, so the frame never sees the app's token. The
 * app's `frame-src` allows only its own server and local addresses, so the document cannot take
 * its frame anywhere else, and its policy blocks every fetch.
 */
export async function resolveWebInlineVisualFrameUrl(visual: {
  readonly threadId: string;
  readonly visualId: string;
  readonly appearance: InlineVisualAppearance;
}): Promise<string | null> {
  const params = new URLSearchParams({
    threadId: visual.threadId,
    visualId: visual.visualId,
    appearance: visual.appearance,
  });
  try {
    const response = await fetch(resolveWsHttpUrl(`/api/inline-visual?${params.toString()}`), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    const url = (value as { url?: unknown } | null)?.url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}
