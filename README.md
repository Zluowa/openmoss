# Moss

[![CI](https://github.com/Zluowa/openmoss/actions/workflows/ci.yml/badge.svg)](https://github.com/Zluowa/openmoss/actions/workflows/ci.yml)

A desktop workspace for coding agents. Run Codex, Claude, Cursor, Gemini, Antigravity, Grok, OpenCode, Pi, Hermes, Devin, and OMP side by side, with each project's threads, diffs, terminal, browser, and Git tools in one window.

[Download](https://trymoss.com) · [Report an issue](../../issues/new/choose) · [Contributing](CONTRIBUTING.md)

> Moss is early software. Interfaces and APIs still change often.

## What's in this repository

| Path                 | What it is                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `apps/desktop`       | Electron shell.                                                                           |
| `apps/server`        | Local Node.js server. It runs each provider's agent runtime and streams events to the UI. |
| `apps/web`           | React UI, served by the local server or loaded by the desktop shell.                      |
| `packages/contracts` | Shared schemas for provider events, the WebSocket protocol, and model and session types.  |
| `packages/shared`    | Runtime utilities used by both server and web.                                            |

The hosted Moss services (accounts, hosted models, payments) are not part of this repository. Moss runs without them: bring your own provider logins and API keys.

## Build from source

You need [Bun](https://bun.sh) 1.4.4 and Node.js 24.13.1 (see `.mise.toml`).

```sh
bun install
bun run dev            # server + web UI in your browser
bun run dev:desktop    # Electron app
```

Before sending a change, run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Open-source build and official builds

Official Moss builds use a commercially licensed icon set. This repository ships [Tabler Icons](https://tabler.io/icons) (MIT) under the same names, and neutral placeholders for a few decorative images, so the UI looks slightly different from the app you download.

## License

[MIT](LICENSE). Moss started from [T3 Code](https://github.com/pingdotgg/t3code) and [Synara](https://github.com/Emanuele-web04/synara), both MIT. Third-party code and assets are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
