---
name: open-pr
description: Use before pushing and when opening or updating a PR - run the quick gate, commit, push without credential prompts, and write the standard report.
---

# Open or update a PR

## When to use

Before every push, and when the work in a brief is ready for review. The author
opens the PR; the author never merges it.

## Inputs

- Your worktree and branch (from `start-task`), and the brief.
- From the machine profile: the signed-in GitHub CLI (`gh`) and the repository
  name (`<owner>/<repo>`).

## Steps

1. **Check scope.** `git diff --name-only origin/main...HEAD` plus
   `git status --short`. Every path must be inside the brief's scope. Move
   anything else out before going on.
2. **Run the quick gate:** `bun run check`. Never `bun test`.
   - It compares your branch with its merge base on `origin/main` (`--base <ref>`
     for another base) and runs, on what you changed: format, oxlint, the design,
     sync-fs, brand and skills checks when relevant, types for the affected
     packages, and the unit tests that import a changed file. One line per step
     with its time; a failed step prints the exact command to reproduce it.
   - "full run required" means you changed root configuration (`package.json`,
     `bun.lock`, `turbo.json`, `tsconfig*`, Vitest configs or setup, `patches/`).
     Say so in the PR; the full lanes are the coordinator's. `--allow-root` runs
     the selection anyway.
   - Browser files: it runs up to 20 selected component files and never
     `ChatView.browser.tsx`; anything more is left to the coordinator's lane. Say
     which in the report.
   - Quote its output (steps, times, counts) in the report. `--json` gives the
     same as one JSON object.
   - No full lanes, no `bun run test` across the repository, no installer builds,
     unless the brief says so.
3. **Visible changes.** Run the `design-review` skill. Take screenshots in light
   and dark and in zh-CN and en. They go on the PR, never into the repository.
4. **Commit.** Small commits with plain messages. Every message ends with a
   `Co-Authored-By:` line for the model that wrote the code. LF line endings.
5. **Push without a credential prompt and without printing a token:**
   `GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c "credential.helper=!'<gh>' auth git-credential" push origin <branch>`
   where `<gh>` is the GitHub CLI path from the machine profile.
6. **Write the body** to a file in your scratch folder, in the standard report
   shape (`docs/handbook/coordination.md`, "The standard report"). Say which
   model wrote the code.
7. **Open the PR:**
   `gh pr create -R <repo> --base main --head <branch> --title "<type>(<area>): <what>" --body-file <file>`.
   To update it later, push again and edit the body with
   `gh pr edit <number> -R <repo> --body-file <file>`.
8. **Record the head:** `git rev-parse HEAD` gives the full SHA for the report.

## Checks

- `gh pr view <number> -R <repo> --json headRefOid,baseRefName,state` shows your
  full SHA, base `main`, state `OPEN`.
- Every command named in the report was run, at that SHA, and its result is
  quoted with counts.

## Output

The standard report, in the PR body and as your last message:

```
PR           number and full head SHA
Changed      what, in plain words, per area
Why          the cause found, not only the fix made
Verified     exact commands, counts, and what was looked at
Not verified what was skipped or could not be shown, and why
Controls     baseline runs made to back any "it was already failing" claim
Left over    follow-ups
Released     worktree, branch, ports, processes, scratch: returned or still held
```

## Traps

- "Already failing on main" needs a control run: make a second worktree at
  `git merge-base origin/main HEAD` (`git worktree add --detach ...`), run the
  same test there, and show both results.
- A test that passes on retry is flaky, not passing. Rerun a failure alone before
  calling it a flake; if it fails alone, run it on the base.
- Never print, echo or log a token, and never put one in a URL, a file or the PR.
  Do not run `gh auth token`.
- Keep unrelated formatter changes out of logic commits. If some are needed, put
  them in their own format-only commit.
- Never merge, push to `main`, publish or deploy, even when a check is green.
- A PR over about 800 changed lines of product code is split unless the brief
  agreed to its size (`docs/handbook/quality.md`, "Risk").
