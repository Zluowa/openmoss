// FILE: resources.ts
// Purpose: Points the shared transcript's resources at the share's routes: attachments, the
//          agent's published pages and visuals (`render`), pictures from the owner's disk
//          (`media`), and the bytes the viewer pane reads or saves (`file`).
// Layer: Guest page
// Why: The transcript components ask the app's URL helpers for `/attachments/…`,
//      `/api/local-image?…`, `/api/inline-visualization?…`, signed page URLs and RPCs on the
//      owner's server, none of which the relay serves. Each helper takes a resolver, set here
//      once, so the same components load the same resources through the share. An owner whose
//      Moss predates a route gets a placeholder from the component instead of a broken frame or
//      image.

import { GUEST_ROUTES, HtmlRenderMapConfig, type GuestOptionalRoute } from "@moss/contracts";
import { Option, Schema } from "effect";

import { setHtmlDocumentSourceUrlResolver } from "~/lib/htmlDocumentSource";
import { setHtmlRenderFrameUrlResolver } from "~/lib/htmlRenderFrameUrl";
import { setHtmlRenderMapConfigReader } from "~/lib/htmlRenderMapConfig";
import { setInlineVisualHost } from "~/lib/inlineVisualHosting";
import { setInlineVisualizationFrameUrlResolver } from "~/lib/inlineVisualizationFrameUrl";
import { setLocalImageUrlResolver } from "~/lib/localImageUrls";
import { setAttachmentPreviewUrlResolver } from "~/lib/wsHttpUrl";

import type { GuestTransport } from "./transport";

type OwnerRoutes = ReadonlySet<string> | null;

let ownerRoutes: OwnerRoutes = null;
let routesKnown: Promise<OwnerRoutes> | null = null;
let settleRoutes: ((routes: OwnerRoutes) => void) | null = null;

function routesPromise(): Promise<OwnerRoutes> {
  if (routesKnown === null) {
    routesKnown = new Promise((resolve) => {
      settleRoutes = resolve;
    });
  }
  return routesKnown;
}

/** Records what the owner's Moss serves, from the stream's `hello` (absent: none of them). */
export function setGuestOwnerRoutes(routes: ReadonlyArray<string> | undefined): void {
  ownerRoutes = new Set(routes ?? []);
  routesPromise();
  settleRoutes?.(ownerRoutes);
}

/** Whether the owner serves a route; waits for the first `hello`, which precedes the thread. */
export async function ownerServes(route: GuestOptionalRoute): Promise<boolean> {
  const routes = ownerRoutes ?? (await routesPromise());
  return routes?.has(route) ?? false;
}

/**
 * Whether the owner serves a route, as far as this page knows now. The thread renders only after
 * `hello`, so inside the transcript this is the owner's answer.
 */
export function ownerServesNow(route: GuestOptionalRoute): boolean {
  return ownerRoutes?.has(route) ?? false;
}

/** Fails like the RPC does for a visual the owner cannot serve: shown once, never retried. */
class GuestVisualUnavailable extends Error {
  readonly retryable = false;
}

const decodeMapConfig = Schema.decodeUnknownOption(HtmlRenderMapConfig);

/** Installs the resolvers before the first snapshot renders. */
export function installGuestResourceResolvers(transport: GuestTransport): void {
  setAttachmentPreviewUrlResolver((id) => transport.attachmentUrl(id));
  setHtmlRenderFrameUrlResolver(async (attachmentId) =>
    (await ownerServes(GUEST_ROUTES.render)) ? transport.renderUrl(attachmentId) : null,
  );
  // An `<img>` needs its URL while rendering; an older owner answers this route with an error,
  // and the picture shows its error card.
  setLocalImageUrlResolver((src) => transport.mediaUrl(src));
  // Inline visuals (`moss_show_visual`): the source through `file`, an HTML visual's frame
  // through `render`. The frame runs under the guest page's `frame-src 'self'`, which refuses
  // any navigation away before a request leaves, as desktop's native guard does.
  setInlineVisualHost({
    async source(visualId) {
      if (!(await ownerServes(GUEST_ROUTES.file))) {
        throw new GuestVisualUnavailable("This visual is not available.");
      }
      const response = await fetch(transport.fileUrl({ visual: visualId }), {
        credentials: "include",
      });
      if (!response.ok) throw new GuestVisualUnavailable("This visual is not available.");
      return response.text();
    },
    async frameUrl({ visualId, appearance }) {
      return (await ownerServes(GUEST_ROUTES.file))
        ? transport.documentUrl({ visual: visualId, appearance })
        : null;
    },
  });
  // Visualization markers in a reply: the marker's file through `render`.
  setInlineVisualizationFrameUrlResolver(async (path) =>
    (await ownerServes(GUEST_ROUTES.file)) ? transport.documentUrl({ visualization: path }) : null,
  );
  // A published page's map: the owner's lane, with Moss's public keys only. An owner that
  // cannot answer leaves the page its plain map, as a page outside the app gets.
  setHtmlRenderMapConfigReader(async () => {
    if (!(await ownerServes(GUEST_ROUTES.file))) return null;
    try {
      const response = await fetch(transport.fileUrl({ map: "1" }), { credentials: "include" });
      if (!response.ok) return null;
      return Option.getOrNull(decodeMapConfig(await response.json()));
    } catch {
      return null;
    }
  });
  // The viewer pane's source and save read the document's bytes through `file`.
  setHtmlDocumentSourceUrlResolver((document) =>
    document.kind === "html-render"
      ? transport.fileUrl({ render: document.attachmentId })
      : transport.fileUrl({ visualization: document.path }),
  );
}

/** Test-only: forget the owner's routes between cases. */
export function resetGuestResourcesForTests(): void {
  ownerRoutes = null;
  routesKnown = null;
  settleRoutes = null;
  setAttachmentPreviewUrlResolver(null);
  setHtmlRenderFrameUrlResolver(null);
  setLocalImageUrlResolver(null);
  setInlineVisualHost(null);
  setInlineVisualizationFrameUrlResolver(null);
  setHtmlDocumentSourceUrlResolver(null);
  setHtmlRenderMapConfigReader(null);
}
