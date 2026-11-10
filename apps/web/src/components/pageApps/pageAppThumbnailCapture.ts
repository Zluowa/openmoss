// FILE: pageAppThumbnailCapture.ts
// Purpose: One bounded owner preview request for one authorized iframe load.
// Layer: Web pageApps

import type { PageAppsOpenFrameResult } from "@moss/contracts";
import {
  PAGE_APP_THUMBNAIL_PROTOCOL,
  PAGE_APP_THUMBNAIL_WIDTH,
  PAGE_APP_THUMBNAIL_HEIGHT,
  PAGE_APP_THUMBNAIL_MAX_BYTES,
  PAGE_APP_THUMBNAIL_TIMEOUT_MS,
} from "@moss/shared/pageAppFrameRuntime";
import rendererSource from "html-to-image/dist/html-to-image.js?raw";

// Keep the small UMD source in the app bundle. Runtime bare-package imports can be
// rewritten by dependency optimization without preserving the raw-asset query.
export const loadPageAppThumbnailRenderer = async (): Promise<string> => rendererSource;

export function createPageAppThumbnailCapture(options: {
  readonly element: HTMLIFrameElement;
  readonly frame: PageAppsOpenFrameResult;
  readonly mode: string;
  readonly save: (thumbnail: string, signal: AbortSignal) => Promise<unknown>;
  readonly loadRenderer?: () => Promise<string>;
}) {
  const { element, frame } = options;
  const allowed = options.mode !== "guest" && frame.viewer.isOwner && frame.app.trashedAt === null;
  const nonce = crypto.randomUUID();
  const controller = new AbortController();
  let started = false;
  let accepted = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let image: HTMLImageElement | null = null;
  const post = (message: object) =>
    element.contentWindow?.postMessage(
      { protocol: PAGE_APP_THUMBNAIL_PROTOCOL, nonce, ...message },
      frame.frameOrigin === "null" ? "*" : frame.frameOrigin,
    );
  const dispose = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    clearTimeout(settleTimer);
    clearTimeout(timeout);
    window.removeEventListener("message", onMessage);
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.src = "";
      image = null;
    }
    if (started) post({ kind: "cancel" });
  };
  const onMessage = (event: MessageEvent) => {
    if (controller.signal.aborted || accepted || !started) return;
    if (event.source !== element.contentWindow || event.origin !== frame.frameOrigin) return;
    const message = event.data;
    if (
      !message ||
      message.protocol !== PAGE_APP_THUMBNAIL_PROTOCOL ||
      message.kind !== "result" ||
      message.nonce !== nonce
    )
      return;
    accepted = true;
    const thumbnail: unknown = message.thumbnail;
    if (
      typeof thumbnail !== "string" ||
      thumbnail.length > Math.ceil(PAGE_APP_THUMBNAIL_MAX_BYTES / 3) * 4 + 23 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(thumbnail)
    ) {
      dispose();
      return;
    }
    let bytes: string;
    try {
      bytes = atob(thumbnail.slice(23));
    } catch {
      dispose();
      return;
    }
    if (
      bytes.length > PAGE_APP_THUMBNAIL_MAX_BYTES ||
      !bytes.startsWith("\xff\xd8\xff") ||
      !bytes.endsWith("\xff\xd9")
    ) {
      dispose();
      return;
    }
    image = new Image();
    image.onload = () => {
      if (controller.signal.aborted || !image) return;
      if (
        !image.naturalWidth ||
        image.naturalWidth > PAGE_APP_THUMBNAIL_WIDTH ||
        !image.naturalHeight ||
        image.naturalHeight > PAGE_APP_THUMBNAIL_HEIGHT
      ) {
        dispose();
        return;
      }
      void options
        .save(thumbnail, controller.signal)
        .catch(() => {})
        .finally(dispose);
    };
    image.onerror = dispose;
    image.src = thumbnail;
  };
  const loaded = () => {
    if (!allowed || started || controller.signal.aborted) return;
    started = true;
    window.addEventListener("message", onMessage);
    timeout = setTimeout(dispose, PAGE_APP_THUMBNAIL_TIMEOUT_MS);
    // One small settling delay; no mutation observer, polling or retry loop.
    settleTimer = setTimeout(() => {
      void (options.loadRenderer ?? loadPageAppThumbnailRenderer)()
        .then((renderer) => {
          if (!controller.signal.aborted) post({ kind: "capture", renderer });
        })
        .catch(dispose);
    }, 400);
  };
  return { loaded, dispose };
}
