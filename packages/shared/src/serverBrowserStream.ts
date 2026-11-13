/**
 * The wire protocol of a server-hosted browser streamed to its viewers.
 *
 * When no desktop app hosts the browser — a Moss server reached over SSH, the
 * web client, a phone — the agent's browser runs headless on the server and
 * every viewer watches it over one WebSocket per thread:
 *
 * - Binary messages are JPEG frames of the viewer's selected tab.
 * - Text messages are JSON: `tabs`, `viewport`, `control` and `dialog` from the
 *   server, `ack`, input and control requests from the viewer.
 * - The server keeps one frame on the wire and only the newest waiting; the
 *   viewer acks each frame it received, which paces the screencast to what the
 *   link carries instead of queueing stale images.
 *
 * Coordinates in input messages are page CSS pixels.
 *
 * Protocol shape adapted from T3 Code's preview stream (MIT).
 *
 * @module serverBrowserStream
 */

export const SERVER_BROWSER_STREAM_PATH = "/api/server-browser/ws";
export const SERVER_BROWSER_STREAM_THREAD_PARAM = "threadId";
/** Close code: the thread has no server browser and none can be started for it. */
export const SERVER_BROWSER_STREAM_UNAVAILABLE_CLOSE_CODE = 4404;
export const SERVER_BROWSER_STREAM_ACK = JSON.stringify({ type: "ack" });
/**
 * Query flag for a presence-only viewer: tabs and reveal requests, no frames.
 * A chat keeps one open so the browser panel can open when the agent asks.
 */
export const SERVER_BROWSER_STREAM_PRESENCE_PARAM = "presence";
/** A download a person started, fetched once with its token. */
export const SERVER_BROWSER_DOWNLOAD_PATH = "/api/server-browser/download";
/**
 * The download's one-time token. Not `token`: the address keeps the app's own
 * connection query, whose `token` is the desktop's loopback credential.
 */
export const SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM = "download";
/** Upper bound for the files a viewer hands one file picker, in bytes. */
export const SERVER_BROWSER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type ServerBrowserController = "agent" | "you" | "another-viewer";

export interface ServerBrowserStreamTab {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly loading: boolean;
}

export interface ServerBrowserStreamControl {
  readonly canOperate: boolean;
  readonly controller: ServerBrowserController;
  readonly generation: number;
}

export type ServerBrowserStreamServerMessage =
  | {
      readonly type: "tabs";
      readonly tabs: ReadonlyArray<ServerBrowserStreamTab>;
      /** The tab this viewer is watching, or `null` while the thread has none. */
      readonly selectedTabId: string | null;
    }
  | { readonly type: "viewport"; readonly width: number; readonly height: number }
  | ({ readonly type: "control" } & ServerBrowserStreamControl)
  | {
      readonly type: "dialog";
      readonly kind: string;
      readonly message: string;
      readonly action: "accepted" | "dismissed";
    }
  | { readonly type: "error"; readonly message: string }
  /** The agent opened a page and asked for it to be shown. */
  | { readonly type: "reveal"; readonly tabId: string }
  /** A page dialog waits for the person in control to answer it. */
  | {
      readonly type: "dialogOpen";
      readonly id: string;
      readonly kind: string;
      readonly message: string;
      readonly defaultPrompt: string;
    }
  | { readonly type: "dialogClosed"; readonly id: string }
  /** The page opened a file picker for the person in control. */
  | {
      readonly type: "fileChooser";
      readonly id: string;
      readonly multiple: boolean;
      readonly accept: string;
    }
  | { readonly type: "fileChooserClosed"; readonly id: string }
  /** A file the person downloaded, served once at `path` (relative to the server). */
  | {
      readonly type: "download";
      readonly fileName: string;
      readonly sizeBytes: number;
      readonly path: string;
    }
  /** Text the person copied or cut in the page, for the viewer's own clipboard. */
  | { readonly type: "clipboard"; readonly text: string }
  /** A page load was refused: `host` is on the server's own machine or network. */
  | { readonly type: "navigationBlocked"; readonly host: string };

export interface ServerBrowserUploadFile {
  readonly name: string;
  readonly mimeType: string;
  /** Base64 file contents. */
  readonly data: string;
}

export type ServerBrowserMouseButton = "none" | "left" | "middle" | "right";

export type ServerBrowserStreamInput =
  | { readonly type: "ack" }
  | { readonly type: "selectTab"; readonly tabId: string }
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: ServerBrowserMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** DOM `keyCode`; Enter, Backspace and the arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload" }
  /** Open a page in a new tab of the thread's browser, starting it if needed. */
  | { readonly type: "open"; readonly url: string }
  /**
   * The viewer's panel size in CSS pixels. The page follows it, so it fills
   * the panel, unless the agent pinned the tab's size with `browser_resize`.
   */
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | {
      readonly type: "dialogAnswer";
      readonly id: string;
      readonly accept: boolean;
      readonly promptText?: string;
    }
  /** The files for an open picker; none cancels it. */
  | {
      readonly type: "fileChooserAnswer";
      readonly id: string;
      readonly files: ReadonlyArray<ServerBrowserUploadFile>;
    }
  | { readonly type: "closeTab"; readonly tabId: string };

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const serverBrowserModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTab = (value: unknown): value is ServerBrowserStreamTab =>
  isRecord(value) &&
  typeof value.tabId === "string" &&
  typeof value.title === "string" &&
  typeof value.url === "string" &&
  typeof value.loading === "boolean";

/** Decode a server text message, or `null` for anything this client does not understand. */
export function decodeServerBrowserServerMessage(
  text: string,
): ServerBrowserStreamServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "tabs":
      return Array.isArray(value.tabs) &&
        value.tabs.every(isTab) &&
        (value.selectedTabId === null || typeof value.selectedTabId === "string")
        ? { type: "tabs", tabs: value.tabs, selectedTabId: value.selectedTabId }
        : null;
    case "viewport":
      return typeof value.width === "number" && typeof value.height === "number"
        ? { type: "viewport", width: value.width, height: value.height }
        : null;
    case "control":
      return typeof value.canOperate === "boolean" &&
        (value.controller === "agent" ||
          value.controller === "you" ||
          value.controller === "another-viewer") &&
        typeof value.generation === "number"
        ? {
            type: "control",
            canOperate: value.canOperate,
            controller: value.controller,
            generation: value.generation,
          }
        : null;
    case "dialog":
      return typeof value.kind === "string" &&
        typeof value.message === "string" &&
        (value.action === "accepted" || value.action === "dismissed")
        ? { type: "dialog", kind: value.kind, message: value.message, action: value.action }
        : null;
    case "error":
      return typeof value.message === "string" ? { type: "error", message: value.message } : null;
    case "reveal":
      return typeof value.tabId === "string" ? { type: "reveal", tabId: value.tabId } : null;
    case "dialogOpen":
      return typeof value.id === "string" &&
        typeof value.kind === "string" &&
        typeof value.message === "string" &&
        typeof value.defaultPrompt === "string"
        ? {
            type: "dialogOpen",
            id: value.id,
            kind: value.kind,
            message: value.message,
            defaultPrompt: value.defaultPrompt,
          }
        : null;
    case "dialogClosed":
    case "fileChooserClosed":
      return typeof value.id === "string" ? { type: value.type, id: value.id } : null;
    case "fileChooser":
      return typeof value.id === "string" &&
        typeof value.multiple === "boolean" &&
        typeof value.accept === "string"
        ? { type: "fileChooser", id: value.id, multiple: value.multiple, accept: value.accept }
        : null;
    case "download":
      return typeof value.fileName === "string" &&
        typeof value.sizeBytes === "number" &&
        typeof value.path === "string"
        ? {
            type: "download",
            fileName: value.fileName,
            sizeBytes: value.sizeBytes,
            path: value.path,
          }
        : null;
    case "clipboard":
      return typeof value.text === "string" ? { type: "clipboard", text: value.text } : null;
    case "navigationBlocked":
      return typeof value.host === "string"
        ? { type: "navigationBlocked", host: value.host }
        : null;
    default:
      return null;
  }
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const boundedString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

/**
 * Decode a viewer message, or `null` for anything malformed. The server is the
 * boundary here: numbers are forced finite, strings bounded, enums closed.
 */
export function decodeServerBrowserViewerInput(raw: unknown): ServerBrowserStreamInput | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const modifiers = Math.max(0, Math.min(15, Math.trunc(finite(value.modifiers))));
  switch (value.type) {
    case "ack":
    case "takeControl":
    case "releaseControl":
    case "reload":
      return { type: value.type };
    case "selectTab": {
      const tabId = boundedString(value.tabId, 128);
      return tabId ? { type: "selectTab", tabId } : null;
    }
    case "mouse": {
      const action = value.action;
      if (action !== "move" && action !== "down" && action !== "up") return null;
      const button =
        value.button === "left" || value.button === "middle" || value.button === "right"
          ? value.button
          : "none";
      return {
        type: "mouse",
        action,
        x: finite(value.x),
        y: finite(value.y),
        button,
        buttons: Math.max(0, Math.min(7, Math.trunc(finite(value.buttons)))),
        clickCount: Math.max(0, Math.min(3, Math.trunc(finite(value.clickCount)))),
        modifiers,
      };
    }
    case "wheel":
      return {
        type: "wheel",
        x: finite(value.x),
        y: finite(value.y),
        deltaX: Math.max(-10_000, Math.min(10_000, finite(value.deltaX))),
        deltaY: Math.max(-10_000, Math.min(10_000, finite(value.deltaY))),
        modifiers,
      };
    case "key": {
      if (value.action !== "down" && value.action !== "up") return null;
      const key = boundedString(value.key, 64);
      const code = boundedString(value.code ?? "", 64);
      if (key === null || code === null) return null;
      const text = boundedString(value.text, 8);
      const keyCode = finite(value.keyCode, -1);
      return {
        type: "key",
        action: value.action,
        key,
        code,
        modifiers,
        ...(keyCode >= 0 && keyCode <= 255 ? { keyCode: Math.trunc(keyCode) } : {}),
        ...(text ? { text } : {}),
      };
    }
    case "text": {
      const text = boundedString(value.text, 10_000);
      return text ? { type: "text", text } : null;
    }
    case "navigate":
    case "open": {
      const url = boundedString(value.url, 8_192);
      return url ? { type: value.type, url } : null;
    }
    case "history":
      return value.delta === -1 || value.delta === 1
        ? { type: "history", delta: value.delta }
        : null;
    case "resize": {
      const width = Math.round(finite(value.width));
      const height = Math.round(finite(value.height));
      return width >= 1 && height >= 1 ? { type: "resize", width, height } : null;
    }
    case "dialogAnswer": {
      const id = boundedString(value.id, 128);
      if (!id || typeof value.accept !== "boolean") return null;
      const promptText = boundedString(value.promptText, 4_096);
      return {
        type: "dialogAnswer",
        id,
        accept: value.accept,
        ...(promptText !== null ? { promptText } : {}),
      };
    }
    case "fileChooserAnswer": {
      const id = boundedString(value.id, 128);
      if (!id || !Array.isArray(value.files) || value.files.length > 32) return null;
      const files: ServerBrowserUploadFile[] = [];
      let bytes = 0;
      for (const file of value.files as unknown[]) {
        if (!isRecord(file)) return null;
        const name = boundedString(file.name, 1_024);
        const mimeType = boundedString(file.mimeType ?? "", 256);
        const data = typeof file.data === "string" ? file.data : null;
        if (!name || mimeType === null || data === null) return null;
        bytes += Math.floor((data.length * 3) / 4);
        if (bytes > SERVER_BROWSER_UPLOAD_MAX_BYTES) return null;
        files.push({ name, mimeType, data });
      }
      return { type: "fileChooserAnswer", id, files };
    }
    case "closeTab": {
      const tabId = boundedString(value.tabId, 128);
      return tabId ? { type: "closeTab", tabId } : null;
    }
    default:
      return null;
  }
}
