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

## Database migrations

Migrations live in `apps/server/src/persistence/Migrations.ts` and are only ever
appended: never renumber, rename or edit one a release shipped
(`bun run migrations:check`, the "Migration Lineage" CI job).

**Going back a version.** A person who installs a newer Moss and then goes back
to an older one must still be able to start it. The database records a reader
floor in SQLite's `PRAGMA user_version`: the lowest migration a build must know
to open the database, together with the newest migration it was written for.
Every start that finds the database at exactly its own newest migration writes
its floor if the stored one differs, so a start that committed its migrations
and then stopped is repaired by the next one.

An older build opens a database with migrations it does not know only when the
floor was written for the database's newest migration and is at or below the
older build's own newest migration. Otherwise it shows "This database is newer
than Moss", as before. The floor admits every build at or above it, not only
the previous release: a database with two releases' additive migrations opens
in the oldest build the floor names.

**Declaring a migration additive.** A new migration raises the floor unless you
add it to `MIGRATIONS_OLDER_READERS_MAY_IGNORE`. List it there only when all of
these hold.

1. **It only adds things an older build never touches:**
   - a nullable column on an existing table, or one with a constant default;
   - a new table, or a non-unique index.

   On an existing table, none of these are allowed:
   - a UNIQUE or partial-unique index, because an older build's INSERT can fail on it;
   - a trigger, because older writes would then do more than they did;
   - a NOT NULL column without a default, because older INSERTs fail;
   - a foreign key into the table from a new table or column, unless it is
     `ON DELETE CASCADE` or `SET NULL`, because with `foreign_keys = ON` an older
     build's DELETE can fail.

   It also drops, renames and rewrites nothing that existed. A backfill may only
   set the columns it adds.

2. **Older code works without it, and its writes keep it intact.** Projection rows
   are updated by named columns, never by `INSERT OR REPLACE` or by delete and
   re-insert. Anything stored only in the new column can be rebuilt from events.
3. **Older code can still read every event the new code writes.** A new optional
   field on an existing event is fine. A new event type, a new value in an enum
   an older decoder knows, or a field an older decider requires is not.
4. **The new code reconciles rows the older build wrote, on every start.** Nothing
   records that an older build opened the database. Example: the older build
   keeps updating `lastKnownPr` while the new list of linked pull requests goes
   stale, so on every read the new build compares the two and takes the older
   build's value.

`checkAdditiveMigration` enforces rule 1 for every migration on the list, in
`MigrationReaderFloor.test.ts`, and names the rule a migration breaks. Rules 2 to
4 are the author's claim; the tests below show them.

The list is an unbroken run at the end of the migrations, and the floor is the
migration just before it. When a migration that is not additive lands after
additive ones, it raises the floor to itself: empty the list, and let later
additive migrations start a new run. If any rule is in doubt, leave the
migration off the list. Older versions then refuse the database with the usual
dialog, which is safe.

**Test it.** Every additive migration gets a test against the floor release,
which is the oldest build the floor admits, with every additive migration above
the floor applied together:

1. Migrate with `runMigrations()`.
2. Open the database with `runMigrationsAsFloorRelease()` from
   `persistence/migrationReaderFloorTesting.ts`. Use `runMigrationsAsRelease(id)`
   for any release in between.
3. Run that release's writes against the database.
4. Check the reconciliation when the new build starts again.

`persistence/MigrationReaderFloor.test.ts` shows each step, including a
database two newer releases migrated, opened by the floor release.

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
  Cancelling a directly owned child must work even without process-table tools:
  on Windows, when `taskkill /T` did not end the root (it timed out or could not
  run), teardown ends it through the owned child handle, never by PID.
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
