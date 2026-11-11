# Moss

Moss is a desktop home for AI agents: one app where people work with any coding or
general agent, with chat, files, browser, canvas, pages and apps around it. It ships
to ordinary users in China and worldwide. It is built and run by AI agents.

You are one of those agents. Read this page, then the pages it sends you to for
your task. Do not start work without a brief.

## The law, in short

The full text is `docs/handbook/constitution.md`. It overrides everything else.

1. Tell the truth about what you verified.
2. Secrets never appear anywhere.
3. One task, one brief, one worktree, one branch, one PR.
4. Stay inside your brief's scope.
5. The author never merges. Only the coordinator merges.
6. Reuse before you build, delete before you add.
7. Return everything you create.
8. The repository holds only what is true today.
9. Isolate every run from the owner's real data.
10. One product, one voice: Moss, the design standard, the user's language.

Money, identity, publishing, production and the owner's own things need the
owner's direct yes for that action. Stop and report when you reach one.

## Where to look

| You are about to…                        | Read                                                    | Use skill       |
| ---------------------------------------- | ------------------------------------------------------- | --------------- |
| Start any task                           | `docs/handbook/coordination.md`                         | `start-task`    |
| Write or change code                     | `docs/handbook/engineering.md`, the area's `README.md`  |                 |
| Change anything a user can see           | `docs/design/moss-design-standard.md`                   | `design-review` |
| Write or change user-facing text         | `docs/zh-CN-product-glossary.md`, the design standard   | `design-review` |
| Open or update a PR                      | `docs/handbook/quality.md`                              | `open-pr`       |
| Review someone's PR                      | `docs/handbook/roles.md` (Reviewer)                     | `review-pr`     |
| Run or start Moss to try a change        | `docs/handbook/quality.md` (Isolation)                  | `run-isolated`  |
| Test as a user                           | `docs/handbook/quality.md`                              | `run-isolated`  |
| Merge, coordinate, plan a round          | `docs/handbook/roles.md` (Coordinator)                  |                 |
| Clean up a machine                       | `docs/handbook/resources.md`                            | `reclaim`       |
| Build, release or change production      | `docs/release.md` ("Unsigned feed release")             |                 |
| Understand how the system fits together  | `docs/core-concepts.md`, `docs/handbook/engineering.md` |                 |
| Learn how another product does something | `docs/research/`                                        |                 |

`docs/design/`, `docs/release.md`, `docs/core-concepts.md` and `docs/research/` are
kept in the private repository; the public mirror does not include them.

Skills live in `.agents/skills/`; `docs/handbook/skills.md` lists them and the
ones still planned.

## Commands

```
bun run check                           the quick gate: format, lint, checks, types and
                                        tests for what your change affects (about a minute)
bun x oxfmt --check <files>             format, on the files you changed
bun run lint                            oxlint, then the design, sync-fs, brand and skills checks
bun run --cwd <package> typecheck       types, for one package
bun run --cwd <package> test <files>    some tests (Vitest)
bun run test                            every workspace's tests: a heavy lane
```

Never run `bun test`: it is a different runner. Always `bun run test`.

`bun run check` is the quick gate. Run it before every push; the `open-pr` skill
has the details and `tools/check/README.md` says what it selects. The other lines
are its parts, for running one of them alone.
Do not run full lanes or build installers unless your brief says so: the
coordinator runs them, one at a time per machine.

## The codebase

- `apps/desktop` — the Electron shell.
- `apps/web` — the React interface.
- `apps/server` — the local server: agent runtimes, sessions, tools.
- `packages/contracts` — shared schemas and types. No runtime logic.
- `packages/shared` — shared runtime utilities, by explicit subpath.

Priorities, in order: correct, reliable under failure, fast, simple. Conventions
that cross areas are in `docs/handbook/engineering.md`. Conventions for one area
live next to the code they govern, in that area's `README.md` (so far
`apps/web/README.md`).
