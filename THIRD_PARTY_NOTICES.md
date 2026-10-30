# Third-party notices

## Visual replies from T3 Code

Moss's inline HTML pages (`html_render`) are adapted from T3 Code's Visual replies.

- Source: https://github.com/pingdotgg/t3code
- First port: ba0ea3d152150f399827d36a5b4b86c5bbda2d7f (2026-10-07), with #15968, #16283 and #16752
- Synced to: 08a463e29976617134de01e9341f898bc881d0eb (2026-10-29), absorbing #17561, #18897, #18898, #20036, #22131, #23745, #24850 and #25456
- License: MIT. Copyright (c) 2026 T3 Tools Inc.

Carried over with only the renames Moss needs (product name, palette constant names, the bootstrap element ids `moss-theme` and `moss-link-`, and the `moss/notifications/*` bridge methods):

- `packages/shared/src/htmlRender.ts` and `packages/shared/src/htmlRender.test.ts`, including the full-height frame fit, the 8px focus-ring gutter, and the link, image, and shortcut bridge
- the color roles and stock palette values in `packages/shared/src/themePalettes.ts`
- the image inlining, viewport-height rejection, headless preview, height measurement, and page storage in `apps/server/src/htmlRender/HtmlRender.ts`
- the sandboxed frame and its single frame-message listener in `apps/web/src/components/chat/SandboxedHtmlDocument.tsx` (re-exported as `HtmlRenderDocument.tsx`)
- the shorter agent tool copy in `apps/server/src/agentGateway/htmlRenderTools.ts`

Moss-only adaptations, because this repository does not have the upstream pieces they plug into:

- `html_preview` uses a Moss-owned Chromium headless shell installation and a T3-derived SOCKS public-network proxy. The browser is stored in Moss data, never chosen from a user's installed browsers; the first preview installs it on demand and waits for that installation to finish.
- Moss records published pages as activities because providers do not share T3's single tool-result shape. This is intentionally server-owned and independent of how a provider renders tool rows.
- Attachment and native-visualization pages use T3's response CSP. Both inline `html_render` and panel document iframes use the narrower `allow-scripts allow-forms` sandbox, so panel documents cannot open popup contexts.
- Only desktop attachment URLs, which carry a desktop startup token, are replaced with a short-lived per-attachment signature. Web-mode attachment URLs have no token and remain unsigned; panels refresh a signed desktop URL before loading, viewing source, or saving.
- Visual replies open in Moss's right dock rather than T3's full-screen dialog, so T3's zoom steps (50% to 200%) live in the dock's `HtmlRenderPreviewPane.tsx`.
- Page links open like Moss chat links (`linkContextMenu.ts`), page images open in Moss's image viewer, and the shortcuts a page may forward are Moss's own view commands (`apps/web/src/lib/htmlRenderShortcuts.ts`), matched with Moss's key alias table in `packages/shared/src/keybindingRules.ts`.
- Not carried over: T3's mobile, guest-sharing, MCP-app, and Antigravity ACP changes, which have no Moss counterpart, and its headless-Chrome launch reporting, since Moss previews through Playwright. Moss already hands pages sRGB theme colors (T3 #16325) and emulates the preview appearance (T3 #24521).

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Offline visualization libraries

Codex inline visualizations can reference a small set of familiar public CDN URLs. Moss may rewrite them to the following checked-in browser assets under `apps/web/public/inline-visualization-libs/` as a harmless offline optimization; visual replies are not required to depend on network blocking.

- D3 7.9.0 — ISC License, Copyright 2010-2024 Mike Bostock.
- three.js r182 — MIT License, Copyright 2010-2026 three.js authors.
- Chart.js 4.5.1 — MIT License, Copyright 2026 Chart.js Contributors.
- Inter Variable 4.1 — SIL Open Font License 1.1, Copyright 2020 The Inter Project Authors.
- JetBrains Mono Variable 2.304 — SIL Open Font License 1.1, Copyright 2020 The JetBrains Mono Project Authors.

The package metadata in `node_modules` contains each upstream license text; the assets are copied without modification except for bundling format.

## CC Switch

Moss includes a modified provider-preset implementation and a dependency-free
Messages/Responses ↔ OpenAI Chat Completions dialect bridge derived from the
conversion behavior in [CC Switch](https://github.com/farion1231/cc-switch).
The CC Switch application and proxy are not shipped, installed, or required at
runtime.

MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Synara inline visuals (absorbed)

Portions of the structured inline-visual pipeline (component spec, formula parser,
store, gateway tool, and transcript helpers) are adapted from Synara PR #1874
(https://github.com/Emanuele-web04/synara/pull/1874, MIT) and its Stable promotion in
PR #1932 (https://github.com/Emanuele-web04/synara/pull/1932, MIT). Moss renames the
model-facing tool to `moss_show_visual` and offers it to every gateway CLI. Component
specs render with the app's own components. Agent HTML from that tool runs only in
the desktop app, with a sandbox and a content security policy that blocks network
loads. The separate OpenUI and T3 `html_render` path is unchanged and can reach the
network.

## OpenUI Lang and open-intelligent-ui components (absorbed)

Moss uses OpenUI Lang and selected browser-only components adapted from
`thesysdev/open-intelligent-ui` (https://github.com/thesysdev/open-intelligent-ui),
including the six-chart renderer, KaTeX math, SVG primitives, component-cell
tables, and local working-tool functions. The upstream project and OpenUI
packages are MIT licensed; the notice below covers the copied source in
`apps/web/src/lib/openui/`.
The adapted components and functions match upstream as of
16ef26475999e3a021a50b1607a03717c0721255 (2026-10-26), which has not changed them since
6a4a0ba192ea285b3a5ed39dcc1295d7d4080d6f (2026-10-15). The OpenUI packages are
`@openuidev/lang-core` and `@openuidev/react-lang` 1.0.2, `@openuidev/react-ui` and
`@openuidev/react-headless` 0.18.1.

MIT License

Copyright (c) 2026 Thesys Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Cua driver (computer use)

The macOS computer-use driver is built from `trycua/cua` (https://github.com/trycua/cua) at the commit pinned in `packages/shared/src/cuaDriverRelease.json`, with Moss's patches in `apps/desktop/patches/cua-driver/`. The upstream license ships with the driver from `docs/computer-use-cua/CUA-LICENSE.txt`.

- License: MIT. Copyright (c) 2025 Cua AI, Inc.

## idb (iOS Simulator input)

The Indigo HID message layout and the two-payload touch message in `apps/server/native/device-helper/Sources/HIDBridge.h` and `HIDBridge.m` are ported from `FBSimulatorIndigoHID` in `facebook/idb` (https://github.com/facebook/idb).

- License: MIT. Copyright (c) Meta Platforms, Inc. and affiliates.

## OpenAI Codex CLI

Desktop builds bundle the Codex CLI. Each bundled release has its license, notice, source pointer, and the licenses of its own dependencies under `third_party/openai-codex/<version>/`.

- License: Apache License 2.0. Copyright 2025 OpenAI. See each version's `LICENSE` and `NOTICE`.

## Tabler Icons

UI icons from `@tabler/icons-react`. In the open-source build, the icon folders under `apps/web/public/central-icons-*` hold Tabler Icons SVGs (stroke width changed to 1.5) in place of the commercially licensed set that official builds use.

- Source: https://github.com/tabler/tabler-icons
- License: MIT. Copyright (c) 2020-2026 Paweł Kuna.
