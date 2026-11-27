// FILE: pageAppsClient.ts
// Purpose: The shell's HTTP & multiplexed WebSocket client for 应用页:
// JSON requests to /api/page-apps/<op>, multiplexed WS streams on
// /api/page-apps/watch-ws, and SSE fallback on /api/page-apps/watch.
// Layer: Web pageApps

import type {
  PageAppCallError,
  PageAppsCallInput,
  PageAppsCallResult,
  PageAppsConsentInput,
  PageAppsConsentResult,
  PageAppsGenerateCoverInput,
  PageAppsGenerateCoverResult,
  PageAppsListInput,
  PageAppsListResult,
  PageAppsMutateInput,
  PageAppsMutateResult,
  PageAppsOpenFrameInput,
  PageAppsOpenFrameResult,
  PageAppsReadInput,
  PageAppsReadResult,
  PageAppsVersionsInput,
  PageAppsVersionsResult,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

async function post<T>(op: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(resolveWsHttpUrl(`/api/page-apps/${op}`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new PageAppCapabilityError("unavailable", "无法连接到 Moss。");
  }
  const json = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok || !json || (json as { error?: unknown }).error) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new PageAppCapabilityError(
      error?.code ?? "unavailable",
      error?.message ?? `HTTP ${response.status}`,
    );
  }
  return json as T;
}

export interface PageAppsWatchSink {
  readonly next: (value: unknown) => void;
  readonly end: (error?: PageAppCallError) => void;
}

const WATCH_WS_IDLE_CLOSE_MS = 15_000;

interface WatchEntry {
  readonly id: string;
  readonly input: PageAppsCallInput;
  readonly sink: PageAppsWatchSink;
  state: "queued" | "active" | "fallback" | "closed";
  sent: boolean;
  fallbackCancel?: () => void;
}

type WatchServerMessage =
  | { type: "event"; id: string; value?: unknown }
  | { type: "error"; id: string; error?: PageAppCallError }
  | { type: "end"; id: string };

/** Resolves the WebSocket URL for `/api/page-apps/watch-ws`, keeping any legacy token query. */
export function resolvePageAppsWatchWsUrl(): string {
  return resolveWsHttpUrl("/api/page-apps/watch-ws").replace(/^http(s?):/, "ws$1:");
}

let nextWatchSubscriptionId = 0;
let activeWatchSocket: PageAppsWatchSocket | null = null;

/**
 * Per-window lazy multiplexed WebSocket manager for `watch` subscriptions.
 * Avoids exhausting Chromium's HTTP/1.1 6-connection-per-origin pool when main and
 * standalone windows keep multiple `onSnapshot` subscriptions open concurrently.
 */
export class PageAppsWatchSocket {
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly entries = new Map<string, WatchEntry>();
  private readonly url: string;
  private readonly idleCloseMs: number;
  private readonly fallbackWatch: (input: PageAppsCallInput, sink: PageAppsWatchSink) => () => void;

  constructor(options?: {
    url?: string;
    idleCloseMs?: number;
    fallbackWatch?: (input: PageAppsCallInput, sink: PageAppsWatchSink) => () => void;
  }) {
    this.url = options?.url ?? resolvePageAppsWatchWsUrl();
    this.idleCloseMs = options?.idleCloseMs ?? WATCH_WS_IDLE_CLOSE_MS;
    this.fallbackWatch = options?.fallbackWatch ?? watchPageAppSse;
    this.connect();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get activeCount(): number {
    return this.entries.size;
  }

  subscribe(input: PageAppsCallInput, sink: PageAppsWatchSink): () => void {
    const id = `w-${++nextWatchSubscriptionId}`;
    const entry: WatchEntry = {
      id,
      input,
      sink,
      state: "queued",
      sent: false,
    };

    if (this.closed) {
      entry.state = "fallback";
      entry.fallbackCancel = this.fallbackWatch(input, sink);
      return () => {
        if (entry.state !== "fallback") return;
        entry.state = "closed";
        entry.fallbackCancel?.();
      };
    }

    this.clearIdleTimer();
    this.entries.set(id, entry);

    if (this.opened && this.ws && this.ws.readyState === 1) {
      entry.state = "active";
      entry.sent = true;
      this.sendPayload({ type: "watch", id, input });
    }

    return () => {
      if (entry.state === "closed") return;
      if (entry.state === "fallback") {
        entry.state = "closed";
        entry.fallbackCancel?.();
        return;
      }
      const wasSent = entry.sent;
      entry.state = "closed";
      this.entries.delete(id);
      if (wasSent && !this.closed && this.opened && this.ws && this.ws.readyState === 1) {
        this.sendPayload({ type: "unwatch", id });
      }
      this.scheduleIdleCloseIfEmpty();
    };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    if (activeWatchSocket === this) {
      activeWatchSocket = null;
    }
    this.entries.clear();
    try {
      this.ws?.close();
    } catch {
      // ignore close errors during cleanup
    }
  }

  private connect(): void {
    if (typeof WebSocket !== "function") {
      this.handleTransportTermination();
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.handleTransportTermination();
      return;
    }
    this.ws = socket;

    socket.addEventListener("open", () => {
      if (this.closed) return;
      this.opened = true;
      for (const entry of this.entries.values()) {
        if (entry.state !== "queued" || entry.sent) continue;
        entry.state = "active";
        entry.sent = true;
        this.sendPayload({ type: "watch", id: entry.id, input: entry.input });
      }
      this.scheduleIdleCloseIfEmpty();
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.closed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const msg = parsed as Partial<WatchServerMessage>;
      if (typeof msg.id !== "string" || typeof msg.type !== "string") return;
      const entry = this.entries.get(msg.id);
      if (!entry || entry.state !== "active") return;

      if (msg.type === "event") {
        entry.sink.next(msg.value);
        return;
      }
      if (msg.type === "end") {
        this.entries.delete(msg.id);
        entry.state = "closed";
        this.scheduleIdleCloseIfEmpty();
        entry.sink.end();
        return;
      }
      if (msg.type === "error") {
        this.entries.delete(msg.id);
        entry.state = "closed";
        this.scheduleIdleCloseIfEmpty();
        const err =
          msg.error && typeof msg.error.code === "string" && typeof msg.error.message === "string"
            ? msg.error
            : ({ code: "unavailable", message: "连接中断。" } satisfies PageAppCallError);
        entry.sink.end(err);
      }
    });

    socket.addEventListener("error", () => {
      this.handleTransportTermination();
    });

    socket.addEventListener("close", () => {
      this.handleTransportTermination();
    });
  }

  private sendPayload(payload: unknown): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      this.handleTransportTermination();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleCloseIfEmpty(): void {
    if (this.closed || this.entries.size > 0 || this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closed || this.entries.size > 0) return;
      this.closed = true;
      if (activeWatchSocket === this) {
        activeWatchSocket = null;
      }
      try {
        this.ws?.close();
      } catch {
        // ignore close errors on idle socket shutdown
      }
    }, this.idleCloseMs);
  }

  private handleTransportTermination(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    if (activeWatchSocket === this) {
      activeWatchSocket = null;
    }
    const pending = [...this.entries.values()];
    this.entries.clear();
    try {
      this.ws?.close();
    } catch {
      // ignore close errors on already-failed sockets
    }
    if (!this.opened) {
      for (const entry of pending) {
        if (entry.state !== "queued") continue;
        entry.state = "fallback";
        entry.fallbackCancel = this.fallbackWatch(entry.input, entry.sink);
      }
      return;
    }
    for (const entry of pending) {
      if (entry.state !== "active") continue;
      entry.state = "closed";
      entry.sink.end({ code: "unavailable", message: "连接中断。" });
    }
  }
}

/** Resets the shared multiplexed watch socket (used by tests). */
export function resetPageAppsWatchSocketForTests(): void {
  activeWatchSocket?.dispose();
  activeWatchSocket = null;
}

function getOrCreateWatchSocket(): PageAppsWatchSocket {
  if (!activeWatchSocket || activeWatchSocket.isClosed) {
    activeWatchSocket = new PageAppsWatchSocket();
  }
  return activeWatchSocket;
}

/** Opens SSE `watch` fallback; returns cancel. `end` fires exactly once. */
export function watchPageAppSse(input: PageAppsCallInput, sink: PageAppsWatchSink): () => void {
  const controller = new AbortController();
  let ended = false;
  const finish = (error?: PageAppCallError) => {
    if (ended) return;
    ended = true;
    sink.end(error);
  };
  void (async () => {
    let response: Response;
    try {
      response = await fetch(resolveWsHttpUrl("/api/page-apps/watch"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) finish({ code: "unavailable", message: "无法连接到 Moss。" });
      return;
    }
    if (!response.ok || !response.body) {
      const json = (await response.json().catch(() => null)) as { error?: PageAppCallError } | null;
      finish(json?.error ?? { code: "unavailable", message: `HTTP ${response.status}` });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          const parsed = data ? JSON.parse(data) : null;
          if (event === "error") finish(parsed as PageAppCallError);
          else if (event === "end") finish();
          else if (!ended) sink.next(parsed);
        }
      }
      finish();
    } catch {
      if (!controller.signal.aborted) finish({ code: "unavailable", message: "连接中断。" });
    }
  })();
  return () => {
    ended = true;
    controller.abort();
  };
}

/** Opens `watch` over the per-window multiplexed WebSocket (with SSE fallback); returns cancel. */
export function watchPageApp(input: PageAppsCallInput, sink: PageAppsWatchSink): () => void {
  if (typeof WebSocket !== "function") {
    return watchPageAppSse(input, sink);
  }
  return getOrCreateWatchSocket().subscribe(input, sink);
}

export const pageAppsClient = {
  list: (input: PageAppsListInput) => post<PageAppsListResult>("list", input),
  listPublished: (input: { scopeSpaceId?: PageAppsListInput["scopeSpaceId"] } = {}) =>
    post<import("@moss/contracts").PageAppsListPublishedResult>("list-published", input),
  read: (input: PageAppsReadInput) => post<PageAppsReadResult>("read", input),
  versions: (input: PageAppsVersionsInput) => post<PageAppsVersionsResult>("versions", input),
  mutate: (input: PageAppsMutateInput, signal?: AbortSignal) =>
    post<PageAppsMutateResult>("mutate", input, signal),
  generateCover: (input: PageAppsGenerateCoverInput, signal?: AbortSignal) =>
    post<PageAppsGenerateCoverResult>("generate-cover", input, signal),
  consent: (input: PageAppsConsentInput) => post<PageAppsConsentResult>("consent", input),
  openFrame: (input: PageAppsOpenFrameInput) => post<PageAppsOpenFrameResult>("open-frame", input),
  call: (input: PageAppsCallInput, signal?: AbortSignal) =>
    post<PageAppsCallResult>("call", input, signal),
  watch: watchPageApp,
};

export type PageAppsClient = typeof pageAppsClient;
