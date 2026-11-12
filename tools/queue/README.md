# queue — the merge queue

`bun run queue <command>` is the coordinator's batch loop as one tool: build a candidate from
approved PRs, verify it on every lane, judge the failures, and merge a green batch one PR at a
time. It is the "Queue" lane of `docs/handbook/quality.md`. It never syncs the public mirror,
never publishes anything, and never picks PRs by itself: `plan` takes PR numbers, so a later
`queue auto` can call these commands.

## Commands

| Command                                                                    | Does                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue plan <pr> [<pr>…]`                                                  | Reads each PR from GitHub, fetches the base branch and every `refs/pull/<n>/head`, refuses a fetched head that is not the head GitHub reports, then chains `git merge-tree --write-tree` + `git commit-tree` onto the base in the given order. Prints the first conflict with its files, or the candidate SHA, tree and per-PR heads. |
| `queue verify [<candidate>] [--only <lane,…>] [--no-remote] [--resume]`    | Runs every lane (below) on the candidate, prints one line per lane as it finishes, then judges the failures. Writes `verdict.json`, `summary.txt` and one log per run. Exit 0 only when green.                                                                                                                                        |
| `queue merge [<candidate>] [--dry-run] [--allow-base-red] [--note <text>]` | Merges the batch through the GitHub API, one PR at a time, pinned to its verified head, with a merge commit. After every merge it fetches the base and requires its tree to equal the tree computed for that step; it stops at the first mismatch. Appends one line per merge to the merge log.                                       |
| `queue status [<candidate>]`                                               | The heavy lock's holder, the current candidate, what `verify` is running, the last verdict and merge progress.                                                                                                                                                                                                                        |

`<candidate>` is a candidate SHA or a prefix of 7+ characters; the default is the one `plan`
made last. The candidate commits are not referenced by any branch or ref; they live in the
object store of the lane checkout until git's garbage collection drops them (weeks).

The candidate SHA is reproducible: queue commits use a fixed identity and the base commit's
date, so planning the same PRs on the same base again gives the same candidate, and `verify
--resume` carries on where it stopped.

## Lanes

`lib/lanes.ts` is the table, in run order: `fmt`, `lint`, `winruntime`, `migrations`,
`typecheck`, `contracts`, `shared`, `desktop`, `web`, `chat`, `compiler`, `server`, `scripts`,
`releasesmoke`, and `components`. Each row says where the command runs, its exact command and
environment (the same commands as the coordinator's full-lane script, browser ports from
`queue.browserPortBase`), whether its output is Vitest's, how a failure is rerun alone (`files`,
`names` for the one-file chat lane, or the whole `lane`), and which folders make a PR a suspect.

Local lanes run one after another in `queue.checkout`, under the machine's heavy-lane lock (the
lock of `ws lane`, with its disk floor). Before each series the checkout is checked out at the
commit (refused when it has tracked changes), its tree is checked, and `bun install
--frozen-lockfile` runs; a failure there makes the verdict `broken`. Do not run `queue verify`
inside `ws lane`: it takes the lock itself, per series, so a long judgement never holds the lock
past its stale limit.

The queue never installs into a checkout whose dependencies are linked from another (a `ws new`
worktree: its `node_modules/.bun` is a link), because that install would rewrite the other
checkout's. With `"queue.install": "linked"` it runs on the linked install as it is and refuses
any commit whose `bun.lock` differs from the linked install's.

The `components` lane runs on the second machine when `queue.remote` is configured (and
`--no-remote` is not given), in parallel with the local lanes. The queue sends a gzip'd `git diff
--binary` from the tree that machine already has, the remote applies it and must arrive at
exactly the candidate's tree (`git write-tree`), and the lane runs there in `shards` Vitest shards
in the background while the queue polls. Every remote command is generated with explicit lists;
the remote side needs only bash, git, gunzip and the repo's toolchain. When the remote is
unreachable or the tree does not match, the lane runs locally instead and the verdict says so.

## The judgement

1. Every failing file (or, for `chat`, test) is rerun alone on the candidate, serially, with
   `--no-file-parallelism`. A static check or a run with no failures to name (crashed, errors
   outside tests) is rerun whole. What passes is **flaky**; the verdict lists it with its
   `test-quarantine.json` id where the list covers the lane.
2. What still fails runs on the base (the control). Failing there too is **pre-existing**. A
   test file the base does not have cannot be, so it is real without a control run.
3. What fails on the candidate and passes on the base is **real**. Its lane (only those files)
   runs on the base plus each PR alone, limited to PRs that touch the lane's folders unless none
   does, to name the culprit. A batch of one PR names that PR without running more. A failure no
   single PR reproduces is real with no culprit ("fails only in combination").

The verdict is `green` (nothing real, flaky allowed), `red` (something real or not judged),
`base-red` (only pre-existing failures) or `broken` (setup failed). A failure that existed on the
base and got worse in the batch still reads as pre-existing; the lane logs show the difference.

`queue merge` requires a `green` verdict (`base-red` only with `--allow-base-red`) that is
complete (every lane ran, here or recorded green before with `--resume`), for exactly the
candidate's base, heads and trees. A PR whose head changed after verification is accepted only
if merging the new head onto the previous step gives the identical tree; otherwise the batch must
be planned and verified again. A stacked PR is retargeted to the base branch before it merges.
Before the first merge, and before each later one, the base branch must have exactly the tree the
candidate expects; a merge by someone else in between stops the run.

## State

Under `queue.stateDir` (default `<ws stateDir>/queue`):

```
current.json                  the candidate `plan` made last
<sha12>/candidate.json        base, steps (PR, title, head, base branch, commit, tree), candidate SHA and tree
<sha12>/runs.json             every lane run: status, failures, seconds, log
<sha12>/progress.json         phase and what is running (read by `queue status`)
<sha12>/verdict.json          lanes, failures with classification and culprits, notes
<sha12>/summary.txt           the human summary
<sha12>/merge.json            what `merge` merged, so a stopped merge can carry on
<sha12>/logs/*.log            lane-<lane>, rerun-<lane>, control-<lane>, pr-<n>-<lane>, install-<sha>
```

## Configuration

Machine facts live in the `queue` section of the ws machine profile
(`$MOSS_WS_PROFILE`, default `~/.moss-ws/profile.json`; see `tools/ws/README.md`). The repository
holds no machine names, users or paths.

```json
{
  "githubRepo": "owner/repo",
  "defaultBase": "origin/main",
  "tools": { "git": "git", "gh": "/path/to/gh", "bun": "/path/to/bun" },
  "queue": {
    "checkout": "/path/to/the/checkout/lanes/run/in",
    "mergeLog": "/path/to/merge-log.md",
    "remote": {
      "ssh": "user@second-machine",
      "workdir": "moss-verify",
      "pathPrepend": ["~/moss-verify/bun"],
      "shards": { "components": 3 }
    }
  }
}
```

| Key                                          | Meaning                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `queue.checkout` (required)                  | The checkout the queue's git work and every local lane run in. Lanes check it out detached; keep it free of tracked changes. |
| `queue.repo`                                 | `owner/repo`; default the profile's `githubRepo`.                                                                            |
| `queue.mergeLog`                             | The merge log `merge` appends to; required for a real merge, not for `--dry-run`.                                            |
| `queue.stateDir`                             | Default `<ws stateDir>/queue`.                                                                                               |
| `queue.install`                              | `frozen` (default): `bun install --frozen-lockfile` before each series. `linked`: no install (see above).                    |
| `queue.browserPortBase`                      | Browser lanes use this port and the next two (default 53660).                                                                |
| `queue.laneTimeoutMinutes`                   | A lane process running longer is stopped and counted as broken (default 60).                                                 |
| `queue.tools.node`                           | `node` for the release smoke (default `node`).                                                                               |
| `queue.remote.ssh`                           | ssh destination of the second machine. Without `queue.remote`, the components lane runs locally.                             |
| `queue.remote.workdir`                       | Remote work folder (absolute, or relative to the remote home) holding the git checkout `src/`.                               |
| `queue.remote.pathPrepend`                   | Prepended to the remote PATH (bun first); `~/` means the remote home.                                                        |
| `queue.remote.shards`                        | Vitest shards per remote lane (default `{ "components": 3 }`).                                                               |
| `queue.remote.portBase`                      | First browser port on the remote (default 53700; shard k uses portBase + 2(k-1)).                                            |
| `queue.remote.sshCommand`, `sshOptions`      | Default `ssh` with `BatchMode=yes`, `ConnectTimeout=25`, `ServerAliveInterval=20`, `ServerAliveCountMax=6`.                  |
| `queue.remote.pollSeconds`, `timeoutMinutes` | How often the queue polls a remote run (30) and when it gives up (90).                                                       |

The base branch and remote come from the profile's `defaultBase` (`origin/main`). The heavy lock,
its stale limit and the disk floor are the ws profile's own `lock` and `disk` settings.

GitHub: every API call is `gh api` (the token stays inside gh; the queue never reads or writes
it), and fetches use gh as git's credential helper for that one command
(`-c credential.helper=!'<gh>' auth git-credential`).

## Tests

`bun run test:queue`. Every external action goes through `lib/runner.ts`, so the tests use a fake
runner for gh, ssh and lane processes and real git in temporary repositories: candidate building
and conflicts, the merge step against a fake GitHub that really merges into a bare repository
(tree assertion, stop on mismatch, the head rule, stacked PRs, dry run), the remote tree sync and
its generated script, and the judgement from excerpts of real lane logs (`test/fixtures/`).
