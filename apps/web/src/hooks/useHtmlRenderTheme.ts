// FILE: useHtmlRenderTheme.ts
// Purpose: The app's active theme and fonts, as handed to agent HTML renders.
// Layer: Web appearance hook
// Origin: Adapted from apps/web/src/hooks/useHtmlRenderTheme.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at ba0ea3d152150f399827d36a5b4b86c5bbda2d7f.
//   Moss reads its own theme tokens into T3's color roles; roles Moss has no token for
//   keep T3's stock palette. See THIRD_PARTY_NOTICES.md.

import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@synara/shared/htmlRender";
import {
  MOSS_DARK_THEME_COLORS,
  MOSS_LIGHT_THEME_COLORS,
  type ThemeColors,
} from "@synara/shared/themePalettes";
import { useMemo } from "react";

import { isElectron } from "../env";
import { isMacNavigatorPlatform } from "../lib/utils";
import {
  buildThemeCssVariables,
  resolveThemePack,
  type ThemeState,
  type ThemeVariant,
} from "../theme/theme.logic";
import { useTheme } from "./useTheme";

// T3 color role -> the Moss app token painting the same surface or text.
const MOSS_TOKEN_BY_ROLE = {
  canvas: "--color-background-surface",
  text: "--foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  surface: "--card",
  surfaceOverlay: "--popover",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  border: "--border",
  input: "--input",
  focus: "--ring",
  messageAction: "--primary",
  messageActionForeground: "--primary-foreground",
  accentSurface: "--accent",
  accentSurfaceForeground: "--info-foreground",
  codeBackground: "--app-chat-code-surface",
  codeForeground: "--foreground",
} as const satisfies Partial<Record<keyof ThemeColors, string>>;

const fontStack = (family: string | undefined, fallback: string) =>
  family ? `${family}, ${fallback}` : fallback;

export function mossHtmlRenderTheme(state: ThemeState, appearance: ThemeVariant) {
  const pack = resolveThemePack(state, appearance);
  const { variables } = buildThemeCssVariables(pack, appearance, {
    electron: isElectron,
    isMac: isMacNavigatorPlatform(),
    systemUiFont: state.systemUiFont,
  });
  const read = (name: string) => variables[name]?.trim() || undefined;
  const mossColors = Object.fromEntries(
    Object.entries(MOSS_TOKEN_BY_ROLE).flatMap(([role, token]) => {
      const value = read(token);
      return value === undefined ? [] : [[role, value]];
    }),
  ) as Partial<Record<keyof ThemeColors, string>>;
  const colors: ThemeColors = {
    ...(appearance === "dark" ? MOSS_DARK_THEME_COLORS : MOSS_LIGHT_THEME_COLORS),
    accent: pack.theme.accent,
    ...mossColors,
  };
  return htmlRenderTheme(colors, appearance, {
    sans: fontStack(read("--theme-font-ui-family"), HTML_RENDER_DEFAULT_FONTS.sans),
    mono: fontStack(read("--theme-font-code-family"), HTML_RENDER_DEFAULT_FONTS.mono),
  });
}

/** The app's active theme and fonts, as handed to agent HTML renders. Stable until one changes. */
export function useHtmlRenderTheme() {
  const { themeState, resolvedTheme } = useTheme();
  return useMemo(() => mossHtmlRenderTheme(themeState, resolvedTheme), [themeState, resolvedTheme]);
}
