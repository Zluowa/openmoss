---
name: reclaim
description: Use when a task's PR is merged or closed, at the end of every round, or when disk or memory runs low - return worktrees, branches, scratch, builds and processes safely and report what is left.
---

# Reclaim

## When to use

- As a worker: when your PR merges or closes, return what your task created.
- As steward or coordinator: after every round, and whenever disk or memory is
  low, sweep the machine (`docs/handbook/resources.md`, "The reclaim sweep").

## Inputs

From the machine profile: the integration checkout, the worktree, run and
scratch roots, the builds root, and the list of things that are never reaped
(rollback sources, the owner's own dev checkout, the latest acceptance evidence).

## Steps

1. **Measure.** `df -h` for every drive. Note the numbers for the report.
2. **List worktrees.**
   `git -C <integration checkout> worktree list --porcelain`.
   For each one with a branch, find its PR:
   `gh pr list -R <repo> --head <branch> --state all --json number,state`.
3. **Classify each worktree.** It may be reclaimed only if all hold:
   - its PR is `MERGED` or `CLOSED`, or it has no PR and you created it;
   - `git -C <worktree> status --short` is empty;
   - nothing is unpushed: `git -C <worktree> log --oneline @{u}..` is empty (for
     a detached worktree, its commit is on `origin/main` or in a merged PR);
   - it is not on the never-reap list.

   Anything else goes on the "could not classify" list for the coordinator.

4. **Stop its processes first.** Find processes whose command line contains the
   worktree or run-folder path, for example in PowerShell:
   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*<path>*' }`.
   Stop only those.
5. **Remove the folder** with a command that does not follow junctions. From
   PowerShell: `cmd /c rmdir /s /q <folder>`. From Git Bash:
   `cmd //c "rmdir /s /q <folder>"`. Then
   `git -C <integration checkout> worktree prune`.
6. **Delete the local branch** of a reclaimed worktree:
   `git -C <integration checkout> branch -D <branch>`. Remote branches are deleted
   on merge; leave other remote branches to the coordinator.
7. **Scratch and run folders.** Remove your own task folders, with the same
   junction-safe command. As steward, only folders whose task is merged or closed.
8. **Builds.** Keep the current release, the previous release and the latest
   candidate; remove superseded candidates.
9. **Measure again** and write the report.

## Checks

- `git -C <integration checkout> worktree list` no longer shows what you removed,
  and shows no `prunable` entries you created.
- `df -h` after is not lower than before.
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
  empties the real install; this has happened. Only `rmdir /s /q` is safe.
- To move a worktree, do not. Make a new one and reclaim the old one.
- "prunable" in `git worktree list` means the folder is already gone; prune it,
  do not recreate it.
- Never delete what you have not confirmed is merged, released or
  reproducible. When unsure, move it aside and list it as unclassified.
- Never stop the owner's programs or anyone else's test runs. Match your own paths.
- Never touch rollback sources or the owner's other projects, whatever their age.
