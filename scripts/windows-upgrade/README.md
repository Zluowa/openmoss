# Windows upgrade validation adapter

This slice provides the fail-closed capability orchestrator, native probe source
and fake-child tests. Native probes have not been executed. The capability-only
CLI is pending independent review and is not connected to any workflow. It does
not download, install, start or upgrade Moss. Tests explicitly inject fake launchers.

Run the fake-only checks through the repository's existing scripts test entry:
`bun run --cwd scripts test windows-upgrade/core.test.mjs windows-upgrade/owned.test.mjs --no-cache`.
They use Vitest so the normal scripts/full-repository collector runs the same
tests. Every process launcher in those tests remains explicitly fake; collecting
the tests never invokes the native CLI entry point.

On the reviewed public hosted runner only, collect evidence with:

```sh
node scripts/windows-upgrade/cli.mjs --mode host --root D:/a/_temp/moss-upgrade-probe
```

This mode creates no directories or fixtures and returns `status: observed`.
It cannot authorize installation or satisfy upgrade acceptance. After reviewing
actual host evidence, request owned fixtures explicitly:

```sh
node scripts/windows-upgrade/cli.mjs --mode fixtures --root D:/a/_temp/moss-upgrade-probe --opt-in allow-ephemeral-fixtures
```

The root must not exist. The hardcoded expected service path, session, compiler
path and UI controls are unverified assumptions; mismatches fail for review.
No input can opt into installing Moss through this CLI.

## Capability adapter contract

Every capability must return `{ status: "passed" }` only after observing its result.
Missing, skipped, failed, rejected, timed-out and closed RPC results all fail.
Cleanup runs on both success and failure, with its own hard deadline. Adapters
must listen for abort and cancel their in-flight work; the timeout wrapper alone
does not forcibly terminate a noncooperative external process.

1. `host`: read native CIM OS build/product type, user/session, runner executable
   path, image version and temporary path. Check free space before downloading.
   The source native adapter returns `observed` only. Observation cannot pass the
   preflight orchestrator. Actual hosted facts must be reviewed before adding a
   fixture run; installation has a separate explicit opt-in outside this CLI.
   Apply both `runnerContract` and `fixtureContract`. Environment variables
   alone do not establish a disposable VM. A change to runner layout fails for
   review; never weaken the gate automatically. The exact hosted service path and
   interactive session are intentionally unverified until the first remote probe.
2. `window`: create an owned native fixture window, verify a nonzero HWND and
   enumerate it through UIAutomation. Invoke its fixture button and read back an
   observable effect. A process starting is insufficient.
3. `nsis`: compile a small NSIS fixture with no application file/registry install
   instructions using the runner's compiler; verify its owned window, enumerate
   and invoke its Close control, verify exit. It does not yet prove the real
   update installer's Install transition or full UI sequence is drivable.

`cdp` is a separate post-install stage, excluded from the pre-install fixture
preflight: after authentic initial installation, launch the original installed
Electron binary with a unique loopback CDP port and isolated profile; connect,
evaluate a renderer expression, close cleanly. No patched asar or fixture
Electron can stand in for this check.

Native fixture roots must be new and direct children of the fixed runner temp
directory; all existing ancestors are checked for reparse points before writes.
Node is the sole process creator. Helpers never spawn other processes. Every
PowerShell helper and window fixture immediately emits an allowlisted identity
handshake; compiler and NSIS identities are read by a directly owned helper.
Node records each PID, creation ticks and expected executable, then obtains fresh
native identity before requesting window close and again before individual forced
termination through its owned child handle. It waits for the child's close event.
No Job-object termination or parent-PID process-tree cleanup is used. If handshake,
inspection or identity fails, termination is refused and cleanup is reported
incomplete. No green result is possible with unresolved children. A helper used
for cleanup can itself fail; that leaves explicit unresolved records instead of
recursively launching unbounded cleanup probes. Forced OS termination of Node
itself cannot promise cleanup; this remains a disposable-VM tool.

SIGINT/SIGTERM and stage deadlines enter the same cleanup path. Each helper has a
15-second deadline, and each owned process close has a separate bounded wait.
After requesting UIA close, cleanup allows 750 ms for normal asynchronous exit
before obtaining another identity sample and considering individual termination.
Cleanup has no global aggregate budget yet; failures or hung inspection helpers
remain explicit unresolved records. Fixture execution is not approved for CI.
Normal output is one JSON report with `observed` or scoped fixture `passed` plus
cleanup state; failures use exit 1 and sanitized JSON. No stderr from native tools
is copied into evidence. Host mode is a collection result, not a passed gate.
Reports identify the fixed current stage (`host`, `fixture-gate`, `fixture-paths`,
`window`, `nsis-compile`, `nsis`, `completed`, `cleanup`, or prelaunch `guard`),
script hashes and observed owned-process identities, without raw command lines.
Children use ten isolated profile paths (including TMP, Moss, Codex and Claude),
four product disable flags, a system-only PATH and no inherited auth/provider
environment. This is capability-only; real packaged Moss is still unverified.

Only directly created child handles and explicitly recorded process identities
may be cleaned up. A discovered NSIS process requires verified executable path,
creation time, expected arguments and the observed updater launch relationship;
PID/parent PID alone is insufficient. Recheck before individual termination.
Never use process-tree killing. Sanitized child environments are allowlisted.
Never upload whole profiles, installer binaries, URLs with query strings or raw
provider logs. Evidence consists of allowlisted statuses, hashes, synthetic data
counts and reviewed fixture screenshots.

## Subsequent upgrade driver and workflow

The `windows-upgrade-host-capability.yml` is derived into the public mirror
from the source workflow. It runs only host evidence collection, only in the
public repository on `windows-2022`, with a five-minute job limit and read-only
repository permission. Checkout does not persist credentials. Only the two JSON
evidence files are uploaded for seven days. A green collection job means only
that host evidence was collected, never that fixtures or upgrade passed. The
workflow must be independently reviewed before it is exported or dispatched.
Dedicated `ci/nsis-host-*` pushes also collect host evidence, enabling reviewed
candidate testing before the new manual workflow exists on the default branch.
Ordinary `ci/*`, main and PR events do not trigger this workflow. The job and run
step independently enforce the public repository and the dispatch/dedicated-push
event boundary; neither trigger authorizes fixtures or application installation.

Keep one 60-minute job on `windows-2022`, with stage deadlines and independent
RPC deadlines. Source workflow changes belong in the existing private CI source;
extend the public-mirror derive job allowlist and exported file list only after
review. Use `contents: read`, checkout `persist-credentials: false`, no secrets,
no release writes and explicit candidate/manual selection. Ordinary PRs must not
download large installers. An unselected job is not product acceptance.

Freeze the published 1.0.3 installer SHA before implementing download. Verify the
original installer and real installed exe/asar, registration and exit evidence.
Initial `/S` is allowed; original updater install is non-silent and must remain
`desktopBridge.installUpdate()` with the original no-argument `quitAndInstall()`.
Create synthetic local data, close normally, record content hashes/counts and
database integrity. The installed 1.0.3 must discover/download through its original
GitHub update bridge. Abort on version drift instead of changing the feed.
Observe download errors even when status returns to available; preserve the
original ten-minute download budget and never prefill its cache.

Before updating, require version 1.0.5, 715081212 bytes, manifest SHA512 and SHA256
`c8a0302dd0cee5cf97ab5cccf68764a3e7bc5eef26bfbc6a4d75e5d5ca3f08d3`.
Observe original old-process exit, owned non-silent NSIS window transitions,
installer exit, installed identity/version, fresh renderer/backend readiness and
synthetic data equality. Close/restart once more and repeat data checks. None of
these terminal states may be inferred merely from the old process exiting.

No real provider account, token, model request or owner profile is involved.
Capability success is expressly distinct from upgrade/data-preservation success;
hosted Server 2022 success cannot replace Windows 11 or real-account acceptance.
