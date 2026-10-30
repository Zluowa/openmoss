// FILE: providerLifecycleCoordinator.test.ts
// Purpose: Verifies per-thread lifecycle serialization and generation ownership rules.
// Layer: Provider lifecycle unit tests
// Depends on: makeProviderLifecycleCoordinator.

import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeProviderLifecycleCoordinator } from "./providerLifecycleCoordinator.ts";

const threadId = ThreadId.makeUnsafe("thread-lifecycle-coordinator");

describe("makeProviderLifecycleCoordinator", () => {
  it("keeps the old generation through preparation and does not rotate on rejection", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        coordinator.adoptCurrent(threadId, "old");
        const result = yield* coordinator
          .run(
            threadId,
            () => Effect.die("must not start"),
            Effect.gen(function* () {
              expect(coordinator.currentGeneration(threadId)).toBe("old");
              yield* Effect.yieldNow;
              expect(coordinator.currentGeneration(threadId)).toBe("old");
              return yield* Effect.fail("busy");
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(coordinator.currentGeneration(threadId)).toBe("old");
      }),
    );
  });

  it("publishes the run generation for the duration of a committed run", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const started = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            expect(coordinator.currentGeneration(threadId)).toBe(lease.generation);
            lease.commit();
            return lease.generation;
          }),
        );

        expect(coordinator.currentGeneration(threadId)).toBe(started);
      }),
    );
  });

  it("clears the generation when an uncommitted run succeeds on a fresh thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, () => Effect.void);

        expect(coordinator.currentGeneration(threadId)).toBeUndefined();
      }),
    );
  });

  it("restores the previous generation when a run fails before taking ownership", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const live = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );

        const result = yield* Effect.result(
          coordinator.run(threadId, () => Effect.fail("start failed" as const)),
        );

        expect(result._tag).toBe("Failure");
        expect(coordinator.currentGeneration(threadId)).toBe(live);
      }),
    );
  });

  it("marks an explicit generation provisional until the launch commits", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const launch = yield* coordinator
          .runProvisional(threadId, "startup-generation", (lease) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(() => lease.commit())),
            ),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        expect(coordinator.currentGeneration(threadId)).toBe("startup-generation");
        expect(coordinator.isGenerationPending(threadId, "startup-generation")).toBe(true);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(launch);
        expect(coordinator.isGenerationPending(threadId, "startup-generation")).toBe(false);
      }),
    );
  });

  it("keeps the committed generation current until a separately begun startup is promoted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const live = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );

        const startup = coordinator.beginProvisional(threadId, "pending-startup");
        expect(coordinator.currentGeneration(threadId)).toBe(live);
        expect(coordinator.isGenerationPending(threadId, "pending-startup")).toBe(true);

        startup.promote();
        expect(coordinator.currentGeneration(threadId)).toBe("pending-startup");
        expect(startup.isPending()).toBe(true);

        startup.commit();
        expect(coordinator.currentGeneration(threadId)).toBe("pending-startup");
        expect(startup.isPending()).toBe(false);
      }),
    );
  });

  it("rolls a promoted startup back without overwriting a newer committed winner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        coordinator.adoptCurrent(threadId, "old");
        const losing = coordinator.beginProvisional(threadId, "losing");
        losing.promote();
        expect(coordinator.currentGeneration(threadId)).toBe("losing");

        coordinator.adoptCurrent(threadId, "winner");
        losing.rollback();

        expect(coordinator.currentGeneration(threadId)).toBe("winner");
        expect(coordinator.isGenerationPending(threadId, "losing")).toBe(false);
      }),
    );
  });

  it("does not resurrect a rolled-back provisional predecessor", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        coordinator.adoptCurrent(threadId, "committed");
        const first = coordinator.beginProvisional(threadId, "first");
        first.promote();
        const second = coordinator.beginProvisional(threadId, "second");
        second.promote();

        first.rollback();
        second.rollback();

        expect(coordinator.currentGeneration(threadId)).toBe("committed");
        expect(coordinator.isGenerationPending(threadId, "first")).toBe(false);
        expect(coordinator.isGenerationPending(threadId, "second")).toBe(false);
      }),
    );
  });

  it("settles a failed provisional launch back to the previous generation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const previous = yield* coordinator.run(threadId, (lease) =>
          Effect.sync(() => {
            lease.commit();
            return lease.generation;
          }),
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const launch = yield* coordinator
          .runProvisional(threadId, "failed-startup-generation", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail("start failed" as const)),
            ),
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        expect(coordinator.isGenerationPending(threadId, "failed-startup-generation")).toBe(true);

        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(launch);
        expect(result._tag).toBe("Failure");
        expect(coordinator.isGenerationPending(threadId, "failed-startup-generation")).toBe(false);
        expect(coordinator.currentGeneration(threadId)).toBe(previous);
      }),
    );
  });

  it("serializes explicit provisional launches so a failed predecessor cannot rewind its winner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const firstEntered = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();

        const first = yield* coordinator
          .runProvisional(threadId, "failed-predecessor", () =>
            Deferred.succeed(firstEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(Effect.fail("first failed" as const)),
            ),
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(firstEntered);

        const second = yield* coordinator
          .runProvisional(threadId, "committed-winner", (lease) =>
            Effect.sync(() => {
              lease.commit();
              return lease.generation;
            }).pipe(Effect.tap(() => Deferred.succeed(secondEntered, undefined))),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(secondEntered)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        expect((yield* Fiber.join(first))._tag).toBe("Failure");
        yield* Deferred.await(secondEntered);
        expect(yield* Fiber.join(second)).toBe("committed-winner");
        expect(coordinator.currentGeneration(threadId)).toBe("committed-winner");
      }),
    );
  });

  it("keeps an owned generation when the run is interrupted after committing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        const committed = yield* Deferred.make<string>();
        const fiber = yield* coordinator
          .run(threadId, (lease) =>
            Effect.sync(() => lease.commit()).pipe(
              Effect.andThen(Deferred.succeed(committed, lease.generation)),
              Effect.andThen(Effect.never),
            ),
          )
          .pipe(Effect.forkChild);

        const generation = yield* Deferred.await(committed);
        yield* Fiber.interrupt(fiber);

        // The started runtime outlives the interrupted request, so rewinding
        // here would orphan it exactly like an uncommitted run.
        expect(coordinator.currentGeneration(threadId)).toBe(generation);
      }),
    );
  });

  for (const mode of ["urgent", "retirement", "legacy-urgent"] as const) {
    it(`bounds a contended ${mode} operation without changing legacy urgent fallback`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const coordinator = makeProviderLifecycleCoordinator();
          coordinator.adoptCurrent(threadId, "current");
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* coordinator
            .runCurrent(threadId, () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          let calls = 0;
          const operation = Effect.sync(() => {
            calls += 1;
            return "completed";
          });
          const timeout = Effect.fail("contended" as const);
          const now = Date.now();
          const clock = vi
            .spyOn(Date, "now")
            .mockReturnValueOnce(now)
            .mockReturnValue(now + 6000);
          const result = yield* (
            mode === "retirement"
              ? coordinator.run(threadId, () => operation, undefined, timeout)
              : coordinator.runCurrentUrgent(
                  threadId,
                  () => operation,
                  mode === "urgent" ? timeout : undefined,
                )
          ).pipe(
            Effect.result,
            Effect.ensuring(Effect.sync(() => clock.mockRestore())),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
          yield* Fiber.join(holder);
          expect(result._tag).toBe(mode === "legacy-urgent" ? "Success" : "Failure");
          expect(calls).toBe(mode === "legacy-urgent" ? 1 : 0);
          expect(coordinator.currentGeneration(threadId)).toBe("current");
          expect(yield* coordinator.runCurrent(threadId, () => Effect.succeed("reacquired"))).toBe(
            "reacquired",
          );
        }),
      );
    });
  }

  it("retires the generation for a stopped thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = makeProviderLifecycleCoordinator();
        yield* coordinator.run(threadId, (lease) => Effect.sync(() => lease.commit()));
        yield* coordinator.run(threadId, (lease) => Effect.sync(() => lease.retire()));

        expect(coordinator.currentGeneration(threadId)).toBeUndefined();
      }),
    );
  });
});
