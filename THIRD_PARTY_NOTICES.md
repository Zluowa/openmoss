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
- the Mermaid diagram renderer in `apps/web/src/components/chat/MermaidDiagram.tsx` (at 8657eecb, with the expanded-diagram fit from #27519) and the `--pele-*` theme variables

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

- D3 7.9.0 — ISC License, Copyright 2010-2023 Mike Bostock. Full text: `apps/web/public/inline-visualization-libs/d3.LICENSE.txt`.
- three.js r182 — MIT License, Copyright © 2010-2025 three.js authors. Full text: `apps/web/public/inline-visualization-libs/three.LICENSE.txt`.
- Chart.js 4.5.1 — MIT License, Copyright (c) 2014-2024 Chart.js Contributors. Full text: `apps/web/public/inline-visualization-libs/chart.LICENSE.txt`.
- Inter Variable Latin normal wght, packaged as `@fontsource-variable/inter` 5.2.8 — SIL Open Font License 1.1. Full text: `apps/web/public/inline-visualization-libs/inter.OFL.txt`.
- JetBrains Mono Variable Latin normal wght, packaged as `@fontsource-variable/jetbrains-mono` 5.2.8 — SIL Open Font License 1.1. Full text: `apps/web/public/inline-visualization-libs/jetbrains-mono.OFL.txt`.

These complete license texts are copied from the exact installed packages alongside the static assets and are included in web/desktop distributions. The assets are copied without modification except for bundling format.

Application-page module analysis vendors es-module-lexer 3.0.3 (minimal asm.js build), Copyright (C) 2018-2022 Guy Bedford, under the MIT License. Full text: `apps/server/src/pages/apps/vendor/es-module-lexer.LICENSE.txt`; the server bundle also retains this complete notice in its owning code chunk.

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
The dashboard components in `apps/web/src/lib/openui/oiuDashboard*.tsx` are adapted from the OpenUI
dashboard kit (`packages/kits/dashboard`, `@openuidev/dashboard-kit` 0.0.1) in
thesysdev/openui (https://github.com/thesysdev/openui) at 9f01894 (2026-11-02), MIT License,
Copyright (c) 2011-2024 Thesys Inc.; the MIT license text below applies to them as well.

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

## Open Intelligent UI (absorbed)

Moss's visual follow-ups, maps, trip itineraries, place photos, and visual guide are adapted from Open Intelligent UI by CopilotKit (https://github.com/CopilotKit/OpenIntelligentUI) at 8391a94 (2026-10-13).

- `packages/shared/src/tripAnimator.ts` adapts `trip-animator.ts`, shipped as plain script source.
- `apps/server/src/agentGateway/placePhotoTools.ts` adapts `trip_images.py`, with the article language added.
- `apps/server/src/agentGateway/visualGuideTool.ts` adapts the master-playbook, advanced-visualization, and svg-diagrams skills to Moss's tools and theme variables.
- `window.mossFollowUp` follows the upstream `sendPrompt` bridge, sent as an MCP Apps `ui/message` and put in the composer instead of starting a turn.

Not carried over: the CopilotKit runtime and AG-UI transport, the A2UI table renderer (Moss uses OpenUI tables), the visualization router (it sends the conversation to an outside service), the Python agent, the streamed sandbox renderer, the browser key dialog, and telemetry. Moss draws maps through its own `window.mossMaps` helper instead of the upstream map setup: Amap or Google Maps for the reader's account when a key is set, otherwise the libraries below with the OpenFreeMap basemap, or a plain map for mainland China accounts.

The MIT License

Copyright (c) Atai Barkai

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

## CopilotKit standard generative-UI catalog (adapted)

The standard-catalog additions to Moss's OpenUI visual language (`apps/web/src/lib/openui/oiuStandard.tsx`, `oiuStandardViews.tsx` and `oiuStandardControls.tsx`) adapt the component set, semantics and descriptions of the standard generative-UI catalog in CopilotKit (https://github.com/CopilotKit/CopilotKit, `packages/react-core/src/v2/generative-ui/standard`) at 180a2f0 (2026-11-04): Grid, Flow, Spacer, Blockquote, ShimmerText, Link, Tooltip, SegmentedControl, DateTimeInput, Pressable, Favicon, Video, AudioPlayer, PulseIndicator, FlashcardFlip, Popover, LinkCard, Citation, EntityCard and ImageGrid. CitedText and DefinedText are Moss's own.

Moss writes them as OpenUI Lang components with positional arguments, draws them with its own theme tokens and Base UI primitives, and routes links and follow-ups through its OpenUI action handling. Not carried over: the A2UI renderer and surface runtime, components Moss already has under its own names, Map (maps are html_render pages), HtmlView (raw HTML is html_render), and the third-party favicon service (Moss asks the site for its own /favicon.ico).

The MIT License

Copyright (c) Atai Barkai

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

## Map libraries for html_render pages

Pages that draw a map get these libraries inlined from `packages/shared/src/htmlRenderMapAssets.generated.ts` (regenerated by `scripts/generate-html-render-map-assets.ts` from the npm releases named below), so no map script comes from a CDN. The basemap is OpenFreeMap (https://openfreemap.org/, terms https://openfreemap.org/tos/): map data © OpenStreetMap contributors (ODbL, https://www.openstreetmap.org/copyright) and © OpenMapTiles (https://www.openmaptiles.org/), credited on every map.

### Leaflet 1.9.4 (npm `leaflet`, https://leafletjs.com, BSD-2-Clause)

```text
BSD 2-Clause License

Copyright (c) 2010-2023, Volodymyr Agafonkin
Copyright (c) 2010-2011, CloudMade
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### MapLibre GL JS 5.24.0 (npm `maplibre-gl`, https://maplibre.org, BSD-3-Clause)

```text
Copyright (c) 2023, MapLibre contributors

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of MapLibre GL JS nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


-------------------------------------------------------------------------------

Contains code from mapbox-gl-js v1.13 and earlier

Version v1.13 of mapbox-gl-js and earlier are licensed under a BSD-3-Clause license

Copyright (c) 2020, Mapbox
Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of Mapbox GL JS nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


-------------------------------------------------------------------------------

Contains code from glfx.js

Copyright (C) 2011 by Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

--------------------------------------------------------------------------------

Contains a portion of d3-color https://github.com/d3/d3-color

Copyright 2010-2016 Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### maplibre-gl-leaflet 0.1.4 (npm `@maplibre/maplibre-gl-leaflet`, https://github.com/maplibre/maplibre-gl-leaflet, ISC)

```text
Copyright (c) 2021 MapLibre contributors

Copyright (c) 2014, Mapbox

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

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

## OpenMausBot (Mossbot group chats, adapted)

Mossbot's group-chat mention grammar and routing, room member picker, sequential speaker queue, room layout and conversation-section components adapt OpenMausBot. Moss supplies its own artwork, execution, persistence and permissions. The adapted files and changes are listed in `third_party/openmaus/NOTICE.md` and `third_party/openmaus/UI-PORTS.md`.

- Source: https://github.com/milind-soni/OpenMausBot/tree/58378e85449ca49f3370d72e6c70cece4fee413f
- License: Apache License 2.0. Copyright 2026 Milind Soni and OpenMausBot contributors.

The upstream NOTICE file, reproduced in full as the license requires:

```text
OpenMausBot
Copyright 2026 Milind Soni and OpenMausBot contributors

OpenMausBot was relicensed from the MIT License to the Apache License,
Version 2.0, with the consent of all contributors whose copyright was
incorporated before the transition.

The Google Antigravity ACP integration adapts release, installation, profile,
authentication, and runtime temporary-folder behavior from T3 Code, Copyright
2026 T3 Tools Inc., used under the MIT License (third_party/t3-code/LICENSE).

Selected-text citation matching adapts T3 Code's assistant citation selection,
Copyright 2026 T3 Tools Inc., used under the MIT License.

The egress gate for the bots' browser (server/browser/egress/) adapts T3 Code's
public-only SOCKS5 proxy for HTML previews and the Linux listener-ownership
scan of its preview port scanner, Copyright 2026 T3 Tools Inc., used under the
MIT License (third_party/t3-code/LICENSE).

Prompt-cache keep-warm (server/cache-keepwarm.ts and
server/drivers/claude-keepwarm.ts) ports the design of Cache Tax,
https://github.com/karanb192/claude-code-mods, Copyright (c) 2026 Karan
Bansal, used under the MIT License (third_party/cache-tax/LICENSE).

Moving a Grok Bot (shared/grok-import.ts and server/grok-local.ts) adapts the
export message, reader repairs, credential refusal and desktop cache reading of
the agent-importers plugin in hermes-official-plugins,
https://github.com/NousResearch/hermes-official-plugins, Copyright (c) 2026
Nous Research, used under the MIT License: Permission is hereby granted, free
of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the
following conditions: The above copyright notice and this permission notice
shall be included in all copies or substantial portions of the Software. THE
SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The secure phone credential transport uses @hpke/core and @hpke/common from
hpke-js, Copyright 2023-2024 Ajitomi Daisuke, used under the MIT License.

The Android companion app bundles a prebuilt WebRTC library for Live calls
(io.github.webrtc-sdk:android), built from the WebRTC project, Copyright (c)
2011, The WebRTC project authors, used under the BSD 3-Clause License. WebRTC
includes third-party components under their own licenses, listed with the
library.

Selected provider icon paths are from Simple Icons, used under CC0 1.0.
The Cohere provider icon path is from Lobe Icons, Copyright 2023 LobeHub,
used under the MIT License.

The model provider catalog bundles provider and model data from models.dev,
https://github.com/anomalyco/models.dev, Copyright (c) 2025 models.dev, used
under the MIT License. Its cache and refresh logic is adapted from OpenCode,
https://github.com/anomalyco/opencode, Copyright (c) 2025 opencode, used under
the MIT License. The full license texts are in third_party/models-dev/LICENSE
and third_party/opencode/LICENSE.

The browser driver's US keyboard layout and key-event rules
(server/browser/cdp/keyboard.ts) come from Puppeteer, Copyright 2017 Google
Inc., used under the Apache License, Version 2.0 (third_party/puppeteer).

The browser driver's action semantics, error messages, limits and test cases,
its copy capture and its browser host diagnosis adapt T3 Code's server
browser (apps/server/src/preview), Copyright 2026 T3 Tools Inc., used under
the MIT License (third_party/t3-code/LICENSE).

The bots' browser service on that driver (server/browser/) adapts T3 Code's
server browser and preview tools: its session control, tab lifecycle,
viewers and screencast pacing, tool definitions and snapshot bound
(apps/server/src/preview and apps/server/src/mcp), Copyright 2026 T3 Tools
Inc., used under the MIT License (third_party/t3-code/LICENSE).

The social post previews template (skills/social-posts/posts.html) adapts the
post card markup and platform styling of MiniMock,
https://github.com/minianon/MiniMock, Copyright (c) 2026 Tushar Bhardwaj, used
under the MIT License (third_party/minimock/LICENSE). Its icon paths are from
Lucide, https://lucide.dev, Copyright Lucide Contributors, used under the ISC
License; the template carries both notices, so every copy of it keeps them.

The browser desktop viewer bundles the unmodified noVNC 1.7.0 library,
Copyright the noVNC authors, under MPL-2.0 and its accompanying licenses.
Attribution, license terms and the corresponding source location are in
public/novnc-NOTICE.txt (novnc-NOTICE.txt in the built UI).
The iOS companion app bundles a prebuilt WebRTC library for Live calls
(stasel/WebRTC), built from the WebRTC project, Copyright (c) 2011, The WebRTC
project authors, used under the BSD 3-Clause License. WebRTC includes
third-party components under their own licenses, listed with the library.
```

The Apache License, Version 2.0:

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## Threebot (Mossbot chat scrolling, adapted)

Mossbot's chat scroll anchoring and the phone composer's tap-to-focus behaviour port `web/src/lib/chatScroll.ts` and the chat behaviour state machine of Threebot.

- Source: https://github.com/RokaSwK/threebot (commit 4f482cce6edd747b6db34772e0fb4c526d11ca02)
- License: MIT.

```text
MIT License

Copyright (c) 2026 Threebot contributors

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
```
