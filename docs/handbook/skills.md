# Skills

A skill is a fixed procedure for work the team repeats. It exists so the tenth run
gives the same result as the first, whichever agent does it. If you find yourself
explaining the same steps in a second brief, that is a skill waiting to be written.

## Where they live

Skills live in `.agents/skills/<name>/SKILL.md`, one folder per skill, and are
exposed to each agent runtime (Claude, Codex and the others Moss hosts) through
that runtime's own skills location. One source, no copies that drift.

Runtimes that read `.agents/skills/` use it directly. Claude Code reads
`.claude/skills/`, so that folder is generated: `node .agents/skills/sync.mjs`
copies every skill there with a "generated" note, and
`node .agents/skills/sync.mjs --check` fails when a copy differs, is missing, or
has no source. Edit only `.agents/skills/`, run the sync, and commit both. The
copy is used instead of a symlink because symlinks do not survive a Windows
checkout. The public mirror leaves `.claude/` out; there, run
`node .agents/skills/sync.mjs` once to create it.

## What a skill contains

```
---
name: design-review
description: When to use it, in one sentence an agent can match against its task.
---
When to use        the trigger, and when not to
Inputs             what you need before starting
Steps              numbered, each one checkable
Checks             the commands or observations that prove each step
Output             the exact shape of what you hand back
Traps              what went wrong before, and how to avoid it
```

A skill states the standard by pointing at the handbook or design docs; it does
not restate them. A skill over about 150 lines is two skills.

## The core set

| Skill           | For                                                                       |
| --------------- | ------------------------------------------------------------------------- |
| `start-task`    | Read the brief, take a worktree, confirm scope, set up isolation          |
| `open-pr`       | Quick gate, standard report, screenshots for visible changes, open the PR |
| `review-pr`     | Two-axis review (standards, intent), verdict in the fixed format          |
| `design-review` | Check a visible change against the design standard in a real render       |
| `run-isolated`  | Start a dev or packaged Moss that cannot touch the owner's data           |
| `reclaim`       | The reclaim sweep: return worktrees, scratch and processes, report space  |

### Planned

Not written yet. Until each one exists, follow the page or skill named here.
`docs/release.md` and `docs/research/` are kept in the private repository.

| Skill         | For                                                                       | Until then           |
| ------------- | ------------------------------------------------------------------------- | -------------------- |
| `copy-review` | Check user-facing text: voice, glossary, both languages, no jargon        | `design-review`      |
| `acceptance`  | The user-level checklist, findings with steps, screenshot and log         | `quality.md`         |
| `coordinate`  | Plan a round, write briefs, run the merge queue, post the coordinator log | `coordination.md`    |
| `release`     | Verify, build, smoke, notes, rollback, ask once, publish, verify update   | `docs/release.md`    |
| `deploy`      | Production change: read state, dry run, backup, apply, verify, rollback   | `constitution.md` §2 |
| `teardown`    | Study how another product does something and write it up as reference     | `docs/research/`     |
| `write-skill` | Turn a repeated procedure into a new skill                                | this page            |

## Keeping skills true

- A skill is changed in the same PR as the thing it describes.
- When a run of a skill goes wrong for a reason the skill did not warn about, the
  agent adds one line to **Traps** in its PR. That is how the team learns.
- The coordinator removes skills nobody has used; an unused skill is clutter.
