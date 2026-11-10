import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_PAGES_PRINCIPAL as user } from "../Services/PagesService";
import { makePageRealtimeSqliteHarness as fixture } from "./testing/pageRealtimeSqliteHarness";
import { applyPlateValue, readPageDoc } from "./pageYjsContent";

const p = (text: string) => ({ type: "p", children: [{ text }] });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("actual Page room reservations", () => {
  it("keeps a real deferred room.open valid beyond five seconds", async () => {
    const h = await fixture();
    const entered = barrier();
    const release = barrier();
    let reads = 0;
    let settled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // issueToken's permission read is first; room.open's real Page read is second.
      h.controls.read = async () => {
        if (++reads === 2) {
          entered.release();
          await release.promise;
        }
      };
      const tokenPromise = h
        .run(h.realtime.issueToken({ pageId: h.page.id, scopeSpaceId: null }, user))
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      expect(h.realtime.roomCount()).toBe(1);
      release.release();
      const token = await tokenPromise;
      const joined = await h.realtime.join({
        pageId: h.page.id,
        token: token.token,
        connection: (mode) => ({ mode, send: () => {}, close: () => {} }),
      });
      expect(joined).not.toBeNull();
      expect(readPageDoc(joined!.room.doc)).toEqual([p("original")]);
      h.realtime.leave(h.page.id, joined!.connection);
    } finally {
      release.release();
      await h.close();
      vi.useRealTimers();
    }
  });

  it("cannot revive a room or idle timer when canceled open becomes ready after shutdown", async () => {
    const h = await fixture();
    const entered = barrier();
    const release = barrier();
    const abort = new AbortController();
    let reads = 0;
    const pendingIdle = new Set<ReturnType<typeof setTimeout>>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const schedule = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = realSet(...args);
      if (args[1] === 30_000) pendingIdle.add(timer);
      return timer;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      pendingIdle.delete(timer as ReturnType<typeof setTimeout>);
      realClear(timer);
    });
    try {
      h.controls.read = async () => {
        if (++reads === 2) {
          entered.release();
          await release.promise;
        }
      };
      const opening = h
        .run(h.realtime.issueToken({ pageId: h.page.id, scopeSpaceId: null }, user), abort.signal)
        .catch((error) => error);
      await entered.promise;
      abort.abort();
      await opening;
      let disposed = false;
      const closing = h.close().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      release.release();
      await closing;
      expect(h.realtime.roomCount()).toBe(0);
      expect(pendingIdle.size).toBe(0);
      await expect(
        Effect.runPromise(h.realtime.issueToken({ pageId: h.page.id, scopeSpaceId: null }, user)),
      ).rejects.toBeDefined();
    } finally {
      release.release();
      await h.close();
      schedule.mockRestore();
      clear.mockRestore();
    }
  });

  it.each([false, true])(
    "holds actual idle close/SQLite flush until settled (shutdown=%s)",
    async (shutdown) => {
      const h = await fixture();
      const entered = barrier();
      const release = barrier();
      let disposed = false;
      let closing: Promise<void> | undefined;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const token = await h.run(
          h.realtime.issueToken({ pageId: h.page.id, scopeSpaceId: null }, user),
        );
        const joined = await h.realtime.join({
          pageId: h.page.id,
          token: token.token,
          connection: (mode) => ({ mode, send: () => {}, close: () => {} }),
        });
        expect(joined).not.toBeNull();
        h.realtime.leave(h.page.id, joined!.connection);
        expect(
          (await h.run(h.base.read({ pageId: h.page.id, scopeSpaceId: null }, user))).content,
        ).toBe("original");
        await vi.advanceTimersByTimeAsync(29_999);
        h.controls.write = async () => {
          entered.release();
          await release.promise;
        };
        applyPlateValue(joined!.room.doc, [p("flushed before replacement")], "fixture");
        await vi.advanceTimersByTimeAsync(1);
        await entered.promise;
        // The atomic outer transaction now owns this SQLite connection: an independent
        // read must not be awaited here while the intentionally deferred writer holds it.
        expect(h.completedWrites.some((row) => row.content === "flushed before replacement")).toBe(
          false,
        );
        let tokenSettled = false;
        let joinSettled = false;
        let guestEntered = false;
        const opening = h
          .run(h.realtime.issueToken({ pageId: h.page.id, scopeSpaceId: null }, user))
          .then(
            (value) => {
              tokenSettled = true;
              return value;
            },
            (error) => {
              tokenSettled = true;
              return error;
            },
          );
        const joining = h.realtime
          .join({
            pageId: h.page.id,
            ticket: {
              pageId: h.page.id,
              scopeSpaceId: null,
              mode: "view",
              expiresAt: Date.now() + 60_000,
            },
            connection: (mode) => ({ mode, send: () => {}, close: () => {} }),
          })
          .then((value) => {
            joinSettled = true;
            return value;
          });
        const guest = h
          .run(
            h.realtime.withRoomClosed(
              h.page.id,
              Effect.sync(() => {
                guestEntered = true;
              }),
            ),
          )
          .catch((error) => error);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(tokenSettled).toBe(false);
        expect(joinSettled).toBe(false);
        expect(guestEntered).toBe(false);
        expect(h.realtime.roomCount()).toBe(1);
        if (shutdown) {
          closing = h.close().then(() => {
            disposed = true;
          });
          await vi.advanceTimersByTimeAsync(1);
          expect(disposed).toBe(false);
          expect(h.realtime.roomCount()).toBe(1);
        }
        release.release();
        await Promise.all([opening, joining, guest]);
        if (closing) {
          await closing;
          expect(h.realtime.roomCount()).toBe(0);
        } else {
          const saved = await h.run(h.base.read({ pageId: h.page.id, scopeSpaceId: null }, user));
          expect(saved.content).toBe("flushed before replacement");
          expect(saved.page.revision).toBe(2);
          const replacement = await joining;
          expect(replacement).not.toBeNull();
          expect(readPageDoc(replacement!.room.doc)).toEqual([p("flushed before replacement")]);
          h.realtime.leave(h.page.id, replacement!.connection);
        }
        expect(guestEntered).toBe(false);
        expect(
          h.completedWrites.some(
            (result) =>
              result.content === "flushed before replacement" && result.page.revision === 2,
          ),
        ).toBe(true);
      } finally {
        release.release();
        await closing;
        await h.close();
        vi.useRealTimers();
      }
    },
  );
});
