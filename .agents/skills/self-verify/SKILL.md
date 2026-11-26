---
name: self-verify
description: Layer 2 pre-PR self-verification against .agents/feature-map/*.md, static boundary guards, and real observable behavior before opening or updating any PR.
---

# Self-Verify (Layer 2 Quality Gate)

## When to use

Before pushing a branch or opening/updating any PR, after your last edit.

## Inputs

- Your worktree branch diff (`git diff --name-only origin/main...HEAD`)
- The matching `.agents/feature-map/*.md` guide(s) for the files you touched
- Your module entry in `docs/factory/modules.json`

## Steps

1. **Map diff to feature map & module owner.** Confirm every changed path belongs to your brief's module (`docs/factory/modules.json`) and list the `.agents/feature-map/*.md` journeys affected.
2. **Run Layer 1 static checks locally:**
   - `./node_modules/.bin/oxfmt --check .` (or `oxfmt.exe --check .` on Windows)
   - `bun run lint` (includes `oxlint`, `design:check`, `server-sync-fs:check`, `brand:check`, `copy:check`, `skills:check`, `boundaries:check`, `test-quarantine:check`)
   - `node .agents/skills/sync.mjs --check`
3. **Run affected typechecks & contract tests:**
   - Run package typecheck(s) and unit tests (`bun run --cwd <pkg> typecheck`, `bun run --cwd <pkg> test <files>`, or `bun run mobile:check` for `apps/mobile`), using the Mac lane or mirror CI for heavy web/server suites when on a memory-constrained Windows host.
4. **Verify user-perspective proof criteria:**
   - Check each affected journey in `.agents/feature-map/*.md`.
   - For UI changes, verify in a real render / browser test (Light + Dark, `zh-CN` + `en`, no explanatory subtitles, no clipped controls, no console/page errors).
   - For Windows runtime/packaging changes, verify process cleanup and confirm real user profiles and protocol registration remain untouched.
5. **Check git hygiene:**
   - `git diff --stat origin/main...HEAD` contains ONLY files your task intended to touch (no set-backs).

## Checks

- `oxfmt --check .` exit 0
- `bun run lint` exit 0
- `node .agents/skills/sync.mjs --check` exit 0
- All touched/contract tests pass without weakened assertions or newly skipped tests

## Output

Include a `Self-Verify` block inside the PR description:

```
Feature Maps   <list of .agents/feature-map/*.md checked>
Static Gates   oxfmt --check ., bun run lint, sync.mjs --check (exit codes + counts)
Contract Tests <exact commands and pass counts>
User Proof     <what was observed in browser/real-window/probe, or explicit Not Verified reason>
```

## Traps

- Never claim a test passed from memory or from an earlier commit before your final edit.
- Never run `bun install` inside a `ws new` worktree.
- Never weaken an assertion or add a mock just to turn a failing feature-map check green.
