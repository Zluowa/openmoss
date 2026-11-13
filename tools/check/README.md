# check — the pre-push gate

`bun run check` answers "is this change ready to push" in about a minute, from the files the
change touches. The lane it implements is described in `docs/handbook/quality.md`.

```
bun run check [--base <ref>] [--json] [--no-tests] [--allow-root] [--dry-run]
              [--no-wait] [--max-wait <minutes>]
```

| Flag                   | Does                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `--base <ref>`         | Compare with the merge base of `HEAD` and `<ref>` (default `origin/main`).     |
| `--json`               | Print one JSON object: changed files, the selection, every step with its time. |
| `--no-tests`           | Format, lint, checks and types only.                                           |
| `--allow-root`         | Run the selection even though root configuration changed (see below).          |
| `--dry-run`            | Print the steps and their commands without running them.                       |
| `--no-wait`            | Run the tests even while another owner's heavy lane runs (see Load).           |
| `--max-wait <minutes>` | Wait at most this long for a heavy lane, then test anyway (default 45).        |

Exit code 0 when every step passed (a test file that failed under load and passed alone counts as
passed, and is named), 1 when one failed, 2 when a full run is required.

## What runs

The changed files are everything that differs from the merge base: commits, staged and
unstaged edits, untracked files, deletions.

1. **Root configuration** (`package.json`, `bun.lock`, `bunfig.toml`, `turbo.json`, root
   `tsconfig*.json`, any Vitest or Vite config, Vitest setup files, `patches/`,
   `test-quarantine.json`): prints "full run required" and exits 2. Every test may be affected;
   the full lanes are the coordinator's. `--allow-root` runs the selection anyway.
2. **Format**: `oxfmt --check` on the changed files it formats.
3. **Lint**: `oxlint` on the changed JavaScript and TypeScript files.
4. **Checks**, each only when a file it reads changed: `design:check` (`apps/web/src`),
   `server-sync-fs:check` (`apps/server/src`, `packages/shared/src`), `brand:check` (public
   runtime sources, release scripts, brand assets, `README.md`), `skills:check` (`.agents/skills`,
   `.claude/skills`), `test-quarantine:check` (when the list exists).
5. **Types**: `bun run --cwd <package> typecheck` for every package that holds a changed code
   file or a file that imports one, directly or not. Tools under `tools/` with a Vitest config
   count as packages (`tsc -p tools/<name>/tsconfig.json`). Two at a time.
6. **Unit tests**: per package, `vitest run --maxWorkers=4` on the test files that import a
   changed file through any chain, the changed test files themselves, and tests that name a
   changed non-code file by its path (tests that read a fixture or a workflow file). Packages
   that do not test with Vitest are reported and skipped. These run alongside the types.
7. **Browser**: up to 20 selected component browser files run in
   `vitest.browser.ci.config.ts --project=components`. More than 20 are left to the
   coordinator's lane, and `ChatView.browser.tsx` always is (it takes over ten minutes alone).
   The browser port is `VITEST_BROWSER_API_PORT`, or 52000 plus `MOSS_PORT_OFFSET` from a `ws`
   lease.
8. **Phone app** (`apps/mobile`): not a workspace package (root `workspaces` lists
   `!apps/mobile`; it has its own npm install), so it gets no package typecheck or test step. Its
   files are formatted and linted like any others. When a change touches `apps/mobile/**`, a file
   the app imports, or `packages/contracts/src` (its contract-drift test reads them), the tests
   lane runs `bun run mobile:check` (`mobile:typecheck` with `--no-tests`) if
   `apps/mobile/node_modules` exists. Without it, one line says the lane was skipped and to run
   `bun run mobile:install`, then `bun run mobile:check`; that does not fail the gate.

Each step prints one line with its time; a failed step prints the exact command that
reproduces it and the end of its output. The last line is the total, the verdict and the load
(below).

## Failing test files are rerun alone

Each test step writes a Vitest JSON report beside its normal output. When a step fails, the files
its report marks failed are rerun after the other steps, one at a time, each alone with one
worker, at most 20 (more are named, not rerun, and count as failed). The summary separates
"failed under load, passed alone" from "failed alone". Only "failed alone" (or a failure the
report cannot pin on a file) makes the exit code non-zero; "passed alone" is reported, never
hidden.

## Load

A machine allows at most two runs at once and no tests during another owner's heavy lane
(`docs/handbook/resources.md`, "Load"). The locks are the workspace tool's
(`tools/ws/lib/lock.ts`), in the machine profile's state folder (`~/.moss-ws/locks` by default):

- **Slots.** A run takes `check-1` or `check-2` before its first step. A third waits in
  `check.queue` and prints one line naming the runs it waits for. A slot whose process is gone is
  broken like a stale heavy lock.
- **Heavy lane.** While `locks/heavy` is held by another owner, the static steps and types run
  at once and the tests wait for the lane to end (one line says whose lane). `--no-wait` runs them
  anyway; after `--max-wait` minutes (45 by default) they run anyway and the summary says so. The
  reruns wait the same way. A command started by `ws lane` (it sets `MOSS_WS_LANE`) never waits
  for its own lane; the owner comes from `MOSS_WS_OWNER`, else `CLAUDE_SESSION_NAME`, else the
  checkout's folder name.
- The last line says whether the run waited for a slot or a heavy lane, and whether its steps
  overlapped one, for example `load: tests waited 3.0 min for heavy lane batch7 (coordinator)`.

## How tests are chosen

`lib/graph.ts` builds a static import graph of the repository in about a second: it reads the
import lines of every tracked source file from git's index (`git grep --cached`, fast even in a
cold checkout) and the files changed in the working tree from disk, and resolves relative paths,
`~/` in the web app, and workspace package exports. It follows static, dynamic and side-effect
imports, `require` and `vi.mock`; it skips `import type` and `export type`, which are erased.

It is the graph `vitest related` walks, without transforming modules: `vitest related` on one web
file spent 72 seconds building that graph before running two test files. Where they differ, this
graph selects more: it follows the web app's code-split route files, which `vitest related` stops
at.

Which packages a change affects comes from the same graph, not from `package.json`: the server
lists `@moss/web` only to bundle its build and imports none of it, so a web change does not
typecheck or test the server; `scripts/` imports web and server code by relative path, so those
changes reach it.

## Tests

`bun run test:check`: file-to-package mapping, workspace patterns with `!` exclusions, when the
phone app's lane runs,
dependents through import chains, root-config detection, the static checks, test selection and
grouping, import parsing and resolution, the git side against a temporary repository, the slots
and the heavy-lane wait against temporary locks, and the rerun-alone classification (report
paths in both Windows and POSIX form).
