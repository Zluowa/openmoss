// FILE: localHtmlPreviewFrameGuard.ts
// Purpose: Keeps a rendered HTML file preview (an iframe on the backend's
//   /api/local-html/<grant>/ route) inside its own grant. Its response policy blocks
//   every fetch, but no policy can stop a script from navigating its own frame, which
//   would carry data out in the URL. The main process can, so it does.
// Layer: Desktop main-process policy (pure functions; wired up in main.ts)

import { LOCAL_HTML_PREVIEW_ROUTE_PREFIX } from "@moss/shared/localPreviewFiles";

/** `<origin>/api/local-html/<grant>/` for a preview URL, otherwise null. */
export function localHtmlPreviewGrantScope(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return null;
  }
  if (!url.pathname.startsWith(LOCAL_HTML_PREVIEW_ROUTE_PREFIX)) return null;
  const grant = url.pathname.slice(LOCAL_HTML_PREVIEW_ROUTE_PREFIX.length).split("/", 1)[0];
  if (!grant) return null;
  return `${url.origin}${LOCAL_HTML_PREVIEW_ROUTE_PREFIX}${grant}/`;
}

/**
 * True when a subframe navigation must be cancelled: the frame, or any frame above
 * it, shows a preview, and the target is outside that preview's grant. Links between
 * pages of the same previewed folder stay allowed. The app's own main frame is
 * never affected.
 */
export function shouldBlockLocalHtmlPreviewFrameNavigation(input: {
  readonly isMainFrame: boolean;
  /** URL of the frame being navigated, then each ancestor up to the top. */
  readonly frameChainUrls: readonly (string | null | undefined)[];
  readonly targetUrl: string;
}): boolean {
  if (input.isMainFrame) return false;
  const targetScope = localHtmlPreviewGrantScope(input.targetUrl);
  return input.frameChainUrls.some((frameUrl) => {
    const scope = localHtmlPreviewGrantScope(frameUrl);
    return scope !== null && scope !== targetScope;
  });
}

/**
 * Electron does not say which frame called `window.open`. Preview frames are
 * sandboxed without `allow-popups`, so Chromium refuses their popups before this
 * point; this still refuses any request that names a preview URL, so nothing can
 * open a preview in a new window or hand it to the external browser.
 */
export function shouldDenyLocalHtmlPreviewWindowOpen(input: {
  readonly url: string;
  readonly referrerUrl?: string | null;
}): boolean {
  return (
    localHtmlPreviewGrantScope(input.url) !== null ||
    localHtmlPreviewGrantScope(input.referrerUrl) !== null
  );
}
