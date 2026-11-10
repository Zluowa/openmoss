// FILE: pageRealtimeRoute.ts
// Purpose: Mounts `GET /ws/pages-realtime?pageId=…&ticket=…`, the WebSocket of one Page room.
// Layer: Pages realtime (collab)
// Why: Its own socket keeps typing traffic off the RPC socket's queue. Admission is the RPC
//      upgrade's (trusted origin plus whatever authentication the server requires, so a paired
//      device on the LAN or tailnet works like a local window) and then a single-use ticket from
//      `pages.realtimeToken` that names this Page and its mode. The subprotocol must name the
//      Page too, which keeps a page from being opened by a cross-site socket guessing the URL.

import { PAGES_REALTIME_SUBPROTOCOL_PREFIX, PAGES_REALTIME_WS_PATH } from "@moss/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import type { RoomConnection } from "./PageRealtimeRoom";
import { PageRealtimeService } from "./PageRealtimeService";

/** Larger than any Page (2 MB of rich content) after Yjs encoding overhead. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const PAGE_ID = /^[A-Za-z0-9._~-]{1,200}$/u;

export function makePageRealtimeRouteLayer<R = never>(options: {
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        PAGES_REALTIME_WS_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const realtime = yield* Effect.serviceOption(PageRealtimeService);
          if (realtime._tag === "None") {
            return HttpServerResponse.text("Page rooms are unavailable", { status: 404 });
          }
          const url = HttpServerRequest.toURL(request);
          const pageId = url?.searchParams.get("pageId") ?? "";
          const token = url?.searchParams.get("ticket") ?? "";
          const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
            .split(",")
            .map((value) => value.trim());
          if (
            !PAGE_ID.test(pageId) ||
            !token ||
            !protocols.includes(`${PAGES_REALTIME_SUBPROTOCOL_PREFIX}${pageId}`)
          ) {
            return HttpServerResponse.text("Bad page room request", { status: 400 });
          }
          if (!(yield* options.authorizeUpgrade(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          // Redeemed before the upgrade: a forged, expired or replayed ticket gets a plain refusal
          // and the client fetches a fresh one, instead of a socket that is opened only to close.
          const ticket = realtime.value.admit(pageId, token);
          if (!ticket) return HttpServerResponse.text("Invalid page room ticket", { status: 401 });

          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          let queue: Promise<void> = Promise.resolve();
          const write = (chunk: Uint8Array | string | Socket.CloseEvent) => {
            if (!open) return;
            if (Socket.isCloseEvent(chunk)) open = false;
            queue = queue.then(() => Effect.runPromise(writer(chunk)).catch(() => undefined));
          };
          const joined = yield* Effect.promise(() =>
            realtime.value.join({
              pageId,
              ticket,
              connection: (mode): RoomConnection => ({
                mode,
                send: (message) => write(message),
                close: (code, reason) => write(new Socket.CloseEvent(code, reason)),
              }),
            }),
          );
          if (!joined) {
            // The room went away between the ticket check and the upgrade.
            write(new Socket.CloseEvent(1013, "room unavailable"));
            yield* Effect.promise(() => queue);
            return HttpServerResponse.empty();
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open = false;
              realtime.value.leave(pageId, joined.connection);
            }),
          );
          yield* socket.runRaw((message) => {
            const size = typeof message === "string" ? message.length : message.byteLength;
            if (size > MAX_FRAME_BYTES || !joined.room.receive(joined.connection, message)) {
              write(new Socket.CloseEvent(1003, "unsupported frame"));
            }
          });
          return HttpServerResponse.empty();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("page room socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
    }),
  );
}
