// FILE: themeDerivation.ts
// Purpose: The colour math that turns a theme's seed (surface, ink, accent, contrast) into the
//          desktop's derived tokens (borders, secondary and tertiary text, controls). Pure and
//          import-free, so apps/mobile/scripts/sync-moss-assets.mjs can run it with plain node
//          to generate the phone's palette from the same numbers.
// Layer: Web appearance domain logic. Moved unchanged from theme.logic.ts (2026-11-24),
//          which imports it back.
import type { ChromeTheme, ThemeVariant } from "./theme.logic";

export type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

export const BLACK: RgbColor = { blue: 0, green: 0, red: 0 };

export const WHITE: RgbColor = { blue: 255, green: 255, red: 255 };

export const CONTRAST_CURVE_BELOW_BASELINE = 0.7;

export const CONTRAST_CURVE_ABOVE_BASELINE = 2;

// Keep Codex's original curve anchors even though Moss presets start at zero.
// This makes the new default render exactly like manually moving the old slider to zero.
export const CONTRAST_CURVE_BASELINE: Record<ThemeVariant, number> = {
  dark: 60,
  light: 45,
};

export const SURFACE_UNDER_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.16,
  light: 0.04,
};

export const SURFACE_UNDER_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.0015,
  light: 0.0012,
};

export function buildComputedTheme(theme: ChromeTheme, variant: ThemeVariant) {
  const contrast = normalizeContrastStrength(theme.contrast, variant);
  const surface = parseHexColor(theme.surface);
  const ink = parseHexColor(theme.ink);

  return {
    accent: parseHexColor(theme.accent),
    contrast,
    editorBackground:
      variant === "light" ? mixRgb(surface, WHITE, 0.12) : mixRgb(surface, ink, 0.07),
    ink,
    surface,
    surfaceUnder: buildSurfaceUnder(theme, surface, ink, variant),
    theme,
    variant,
  };
}

export function buildLightDerivedTokens(theme: ReturnType<typeof buildComputedTheme>) {
  // Light chrome derivation.
  const controlBase = mixRgb(theme.surface, WHITE, 0.09 + theme.contrast * 0.04);
  const elevatedSecondaryBase = mixRgb(theme.surface, WHITE, 0.08 + theme.contrast * 0.08);
  const elevatedPrimaryBase = mixRgb(theme.surface, WHITE, 0.16 + theme.contrast * 0.12);

  return {
    accentBackground: mixHex(theme.theme.surface, theme.theme.accent, 0.11 + theme.contrast * 0.04),
    accentBackgroundActive: mixHex(
      theme.theme.surface,
      theme.theme.accent,
      0.13 + theme.contrast * 0.05,
    ),
    accentBackgroundHover: mixHex(
      theme.theme.surface,
      theme.theme.accent,
      0.12 + theme.contrast * 0.045,
    ),
    // Light borders run slightly stronger than Codex's base derivation so the chat
    // seam (--color-border) and chat/header dividers (--color-border-light) read
    // clearly on white surfaces. Keep the bump small; don't exceed borderHeavy.
    border: formatRgba(theme.ink, 0.09 + theme.contrast * 0.04),
    borderFocus: theme.theme.accent,
    borderHeavy: formatRgba(theme.ink, 0.09 + theme.contrast * 0.06),
    borderLight: formatRgba(theme.ink, 0.07 + theme.contrast * 0.02),
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: formatRgba(theme.ink, 0.1 + theme.contrast * 0.12),
    buttonPrimaryBackgroundHover: formatRgba(theme.ink, 0.05 + theme.contrast * 0.06),
    buttonPrimaryBackgroundInactive: formatRgba(theme.ink, 0.18 + theme.contrast * 0.14),
    buttonSecondaryBackground: formatRgba(theme.ink, 0.03),
    buttonSecondaryBackgroundActive: formatRgba(theme.ink, 0.03 + theme.contrast * 0.02),
    buttonSecondaryBackgroundHover: formatRgba(theme.ink, 0.03),
    buttonSecondaryBackgroundInactive: formatRgba(theme.ink, 0.01 + theme.contrast * 0.02),
    buttonTertiaryBackground: formatRgba(theme.ink, 0),
    buttonTertiaryBackgroundActive: formatRgba(theme.ink, 0.16 + theme.contrast * 0.08),
    buttonTertiaryBackgroundHover: formatRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    controlBackground: formatRgba(controlBase, 0.96),
    controlBackgroundOpaque: formatOpaqueRgb(controlBase),
    elevatedPrimary: formatRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: formatOpaqueRgb(elevatedPrimaryBase),
    elevatedSecondary: formatRgba(theme.ink, 0.04),
    elevatedSecondaryOpaque: formatOpaqueRgb(elevatedSecondaryBase),
    iconAccent: theme.theme.accent,
    iconPrimary: theme.theme.ink,
    iconSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: formatRgba(BLACK, 0.08 + theme.contrast * 0.04),
    textAccent: theme.theme.accent,
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: theme.theme.ink,
    textButtonTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
  };
}

export function buildDarkDerivedTokens(theme: ReturnType<typeof buildComputedTheme>) {
  // Dark chrome derivation.
  const controlBase = mixRgb(theme.surface, theme.ink, 0.06 + theme.contrast * 0.05);
  const focusBase = mixRgb(theme.accent, WHITE, 0.3 + theme.contrast * 0.15);
  const elevatedPrimaryBase = mixRgb(theme.surface, theme.ink, 0.08 + theme.contrast * 0.08);

  return {
    accentBackground: mixHex("#000000", theme.theme.accent, 0.2 + theme.contrast * 0.08),
    accentBackgroundActive: mixHex("#000000", theme.theme.accent, 0.22 + theme.contrast * 0.12),
    accentBackgroundHover: mixHex("#000000", theme.theme.accent, 0.21 + theme.contrast * 0.1),
    border: formatRgba(theme.ink, 0.1 + theme.contrast * 0.04),
    borderFocus: formatRgba(focusBase, 0.7 + theme.contrast * 0.1),
    borderHeavy: formatRgba(theme.ink, 0.16 + theme.contrast * 0.06),
    borderLight: formatRgba(theme.ink, 0.06 + theme.contrast * 0.02),
    // High-contrast primary button (white-on-dark) mirroring the light-mode
    // derivation (bg = ink, text = surface). Intentionally diverges from Codex
    // Electron's dark elevated primary so the primary action reads as filled.
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: formatRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonPrimaryBackgroundHover: formatRgba(theme.ink, 0.04 + theme.contrast * 0.03),
    buttonPrimaryBackgroundInactive: formatRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    buttonSecondaryBackground: formatRgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: formatRgba(theme.ink, 0.09 + theme.contrast * 0.05),
    buttonSecondaryBackgroundHover: formatRgba(theme.ink, 0.06 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: formatRgba(theme.ink, 0.02 + theme.contrast * 0.03),
    buttonTertiaryBackground: formatRgba(theme.ink, 0.02 + theme.contrast * 0.015),
    buttonTertiaryBackgroundActive: formatRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonTertiaryBackgroundHover: formatRgba(theme.ink, 0.05 + theme.contrast * 0.03),
    controlBackground: formatRgba(controlBase, 0.96),
    controlBackgroundOpaque: formatOpaqueRgb(controlBase),
    elevatedPrimary: formatRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: formatOpaqueRgb(elevatedPrimaryBase),
    elevatedSecondary: formatRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    elevatedSecondaryOpaque: mixHex(
      theme.theme.surface,
      theme.theme.ink,
      0.04 + theme.contrast * 0.05,
    ),
    iconAccent: formatOpaqueRgb(focusBase),
    iconPrimary: formatRgba(theme.ink, 0.82 + theme.contrast * 0.14),
    iconSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: formatRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    // Codex brightens dark accent affordances through the same focus mix used
    // for the border, rather than using the raw accent directly.
    textAccent: formatOpaqueRgb(focusBase),
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: mixHex(theme.theme.ink, theme.theme.surface, 0.7 + theme.contrast * 0.1),
    textButtonTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: formatRgba(theme.ink, 0.42 + theme.contrast * 0.13),
  };
}

export function buildSurfaceUnder(
  theme: ChromeTheme,
  surface: RgbColor,
  ink: RgbColor,
  variant: ThemeVariant,
): string {
  const baseline = CONTRAST_CURVE_BASELINE[variant];
  const mixAmount =
    SURFACE_UNDER_BASE_ALPHA[variant] +
    (theme.contrast - baseline) * SURFACE_UNDER_CONTRAST_STEP[variant];
  return variant === "light"
    ? mixHex(formatHex(surface), formatHex(ink), mixAmount)
    : mixHex(formatHex(surface), "#000000", mixAmount);
}

export function normalizeContrastStrength(value: number, variant: ThemeVariant): number {
  const baseline = CONTRAST_CURVE_BASELINE[variant];
  const baselineRatio = baseline / 100;
  const curvedValue = value / 100 + ((value - baseline) / 60) * CONTRAST_CURVE_BELOW_BASELINE;

  if (value <= baseline) {
    return curvedValue;
  }

  return baselineRatio + (curvedValue - baselineRatio) * CONTRAST_CURVE_ABOVE_BASELINE;
}

// ─── Color math ───────────────────────────────────────────────────────────

export function parseHexColor(value: string): RgbColor {
  const hexValue = value.slice(1);
  return {
    blue: Number.parseInt(hexValue.slice(4, 6), 16),
    green: Number.parseInt(hexValue.slice(2, 4), 16),
    red: Number.parseInt(hexValue.slice(0, 2), 16),
  };
}

export function mixHex(from: string, to: string, amount: number): string {
  return formatHex(mixRgb(parseHexColor(from), parseHexColor(to), amount));
}

export function mixRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const clampedAmount = Math.min(1, Math.max(0, amount));
  return {
    blue: mixChannel(from.blue, to.blue, clampedAmount),
    green: mixChannel(from.green, to.green, clampedAmount),
    red: mixChannel(from.red, to.red, clampedAmount),
  };
}

export function mixChannel(from: number, to: number, amount: number): number {
  return Math.round(from + (to - from) * amount);
}

export function formatHex(color: RgbColor): string {
  return `#${formatHexChannel(color.red)}${formatHexChannel(color.green)}${formatHexChannel(color.blue)}`;
}

export function formatOpaqueRgb(color: RgbColor): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

export function formatRgba(color: RgbColor, opacity: number): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${formatAlpha(opacity)})`;
}

export function formatHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

export function formatAlpha(value: number): string {
  return Math.min(1, Math.max(0, value)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
