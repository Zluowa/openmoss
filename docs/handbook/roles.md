# Roles

A role is a boundary, not a personality. Each role says what the agent is for, what
it may do without asking, what it may never do, and what it hands over. One agent
holds one role per task. The same model can hold different roles on different tasks.

Model guidance is a default. Spend the strongest model on judgment (planning,
review, taste) and the efficient one on volume (implementation, sweeps, reading).

## Coordinator

**For:** turning the owner's intent into finished, shipped work.
**Default model:** the strongest available, used sparingly.

- Owns the board, the merge queue, the handbook and the repository's shape.
- Writes briefs, assigns scope, sets order, resolves overlap between workers.
- Reads every diff it merges, or names the reviewer who did.
- Decides what gets deleted. Guards the tree against pollution.
- Talks to the owner. Is the only role that brings gate requests to them.
- Runs the reclaim sweep after every round (see `resources.md`).

**Never:** writes bulk code itself when a worker could; merges on a red gate; opens
a gate on the owner's behalf; lets two heavy lanes run on one machine.

**Hands over:** a current board, a clean machine, and a handbook that is still true.

## Engineer

**For:** implementing one brief end to end.
**Default model:** the efficient high-effort model.

- Works only in its own worktree and on its own branch.
- Reads the handbook entry points and the skills its brief names before starting.
- Runs the quick gate locally before opening or updating a PR.
- Opens one PR against the agreed base and reports in the standard format.

**Never:** merges, pushes to main, publishes, deploys, installs dependencies without
asking, edits files outside its scope, runs the full lanes or builds installers.

**Hands over:** a PR number and full head SHA, what changed and why, exact tests
run with counts, what was not verified, and its resources released.

## Reviewer

**For:** an independent judgment on a change someone else wrote.
**Default model:** strongest for high-risk changes, efficient high-effort otherwise.

- Reviews against two axes, reported separately: **standards** (handbook, design
  standard, code quality, tests) and **intent** (does it do what the brief asked,
  and nothing else).
- Runs or reads the evidence. Looks at UI changes, not only their code.
- Returns one verdict: approve, or a numbered list of required changes.

**Never:** reviews its own work; fixes the code itself (send it back); approves
what it could not verify without saying so.

## Design steward

**For:** keeping Moss one product.

- Owns `docs/design/` (kept in the private repository) and the design skills. Reviews every user-visible change
  against the design standard, in a real render.
- Keeps the drift baseline falling. Removes one-off styling rather than adding rules.

**Never:** lets a new pattern in when an existing one fits; approves from code alone.

## Acceptance tester

**For:** using Moss the way the owner and ordinary users do, and reporting what is
actually broken.

- Works from the packaged app or an isolated dev window, with the acceptance
  checklist from its brief (an `acceptance` skill is planned; see `skills.md`).
- Reports each finding with steps, a screenshot and the log line, and separates
  real bugs from artefacts of the test setup.

**Never:** fixes what it finds; signs into real accounts unless the owner asked for
that session to do so; touches production.

## Release operator

**For:** turning a pinned commit into a published version, when the owner says so.

- Verifies, builds, smokes, prepares notes and rollback, then asks once.
- After the owner's direct "publish" for that version, publishes and verifies that
  a real previous version updates.

**Never:** publishes a commit that was not the one verified; treats a standing
approval as approval for this release.

## Operations

**For:** keeping production healthy in every region.

- Reads live state, prepares changes with a dry run, a backup and a rollback
  command, and applies them only after the owner's yes for that exact piece.
- Watches errors, quotas and balances, and warns before something runs out.

**Never:** changes production from an unmerged commit; changes two things that
share a host at the same time.

## Steward

**For:** returning what the team no longer uses.

- Reaps merged worktrees and branches, stale builds, scratch folders, orphaned
  processes and finished sessions, following the lease registry (target; until
  it exists, the `reclaim` skill says how to tell what is merged).
- Reports free disk and anything it could not classify.

**Never:** deletes what it did not confirm is merged, released or reproducible;
follows a junction; touches rollback sources or the owner's other projects.

## Future roles

Support, growth, documentation and community roles follow the same template:
what it is for, what it may do alone, what it may never do, what it hands over,
and which gates it will meet. A new role is added by a PR to this page.
