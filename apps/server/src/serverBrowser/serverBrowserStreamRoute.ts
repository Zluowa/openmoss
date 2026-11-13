/**
 * The server browser's viewer WebSocket: one per thread, carrying JPEG frames
 * out and the viewer's acks, control requests and input in.
 *
 * Admission follows the RPC upgrade (trusted origin, then the configured
 * authentication), for the socket and for a download alike.
 * `interactive=false` makes a watch-only viewer.
 *
 * @module serverBrowserStreamRoute
 */
import {
  SERVER_BROWSER_DOWNLOAD_PATH,
  SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM,
  SERVER_BROWSER_STREAM_PATH,
  SERVER_BROWSER_STREAM_PRESENCE_PARAM,
  SERVER_BROWSER_STREAM_THREAD_PARAM,
  SERVER_BROWSER_STREAM_UNAVAILABLE_CLOSE_CODE,
} from "@moss/shared/serverBrowserStream";
import { readFile } from "node:fs/promises";

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { frameSocketByteStream } from "../frameSocketByteStream.ts";

import { ServerBrowserService } from "./ServerBrowserService.ts";

const MAX_THREAD_ID_LENGTH = 256;

const intParam = (params: URLSearchParams, name: string, fallback: number, max: number) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};

export function makeServerBrowserStreamRouteLayer<R = never>(options: {
  /** The RPC socket's admission: trusted origin, then authentication. */
  readonly authorize: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        SERVER_BROWSER_STREAM_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const service = yield* Effect.serviceOption(ServerBrowserService);
          const params = HttpServerRequest.toURL(request)?.searchParams;
          const threadId = params?.get(SERVER_BROWSER_STREAM_THREAD_PARAM)?.trim();
          if (!params || !threadId || threadId.length > MAX_THREAD_ID_LENGTH) {
            return HttpServerResponse.text("Missing threadId", { status: 400 });
          }
          if (!(yield* options.authorize(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          if (service._tag === "None" || !service.value.enabled) {
            // A close code the client stops on; a refused upgrade would read as a
            // dropped connection and be retried forever.
            const refused = yield* request.upgrade;
            const refusedWriter = yield* refused.writer;
            yield* refusedWriter(
              new Socket.CloseEvent(SERVER_BROWSER_STREAM_UNAVAILABLE_CLOSE_CODE, "unavailable"),
            );
            return HttpServerResponse.empty();
          }
          // Read before the upgrade hands the socket to the WebSocket layer.
          const byteStream = frameSocketByteStream(request);
          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          const write = (data: Uint8Array | string | Socket.CloseEvent) => {
            if (!open) return;
            void Effect.runPromise(writer(data)).catch(() => undefined);
          };
          const handle = service.value.hub.attach(
            threadId,
            {
              sendBinary: (data) => write(data),
              sendText: (text) => write(text),
              backlogBytes: () => byteStream?.pendingBytes() ?? 0,
              close: (code, reason) => {
                write(new Socket.CloseEvent(code, reason));
                open = false;
              },
            },
            {
              maxWidth: intParam(params, "maxWidth", 1280, 3840),
              maxHeight: intParam(params, "maxHeight", 800, 2160),
              quality: intParam(params, "quality", 70, 100),
              canOperate: params.get("interactive") !== "false",
              presence: params.get(SERVER_BROWSER_STREAM_PRESENCE_PARAM) === "true",
            },
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              open = false;
              await handle.detach();
            }),
          );
          yield* socket.run((message) => {
            handle.receive(message);
          });
          return HttpServerResponse.empty();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("server browser viewer socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
      // A download a person started. The request carries the same credential as
      // the viewer socket (the session cookie, or the desktop's loopback token in
      // the query); the download token, sent only over that socket, picks the
      // file, works once and expires after two minutes.
      yield* router.add(
        "GET",
        SERVER_BROWSER_DOWNLOAD_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!(yield* options.authorize(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          const service = yield* Effect.serviceOption(ServerBrowserService);
          const token =
            HttpServerRequest.toURL(request)?.searchParams.get(
              SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM,
            ) ?? "";
          const download =
            service._tag === "Some" && token.length > 0
              ? service.value.runtime.takeDownload(token)
              : undefined;
          if (!download) return HttpServerResponse.text("Not Found", { status: 404 });
          const bytes = yield* Effect.promise(() => readFile(download.path));
          return HttpServerResponse.uint8Array(bytes, {
            contentType: "application/octet-stream",
            headers: {
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
          ),
        ),
      );
    }),
  );
}

export { SERVER_BROWSER_STREAM_UNAVAILABLE_CLOSE_CODE };
