// FILE: sharedViewer.ts
// Purpose: Tells transcript components that a guest is reading a shared conversation.
// Layer: Web chat presentation context
// Why: The guest page renders the owner's own transcript components, but a guest has no access
//      to the owner's computer. File references then show as plain chips (name and kind, no path,
//      nothing to open) instead of links that would try to reach the owner's files.

import { createContext, useContext } from "react";

export const SharedViewerContext = createContext(false);

/** True inside a shared conversation's guest page. */
export function useIsSharedViewer(): boolean {
  return useContext(SharedViewerContext);
}

/** A file the agent linked in a shared reply: the link as written, and the file's name. */
export interface SharedFileReference {
  /** The link target as the reply wrote it; the share resolves it, the page never shows it. */
  readonly path: string;
  readonly name: string;
}

/**
 * Opens a linked file in the guest page's viewer pane, through the share. Null when the owner's
 * Moss cannot serve files (an older version): the chip then stays a plain name.
 */
export const SharedFileOpenerContext = createContext<((file: SharedFileReference) => void) | null>(
  null,
);

export function useSharedFileOpener(): ((file: SharedFileReference) => void) | null {
  return useContext(SharedFileOpenerContext);
}

/**
 * Whether a link points at the owner's own machine or local network (a dev server, the browser
 * panel's local page): a guest's browser would reach its own machine instead, or nothing.
 */
export function isOwnerLocalUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") {
    return true;
  }
  const octets = host.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
