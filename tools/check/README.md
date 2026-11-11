# check — the pre-push gate

`bun run check` answers "is this change ready to push" in about a minute, from the files the
change touches. The lane it implements is described in `docs/handbook/quality.md`.

```
bun run check [--base <ref>] [--json] [--no-tests] [--allow-root] [--dry-run]
```

| Flag           | Does                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| `--base <ref>` | Compare with the merge base of `HEAD` and `<ref>` (default `origin/main`).     |
| `--json`       | Print one JSON object: changed files, the selection, every step with its time. |
| `--no-tests`   | Format, lint, checks and types only.                                           |
| `--allow-root` | Run the selection even though root configuration changed (see below).          |
| `--dry-run`    | Print the steps and their commands without running them.                       |

Exit code 0 when every step passed, 1 when one failed, 2 when a full run is required.

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

Each step prints one line with its time; a failed step prints the exact command that
reproduces it and the end of its output. The last line is the total.

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

`bun run test:check`: file-to-package mapping, dependents through import chains, root-config
detection, the static checks, test selection and grouping, import parsing and resolution, and
the git side against a temporary repository.
