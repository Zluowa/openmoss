import type { PageAppCallError, PageAppId, PageAppsCallInput } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetPageAppsWatchSocketForTests,
  resolvePageAppsWatchWsUrl,
  watchPageApp,
} from "./pageAppsClient";

interface SentWatchMessage {
  type: "watch" | "unwatch";
  id: string;
  input?: PageAppsCallInput;
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: SentWatchMessage[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentWatchMessage);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = MockWebSocket.CLOSED;
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) {
      listener(new Event("open"));
    }
  }

  emitMessage(payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }

  emitError(): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener(new Event("error"));
    }
  }

  emitClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) {
      listener({} as CloseEvent);
    }
  }
}

function makeInput(collection: string): PageAppsCallInput {
  return {
    appId: "app-1" as PageAppId,
    revision: 1,
    capability: "db",
    method: "watchQuery",
    args: { collection },
  };
}

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pageAppsClient watch WebSocket multiplexing", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    MockWebSocket.instances = [];
    resetPageAppsWatchSocketForTests();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:5733" },
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:43210/ws?token=desk-tok",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPageAppsWatchSocketForTests();
    vi.stubGlobal("WebSocket", originalWebSocket);
    vi.stubGlobal("fetch", originalFetch);
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      vi.stubGlobal("window", originalWindow);
    }
  });

  it("preserves desktop token query and multiplexes watch, event, end, error, and pre-open cancel", () => {
    expect(resolvePageAppsWatchWsUrl()).toBe(
      "ws://127.0.0.1:43210/api/page-apps/watch-ws?token=desk-tok",
    );

    const eventsA: unknown[] = [];
    const endsA: Array<PageAppCallError | undefined> = [];
    const eventsB: unknown[] = [];
    const endsB: Array<PageAppCallError | undefined> = [];
    const eventsC: unknown[] = [];
    const endsC: Array<PageAppCallError | undefined> = [];

    const inputA = makeInput("highlights");
    const inputB = makeInput("notes");
    const inputC = makeInput("canceled-before-open");

    watchPageApp(inputA, {
      next: (value) => eventsA.push(value),
      end: (err) => endsA.push(err),
    });
    watchPageApp(inputB, {
      next: (value) => eventsB.push(value),
      end: (err) => endsB.push(err),
    });
    const cancelC = watchPageApp(inputC, {
      next: (value) => eventsC.push(value),
      end: (err) => endsC.push(err),
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:43210/api/page-apps/watch-ws?token=desk-tok");
    expect(ws.sent).toEqual([]);

    // Canceling while CONNECTING removes it from the queue without contacting the server.
    cancelC();
    ws.emitOpen();

    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]?.type).toBe("watch");
    expect(ws.sent[0]?.input).toEqual(inputA);
    expect(ws.sent[1]?.type).toBe("watch");
    expect(ws.sent[1]?.input).toEqual(inputB);

    const idA = ws.sent[0]!.id;
    const idB = ws.sent[1]!.id;

    ws.emitMessage({ type: "event", id: idA, value: { docs: [{ id: "h1" }] } });
    ws.emitMessage({ type: "event", id: idB, value: { docs: [{ id: "n1" }] } });
    ws.emitMessage({ type: "end", id: idA });
    ws.emitMessage({ type: "event", id: idA, value: { docs: [{ id: "ignored" }] } });
    ws.emitMessage({
      type: "error",
      id: idB,
      error: { code: "forbidden", message: "denied" },
    });

    expect(eventsA).toEqual([{ docs: [{ id: "h1" }] }]);
    expect(endsA).toEqual([undefined]);
    expect(eventsB).toEqual([{ docs: [{ id: "n1" }] }]);
    expect(endsB).toEqual([{ code: "forbidden", message: "denied" }]);
    expect(eventsC).toEqual([]);
    expect(endsC).toEqual([]);
  });

  it("sends unwatch on cancel and closes idle socket after 15s of zero active watches", () => {
    vi.useFakeTimers();

    const ends1: Array<PageAppCallError | undefined> = [];
    const cancel1 = watchPageApp(makeInput("highlights"), {
      next: () => undefined,
      end: (err) => ends1.push(err),
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws1 = MockWebSocket.instances[0]!;
    ws1.emitOpen();
    expect(ws1.sent).toHaveLength(1);
    const id1 = ws1.sent[0]!.id;

    cancel1();
    expect(ws1.sent).toEqual([
      { type: "watch", id: id1, input: makeInput("highlights") },
      { type: "unwatch", id: id1 },
    ]);
    expect(ends1).toEqual([]);

    // Still reused before 15s idle timeout expires.
    vi.advanceTimersByTime(14_000);
    expect(ws1.closeCalls).toBe(0);

    const cancel2 = watchPageApp(makeInput("notes"), {
      next: () => undefined,
      end: () => undefined,
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws1.sent).toHaveLength(3);
    cancel2();

    // After 15s with zero active watches, the idle socket closes and next watch opens a fresh one.
    vi.advanceTimersByTime(15_000);
    expect(ws1.closeCalls).toBe(1);

    watchPageApp(makeInput("reading"), {
      next: () => undefined,
      end: () => undefined,
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("falls back transparently to SSE when WebSocket fails before opening", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      createSseResponse(['data: {"docs":[{"id":"sse-1"}]}\n\n', "event: end\ndata: {}\n\n"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: unknown[] = [];
    const ends: Array<PageAppCallError | undefined> = [];
    const input = makeInput("highlights");

    const cancel = watchPageApp(input, {
      next: (value) => events.push(value),
      end: (err) => ends.push(err),
    });

    const ws = MockWebSocket.instances[0]!;
    ws.emitError();
    ws.emitClose();

    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:43210/api/page-apps/watch?token=desk-tok",
    );
    expect(events).toEqual([{ docs: [{ id: "sse-1" }] }]);
    expect(ends).toEqual([undefined]);

    // Canceling after fallback should remain safe and idempotent.
    cancel();
  });

  it("cancels an in-flight SSE fallback when caller cancels after pre-open WS fallback", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {
        // intentionally keep pending until aborted
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cancel = watchPageApp(makeInput("notes"), {
      next: () => undefined,
      end: () => undefined,
    });

    const ws = MockWebSocket.instances[0]!;
    ws.emitError();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);
    cancel();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("ends every active subscription once with unavailable if an opened WebSocket disconnects", () => {
    const endsA: Array<PageAppCallError | undefined> = [];
    const endsB: Array<PageAppCallError | undefined> = [];

    watchPageApp(makeInput("highlights"), {
      next: () => undefined,
      end: (err) => endsA.push(err),
    });
    watchPageApp(makeInput("notes"), {
      next: () => undefined,
      end: (err) => endsB.push(err),
    });

    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitError();
    ws.emitClose();

    expect(endsA).toEqual([{ code: "unavailable", message: "连接中断。" }]);
    expect(endsB).toEqual([{ code: "unavailable", message: "连接中断。" }]);

    // Next watch opens a new WebSocket connection cleanly.
    watchPageApp(makeInput("highlights"), {
      next: () => undefined,
      end: () => undefined,
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
