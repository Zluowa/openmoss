---
name: run-isolated
description: Use whenever you start Moss (dev server, web, desktop or a packaged build) or run tests that start it - isolate homes, ports and agent data so nothing touches the owner's real profile.
---

# Run Moss isolated

## When to use

Every time you start Moss to look at or test a change: dev server and web, the
desktop app, a packaged build, or tests that launch any of them. There is no
exception for "just a quick look".

## Inputs

From the machine profile: your run folder root, your port offset and
browser-test port, where bun lives, the global npm folder to drop from `PATH`,
and the read-only check that proves the owner's agent data was not touched.

## Steps

1. Make a run folder for this task, `<run root>/<task>/`, with subfolders for
   each home below. Never the system temp folder, never the owner's profile.
2. Point every home at it:
   `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `MOSS_HOME`,
   `MOSS_DESKTOP_USER_DATA_DIR`, `CODEX_HOME`, `CODEX_SQLITE_HOME`,
   `CLAUDE_CONFIG_DIR`.
3. Turn off what writes outside the run folder:
   `MOSS_DISABLE_SHELL_ENVIRONMENT_SYNC=1`, `MOSS_DISABLE_SHORTCUT_ICON_SYNC=1`,
   `MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION=1`, `MOSS_DISABLE_PROVIDER_UPDATES=1`.
   Remove the global npm folder from `PATH`. Unset `MOSS_AUTH_TOKEN`,
   `CLAUDE_CODE_CHILD_SESSION` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
4. Use fake agents only: stub agent CLIs and fake credential files inside the run
   folder, a local stub gateway, fake keys. Never copy real credentials.
5. Dry-run the dev runner with your offset, then start it the same way without
   `--dry-run`:
   `MOSS_PORT_OFFSET=<offset> bun run dev -- --home-dir <run folder>/moss-home --no-browser --dry-run -- --env-mode=loose`
   It prints the server and web ports it will use. `bun run dev:server`,
   `dev:web` and `dev:desktop` take the same flags.
6. Or start the two halves directly, with explicit ports:
   server, from the folder you want as the workspace:
   `MOSS_HOME=<run folder>/moss-home MOSS_PORT=<server port> MOSS_MODE=web MOSS_NO_BROWSER=1 VITE_DEV_SERVER_URL=http://localhost:<web port> bun <repo>/apps/server/src/index.ts`;
   web: `PORT=<web port> VITE_WS_URL=ws://localhost:<server port> bun run --cwd <repo>/apps/web dev`.
7. Look at it headless: a headless browser pointed at the web port (Playwright is
   a dev dependency of `apps/web`), or `webContents.capturePage()` for a desktop
   window. A desktop window you start stays hidden or off-screen and never takes
   focus.
8. Stop everything you started, matching your own ports and run-folder paths.
9. Run the read-only check from the machine profile and confirm the owner's real
   agent data gained nothing from your run.

## Checks

- The dry run prints your offset as its source and ports that are not the
  defaults (3773 and 5733).
- After stopping, nothing listens on your ports.
- The read-only owner-data check shows no change.

## Output

For the report: the ports and run folder used, what you looked at, and the
result of the owner-data check. Screenshots go on the PR.

## Traps

- Turbo's strict env mode drops variables such as `CODEX_SQLITE_HOME`, so
  `bun run dev` without `-- --env-mode=loose` can quietly use the owner's data.
- The user environment may inject `CODEX_HOME`, and Moss's shell-env sync merges
  it again. Set it explicitly and keep the sync disabled.
- Copying a real refresh token logs the owner out when it rotates.
- Never run an installer. Packaged builds are tested from an extracted copy.
- `MOSS_DISABLE_PROVIDER_UPDATES=1` makes the provider-health upgrade tests fail;
  leave it unset for those tests only.
- Without `VITE_DEV_SERVER_URL` on the server, the WebSocket handshake from the
  web origin is rejected with 403 (`apps/server/src/trustedOrigins.ts`).
- The project picker lists top-level folders of `HOME`, so put test repositories
  inside the isolated `HOME`.
- Browser tests take their port from `VITEST_BROWSER_API_PORT`; use your own.
  On Windows, port 51101 is reserved.
- If the UI shows no threads, check the server before touching SQL: inspect the
  isolated `state.sqlite`, then call `orchestration.getSnapshot` over the
  WebSocket. A healthy snapshot means the problem is the client connection.
- Kill only processes whose command line contains your own paths or ports,
  never "everything started after" some time.
- Real-screen testing with the owner's own signed-in session happens only when
  the owner asked for it in that session. Even then: no new sign-ins, passwords,
  payments or settings changes, and stop if the owner is using the machine.
- `library-panel.md` in this folder shows how to reach the hub Library panel in
  an isolated instance.
