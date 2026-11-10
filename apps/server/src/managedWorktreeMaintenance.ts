// FILE: managedWorktreeMaintenance.ts
// Purpose: Daily pass over Moss-managed worktrees: keep active ones and the 15 most recently
//          archived, snapshot and remove the rest, and expire old recovery snapshots. It only
//          touches worktrees of threads the person archived or deleted.
// Layer: Server maintenance
// Exports: startManagedWorktreeMaintenanceJob

import { Effect } from "effect";

import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { pruneProjectedArchivedManagedWorktrees } from "./managedWorktrees";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";

// Startup settles first; then once a day, so snapshots expire even when nothing is archived.
export const MANAGED_WORKTREE_MAINTENANCE_INITIAL_DELAY_MS = 5 * 60 * 1000;
export const MANAGED_WORKTREE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const startManagedWorktreeMaintenanceJob = Effect.fn("startManagedWorktreeMaintenanceJob")(
  function* (projectionSnapshotQuery: ProjectionSnapshotQueryShape) {
    const config = yield* ServerConfig;
    const git = yield* GitCore;
    const prune = pruneProjectedArchivedManagedWorktrees({
      homeDir: config.homeDir,
      worktreesDir: config.worktreesDir,
      snapshotQuery: projectionSnapshotQuery,
      git,
    }).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("managed worktree maintenance failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Effect.sleep(MANAGED_WORKTREE_MAINTENANCE_INITIAL_DELAY_MS);
      yield* prune;
      yield* Effect.forever(
        Effect.sleep(MANAGED_WORKTREE_MAINTENANCE_INTERVAL_MS).pipe(Effect.flatMap(() => prune)),
        { disableYield: true },
      );
    }).pipe(Effect.forkScoped);
  },
);
