// FILE: slidesDeck.ts
// Purpose: The 幻灯片 (kind `slides`) document, schema v2: a 1920×1080 deck of sections and
//          slides holding text, image, shape, line, table and chart elements; its validator
//          (which also upgrades #378's v1 decks), its constructors and its text projection.
// Layer: Shared model (server validates and projects; web renders, presents and exports;
//        the Moss Canvas deck editor edits the same JSON — see slides/DECK-SCHEMA.md)
// Why: One engine-neutral shape lets the canvas editor, the read-only renderer, the agent
//      tools and PPTX/PDF export agree without any of them owning the format.

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;
export const SLIDES_DATA_LIMITS = {
  bytes: 2_000_000,
  slides: 300,
  elements: 120,
  sections: 40,
  tableRows: 30,
  tableColumns: 12,
  chartPoints: 60,
} as const;

export const SLIDE_LAYOUTS = [
  "blank",
  "title",
  "section",
  "title-body",
  "bullets",
  "two-columns",
  "table",
  "quote",
  "image-caption",
  "closing",
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const SLIDE_SHAPES = [
  "rect",
  "roundRect",
  "ellipse",
  "diamond",
  "triangle",
  "arrowRight",
  "arrowLeft",
  "arrowUp",
  "arrowDown",
] as const;
export type SlideShape = (typeof SLIDE_SHAPES)[number];

export const TEXT_STYLE_IDS = [
  "display",
  "title",
  "heading",
  "subheading",
  "body",
  "caption",
  "label",
] as const;
export type TextStyleId = (typeof TEXT_STYLE_IDS)[number];
/** How a slide leaves for the next one in 演示; `magic` moves elements that share an id
 *  between the two slides into their new place (神奇移动), the rest fade. */
export const SLIDE_TRANSITIONS = ["none", "fade", "push", "wipe", "magic"] as const;
export type SlideTransition = (typeof SLIDE_TRANSITIONS)[number];
/** How an element arrives in 演示 (逐个出现), one step per `order`. */
export const BUILD_EFFECTS = ["fade", "rise", "drop", "left", "right", "scale", "pop"] as const;
export type BuildEffect = (typeof BUILD_EFFECTS)[number];
export interface ElementBuild {
  readonly effect: BuildEffect;
  /** 1–50; elements with the same order arrive together. */
  readonly order: number;
  /** Arrives by itself shortly after the slide (or the previous step) instead of on a click. */
  readonly auto?: boolean;
}
/** List paragraphs nest up to nine levels (0–8). */
export const MAX_LIST_LEVEL = 8;
export type ListLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const LIST_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
/** Moss's own icon set (Central outline names, served at /central-icons-reversed/<name>.svg). */
export const ICON_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** The icons a slide can hold: a closed set, like Claude's, so every one ships in the app. */
export const SLIDE_ICON_NAMES = [
  "heart-beat",
  "book",
  "chart-2",
  "bubble-text",
  "checkmark-1",
  "circle-check",
  "clock",
  "cloud",
  "code-brackets",
  "server",
  "globe",
  "graduate-cap",
  "home",
  "key-2",
  "light-bulb",
  "lightning",
  "chain-link-1",
  "lock",
  "paper-plane",
  "play",
  "magnifying-glass",
  "settings-gear-1",
  "star",
  "thumbs-up",
  "hammer",
  "shield-check",
  "people",
  "exclamation-triangle",
  "rocket",
  "target",
  "trophy",
  "flag-1",
  "calendar-1",
  "heart",
  "user-group",
] as const;
export type SlideIconName = (typeof SLIDE_ICON_NAMES)[number];
/** A web embed is one small sandboxed page: no network, no forms, no navigation. */
export const EMBED_HTML_LIMIT = 16_000;

/** Where an icon element's glyph is served (same origin as the deck editor and viewer). */
export function slideIconUrl(name: string): string | null {
  return ICON_NAME.test(name) ? `/central-icons-reversed/${name}.svg` : null;
}
/** The document a web embed runs as, inside an iframe with `sandbox="allow-scripts"` only:
 *  a CSP with no network at all, a transparent page, and the embed's own markup. */
export function embedDocument(html: string): string {
  // Its own <meta> (a refresh could load a web page into the frame) and <base> are dropped.
  const body = html.replace(/<\/?(?:meta|base)\b[^>]*>/giu, "");
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}</style></head><body>${body}</body></html>`;
}
export const CHART_KINDS = ["bar", "column", "line", "pie", "donut"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export type TextAlign = "left" | "center" | "right" | "justify";
export type TextRole = "title" | "subtitle" | "body" | "caption" | "label";
export type FontWeight = 300 | 400 | 500 | 600 | 700 | 800;

export interface TextStyle {
  readonly font?: string;
  readonly size: number;
  readonly weight: FontWeight;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly color?: string;
}
export interface DeckTheme {
  readonly name?: string;
  readonly colors: {
    readonly background: string;
    readonly surface: string;
    readonly text: string;
    readonly muted: string;
    readonly accent: string;
    readonly accent2?: string;
    readonly border?: string;
    /** Palette for dark statement / section slides. */
    readonly inverse?: {
      readonly background: string;
      readonly text: string;
      readonly muted: string;
      readonly accent: string;
    };
  };
  readonly fonts: { readonly heading: string; readonly body: string };
  readonly textStyles: Readonly<Record<TextStyleId, TextStyle>>;
}

export type Fill =
  | { readonly type: "solid"; readonly color: string; readonly opacity?: number }
  | {
      readonly type: "gradient";
      readonly from: string;
      readonly to: string;
      readonly angle: number;
    }
  | { readonly type: "image"; readonly src: string; readonly fit: "cover" | "contain" }
  | { readonly type: "none" };
export interface Stroke {
  readonly color: string;
  readonly width: number;
  readonly dash: "solid" | "dash" | "dot";
  readonly opacity?: number;
}
export interface Shadow {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly color: string;
  readonly opacity: number;
}

export interface Run {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly color?: string;
  readonly link?: string;
  readonly size?: number;
  readonly font?: string;
}
export interface Paragraph {
  readonly runs: readonly Run[];
  readonly align?: TextAlign;
  readonly list?: "bullet" | "number";
  readonly level?: ListLevel;
}
export interface TextBody {
  readonly paragraphs: readonly Paragraph[];
  readonly style: TextStyleId;
  readonly font?: string;
  readonly size?: number;
  readonly weight?: FontWeight;
  readonly lineHeight?: number;
  readonly letterSpacing?: number;
  readonly color?: string;
  readonly align: TextAlign;
  readonly vAlign: "top" | "middle" | "bottom";
  readonly autofit: "none" | "shrink" | "grow";
}

export type SlideLink = { readonly url: string } | { readonly slideId: string };
interface ElementBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation?: number;
  readonly opacity?: number;
  readonly locked?: boolean;
  readonly name?: string;
  readonly groupId?: string;
  readonly link?: SlideLink;
  readonly fill?: Fill;
  readonly border?: Stroke;
  readonly radius?: number;
  readonly shadow?: Shadow;
  readonly padding?: number;
  /** 演示 only: how and when the element arrives (逐个出现). */
  readonly build?: ElementBuild;
}
export interface TextElement extends ElementBase {
  readonly type: "text";
  readonly role?: TextRole;
  readonly body: TextBody;
}
export interface ImageElement extends ElementBase {
  readonly type: "image";
  readonly src: string;
  readonly alt?: string;
  readonly fit: "cover" | "contain";
  readonly crop?: {
    readonly l: number;
    readonly t: number;
    readonly r: number;
    readonly b: number;
  };
}
export interface ShapeElement extends ElementBase {
  readonly type: "shape";
  readonly shape: SlideShape;
  readonly body?: TextBody;
}
export type LineEnd = "none" | "arrow" | "dot";
export type ConnectorAnchor = "top" | "right" | "bottom" | "left" | "center";
export interface LineElement extends ElementBase {
  readonly type: "line";
  readonly points: readonly [
    { readonly x: number; readonly y: number },
    { readonly x: number; readonly y: number },
  ];
  readonly stroke: Stroke;
  /** Straight (default) or an elbow connector routed with right angles. */
  readonly route?: "straight" | "elbow";
  readonly startArrow?: LineEnd;
  readonly endArrow?: LineEnd;
  readonly connector?: {
    readonly from?: { readonly elementId: string; readonly anchor: ConnectorAnchor };
    readonly to?: { readonly elementId: string; readonly anchor: ConnectorAnchor };
  };
}
export interface TableCell {
  readonly body: TextBody;
  readonly fill?: string;
  readonly colSpan?: number;
  readonly rowSpan?: number;
}
export interface TableElement extends ElementBase {
  readonly type: "table";
  readonly columns: readonly number[];
  readonly rows: readonly { readonly height: number; readonly cells: readonly TableCell[] }[];
  readonly header: boolean;
  readonly banded: boolean;
  readonly style: {
    readonly headerFill: string;
    readonly headerText: string;
    readonly bandFill?: string;
    readonly border: Stroke;
    readonly fontSize: number;
  };
}
export interface ChartElement extends ElementBase {
  readonly type: "chart";
  readonly kind: ChartKind;
  readonly labels: readonly string[];
  readonly series: readonly {
    readonly name: string;
    readonly values: readonly number[];
    readonly color?: string;
  }[];
  readonly legend: boolean;
  readonly showValues: boolean;
}
/** One icon of Moss's icon set, drawn in one colour. */
export interface IconElement extends ElementBase {
  readonly type: "icon";
  readonly name: string;
  readonly color?: string;
}
/** A video clip: a Moss /api/ media path or an https file. The poster stands in for it in exports. */
export interface VideoElement extends ElementBase {
  readonly type: "video";
  readonly src: string;
  readonly poster?: string;
  readonly alt?: string;
  /** Plays by itself when its slide appears in 演示. */
  readonly autoplay?: boolean;
  readonly loop?: boolean;
  readonly muted?: boolean;
  /** Seconds into the clip where it starts. */
  readonly start?: number;
}
/** A small live web page (HTML, CSS and script, no network), sandboxed; a still in exports. */
export interface EmbedElement extends ElementBase {
  readonly type: "embed";
  readonly html: string;
  readonly title?: string;
}
export type SlideElement =
  | TextElement
  | ImageElement
  | ShapeElement
  | LineElement
  | TableElement
  | ChartElement
  | IconElement
  | VideoElement
  | EmbedElement;
export type SlideElementType = SlideElement["type"];

export interface DeckSection {
  readonly id: string;
  readonly title: string;
}
export interface Slide {
  readonly id: string;
  readonly sectionId: string | null;
  readonly layout: SlideLayout;
  readonly background: Fill;
  readonly transition: SlideTransition;
  readonly hidden?: boolean;
  readonly notes: string;
  readonly elements: readonly SlideElement[];
}
export interface SlidesDeck {
  readonly version: 2;
  readonly size: { readonly width: typeof SLIDE_WIDTH; readonly height: typeof SLIDE_HEIGHT };
  /** The slide shown on 资料空间 cards (设为封面); default the first slide. */
  readonly coverSlideId?: string;
  readonly theme: DeckTheme;
  readonly sections: readonly DeckSection[];
  readonly slides: readonly Slide[];
}

const SANS = "Noto Sans SC";
export const MOSS_FONT_FALLBACK =
  '"Inter Variable", Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
export const DECK_FONTS = [
  "Noto Sans SC",
  "Noto Serif SC",
  "Inter",
  "Source Han Sans SC",
  "Microsoft YaHei",
  "Georgia",
] as const;

export const defaultTextStyles = (text: string, muted: string): Record<TextStyleId, TextStyle> => ({
  display: { size: 96, weight: 700, lineHeight: 1.1, letterSpacing: -1, color: text },
  title: { size: 72, weight: 700, lineHeight: 1.15, letterSpacing: -0.5, color: text },
  heading: { size: 48, weight: 600, lineHeight: 1.2, letterSpacing: 0, color: text },
  subheading: { size: 36, weight: 500, lineHeight: 1.3, letterSpacing: 0, color: muted },
  body: { size: 28, weight: 400, lineHeight: 1.5, letterSpacing: 0, color: text },
  caption: { size: 20, weight: 400, lineHeight: 1.4, letterSpacing: 0, color: muted },
  label: { size: 18, weight: 600, lineHeight: 1.3, letterSpacing: 1, color: muted },
});

export const DEFAULT_DECK_THEME: DeckTheme = {
  name: "留白",
  colors: {
    background: "#F7F6F3",
    surface: "#FFFFFF",
    text: "#252420",
    muted: "#6B6A66",
    accent: "#C4623F",
    accent2: "#2F6F5E",
    border: "#DEDBD3",
  },
  fonts: { heading: SANS, body: SANS },
  textStyles: defaultTextStyles("#252420", "#6B6A66"),
};

const HEX = /^#[0-9A-Fa-f]{6}$/u;
export const THEME_COLOR_REFS = [
  "@background",
  "@surface",
  "@text",
  "@muted",
  "@accent",
  "@accent2",
  "@border",
  "@inverse.background",
  "@inverse.text",
  "@inverse.muted",
  "@inverse.accent",
] as const;
export type ThemeColorRef = (typeof THEME_COLOR_REFS)[number];

/** A slide color as paintable #RRGGBB: theme references resolve against `theme`. */
export function resolveColor(value: string, theme: DeckTheme): string {
  if (!value.startsWith("@")) return value;
  const key = value.slice(1);
  const colors = theme.colors;
  if (key.startsWith("inverse.")) {
    const inverse = colors.inverse ?? {
      background: colors.text,
      text: colors.background,
      muted: colors.border ?? colors.muted,
      accent: colors.accent,
    };
    return inverse[key.slice(8) as keyof typeof inverse] ?? colors.text;
  }
  return (
    (colors[key as keyof Omit<DeckTheme["colors"], "inverse">] as string | undefined) ??
    (key === "accent2" ? colors.accent : key === "border" ? colors.muted : colors.text)
  );
}
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/u;
const LOCAL_PATH = /^\/api\/[A-Za-z0-9/_.~%-]+(?:\?[A-Za-z0-9=&_.~%-]*)?$/u;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

let fallbackCounter = 0;
/** Short ids are enough: they only need to be unique inside one deck. */
export function newSlideId(prefix = "s"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 10)
      : `${Date.now().toString(36)}${(fallbackCounter++).toString(36)}`;
  return `${prefix}${random}`;
}

export class SlidesDeckError extends Error {}
function fail(message: string): never {
  throw new SlidesDeckError(`Invalid slides deck: ${message}`);
}
function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${where} must be an object`);
  for (const key of Object.keys(value))
    if (forbiddenKeys.has(key)) fail(`${where} has a forbidden key`);
  return value as Record<string, unknown>;
}
function array(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (value.length > max) fail(`${where} has more than ${max} items`);
  return value;
}
function string(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value.length > max)
    fail(`${where} must be a string of at most ${max} characters`);
  return value;
}
function id(value: unknown, where: string): string {
  const text = string(value, where, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(text)) fail(`${where} must be 1-64 letters, digits, _ or -`);
  return text;
}
/** Theme colors themselves are always literal #RRGGBB. */
function hexColor(value: unknown, where: string): string {
  if (typeof value !== "string" || !HEX.test(value)) fail(`${where} must be a #RRGGBB color`);
  return value.toUpperCase();
}
/** Colors inside slides: #RRGGBB, or a theme reference such as "@accent" that follows the theme. */
function color(value: unknown, where: string): string {
  if (typeof value === "string" && (THEME_COLOR_REFS as readonly string[]).includes(value))
    return value;
  if (typeof value !== "string" || !HEX.test(value))
    fail(`${where} must be a #RRGGBB color or a theme color such as @accent`);
  return value.toUpperCase();
}
function number(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${where} must be a number between ${min} and ${max}`);
  }
  return Math.round(value * 100) / 100;
}
function oneOf<T extends string | number>(value: unknown, options: readonly T[], where: string): T {
  if (!(options as readonly unknown[]).includes(value)) {
    fail(`${where} must be one of ${options.join(", ")}`);
  }
  return value as T;
}
const opt = <T>(value: unknown, read: (value: unknown) => T): T | undefined =>
  value === undefined || value === null ? undefined : read(value);
/**
 * With strict null checking, make possibly undefined properties optional.
 * Without it, undefined extends every property type: preserve T rather than
 * incorrectly making required fields such as an element's type and id optional.
 */
export type Compact<T> = undefined extends number
  ? T
  : {
      [K in keyof T as undefined extends T[K] ? never : K]: T[K];
    } & {
      [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
    };
/** Drops undefined fields so stored JSON stays small and stable. */
export function compact<T extends object>(value: T): Compact<T> {
  for (const key of Object.keys(value) as (keyof T)[])
    if (value[key] === undefined) delete value[key];
  return value as Compact<T>;
}

export function isDurableSlideImageSource(src: string): boolean {
  if (DATA_IMAGE.test(src)) return true;
  if (LOCAL_PATH.test(src)) return !src.includes("..") && !src.includes("//");
  try {
    const url = new URL(src);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function imageSrc(value: unknown, where: string): string {
  const src = string(value, where, 1_500_000);
  if (!isDurableSlideImageSource(src))
    fail(`${where} must be an https URL, a Moss /api/ media path or an inline image`);
  return src;
}
function videoSrc(value: unknown, where: string): string {
  const src = string(value, where, 4_000);
  if (src.startsWith("data:") || !isDurableSlideImageSource(src))
    fail(`${where} must be an https URL or a Moss /api/ media path`);
  return src;
}
function safeUrl(value: unknown, where: string): string {
  const text = string(value, where, 2_000);
  try {
    const url = new URL(text);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:")
      return text;
  } catch {
    /* fall through */
  }
  return fail(`${where} must be an http(s) or mailto link`);
}

function fill(raw: unknown, where: string): Fill {
  if (typeof raw === "string") return { type: "solid", color: color(raw, where) };
  const value = record(raw, where);
  switch (value.type) {
    case "solid":
      return compact({
        type: "solid" as const,
        color: color(value.color, `${where}.color`),
        opacity: opt(value.opacity, (v) => number(v, `${where}.opacity`, 0, 1)),
      });
    case "gradient":
      return {
        type: "gradient",
        from: color(value.from, `${where}.from`),
        to: color(value.to, `${where}.to`),
        angle: number(value.angle ?? 90, `${where}.angle`, -360, 360),
      };
    case "image":
      return {
        type: "image",
        src: imageSrc(value.src, `${where}.src`),
        fit: oneOf(value.fit ?? "cover", ["cover", "contain"] as const, `${where}.fit`),
      };
    case "none":
      return { type: "none" };
    default:
      return fail(`${where}.type must be solid, gradient, image or none`);
  }
}
function stroke(raw: unknown, where: string): Stroke {
  const value = record(raw, where);
  return compact({
    color: color(value.color, `${where}.color`),
    width: number(value.width ?? 1, `${where}.width`, 0, 64),
    dash: oneOf(value.dash ?? "solid", ["solid", "dash", "dot"] as const, `${where}.dash`),
    opacity: opt(value.opacity, (v) => number(v, `${where}.opacity`, 0, 1)),
  });
}
function shadow(raw: unknown, where: string): Shadow {
  const value = record(raw, where);
  return {
    x: number(value.x ?? 0, `${where}.x`, -200, 200),
    y: number(value.y ?? 8, `${where}.y`, -200, 200),
    blur: number(value.blur ?? 24, `${where}.blur`, 0, 400),
    color: color(value.color ?? "#000000", `${where}.color`),
    opacity: number(value.opacity ?? 0.2, `${where}.opacity`, 0, 1),
  };
}

const ALIGNS = ["left", "center", "right", "justify"] as const;
const WEIGHTS = [300, 400, 500, 600, 700, 800] as const;
function run(raw: unknown, where: string): Run {
  if (typeof raw === "string") return { text: raw.slice(0, 20_000) };
  const value = record(raw, where);
  return compact({
    text: string(value.text ?? "", `${where}.text`, 20_000),
    bold: value.bold === true ? true : undefined,
    italic: value.italic === true ? true : undefined,
    underline: value.underline === true ? true : undefined,
    strike: value.strike === true ? true : undefined,
    color: opt(value.color, (v) => color(v, `${where}.color`)),
    link: opt(value.link, (v) => safeUrl(v, `${where}.link`)),
    size: opt(value.size, (v) => number(v, `${where}.size`, 6, 400)),
    font: opt(value.font, (v) => string(v, `${where}.font`, 80)),
  });
}
function paragraph(raw: unknown, where: string): Paragraph {
  if (typeof raw === "string") return { runs: [{ text: raw.slice(0, 20_000) }] };
  const value = record(raw, where);
  const runs = array(value.runs ?? [], `${where}.runs`, 200).map((item, i) =>
    run(item, `${where}.runs[${i}]`),
  );
  return compact({
    runs,
    align: opt(value.align, (v) => oneOf(v, ALIGNS, `${where}.align`)),
    list: opt(value.list, (v) => oneOf(v, ["bullet", "number"] as const, `${where}.list`)),
    level: opt(value.level, (v) => oneOf(v, LIST_LEVELS, `${where}.level`)),
  });
}

/** Plain text (one paragraph per line; "- " / "1. " lines become list items) as paragraphs. */
export function paragraphsFromText(text: string): Paragraph[] {
  return text.split(/\r?\n/u).map((line): Paragraph => {
    const level = Math.min(
      MAX_LIST_LEVEL,
      Math.floor((/^\s*/u.exec(line)?.[0].length ?? 0) / 2),
    ) as ListLevel;
    const bullet = /^\s*[-*•]\s+(.*)$/u.exec(line);
    if (bullet)
      return compact({
        runs: [{ text: bullet[1]! }],
        list: "bullet" as const,
        level: level || undefined,
      });
    const numbered = /^\s*\d+[.)、]\s*(.*)$/u.exec(line);
    if (numbered && /^\s*\d+[.)、]\s/u.test(line))
      return compact({
        runs: [{ text: numbered[1]! }],
        list: "number" as const,
        level: level || undefined,
      });
    return { runs: [{ text: line }] };
  });
}

function textBody(raw: unknown, where: string, fallbackStyle: TextStyleId): TextBody {
  const value =
    typeof raw === "string" ? { text: raw } : (record(raw, where) as Record<string, unknown>);
  const paragraphs =
    value.paragraphs !== undefined
      ? array(value.paragraphs, `${where}.paragraphs`, 400).map((item, i) =>
          paragraph(item, `${where}.paragraphs[${i}]`),
        )
      : paragraphsFromText(string(value.text ?? "", `${where}.text`, 20_000));
  return compact({
    paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }],
    style: oneOf(value.style ?? fallbackStyle, TEXT_STYLE_IDS, `${where}.style`),
    font: opt(value.font, (v) => string(v, `${where}.font`, 80)),
    size: opt(value.size ?? value.fontSize, (v) => number(v, `${where}.size`, 6, 400)),
    weight: opt(value.weight, (v) => oneOf(v, WEIGHTS, `${where}.weight`)),
    lineHeight: opt(value.lineHeight, (v) => number(v, `${where}.lineHeight`, 0.6, 4)),
    letterSpacing: opt(value.letterSpacing, (v) => number(v, `${where}.letterSpacing`, -20, 60)),
    color: opt(value.color, (v) => color(v, `${where}.color`)),
    align: oneOf(value.align ?? "left", ALIGNS, `${where}.align`),
    vAlign: oneOf(value.vAlign ?? "top", ["top", "middle", "bottom"] as const, `${where}.vAlign`),
    autofit: oneOf(
      value.autofit ?? "none",
      ["none", "shrink", "grow"] as const,
      `${where}.autofit`,
    ),
  });
}

export const ROLE_STYLE: Record<TextRole, TextStyleId> = {
  title: "title",
  subtitle: "subheading",
  body: "body",
  caption: "caption",
  label: "label",
};
const ANCHORS = ["top", "right", "bottom", "left", "center"] as const;
function endpoint(raw: unknown, where: string) {
  const value = record(raw, where);
  return {
    elementId: id(value.elementId, `${where}.elementId`),
    anchor: oneOf(value.anchor ?? "center", ANCHORS, `${where}.anchor`),
  };
}
function point(raw: unknown, where: string) {
  const value = record(raw, where);
  return {
    x: number(value.x, `${where}.x`, -SLIDE_WIDTH, SLIDE_WIDTH * 2),
    y: number(value.y, `${where}.y`, -SLIDE_HEIGHT, SLIDE_HEIGHT * 2),
  };
}

function tableCell(rawCell: unknown, at: string): TableCell {
  const cell =
    typeof rawCell === "string" || typeof rawCell === "number"
      ? { body: String(rawCell) }
      : (record(rawCell, at) as Record<string, unknown>);
  return compact({
    body: textBody(cell.body ?? cell.text ?? "", `${at}.body`, "body"),
    fill: opt(cell.fill, (v) => color(v, `${at}.fill`)),
    colSpan: opt(cell.colSpan, (v) => number(v, `${at}.colSpan`, 1, 12)),
    rowSpan: opt(cell.rowSpan, (v) => number(v, `${at}.rowSpan`, 1, 30)),
  });
}

/** Validates one element (also used by deck ops for agent-supplied elements). */
export function parseSlideElement(raw: unknown, where = "element"): SlideElement {
  const value = record(raw, where);
  const box = compact({
    id: id(value.id, `${where}.id`),
    x: number(value.x, `${where}.x`, -SLIDE_WIDTH, SLIDE_WIDTH * 2),
    y: number(value.y, `${where}.y`, -SLIDE_HEIGHT, SLIDE_HEIGHT * 2),
    w: number(value.w, `${where}.w`, 0, SLIDE_WIDTH * 3),
    h: number(value.h, `${where}.h`, 0, SLIDE_HEIGHT * 3),
    rotation: opt(value.rotation, (v) => number(v, `${where}.rotation`, -360, 360)) || undefined,
    opacity: opt(value.opacity, (v) => number(v, `${where}.opacity`, 0, 1)),
    locked: value.locked === true ? true : undefined,
    name: opt(value.name, (v) => string(v, `${where}.name`, 120)),
    groupId: opt(value.groupId, (v) => id(v, `${where}.groupId`)),
    link: opt(value.link, (v): SlideLink => {
      const link = record(v, `${where}.link`);
      return link.slideId !== undefined
        ? { slideId: id(link.slideId, `${where}.link.slideId`) }
        : { url: safeUrl(link.url, `${where}.link.url`) };
    }),
    fill: opt(value.fill, (v) => fill(v, `${where}.fill`)),
    border: opt(value.border, (v) => stroke(v, `${where}.border`)),
    radius: opt(value.radius, (v) => number(v, `${where}.radius`, 0, 1000)),
    shadow: opt(value.shadow, (v) => shadow(v, `${where}.shadow`)),
    padding: opt(value.padding, (v) => number(v, `${where}.padding`, 0, 400)),
    build: opt(value.build, (v): ElementBuild => {
      const build = record(v, `${where}.build`);
      return compact({
        effect: oneOf(build.effect ?? "fade", BUILD_EFFECTS, `${where}.build.effect`),
        order: Math.round(number(build.order ?? 1, `${where}.build.order`, 1, 50)),
        auto: build.auto === true ? true : undefined,
      });
    }),
  });
  switch (value.type) {
    case "text": {
      const role = opt(value.role, (v) =>
        oneOf(v, ["title", "subtitle", "body", "caption", "label"] as const, `${where}.role`),
      );
      return compact({
        ...box,
        type: "text" as const,
        role,
        // Without a body, the element's own text and style fields (text, color, size…) are it.
        body: textBody(value.body ?? value, `${where}.body`, role ? ROLE_STYLE[role] : "body"),
      });
    }
    case "image":
      return compact({
        ...box,
        type: "image" as const,
        src: imageSrc(value.src, `${where}.src`),
        alt: opt(value.alt, (v) => string(v, `${where}.alt`, 1_000)),
        fit: oneOf(value.fit ?? "cover", ["cover", "contain"] as const, `${where}.fit`),
        crop: opt(value.crop, (v) => {
          const crop = record(v, `${where}.crop`);
          const side = (key: string) => number(crop[key] ?? 0, `${where}.crop.${key}`, 0, 0.95);
          return { l: side("l"), t: side("t"), r: side("r"), b: side("b") };
        }),
      });
    case "shape":
      return compact({
        ...box,
        type: "shape" as const,
        shape: oneOf(value.shape, SLIDE_SHAPES, `${where}.shape`),
        fill: box.fill ?? ({ type: "solid", color: "#DEDBD3" } as Fill),
        body: opt(
          value.body ??
            (value.text === undefined
              ? undefined
              : {
                  align: "center",
                  vAlign: "middle",
                  autofit: "shrink",
                  ...value,
                  color: value.textColor ?? value.color,
                }),
          (v) => textBody(v, `${where}.body`, "body"),
        ),
      });
    case "line": {
      const points = array(value.points, `${where}.points`, 2);
      if (points.length !== 2) fail(`${where}.points must hold two points`);
      const ends = ["none", "arrow", "dot"] as const;
      return compact({
        ...box,
        type: "line" as const,
        points: [
          point(points[0], `${where}.points[0]`),
          point(points[1], `${where}.points[1]`),
        ] as [{ x: number; y: number }, { x: number; y: number }],
        stroke: stroke(value.stroke ?? { color: "#252420", width: 3 }, `${where}.stroke`),
        route: opt(value.route, (v) => oneOf(v, ["straight", "elbow"] as const, `${where}.route`)),
        startArrow: opt(value.startArrow, (v) => oneOf(v, ends, `${where}.startArrow`)),
        endArrow: opt(value.endArrow, (v) => oneOf(v, ends, `${where}.endArrow`)),
        connector: opt(value.connector, (v) => {
          const connector = record(v, `${where}.connector`);
          return compact({
            from: opt(connector.from, (e) => endpoint(e, `${where}.connector.from`)),
            to: opt(connector.to, (e) => endpoint(e, `${where}.connector.to`)),
          });
        }),
      });
    }
    case "table": {
      const rows = array(value.rows, `${where}.rows`, SLIDES_DATA_LIMITS.tableRows).map(
        (rawRow, r) => {
          const row = Array.isArray(rawRow)
            ? { cells: rawRow }
            : (record(rawRow, `${where}.rows[${r}]`) as Record<string, unknown>);
          return {
            height: number(row.height ?? 64, `${where}.rows[${r}].height`, 8, SLIDE_HEIGHT),
            cells: array(
              row.cells,
              `${where}.rows[${r}].cells`,
              SLIDES_DATA_LIMITS.tableColumns,
            ).map((cell, c) => tableCell(cell, `${where}.rows[${r}].cells[${c}]`)),
          };
        },
      );
      const width = Math.max(1, ...rows.map((row) => row.cells.length));
      const columns =
        value.columns === undefined
          ? Array.from({ length: width }, () => Math.round((box.w / width) * 100) / 100)
          : array(value.columns, `${where}.columns`, SLIDES_DATA_LIMITS.tableColumns).map((v, i) =>
              number(v, `${where}.columns[${i}]`, 4, SLIDE_WIDTH * 2),
            );
      const style = record(value.style ?? {}, `${where}.style`);
      return {
        ...box,
        type: "table",
        columns,
        rows,
        header: value.header !== false,
        banded: value.banded === true,
        style: compact({
          headerFill: color(style.headerFill ?? "#252420", `${where}.style.headerFill`),
          headerText: color(style.headerText ?? "#FFFFFF", `${where}.style.headerText`),
          bandFill: opt(style.bandFill, (v) => color(v, `${where}.style.bandFill`)),
          border: stroke(style.border ?? { color: "#DEDBD3", width: 1 }, `${where}.style.border`),
          fontSize: number(style.fontSize ?? 22, `${where}.style.fontSize`, 6, 120),
        }),
      };
    }
    case "chart": {
      const labels = array(value.labels, `${where}.labels`, SLIDES_DATA_LIMITS.chartPoints).map(
        (v, i) => string(String(v), `${where}.labels[${i}]`, 120),
      );
      const series = array(value.series, `${where}.series`, 12).map((rawSeries, s) => {
        const item = record(rawSeries, `${where}.series[${s}]`);
        return compact({
          name: string(item.name ?? `系列 ${s + 1}`, `${where}.series[${s}].name`, 120),
          values: array(
            item.values,
            `${where}.series[${s}].values`,
            SLIDES_DATA_LIMITS.chartPoints,
          ).map((v, i) => number(v, `${where}.series[${s}].values[${i}]`, -1e12, 1e12)),
          color: opt(item.color, (v) => color(v, `${where}.series[${s}].color`)),
        });
      });
      return {
        ...box,
        type: "chart",
        kind: oneOf(value.kind ?? "column", CHART_KINDS, `${where}.kind`),
        labels,
        series,
        legend: value.legend !== false,
        showValues: value.showValues === true,
      };
    }
    case "icon": {
      const name = oneOf(value.name, SLIDE_ICON_NAMES, `${where}.name`);
      return compact({
        ...box,
        type: "icon" as const,
        name,
        color: opt(value.color, (v) => color(v, `${where}.color`)),
      });
    }
    case "video":
      return compact({
        ...box,
        type: "video" as const,
        src: videoSrc(value.src, `${where}.src`),
        poster: opt(value.poster, (v) => imageSrc(v, `${where}.poster`)),
        alt: opt(value.alt, (v) => string(v, `${where}.alt`, 1_000)),
        autoplay: value.autoplay === true ? true : undefined,
        loop: value.loop === true ? true : undefined,
        muted: value.muted === true ? true : undefined,
        start: opt(value.start, (v) => number(v, `${where}.start`, 0, 86_400)) || undefined,
      });
    case "embed":
      return compact({
        ...box,
        type: "embed" as const,
        html: string(value.html, `${where}.html`, EMBED_HTML_LIMIT),
        title: opt(value.title, (v) => string(v, `${where}.title`, 200)),
      });
    default:
      return fail(
        `${where}.type must be text, image, shape, line, table, chart, icon, video or embed`,
      );
  }
}

function textStyle(raw: unknown, where: string, fallback: TextStyle): TextStyle {
  const value = raw === undefined ? {} : record(raw, where);
  return compact({
    font: opt(value.font ?? fallback.font, (v) => string(v, `${where}.font`, 80)),
    size: number(value.size ?? fallback.size, `${where}.size`, 6, 400),
    weight: oneOf(value.weight ?? fallback.weight, WEIGHTS, `${where}.weight`),
    lineHeight: number(value.lineHeight ?? fallback.lineHeight, `${where}.lineHeight`, 0.6, 4),
    letterSpacing: number(
      value.letterSpacing ?? fallback.letterSpacing,
      `${where}.letterSpacing`,
      -20,
      60,
    ),
    color: opt(value.color ?? fallback.color, (v) => hexColor(v, `${where}.color`)),
  });
}

/** Validates a theme; missing parts come from `base`. New text colors restyle the text styles. */
export function parseDeckTheme(raw: unknown, base: DeckTheme = DEFAULT_DECK_THEME): DeckTheme {
  const value = raw === undefined ? {} : record(raw, "theme");
  const colors = value.colors === undefined ? {} : record(value.colors, "theme.colors");
  type Key = Exclude<keyof DeckTheme["colors"], "inverse">;
  const c = (key: Key) =>
    opt(colors[key] ?? base.colors[key], (v) => hexColor(v, `theme.colors.${key}`));
  const inverseRaw =
    colors.inverse === undefined
      ? base.colors.inverse
      : (record(colors.inverse, "theme.colors.inverse") as Record<string, unknown>);
  const parsedColors = compact({
    background: c("background")!,
    surface: c("surface")!,
    text: c("text")!,
    muted: c("muted")!,
    accent: c("accent")!,
    accent2: c("accent2"),
    border: c("border"),
    inverse: opt(inverseRaw, (v) => {
      const inv = v as Record<string, unknown>;
      return {
        background: hexColor(inv.background, "theme.colors.inverse.background"),
        text: hexColor(inv.text, "theme.colors.inverse.text"),
        muted: hexColor(inv.muted, "theme.colors.inverse.muted"),
        accent: hexColor(inv.accent, "theme.colors.inverse.accent"),
      };
    }),
  });
  const fonts = value.fonts === undefined ? {} : record(value.fonts, "theme.fonts");
  const styles = value.textStyles === undefined ? {} : record(value.textStyles, "theme.textStyles");
  const recolored =
    (colors.text !== undefined && colors.text !== base.colors.text) ||
    (colors.muted !== undefined && colors.muted !== base.colors.muted);
  const fresh = defaultTextStyles(parsedColors.text, parsedColors.muted);
  const textStyles = Object.fromEntries(
    TEXT_STYLE_IDS.map((key) => [
      key,
      textStyle(
        styles[key],
        `theme.textStyles.${key}`,
        recolored
          ? { ...base.textStyles[key], color: fresh[key].color ?? parsedColors.text }
          : base.textStyles[key],
      ),
    ]),
  ) as Record<TextStyleId, TextStyle>;
  return compact({
    name: opt(value.name ?? base.name, (v) => string(v, "theme.name", 60)),
    colors: parsedColors,
    fonts: {
      heading: string(fonts.heading ?? base.fonts.heading, "theme.fonts.heading", 80),
      body: string(fonts.body ?? base.fonts.body, "theme.fonts.body", 80),
    },
    textStyles,
  });
}

function slide(raw: unknown, index: number, theme: DeckTheme, sectionIds: Set<string>): Slide {
  const where = `slides[${index}]`;
  const value = record(raw, where);
  const elements = array(
    value.elements ?? [],
    `${where}.elements`,
    SLIDES_DATA_LIMITS.elements,
  ).map((item, i) => parseSlideElement(item, `${where}.elements[${i}]`));
  if (new Set(elements.map((item) => item.id)).size !== elements.length) {
    fail(`${where} has duplicate element ids`);
  }
  const sectionId =
    value.sectionId === undefined || value.sectionId === null
      ? null
      : id(value.sectionId, `${where}.sectionId`);
  return compact({
    id: id(value.id, `${where}.id`),
    sectionId: sectionId && sectionIds.has(sectionId) ? sectionId : null,
    layout: oneOf(value.layout ?? "blank", SLIDE_LAYOUTS, `${where}.layout`),
    background:
      value.background === undefined
        ? ({ type: "solid", color: theme.colors.background } as Fill)
        : fill(value.background, `${where}.background`),
    transition: oneOf(value.transition ?? "none", SLIDE_TRANSITIONS, `${where}.transition`),
    hidden: value.hidden === true ? true : undefined,
    notes: value.notes === undefined ? "" : string(value.notes, `${where}.notes`, 20_000),
    elements,
  });
}

/** #378's v1 deck (1280×720, plain-text boxes) as v2 JSON on the 1920×1080 stage. */
export function migrateDeckV1(value: Record<string, unknown>): Record<string, unknown> {
  const k = SLIDE_WIDTH / 1280;
  const v1Theme = (value.theme ?? {}) as Record<string, unknown>;
  const hex = (v: unknown, fallback: string) =>
    typeof v === "string" && HEX.test(v) ? v.toUpperCase() : fallback;
  const text = hex(v1Theme.text, "#1F1F1E");
  const muted = hex(v1Theme.muted, "#6B6A66");
  const theme = {
    name: "经典",
    colors: {
      background: hex(v1Theme.background, "#FFFFFF"),
      surface: "#FFFFFF",
      text,
      muted,
      accent: hex(v1Theme.accent, "#2F6F5E"),
    },
    fonts: { heading: SANS, body: SANS },
    textStyles: defaultTextStyles(text, muted),
  };
  const layoutMap: Record<string, SlideLayout> = {
    title: "title",
    "title-content": "title-body",
    "two-column": "two-columns",
    section: "section",
    "image-caption": "image-caption",
    blank: "blank",
  };
  const scale = (n: unknown) => (typeof n === "number" ? Math.round(n * k * 100) / 100 : n);
  const slides = Array.isArray(value.slides) ? value.slides : [];
  return {
    version: 2,
    theme,
    sections: [],
    slides: slides.map((raw) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const elements = Array.isArray(s.elements) ? s.elements : [];
      return {
        id: s.id,
        sectionId: null,
        layout: layoutMap[String(s.layout)] ?? "blank",
        background: s.background,
        transition: "none",
        notes: s.notes ?? "",
        elements: elements.map((rawEl) => {
          const e = (rawEl ?? {}) as Record<string, unknown>;
          const box = { id: e.id, x: scale(e.x), y: scale(e.y), w: scale(e.w), h: scale(e.h) };
          if (e.type === "text") {
            const role = (
              ["title", "subtitle", "body", "caption"].includes(String(e.role)) ? e.role : "body"
            ) as TextRole;
            const italic = e.italic === true;
            return {
              ...box,
              type: "text",
              role,
              body: {
                ...(italic
                  ? {
                      paragraphs: String(e.text ?? "")
                        .split("\n")
                        .map((line) => ({ runs: [{ text: line, italic: true }] })),
                    }
                  : { text: e.text ?? "" }),
                style: ROLE_STYLE[role],
                size: scale(e.fontSize ?? 24),
                weight: e.bold === true ? 700 : 400,
                color: e.color,
                align: e.align ?? "left",
              },
            };
          }
          if (e.type === "shape") {
            return {
              ...box,
              type: "shape",
              shape: e.shape === "rightArrow" ? "arrowRight" : e.shape,
              fill: e.fill,
              ...(typeof e.text === "string" && e.text
                ? {
                    body: {
                      text: e.text,
                      size: scale(e.fontSize ?? 24),
                      color: e.color,
                      align: "center",
                      vAlign: "middle",
                    },
                  }
                : {}),
            };
          }
          return { ...box, type: e.type, src: e.src, alt: e.alt, fit: "contain" };
        }),
      };
    }),
  };
}

/** Validates untrusted deck JSON (agents, imports, stored rows, the editor) into a normalized v2 deck. */
export function parseSlidesDeck(input: string | unknown): SlidesDeck {
  if (typeof input === "string" && input.length > SLIDES_DATA_LIMITS.bytes)
    fail("deck is too large");
  let raw: unknown;
  try {
    raw = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return fail("deck is not JSON");
  }
  let value = record(raw, "deck");
  if (value.version === 1) value = migrateDeckV1(value);
  else if (value.version !== 2) fail("version must be 2");
  const theme = parseDeckTheme(value.theme);
  const sections = array(value.sections ?? [], "sections", SLIDES_DATA_LIMITS.sections).map(
    (item, i) => {
      const section = record(item, `sections[${i}]`);
      return {
        id: id(section.id, `sections[${i}].id`),
        title: string(section.title ?? "", `sections[${i}].title`, 200),
      };
    },
  );
  const sectionIds = new Set(sections.map((section) => section.id));
  if (sectionIds.size !== sections.length) fail("duplicate section ids");
  const slides = array(value.slides, "slides", SLIDES_DATA_LIMITS.slides).map((item, index) =>
    slide(item, index, theme, sectionIds),
  );
  if (new Set(slides.map((item) => item.id)).size !== slides.length) fail("duplicate slide ids");
  const cover =
    typeof value.coverSlideId === "string" && slides.some((s) => s.id === value.coverSlideId)
      ? value.coverSlideId
      : undefined;
  const deck: SlidesDeck = {
    version: 2,
    size: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
    ...(cover ? { coverSlideId: cover } : {}),
    theme,
    sections,
    slides,
  };
  if (JSON.stringify(deck).length > SLIDES_DATA_LIMITS.bytes) fail("deck is too large");
  return deck;
}

export interface ResolvedTextStyle {
  readonly font: string;
  readonly size: number;
  readonly weight: FontWeight;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly color: string;
}
/** Effective text style of a body: theme style, then the body's own overrides. */
export function resolveTextStyle(body: TextBody, theme: DeckTheme): ResolvedTextStyle {
  const base = theme.textStyles[body.style] ?? theme.textStyles.body;
  const heading = body.style === "display" || body.style === "title" || body.style === "heading";
  return {
    font: body.font ?? base.font ?? (heading ? theme.fonts.heading : theme.fonts.body),
    size: body.size ?? base.size,
    weight: body.weight ?? base.weight,
    lineHeight: body.lineHeight ?? base.lineHeight,
    letterSpacing: body.letterSpacing ?? base.letterSpacing,
    color: resolveColor(body.color ?? base.color ?? theme.colors.text, theme),
  };
}

export const bodyText = (body: TextBody | undefined): string =>
  body ? body.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n") : "";

/** Body with new plain text, keeping its style and the first run's formatting. */
export function withBodyText(body: TextBody, text: string): TextBody {
  const first = body.paragraphs[0]?.runs[0];
  const keep: Omit<Run, "text"> = first
    ? compact({
        bold: first.bold,
        italic: first.italic,
        underline: first.underline,
        color: first.color,
        size: first.size,
        font: first.font,
      })
    : {};
  // A list box stays a list when the new lines carry no markers of their own.
  const listed = body.paragraphs.find((p) => p.list)?.list;
  const parsed = paragraphsFromText(text);
  const marked = parsed.some((p) => p.list);
  const paragraphs = parsed.map((p) => ({
    ...p,
    ...(listed && !marked && p.runs.some((r) => r.text.trim()) ? { list: listed } : {}),
    runs: p.runs.map((r) => ({ ...keep, ...r })),
  }));
  return { ...body, paragraphs };
}

export const makeTextBody = (
  text: string,
  style: TextStyleId,
  overrides: Partial<Omit<TextBody, "paragraphs" | "style">> = {},
): TextBody =>
  compact({
    paragraphs: paragraphsFromText(text),
    style,
    align: "left" as TextAlign,
    vAlign: "top" as const,
    autofit: "shrink" as const,
    ...overrides,
  });

export function createSlidesDeck(title = "", theme: DeckTheme = DEFAULT_DECK_THEME): SlidesDeck {
  return {
    version: 2,
    size: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
    theme,
    sections: [],
    slides: [
      {
        id: newSlideId("s"),
        sectionId: null,
        layout: "title",
        background: { type: "solid", color: theme.colors.background },
        transition: "none",
        notes: "",
        elements: [
          {
            id: newSlideId("e"),
            type: "text",
            role: "title",
            x: 160,
            y: 360,
            w: 1600,
            h: 200,
            body: makeTextBody(title, "display", { vAlign: "bottom" }),
          },
          {
            id: newSlideId("e"),
            type: "text",
            role: "subtitle",
            x: 160,
            y: 590,
            w: 1600,
            h: 80,
            body: makeTextBody("", "subheading"),
          },
        ],
      },
    ],
  };
}

/** The words of one element, for projections and diffs. */
export function elementText(part: SlideElement): string {
  switch (part.type) {
    case "text":
      return bodyText(part.body);
    case "shape":
      return bodyText(part.body);
    case "table":
      return part.rows
        .map(
          (row) =>
            `| ${row.cells.map((cell) => bodyText(cell.body).replaceAll("\n", " ")).join(" | ")} |`,
        )
        .join("\n");
    case "chart":
      return `[图表] ${part.series
        .map(
          (s) =>
            `${s.name}: ${part.labels.map((label, i) => `${label} ${s.values[i] ?? ""}`).join(", ")}`,
        )
        .join("; ")}`;
    case "image":
      return part.alt ? `[图片] ${part.alt}` : "";
    case "line":
      return "";
    case "icon":
      return `[图标] ${part.name}`;
    case "video":
      return part.alt ? `[视频] ${part.alt}` : "[视频]";
    case "embed":
      return part.title ? `[网页嵌入] ${part.title}` : "[网页嵌入]";
  }
}

/** Readable Markdown outline: what search, agents and the page list see of a deck. */
export function projectSlidesDeck(deck: SlidesDeck): string {
  const sectionTitle = new Map(deck.sections.map((section) => [section.id, section.title]));
  let lastSection: string | null = null;
  return deck.slides
    .flatMap((item, index) => {
      const out: string[] = [];
      if (item.sectionId && item.sectionId !== lastSection && sectionTitle.get(item.sectionId))
        out.push(`# ${sectionTitle.get(item.sectionId)}`);
      lastSection = item.sectionId;
      const title =
        item.elements
          .find((part): part is TextElement => part.type === "text" && part.role === "title")
          ?.body.paragraphs.map((p) => p.runs.map((r) => r.text).join(""))
          .join(" ")
          .trim() || `幻灯片 ${index + 1}`;
      const rest = item.elements
        .filter((part) => !(part.type === "text" && part.role === "title"))
        .map((part) => elementText(part).trim())
        .filter(Boolean);
      const notes = item.notes.trim() ? [`> ${item.notes.trim().replaceAll("\n", "\n> ")}`] : [];
      out.push([`## ${index + 1}. ${title}`, ...rest, ...notes].join("\n\n"));
      return out;
    })
    .join("\n\n");
}

/** The deck with every theme color reference (`@accent`…) replaced by its #RRGGBB value. */
export function resolveDeckColors(deck: SlidesDeck): SlidesDeck {
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string")
      return key !== "text" && key !== "src" && value.startsWith("@")
        ? resolveColor(value, deck.theme)
        : value;
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  return { ...deck, slides: walk(deck.slides) as Slide[] };
}
