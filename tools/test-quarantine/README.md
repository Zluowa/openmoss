# test-quarantine

One list, `test-quarantine.json` at the repository root, of tests that fail for reasons other
than the change under test: machine-only failures and flakes. Every lane skips them on the
platform they are listed for, so a red lane means a real failure. The rules are in
`docs/handbook/quality.md` ("Red means red").

## An entry

```json
{
  "id": "server:apps/server/src/http.test.ts > production Effect HTTP routes > serves a link",
  "platform": "win32",
  "reason": "Machine-only: needs symlink rights the Windows test user does not have.",
  "owner": "server",
  "added": "2026-11-11",
  "expires": "2026-11-25",
  "evidence": "verify-full 459a2e649, fbb0202b4: fails in 40/41 local server runs"
}
```

| Field                | Rule                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                 | `<lane>:<repo-relative file>`, then optionally `>` and the test's name exactly as Vitest prints a failure.               |
| `platform`           | `win32`, `linux`, `darwin` or `all`. Elsewhere the test runs normally.                                                   |
| `owner`              | An area (`server`, `web`, `web/transcript`, `shared`, `desktop`, `release`, …) that fixes the test or deletes the entry. |
| `added`              | The UTC date the entry was added; not in the future.                                                                     |
| `expires`            | At most 14 days after `added`. An expired entry fails `bun run lint`.                                                    |
| `reason`, `evidence` | Why it fails, and the runs that show it (run names, CI run ids, the control run on the base).                            |

Lanes: `contracts`, `shared`, `desktop`, `web`, `server`, `scripts` (unit), `components`, `chat`
(browser), `geometry` (the `[geometry:linux]` cases, which the stable browser lanes filter out by
name and the geometry lane runs).

A name covers the test with exactly that name and every test whose name continues it after a
space: a whole describe block, or the cases of an `each()` table (`fits the bar` covers
`fits the bar (light)`). `$name` and `%s` copied from a title match anything. Without a name the
entry covers the whole file, which is then left out of the run.

## Commands

| Command                                   | Does                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run test-quarantine:check`           | Part of `bun run lint`. Fails on expired entries, entries without an owner, more than 40 entries, ids whose file is missing or whose lane does not match the file, and tests that are never quarantined (`backendShutdown.windows.integration`). |
| `bun run test:quarantined [--lane a,b]`   | Runs only this platform's quarantined tests, lane by lane, with `--retry=0`, and prints pass/fail per entry. Exits 1 when any entry failed or did not run. Browser lanes need `VITEST_BROWSER_API_PORT` on Windows.                              |
| `MOSS_TEST_QUARANTINE=off <any test run>` | Ignores the list, to see a quarantined test fail (or pass) in its normal lane.                                                                                                                                                                   |
| `bun run test:test-quarantine`            | This tool's own tests.                                                                                                                                                                                                                           |

## How it is applied

`vitest.ts` is a Vitest plugin (`configureVitest`) in the root `vitest.config.ts` (contracts,
shared, desktop, scripts, server) and in `apps/web/vite.config.ts` (web unit and every browser
config, which extend it). For each project it leaves whole-file entries out through `exclude`,
adds `setup.ts` as a setup file, and provides this platform's test entries; `setup.ts` skips a
covered test in `beforeEach` with a note naming the entry. It imports only Vitest, so it runs in
the browser too. A config pins a mode with `test.env.MOSS_TEST_QUARANTINE` (the geometry lane
uses `only`).

## What does not belong here

- A test that fails alone on the base commit because of a product bug: fix it.
- `backendShutdown.windows.integration`: it finds real regressions. Rerun it alone, then bisect.
- Unhandled errors, teardown errors and errors outside a test: the list cannot hide them.
- A test that needs the network: put it behind an explicit opt-in instead (for example
  `MOSS_LIVE_BUNDLED_CODEX=1` for `apps/desktop/src/bundledCodex.live.test.ts`).

An entry whose test passes three nightly `test:quarantined` runs in a row is deleted by its owner.
