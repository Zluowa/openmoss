// FILE: boardRoomRoute.ts
// Purpose: Mounts `GET /ws/board-room?pageId=…&scope=…&sessionId=…`, the WebSocket endpoint
//          of a live 白板 (`kind: "board"`) room. Validates upgrade authentication and board scope
//          against `PageTypesService` before joining a shared `BoardRooms` instance.
// Layer: Server pages. Zero `@tldraw/*` or synchronous FS dependencies.

import type { PageId, SpaceId } from "@moss/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { LOCAL_PAGES_PRINCIPAL } from "../Services/PagesService";
import { PageTypesService, type PageTypesServiceShape } from "../types/PageTypesService";
import { BoardRooms } from "./boardRooms";

export const BOARD_ROOM_WS_PATH = "/ws/board-room";
const SAFE_PARAM = /^[A-Za-z0-9._~-]{1,200}$/u;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const roomsByService = new WeakMap<PageTypesServiceShape, BoardRooms>();

export function getBoardRoomsForService(service: PageTypesServiceShape): BoardRooms {
  const existing = roomsByService.get(service);
  if (existing) return existing;
  const readBoard = (id: string, space: string | null) =>
    service.read(
      { scopeSpaceId: space as SpaceId | null, pageId: id as PageId } as never,
      LOCAL_PAGES_PRINCIPAL,
    );
  const created = new BoardRooms({
    read: (id, space) =>
      Effect.runPromise(readBoard(id, space)).then((current) => ({
        data: current.data ?? "",
        revision: current.page.revision,
      })),
    save: (id, space, data, expectedRevision) =>
      Effect.runPromise(
        service.save(
          {
            requestId: `board-room:${crypto.randomUUID()}`,
            scopeSpaceId: space as SpaceId | null,
            pageId: id as PageId,
            expectedRevision,
            data,
          } as never,
          LOCAL_PAGES_PRINCIPAL,
        ),
      ).then((saved) => saved.page.revision),
  });
  roomsByService.set(service, created);
  return created;
}

export function makeBoardRoomRouteLayer<R = never>(options: {
  readonly authorizeUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean, never, R>;
}) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      let activeService: PageTypesServiceShape | null = null;
      let activeRooms: BoardRooms | null = null;
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (activeService) roomsByService.delete(activeService);
          await activeRooms?.dispose();
        }).pipe(Effect.ignore),
      );

      yield* router.add(
        "GET",
        BOARD_ROOM_WS_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const typesOpt = yield* Effect.serviceOption(PageTypesService);
          if (Option.isNone(typesOpt)) {
            return HttpServerResponse.text("Board rooms are unavailable", { status: 404 });
          }
          activeService = typesOpt.value;
          const rooms = getBoardRoomsForService(typesOpt.value);
          activeRooms = rooms;
          const url = HttpServerRequest.toURL(request);
          const pageId = url?.searchParams.get("pageId") ?? "";
          const scope = url?.searchParams.get("scope") || null;
          const sessionId = url?.searchParams.get("sessionId") ?? "";
          const peerName = url?.searchParams.get("name")?.trim() || undefined;
          const peerColor = url?.searchParams.get("color")?.trim() || undefined;
          if (
            !SAFE_PARAM.test(pageId) ||
            (scope !== null && !SAFE_PARAM.test(scope)) ||
            !SAFE_PARAM.test(sessionId)
          ) {
            return HttpServerResponse.text("Bad board room request", { status: 400 });
          }
          if (!(yield* options.authorizeUpgrade(request))) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }

          const item = yield* typesOpt.value
            .read(
              { scopeSpaceId: scope as SpaceId | null, pageId: pageId as PageId } as never,
              LOCAL_PAGES_PRINCIPAL,
            )
            .pipe(Effect.option);
          if (
            item._tag === "None" ||
            item.value.kind !== "board" ||
            item.value.data === null ||
            item.value.page.scopeSpaceId !== scope
          ) {
            return HttpServerResponse.text("Not a board", { status: 404 });
          }

          const readOnly = item.value.page.trashedAt !== null;
          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          let open = true;
          let queue: Promise<void> = Promise.resolve();
          const write = (chunk: string | Socket.CloseEvent) => {
            if (!open) return;
            if (Socket.isCloseEvent(chunk)) open = false;
            queue = queue.then(() => Effect.runPromise(writer(chunk)).catch(() => undefined));
          };

          const leave = yield* Effect.promise(() =>
            rooms.join(pageId, scope, {
              sessionId,
              readOnly,
              ...(peerName ? { name: peerName } : {}),
              ...(peerColor ? { color: peerColor } : {}),
              send: (data) => write(data),
              close: () => write(new Socket.CloseEvent(1000, "closed")),
            }),
          );

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open = false;
              leave();
            }),
          );

          const decoder = new TextDecoder();
          yield* socket.runRaw((message) => {
            const size = typeof message === "string" ? message.length : message.byteLength;
            if (size > MAX_FRAME_BYTES) {
              write(new Socket.CloseEvent(1009, "frame too large"));
              return;
            }
            const text = typeof message === "string" ? message : decoder.decode(message);
            rooms.handleMessage(pageId, sessionId, text);
          });
          return HttpServerResponse.empty();
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("board room socket closed", { cause: String(cause) }),
              HttpServerResponse.empty(),
            ),
          ),
        ),
      );
    }),
  );
}
