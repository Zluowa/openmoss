import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { pageAccessEpoch } from "./pageAccessEpoch";

it("keeps an overlapping permission mutation closed across interruption and never reuses the old stamp", async () => {
  const db = {};
  const epoch = pageAccessEpoch(db);
  expect(pageAccessEpoch(db)).toBe(epoch);
  expect(pageAccessEpoch({})).not.toBe(epoch);
  const before = epoch.current();
  const events: Array<string | null> = [];
  const off = epoch.listen(() => {
    events.push(epoch.current());
  });
  const one = Deferred.makeUnsafe<void>(),
    two = Deferred.makeUnsafe<void>(),
    done = Deferred.makeUnsafe<void>();
  const abort = new AbortController();
  const first = Effect.runPromise(
    epoch.around(Deferred.succeed(one, undefined).pipe(Effect.andThen(Effect.never))),
    { signal: abort.signal },
  ).then(
    () => false,
    () => true,
  );
  await Effect.runPromise(Deferred.await(one));
  const second = Effect.runPromise(
    epoch.around(Deferred.succeed(two, undefined).pipe(Effect.andThen(Deferred.await(done)))),
  );
  try {
    await Effect.runPromise(Deferred.await(two));
    expect(epoch.current()).toBeNull();
    abort.abort();
    expect(await first).toBe(true);
    expect(epoch.current()).toBeNull();
    await Effect.runPromise(Deferred.succeed(done, undefined));
    await second;
    expect(epoch.current()).not.toBeNull();
    expect(epoch.current()).not.toBe(before);
    expect(events.slice(0, 3)).toEqual([null, null, null]);
    expect(events.at(-1)).toBe(epoch.current());
  } finally {
    abort.abort();
    await Effect.runPromise(Deferred.succeed(done, undefined));
    await second;
    off();
  }
});
