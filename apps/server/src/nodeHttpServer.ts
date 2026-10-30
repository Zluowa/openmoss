import http from "node:http";
import type { ListenOptions, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { WS_FEATURE_PATH } from "@synara/contracts";
import * as NodeHttpIncomingMessage from "@effect/platform-node/NodeHttpIncomingMessage";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Fiber from "effect/Fiber";
import { Effect, Scope } from "effect";
import * as ServiceMap from "effect/ServiceMap";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as HttpServer from "effect/unstable/http/HttpServer";
import {
  ClientAbort,
  RequestParseError,
  ServeError,
  HttpServerError,
} from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import * as SocketEffect from "effect/unstable/socket/Socket";
import { WebSocketServer, type WebSocket } from "ws";

type UpgradeWebSocket = {
  send: WebSocket["send"];
};

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Keep outbound frames on one write lane.
 *
 * Effect RPC deliberately forks every handler and may therefore call the
 * socket writer from several fibers at the same time. `ws` normally handles
 * concurrent calls. Waiting for its write callback also bounds concurrency at
 * the transport boundary rather than relying on adapter-specific scheduling,
 * so simultaneous subscription snapshots cannot share an in-flight write.
 */
export function serializeWebSocketSends<T extends UpgradeWebSocket>(socket: T): T {
  const originalSend = socket.send.bind(socket);
  let tail = Promise.resolve();
  socket.send = ((
    data: Parameters<WebSocket["send"]>[0],
    options?: Parameters<WebSocket["send"]>[1] | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ) => {
    const userCallback = typeof options === "function" ? options : callback;
    const sendOptions = typeof options === "function" ? undefined : options;
    tail = tail.then(
      () =>
        new Promise<void>((resolve) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            try {
              if (typeof userCallback === "function") userCallback(error);
            } finally {
              resolve();
            }
          };
          try {
            originalSend(data, sendOptions ?? {}, finish);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      () => undefined,
    );
  }) as T["send"];
  return socket;
}

/**
 * Node's HTTP parser owns the socket error listener until an upgrade starts.
 * The Effect upgrade handler then runs the route (including authentication)
 * before `ws.handleUpgrade()` installs its own listener. A peer reset during
 * that gap otherwise becomes an unhandled `error` event and terminates the
 * whole backend process.
 *
 * Keep this boundary for the complete lifetime of every accepted connection.
 * Other protocol-specific listeners still receive the event and perform their
 * own cleanup; destroying an already-failed socket here only guarantees that
 * HTTP requests, rejected upgrades, and pending upgrades all release promptly.
 */
function handleClientSocketError(this: Socket): void {
  this.destroy();
}

function protectClientSocket(socket: Socket): void {
  socket.on("error", handleClientSocketError);
}

/**
 * permessage-deflate configuration for the feature WS socket only.
 *
 * The RPC stream is small, highly repetitive JSON (repeated schema keys,
 * UUIDs, event envelopes), which is the best case for DEFLATE with context
 * takeover: the compression window is shared across frames, so each frame is
 * coded against the vocabulary of everything sent before it. Context takeover
 * stays enabled (the negotiated default). A client offering
 * `client_no_context_takeover` still compresses normally; one offering
 * `server_no_context_takeover` loses the shared vocabulary and can end up
 * with frames slightly larger than uncompressed, since framing overhead
 * exceeds the gain on a single small frame.
 *
 * No `threshold` is set: `ws` only honors it when context takeover is
 * disabled, and skipping tiny frames would also skip priming the shared
 * window they benefit from.
 *
 * `maxPayload` admission control is unaffected: `ws` enforces it on the
 * decompressed size — accumulated across continuation frames — so a
 * compressed or fragmented message cannot smuggle past the bound.
 *
 * The pre-auth bootstrap socket deliberately never negotiates compression:
 * each actively compressed connection retains zlib window state (~288 KiB at
 * defaults) plus potentially near-`maxPayload` inflated buffers for
 * incomplete fragmented messages, and the bootstrap path is reachable
 * without credentials. Compression is a post-authentication privilege so
 * unauthenticated connections cannot multiply per-connection memory.
 *
 * Measured on a simulated streaming turn of small repetitive JSON frames:
 * ~80% wire reduction, with CPU dominated by per-invocation zlib overhead
 * rather than compression level (levels 1/3/6 within 2% on both axes), so
 * zlib options stay at their defaults. Numbers in the PR that added this.
 *
 * `ws` already defaults `concurrencyLimit` to 10 and creates its limiter
 * once per process on the first PerMessageDeflate instance, so passing it
 * here would pin the default rather than bound anything new.
 */
const PER_MESSAGE_DEFLATE_OPTIONS = true;

/**
 * The one upgrade route allowed to negotiate compression (post-auth). Shared
 * with the route registration so the dispatcher and the router cannot drift.
 */
const COMPRESSED_UPGRADE_PATH = WS_FEATURE_PATH;

/**
 * The upstream Effect Node adapter writes the `HttpServerResponse.empty()`
 * returned by `RpcServer.toHttpEffectWebsocket` after the WebSocket upgrade
 * has already completed. Node then puts a second HTTP response on the same
 * TCP stream, which the client correctly reports as `Invalid frame header`.
 * This local adapter preserves the upstream request plumbing but suppresses
 * the post-upgrade HTTP response. Rejected upgrades still receive a small
 * HTTP response before the socket is closed.
 */
class MossUpgradeRequest extends NodeHttpIncomingMessage.NodeHttpIncomingMessage<HttpServerError> {
  readonly [HttpServerRequest.TypeId]: typeof HttpServerRequest.TypeId;
  readonly response: http.ServerResponse | (() => http.ServerResponse);
  url: string;
  private readonly upgradeEffect: Effect.Effect<any, HttpServerError>;
  private readonly upgradeState: { upgraded: boolean };
  private headersOverride?: Record<string, string | string[] | undefined>;

  constructor(
    source: http.IncomingMessage,
    response: http.ServerResponse | (() => http.ServerResponse),
    upgradeEffect: Effect.Effect<any, HttpServerError>,
    upgradeState: { upgraded: boolean },
    remoteAddressOverride?: string,
  ) {
    super(
      source,
      (cause) =>
        new HttpServerError({ reason: new RequestParseError({ request: this as any, cause }) }),
      remoteAddressOverride,
    );
    this[HttpServerRequest.TypeId] = HttpServerRequest.TypeId;
    this.response = response;
    this.upgradeEffect = upgradeEffect;
    this.upgradeState = upgradeState;
    this.url = source.url ?? "/";
  }

  get cookies() {
    return Cookies.parseHeader(this.headers.cookie ?? "");
  }

  get resolvedResponse() {
    return typeof this.response === "function" ? this.response() : this.response;
  }

  get originalUrl() {
    return this.source.url ?? "/";
  }

  get method() {
    return (this.source.method ?? "GET").toUpperCase() as any;
  }

  override get headers() {
    this.headersOverride ??= this.source.headers as any;
    return this.headersOverride as any;
  }

  modify(options: { url?: string; headers?: any; remoteAddress?: string }) {
    const copy = new MossUpgradeRequest(
      this.source,
      this.response,
      this.upgradeEffect,
      this.upgradeState,
      options.remoteAddress ?? this.remoteAddressOverride,
    );
    copy.url = options.url ?? this.url;
    copy.headersOverride = options.headers ?? this.headersOverride;
    return copy as any;
  }

  get upgrade() {
    return this.upgradeEffect;
  }

  get upgraded() {
    return this.upgradeState.upgraded;
  }

  set upgraded(value: boolean) {
    this.upgradeState.upgraded = value;
  }

  override toString() {
    return `ServerRequest(${this.method} ${this.url})`;
  }

  toJSON() {
    return HttpIncomingMessage.inspect(this as any, {
      _id: "HttpServerRequest",
      method: this.method,
      url: this.originalUrl,
    });
  }
}

function writeUpgradeResponse(request: MossUpgradeRequest, response: any): Effect.Effect<void> {
  return Effect.sync(() => {
    const nodeResponse = request.resolvedResponse;
    if (request.upgraded || nodeResponse.writableEnded) return;
    nodeResponse.writeHead(response.status, response.headers as any);
    const body = response.body;
    if (body?._tag === "Uint8Array" || body?._tag === "Raw") {
      nodeResponse.end(body.body);
    } else {
      nodeResponse.end();
    }
  });
}

function makeMossUpgradeHandler(
  lazyWss: Effect.Effect<any>,
  httpEffect: Effect.Effect<
    HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
  options: { scope: Scope.Scope; middleware?: any },
): Effect.Effect<(request: http.IncomingMessage, socket: Duplex, head: Buffer) => void> {
  const handledApp = HttpEffect.toHandled(
    httpEffect,
    (request, response) =>
      request instanceof MossUpgradeRequest
        ? writeUpgradeResponse(request, response)
        : Effect.die(new Error("Unexpected HTTP request in WebSocket upgrade handler")),
    options.middleware,
  );
  return Effect.withFiber((parent) => {
    const services = parent.services;
    return Effect.succeed((nodeRequest: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      let nodeResponse_: http.ServerResponse | undefined;
      const nodeResponse = () => {
        nodeResponse_ ??= new http.ServerResponse(nodeRequest);
        nodeResponse_.assignSocket(socket as any);
        nodeResponse_.on("finish", () => socket.end());
        return nodeResponse_;
      };
      const upgradeState = { upgraded: false };
      const requestRef = { current: undefined as MossUpgradeRequest | undefined };
      const upgradeEffect = SocketEffect.fromWebSocket(
        Effect.flatMap(lazyWss, (wss: any) =>
          Effect.acquireRelease(
            Effect.callback<any>((resume) =>
              wss.handleUpgrade(nodeRequest, socket, head, (ws: any) => {
                if (requestRef.current) requestRef.current.upgraded = true;
                resume(Effect.succeed(ws));
              }),
            ),
            (ws: any) => Effect.sync(() => ws.close()),
          ),
        ),
      );
      const request = new MossUpgradeRequest(
        nodeRequest,
        nodeResponse,
        upgradeEffect,
        upgradeState,
      );
      requestRef.current = request;
      const map = new Map(services.mapUnsafe);
      map.set(HttpServerRequest.HttpServerRequest.key, request);
      const fiber = Fiber.runIn(
        Effect.runForkWith(ServiceMap.makeUnsafe<any>(map))(handledApp),
        options.scope,
      );
      socket.on("close", () => {
        if (!socket.writableEnded) fiber.interruptUnsafe(parent.id, ClientAbort.annotation);
      });
    });
  });
}

/**
 * Normalizes a raw request target the way the Effect router does before route
 * matching: absolute-form targets, query and fragment, `;params`, duplicate
 * slashes, percent-encoding, case, and trailing slashes all collapse. The
 * router matches case-insensitively on the decoded path, so comparing the raw
 * target here would let `/WS/BOOTSTRAP` or `/ws/%62ootstrap` reach the
 * bootstrap route while classifying as something else.
 */
function normalizeUpgradePath(requestUrl: string | undefined): string {
  const target = requestUrl ?? "";
  // Absolute-form request targets (RFC 9112 §3.2.2) are legal on upgrades.
  const afterAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
    ? target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/"
    : target;
  const pathOnly = afterAuthority.split("#")[0]?.split("?")[0] ?? "";
  let decoded = pathOnly;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    // Malformed percent-encoding cannot be a recognized route; leave as-is so
    // it falls through to the uncompressed default.
  }
  const withoutParams = decoded
    .split("/")
    .map((segment) => segment.split(";")[0] ?? "")
    .join("/");
  const collapsed = withoutParams.replace(/\/{2,}/g, "/").toLowerCase();
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/**
 * Fail closed: only the exact feature route negotiates compression. Anything
 * else — the pre-auth bootstrap route, unrecognized paths, malformed targets —
 * lands on the uncompressed server, so no unauthenticated connection can hold
 * zlib state regardless of how its path is spelled.
 */
export function upgradePathAllowsCompression(requestUrl: string | undefined): boolean {
  return normalizeUpgradePath(requestUrl) === COMPRESSED_UPGRADE_PATH;
}

/**
 * Owns the Node HTTP/WebSocket transport so Moss, rather than the platform
 * adapter's 100 MiB default, controls admission before a message is decoded.
 */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  // Install before `listen()`: no accepted connection may exist without a
  // permanent error boundary, including connections reset during startup.
  server.on("connection", protectClientSocket);

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      server.off("connection", protectClientSocket);
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((error) => {
        if (error) resume(Effect.die(error));
        else resume(Effect.void);
      });
    }),
  );

  yield* Effect.callback<void, ServeError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServeError({ cause })));
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address()!;
  const makeBoundedWebSocketServer = (perMessageDeflate: boolean) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const websocketServer = new WebSocketServer({
          noServer: true,
          maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
          perMessageDeflate: perMessageDeflate ? PER_MESSAGE_DEFLATE_OPTIONS : false,
        });
        const handleUpgrade = websocketServer.handleUpgrade.bind(websocketServer);
        // The Effect adapter consumes handleUpgrade's callback directly; it
        // does not emit a WebSocketServer "connection" event.
        websocketServer.handleUpgrade = ((request, socket, head, callback) =>
          handleUpgrade(request, socket, head, (client) =>
            callback(serializeWebSocketSends(client), request),
          )) as typeof websocketServer.handleUpgrade;
        return websocketServer;
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resume(Effect.void));
        }),
    ).pipe(Scope.provide(scope));
  // Keep the feature socket uncompressed. Chromium's native WebSocket client
  // and Effect's Socket adapter can disagree on permessage-deflate context
  // takeover after a stream reconnect, producing an Invalid frame header and
  // stranding the entire desktop shell. Moss runs this socket over loopback,
  // so the bounded uncompressed frames are preferable to a corrupt stream.
  const featureWebSocketServer = yield* makeBoundedWebSocketServer(false);
  const bootstrapWebSocketServer = yield* makeBoundedWebSocketServer(false);

  return HttpServer.make({
    address:
      typeof address === "string"
        ? { _tag: "UnixAddress", path: address }
        : {
            _tag: "TcpAddress",
            hostname: address.address === "::" ? "0.0.0.0" : address.address,
            port: address.port,
          },
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware: middleware as any,
        scope: serveScope,
      }) as Effect.Effect<
        (nodeRequest: http.IncomingMessage, nodeResponse: http.ServerResponse) => void
      >;
      const featureUpgradeHandler = yield* makeMossUpgradeHandler(
        Effect.succeed(featureWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const bootstrapUpgradeHandler = yield* makeMossUpgradeHandler(
        Effect.succeed(bootstrapWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const upgradeHandler = (
        nodeRequest: http.IncomingMessage,
        socket: Parameters<typeof featureUpgradeHandler>[1],
        head: Parameters<typeof featureUpgradeHandler>[2],
      ) => {
        const dispatch = upgradePathAllowsCompression(nodeRequest.url)
          ? featureUpgradeHandler
          : bootstrapUpgradeHandler;
        dispatch(nodeRequest, socket, head);
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.off("request", handler);
          server.off("upgrade", upgradeHandler);
        }),
      );
      server.on("request", handler);
      server.on("upgrade", upgradeHandler);
    }),
  });
});
