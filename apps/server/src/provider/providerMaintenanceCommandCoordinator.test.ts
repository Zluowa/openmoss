import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";

it("keeps an unproven cleanup block inside the existing coordinator until server restart", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const coordinator = yield* makeProviderMaintenanceCommandCoordinator({
        makeAlreadyRunningError: (key) => new Error(key),
      });
      const error = new Error("Restart Moss before retrying.");
      let ran = false;
      yield* coordinator.withCommandLock({
        targetKey: "install:cursor:default",
        lockKey: "moss-agent-install",
        run: coordinator.blockCommandLock("moss-agent-install", error),
      });
      const outcome = yield* coordinator
        .withCommandLock({
          targetKey: "install:cursor:other-instance",
          lockKey: "moss-agent-install",
          run: Effect.sync(() => {
            ran = true;
          }),
        })
        .pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
      expect(ran).toBe(false);
      // An unrelated maintenance lock continues to work. A new server has a fresh coordinator.
      yield* coordinator.withCommandLock({
        targetKey: "update:codex",
        lockKey: "npm-global",
        run: Effect.void,
      });
      const restarted = yield* makeProviderMaintenanceCommandCoordinator({
        makeAlreadyRunningError: (key) => new Error(key),
      });
      yield* restarted.withCommandLock({
        targetKey: "install:cursor:default",
        lockKey: "moss-agent-install",
        run: Effect.void,
      });
    }),
  );
});

it("checks a cleanup block again after a queued install acquires the same lock", async () => {
  const coordinator = await Effect.runPromise(
    makeProviderMaintenanceCommandCoordinator({ makeAlreadyRunningError: (key) => new Error(key) }),
  );
  let release!: () => void;
  let markEntered!: () => void;
  let markQueued!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const queued = new Promise<void>((resolve) => {
    markQueued = resolve;
  });
  const first = Effect.runPromise(
    coordinator.withCommandLock({
      targetKey: "one",
      lockKey: "moss-agent-install",
      run: Effect.gen(function* () {
        markEntered();
        yield* Effect.promise(() => wait);
        yield* coordinator.blockCommandLock("moss-agent-install", new Error("cleanup-unproven"));
      }),
    }),
  );
  await entered;
  let ran = false;
  const second = Effect.runPromise(
    coordinator
      .withCommandLock({
        targetKey: "two",
        lockKey: "moss-agent-install",
        onQueued: Effect.sync(markQueued),
        run: Effect.sync(() => {
          ran = true;
        }),
      })
      .pipe(Effect.result),
  );
  await queued;
  release();
  await first;
  expect((await second)._tag).toBe("Failure");
  expect(ran).toBe(false);
});
