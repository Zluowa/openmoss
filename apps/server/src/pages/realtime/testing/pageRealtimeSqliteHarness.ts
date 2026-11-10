import { randomUUID } from "node:crypto";
import { Effect, Layer, ManagedRuntime, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite";
import { PagesServiceLive } from "../../Layers/PagesService";
import {
  LOCAL_PAGES_PRINCIPAL as user,
  PagesService,
  type PagesServiceShape,
} from "../../Services/PagesService";
import { makePageRealtime, PageRealtimeService } from "../PageRealtimeService";

export async function makePageRealtimeSqliteHarness() {
  const controls: { read?: () => Promise<void>; write?: () => Promise<void> } = {};
  let base!: PagesServiceShape;
  const completedWrites: Array<{ content: string; page: { revision: number } }> = [];
  const layer = Layer.effectServices(
    Effect.gen(function* () {
      base = yield* PagesService;
      // Delay the real room's Page storage calls, not the reservation or a fake room.
      const { pages, service } = yield* makePageRealtime({
        ...base,
        read: (input, principal) =>
          Effect.promise(async () => {
            await controls.read?.();
          }).pipe(Effect.andThen(base.read(input, principal))),
        mutate: (input, principal) =>
          Effect.promise(async () => {
            await controls.write?.();
          }).pipe(
            Effect.andThen(base.mutate(input, principal)),
            Effect.tap((result) =>
              Effect.sync(() => {
                completedWrites.push(result);
              }),
            ),
          ),
      });
      return ServiceMap.make(PagesService, pages).pipe(
        ServiceMap.add(PageRealtimeService, service),
      );
    }),
  ).pipe(Layer.provide(PagesServiceLive), Layer.provideMerge(SqlitePersistenceMemory));
  const runtime = ManagedRuntime.make(layer);
  const pages = await runtime.runPromise(Effect.service(PagesService));
  const realtime = await runtime.runPromise(Effect.service(PageRealtimeService));
  const created = await runtime.runPromise(
    pages.mutate(
      {
        op: "create",
        requestId: randomUUID(),
        scopeSpaceId: null,
        title: "Reservation",
        richContent: JSON.stringify([{ type: "p", children: [{ text: "original" }] }]),
        spaceId: null,
        parentPageId: null,
      },
      user,
    ),
  );
  const run = <A, E>(task: Effect.Effect<A, E>, signal?: AbortSignal) =>
    runtime.runPromise(task, signal ? { signal } : undefined);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    controls,
    base,
    pages,
    realtime,
    sql,
    completedWrites,
    page: created.page,
    run,
    close: () => runtime.dispose(),
  };
}
