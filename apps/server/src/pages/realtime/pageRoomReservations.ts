import { Deferred, Effect, Semaphore } from "effect";

import { PagesServiceError } from "../Services/PagesService";

/** Service-level exclusion: a room cannot be created while a no-room transaction commits.
 * Like creationCoordinator, entries count holders AND waiters and disappear on final release.
 * No authority or deadline is carried by this lock. Promise-backed shared mutations must
 * retain the permit until they actually settle, even when their caller is interrupted.
 */
export const makePageRoomReservations = () =>
  Effect.gen(function* () {
    const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
    const stopped = yield* Deferred.make<void>();
    let closed = false;
    let active = 0;
    let drained = Deferred.makeUnsafe<void>();
    const unavailable = () =>
      new PagesServiceError({ code: "storage", message: "Page room service is unavailable" });
    const withPage = <A, E, R>(pageId: string, task: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (closed) return null;
          if (active++ === 0) drained = Deferred.makeUnsafe<void>();
          const entry = locks.get(pageId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          entry.users++;
          locks.set(pageId, entry);
          return entry;
        }),
        (entry) =>
          entry === null
            ? Effect.fail(unavailable())
            : entry.semaphore
                .withPermits(1)(
                  Effect.suspend<A, E | PagesServiceError, R>(() =>
                    closed ? Effect.fail(unavailable()) : task,
                  ),
                )
                .pipe(
                  Effect.raceFirst(
                    Deferred.await(stopped).pipe(Effect.andThen(() => Effect.fail(unavailable()))),
                  ),
                ),
        (entry) =>
          Effect.gen(function* () {
            if (entry === null) return;
            if (--entry.users === 0) locks.delete(pageId);
            if (--active === 0) yield* Deferred.succeed(drained, undefined);
          }),
      );
    const close = Effect.gen(function* () {
      closed = true;
      // Interrupt both queued and active tasks; raceFirst waits for their transaction finalizers.
      yield* Deferred.succeed(stopped, undefined);
      if (active > 0) yield* Deferred.await(drained);
    });
    return { withPage, close, retainedPages: () => locks.size };
  });
