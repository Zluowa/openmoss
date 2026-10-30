// FILE: subagentAvatarAssets.ts
// Purpose: Keep the legacy seeded-avatar API over the shared Codex marks.

import { CODEX_SUBAGENT_SPARKLE_ASSETS } from "./codexSubagentSparkleAssets";

export interface SubagentAvatarAssetPair {
  readonly dark: string;
  readonly light: string;
}

// Main renamed avatar-01..28 to 00..27 without changing the SVG blobs. Preserve
// the PR seed-to-index mapping while sharing the same bundled asset URLs.
export const SUBAGENT_AVATAR_ASSETS: readonly SubagentAvatarAssetPair[] =
  CODEX_SUBAGENT_SPARKLE_ASSETS;

export const SUBAGENT_AVATAR_ASSET_COUNT = SUBAGENT_AVATAR_ASSETS.length;
