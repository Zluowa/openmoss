// FILE: fakeShareRelay.ts
// Purpose: An in-process Moss share relay for tests: the registration HTTP API and the host
//          WebSocket, with a guest-side helper that forwards requests the way the relay does.
// Layer: Server test utility (imported by *.test.ts only; never by production code)

import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  SHARE_RELAY_BINARY_KIND,
  SHARE_RELAY_CHUNK_BYTES,
  SHARE_RELAY_CLOSE_CODES,
  SHARE_RELAY_HOST_KEY_HEADER,
  SHARE_RELAY_PROTOCOL_VERSION,
  ShareRelayHostFrame,
  ShareRelayRegisterRequest,
  type ShareRelayRelayFrame,
} from "@synara/contracts";
import { Schema } from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { decodeRelayBodyFrame, encodeRelayBodyFrame } from "../shareRelayHostClient.ts";

const decodeHostFrame = Schema.decodeUnknownOption(ShareRelayHostFrame);
const decodeRegisterRequest = Schema.decodeUnknownOption(ShareRelayRegisterRequest);

export interface FakeRelayRegistration {
  readonly shareId: string;
  readonly hostKeyHash: string;
  readonly expiresAt: string;
  readonly bearer: string;
}

export interface RelayedResponseHead {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** A guest request as the relay sees its answer: the head, then body chunks until the end. */
export class RelayedResponse {
  readonly head: Promise<RelayedResponseHead>;
  #resolveHead!: (head: RelayedResponseHead) => void;
  readonly #chunks: Array<Uint8Array | null | Error> = [];
  readonly #waiters: Array<(value: Uint8Array | null | Error) => void> = [];

  constructor() {
    this.head = new Promise((resolve) => {
      this.#resolveHead = resolve;
    });
  }

  /** @internal */
  _head(head: RelayedResponseHead): void {
    this.#resolveHead(head);
  }

  /** @internal */
  _push(value: Uint8Array | null | Error): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#chunks.push(value);
  }

  /** The next body chunk; null once `res-end` arrived; throws on `res-error`. */
  async next(): Promise<Uint8Array | null> {
    const value =
      this.#chunks.length > 0
        ? this.#chunks.shift()!
        : await new Promise<Uint8Array | null | Error>((resolve) => this.#waiters.push(resolve));
    if (value instanceof Error) throw value;
    return value;
  }

  /** The whole body as text. */
  async text(): Promise<string> {
    const parts: Array<Uint8Array> = [];
    while (true) {
      const chunk = await this.next();
      if (chunk === null) break;
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString("utf8");
  }
}

export interface GuestRequestInput {
  readonly method: "GET" | "POST" | "HEAD";
  readonly route: string;
  readonly query?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Body chunks to forward, or null for no body. */
  readonly body?: ReadonlyArray<Uint8Array> | null;
}

/** One connected host socket and the requests in flight on it. */
export class FakeRelayHost {
  readonly socket: WebSocket;
  readonly shareId: string;
  readonly pongs: Array<void> = [];
  readonly frames: Array<ShareRelayHostFrame> = [];
  #nextRequestId = 1;
  readonly #responses = new Map<number, RelayedResponse>();
  #pongWaiters: Array<() => void> = [];

  constructor(socket: WebSocket, shareId: string) {
    this.socket = socket;
    this.shareId = shareId;
    socket.on("message", (data, isBinary) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        const decoded = decodeRelayBodyFrame(buffer);
        if (decoded === null || decoded.kind !== SHARE_RELAY_BINARY_KIND.responseBody) return;
        this.#responses.get(decoded.requestId)?._push(Uint8Array.from(decoded.payload));
        return;
      }
      const frame = decodeHostFrame(JSON.parse(buffer.toString("utf8")));
      if (frame._tag === "None") return;
      this.frames.push(frame.value);
      switch (frame.value.t) {
        case "res":
          this.#responses
            .get(frame.value.id)
            ?._head({ status: frame.value.status, headers: frame.value.headers });
          return;
        case "res-end":
          this.#responses.get(frame.value.id)?._push(null);
          this.#responses.delete(frame.value.id);
          return;
        case "res-error":
          this.#responses.get(frame.value.id)?._push(new Error("res-error"));
          this.#responses.delete(frame.value.id);
          return;
        case "pong":
          this.pongs.push(undefined);
          for (const waiter of this.#pongWaiters.splice(0)) waiter();
          return;
        default:
          return;
      }
    });
  }

  send(frame: ShareRelayRelayFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Forwards a guest request the way the relay does and returns its answer as it arrives. */
  request(input: GuestRequestInput): { readonly id: number; readonly response: RelayedResponse } {
    const id = this.#nextRequestId++;
    const response = new RelayedResponse();
    this.#responses.set(id, response);
    const body = input.body ?? null;
    this.send({
      t: "req",
      id,
      method: input.method,
      route: input.route,
      query: input.query ?? "",
      headers: input.headers ?? {},
      hasBody: body !== null,
    });
    if (body !== null) {
      for (const chunk of body) {
        for (let offset = 0; offset < chunk.byteLength; offset += SHARE_RELAY_CHUNK_BYTES) {
          this.socket.send(
            encodeRelayBodyFrame(
              SHARE_RELAY_BINARY_KIND.requestBody,
              id,
              chunk.subarray(offset, offset + SHARE_RELAY_CHUNK_BYTES),
            ),
          );
        }
      }
      this.send({ t: "req-end", id });
    }
    return { id, response };
  }

  cancel(id: number): void {
    this.send({ t: "cancel", id });
  }

  ping(): Promise<void> {
    const pong = new Promise<void>((resolve) => this.#pongWaiters.push(resolve));
    this.send({ t: "ping" });
    return pong;
  }

  close(code: number, reason = ""): void {
    this.socket.close(code, reason);
  }
}

export class FakeShareRelay {
  readonly registrations = new Map<string, FakeRelayRegistration>();
  readonly registerCalls: Array<FakeRelayRegistration> = [];
  readonly deleteCalls: Array<{ readonly shareId: string; readonly hostKeyValid: boolean }> = [];
  /** When set, `POST /v1/shares` answers with this status instead of registering. */
  registerStatus: number | null = null;
  readonly hosts = new Map<string, FakeRelayHost>();
  readonly #hostWaiters = new Map<string, Array<(host: FakeRelayHost) => void>>();
  readonly #server: http.Server;
  readonly #wss: WebSocketServer;
  readonly origin: string;

  private constructor(server: http.Server, wss: WebSocketServer, origin: string) {
    this.#server = server;
    this.#wss = wss;
    this.origin = origin;
  }

  static async start(): Promise<FakeShareRelay> {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const relay = new FakeShareRelay(server, wss, `http://127.0.0.1:${port}`);
    server.on("request", (request, response) => void relay.#onRequest(request, response));
    server.on("upgrade", (request, socket, head) => {
      const match = /^\/v1\/shares\/([A-Za-z0-9_-]{22})\/host$/.exec(request.url ?? "");
      if (!match) {
        socket.destroy();
        return;
      }
      const shareId = match[1]!;
      wss.handleUpgrade(request, socket, head, (ws) => relay.#onHostSocket(shareId, ws));
    });
    return relay;
  }

  async close(): Promise<void> {
    for (const host of this.hosts.values()) host.socket.terminate();
    this.#wss.close();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** The next host connection for a share that passes `hello`. */
  waitForHost(shareId: string, timeoutMs = 5_000): Promise<FakeRelayHost> {
    const existing = this.hosts.get(shareId);
    if (existing && existing.socket.readyState === existing.socket.OPEN) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No host connected for ${shareId} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const waiters = this.#hostWaiters.get(shareId) ?? [];
      waiters.push((host) => {
        clearTimeout(timer);
        resolve(host);
      });
      this.#hostWaiters.set(shareId, waiters);
    });
  }

  /** Simulates a relay restart: the registration is gone and the host must register again. */
  forget(shareId: string): void {
    this.registrations.delete(shareId);
    this.hosts.get(shareId)?.close(SHARE_RELAY_CLOSE_CODES.unknownShare, "unknown share");
    this.hosts.delete(shareId);
  }

  /** Ends the share as a `DELETE` or expiry would. */
  end(shareId: string): void {
    this.registrations.delete(shareId);
    this.hosts.get(shareId)?.close(SHARE_RELAY_CLOSE_CODES.ended, "share ended");
    this.hosts.delete(shareId);
  }

  async #onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = request.url ?? "";
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url === "/v1/shares") {
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (!bearer) return json(401, { error: "unauthorized", message: "No bearer." });
      if (this.registerStatus !== null) {
        return json(this.registerStatus, { error: "rate_limited", message: "Too many shares." });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(400, { error: "invalid_request", message: "Bad JSON." });
      }
      const body = decodeRegisterRequest(parsed);
      if (body._tag === "None")
        return json(400, { error: "invalid_request", message: "Bad body." });
      if (body.value.protocolVersion !== SHARE_RELAY_PROTOCOL_VERSION) {
        return json(426, { error: "unsupported_protocol", message: "Update Moss." });
      }
      const existing = this.registrations.get(body.value.shareId);
      if (existing && existing.hostKeyHash !== body.value.hostKeyHash) {
        return json(409, { error: "conflict", message: "Hash differs." });
      }
      const registration: FakeRelayRegistration = { ...body.value, bearer };
      this.registrations.set(body.value.shareId, registration);
      this.registerCalls.push(registration);
      return json(201, {
        shareId: body.value.shareId,
        expiresAt: body.value.expiresAt,
        pageUrl: `${this.origin}/s/${body.value.shareId}`,
      });
    }
    const deleteMatch = /^\/v1\/shares\/([A-Za-z0-9_-]{22})$/.exec(url);
    if (request.method === "DELETE" && deleteMatch) {
      const shareId = deleteMatch[1]!;
      const hostKey = request.headers[SHARE_RELAY_HOST_KEY_HEADER];
      const registration = this.registrations.get(shareId);
      const hostKeyValid =
        typeof hostKey === "string" &&
        registration !== undefined &&
        createHash("sha256").update(hostKey).digest("base64url") === registration.hostKeyHash;
      this.deleteCalls.push({ shareId, hostKeyValid });
      if (!registration) return json(404, { error: "not_found", message: "Unknown share." });
      if (!hostKeyValid) return json(403, { error: "forbidden", message: "Bad host key." });
      this.end(shareId);
      response.writeHead(204);
      response.end();
      return;
    }
    json(404, { error: "not_found", message: "No such route." });
  }

  #onHostSocket(shareId: string, socket: WebSocket): void {
    const helloTimer = setTimeout(
      () => socket.close(SHARE_RELAY_CLOSE_CODES.badHello, "no hello"),
      5_000,
    );
    socket.once("message", (data) => {
      clearTimeout(helloTimer);
      let frame: ReturnType<typeof decodeHostFrame> = { _tag: "None" } as never;
      try {
        frame = decodeHostFrame(JSON.parse(String(data)));
      } catch {
        // Falls through to badHello.
      }
      if (frame._tag === "None" || frame.value.t !== "hello" || frame.value.shareId !== shareId) {
        socket.close(SHARE_RELAY_CLOSE_CODES.badHello, "bad hello");
        return;
      }
      if (frame.value.protocolVersion !== SHARE_RELAY_PROTOCOL_VERSION) {
        socket.close(SHARE_RELAY_CLOSE_CODES.unsupportedProtocol, "unsupported protocol");
        return;
      }
      const registration = this.registrations.get(shareId);
      if (!registration) {
        socket.close(SHARE_RELAY_CLOSE_CODES.unknownShare, "unknown share");
        return;
      }
      const hash = createHash("sha256").update(frame.value.hostKey).digest("base64url");
      if (hash !== registration.hostKeyHash) {
        socket.close(SHARE_RELAY_CLOSE_CODES.badHostKey, "bad host key");
        return;
      }
      const previous = this.hosts.get(shareId);
      if (previous && previous.socket !== socket) {
        previous.close(SHARE_RELAY_CLOSE_CODES.replaced, "replaced");
      }
      const host = new FakeRelayHost(socket, shareId);
      this.hosts.set(shareId, host);
      socket.on("close", () => {
        if (this.hosts.get(shareId) === host) this.hosts.delete(shareId);
      });
      host.send({ t: "hello-ok", expiresAt: registration.expiresAt });
      for (const waiter of this.#hostWaiters.get(shareId)?.splice(0) ?? []) waiter(host);
    });
  }
}
