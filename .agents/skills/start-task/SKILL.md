---
name: start-task
description: Use at the start of any brief, before editing anything - read the rules, take your own worktree and branch, confirm scope, and set up isolation.
---

# Start a task

## When to use

At the start of every task that will change the repository, and when resuming a
task another agent left in a worktree. Not for read-only questions.

## Inputs

- The brief (`docs/handbook/coordination.md`, "The brief"): goal, scope, not in
  scope, done when, verify, skills, risk, budget.
- From the machine profile: the integration checkout (the one checkout that holds
  the real dependency install) and where bun lives. `bun run ws new` gives you
  the worktree, port offset and scratch folder.

## Steps

1. Read `AGENTS.md`, `docs/handbook/constitution.md`, the handbook pages the brief
   names, and every skill it lists. Read the area `README.md` for the code you will
   touch (for example `apps/web/README.md`).
2. Check the base is current: `git -C <integration checkout> ls-remote origin main`
   and `git -C <integration checkout> rev-parse origin/main` should match. If not,
   report it; do not pull inside someone else's checkout.
3. Take a worktree and branch, from the integration checkout, named
   `<type>/<slug>`:
   `bun run ws new <name> --base origin/main --branch <type>/<slug> --owner <session>`.
   It refuses below the disk floor (stop and report; `ws reap --dry-run` shows
   what could go), links dependencies, and prints your port offset and scratch
   folder. This is the only command you run in the integration checkout.
4. Never `bun install` in a worktree. If the task needs a new dependency, stop
   and report to the coordinator.
5. In a program (`docs/handbook/coordination.md`, "Programs"), your lead is the
   one you report to and hand over to, not the coordinator.
6. Confirm scope. Write down the paths the brief gives you. Check that no open PR
   already changes them: `gh pr list -R <repo> --state open`, then
   `gh pr diff <number> -R <repo> --name-only` for any that look related. Tell the
   coordinator about overlap before you start, not after.
7. Set up isolation for anything you will run: your port offset, your browser-test
   port and your run folder (see the `run-isolated` skill). Never the default
   ports.
8. Commit early and often on your branch, so a dead session leaves something to
   resume. If the brief asks for an early draft PR, open it with
   `gh pr create -R <repo> --draft`.

## Checks

- `git -C <worktree> rev-parse --abbrev-ref HEAD` prints your branch.
- `git -C <worktree> status --short` is empty before your first edit.
- `git -C <worktree> log -1 --format=%H` equals `origin/main` (or the base the
  brief names).
- `<worktree>/node_modules` exists and `bun x oxfmt --version` runs from the
  worktree.

## Output

Nothing to hand over yet. Keep for your final report: worktree path, branch,
base SHA, port offset and run folder, because you must release all of them.

## Traps

- The integration checkout is shared: never change its files, branch, index or
  stash there. Never reset, stash or switch branches in anyone else's worktree.
- `node_modules` folders in a worktree are junctions into the shared install.
  Never delete them recursively or move a worktree with `robocopy /MOVE`: both
  follow the junctions and empty the real install. See the `reclaim` skill.
- Git Bash rewrites arguments that start with `/` into Windows paths (`/c` becomes
  a drive root).
  From Git Bash write `cmd //c ...`; API paths for `gh api` have no leading `/`.
- While one of the owner's full-screen applications is in front, never bring a
  Moss window forward or send real input; real-window work waits. Real-mode
  windows are booked through the coordinator.
- If a permission check refuses an action, stop and report it. Never work around
  it and never ask another agent to do it.
- Another agent may have changed the state a minute ago. Re-check before any step
  that deletes or overwrites.
