// FILE: richAgentPresence.test.ts
// Purpose: Verifies rich PageRealtimeService awareness payloads (`state`, `label`, `blockIds`, `threadId`)
//          for live Moss presence indicators and backward compatibility with legacy `{ id, name }`.

import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId } from "@moss/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as decoding from "lib0/decoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { MESSAGE_AWARENESS, type RoomConnection } from "./PageRealtimeRoom";
import { PageRealtimeService, PagesRealtimeLive } from "./PageRealtimeService";

const tests = it.layer(PagesRealtimeLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const timestamp = "2026-11-22T00:00:00.000Z";

function readAwarenessAgents(frames: Array<Uint8Array | string>) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  for (const frame of frames) {
    if (typeof frame === "string") continue;
    const decoder = decoding.createDecoder(frame);
    const kind = decoding.readVarUint(decoder);
    if (kind === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        "test",
      );
    }
  }
  const states = [...awareness.getStates().values()]
    .map((state) => (state as { moss?: { kind?: string; agents?: unknown[] } })?.moss)
    .filter((moss) => moss?.kind === "agents");
  return states.at(-1)?.agents ?? [];
}

const pause = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

tests("Rich agent awareness telemetry", (it) => {
  it.effect(
    "broadcasts thinking, editing, done, blockIds, label, threadId and clears cleanly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pages = yield* PagesService;
        const realtime = yield* PageRealtimeService;
        const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
        yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Rich presence', 'folder', 0, ${timestamp}, ${timestamp})`;
        const created = yield* pages.mutate(
          {
            op: "create",
            requestId: randomUUID(),
            scopeSpaceId,
            title: "Doc",
            richContent: JSON.stringify([{ type: "p", id: "b1", children: [{ text: "hello" }] }]),
            spaceId: null,
            parentPageId: null,
          },
          user,
        );
        const token = yield* realtime.issueToken({ pageId: created.page.id, scopeSpaceId }, user);
        const frames: Array<Uint8Array | string> = [];
        const conn: RoomConnection = {
          mode: "edit",
          send: (msg) => frames.push(msg),
          close: () => {},
        };
        const joined = yield* Effect.promise(() =>
          realtime.join({
            pageId: created.page.id,
            token: token.token,
            connection: () => conn,
          }),
        );
        assert.isNotNull(joined);

        const threadId = ThreadId.makeUnsafe(randomUUID());
        realtime.showAgent(created.page.id, threadId, {
          name: "Moss",
          state: "thinking",
          label: "Moss · 正在思考...",
          blockIds: ["b1", "b1", "b2"],
          threadId,
        });
        yield* pause(20);
        assert.deepStrictEqual(readAwarenessAgents(frames), [
          {
            id: threadId,
            name: "Moss",
            state: "thinking",
            label: "Moss · 正在思考...",
            blockIds: ["b1", "b2"],
            threadId,
          },
        ]);

        realtime.showAgent(created.page.id, threadId, {
          name: "Moss",
          state: "editing",
          label: "Moss 正在修改...",
          blockIds: ["b2"],
          threadId,
        });
        yield* pause(20);
        assert.deepStrictEqual(readAwarenessAgents(frames), [
          {
            id: threadId,
            name: "Moss",
            state: "editing",
            label: "Moss 正在修改...",
            blockIds: ["b2"],
            threadId,
          },
        ]);

        realtime.clearAgent(created.page.id, threadId);
        yield* pause(20);
        assert.deepStrictEqual(readAwarenessAgents(frames), []);

        // Verify "done" expires automatically after ttlMs
        realtime.showAgent(created.page.id, threadId, {
          name: "Moss",
          state: "done",
          label: "Moss 已修改",
          blockIds: ["b2"],
          ttlMs: 60,
        });
        yield* pause(15);
        assert.deepStrictEqual(readAwarenessAgents(frames), [
          {
            id: threadId,
            name: "Moss",
            state: "done",
            label: "Moss 已修改",
            blockIds: ["b2"],
            threadId,
          },
        ]);
        yield* pause(100);
        assert.deepStrictEqual(readAwarenessAgents(frames), []);
        realtime.leave(created.page.id, joined!.connection);
      }),
  );
});
