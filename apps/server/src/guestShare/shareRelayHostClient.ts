/**
 * One outbound WebSocket per live share to the Moss share relay (`GET /v1/shares/<id>/host`).
 * Guest HTTP requests arrive multiplexed over it (`req`, body chunks, `req-end`, `cancel`) and
 * are answered the same way (`res`, body chunks, `res-end` / `res-error`). The client keeps the
 * socket alive with backoff for as long as the share lives; the relay's close codes say when to
 * register again (4404), when another host of the same owner took over (4409), and when the
 * share ended (4410).
 *
 * This is plain Node code on purpose: `ws` is callback-driven, and the service bridges it into
 * Effect at the request handler boundary.
 */
import {
  SHARE_RELAY_BINARY_HEADER_BYTES,
  SHARE_RELAY_BINARY_KIND,
  SHARE_RELAY_CHUNK_BYTES,
  SHARE_RELAY_CLOSE_CODES,
  SHARE_RELAY_HELLO_TIMEOUT_MS,
  SHARE_RELAY_HOST_IDLE_TIMEOUT_MS,
  SHARE_RELAY_MAX_REQUEST_BODY_BYTES,
  SHARE_RELAY_PATHS,
  SHARE_RELAY_PROTOCOL_VERSION,
  ShareRelayRelayFrame,
  type GuestShareId,
  type GuestShareRelayStatus,
  type ShareRelayHostFrame,
} from "@synara/contracts";
import { Schema } from "effect";
import WebSocket from "ws";

import { createLogger } from "../logger.ts";

export interface GuestRelayRequest {
  readonly method: "GET" | "POST" | "HEAD";
  readonly route: string;
  /** The raw query string without `?`, possibly empty. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Null when the relay said the request has no body. */
  readonly body: ReadableStream<Uint8Array> | null;
  /** Aborts when the guest went away or the relay socket dropped. */
  readonly signal: AbortSignal;
}

export interface GuestRelayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type GuestRelayRequestHandler = (request: GuestRelayRequest) => Promise<GuestRelayResponse>;

export interface ShareRelayHostBackoff {
  readonly initialMs: number;
  readonly maxMs: number;
  /** Wait after another host took over, long enough not to fight it. */
  readonly replacedMs: number;
}

export const DEFAULT_SHARE_RELAY_HOST_BACKOFF: ShareRelayHostBackoff = {
  initialMs: 1_000,
  maxMs: 30_000,
  replacedMs: 60_000,
};

export interface ShareRelayHostClientOptions {
  readonly origin: string;
  readonly shareId: GuestShareId;
  readonly hostKey: string;
  readonly handle: GuestRelayRequestHandler;
  readonly onStatus: (status: GuestShareRelayStatus) => void;
  /** The relay ended the share (4410); the client has stopped and must not be restarted. */
  readonly onEnded: () => void;
  /** The relay forgot the share (4404). Resolves true once it is registered again. */
  readonly reregister: () => Promise<boolean>;
  readonly backoff?: ShareRelayHostBackoff;
  readonly webSocket?: typeof WebSocket;
}

const logger = createLogger("guest-share.relay");

// Outbound body bytes the socket may hold before a response pauses reading.
const SEND_HIGH_WATER_BYTES = 1024 * 1024;
const SEND_LOW_WATER_BYTES = 256 * 1024;
const SEND_DRAIN_POLL_MS = 20;
const HOST_MAX_PAYLOAD_BYTES = SHARE_RELAY_CHUNK_BYTES + SHARE_RELAY_BINARY_HEADER_BYTES + 1024;

const decodeRelayFrame = Schema.decodeUnknownOption(ShareRelayRelayFrame);

const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  SHARE_RELAY_CLOSE_CODES.badHello,
  SHARE_RELAY_CLOSE_CODES.badHostKey,
  SHARE_RELAY_CLOSE_CODES.unsupportedProtocol,
]);

interface InFlightRequest {
  readonly id: number;
  readonly abort: AbortController;
  /** Feeds the request body stream; null once the body ended or the request has none. */
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
  bodyBytes: number;
}

export function relayWebSocketUrl(origin: string, shareId: GuestShareId): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = SHARE_RELAY_PATHS.host(shareId);
  return url.toString();
}

/** Builds one binary frame: kind, request id (uint32 big-endian), payload. */
export function encodeRelayBodyFrame(
  kind: (typeof SHARE_RELAY_BINARY_KIND)[keyof typeof SHARE_RELAY_BINARY_KIND],
  requestId: number,
  payload: Uint8Array,
): Buffer {
  const frame = Buffer.allocUnsafe(SHARE_RELAY_BINARY_HEADER_BYTES + payload.byteLength);
  frame[0] = kind;
  frame.writeUInt32BE(requestId, 1);
  frame.set(payload, SHARE_RELAY_BINARY_HEADER_BYTES);
  return frame;
}

export function decodeRelayBodyFrame(
  frame: Uint8Array,
): { readonly kind: number; readonly requestId: number; readonly payload: Uint8Array } | null {
  if (frame.byteLength < SHARE_RELAY_BINARY_HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    kind: frame[0]!,
    requestId: view.getUint32(1, false),
    payload: frame.subarray(SHARE_RELAY_BINARY_HEADER_BYTES),
  };
}

const toBuffer = (data: WebSocket.RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);

const DRAIN_POLL_MS = 25;

export class ShareRelayHostClient {
  readonly #options: ShareRelayHostClientOptions;
  readonly #backoff: ShareRelayHostBackoff;
  readonly #WebSocketCtor: typeof WebSocket;
  readonly #inFlight = new Map<number, InFlightRequest>();
  #socket: WebSocket | null = null;
  #status: GuestShareRelayStatus = "offline";
  #attempt = 0;
  #stopped = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #helloTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(options: ShareRelayHostClientOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? DEFAULT_SHARE_RELAY_HOST_BACKOFF;
    this.#WebSocketCtor = options.webSocket ?? WebSocket;
  }

  get status(): GuestShareRelayStatus {
    return this.#status;
  }

  start(): void {
    if (this.#stopped || this.#socket !== null || this.#reconnectTimer !== null) return;
    this.#connect();
  }

  /**
   * Closes once the responses in flight have finished, or after `timeoutMs`. Ending a share
   * sends each guest stream `ended` first, and this lets those frames reach the relay before
   * the socket that carries them goes away.
   */
  async closeWhenDrained(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#stopped && this.#inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    this.close();
  }

  /** Stops reconnecting, closes the socket, and aborts every request in flight. */
  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearReconnect();
    this.#teardownSocket(1000, "host closed the share");
    this.#setStatus("offline");
  }

  #setStatus(status: GuestShareRelayStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatus(status);
  }

  #connect(): void {
    this.#clearReconnect();
    this.#setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new this.#WebSocketCtor(
        relayWebSocketUrl(this.#options.origin, this.#options.shareId),
        {
          handshakeTimeout: SHARE_RELAY_HELLO_TIMEOUT_MS,
          maxPayload: HOST_MAX_PAYLOAD_BYTES,
          perMessageDeflate: false,
        },
      );
    } catch (cause) {
      logger.warn("relay socket could not be created", {
        shareId: this.#options.shareId,
        cause: String(cause),
      });
      this.#scheduleReconnect(this.#nextBackoffMs());
      return;
    }
    this.#socket = socket;
    socket.on("open", () => {
      if (this.#socket !== socket) return;
      this.#sendFrame({
        t: "hello",
        shareId: this.#options.shareId,
        hostKey: this.#options.hostKey,
        protocolVersion: SHARE_RELAY_PROTOCOL_VERSION,
      });
      this.#helloTimer = setTimeout(() => {
        if (this.#socket !== socket) return;
        logger.warn("relay did not answer hello", { shareId: this.#options.shareId });
        socket.terminate();
      }, SHARE_RELAY_HELLO_TIMEOUT_MS);
      this.#touchIdle(socket);
    });
    socket.on("message", (data, isBinary) => {
      if (this.#socket !== socket) return;
      this.#touchIdle(socket);
      if (isBinary) this.#onBinary(toBuffer(data));
      else this.#onText(toBuffer(data).toString("utf8"), socket);
    });
    socket.on("error", (error) => {
      if (this.#socket !== socket) return;
      logger.warn("relay socket error", {
        shareId: this.#options.shareId,
        cause: error.message,
      });
    });
    socket.on("close", (code, reason) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearTimers();
      this.#abortInFlight();
      this.#setStatus("offline");
      if (!this.#stopped) this.#onClosed(code, toBuffer(reason).toString("utf8"));
    });
  }

  #onClosed(code: number, reason: string): void {
    const shareId = this.#options.shareId;
    if (code === SHARE_RELAY_CLOSE_CODES.ended) {
      logger.info("relay ended the share", { shareId });
      this.#stopped = true;
      this.#options.onEnded();
      return;
    }
    if (code === SHARE_RELAY_CLOSE_CODES.restarting) {
      // A relay deploy or restart: come back promptly; the new process may answer 4404.
      logger.info("relay is restarting; reconnecting", { shareId });
      this.#attempt = 0;
      this.#scheduleReconnect(this.#nextBackoffMs());
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      logger.error("relay refused the host connection", { shareId, code, reason });
      this.#stopped = true;
      return;
    }
    if (code === SHARE_RELAY_CLOSE_CODES.replaced) {
      logger.warn("another host took over the share; backing off", { shareId });
      this.#attempt = 0;
      this.#scheduleReconnect(this.#backoff.replacedMs);
      return;
    }
    if (code === SHARE_RELAY_CLOSE_CODES.unknownShare) {
      logger.info("relay forgot the share; registering again", { shareId });
      void this.#options
        .reregister()
        .then((registered) => {
          if (this.#stopped) return;
          this.#scheduleReconnect(registered ? this.#backoff.initialMs : this.#nextBackoffMs());
        })
        .catch((cause: unknown) => {
          if (this.#stopped) return;
          logger.warn("re-registration failed", { shareId, cause: String(cause) });
          this.#scheduleReconnect(this.#nextBackoffMs());
        });
      return;
    }
    this.#scheduleReconnect(this.#nextBackoffMs());
  }

  #nextBackoffMs(): number {
    const base = Math.min(this.#backoff.maxMs, this.#backoff.initialMs * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 16);
    // Full jitter keeps many hosts from reconnecting in lockstep after a relay restart.
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  #scheduleReconnect(delayMs: number): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#stopped) this.#connect();
    }, delayMs);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #clearTimers(): void {
    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #touchIdle(socket: WebSocket): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#socket !== socket) return;
      logger.warn("relay socket idle; reconnecting", { shareId: this.#options.shareId });
      socket.terminate();
    }, SHARE_RELAY_HOST_IDLE_TIMEOUT_MS);
  }

  #teardownSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clearTimers();
    this.#abortInFlight();
    if (socket === null) return;
    socket.removeAllListeners();
    socket.on("error", () => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  #abortInFlight(): void {
    for (const request of this.#inFlight.values()) this.#cancelRequest(request);
    this.#inFlight.clear();
  }

  #cancelRequest(request: InFlightRequest): void {
    request.abort.abort();
    if (request.bodyController !== null) {
      try {
        request.bodyController.error(new Error("The guest request was cancelled."));
      } catch {
        // Already closed or errored.
      }
      request.bodyController = null;
    }
  }

  #sendFrame(frame: ShareRelayHostFrame): boolean {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  #onText(text: string, socket: WebSocket): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn("relay sent a malformed frame", { shareId: this.#options.shareId });
      return;
    }
    const frame = decodeRelayFrame(parsed);
    if (frame._tag === "None") {
      logger.warn("relay sent an unknown frame", { shareId: this.#options.shareId });
      return;
    }
    switch (frame.value.t) {
      case "hello-ok":
        if (this.#helloTimer !== null) {
          clearTimeout(this.#helloTimer);
          this.#helloTimer = null;
        }
        this.#attempt = 0;
        this.#setStatus("online");
        return;
      case "ping":
        this.#sendFrame({ t: "pong" });
        return;
      case "req":
        this.#onRequest(frame.value, socket);
        return;
      case "req-end": {
        const request = this.#inFlight.get(frame.value.id);
        if (request === undefined || request.bodyController === null) return;
        try {
          request.bodyController.close();
        } catch {
          // Already closed.
        }
        request.bodyController = null;
        return;
      }
      case "cancel": {
        const request = this.#inFlight.get(frame.value.id);
        if (request !== undefined) {
          this.#inFlight.delete(request.id);
          this.#cancelRequest(request);
        }
        return;
      }
    }
  }

  #onBinary(frame: Buffer): void {
    const decoded = decodeRelayBodyFrame(frame);
    if (decoded === null || decoded.kind !== SHARE_RELAY_BINARY_KIND.requestBody) return;
    const request = this.#inFlight.get(decoded.requestId);
    if (request === undefined || request.bodyController === null) return;
    request.bodyBytes += decoded.payload.byteLength;
    if (request.bodyBytes > SHARE_RELAY_MAX_REQUEST_BODY_BYTES) {
      this.#inFlight.delete(request.id);
      this.#cancelRequest(request);
      return;
    }
    try {
      // The relay caps a request body, so what waits here is bounded even when the handler
      // has not started reading yet.
      request.bodyController.enqueue(Uint8Array.from(decoded.payload));
    } catch {
      request.bodyController = null;
    }
  }

  #onRequest(frame: Extract<ShareRelayRelayFrame, { readonly t: "req" }>, socket: WebSocket): void {
    if (this.#inFlight.has(frame.id)) {
      logger.warn("relay reused a request id", { shareId: this.#options.shareId, id: frame.id });
      return;
    }
    const request: InFlightRequest = {
      id: frame.id,
      abort: new AbortController(),
      bodyController: null,
      bodyBytes: 0,
    };
    this.#inFlight.set(frame.id, request);
    const body = frame.hasBody
      ? new ReadableStream<Uint8Array>({
          start: (controller) => {
            request.bodyController = controller;
          },
          cancel: () => {
            request.bodyController = null;
          },
        })
      : null;
    void this.#respond(
      request,
      {
        method: frame.method,
        route: frame.route,
        query: frame.query,
        headers: frame.headers,
        body,
        signal: request.abort.signal,
      },
      socket,
    );
  }

  async #respond(
    request: InFlightRequest,
    relayRequest: GuestRelayRequest,
    socket: WebSocket,
  ): Promise<void> {
    let response: GuestRelayResponse;
    try {
      response = await this.#options.handle(relayRequest);
    } catch (cause) {
      if (request.abort.signal.aborted) return;
      logger.error("guest request handler failed", {
        shareId: this.#options.shareId,
        route: relayRequest.route,
        cause: String(cause),
      });
      response = {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: null,
      };
    }
    const live = () =>
      this.#socket === socket &&
      socket.readyState === WebSocket.OPEN &&
      !request.abort.signal.aborted;
    if (!live()) {
      await response.body?.cancel().catch(() => undefined);
      this.#inFlight.delete(request.id);
      return;
    }
    this.#sendFrame({
      t: "res",
      id: request.id,
      status: response.status,
      headers: response.headers,
    });
    if (response.body === null || relayRequest.method === "HEAD") {
      await response.body?.cancel().catch(() => undefined);
      this.#sendFrame({ t: "res-end", id: request.id });
      this.#inFlight.delete(request.id);
      return;
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!live()) throw new Error("The guest request was cancelled.");
        await this.#sendBody(request.id, value, socket);
      }
      this.#sendFrame({ t: "res-end", id: request.id });
    } catch (cause) {
      if (live()) {
        logger.warn("guest response body failed", {
          shareId: this.#options.shareId,
          route: relayRequest.route,
          cause: String(cause),
        });
        this.#sendFrame({ t: "res-error", id: request.id });
      }
      await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
      this.#inFlight.delete(request.id);
    }
  }

  async #sendBody(requestId: number, bytes: Uint8Array, socket: WebSocket): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += SHARE_RELAY_CHUNK_BYTES) {
      const payload = bytes.subarray(offset, offset + SHARE_RELAY_CHUNK_BYTES);
      socket.send(encodeRelayBodyFrame(SHARE_RELAY_BINARY_KIND.responseBody, requestId, payload));
      // Streams (SSE, files) must not pile up in the socket's send buffer when the guest's link
      // is slower than the producer.
      while (socket.bufferedAmount > SEND_HIGH_WATER_BYTES) {
        if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error("The relay socket closed while a response was streaming.");
        }
        await new Promise((resolve) => setTimeout(resolve, SEND_DRAIN_POLL_MS));
        if (socket.bufferedAmount <= SEND_LOW_WATER_BYTES) break;
      }
    }
  }
}
