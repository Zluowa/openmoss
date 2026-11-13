/**
 * The viewer side of a server-hosted browser stream: one WebSocket per
 * thread, JPEG frames in, acks and input out.
 *
 * Every frame is acked as soon as it arrives, which is what lets the server
 * send the next one; painting decodes one frame at a time and keeps only the
 * newest waiting, so a slow device skips frames instead of falling behind.
 *
 * @module serverBrowserStream
 */
import {
  SERVER_BROWSER_DOWNLOAD_PATH,
  SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM,
  SERVER_BROWSER_STREAM_ACK,
  SERVER_BROWSER_STREAM_PATH,
  SERVER_BROWSER_STREAM_PRESENCE_PARAM,
  SERVER_BROWSER_STREAM_THREAD_PARAM,
  SERVER_BROWSER_STREAM_UNAVAILABLE_CLOSE_CODE,
  decodeServerBrowserServerMessage,
  type ServerBrowserStreamControl,
  type ServerBrowserStreamInput,
  type ServerBrowserStreamServerMessage,
  type ServerBrowserStreamTab,
} from "@moss/shared/serverBrowserStream";

import { makeSocketUrl } from "../wsTransport";

export interface ServerBrowserStreamEvents {
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onTabs: (
    tabs: ReadonlyArray<ServerBrowserStreamTab>,
    selectedTabId: string | null,
  ) => void;
  readonly onViewport: (viewport: { readonly width: number; readonly height: number }) => void;
  readonly onControl: (control: ServerBrowserStreamControl | null) => void;
  readonly onDialog?: (dialog: { kind: string; message: string; action: string }) => void;
  /** The agent opened a page and asked for it to be shown. */
  readonly onReveal?: (tabId: string) => void;
  /**
   * A dialog, file picker, download or copied text for the person in control,
   * or a page load the server refused.
   */
  readonly onPersonal?: (
    message: Extract<
      ServerBrowserStreamServerMessage,
      {
        type:
          | "dialogOpen"
          | "dialogClosed"
          | "fileChooser"
          | "fileChooserClosed"
          | "download"
          | "clipboard"
          | "navigationBlocked";
      }
    >,
  ) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  /** The server has no browser to offer; the client stopped. */
  readonly onUnavailable: () => void;
}

export interface ServerBrowserStreamClient {
  /** Send viewer input; false when it cannot be delivered right now. */
  readonly send: (input: ServerBrowserStreamInput) => boolean;
  readonly stop: () => void;
}

export interface ServerBrowserStreamTarget {
  readonly threadId: string;
  /** Backing-store size in device pixels: the server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly interactive?: boolean;
  /** Tabs and reveal requests only, no frames: a chat watching for the agent's browser. */
  readonly presence?: boolean;
  /** The server's socket address; defaults to the app's own connection. */
  readonly explicitUrl?: string | null;
  /** Tests inject a socket; the app uses the browser's. */
  readonly createSocket?: (url: string) => WebSocket;
}

const MAX_RETRY_MS = 10_000;

export function serverBrowserStreamUrl(target: ServerBrowserStreamTarget): string {
  const url = new URL(makeSocketUrl(target.explicitUrl ?? null, SERVER_BROWSER_STREAM_PATH));
  url.searchParams.set(SERVER_BROWSER_STREAM_THREAD_PARAM, target.threadId);
  url.searchParams.set("maxWidth", String(Math.max(1, Math.round(target.maxWidth))));
  url.searchParams.set("maxHeight", String(Math.max(1, Math.round(target.maxHeight))));
  if (target.interactive === false) url.searchParams.set("interactive", "false");
  if (target.presence === true) url.searchParams.set(SERVER_BROWSER_STREAM_PRESENCE_PARAM, "true");
  return url.toString();
}

/**
 * The HTTP address of a download the server offered, on the app's own server.
 * It keeps the connection's own query, so it carries the same credential the
 * viewer socket does (the desktop's loopback token; a browser sends its cookie).
 */
export function serverBrowserDownloadUrl(path: string, explicitUrl: string | null = null): string {
  const offered = new URL(path, "http://moss.invalid");
  const url = new URL(makeSocketUrl(explicitUrl, SERVER_BROWSER_DOWNLOAD_PATH));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.searchParams.set(
    SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM,
    offered.searchParams.get(SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM) ?? "",
  );
  return url.toString();
}

export function createServerBrowserStreamClient(
  target: ServerBrowserStreamTarget,
  events: ServerBrowserStreamEvents,
): ServerBrowserStreamClient {
  const url = serverBrowserStreamUrl(target);
  const createSocket = target.createSocket ?? ((address: string) => new WebSocket(address));
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: ServerBrowserStreamControl | null = null;

  const connect = () => {
    if (stopped) return;
    const ws = createSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(SERVER_BROWSER_STREAM_ACK);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      const message = decodeServerBrowserServerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "tabs":
          failures = 0;
          events.onTabs(message.tabs, message.selectedTabId);
          return;
        case "viewport":
          events.onViewport({ width: message.width, height: message.height });
          return;
        case "control": {
          const { type: _type, ...next } = message;
          control = next;
          events.onControl(next);
          return;
        }
        case "dialog":
          events.onDialog?.(message);
          return;
        case "reveal":
          events.onReveal?.(message.tabId);
          return;
        case "error":
          return;
        default:
          events.onPersonal?.(message);
          return;
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      events.onControl(null);
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === SERVER_BROWSER_STREAM_UNAVAILABLE_CLOSE_CODE) {
        stopped = true;
        events.onUnavailable();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, MAX_RETRY_MS));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      // Opening, choosing or closing a tab needs no control of the watched one;
      // the server checks access.
      if (
        input.type !== "selectTab" &&
        input.type !== "open" &&
        input.type !== "resize" &&
        input.type !== "closeTab"
      ) {
        if (!control?.canOperate) return false;
        if (input.type !== "takeControl" && control.controller !== "you") return false;
      }
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
  };
}

export interface ServerBrowserFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the newest waiting frame. */
export function createServerBrowserFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
): ServerBrowserFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.();
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

/**
 * Map a point on the displayed canvas to page CSS pixels. The canvas keeps the
 * page's aspect ratio inside its box, so the letterbox is subtracted first.
 */
export function canvasPointToPage(
  point: { readonly x: number; readonly y: number },
  box: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
  const drawnWidth = viewport.width * scale;
  const drawnHeight = viewport.height * scale;
  const left = (box.width - drawnWidth) / 2;
  const top = (box.height - drawnHeight) / 2;
  const x = (point.x - left) / scale;
  const y = (point.y - top) / scale;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return null;
  return { x, y };
}
