# UI SDK WebMCP test fixture

A project-settings page built with UI SDK, used only by Moss's tests of its in-app
browser WebMCP host (`apps/desktop/scripts/browser-webmcp-smoke.ts`). Moss does not
depend on UI SDK and ships none of this in the app.

- Upstream: UI SDK, https://github.com/vercel-labs/ui
- Packages bundled into `dist/main.js`: `@ui-sdk/web` and `@ui-sdk/core`, both
  `0.1.0-beta.6` (pinned), built with esbuild `0.25.0`:
  `npx esbuild source-main.js --bundle --format=esm --outfile=dist/main.js`
- Licence: Apache License 2.0, copy in `LICENSE`. The bundle is unmodified build output.
- `source-main.js` and `index.html` were written for Moss (2026-11-17); `index.html`
  drops the upstream stylesheet link so the page needs no network.
- `source-main.js` installs a stand-in `document.modelContext` only when the browser
  has none. Inside Moss's in-app browser, Moss's own WebMCP bridge is used.
- `?raf=timer` swaps animation frames for timers. Moss's tests do not use it: they
  check that a call completes with real frames while the guest is hidden.

SHA-256 (2026-11-17):

| File | SHA-256 |
|---|---|
| `dist/main.js` | `d79383cab433097bfaf933278ecb04cf0c74bfb554d4ab21c95d86ab1c924050` |
| `index.html` | `65eb0f65f8c78f8e24f1fa7a2bc94e454eaded3d3dfb58f248f7be52a362cfd3` |
| `source-main.js` | `f28a8693e9c1172a8e4572b81380df7daecdb16d9690a5e889555e29edd1eedf` |

Update by rebuilding from pinned versions, replacing these files together, and
running `bun run --cwd apps/desktop smoke:browser-webmcp`.
