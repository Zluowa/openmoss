---
name: review-pr
description: Use when asked to review a PR someone else wrote - freeze the head, judge standards and intent separately, verify the evidence, and return one verdict.
---

# Review a PR

## When to use

When a brief or the coordinator asks you to review a PR. Never for a PR you wrote
or helped write; say so and stop.

## Inputs

- The PR number and the repository (`<owner>/<repo>`).
- The brief the author worked from (usually the PR body, or the coordinator's
  message). If there is none, the intent axis says "no brief"; do not invent
  acceptance criteria.
- A worktree of your own if you will run anything (`start-task`).

## Steps

1. **Freeze the fixed point.**
   `gh pr view <n> -R <repo> --json headRefOid,baseRefName,title,body,files`.
   Fetch it: `git fetch origin pull/<n>/head`, then check
   `git rev-parse FETCH_HEAD` equals `headRefOid`. Base:
   `git merge-base origin/main <head>`. Review that head only. If the author
   pushes again, the new head keeps your verdict only if merging it gives the
   identical tree (`git merge-tree --write-tree origin/main <head>` prints the
   same tree for both heads); otherwise start over at the new head.
2. **Read the whole change once.** `git diff --stat <base>...<head>`, then
   `git diff <base>...<head>`, and `git log --oneline <base>..<head>`.
3. **Standards axis.** Check the change against `docs/handbook/constitution.md`,
   `docs/handbook/engineering.md`, the area `README.md` (for example
   `apps/web/README.md`) and, for visible changes,
   `docs/design/moss-design-standard.md` (kept in the private repository). Look for:
   - duplicated logic where something shared exists, local one-off fixes,
     mysterious names, speculative generality;
   - missing tests for changed behaviour;
   - repository hygiene: no status reports, dated files, evidence, screenshots,
     scratch scripts, secrets, or owner or machine details;
   - user-facing text outside `apps/web/src/localization.tsx`, or without both
     zh-CN and en;
   - code written on Linux (cloud sessions) without Windows proof of its paths,
     processes and timing, and path logic not tested with both path flavours;
   - a tool description that promises the model something (a library, a format)
     the runtime it produces for does not have.

   Report each finding with `file:line`, the rule it breaks, why it matters, and a
   concrete fix. Do not repeat what a tool already enforces.

4. **Intent axis.** Does it do what the brief asked, completely, and nothing
   more? Quote the brief line for each finding. Scope creep is a finding.
5. **Evidence.** Read the author's report, then check it. Re-run the targeted
   commands it names when that is cheap (`bun x oxfmt --check <files>`, the named
   tests), at the frozen head. For visible changes, look at the screenshots or a
   real render (`design-review`), not only the code.
   A capability counts only if it works on the real user path: a green fixture
   test, an HTTP 200 or a healthy browser page does not prove the desktop path.
6. **Risk.** If the change is high risk (`docs/handbook/quality.md`, "Risk"),
   say so: the coordinator must read the diff and a second reviewer is needed.
7. **Verdict.** Approve, or a numbered list of required changes. If the author's session cannot be reached, post the findings as a PR
   comment with the command that reproduces each one, and tell the coordinator.

## Checks

- The SHA in your verdict equals the PR's `headRefOid` at the time you finish.
- Every "verified" line names the command you ran and what you saw.

## Output

```
PR         #<n> at <full head SHA>
Standards  approve | numbered findings (file:line, rule, why, fix)
Intent     approve | numbered findings (quoted brief line)
Evidence   what you ran or looked at; what you could not verify, and why
Risk       normal | high (what that requires)
Verdict    approve | required changes 1..n
Optional   at most three suggestions, marked optional
```

## Traps

- Never fix the code yourself while reviewing. Send it back.
- Never blend the two axes into one score: a change can meet the standards and
  miss the brief, or the reverse.
- A polished description is not evidence. Neither is "tests pass" without a
  command and a count.
- Do not approve what you could not verify without saying exactly what is
  unverified.
- Review the frozen head. Findings against an older head mislead the author.
- A red quick gate under load is not a finding. Rerun the failing files alone
  first, and say which of "failed under load, passes alone" or "fails alone" you
  saw.
- When a diagram would shorten the review (a call path, a state machine), draw
  the smallest one, from cited code only, and mark unknown edges as unknown.
