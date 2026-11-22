// FILE: boardRoomRoute.test.ts
// Purpose: Route-level admission tests for GET /ws/board-room (parameter validation, auth, and kind guard).

import { randomUUID } from "node:crypto";

import { SpaceId } from "@moss/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { PagesServiceLive } from "../Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL } from "../Services/PagesService";
import { PageTypesService, PageTypesServiceLive } from "../types/PageTypesService";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { BOARD_ROOM_WS_PATH, makeBoardRoomRouteLayer } from "./boardRoomRoute";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

describe("GET /ws/board-room", () => {
  it("enforces query validation, upgrade authorization, and board kind check", async () => {
    const pageLayer = PageTypesServiceLive.pipe(
      Layer.provideMerge(PagesServiceLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(pageLayer);
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const types = await runtime.runPromise(Effect.service(PageTypesService));
    let allowUpgrade = false;
    const routeLayer = makeBoardRoomRouteLayer({
      authorizeUpgrade: () => Effect.sync(() => allowUpgrade),
    }).pipe(HttpRouter.provideRequest(Layer.succeed(PageTypesService, types)));
    const web = HttpRouter.toWebHandler(routeLayer, { disableLogger: true });
    cleanups.push(async () => {
      await web.dispose();
      await runtime.dispose();
    });

    const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
    const now = "2026-11-22T00:00:00.000Z";
    await runtime.runPromise(
      sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Board ws', 'folder', 0, ${now}, ${now})`,
    );
    const sheet = await runtime.runPromise(
      types.create(
        {
          requestId: randomUUID(),
          scopeSpaceId,
          kind: "sheet",
          title: "Not a board",
          spaceId: null,
          parentPageId: null,
        },
        LOCAL_PAGES_PRINCIPAL,
      ),
    );

    const badParams = await web.handler(new Request(`http://127.0.0.1:3000${BOARD_ROOM_WS_PATH}`));
    expect(badParams.status).toBe(400);

    const forbidden = await web.handler(
      new Request(
        `http://127.0.0.1:3000${BOARD_ROOM_WS_PATH}?pageId=${sheet.page.id}&scope=${scopeSpaceId}&sessionId=s1`,
      ),
    );
    expect(forbidden.status).toBe(403);

    allowUpgrade = true;
    const nonBoard = await web.handler(
      new Request(
        `http://127.0.0.1:3000${BOARD_ROOM_WS_PATH}?pageId=${sheet.page.id}&scope=${scopeSpaceId}&sessionId=s1`,
      ),
    );
    expect(nonBoard.status).toBe(404);
  });
});
