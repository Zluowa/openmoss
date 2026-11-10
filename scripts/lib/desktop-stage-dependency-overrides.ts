// FILE: desktop-stage-dependency-overrides.ts
// Purpose: Keeps staged desktop installs working around published packages with unresolved catalog deps.
// Layer: Release/build script support

export const DESKTOP_STAGE_DEPENDENCY_OVERRIDES = {
  // Keep the release stage on the exact version used by the production lock.
  // The web app ships 1.3.5; pinning the desktop/server stage to 1.2.x leaves
  // two incompatible Pierre renderers in one release surface.
  "@pierre/diffs": "1.3.5",
  "@pierre/theme": "2.0.0",
  "hast-util-to-html": "9.0.5",
  lru_map: "0.4.1",
} as const satisfies Record<string, string>;
