// FILE: LocalHtmlPreviewFrame.tsx
// Purpose: The rendered view of an HTML file opened in the file panel.
// Layer: File preview UI
//
// Written separately from SandboxedHtmlDocument on purpose: that frame carries a
// message bridge (links, images, keys, theme) for agent-authored inline HTML. A
// file from disk gets no channel to Moss at all, so it cannot ask Moss to open a
// URL or load an image on its behalf.

import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Scripts run, but in an opaque origin: no `allow-same-origin`, so the page has no
 * access to Moss's origin, APIs, cookies or storage; no forms, popups, modals,
 * downloads or top-level navigation. The server's policy repeats this and blocks
 * every network request.
 *
 * No policy can stop a script from navigating this frame itself (taking data along
 * in the URL), nor stop WebRTC. The desktop app cancels such navigations in the main
 * process (apps/desktop/src/localHtmlPreviewFrameGuard.ts); the plain browser build
 * has no equivalent.
 */
export const LOCAL_HTML_PREVIEW_FRAME_SANDBOX = "allow-scripts";

export function LocalHtmlPreviewFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
}) {
  // Short-lived preview grants are refreshed in the background. Keep the URL the
  // frame started with so a refresh never reloads the page under the reader; the
  // server keeps that first grant alive while the file keeps being re-granted. The
  // parent remounts the frame when the file itself is reloaded.
  const [src] = useState(props.src);
  return (
    <iframe
      src={src}
      title={props.title}
      sandbox={LOCAL_HTML_PREVIEW_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className={cn("block border-0 bg-white scheme-light", props.className)}
    />
  );
}
