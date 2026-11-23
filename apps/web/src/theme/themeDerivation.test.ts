import { describe, expect, it } from "vitest";

import { DEFAULT_THEME_STATE, buildResolvedThemeTokens, resolveThemePack } from "./theme.logic";
import { THEME_SEED_CATALOG } from "./theme.seed.generated";
import {
  buildComputedTheme,
  buildDarkDerivedTokens,
  buildLightDerivedTokens,
} from "./themeDerivation";

describe("theme derivation from the raw Moss seed", () => {
  // The phone's palette is generated from THEME_SEED_CATALOG.moss through themeDerivation
  // (apps/mobile/scripts/sync-moss-assets.mjs), without the desktop's state normalization.
  // This keeps that path equal to what the desktop really draws by default.
  it.each(["light", "dark"] as const)(
    "gives the same tokens the desktop resolves for its default state (%s)",
    (variant) => {
      const seed = THEME_SEED_CATALOG.moss![variant]!;
      const computed = buildComputedTheme(
        { ...seed, sidebar: seed.sidebar ?? null } as Parameters<typeof buildComputedTheme>[0],
        variant,
      );
      const fromSeed =
        variant === "light" ? buildLightDerivedTokens(computed) : buildDarkDerivedTokens(computed);
      const resolved = buildResolvedThemeTokens(
        resolveThemePack(DEFAULT_THEME_STATE, variant),
        variant,
      );
      expect(fromSeed).toEqual(resolved.derived);
      expect(resolveThemePack(DEFAULT_THEME_STATE, variant).theme).toMatchObject({
        surface: seed.surface,
        ink: seed.ink,
        accent: seed.accent,
        semanticColors: seed.semanticColors,
      });
    },
  );
});
