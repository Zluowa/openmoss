// FILE: readonlyAppItemFrameController.ts
// Purpose: A single bounded nonce handshake for an opaque readonly document.
// Layer: Web frame lifecycle; no capability/API requests

import {
  READONLY_APP_ITEM_PROTOCOL,
  READONLY_APP_ITEM_TIMEOUT_MS,
} from "@moss/shared/readonlyAppItem";

export type ReadonlyAppItemFrameStatus =
  | "loading"
  | "ready"
  | "timeout"
  | "expired"
  | "invalid"
  | "unavailable";

export function createReadonlyAppItemFrameController(options: {
  readonly element: HTMLIFrameElement;
  readonly hostUrl: string;
  readonly parentOrigin: string;
  readonly html: string;
  readonly expiresAt?: number;
  readonly onStatus: (status: ReadonlyAppItemFrameStatus) => void;
}) {
  const nonce = crypto.randomUUID();
  const url = new URL(options.hostUrl);
  // A new query creates a new document. Hash-only navigation would leave the
  // previous document.write result in place, with no host listener to reload it.
  url.searchParams.set("readonlyFrame", nonce);
  url.hash = new URLSearchParams({
    protocol: READONLY_APP_ITEM_PROTOCOL,
    nonce,
    parentOrigin: options.parentOrigin,
  }).toString();
  const frameUrl = url.href;
  let disposed = false;
  let sent = false;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const stopHandshake = () => {
    clearTimeout(handshakeTimer);
    window.removeEventListener("message", receive);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopHandshake();
    clearTimeout(expiryTimer);
    if (options.element.getAttribute("src") === frameUrl) options.element.src = "about:blank";
  };
  const end = (status: ReadonlyAppItemFrameStatus) => {
    if (disposed) return;
    dispose();
    options.onStatus(status);
  };
  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== options.element.contentWindow || event.origin !== "null")
      return;
    const message = event.data;
    if (!message || message.protocol !== READONLY_APP_ITEM_PROTOCOL || message.nonce !== nonce)
      return;
    if (message.kind === "ready" && !sent) {
      sent = true;
      try {
        options.element.contentWindow?.postMessage(
          { protocol: READONLY_APP_ITEM_PROTOCOL, nonce, kind: "document", html: options.html },
          "*",
        );
      } catch {
        end("invalid");
      }
    } else if (message.kind === "loaded" && sent) {
      stopHandshake();
      options.onStatus("ready");
    }
  };
  const remaining = options.expiresAt === undefined ? undefined : options.expiresAt - Date.now();
  if (
    remaining !== undefined &&
    (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647)
  ) {
    options.onStatus("expired");
    return { dispose };
  }
  options.onStatus("loading");
  window.addEventListener("message", receive);
  handshakeTimer = setTimeout(() => end("timeout"), READONLY_APP_ITEM_TIMEOUT_MS);
  if (remaining !== undefined) expiryTimer = setTimeout(() => end("expired"), remaining);
  // Listeners exist before navigation, so the host's first ready cannot be lost.
  options.element.src = frameUrl;
  return { dispose };
}
