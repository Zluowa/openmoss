# Lessons

What merged work got wrong, kept as rules that would have caught it. Read this
before changing code. A lesson is a rule in force today; the times it was seen live
on its issue, not here (constitution, law 8).

## How a lesson is kept

- **Found.** The nightly review (the `nightly-review` skill) reads the day's merged
  PRs and asks three questions: what had to be fixed again, what should not have
  merged, and what was verified too thinly. A finding a reviewer or an engineer
  makes during the day counts the same way.
- **Recorded.** Each lesson has one GitHub issue labelled `lesson`. The issue holds
  the rule, the evidence (PRs, commits, failing output) and one comment per day it
  was seen. Seen again: add a comment to the existing issue, never a new one.
- **Written here.** The rule, one line on why, and the issue link. Nothing else: no
  dates, counts or history on this page.
- **Promoted.** A lesson seen on three separate days moves to the handbook page it
  belongs to (`engineering.md`, `quality.md`, a skill's Traps) and, where it can be,
  into an automatic check. It then leaves this page; the issue is closed with a link
  to where the rule now lives.
- **Retired.** A lesson that a check now enforces, or that no longer applies, is
  removed in the same PR that makes it so.

Format of an entry:

```
- **The rule, as an instruction.** Why, in one sentence. (#issue)
```

## Current lessons

- **A test that pretends to be another platform never writes through the real file
  system.** A `win32` path joined on Linux becomes a file name with backslashes, so
  `ProviderHealth.test.ts` leaves `apps/server/\tmp\moss-test-runtime-*` folders in
  the checkout, and one was committed by mistake. (#729)
- **Stage files by name, never with `git add -A`, while tests or servers run in the
  checkout.** Test runs write into the tree; `add -A` commits whatever they left.
  (#730)
- **A test that checks file permissions skips when it runs as root.** Root ignores
  permission bits, so three tests fail in every container: `keybindings.test.ts`,
  `IosSimulatorBackend.test.ts` and `WorkspaceFileSystem.test.ts`. (#731)
