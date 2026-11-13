# Engineering

Code conventions that hold across the repository. Conventions for one area live
next to its code, in that area's `README.md` (for the interface,
`apps/web/README.md`). Design rules live in `docs/design/moss-design-standard.md`
(kept in the private repository).

## Priorities

In order: correct, reliable under failure, fast, simple. Behaviour stays
predictable under load and during failures: session restarts, reconnects,
partial streams. When a trade-off is needed, choose correctness and robustness
over short-term convenience.

## Packages

- `apps/desktop` — the Electron shell. It starts and supervises the server.
- `apps/web` — the React/Vite interface: session UX, conversation rendering,
  client state. It talks to the server over WebSocket.
- `apps/server` — the local server: agent runtimes, sessions, tools, and the
  orchestration events the interface renders.
- `packages/contracts` — shared Effect schemas and TypeScript contracts for
  provider events, the WebSocket protocol, and model and session types.
  Schema-only: no runtime logic.
- `packages/shared` — runtime utilities used by server and web, through explicit
  subpath exports such as `@moss/shared/git`. No barrel index.

## Agent runtimes

Moss hosts many agents. `SUPPORTED_PROVIDER_KINDS` in
`packages/contracts/src/orchestration.ts` lists the active drivers;
`RETIRED_PROVIDER_KINDS` stay only so old events and threads still decode, and
never appear on a runtime, settings or creation surface. Provider code lives in
`apps/server/src/provider/`. Codex sessions run through `codex app-server`
(JSON-RPC over stdio), brokered by `apps/server/src/codexAppServerManager.ts`.
Every runtime's activity is projected into orchestration domain events that the
interface receives on the `orchestration.domainEvent` WebSocket channel.

For every agent CLI: support its latest version, read the agent's own config and
defaults, and never update a person's CLI without telling them. Test runtime
changes with fake CLIs and fake credentials in an isolated profile (the
`run-isolated` skill).

## Server

- No new synchronous file system calls in `apps/server`. Use async fs or Effect
  `FileSystem`. `bun run server-sync-fs:check` (part of `bun run lint`) fails
  when the count grows.
- Background work is interruptible and owned by the server scope, with its timers
  cleared. Anything started at boot that outlives shutdown is a release blocker.
  `apps/desktop/src/backendShutdown.windows.integration.test.ts` must stay green.

## Reuse before you build

Before adding a component, hook, store or helper, search for one that already
does the job and extend it with a prop or variant when it almost fits. When a
second place needs the same shape, extract the shared piece and switch both to
it. Duplicated logic is a defect; so is a local one-off fix where a shared module
is the right home. Write something new only when nothing comparable exists, and
say so in the PR. `apps/web/README.md` names the shared pieces of the interface.

## Files

- New source files start with the repository's header:
  `// FILE:`, `// Purpose:`, `// Layer:`, `// Exports:` (and `// Why:` when the
  reason is not obvious).
- LF line endings. Some scripted edits write CRLF; check before committing.
- Repository documents, comments, commits and PRs are in English, because the
  repository is mirrored publicly. Nothing that identifies the owner or a
  particular machine (names, emails, paths, drive letters, hosts) goes in.

## Tests

- `bun run test` runs Vitest for every workspace. Never `bun test`: it is a
  different runner.
- While working, run only the tests your change affects:
  `bun run --cwd apps/web test <files>`, `bun run --cwd apps/server test <files>`,
  `bun run --cwd apps/web test:browser <file>` for browser tests. Keep workers
  low (`--maxWorkers=1` or `2`) on a shared machine.
- Behaviour that changed gets a test that would have caught the old behaviour.

## Brand

Everything a person can see is Moss: the name and the coral pinwheel
(`apps/web/public/moss-logo-coral.png`, or `MossLogoMark` where that file is not
served). Never add upstream product names or marks. Look at new or merged-in UI
as well as reading its code: a Moss-named file can still hold an old drawing.
`bun run brand:check` runs inside `bun run lint`; never widen its exceptions for
anything a user can see.

## Commits and PRs

Commit messages end with a `Co-Authored-By:` line for the model that wrote the
code, and the PR description says who wrote it. One PR carries one change.

## Invariants kept by patches

Some behaviour depends on patched dependencies (`patches/`) and on rules that are
easy to undo by accident. Keep them when you upgrade or refactor.

- **`@pierre/diffs`.** The patch refreshes file-editor rows after line insertions
  and deletions. Before removing it on an upgrade, verify repeated Enter,
  subsequent typing, undo and redo with
  `bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.browser.tsx`.
- **`@effect/platform-node-shared`, process signals.** The patch preserves
  Windows spawn options and rejects invalid PIDs before converting child handles
  into process-group signals. Windows group cleanup launches `taskkill` directly
  with `windowsHide: true`, so teardown does not open a console beneath the
  desktop app. Valid groups may outlive their leader; cleanup must still reach
  those descendants. After updating Effect, run
  `apps/server/src/platform/effectProcessSignals.test.ts` against the installed
  runtime, including its Windows cases.
- **`@effect/platform-node-shared`, writable streams.** The same patch makes
  writable stream errors fail the owning Effect sink, waits for accepted writes
  before completing, and removes drain and finish listeners on cancellation.
  Pending writes keep an error listener until they settle, so a late broken pipe
  cannot become an uncaught exception. Keep source and compiled runtime changes
  together and run `apps/server/src/platform/effectWritableSink.test.ts`.
- **Process-tree teardown** captures POSIX start times and Windows creation times
  to check descendants during delayed cleanup and exit verification. They add
  evidence to the command-line comparison; they are not proof of PID ownership
  (POSIX start times have second resolution, and observing then signaling is not
  atomic). Root signaling still requires the caller to own the live process.
  Cancelling a directly owned child must work even without process-table tools.
- **`ELECTRON_RUN_AS_NODE`.** Desktop stdio MCP proxies reuse Electron's
  executable and must set `ELECTRON_RUN_AS_NODE=1` in their own launch
  configuration. Provider child environments strip the inherited flag, so relying
  on inheritance launches the desktop GUI instead of the proxy. Keep the provider
  environment filtering intact.
- **Database lifecycle lock.** The lock publishes its owner metadata atomically.
  Startup may recover an empty lock directory, or one holding only Finder's
  `.DS_Store`. It must preserve live owners, malformed owner metadata, links and
  unrecognised files. An unknown owner is not proof of another running server;
  the desktop lock dialog offers **Open logs** to inspect the error. Never remove
  a populated lock to work around a startup block
  (`apps/server/src/persistence/DatabaseLifecycleLock.ts`).
