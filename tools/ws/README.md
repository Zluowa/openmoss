# ws — the workspace tool

`bun run ws <command>` is the one way agents get and return machine resources: worktrees,
port offsets, scratch folders and the heavy-lane lock. The rules it enforces are in
`docs/handbook/resources.md`. It has no dependencies beyond Node/Bun built-ins and git.

## Commands

| Command                                                                           | Does                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws new <name> [--base origin/main] [--branch <type>/<slug>] [--owner <session>]` | Refuses below the disk floor. Creates a worktree under the worktree root, links dependencies from the primary checkout (junctions, never an install), assigns a free port offset and a scratch folder, records the lease. `--reuse-branch` checks out an existing branch as it is; `--no-deps` skips linking. |
| `ws list [--json] [--no-size] [--all-sizes] [--fresh] [--size-budget <s>]`        | Every lease and every git worktree: owner or `unregistered`/`outside`, branch, PR state, age, size (links never followed), dirty count, ports.                                                                                                                                                                |
| `ws release <name> [--dry-run] [--force]`                                         | Refuses uncommitted or unpushed work unless `--force`. Lists, then stops processes whose command line is inside the tree; removes links as links, then the folder; `git worktree prune`; frees ports and scratch; deletes the local branch when its PR merged at that commit.                                 |
| `ws reap [--apply] [--json]`                                                      | Dry run unless `--apply`. Releases leases and unregistered worktrees that are clean, unused and finished (PR merged at HEAD, PR closed with every commit pushed, or HEAD in `origin/main` and no git activity for `limits.recentHours`). Prints every other tree with the reason it was kept.                 |
| `ws lane <name> [--owner <session>] [--shell] -- <command…>`                      | Checks the disk floor on the profile's drives (exit 9 when below), waits for the machine-wide heavy lock (prints its queue position), runs the command with `MOSS_WS_LANE=<name>`, releases the lock. The exit code is the command's.                                                                         |
| `ws doctor [--no-fail]`                                                           | Free disk and memory, lock holder and queue, orphaned dev/test processes (listed only), unregistered worktrees, leases over the age limit, worktree count over the limit. Exits 1 when anything is over a limit.                                                                                              |

The owner of a lease or lane comes from `--owner`, else `MOSS_WS_OWNER`, else `CLAUDE_SESSION_NAME`.
A lease's port offset is for `MOSS_PORT_OFFSET` (dev server 3773+offset, web 5733+offset).

## Safety

All deletion goes through `lib/safeRemove.ts`:

- The target must be a real directory strictly inside a configured root, reached without any link,
  not a protected path, not inside or containing one, not containing another worktree, and not a
  main checkout (a `.git` directory).
- Links and junctions are removed as links in a first pass; ws never descends into one. Before
  entering any directory its real path must be exactly where it was listed; a directory that
  resolves elsewhere is treated as a link and unlinked, never entered.
- The primary checkout, the state folder and the main worktree of the repository are always protected.

The tests (`bun run test:ws`) create junctions to sentinel folders in temp folders and assert the
sentinels survive every delete path.

## The machine profile

Paths, drives and tool locations of a machine are not in this repository. They are in a JSON file
whose location is `$MOSS_WS_PROFILE`, by default `~/.moss-ws/profile.json`. Copy
`profile.example.json` there and fill it in. Fields:

| Field                                 | Meaning                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `primaryCheckout`                     | The coordinator's checkout. git commands run here; dependencies are linked from it (or from `dependencySource`). Never removed. |
| `githubRepo`                          | `owner/repo` for PR state through `gh` (optional).                                                                              |
| `worktreeRoot`                        | Where `ws new` creates worktrees.                                                                                               |
| `legacyRoots`                         | Older worktree roots that `list` shows and `reap` may clean.                                                                    |
| `scratchRoot`                         | One scratch folder per lease.                                                                                                   |
| `stateDir`                            | Leases, locks and caches (default: the profile's folder).                                                                       |
| `protectedPaths`                      | Never removed, nor anything containing them.                                                                                    |
| `keep`                                | Worktree names or paths reap always keeps.                                                                                      |
| `disk.floorGB`, `disk.drives`         | No `new` or `lane` below this much free space on these drives.                                                                  |
| `ports`                               | Port offset range handed to leases.                                                                                             |
| `lock.staleHours`, `lock.pollSeconds` | When a held lock counts as stale (its pids are gone, or it is older); how often waiters poll.                                   |
| `limits`                              | `leaseMaxAgeDays`, `maxWorktrees`, `recentHours` (reap keeps trees used more recently on "HEAD in main" alone).                 |
| `tools`                               | `git`, `gh`, `bun` executables.                                                                                                 |

The lease registry is `<stateDir>/leases.json`; the heavy lock is the directory
`<stateDir>/locks/heavy` with an `owner.json` {pid, childPid, owner, lane, sha, started}. The
same lock code, with two slots (`locks/check-1`, `locks/check-2`, queue `locks/check.queue`),
limits `bun run check` (`tools/check/README.md`, "Load").

## Differences from the operator's `mkwt.mjs`

- `node_modules/.cache`, `.vite` and `.vite-temp` become real, empty folders in the worktree.
  mkwt links them into the primary checkout, so a typecheck or Vitest run in a worktree rewrote
  cache files there.
- A dangling link in the primary checkout's install is skipped with a warning; mkwt aborts half way.

## Not yet

- Leases are not tied to sessions: reap does not know whether the owning session is still alive.
- Sizes of very large trees may need several runs (or `--size-budget`) to finish; unfinished ones show as `>`.
- The operator scripts (`verify-*.sh`) do not call `ws lane` yet.
