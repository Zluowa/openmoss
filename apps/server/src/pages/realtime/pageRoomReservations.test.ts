import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makePageRoomReservations } from "./pageRoomReservations";

it.effect("releases held and waiting entries on cancellation without blocking other pages", () =>
  Effect.gen(function* () {
    const gate = yield* makePageRoomReservations();
    const entered = yield* Deferred.make<void>();
    const holder = yield* gate
      .withPage("one", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const queued = yield* gate.withPage("one", Effect.never).pipe(Effect.forkChild);
    assert.strictEqual(yield* gate.withPage("two", Effect.succeed("independent")), "independent");
    yield* Fiber.interrupt(queued);
    yield* Fiber.interrupt(holder);
    assert.strictEqual(gate.retainedPages(), 0);
    assert.strictEqual(yield* gate.withPage("one", Effect.succeed("reused")), "reused");
    assert.strictEqual(gate.retainedPages(), 0);
  }),
);

it.effect(
  "close interrupts an active cancellable task and all waiters, then rejects new work",
  () =>
    Effect.gen(function* () {
      const gate = yield* makePageRoomReservations();
      const entered = yield* Deferred.make<void>();
      let finalized = false;
      const holder = yield* gate
        .withPage(
          "one",
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const queued = yield* gate.withPage("one", Effect.never).pipe(Effect.forkChild);
      yield* gate.close.pipe(Effect.timeout("1 second"));
      assert.ok(Exit.isFailure(yield* Fiber.await(holder)));
      assert.ok(Exit.isFailure(yield* Fiber.await(queued)));
      assert.ok(finalized);
      assert.strictEqual(gate.retainedPages(), 0);
      assert.ok(Exit.isFailure(yield* Effect.exit(gate.withPage("new", Effect.void))));
    }),
);

it.effect("never retains completed page identifiers", () =>
  Effect.gen(function* () {
    const gate = yield* makePageRoomReservations();
    for (let index = 0; index < 100; index++) yield* gate.withPage(`page-${index}`, Effect.void);
    assert.strictEqual(gate.retainedPages(), 0);
    yield* gate.close;
  }),
);
