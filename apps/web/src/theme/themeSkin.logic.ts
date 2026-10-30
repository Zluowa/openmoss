import type { ChromeTheme, ThemeVariant } from "./theme.logic";

export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

export interface ThemeSkinState extends OklchColor {
  isGradient: boolean;
  opacity: number;
  saturation: number;
  pattern: ThemeSkinPattern;
  patternOpacity: number;
}

export type ThemeSkinPattern =
  | "none"
  | "stripe"
  | "liquid"
  | "warp"
  | "noise"
  | "starlight"
  | "dots"
  | "dots-2"
  | "define";

export interface ThemeSkinPreset {
  name: string;
  colors: readonly OklchColor[];
}

type OffsetPoint = readonly [number, number];

export const DEFAULT_THEME_SKIN: ThemeSkinState = {
  l: 1,
  c: 0,
  h: 0,
  isGradient: false,
  opacity: 100,
  pattern: "none",
  patternOpacity: 100,
  saturation: 100,
};

export const HEAVY_ANCHORS: readonly OklchColor[] = [
  { l: 0.88, c: 0.075, h: 15.66 },
  { l: 0.88, c: 0.08, h: 44.41 },
  { l: 0.88, c: 0.08, h: 76.39 },
  { l: 0.88, c: 0.085, h: 106.53 },
  { l: 0.88, c: 0.085, h: 136.51 },
  { l: 0.88, c: 0.085, h: 167.48 },
  { l: 0.88, c: 0.09, h: 196.52 },
  { l: 0.88, c: 0.075, h: 228.06 },
  { l: 0.88, c: 0.065, h: 258.69 },
  { l: 0.88, c: 0.065, h: 289.54 },
  { l: 0.88, c: 0.095, h: 319.88 },
  { l: 0.88, c: 0.09, h: 350.12 },
] as const;

const PRESET_HEAVY: readonly OklchColor[] = [
  { l: 0.8798, c: 0.064, h: 16.06 },
  { l: 0.8799, c: 0.068, h: 44.64 },
  { l: 0.8799, c: 0.08, h: 76.32 },
  { l: 0.8806, c: 0.085, h: 106.56 },
  { l: 0.88, c: 0.084, h: 136.69 },
  { l: 0.8801, c: 0.085, h: 167.17 },
  { l: 0.8788, c: 0.09, h: 196.51 },
  { l: 0.8802, c: 0.075, h: 228.22 },
  { l: 0.8793, c: 0.059, h: 258.66 },
  { l: 0.8795, c: 0.063, h: 290.02 },
  { l: 0.8809, c: 0.075, h: 319.96 },
  { l: 0.8803, c: 0.075, h: 350.54 },
] as const;

const PRESET_LIGHT: readonly OklchColor[] = [
  { l: 0.9392, c: 0.031, h: 12.79 },
  { l: 0.9398, c: 0.033, h: 46.4 },
  { l: 0.9393, c: 0.0495, h: 75.02 },
  { l: 0.9397, c: 0.075, h: 106.1 },
  { l: 0.9385, c: 0.074, h: 136.79 },
  { l: 0.94, c: 0.07, h: 167.73 },
  { l: 0.9391, c: 0.055, h: 198.23 },
  { l: 0.9408, c: 0.035, h: 227.58 },
  { l: 0.9398, c: 0.029, h: 259.59 },
  { l: 0.9394, c: 0.031, h: 289.79 },
  { l: 0.9399, c: 0.046, h: 319.22 },
  { l: 0.9399, c: 0.035, h: 350.86 },
] as const;

const CHROMA_OFFSETS: readonly OffsetPoint[] = [
  [16.06, 0.001],
  [44.64, -0.005],
  [136.69, -0.008],
  [228.22, -0.025],
  [290.02, 0.047],
] as const;

const HUE_OFFSETS: Record<"neutralDark" | "baseLight" | "neutralLight", readonly OffsetPoint[]> = {
  baseLight: [
    [16.06, -3.27],
    [44.64, 1.76],
    [136.69, 0.1],
    [228.22, -0.64],
    [290.02, -0.23],
  ],
  neutralDark: [
    [16.06, -0.48],
    [44.64, -0.51],
    [136.69, -0.5],
    [228.22, 0.83],
    [290.02, 5.63],
  ],
  neutralLight: [
    [16.06, 1.26],
    [44.64, -5.2],
    [136.69, -0.37],
    [228.22, 0.7],
    [290.02, 1.94],
  ],
};

const LIGHTNESS_OFFSETS = { baseLight: 6, neutralDark: -62.5, neutralLight: 10 } as const;
const CHROMA_SCALE = { baseLight: 0.485, neutralLight: 0.17 } as const;

export const PATTERNS: readonly ThemeSkinPattern[] = [
  "none",
  "stripe",
  "liquid",
  "warp",
  "noise",
  "starlight",
  "dots",
  "dots-2",
  "define",
] as const;

export const PRESETS: readonly ThemeSkinPreset[] = createPresets();

export function normalizeThemeSkin(
  theme: Partial<ThemeSkinState> | null | undefined,
): ThemeSkinState {
  return {
    c: Math.max(0, finite(theme?.c, DEFAULT_THEME_SKIN.c)),
    h: normalizeHue(finite(theme?.h, DEFAULT_THEME_SKIN.h)),
    isGradient: Boolean(theme?.isGradient),
    l: finite(theme?.l, DEFAULT_THEME_SKIN.l),
    opacity: clamp(Math.round(finite(theme?.opacity, DEFAULT_THEME_SKIN.opacity)), 0, 100),
    pattern: isThemeSkinPattern(theme?.pattern) ? theme.pattern : DEFAULT_THEME_SKIN.pattern,
    patternOpacity: clamp(
      Math.round(finite(theme?.patternOpacity, DEFAULT_THEME_SKIN.patternOpacity)),
      0,
      100,
    ),
    saturation: clamp(Math.round(finite(theme?.saturation, DEFAULT_THEME_SKIN.saturation)), 0, 100),
  };
}

export function themeSkinToChromeThemePatch(
  theme: ThemeSkinState,
  variant: ThemeVariant,
): Partial<ChromeTheme> {
  const swatches = deriveSwatches(normalizeThemeSkin(theme));
  if (variant === "dark") {
    return {
      accent: oklchToHex(swatches.baseHeavy),
      contrast: 62,
      ink: oklchToHex(swatches.neutralLight),
      surface: oklchToHex(swatches.neutralDark),
    };
  }

  return {
    accent: oklchToHex(swatches.baseHeavy),
    contrast: 44,
    ink: oklchToHex(swatches.neutralDark),
    surface: oklchToHex(swatches.baseLight),
  };
}

export function themeSkinToAppSurfaceCssVariables(
  theme: ThemeSkinState,
  variant: ThemeVariant,
): Record<string, string> {
  const normalized = normalizeThemeSkin(theme);
  const swatches = deriveSwatches(normalized);
  const surface = variant === "dark" ? swatches.neutralDark : swatches.baseHeavy;
  const surfaceOpacity = (50 + 0.46 * normalized.opacity) / 100;

  return {
    "--moss-theme-skin-sidebar-surface": oklchCss(surface, surfaceOpacity),
  };
}

export function nextThemeSkinPattern(pattern: ThemeSkinPattern): ThemeSkinPattern {
  const index = PATTERNS.indexOf(pattern);
  return PATTERNS[(index + 1) % PATTERNS.length] ?? PATTERNS[0] ?? "none";
}

export function themeSkinPatternLayerOpacity(
  pattern: ThemeSkinPattern,
  patternOpacity: number,
): number {
  return pattern === "none" ? 0 : clamp(patternOpacity, 0, 100) / 100;
}

export function getGradientStops(theme: ThemeSkinState): OklchColor[] {
  return [theme.h - 25, theme.h, theme.h + 25].map((hue) => {
    const color = interpolateColor(hue, HEAVY_ANCHORS);
    return { c: scaledChroma(color.c, theme.saturation), h: color.h, l: color.l };
  });
}

export function patternBackground(name: ThemeSkinPattern): string {
  if (name === "none" || !PATTERNS.includes(name)) {
    return "none";
  }
  return `url("/theme-skin/patterns/${name}.png")`;
}

export function interpolateColor(
  angle: number,
  anchors: readonly OklchColor[] = HEAVY_ANCHORS,
): OklchColor {
  const activeAnchors = anchors.length > 0 ? anchors : HEAVY_ANCHORS;
  const hue = normalizeHue(angle);
  const scaled = hue / (360 / activeAnchors.length);
  const index = Math.floor(scaled) % activeAnchors.length;
  const nextIndex = (index + 1) % activeAnchors.length;
  const progress = scaled - Math.floor(scaled);
  const current = activeAnchors[index] ?? activeAnchors[0] ?? DEFAULT_THEME_SKIN;
  const next = activeAnchors[nextIndex] ?? activeAnchors[0] ?? DEFAULT_THEME_SKIN;
  let nextHue = next.h;
  let currentHue = current.h;
  if (Math.abs(nextHue - currentHue) > 180) {
    if (nextHue > currentHue) {
      nextHue -= 360;
    } else {
      currentHue -= 360;
    }
  }
  return {
    c: lerp(current.c, next.c, progress),
    h: normalizeHue(lerp(currentHue, nextHue, progress)),
    l: lerp(current.l, next.l, progress),
  };
}

export function oklchCss(color: OklchColor, alpha?: number): string {
  const l = (color.l * 100).toFixed(2);
  const c = color.c.toFixed(3);
  const h = normalizeHue(color.h).toFixed(2);
  return alpha === undefined ? `oklch(${l}% ${c} ${h})` : `oklch(${l}% ${c} ${h} / ${alpha})`;
}

export function oklchToHex(color: OklchColor): string {
  const lightness = clamp(color.l, 0, 1);
  const chroma = Math.max(0, color.c);
  const hue = (normalizeHue(color.h) * Math.PI) / 180;
  const a = Math.cos(hue) * chroma;
  const b = Math.sin(hue) * chroma;

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

  const lCube = lPrime ** 3;
  const mCube = mPrime ** 3;
  const sCube = sPrime ** 3;

  const linearRed = 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube;
  const linearGreen = -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube;
  const linearBlue = -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube;

  return `#${toHexChannel(linearRed)}${toHexChannel(linearGreen)}${toHexChannel(linearBlue)}`;
}

export function polarToPoint(
  angle: number,
  radius: number,
  centerX: number,
  centerY: number,
): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(radians),
    y: centerY + radius * Math.sin(radians),
  };
}

export function normalizeHue(hue: number): number {
  const normalized = hue % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scaledChroma(chroma: number, saturation: number): number {
  return Math.max(0, chroma * (saturation / 100));
}

function deriveSwatches(theme: ThemeSkinState): {
  baseHeavy: OklchColor;
  baseLight: OklchColor;
  neutralDark: OklchColor;
  neutralLight: OklchColor;
} {
  const l = clamp(theme.l, 0, 1);
  const c = scaledChroma(Math.max(0, theme.c), theme.saturation);
  const h = normalizeHue(theme.h);
  const lightness = l * 100;
  const neutralDarkL = offsetLightness(lightness, LIGHTNESS_OFFSETS.neutralDark);
  const baseLightL = offsetLightness(lightness, LIGHTNESS_OFFSETS.baseLight);
  const neutralLightL = offsetLightness(lightness, LIGHTNESS_OFFSETS.neutralLight);
  const neutralDarkC = Math.max(0, c + interpolated(CHROMA_OFFSETS, h));
  const baseLightC = Math.max(0, c * CHROMA_SCALE.baseLight);
  const neutralLightC = Math.max(0, c * CHROMA_SCALE.neutralLight);

  return {
    baseHeavy: { c, h, l },
    baseLight: {
      c: baseLightC,
      h: normalizeHue(h + interpolated(HUE_OFFSETS.baseLight, h)),
      l: baseLightL,
    },
    neutralDark: {
      c: neutralDarkC,
      h: normalizeHue(h + interpolated(HUE_OFFSETS.neutralDark, h)),
      l: neutralDarkL,
    },
    neutralLight: {
      c: neutralLightC,
      h: normalizeHue(h + interpolated(HUE_OFFSETS.neutralLight, h)),
      l: neutralLightL,
    },
  };
}

function createPresets(): ThemeSkinPreset[] {
  const heavy = PRESET_HEAVY.map((color, index) => ({
    colors: [color],
    name: `heavy-${index + 1}`,
  }));
  const light = PRESET_LIGHT.map((color, index) => ({
    colors: [color],
    name: `light-${index + 1}`,
  }));
  return [
    {
      colors: [{ c: DEFAULT_THEME_SKIN.c, h: DEFAULT_THEME_SKIN.h, l: DEFAULT_THEME_SKIN.l }],
      name: "default-white",
    },
    ...heavy,
    ...light,
    { colors: [{ l: 0.88, c: 0, h: 0 }], name: "gray-1" },
    { colors: [{ l: 0.94, c: 0, h: 0 }], name: "gray-2" },
    ...gradientSet(PRESET_HEAVY, "heavy"),
    ...gradientSet(PRESET_LIGHT, "light"),
  ];
}

function gradientSet(colors: readonly OklchColor[], prefix: string): ThemeSkinPreset[] {
  return colors.map((color, index) => {
    const previous = colors[(index - 1 + colors.length) % colors.length] ?? color;
    const next = colors[(index + 1) % colors.length] ?? color;
    return { colors: [previous, color, next], name: `${prefix}-${index + 1}-gradient` };
  });
}

function isThemeSkinPattern(value: unknown): value is ThemeSkinPattern {
  return typeof value === "string" && (PATTERNS as readonly string[]).includes(value);
}

function interpolated(points: readonly OffsetPoint[], hue: number): number {
  if (points.length === 0) {
    return 0;
  }
  const sorted = points.toSorted((a, b) => a[0] - b[0]);
  const normalized = normalizeHue(hue);
  const first = sorted[0] ?? [0, 0];
  const wrapped: OffsetPoint[] = [...sorted, [first[0] + 360, first[1]]];
  for (let index = 0; index < wrapped.length - 1; index += 1) {
    const [h1, value1] = wrapped[index] ?? first;
    const [h2, value2] = wrapped[index + 1] ?? first;
    if (normalized >= h1 && normalized <= h2) {
      return lerp(value1, value2, (normalized - h1) / (h2 - h1 || 1));
    }
  }

  const [lastHue, lastValue] = sorted[sorted.length - 1] ?? first;
  const [firstHue, firstValue] = first;
  if (normalized >= lastHue) {
    return lerp(lastValue, firstValue, (normalized - lastHue) / (firstHue + 360 - lastHue || 1));
  }
  return lerp(
    lastValue,
    firstValue,
    (normalized + 360 - lastHue) / (firstHue + 360 - lastHue || 1),
  );
}

function offsetLightness(value: number, offset: number): number {
  return clamp((value + offset) / 100, 0, 1);
}

function finite(value: unknown, fallback: number): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function toHexChannel(linearValue: number): string {
  const bounded = clamp(linearValue, 0, 1);
  const encoded = bounded <= 0.0031308 ? 12.92 * bounded : 1.055 * bounded ** (1 / 2.4) - 0.055;
  return Math.round(clamp(encoded, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
}
