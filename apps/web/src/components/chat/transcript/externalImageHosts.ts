// FILE: externalImageHosts.ts
// Purpose: Which markdown images the chat transcript holds back: an image on another site
//          (an http(s) address) is never fetched there; the desktop chat shows a "Show
//          Image" box instead. Panels and PR bodies load images as before.
// Layer: Chat transcript behavior
// Exports: TranscriptMarkdownContext, parseExternalImageSrc, externalImageName

import { createContext } from "react";

/** True inside a chat transcript, where markdown takes the desktop chat's forms (image box, bare code blocks); PR bodies, previews and panels keep theirs. */
export const TranscriptMarkdownContext = createContext(false);

/** The remote http(s) address of a markdown image, or null for local, data and blob sources. */
export function parseExternalImageSrc(src: string): { url: URL } | null {
  const trimmed = src.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.hostname.replace(/\.+$/, "") === "" ? null : { url };
  } catch {
    return null;
  }
}

/** Alt text without control characters and with runs of space collapsed. */
export function externalImageName(alt: string): string {
  return alt
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
