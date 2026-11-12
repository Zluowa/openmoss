---
name: reclaim
description: Use within an hour of a task's PR merging or when it closes, at the end of every round, or when disk or memory runs low - return worktrees, branches, scratch, builds and processes safely and report what is left.
---

# Reclaim

## When to use

- As a worker: within an hour of your PR merging, or when it closes, return what
  your task created.
- As steward or coordinator: after every round, and whenever disk or memory is
  low, sweep the machine (`docs/handbook/resources.md`, "The reclaim sweep").

## Inputs

The machine profile (`tools/ws/README.md`, "The machine profile"): roots, the
keep list and the protected paths. Things that are never reaped (rollback
sources, the owner's own dev checkout, the latest acceptance evidence) are on the
keep or protected list.

## Steps

1. **Measure.** `bun run ws doctor --no-fail`. Note free space per drive.
2. **As a worker, release your own lease:** `bun run ws release <name> --dry-run`,
   then without `--dry-run`. It refuses uncommitted or unpushed work; push it or
   say why it can go before using `--force`. It stops the tree's processes,
   removes links as links, the folder, the scratch folder and the ports, and
   deletes the local branch when its PR merged at that commit.
3. **As steward, sweep:** `bun run ws reap` (a dry run). Read every row: RELEASE
   rows are clean, unused and finished; KEEP rows say why they stay. Then
   `bun run ws reap --apply`, which checks each row again first.
4. **Classify what reap keeps.** A tree kept for "open PR", "uncommitted" or
   "commits not in origin/main and no PR" belongs to someone: list it for the
   coordinator with its path and size. Never release it yourself.
5. **Builds.** Keep the current release, the previous release and the latest
   candidate; remove superseded candidates with `cmd //c "rmdir /s /q <folder>"`
   (Git Bash) or `cmd /c rmdir /s /q <folder>` (PowerShell).
6. **Measure again** with `bun run ws doctor --no-fail` and write the report.

## Checks

- `bun run ws list` no longer shows what you released.
- Free space after is not lower than before.
- The integration checkout still has its dependencies:
  `<integration checkout>/node_modules` is not empty.

## Output

```
Free space   per drive, before -> after
Reclaimed    worktrees, branches, folders, processes (counts, names)
Still held   leases kept, and why
Unclassified items you could not classify, with path and size
```

## Traps

- `node_modules` in worktrees are junctions into the shared install. A recursive
  delete (`rm -rf`, `Remove-Item -Recurse`) or `robocopy /MOVE` follows them and
  empties the real install; this has happened. Only `ws release`, `ws reap` and
  `rmdir /s /q` are safe.
- To move a worktree, do not. Make a new one and reclaim the old one.
- "prunable" in `git worktree list` means the folder is already gone; prune it,
  do not recreate it.
- Never delete what you have not confirmed is merged, released or
  reproducible. When unsure, move it aside and list it as unclassified.
- Never stop the owner's programs or anyone else's test runs. Match your own paths.
- Never touch rollback sources or the owner's other projects, whatever their age.
