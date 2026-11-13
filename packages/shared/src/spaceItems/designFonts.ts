// FILE: designFonts.ts
// Purpose: The fonts the 设计 editor offers: the design system's families, the two fonts Moss
//          ships inside the app (Inter, JetBrains Mono), and the Chinese and Latin fonts the
//          operating systems used in mainland China already have.
// Layer: Shared model (web font picker; agents read the same list in the guide)
// Why: Web font services (Google Fonts) are unreachable in mainland China. Every
//      font here loads with no network request, so an artboard looks the same on every Moss.

export type DesignFontGroup = "system" | "bundled" | "chinese" | "latin";

export interface DesignFont {
  readonly id: string;
  readonly label: string;
  /** The CSS `font-family` value written into the artboard. */
  readonly stack: string;
  readonly group: DesignFontGroup;
  /** Shipped inside Moss; the editor declares it in every artboard frame. */
  readonly bundled?: "inter" | "jetbrains-mono";
}

export const DESIGN_FONT_GROUP_LABELS: Record<DesignFontGroup, string> = {
  system: "设计系统",
  bundled: "Moss 自带",
  chinese: "中文（系统自带）",
  latin: "西文（系统自带）",
};

export const DESIGN_FONTS: readonly DesignFont[] = [
  { id: "ds-sans", label: "无衬线（设计系统）", stack: "var(--ds-font-sans)", group: "system" },
  { id: "ds-serif", label: "衬线（设计系统）", stack: "var(--ds-font-serif)", group: "system" },
  { id: "ds-mono", label: "等宽（设计系统）", stack: "var(--ds-font-mono)", group: "system" },
  {
    id: "inter",
    label: "Inter",
    stack: '"Inter Variable", "Inter", system-ui, sans-serif',
    group: "bundled",
    bundled: "inter",
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
    group: "bundled",
    bundled: "jetbrains-mono",
  },
  {
    id: "pingfang",
    label: "苹方 / 微软雅黑",
    stack: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans SC", sans-serif',
    group: "chinese",
  },
  {
    id: "source-han-sans",
    label: "思源黑体",
    stack: '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif',
    group: "chinese",
  },
  {
    id: "heiti",
    label: "黑体",
    stack: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
    group: "chinese",
  },
  {
    id: "songti",
    label: "宋体",
    stack: '"Songti SC", "SimSun", "STSong", "Noto Serif SC", serif',
    group: "chinese",
  },
  {
    id: "source-han-serif",
    label: "思源宋体",
    stack: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif',
    group: "chinese",
  },
  {
    id: "kaiti",
    label: "楷体",
    stack: '"Kaiti SC", "KaiTi", "STKaiti", serif',
    group: "chinese",
  },
  {
    id: "fangsong",
    label: "仿宋",
    stack: '"STFangsong", "FangSong", serif',
    group: "chinese",
  },
  { id: "system-ui", label: "系统界面字体", stack: "system-ui, sans-serif", group: "latin" },
  {
    id: "helvetica",
    label: "Helvetica / Arial",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    group: "latin",
  },
  { id: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif", group: "latin" },
  { id: "georgia", label: "Georgia", stack: "Georgia, serif", group: "latin" },
  {
    id: "times",
    label: "Times New Roman",
    stack: '"Times New Roman", Times, serif',
    group: "latin",
  },
  {
    id: "mono",
    label: "Menlo / Consolas",
    stack: "Menlo, Consolas, ui-monospace, monospace",
    group: "latin",
  },
];

/** A `font-family` value without quotes or spacing, as browsers may read it back. */
const normalizeStack = (value: string) =>
  value
    .replace(/["']/gu, "")
    .replace(/\s*,\s*/gu, ",")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/** The listed font whose stack this `font-family` value is, if any. */
export function findDesignFont(fontFamily: string): DesignFont | undefined {
  const normalized = normalizeStack(fontFamily);
  return DESIGN_FONTS.find((font) => normalizeStack(font.stack) === normalized);
}

/** A family name a person typed (an installed font): quoted, with a generic fallback. */
export function customFontStack(name: string): string | null {
  const clean = name.replace(/["';{}<>\\]/gu, "").trim();
  if (!clean || clean.length > 60) return null;
  return `"${clean}", sans-serif`;
}
