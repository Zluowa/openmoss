// FILE: hostStyles.ts
// Purpose: The style half of the widget host context (SPEC §5, SPEC-protocol §3.5): every
//          ext-apps 1.7.5 style variable, valued from Moss's own resolved theme tokens as
//          `light-dark(<light>, <dark>)` pairs, plus Inter @font-face rules for the sandbox.
// Layer: Web MCP App host presentation
// Exports: MCP_APP_COLOR_VARIABLE_SOURCES, buildMcpAppStyleVariables, buildMcpAppFontCss,
//          mcpAppStylesForThemePacks

import type { McpUiHostStyles, McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

import { buildResolvedThemeTokens, type ThemePack } from "../../theme/theme.logic";
import { MCP_APP_SANDBOX_FONT_FACE_CSS } from "./constants";

type TokenMap = Readonly<Record<string, string>>;

/**
 * Where each color variable comes from: a Moss theme token, optionally at an alpha. The
 * alpha steps follow Moss's own tint ladder (ink 5 % fill, 10 % pressed) or, for rings and
 * the disabled/ghost pairs, the widget contract's meaning (50 % / 70 % / 0 %).
 */
export interface McpAppColorSource {
  readonly token: string;
  readonly alpha?: number;
}

export const MCP_APP_COLOR_VARIABLE_SOURCES = {
  "--color-background-primary": { token: "--color-background-surface" },
  "--color-background-secondary": { token: "--codex-base-ink", alpha: 0.05 },
  "--color-background-tertiary": { token: "--color-background-panel" },
  "--color-background-inverse": { token: "--color-text-foreground" },
  "--color-background-ghost": { token: "--color-background-surface", alpha: 0 },
  "--color-background-info": { token: "--color-background-accent" },
  "--color-background-danger": { token: "--color-editor-deleted" },
  "--color-background-success": { token: "--color-editor-added" },
  "--color-background-warning": { token: "--color-accent-yellow", alpha: 0.15 },
  "--color-background-disabled": { token: "--color-background-surface", alpha: 0.5 },
  "--color-text-primary": { token: "--color-text-foreground" },
  "--color-text-secondary": { token: "--color-text-foreground-secondary" },
  "--color-text-tertiary": { token: "--color-text-foreground-tertiary" },
  "--color-text-inverse": { token: "--color-background-surface" },
  "--color-text-info": { token: "--color-text-accent" },
  "--color-text-danger": { token: "--color-accent-red" },
  "--color-text-success": { token: "--color-accent-green" },
  "--color-text-warning": { token: "--color-text-warning" },
  "--color-text-disabled": { token: "--codex-base-ink", alpha: 0.5 },
  "--color-text-ghost": { token: "--color-text-foreground-tertiary", alpha: 0.5 },
  "--color-border-primary": { token: "--codex-base-ink", alpha: 0.2 },
  "--color-border-secondary": { token: "--codex-base-ink", alpha: 0.1 },
  "--color-border-tertiary": { token: "--color-border" },
  "--color-border-inverse": { token: "--color-background-surface", alpha: 0.3 },
  "--color-border-ghost": { token: "--codex-base-ink", alpha: 0 },
  "--color-border-info": { token: "--color-accent-blue" },
  "--color-border-danger": { token: "--color-accent-red" },
  "--color-border-success": { token: "--color-accent-green" },
  "--color-border-warning": { token: "--color-accent-yellow" },
  "--color-border-disabled": { token: "--color-border-light" },
  "--color-ring-primary": { token: "--color-border-focus" },
  "--color-ring-secondary": { token: "--color-text-foreground-secondary", alpha: 0.7 },
  "--color-ring-inverse": { token: "--color-background-surface", alpha: 0.7 },
  "--color-ring-info": { token: "--color-accent-blue", alpha: 0.5 },
  "--color-ring-danger": { token: "--color-accent-red", alpha: 0.5 },
  "--color-ring-success": { token: "--color-accent-green", alpha: 0.5 },
  "--color-ring-warning": { token: "--color-accent-yellow", alpha: 0.5 },
} as const satisfies Record<string, McpAppColorSource>;

/** Moss design standard v1 values (comfortable density, 16 px root). */
const PLAIN_VARIABLES = {
  "--font-sans": '"Inter", ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
  "--font-mono": '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "14px",
  "--font-text-md-size": "16px",
  "--font-text-lg-size": "20px",
  "--font-heading-xs-size": "12px",
  "--font-heading-sm-size": "14px",
  "--font-heading-md-size": "16px",
  "--font-heading-lg-size": "20px",
  "--font-heading-xl-size": "24px",
  "--font-heading-2xl-size": "28px",
  "--font-heading-3xl-size": "36px",
  "--font-text-xs-line-height": "1.4",
  "--font-text-sm-line-height": "1.4",
  "--font-text-md-line-height": "1.4",
  "--font-text-lg-line-height": "1.25",
  "--font-heading-xs-line-height": "1.4",
  "--font-heading-sm-line-height": "1.4",
  "--font-heading-md-line-height": "1.4",
  "--font-heading-lg-line-height": "1.25",
  "--font-heading-xl-line-height": "1.25",
  "--font-heading-2xl-line-height": "1.1",
  "--font-heading-3xl-line-height": "1",
  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "10px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--shadow-sm": "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
  "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--shadow-lg": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
} as const;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parseColor(value: string): Rgba | null {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(trimmed);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(
    trimmed,
  );
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  return null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatColor(color: Rgba): string {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${round(color.a)})`;
}

function resolveSource(tokens: TokenMap, source: McpAppColorSource): string {
  const raw = tokens[source.token];
  if (raw === undefined) return "transparent";
  const parsed = parseColor(raw);
  if (!parsed) return raw;
  return formatColor(
    source.alpha === undefined ? parsed : { ...parsed, a: parsed.a * source.alpha },
  );
}

/** All style variables for a light and a dark resolved Moss token map. */
export function buildMcpAppStyleVariables(light: TokenMap, dark: TokenMap): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, source] of Object.entries(MCP_APP_COLOR_VARIABLE_SOURCES)) {
    variables[name] = `light-dark(${resolveSource(light, source)}, ${resolveSource(dark, source)})`;
  }
  return { ...variables, ...PLAIN_VARIABLES };
}

/** Inter for the widget document, served from the sandbox asset origin (B). */
export function buildMcpAppFontCss(): string {
  return MCP_APP_SANDBOX_FONT_FACE_CSS;
}

/** hostContext.styles for the person's current light and dark theme packs. */
export function mcpAppStylesForThemePacks(light: ThemePack, dark: ThemePack): McpUiHostStyles {
  const lightTokens = buildResolvedThemeTokens(light, "light").codexVariables;
  const darkTokens = buildResolvedThemeTokens(dark, "dark").codexVariables;
  return {
    variables: buildMcpAppStyleVariables(lightTokens, darkTokens) as McpUiStyles,
    css: { fonts: buildMcpAppFontCss() },
  };
}
