// FILE: PageRealtimeService.lifecycle.test.ts
// Purpose: Room idle cleanup must end with the server scope, without waiting for its timeout.
// Layer: Pages realtime tests

import { randomUUID } from "node:crypto";

import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { PageRealtimeService, PagesRealtimeLive } from "./PageRealtimeService";

describe("Page room lifecycle", () => {
  it.each(["unused ticket", "last viewer left"])(
    "clears idle cleanup immediately on server shutdown: %s",
    async (scenario) => {
      const pending = new Set<ReturnType<typeof setTimeout>>();
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      const schedule = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        ...args: Parameters<typeof setTimeout>
      ) => {
        const timer = realSetTimeout(...args);
        if (args[1] === 30_000) pending.add(timer);
        return timer;
      }) as typeof setTimeout);
      const cancel = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        pending.delete(timer as ReturnType<typeof setTimeout>);
        realClearTimeout(timer);
      });
      const runtime = ManagedRuntime.make(
        PagesRealtimeLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      );
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const pages = yield* PagesService;
            const realtime = yield* PageRealtimeService;
            const created = yield* pages.mutate(
              {
                op: "create",
                requestId: randomUUID(),
                scopeSpaceId: null,
                title: "Shutdown fixture",
                richContent: JSON.stringify([{ type: "p", children: [{ text: "Saved" }] }]),
                spaceId: null,
                parentPageId: null,
              },
              user,
            );
            const ticket = yield* realtime.issueToken(
              { scopeSpaceId: null, pageId: created.page.id },
              user,
            );
            if (scenario === "last viewer left") {
              const joined = yield* Effect.promise(() =>
                realtime.join({
                  pageId: created.page.id,
                  token: ticket.token,
                  connection: (mode) => ({ mode, send: () => {}, close: () => {} }),
                }),
              );
              expect(joined).not.toBeNull();
              realtime.leave(created.page.id, joined!.connection);
            }
          }),
        );
        expect(pending.size).toBe(1);
        await runtime.dispose();
        // No fake clock is advanced: disposal must cancel work immediately, not 30 s later.
        expect(pending.size).toBe(0);
      } finally {
        await runtime.dispose();
        for (const timer of pending) realClearTimeout(timer);
        schedule.mockRestore();
        cancel.mockRestore();
      }
    },
  );
});
