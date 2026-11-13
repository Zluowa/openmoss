// FILE: designSystems.ts
// Purpose: Design systems for 设计 items: the token shape (colours per theme, text styles,
//          fonts, spacing, radius, shadow), Moss's built-in systems, validation, and the CSS
//          variables an artboard receives.
// Layer: Shared model (server validates agent-written tokens; web paints artboards and the Theme tab)
// Why: A design copies the tokens of the system it uses, so an artboard renders the same however
//      the source system changes later; the CSS variables are how its HTML reads them.
// Exports: DesignSystemTokens, BUILT_IN_DESIGN_SYSTEMS, parseDesignSystemTokens,
//          designSystemCss, findBuiltInDesignSystem.

export interface DesignColorToken {
  /** `[a-z][a-z0-9-]*`; reaches the HTML as `var(--ds-<name>)`. */
  readonly name: string;
  readonly label: string;
  readonly light: string;
  readonly dark?: string;
  readonly usage?: string;
}
export interface DesignTextStyle {
  readonly name: string;
  readonly label: string;
  readonly family: "sans" | "serif" | "mono";
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: number;
  readonly letterSpacing?: number;
}
export interface DesignLengthToken {
  readonly name: string;
  readonly value: number;
  readonly usage?: string;
}
export interface DesignSystemTokens {
  readonly fonts: { readonly sans: string; readonly serif: string; readonly mono: string };
  readonly colors: readonly DesignColorToken[];
  readonly text: readonly DesignTextStyle[];
  readonly spacing: readonly DesignLengthToken[];
  readonly radius: readonly DesignLengthToken[];
  readonly shadows?: readonly {
    readonly name: string;
    readonly value: string;
    readonly usage?: string;
  }[];
  /** The system's brand book in Markdown: what to use where. */
  readonly readme?: string;
}

export interface BuiltInDesignSystem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tokens: DesignSystemTokens;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/+-]+\))$/u;
const FONT_STACK = /^[A-Za-z0-9 ,"'\-一-鿿]{1,200}$/u;

function fail(message: string): never {
  throw new Error(`Invalid design system: ${message}`);
}
function list(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${what} must be a list`);
  return value.slice(0, max);
}
function entry(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}
function name(value: unknown, what: string): string {
  if (typeof value !== "string" || !NAME.test(value))
    fail(`${what} name must be lower-case letters, digits or - (got ${String(value)})`);
  return value;
}
function label(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : fallback;
}
function color(value: unknown, what: string): string {
  if (typeof value !== "string" || !COLOR.test(value.trim()))
    fail(`${what} must be a hex, rgb(), hsl() or oklch() colour`);
  return value.trim();
}
function length(value: unknown, what: string, max = 400): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
    fail(`${what} must be a number from 0 to ${max}`);
  return Math.round(value * 100) / 100;
}
function usage(value: unknown): { usage?: string } {
  return typeof value === "string" && value.trim() ? { usage: value.trim().slice(0, 200) } : {};
}
function unique<T extends { name: string }>(items: T[], what: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) fail(`duplicate ${what} ${item.name}`);
    seen.add(item.name);
  }
  return items;
}

const DEFAULT_FONTS = {
  sans: '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  serif: '"Noto Serif SC", "Songti SC", Georgia, serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
};

export function parseDesignSystemTokens(input: unknown): DesignSystemTokens {
  const value = entry(input, "tokens");
  const fontsIn =
    value.fonts && typeof value.fonts === "object" ? (value.fonts as Record<string, unknown>) : {};
  const font = (key: "sans" | "serif" | "mono") => {
    const stack = fontsIn[key];
    if (stack === undefined) return DEFAULT_FONTS[key];
    if (typeof stack !== "string" || !FONT_STACK.test(stack))
      fail(`fonts.${key} is not a font stack`);
    return stack;
  };
  const colors = unique(
    list(value.colors, "colors", 80).map((raw, index) => {
      const token = entry(raw, `colour ${index}`);
      const tokenName = name(token.name, "colour");
      return {
        name: tokenName,
        label: label(token.label, tokenName),
        light: color(token.light ?? token.value, `colour ${tokenName}`),
        ...(token.dark !== undefined
          ? { dark: color(token.dark, `colour ${tokenName} dark`) }
          : {}),
        ...usage(token.usage),
      };
    }),
    "colour",
  );
  const text = unique(
    list(value.text, "text", 24).map((raw, index) => {
      const style = entry(raw, `text style ${index}`);
      const styleName = name(style.name, "text style");
      const family = style.family === "serif" || style.family === "mono" ? style.family : "sans";
      return {
        name: styleName,
        label: label(style.label, styleName),
        family,
        size: length(style.size, `text ${styleName} size`, 400),
        lineHeight: length(style.lineHeight, `text ${styleName} lineHeight`, 600),
        weight: Math.min(900, Math.max(100, Math.round(Number(style.weight ?? 400) / 100) * 100)),
        ...(typeof style.letterSpacing === "number"
          ? { letterSpacing: Math.round(style.letterSpacing * 100) / 100 }
          : {}),
      } satisfies DesignTextStyle;
    }),
    "text style",
  );
  const lengths = (key: "spacing" | "radius") =>
    unique(
      list(value[key], key, 24).map((raw, index) => {
        const token = entry(raw, `${key} ${index}`);
        const tokenName = name(token.name, key);
        return {
          name: tokenName,
          value: length(token.value, `${key} ${tokenName}`, 2_000),
          ...usage(token.usage),
        };
      }),
      key,
    );
  const shadows = list(value.shadows, "shadows", 12).map((raw, index) => {
    const token = entry(raw, `shadow ${index}`);
    const tokenName = name(token.name, "shadow");
    if (typeof token.value !== "string" || !/^[0-9a-zA-Z#().,%\s/-]{1,200}$/u.test(token.value))
      fail(`shadow ${tokenName} is not a box-shadow value`);
    return { name: tokenName, value: token.value, ...usage(token.usage) };
  });
  return {
    fonts: { sans: font("sans"), serif: font("serif"), mono: font("mono") },
    colors,
    text,
    spacing: lengths("spacing"),
    radius: lengths("radius"),
    ...(shadows.length ? { shadows: unique(shadows, "shadow") } : {}),
    ...(typeof value.readme === "string" && value.readme.trim()
      ? { readme: value.readme.slice(0, 20_000) }
      : {}),
  };
}

/** CSS custom properties for an artboard: `--ds-<colour>`, `--ds-text-<style>-*`, spacing, radius. */
export function designSystemCss(
  tokens: DesignSystemTokens,
  theme: "light" | "dark" = "light",
): string {
  const lines: string[] = [
    `--ds-font-sans: ${tokens.fonts.sans};`,
    `--ds-font-serif: ${tokens.fonts.serif};`,
    `--ds-font-mono: ${tokens.fonts.mono};`,
  ];
  for (const token of tokens.colors)
    lines.push(
      `--ds-${token.name}: ${theme === "dark" ? (token.dark ?? token.light) : token.light};`,
    );
  for (const style of tokens.text) {
    lines.push(`--ds-text-${style.name}-size: ${style.size}px;`);
    lines.push(`--ds-text-${style.name}-line: ${style.lineHeight}px;`);
    lines.push(`--ds-text-${style.name}-weight: ${style.weight};`);
  }
  for (const token of tokens.spacing) lines.push(`--ds-space-${token.name}: ${token.value}px;`);
  for (const token of tokens.radius) lines.push(`--ds-radius-${token.name}: ${token.value}px;`);
  for (const token of tokens.shadows ?? [])
    lines.push(`--ds-shadow-${token.name}: ${token.value};`);
  return `:root{${lines.join("")}}`;
}

/** The inline style a text style writes onto an element. */
export function designTextStyleCss(
  tokens: DesignSystemTokens,
  style: DesignTextStyle,
): Record<string, string> {
  return {
    "font-family": tokens.fonts[style.family],
    "font-size": `${style.size}px`,
    "line-height": `${style.lineHeight}px`,
    "font-weight": String(style.weight),
    ...(style.letterSpacing !== undefined ? { "letter-spacing": `${style.letterSpacing}px` } : {}),
  };
}

const RADIUS = [
  { name: "inline", value: 4, usage: "行内标签、复选框" },
  { name: "control", value: 8, usage: "按钮、输入框、列表行" },
  { name: "card", value: 12, usage: "卡片、弹层、面板" },
  { name: "composer", value: 14, usage: "大输入区" },
];
const SPACING = [
  { name: "xs", value: 6, usage: "图标和文字之间" },
  { name: "sm", value: 8, usage: "控件内边距" },
  { name: "md", value: 12, usage: "同组元素间隔" },
  { name: "lg", value: 16, usage: "卡片内边距" },
  { name: "xl", value: 24, usage: "区块内边距" },
  { name: "2xl", value: 40, usage: "区块之间" },
];

const MOSS_TOKENS: DesignSystemTokens = {
  fonts: DEFAULT_FONTS,
  colors: [
    { name: "paper", label: "纸", light: "#fcfcfb", dark: "#1c1c1b", usage: "页面底色" },
    { name: "panel", label: "面板", light: "#fdfdfc", dark: "#1e1e1d", usage: "卡片、列表容器" },
    { name: "frame", label: "外框", light: "#f3f3f1", dark: "#1a1a19", usage: "侧栏、顶栏" },
    { name: "ink", label: "墨", light: "#141413", dark: "#f0efec", usage: "正文、标题" },
    {
      name: "ink-secondary",
      label: "次要文字",
      light: "#72726f",
      dark: "#9f9e9b",
      usage: "说明、元信息",
    },
    {
      name: "ink-muted",
      label: "提示文字",
      light: "#a1a1a0",
      dark: "#6a6a68",
      usage: "占位符、时间",
    },
    { name: "line", label: "细线", light: "#ececeb", dark: "#2c2c2b", usage: "分隔线、卡片边" },
    { name: "fill", label: "填充", light: "#f3f3f2", dark: "#272726", usage: "按钮、标签底" },
    { name: "accent", label: "强调", light: "#2a78d6", dark: "#3987e5", usage: "链接、选中、焦点" },
    { name: "success", label: "成功", light: "#00a240", usage: "完成、通过" },
    { name: "warning", label: "注意", light: "#d97706", dark: "#f5b44a", usage: "提醒" },
    { name: "danger", label: "错误", light: "#e02e2a", usage: "错误、删除" },
  ],
  text: [
    { name: "title", label: "页面标题", family: "sans", size: 22, lineHeight: 28, weight: 500 },
    { name: "heading", label: "小标题", family: "sans", size: 15, lineHeight: 20, weight: 500 },
    { name: "body", label: "界面正文", family: "sans", size: 14, lineHeight: 20, weight: 400 },
    { name: "prose", label: "阅读正文", family: "sans", size: 16, lineHeight: 24, weight: 400 },
    { name: "footnote", label: "次要", family: "sans", size: 13, lineHeight: 17, weight: 400 },
    { name: "caption", label: "注释", family: "sans", size: 12, lineHeight: 17, weight: 400 },
    { name: "code", label: "代码", family: "mono", size: 13, lineHeight: 19, weight: 400 },
  ],
  spacing: SPACING,
  radius: RADIUS,
  shadows: [
    {
      name: "float",
      value: "0 2px 6px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12)",
      usage: "菜单、弹层",
    },
  ],
  readme:
    "Moss 设计标准：纸色底、墨色字、一个蓝色强调色；两种字重（常规、中等）；圆角按角色用 8 / 12 / 14；不用渐变洗底、表情符号和左边框卡片。",
};

export const BUILT_IN_DESIGN_SYSTEMS: readonly BuiltInDesignSystem[] = [
  {
    id: "moss",
    name: "Moss 设计标准",
    description: "纸色、墨色、一个蓝色强调，安静克制",
    tokens: MOSS_TOKENS,
  },
  {
    id: "editorial",
    name: "纸本",
    description: "米色纸面、衬线标题，适合海报和长文",
    tokens: {
      ...MOSS_TOKENS,
      colors: [
        { name: "paper", label: "纸", light: "#f7f3ea", dark: "#1f1c17", usage: "页面底色" },
        { name: "ink", label: "墨", light: "#2a241c", dark: "#efe7da", usage: "正文、标题" },
        {
          name: "ink-secondary",
          label: "次要文字",
          light: "#6f6455",
          dark: "#a89b88",
          usage: "说明",
        },
        { name: "line", label: "细线", light: "#e3dccd", dark: "#3a342b", usage: "分隔线" },
        {
          name: "accent",
          label: "强调",
          light: "#9a3412",
          dark: "#f0a271",
          usage: "标题强调、链接",
        },
        { name: "fill", label: "填充", light: "#efe8da", dark: "#2a261f", usage: "色块" },
      ],
      text: [
        {
          name: "display",
          label: "大标题",
          family: "serif",
          size: 56,
          lineHeight: 64,
          weight: 500,
        },
        { name: "title", label: "标题", family: "serif", size: 32, lineHeight: 40, weight: 500 },
        { name: "lead", label: "导语", family: "sans", size: 20, lineHeight: 30, weight: 400 },
        { name: "body", label: "正文", family: "sans", size: 16, lineHeight: 26, weight: 400 },
        { name: "caption", label: "注释", family: "sans", size: 13, lineHeight: 18, weight: 400 },
      ],
      readme: "纸本：米色纸面和衬线标题，一个砖红强调色。标题用衬线，正文用无衬线。",
    },
  },
  {
    id: "night",
    name: "墨夜",
    description: "深色底、高对比，适合产品界面和演示",
    tokens: {
      ...MOSS_TOKENS,
      colors: [
        { name: "paper", label: "底色", light: "#111113", dark: "#111113", usage: "页面底色" },
        { name: "panel", label: "面板", light: "#1b1b1f", dark: "#1b1b1f", usage: "卡片" },
        { name: "ink", label: "文字", light: "#f4f4f5", dark: "#f4f4f5", usage: "正文、标题" },
        {
          name: "ink-secondary",
          label: "次要文字",
          light: "#a1a1aa",
          dark: "#a1a1aa",
          usage: "说明",
        },
        { name: "line", label: "细线", light: "#2a2a30", dark: "#2a2a30", usage: "分隔线" },
        { name: "accent", label: "强调", light: "#7cc4ff", dark: "#7cc4ff", usage: "链接、选中" },
        { name: "success", label: "成功", light: "#4ade80", usage: "完成" },
        { name: "danger", label: "错误", light: "#f87171", usage: "错误" },
      ],
      readme: "墨夜：深色底和浅色字，强调色用浅蓝。文字对比度保持 4.5:1 以上。",
    },
  },
  {
    id: "fresh",
    name: "清新",
    description: "白底、蓝绿强调、圆润，适合营销页和移动应用",
    tokens: {
      ...MOSS_TOKENS,
      colors: [
        { name: "paper", label: "纸", light: "#ffffff", dark: "#0f1720", usage: "页面底色" },
        { name: "panel", label: "面板", light: "#f4f8fb", dark: "#16212c", usage: "卡片" },
        { name: "ink", label: "墨", light: "#0f1f2e", dark: "#e8f1f8", usage: "正文、标题" },
        {
          name: "ink-secondary",
          label: "次要文字",
          light: "#55697a",
          dark: "#9db1c2",
          usage: "说明",
        },
        { name: "line", label: "细线", light: "#e2eaf0", dark: "#243341", usage: "分隔线" },
        { name: "accent", label: "强调", light: "#0e7490", dark: "#5fc8e0", usage: "按钮、链接" },
        {
          name: "accent-soft",
          label: "浅强调",
          light: "#e0f4f8",
          dark: "#173640",
          usage: "标签底",
        },
      ],
      radius: [
        { name: "control", value: 12, usage: "按钮、输入框" },
        { name: "card", value: 20, usage: "卡片" },
        { name: "pill", value: 999, usage: "胶囊按钮、标签" },
      ],
      readme: "清新：白底和蓝绿强调色，圆角偏大，按钮可以用胶囊形。",
    },
  },
];

export function findBuiltInDesignSystem(id: string): BuiltInDesignSystem | undefined {
  return BUILT_IN_DESIGN_SYSTEMS.find((system) => system.id === id);
}
