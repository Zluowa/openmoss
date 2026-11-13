// FILE: designRoomRoute.ts
// Purpose: Mounts `GET /ws/design-room?pageId=…&scope=…&peer=…`, the WebSocket of one live 设计
//          room.
// Layer: Server pages. Admission is the same as the Page rooms' upgrade (trusted origin plus the
//        server's authentication, so a paired device works like a local window); the item must
//        exist and be a design. Persistence goes through the typed-item service as the local user.

import type { PageId, SpaceId } from "@moss/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { PageTypesService } from "../types/PageTypesService";
import { installDesignRooms } from "./designRooms";

export const DESIGN_ROOM_WS_PATH = "/ws/design-room";
const PAGE_ID = /^[A-Za-z0-9._~-]{1,200}$/u;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const LOCAL = { kind: "local-user" } as const;

export function makeDesignRoomRouteLayer<R = never>(options: {
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        DESIGN_ROOM_WS_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const types = yield* Effect.serviceOption(PageTypesService);
          if (types._tag === "None")
            return HttpServerResponse.text("Design rooms are unavailable", { status: 404 });
          const url = HttpServerRequest.toURL(request);
          const pageId = url?.searchParams.get("pageId") ?? "";
          const scope = url?.searchParams.get("scope") || null;
          const peerId = url?.searchParams.get("peer") ?? "";
          if (
            !PAGE_ID.test(pageId) ||
            (scope !== null && !PAGE_ID.test(scope)) ||
            !PAGE_ID.test(peerId)
          )
            return HttpServerResponse.text("Bad design room request", { status: 400 });
          if (!(yield* options.authorizeUpgrade(request)))
            return HttpServerResponse.text("Forbidden", { status: 403 });
          const service = types.value;
          const read = (id: string, space: string | null) =>
            service.read(
              { scopeSpaceId: space as SpaceId | null, pageId: id as PageId } as never,
              LOCAL,
            );
          const item = yield* read(pageId, scope).pipe(Effect.option);
          if (item._tag === "None" || item.value.kind !== "design" || item.value.data === null)
            return HttpServerResponse.text("Not a design", { status: 404 });
          const readOnly = item.value.page.trashedAt !== null;
          const rooms = installDesignRooms({
            read: (id, space) =>
              Effect.runPromise(read(id, space)).then((current) => ({
                data: current.data ?? "",
                revision: current.page.revision,
              })),
            save: (id, space, data, expectedRevision) =>
              Effect.runPromise(
                service.save(
                  {
                    requestId: `design-room:${crypto.randomUUID()}`,
                    scopeSpaceId: space as SpaceId | null,
                    pageId: id as PageId,
                    expectedRevision,
                    data,
                  } as never,
                  LOCAL,
                ),
              ).then((saved) => saved.page.revision),
          });

          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          let queue: Promise<void> = Promise.resolve();
          const write = (chunk: string | Socket.CloseEvent) => {
            if (!open) return;
            if (Socket.isCloseEvent(chunk)) open = false;
            queue = queue.then(() => Effect.runPromise(writer(chunk)).catch(() => undefined));
          };
          const joined = yield* Effect.promise(() =>
            rooms.join(
              pageId,
              scope,
              peerId,
              {
                get readyState() {
                  return open ? 1 : 3;
                },
                send: (data) => write(data),
                close: (code, reason) => write(new Socket.CloseEvent(code ?? 1000, reason)),
              },
              readOnly,
            ),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open = false;
              joined.leave();
            }),
          );
          const decoder = new TextDecoder();
          yield* socket.runRaw((message) => {
            const size = typeof message === "string" ? message.length : message.byteLength;
            if (size > MAX_FRAME_BYTES) {
              write(new Socket.CloseEvent(1009, "frame too large"));
              return;
            }
            joined.receive(typeof message === "string" ? message : decoder.decode(message));
          });
          return HttpServerResponse.empty();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("design room socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
    }),
  );
}
