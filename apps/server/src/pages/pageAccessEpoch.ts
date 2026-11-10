import { randomUUID } from "node:crypto";
import { Effect } from "effect";

/** Sessions live in this process. Every layer using the same SQLite service sees
 * the same monotonic stamp, including overlapping/nested writes. A new database
 * service gets its own lifetime and never reuses an old session's stamp. */
class PageAccessEpoch {
  private readonly lifetime = randomUUID();
  private version = 0n;
  private writers = 0;
  private readonly listeners = new Set<() => void>();

  current(): string | null {
    return this.writers ? null : this.lifetime + ":" + this.version.toString(36);
  }

  listen(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    this.version++;
    // The stamp itself is authoritative. A faulty cleanup listener must not
    // strand the writer counter or prevent other projections from being dropped.
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* subsequent access still checks the new stamp */
      }
    }
  }

  around<A, E, R>(write: Effect.Effect<A, E, R>) {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        this.writers++;
        this.changed();
      }),
      () => write,
      () =>
        Effect.sync(() => {
          this.writers--;
          this.changed();
        }),
    );
  }
}

const epochs = new WeakMap<object, PageAccessEpoch>();
export function pageAccessEpoch(database: object) {
  let epoch = epochs.get(database);
  if (!epoch) {
    epoch = new PageAccessEpoch();
    epochs.set(database, epoch);
  }
  return epoch;
}
