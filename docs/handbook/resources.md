# Resources

Agents are cheap to start and never tidy up unless the system makes them. So every
resource has an owner, a lease and an expiry, and one tool hands them out and takes
them back. Nothing is created by hand.

## The rule

> Whatever a task creates is returned when its PR merges or closes.
> Whatever has no live owner is reclaimed.

## The workspace tool

One command manages every lease on a machine. It writes a small registry file
outside the repository, so the state of the machine can be read in one place.

It is `bun run ws <command>`; `tools/ws/README.md` has the flags. The
`start-task`, `run-isolated` and `reclaim` skills say when to use each command.

| Command          | Does                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ws new <name>`  | Creates a worktree under the worktree root, links dependencies, assigns a port offset and a scratch folder, records the lease         |
| `ws list`        | Shows every lease: owner, branch, PR state, age, size, ports                                                                          |
| `ws release`     | Stops the task's processes, removes its worktree and scratch, frees ports                                                             |
| `ws reap`        | Releases every lease whose PR is merged or closed, or whose owner is gone and whose tree is clean; lists the rest for the coordinator |
| `ws lane <name>` | Runs a heavy lane under the machine-wide lock, queued, one at a time                                                                  |
| `ws doctor`      | Reports free disk and memory, orphaned processes, unregistered worktrees, and anything over its limit                                 |

## Limits

| Resource         | Rule                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Worktrees        | One root, on the drive with space. One per task. Created and removed only by `ws`. Released within an hour of the PR merging. |
| Branches         | `<type>/<slug>`. Deleted on merge. `main` is the only long-lived branch.                                                      |
| Heavy lanes      | Full test lanes and builds: one at a time per machine, through `ws lane`.                                                     |
| Quick gate       | At most two `bun run check` at once per machine. A third waits; tests wait for a heavy lane.                                  |
| Ports            | Only the leased offset. Never the defaults, which belong to the owner's own Moss.                                             |
| Processes        | Every process a task starts is stopped by that task. `ws release` checks.                                                     |
| Scratch          | One scratch root, one folder per task, wiped on release. Never the system temp folder.                                        |
| Builds           | One builds root. Keep the current release, the previous release and the latest candidate.                                     |
| Evidence         | Attached to the PR. Kept locally only for the latest acceptance round.                                                        |
| Rollback sources | Listed by name in the operations runbook. Never reaped.                                                                       |
| Sessions         | Archived when their PR merges or closes.                                                                                      |
| Disk floor       | No heavy lane or build starts below the floor set in the machine profile.                                                     |

## Load

A machine runs one heavy job at a time (`bun run ws lane`) and at most two quick
gates (`bun run check`) at once. More than that has crashed the type checker and
turned hundreds of tests into false timeouts. The tools enforce both: `ws lane`
queues heavy jobs, and `bun run check` waits for a slot and holds its tests while
another owner's heavy lane runs (`tools/check/README.md`). Do not work around
them: no second heavy job outside `ws lane`, no hand-run test sweeps beside one.

A quick gate that fails under load proves nothing in either direction. Before
reporting a failure, rerun the failing files alone (`bun run check` does this
itself) and report the result as "failed under load, passes alone" or "fails
alone", never just "red".

## Machines

- The owner's Windows machine is the reference.
- A second machine (macOS) runs the components browser lane, about six minutes
  for the whole lane. The chat browser lane fails there in ways Windows does not
  and stays on Windows.
- The link to it is a slow relay. Send a binary patch against the tree it already
  has and check the tree hash there before running; never send whole snapshots.
  It holds no GitHub credential. `docs/ops/verification-machines.md` (kept in the
  private repository) says how to reach it.
- The owner uses the reference machine. While one of their full-screen
  applications is in front, no agent brings a Moss window forward or sends real
  input: real-window work waits. Background load is allowed.

## Tokens

The budget is finite and shared. Spend it on judgment.

- **Plan and review** with the strongest model. **Implement** with the efficient
  high-effort model. **Search and read in bulk** with the cheapest model that can
  do it, and bring back conclusions, not file dumps.
- Rules live in the handbook and skills, so briefs stay short and are not repeated.
- Long output goes to a file. Reports to the coordinator stay under 300 words.
- Search transcripts and logs; never read them whole.
- A worker that has spent its budget without converging stops and reports.
- The coordinator checks plan usage before starting a round and sizes the round
  to what is left.

## The reclaim sweep

After every round, and at least daily while work is active, the steward runs
`ws reap` and `ws doctor` and posts three numbers on the coordinator log: free
space per drive, leases still held, and items it could not classify. Anything
unclassified for a week is the coordinator's to decide.

## The machine profile

Paths, drive letters, tool locations, credentials helpers and known traps of a
particular machine are not project knowledge and are not in this repository. They
live in a machine profile next to the lease registry, and the workspace tool reads
them. An agent new to a machine reads its profile first.
