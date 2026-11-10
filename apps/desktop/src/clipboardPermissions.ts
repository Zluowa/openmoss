import type { WebContents } from "electron";
import { normalizePermissionOrigin } from "./mediaPermissions";
import {
  MOSS_BETA_DESKTOP_SCHEME,
  MOSS_CANARY_DESKTOP_SCHEME,
  MOSS_CUA_DESKTOP_SCHEME,
  MOSS_DESKTOP_SCHEME,
} from "@moss/shared/desktopIdentity";

/** The desktop shell uses hash routing. A same-origin guest document has a different path. */
export function writeMainWindowThreadId(
  event: Pick<Electron.IpcMainInvokeEvent, "sender" | "senderFrame">,
  main: WebContents | undefined,
  entryUrl: string,
  threadId: unknown,
  write: (text: string) => void,
): void {
  const frame = event.senderFrame;
  const origin = normalizePermissionOrigin(entryUrl);
  if (
    !main ||
    main.isDestroyed() ||
    event.sender !== main ||
    !frame ||
    frame !== main.mainFrame ||
    !origin ||
    normalizePermissionOrigin(frame.url) !== origin
  ) {
    throw new Error("Clipboard write requires the Moss main window.");
  }
  const entry = new URL(entryUrl);
  const bundledShell = [
    MOSS_DESKTOP_SCHEME,
    MOSS_CANARY_DESKTOP_SCHEME,
    MOSS_CUA_DESKTOP_SCHEME,
    MOSS_BETA_DESKTOP_SCHEME,
  ].some((scheme) => entry.protocol === scheme + ":" && entry.host === "app");
  const localDevShell =
    ["http:", "https:"].includes(entry.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(entry.hostname);
  if ((!bundledShell && !localDevShell) || new URL(frame.url).pathname !== entry.pathname) {
    throw new Error("Clipboard write requires the Moss main window.");
  }
  if (
    typeof threadId !== "string" ||
    !threadId ||
    threadId.length > 1024 ||
    threadId.trim() !== threadId ||
    /[\u0000-\u001f\u007f]|:\/\//.test(threadId)
  ) {
    throw new Error("Invalid thread ID.");
  }
  write(threadId);
}

/** Copy buttons share the OS clipboard; background reads remain denied. */
export function isClipboardWritePermission(
  requester: Pick<WebContents, "isDestroyed" | "getURL"> | null,
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; embeddingOrigin?: string },
  requestingOrigin?: string,
): boolean {
  if (
    permission !== "clipboard-sanitized-write" ||
    !requester ||
    requester.isDestroyed() ||
    details.isMainFrame === false
  )
    return false;
  try {
    // Chromium enforces document focus. Native window focus may already have
    // returned to the composer when an asynchronous copy requests permission.
    const page = new URL(requester.getURL());
    const trustedScheme =
      page.protocol === `${MOSS_DESKTOP_SCHEME}:` ||
      page.protocol === `${MOSS_CANARY_DESKTOP_SCHEME}:` ||
      page.protocol === `${MOSS_CUA_DESKTOP_SCHEME}:` ||
      page.protocol === `${MOSS_BETA_DESKTOP_SCHEME}:`;
    if (
      page.protocol !== "https:" &&
      !trustedScheme &&
      !(page.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname))
    )
      return false;
    return [requestingOrigin, details.requestingUrl, details.embeddingOrigin].every(
      (origin) => !origin || new URL(origin).origin === page.origin,
    );
  } catch {
    return false;
  }
}
