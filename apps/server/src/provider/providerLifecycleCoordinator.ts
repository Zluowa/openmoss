import { randomUUID } from "node:crypto";

import type { ThreadId } from "@synara/contracts";
import { Duration, Effect, Option } from "effect";
import * as Semaphore from "effect/Semaphore";

export interface ProviderLifecycleLease {
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly isPending: () => boolean;
  /** Atomically makes this provisional generation the committed-current fence. */
  readonly promote: () => void;
  /**
   * Takes lasting ownership of {@link ProviderLifecycleLease.generation}.
   *
   * A run publishes its generation eagerly (runtime events emitted *while* a
   * provider starts must not look stale), but that publication is provisional:
   * it survives the run only if the run says it took ownership. Call this once
   * the generation is observable outside the coordinator — i.e. a session was
   * started with it or a binding was persisted with it.
   */
  readonly commit: () => void;
  /** Takes lasting ownership of an existing generation instead of this run's. */
  readonly adopt: (generation: string) => void;
  /** Takes lasting ownership of "this thread has no provider generation". */
  readonly retire: () => void;
  /** Restores the nearest surviving predecessor without overwriting a newer owner. */
  readonly rollback: () => void;
}

export interface ProviderLifecycleCoordinator {
  readonly run: <A, E, R>(
    threadId: ThreadId,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
    prepare?: Effect.Effect<unknown, E, R>,
    onLockTimeout?: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Runs a mutation under an already allocated generation.
   *
   * The generation is published before `operation` starts, then either owned
   * explicitly through the lease or restored to the previous generation when
   * the operation exits. Per-thread serialization prevents two provisional
   * launches from restoring over one another.
   */
  readonly runProvisional: <A, E, R>(
    threadId: ThreadId,
    generation: string,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Registers a pending generation without displacing the committed fence and
   * returns an ownership token whose rollback cannot clobber a newer owner.
   */
  readonly beginProvisional: (threadId: ThreadId, generation: string) => ProviderLifecycleLease;
  readonly runCurrent: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Control-plane variant of {@link ProviderLifecycleCoordinator.runCurrent}:
   * waits a bounded time for the per-thread lock and then proceeds without it.
   * A wedged lifecycle mutation (a provider start that never returns) must not
   * be able to hold an interrupt hostage forever; the operation still validates
   * the current generation, so a racing replacement is rejected downstream.
   */
  readonly runCurrentUrgent: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
    /** Conditional controls fail on contention instead of bypassing their lock. */
    onLockTimeout?: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly adoptCurrent: (threadId: ThreadId, generation: string) => void;
  readonly currentGeneration: (threadId: ThreadId) => string | undefined;
  readonly isGenerationPending: (threadId: ThreadId, generation: string) => boolean;
}

/** How long an urgent control-plane operation waits for the per-thread lock. */
const URGENT_LOCK_WAIT = Duration.seconds(5);
const URGENT_LOCK_POLL = Duration.millis(25);

/** Serializes provider lifecycle mutations per thread and gives each mutation a unique epoch. */
export function makeProviderLifecycleCoordinator(): ProviderLifecycleCoordinator {
  const locks = new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  /** Last generation whose ownership fully committed; rollback always returns here. */
  const committedGenerations = new Map<ThreadId, string>();
  /** Generation currently accepted by runtime-event/control-plane fences. */
  const currentGenerations = new Map<ThreadId, string>();
  interface ProvisionalGeneration {
    state: "pending" | "promoted" | "committed" | "rolled-back";
  }
  const provisionalGenerations = new Map<ThreadId, Map<string, ProvisionalGeneration>>();

  type LockEntry = { readonly semaphore: Semaphore.Semaphore; users: number };

  const referenceEntry = (threadId: ThreadId): LockEntry => {
    let entry = locks.get(threadId);
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(threadId, entry);
    }
    entry.users += 1;
    return entry;
  };

  const releaseEntry = (threadId: ThreadId, entry: LockEntry) =>
    Effect.sync(() => {
      entry.users -= 1;
      if (entry.users === 0 && locks.get(threadId) === entry) {
        locks.delete(threadId);
      }
    });

  const withThreadLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
    onLockTimeout?: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    onLockTimeout !== undefined
      ? withThreadLockOrBypass(threadId, effect, onLockTimeout)
      : Effect.suspend(() => {
          const entry = referenceEntry(threadId);
          return entry.semaphore
            .withPermits(1)(effect)
            .pipe(Effect.ensuring(releaseEntry(threadId, entry)));
        });

  const withThreadLockOrBypass = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
    onLockTimeout?: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const entry = referenceEntry(threadId);
      const deadlineMs = Date.now() + Duration.toMillis(URGENT_LOCK_WAIT);
      // Polling `withPermitsIfAvailable` instead of racing a timeout against a
      // pending acquisition: a timed-out `take` can strand a permit and wedge
      // the thread's lifecycle for the life of the process.
      const attempt: Effect.Effect<A, E, R> = Effect.suspend(() =>
        entry.semaphore
          .withPermitsIfAvailable(1)(effect)
          .pipe(
            Effect.flatMap((result) => {
              if (Option.isSome(result)) return Effect.succeed(result.value);
              if (Date.now() < deadlineMs) {
                return Effect.sleep(URGENT_LOCK_POLL).pipe(Effect.andThen(attempt));
              }
              if (onLockTimeout !== undefined) return onLockTimeout;
              return Effect.logWarning(
                "provider lifecycle lock bypassed for an urgent control-plane operation",
                { threadId, waitedMs: Duration.toMillis(URGENT_LOCK_WAIT) },
              ).pipe(Effect.andThen(effect));
            }),
          ),
      );
      return attempt.pipe(Effect.ensuring(releaseEntry(threadId, entry)));
    });

  const beginProvisional: ProviderLifecycleCoordinator["beginProvisional"] = (
    threadId,
    generation,
  ) => {
    const owner: ProvisionalGeneration = {
      state: "pending",
    };
    let owners = provisionalGenerations.get(threadId);
    if (owners === undefined) {
      owners = new Map();
      provisionalGenerations.set(threadId, owners);
    }
    owners.set(generation, owner);
    let ownedGeneration = generation;
    const removeOwner = () => {
      const currentOwners = provisionalGenerations.get(threadId);
      currentOwners?.delete(generation);
      if (currentOwners?.size === 0) provisionalGenerations.delete(threadId);
    };
    const isCurrent = () => currentGenerations.get(threadId) === ownedGeneration;
    const promote = () => {
      if (owner.state !== "pending") return;
      currentGenerations.set(threadId, ownedGeneration);
      owner.state = "promoted";
    };
    return {
      generation,
      isCurrent,
      isPending: () => owner.state === "pending" || owner.state === "promoted",
      promote,
      commit: () => {
        if (owner.state === "pending") promote();
        if (owner.state === "promoted" && isCurrent()) {
          committedGenerations.set(threadId, ownedGeneration);
          owner.state = "committed";
          removeOwner();
        }
      },
      adopt: (adoptedGeneration) => {
        if (owner.state === "pending") promote();
        if (owner.state !== "promoted" || !isCurrent()) return;
        ownedGeneration = adoptedGeneration;
        committedGenerations.set(threadId, adoptedGeneration);
        currentGenerations.set(threadId, adoptedGeneration);
        owner.state = "committed";
        removeOwner();
      },
      retire: () => {
        if (owner.state === "pending") promote();
        if (owner.state !== "promoted" || !isCurrent()) return;
        committedGenerations.delete(threadId);
        currentGenerations.delete(threadId);
        owner.state = "committed";
        removeOwner();
      },
      rollback: () => {
        if (owner.state !== "pending" && owner.state !== "promoted") return;
        if (owner.state === "promoted" && isCurrent()) {
          const committedGeneration = committedGenerations.get(threadId);
          if (committedGeneration === undefined) {
            currentGenerations.delete(threadId);
          } else {
            currentGenerations.set(threadId, committedGeneration);
          }
        }
        owner.state = "rolled-back";
        removeOwner();
      },
    };
  };

  const runProvisional: ProviderLifecycleCoordinator["runProvisional"] = (
    threadId,
    generation,
    operation,
  ) =>
    withThreadLock(
      threadId,
      Effect.suspend(() => {
        const lease = beginProvisional(threadId, generation);
        lease.promote();
        return operation(lease).pipe(Effect.onExit(() => Effect.sync(lease.rollback)));
      }),
    );

  const run: ProviderLifecycleCoordinator["run"] = (threadId, operation, prepare, onLockTimeout) =>
    withThreadLock(
      threadId,
      // Reject or retire under the same lock while old events remain current.
      Effect.andThen(
        prepare ?? Effect.void,
        Effect.suspend(() => {
          const lease = beginProvisional(threadId, randomUUID());
          lease.promote();
          // Ownership is opt-in. The eagerly published generation is rewound on
          // exit unless the run explicitly committed/adopted/retired, so a run
          // that ends without changing anything — a successful no-op early
          // return, a failure, an interrupt before the provider was touched —
          // leaves the still-live session's generation exactly as it found it.
          // The inverse default is unsafe: an uncommitted generation nobody else
          // knows about silently invalidates every runtime event and every
          // generation-checked control call for that thread, forever.
          return operation(lease).pipe(Effect.onExit(() => Effect.sync(lease.rollback)));
        }),
      ),
      onLockTimeout,
    );

  return {
    run,
    runProvisional,
    beginProvisional,
    runCurrent: (threadId, operation) =>
      withThreadLock(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
      ),
    runCurrentUrgent: (threadId, operation, onLockTimeout) =>
      withThreadLockOrBypass(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
        onLockTimeout,
      ),
    adoptCurrent: (threadId, generation) => {
      committedGenerations.set(threadId, generation);
      currentGenerations.set(threadId, generation);
    },
    currentGeneration: (threadId) => currentGenerations.get(threadId),
    isGenerationPending: (threadId, generation) => {
      const owner = provisionalGenerations.get(threadId)?.get(generation);
      return owner?.state === "pending" || owner?.state === "promoted";
    },
  };
}
