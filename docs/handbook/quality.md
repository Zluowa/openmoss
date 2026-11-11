# Quality

Verification has to be faster than the urge to skip it. The design below gives
every change an answer in about two minutes, and keeps the slow, thorough checks
off the path of everyday work.

## The lanes

| Lane     | When                                            | Contains                                                                                            | Budget                        |
| -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| Pre-push | The agent, before every push                    | Format, lint, design and brand checks on changed files; types and tests for what the change affects | 1 minute                      |
| PR gate  | Every push to a PR, automatically               | Static checks, types, affected unit tests; affected browser tests when the interface changed        | 2–4 minutes                   |
| Queue    | The coordinator, once per batch of approved PRs | Every lane, on the combined result of the batch, in parallel                                        | 12 minutes                    |
| Nightly  | Every night on `main`, and before a release     | Packaged app start-up, installers, release smoke, native and device checks, quarantined tests       | 45 minutes, never blocks a PR |

Budgets are part of the design. A lane that goes over budget is a defect with an
owner, fixed like any other.

The pre-push lane exists: `bun run check` (`tools/check/README.md`). It compares
your branch with its merge base on `origin/main`, checks format and lint on the
changed files, runs the design, sync-fs, brand and skills checks when their files
changed, typechecks the packages whose code imports a changed file, and runs the
unit tests that import one, chosen from the import graph. It runs at most 20
selected component browser files and never `ChatView.browser.tsx`; more than that
is left to the coordinator's lane. A change to root configuration prints "full run
required" and fails. Each step prints its time and, on failure, the exact command
to reproduce it.

The other lanes are the target. Until they land, the coordinator runs the full
lanes locally on the combined result of each batch. `.github/CI.md` (kept in the
private repository) says what runs in CI today.

## How the speed is kept

1. **Only what the change affects.** Tests are selected from the files changed.
   Changes to root configuration fall back to the full suite.
2. **Nothing is built to run a test.**
3. **Everything that can run in parallel does.** Limits on workers exist only
   where a test has been shown to need them.
4. **Warm runners.** Dependencies, browsers and caches are already there.
5. **Results are cached.** The same input never runs twice.
6. **One batch, one full run.** Approved PRs are verified together and merged
   together. A red batch is bisected automatically and only the culprit is sent back.

## Red means red

A check that fails for reasons other than the change teaches agents to ignore it.

- A flaky or machine-specific test goes into `test-quarantine.json` at the repository
  root: one list for every lane, unit and browser. Each entry names the test, the
  platform it is skipped on, a reason, an owner (an area), the evidence, and an expiry
  at most 14 days after it was added. `tools/test-quarantine/README.md` has the format.
- Every lane applies the list on the entry's platform; elsewhere the test runs.
  `MOSS_TEST_QUARANTINE=off` runs a quarantined test in its normal lane.
- `bun run lint` fails on expired entries, entries without an owner, and more than 40
  entries.
- `bun run test:quarantined` runs only the quarantined tests, with no retries, and
  prints pass or fail per entry. It belongs in the nightly lane (not wired yet). An
  entry that passes three nights in a row is deleted by its owner.
- A test that needs the network is not quarantined: it sits behind an explicit opt-in.
  `backendShutdown.windows.integration` is never quarantined: it finds real regressions.
- Nobody says "that was already failing" without a control run on the base commit,
  with both results shown.
- Nobody reruns until green. A test that passes on retry is flaky and is quarantined.

## Done

A change is done when all of these hold:

1. It does what the brief asked and nothing else.
2. The PR gate is green on the head commit.
3. For anything a user can see: it was looked at in a real render, in both themes
   and both languages, and the design review skill passed.
4. Behaviour that changed has a test that would have caught the old behaviour.
5. Documents and skills that describe the changed thing are updated in the same PR.
6. An independent reviewer approved it.
7. The standard report is on the PR and the task's resources are released.

## Risk

| Risk   | What                                                                                                                                                           | Extra requirement                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Normal | Everything else                                                                                                                                                | One independent review                                                                          |
| High   | Sign-in and accounts, payments and usage, updates and installers, stored data and migrations, permissions and sandboxing, anything that runs code from outside | The coordinator reads the diff itself; a second reviewer; the full queue lanes on that PR alone |

Size is a risk too. A PR over about 800 changed lines of product code is split,
unless the coordinator agreed to its size in the brief.

## Isolation

Every Moss an agent starts runs under the isolation profile: its own home, user
data, agent homes, ports and update switches, with test keys and local stubs
only. The `run-isolated` skill sets it up; the workspace tool supplies the paths
(until it lands, the machine profile does).
After a run, the agent confirms the owner's real data was not touched.

Acceptance with the owner's real account happens only when the owner asks for it,
in the session they asked.

## Review

Reviews report two things separately and never blend them into one score:

- **Standards:** constitution, design standard, code quality, tests, repository hygiene.
- **Intent:** the change does what the brief says, completely, and nothing more.

The verdict is `approve` or a numbered list of required changes. Suggestions that
are not required are marked optional and kept to three.
