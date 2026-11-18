# tools/accept: acceptance tours on the build that ships

`bun run accept run --app <packaged Moss> --tour <name|file.json>` starts a **packaged** Moss build in a
profile of its own, walks a tour like a person would, and asks Moss itself what it shows, through the
self-report tools of #692 (`screen_report`, `layout_report`, `screenshot`, `console_report`,
`apps/web/src/lib/selfReport`). Every answer, every screenshot and the verdict land in the run folder.
Exit 0 pass, 1 fail, 2 usage, 3 could not start.

## Safety

- **Never the owner's environment.** The app inherits only `SystemRoot`, `WINDIR`, `COMSPEC`, `OS`,
  `PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS` and `PATHEXT`, with a minimal `PATH`; never a
  session's `CLAUDE_*`, `ANTHROPIC_*`, `OPENAI_*`, `GH_*` or `GITHUB_*` values, provider keys or proxy
  settings.
- **Never the owner's profile.** Every home, app-data, Moss and Codex folder points inside
  `<run>/profile` (the same isolation as `scripts/verify-packaged-desktop-startup.ts`). The profile is
  removed after the run unless `--keep-profile`. A tour starts signed out.
- **Only in an isolated profile.** A packaged build offers the tools only with `MOSS_SELF_REPORT=1` and
  `MOSS_DESKTOP_USER_DATA_DIR` both set, which only this kit does. The kit refuses a self-report
  version it does not know (`KNOWN_SELF_REPORT_VERSIONS`).
- **Local only.** The debugging port is a free port on `127.0.0.1`.
- **Off the owner's screen.** A Win32 mover, started before the app, keeps every window of the
  run's own process tree (children count only if they started after their parent) left of every
  display; the runner checks it before the first step and around every screenshot.
  `--on-screen` is refused unless `MOSS_ACCEPT_ON_SCREEN=owner-approved` is set, which only the lead
  sets, for an acceptance the owner agreed to.
- **Stops only its own process.** It asks Moss to close its windows (Moss then stops its backend),
  waits 15 s, and only then stops the PID it started; never a process tree.
- Run it through the heavy lane on the shared PC: `bun run ws lane accept -- bun run accept run …`.

## Tours

`tools/accept/tours/*.json`, listed by `bun run accept tours`. Steps: `click` / `type` / `waitFor`
(selectors as Playwright reads them; prefer `data-slot`, `data-testid` or role and name), `press`
(a key), `wait` (ms), and `report` (a label, the tools to call, optional `sizes`: `"standard"` or a list,
optional `allowLayoutFindings`). A tour fails on: a step that cannot be done, a tool error or a tool
slower than 15 s, a report step whose screenshot wrote no file, more layout findings than allowed,
and more console errors than the tour's `allowConsoleErrors` (default 0; warnings never fail).

## Run folder

Run folders default to `<ws profile scratchRoot>/accept-runs/<run id>` (D: on the shared PC), never
C:'s TEMP. `result.json` (pass, problems, timing), one folder per report step with each tool's answer as JSON
and the screenshots, and `app-output.log` (the app's own output).

## The code-update pipeline

`bun run ws lane code-update -- bun run accept code-update --commit <sha> --shell-app <packaged shell folder>`
checks out the commit in its own work tree, builds with the fast-refresh caches, runs
`scripts/build-code-update.ts` against a copy of the shell and smokes the patched copy. It refuses a
non-hex commit before running anything, a work tree that is the dependency source, the shared
checkout or a repository's main worktree, a mirror origin and a different `bun.lock`; it removes and
writes only inside its out folder and never through a link. It never uploads.

`--release` builds with the Sentry DSNs (`VITE_SENTRY_DSN`, `MOSS_SENTRY_DSN`) and, when its file
exists, the feedback endpoint (`MOSS_FEEDBACK_ENDPOINT` as `VITE_FEEDBACK_ENDPOINT`), read from the
files that `--sentry-env` / `--feedback-env` or the ws profile's `release.sentryEnvFile` /
`release.feedbackEnvFile` name; it refuses to build without both DSNs. Only the names are logged,
never the values. Without `--release` it says "not a release build: no error reporting in this
package". `--sign` has the packer sign the manifest with the key it reads itself.
