// FILE: designCanvas.ts
// Purpose: The 设计 (kind `design`) document: pages of live HTML artboards laid out on a canvas,
//          with sticky notes and titles, an installed design system, validation, the text
//          projection, and the ordered operations agents and the editor apply.
// Layer: Shared model (server validates and serves the moss_design_* tools; web renders and edits)
// Why: An artboard is plain HTML with inline styles, so the editor can patch the source it shows
//      and an agent can write a screen in one call, without a component runtime.
// Exports: DesignCanvas and its parts, parseDesignCanvas, createDesignCanvas, projectDesignCanvas,
//          applyDesignOps, layout helpers.

import {
  BUILT_IN_DESIGN_SYSTEMS,
  parseDesignSystemTokens,
  type DesignSystemTokens,
} from "./designSystems";

export const DESIGN_LIMITS = {
  bytes: 2_000_000,
  pages: 40,
  boards: 200,
  boardHtml: 400_000,
  notes: 1_000,
  noteText: 4_000,
  tweaks: 24,
  guides: 6,
  frameMin: 40,
  frameMax: 8_000,
  components: 200,
  componentHtml: 100_000,
  shapePath: 20_000,
  shapePoints: 2_000,
  shapeImage: 600_000,
} as const;

/** A link card's size on the canvas. */
export const DESIGN_LINK_CARD = { w: 640, h: 112 } as const;

/** Paper sizes for flow-paginated PDFs, in points. */
export const DESIGN_PAPER = {
  a4: { w: 595, h: 842, label: "A4" },
  letter: { w: 612, h: 792, label: "Letter" },
} as const;
export type DesignPaper = keyof typeof DESIGN_PAPER;

/** Gaps between artboards when Moss places them: in a row and between rows. */
export const DESIGN_ROW_GAP = 80;
export const DESIGN_COLUMN_GAP = 120;

export const DESIGN_NOTE_COLORS = [
  "yellow",
  "gray",
  "red",
  "orange",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type DesignNoteColor = (typeof DESIGN_NOTE_COLORS)[number];

export interface DesignPage {
  readonly id: string;
  readonly name: string;
}

export type DesignTweakEditor = "color" | "range" | "enum" | "boolean" | "text";
export type DesignTweakValue = string | number | boolean;
export interface DesignTweak {
  /** Lower-case name; reaches the HTML as `var(--tweak-<name>)` and `data-tweak-<name>`. */
  readonly name: string;
  readonly label: string;
  readonly editor: DesignTweakEditor;
  readonly default: DesignTweakValue;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** CSS unit appended to range values (`px`, `%`, `rem`). */
  readonly unit?: string;
  /** Choices of an enum tweak, or 3–4 swatches of a colour tweak. */
  readonly options?: readonly string[];
}

export type DesignGuide =
  | {
      readonly kind: "columns" | "rows";
      readonly count: number;
      readonly gutter: number;
      readonly margin: number;
      readonly hidden?: boolean;
      readonly color?: string;
    }
  | {
      readonly kind: "grid";
      readonly size: number;
      readonly hidden?: boolean;
      readonly color?: string;
    };

export interface DesignBoard {
  /** Stable id: letters, digits, `_` and `-`. Links use `href="board:<id>"`. */
  readonly id: string;
  readonly name: string;
  readonly page: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The artboard's markup: an HTML fragment (or document) with inline styles. */
  readonly html: string;
  /** `page`: a fluid web page that fills the window when played; `fixed` (default) keeps w×h. */
  readonly layout?: "fixed" | "page";
  /** Working controls and links: gets Play. */
  readonly interactive?: boolean;
  readonly radius?: number;
  readonly hidden?: boolean;
  readonly guides?: readonly DesignGuide[];
  readonly tweaks?: readonly DesignTweak[];
  readonly tweakValues?: Readonly<Record<string, DesignTweakValue>>;
  /** PDF export: `flow` breaks a tall artboard onto pages of `paper` (default one page). */
  readonly print?: "flow";
  readonly paper?: DesignPaper;
}

export type DesignShapeKind = "rect" | "oval" | "line" | "arrow" | "path" | "image";

export interface DesignNote {
  readonly id: string;
  readonly page: string;
  /**
   * `sticky`: a coloured note; `title`: one bold 72 px line over a row of artboards; `shape`: a
   * loose shape drawn on the canvas (outside any artboard); `link`: a card that opens another
   * 资料空间 item or a web page.
   */
  readonly kind: "sticky" | "title" | "shape" | "link";
  readonly x: number;
  readonly y: number;
  /** Width of a sticky, shape or link card, or the max width of a title. */
  readonly w?: number;
  /** Height of a shape or link card. */
  readonly h?: number;
  /** Sticky and title text; a link card's title; a shape's label. */
  readonly text: string;
  readonly color?: DesignNoteColor;
  readonly bold?: boolean;
  readonly shape?: DesignShapeKind;
  /** Line and arrow ends `[x1, y1, x2, y2]`, relative to (x, y). */
  readonly points?: readonly number[];
  /** A path's SVG `d` in a `vw`×`vh` box; it stretches to w×h. */
  readonly d?: string;
  readonly vw?: number;
  readonly vh?: number;
  readonly stroke?: string;
  readonly fill?: string;
  readonly strokeWidth?: number;
  /** A picture on the canvas (`data:image/…` or https). */
  readonly src?: string;
  /** Where a link card goes: `moss://space-page/<id>` or https. */
  readonly href?: string;
  /** A link card's second line. */
  readonly subtitle?: string;
}

/**
 * A reusable piece of an artboard. Instances in artboards carry `data-design-component="<id>"`
 * on their root element; syncing writes the master's markup into every instance and keeps where
 * each instance sits.
 */
export interface DesignComponent {
  readonly id: string;
  readonly name: string;
  /** The master's outer HTML (with `data-design-component` on its root). */
  readonly html: string;
  readonly description?: string;
}

/** A design system copied into this design (built-in or another design marked as a system). */
export interface DesignSystemRef {
  /** `builtin:<id>` or `page:<pageId>`. */
  readonly source: string;
  readonly name: string;
  readonly tokens: DesignSystemTokens;
  readonly copiedAt: string;
  /** The system's components, copied with its tokens. */
  readonly components?: readonly DesignComponent[];
}

export interface DesignCanvas {
  readonly version: 1;
  readonly pages: readonly DesignPage[];
  readonly boards: readonly DesignBoard[];
  readonly notes: readonly DesignNote[];
  readonly launch?: {
    readonly view: "canvas" | "focused";
    readonly boardId?: string;
    readonly pageId?: string;
  };
  readonly thumbnailBoardId?: string;
  /** Colour theme the artboards render in. */
  readonly theme?: "light" | "dark";
  readonly system: DesignSystemRef | null;
  /** Set when this design is itself a design system: its tokens, offered to other designs. */
  readonly ownSystem?: DesignSystemTokens;
  /** This design's own components (a design system offers them to the designs that install it). */
  readonly components?: readonly DesignComponent[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const TWEAK_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

function fail(message: string): never {
  throw new Error(`Invalid design: ${message}`);
}
function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, what: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") fail(`${what} must be a string`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) fail(`${what} must not be empty`);
  if (value.length > max) fail(`${what} is longer than ${max} characters`);
  return allowEmpty ? value : trimmed;
}
function num(value: unknown, what: string, min = -1_000_000, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${what} must be a number`);
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
}
function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value))
    fail(`${what} must be 1-64 letters, digits, _ or -`);
  return value;
}

function parseTweak(input: unknown, index: number): DesignTweak {
  const value = record(input, `tweak ${index}`);
  if (typeof value.name !== "string" || !TWEAK_NAME.test(value.name))
    fail(`tweak ${index} name must be lower-case letters, digits or -`);
  const editor = value.editor;
  if (!["color", "range", "enum", "boolean", "text"].includes(editor as string))
    fail(`tweak ${value.name} editor must be color, range, enum, boolean or text`);
  const def = value.default;
  if (!["string", "number", "boolean"].includes(typeof def))
    fail(`tweak ${value.name} needs a default`);
  const options = Array.isArray(value.options)
    ? value.options.filter((option): option is string => typeof option === "string").slice(0, 12)
    : undefined;
  return {
    name: value.name,
    label: text(value.label ?? value.name, `tweak ${value.name} label`, 60),
    editor: editor as DesignTweakEditor,
    default: def as DesignTweakValue,
    ...(typeof value.min === "number" ? { min: value.min } : {}),
    ...(typeof value.max === "number" ? { max: value.max } : {}),
    ...(typeof value.step === "number" ? { step: value.step } : {}),
    ...(typeof value.unit === "string" && /^[a-z%]{1,4}$/u.test(value.unit)
      ? { unit: value.unit }
      : {}),
    ...(options && options.length ? { options } : {}),
  };
}

function parseGuide(input: unknown): DesignGuide {
  const value = record(input, "guide");
  const color =
    typeof value.color === "string" && value.color.length <= 40 ? { color: value.color } : {};
  const hidden = value.hidden === true ? { hidden: true } : {};
  if (value.kind === "grid")
    return { kind: "grid", size: num(value.size ?? 8, "guide size", 2, 400), ...hidden, ...color };
  if (value.kind !== "columns" && value.kind !== "rows")
    fail("guide kind must be columns, rows or grid");
  return {
    kind: value.kind,
    count: num(value.count ?? 12, "guide count", 1, 48),
    gutter: num(value.gutter ?? 24, "guide gutter", 0, 400),
    margin: num(value.margin ?? 0, "guide margin", 0, 2_000),
    ...hidden,
    ...color,
  };
}

function parseBoard(input: unknown, pages: ReadonlySet<string>, fallbackPage: string): DesignBoard {
  const value = record(input, "artboard");
  const boardId = id(value.id, "artboard id");
  const html = typeof value.html === "string" ? value.html : "";
  if (html.length > DESIGN_LIMITS.boardHtml)
    fail(`artboard ${boardId} is larger than ${DESIGN_LIMITS.boardHtml / 1000} KB`);
  const page = typeof value.page === "string" && pages.has(value.page) ? value.page : fallbackPage;
  const tweaks = Array.isArray(value.tweaks)
    ? value.tweaks.slice(0, DESIGN_LIMITS.tweaks).map(parseTweak)
    : [];
  const tweakValues: Record<string, DesignTweakValue> = {};
  if (value.tweakValues && typeof value.tweakValues === "object") {
    for (const [key, entry] of Object.entries(value.tweakValues as Record<string, unknown>)) {
      if (
        tweaks.some((tweak) => tweak.name === key) &&
        ["string", "number", "boolean"].includes(typeof entry)
      )
        tweakValues[key] = entry as DesignTweakValue;
    }
  }
  const guides = Array.isArray(value.guides)
    ? value.guides.slice(0, DESIGN_LIMITS.guides).map(parseGuide)
    : [];
  return {
    id: boardId,
    name: text(value.name ?? boardId, `artboard ${boardId} name`, 120),
    page,
    x: num(value.x ?? 0, "artboard x"),
    y: num(value.y ?? 0, "artboard y"),
    w: num(value.w ?? 1280, "artboard w", DESIGN_LIMITS.frameMin, DESIGN_LIMITS.frameMax),
    h: num(value.h ?? 800, "artboard h", DESIGN_LIMITS.frameMin, DESIGN_LIMITS.frameMax),
    html,
    ...(value.layout === "page" ? { layout: "page" as const } : {}),
    ...(value.interactive === true ? { interactive: true } : {}),
    ...(typeof value.radius === "number" && value.radius > 0
      ? { radius: num(value.radius, "artboard radius", 0, 400) }
      : {}),
    ...(value.hidden === true ? { hidden: true } : {}),
    ...(guides.length ? { guides } : {}),
    ...(tweaks.length ? { tweaks } : {}),
    ...(Object.keys(tweakValues).length ? { tweakValues } : {}),
    ...(value.print === "flow" ? { print: "flow" as const } : {}),
    ...(value.paper === "a4" || value.paper === "letter" ? { paper: value.paper } : {}),
  };
}

const SHAPES: readonly DesignShapeKind[] = ["rect", "oval", "line", "arrow", "path", "image"];
/** A CSS colour or `var(--ds-…)`: no characters that could leave a style value. */
const CSS_COLOR = /^[#(),.%\s\w-]{1,60}$/u;
/** SVG path data: commands, numbers, separators. */
const PATH_DATA = /^[MLHVCSQTAZmlhvcsqtaz0-9eE.,\s-]+$/u;

function color(value: unknown): string | undefined {
  return typeof value === "string" && CSS_COLOR.test(value) ? value : undefined;
}

function parseNote(input: unknown, pages: ReadonlySet<string>, fallbackPage: string): DesignNote {
  const value = record(input, "note");
  const noteId = id(value.id, "note id");
  const kind =
    value.kind === "title" || value.kind === "shape" || value.kind === "link"
      ? value.kind
      : "sticky";
  const noteColor = (DESIGN_NOTE_COLORS as readonly unknown[]).includes(value.color)
    ? (value.color as DesignNoteColor)
    : undefined;
  const base: DesignNote = {
    id: noteId,
    page: typeof value.page === "string" && pages.has(value.page) ? value.page : fallbackPage,
    kind,
    x: num(value.x ?? 0, "note x"),
    y: num(value.y ?? 0, "note y"),
    ...(typeof value.w === "number"
      ? { w: num(value.w, "note w", kind === "shape" ? 0 : 80, 8_000) }
      : {}),
    text: text(value.text ?? "", `note ${noteId} text`, DESIGN_LIMITS.noteText, true),
    ...(noteColor ? { color: noteColor } : {}),
    ...(value.bold === true ? { bold: true } : {}),
  };
  if (kind === "link") {
    const href = typeof value.href === "string" ? value.href.trim() : "";
    if (!/^(moss:\/\/space-page\/[A-Za-z0-9_%-]{1,200}|https?:\/\/\S{1,2000})$/u.test(href))
      fail(`link card ${noteId} needs an href (moss://space-page/<id> or https://…)`);
    return {
      ...base,
      w: base.w ?? DESIGN_LINK_CARD.w,
      h: typeof value.h === "number" ? num(value.h, "link h", 48, 800) : DESIGN_LINK_CARD.h,
      href,
      ...(typeof value.subtitle === "string" && value.subtitle.trim()
        ? { subtitle: text(value.subtitle, "link subtitle", 200) }
        : {}),
    };
  }
  if (kind !== "shape") return base;
  const shape = (SHAPES as readonly unknown[]).includes(value.shape)
    ? (value.shape as DesignShapeKind)
    : "rect";
  const stroke = color(value.stroke);
  const fill = color(value.fill);
  const paint = {
    ...(stroke ? { stroke } : {}),
    ...(fill ? { fill } : {}),
    ...(typeof value.strokeWidth === "number"
      ? { strokeWidth: num(value.strokeWidth, "stroke width", 0, 200) }
      : {}),
  };
  const h = typeof value.h === "number" ? num(value.h, "shape h", 0, 8_000) : 120;
  const w = base.w ?? 120;
  if (shape === "line" || shape === "arrow") {
    const points = Array.isArray(value.points) ? value.points : [];
    if (points.length !== 4 || !points.every((entry) => typeof entry === "number"))
      fail(`${shape} ${noteId} needs points [x1, y1, x2, y2]`);
    const [x1, y1, x2, y2] = (points as number[]).map((entry) => num(entry, "point"));
    return {
      ...base,
      shape,
      points: [x1!, y1!, x2!, y2!],
      w: Math.abs(x2! - x1!),
      h: Math.abs(y2! - y1!),
      ...paint,
    };
  }
  if (shape === "path") {
    const d = typeof value.d === "string" ? value.d : "";
    if (!d || d.length > DESIGN_LIMITS.shapePath || !PATH_DATA.test(d))
      fail(`path ${noteId} needs SVG path data (at most ${DESIGN_LIMITS.shapePath} characters)`);
    return {
      ...base,
      shape,
      d,
      w,
      h,
      vw: num(value.vw ?? w, "path vw", 0.01, 100_000),
      vh: num(value.vh ?? h, "path vh", 0.01, 100_000),
      ...paint,
    };
  }
  if (shape === "image") {
    const src = typeof value.src === "string" ? value.src : "";
    if (
      src.length > DESIGN_LIMITS.shapeImage ||
      !/^(data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|https:\/\/\S+)$/u.test(src)
    )
      fail(`picture ${noteId} needs a data:image or https src under 600 KB`);
    return { ...base, shape, src, w, h };
  }
  return { ...base, shape, w, h, ...paint };
}

function parseComponent(input: unknown): DesignComponent {
  const value = record(input, "component");
  const componentId = id(value.id, "component id");
  const html = typeof value.html === "string" ? value.html.trim() : "";
  if (!html) fail(`component ${componentId} needs html`);
  if (html.length > DESIGN_LIMITS.componentHtml)
    fail(`component ${componentId} is larger than ${DESIGN_LIMITS.componentHtml / 1000} KB`);
  return {
    id: componentId,
    name: text(value.name ?? componentId, `component ${componentId} name`, 80),
    html,
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: text(value.description, "component description", 400) }
      : {}),
  };
}

function parseComponents(input: unknown): DesignComponent[] {
  if (!Array.isArray(input)) return [];
  if (input.length > DESIGN_LIMITS.components)
    fail(`at most ${DESIGN_LIMITS.components} components`);
  const out: DesignComponent[] = [];
  for (const entry of input) {
    const component = parseComponent(entry);
    if (out.some((existing) => existing.id === component.id))
      fail(`duplicate component id ${component.id}`);
    out.push(component);
  }
  return out;
}

/** Validates a stored or agent-written design. Throws a readable error on bad input. */
export function parseDesignCanvas(input: string | unknown): DesignCanvas {
  if (typeof input === "string" && input.length > DESIGN_LIMITS.bytes) fail("larger than 2 MB");
  const value = record(typeof input === "string" ? JSON.parse(input) : input, "design");
  if (value.version !== 1) fail("version must be 1");
  const rawPages = Array.isArray(value.pages) ? value.pages : [];
  if (rawPages.length > DESIGN_LIMITS.pages) fail(`at most ${DESIGN_LIMITS.pages} pages`);
  const pages: DesignPage[] = [];
  for (const entry of rawPages) {
    const page = record(entry, "page");
    const pageId = id(page.id, "page id");
    if (pages.some((existing) => existing.id === pageId)) fail(`duplicate page id ${pageId}`);
    pages.push({ id: pageId, name: text(page.name ?? pageId, "page name", 60) });
  }
  if (pages.length === 0) pages.push({ id: "page-1", name: "页面 1" });
  const pageIds = new Set(pages.map((page) => page.id));
  const first = pages[0]!.id;
  const rawBoards = Array.isArray(value.boards) ? value.boards : [];
  if (rawBoards.length > DESIGN_LIMITS.boards) fail(`at most ${DESIGN_LIMITS.boards} artboards`);
  const boards: DesignBoard[] = [];
  for (const entry of rawBoards) {
    const board = parseBoard(entry, pageIds, first);
    if (boards.some((existing) => existing.id === board.id))
      fail(`duplicate artboard id ${board.id}`);
    boards.push(board);
  }
  const rawNotes = Array.isArray(value.notes) ? value.notes : [];
  if (rawNotes.length > DESIGN_LIMITS.notes) fail(`at most ${DESIGN_LIMITS.notes} notes`);
  const notes: DesignNote[] = [];
  for (const entry of rawNotes) {
    const note = parseNote(entry, pageIds, first);
    if (notes.some((existing) => existing.id === note.id)) fail(`duplicate note id ${note.id}`);
    notes.push(note);
  }
  const launchInput =
    value.launch && typeof value.launch === "object"
      ? (value.launch as Record<string, unknown>)
      : null;
  const launch = launchInput
    ? {
        view: launchInput.view === "focused" ? ("focused" as const) : ("canvas" as const),
        ...(typeof launchInput.boardId === "string" &&
        boards.some((board) => board.id === launchInput.boardId)
          ? { boardId: launchInput.boardId }
          : {}),
        ...(typeof launchInput.pageId === "string" && pageIds.has(launchInput.pageId)
          ? { pageId: launchInput.pageId }
          : {}),
      }
    : undefined;
  let system: DesignSystemRef | null = null;
  if (value.system && typeof value.system === "object") {
    const ref = value.system as Record<string, unknown>;
    if (
      typeof ref.source === "string" &&
      /^(builtin|page):[A-Za-z0-9:_-]{1,128}$/u.test(ref.source)
    ) {
      const systemComponents = parseComponents(ref.components);
      system = {
        source: ref.source,
        name: text(ref.name ?? "设计系统", "system name", 80),
        tokens: parseDesignSystemTokens(ref.tokens),
        copiedAt: typeof ref.copiedAt === "string" ? ref.copiedAt.slice(0, 40) : "",
        ...(systemComponents.length ? { components: systemComponents } : {}),
      };
    }
  }
  const components = parseComponents(value.components);
  return {
    version: 1,
    pages,
    boards,
    notes,
    ...(launch ? { launch } : {}),
    ...(typeof value.thumbnailBoardId === "string" &&
    boards.some((board) => board.id === value.thumbnailBoardId)
      ? { thumbnailBoardId: value.thumbnailBoardId }
      : {}),
    ...(value.theme === "dark" ? { theme: "dark" as const } : {}),
    system,
    ...(value.ownSystem ? { ownSystem: parseDesignSystemTokens(value.ownSystem) } : {}),
    ...(components.length ? { components } : {}),
  };
}

/** A new design: one page, no artboards, Moss 设计标准 installed. */
export function createDesignCanvas(): DesignCanvas {
  const moss = BUILT_IN_DESIGN_SYSTEMS[0]!;
  return {
    version: 1,
    pages: [{ id: "page-1", name: "页面 1" }],
    boards: [],
    notes: [],
    system: { source: `builtin:${moss.id}`, name: moss.name, tokens: moss.tokens, copiedAt: "" },
  };
}

/** Readable text of an artboard's markup (no tags, scripts or styles). */
export function designBoardText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Markdown projection stored as the page `content` (search, agent reads, the page list). */
export function projectDesignCanvas(canvas: DesignCanvas, title = ""): string {
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`);
  for (const page of canvas.pages) {
    const boards = canvas.boards.filter((board) => board.page === page.id);
    const notes = canvas.notes.filter((note) => note.page === page.id && note.text.trim());
    if (canvas.pages.length > 1) lines.push(`## ${page.name}`);
    for (const board of boards) {
      lines.push(`### ${board.name} (${board.w}×${board.h})`);
      const body = designBoardText(board.html).slice(0, 1_200);
      if (body) lines.push(body);
    }
    for (const note of notes)
      lines.push(
        note.kind === "link" && note.href
          ? `[${note.text.replace(/[[\]]/gu, "") || note.href}](${note.href})`
          : `> ${note.text.replace(/\s+/gu, " ").slice(0, 400)}`,
      );
  }
  for (const component of canvas.components ?? [])
    lines.push(`组件 ${component.name}: ${designBoardText(component.html).slice(0, 200)}`);
  return lines.join("\n\n").slice(0, 20_000);
}

// ─── Layout ─────────────────────────────────────────────────────────────────────────────

/** Where the next artboard of `w`×`h` goes on a page: right of the rightmost one in the top row. */
export function nextBoardPosition(
  canvas: DesignCanvas,
  page: string,
  size: { w: number; h: number },
): { x: number; y: number } {
  const boards = canvas.boards.filter((board) => board.page === page);
  if (boards.length === 0) return { x: 0, y: 0 };
  const top = Math.min(...boards.map((board) => board.y));
  const row = boards.filter((board) => board.y < top + Math.max(1, size.h) / 2);
  const right = Math.max(...row.map((board) => board.x + board.w));
  return { x: right + DESIGN_ROW_GAP, y: top };
}

/** A fresh id from `base` that no artboard or note uses yet. */
export function uniqueDesignId(canvas: DesignCanvas, base: string): string {
  const slug =
    base
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48)
      .toLowerCase() || "board";
  const taken = new Set([
    ...canvas.boards.map((board) => board.id),
    ...canvas.notes.map((note) => note.id),
    ...canvas.pages.map((page) => page.id),
    ...(canvas.components ?? []).map((component) => component.id),
  ]);
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n += 1) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

// ─── Operations ─────────────────────────────────────────────────────────────────────────

export type DesignOp =
  | {
      readonly op: "upsertBoard";
      readonly board: Partial<DesignBoard> & { readonly id: string };
      /** Index in the back-to-front order for a new artboard (default: front). */
      readonly index?: number;
      /** Replace the whole artboard instead of merging the given fields into it. */
      readonly replace?: boolean;
    }
  | { readonly op: "deleteBoard"; readonly id: string }
  | {
      readonly op: "moveBoard";
      readonly id: string;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    }
  | { readonly op: "reorderBoard"; readonly id: string; readonly to: "front" | "back" | number }
  | {
      readonly op: "upsertNote";
      readonly note: Partial<DesignNote> & { readonly id: string };
      readonly replace?: boolean;
    }
  | { readonly op: "deleteNote"; readonly id: string }
  | { readonly op: "upsertPage"; readonly page: DesignPage; readonly index?: number }
  | { readonly op: "deletePage"; readonly id: string }
  | { readonly op: "setLaunch"; readonly launch: DesignCanvas["launch"] | null }
  | { readonly op: "setTheme"; readonly theme: "light" | "dark" }
  | { readonly op: "setThumbnail"; readonly id: string | null }
  | { readonly op: "upsertComponent"; readonly component: DesignComponent }
  | { readonly op: "deleteComponent"; readonly id: string }
  | { readonly op: "setSystem"; readonly system: DesignSystemRef | null }
  | { readonly op: "setOwnSystem"; readonly tokens: DesignSystemTokens | null };

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Applies ops in order and re-validates the result. A new artboard without x/y goes right of
 * the page's top row; one without w/h is 1280×800. Throws when an op names something missing.
 */
export function applyDesignOps(canvas: DesignCanvas, ops: readonly DesignOp[]): DesignCanvas {
  let pages = [...canvas.pages];
  let boards = [...canvas.boards];
  let notes = [...canvas.notes];
  let components = [...(canvas.components ?? [])];
  let system = canvas.system;
  let rest: Partial<DesignCanvas> = {
    ...(canvas.launch ? { launch: canvas.launch } : {}),
    ...(canvas.thumbnailBoardId ? { thumbnailBoardId: canvas.thumbnailBoardId } : {}),
    ...(canvas.theme ? { theme: canvas.theme } : {}),
    ...(canvas.ownSystem ? { ownSystem: canvas.ownSystem } : {}),
  };
  const current = (): DesignCanvas => ({
    version: 1,
    pages,
    boards,
    notes,
    system,
    ...rest,
    ...(components.length ? { components } : {}),
  });
  for (const op of ops) {
    switch (op.op) {
      case "upsertBoard": {
        const index = boards.findIndex((board) => board.id === op.board.id);
        if (index >= 0) {
          boards[index] = (
            op.replace
              ? { ...withoutUndefined(op.board) }
              : { ...boards[index]!, ...withoutUndefined(op.board) }
          ) as DesignBoard;
        } else {
          const page = op.board.page ?? pages[0]!.id;
          const w = op.board.w ?? 1280;
          const h = op.board.h ?? 800;
          const at =
            op.board.x === undefined || op.board.y === undefined
              ? nextBoardPosition(current(), page, { w, h })
              : { x: op.board.x, y: op.board.y };
          const board = {
            name: op.board.id,
            html: "",
            ...withoutUndefined(op.board),
            page,
            w,
            h,
            x: op.board.x ?? at.x,
            y: op.board.y ?? at.y,
          } as DesignBoard;
          const position =
            op.index === undefined ? boards.length : Math.max(0, Math.min(boards.length, op.index));
          boards.splice(position, 0, board);
        }
        break;
      }
      case "deleteBoard": {
        if (!boards.some((board) => board.id === op.id)) fail(`no artboard ${op.id}`);
        boards = boards.filter((board) => board.id !== op.id);
        if (rest.thumbnailBoardId === op.id) {
          const { thumbnailBoardId: _drop, ...others } = rest;
          rest = others;
        }
        break;
      }
      case "moveBoard": {
        const index = boards.findIndex((board) => board.id === op.id);
        if (index < 0) fail(`no artboard ${op.id}`);
        const board = boards[index]!;
        boards[index] = {
          ...board,
          x: op.x ?? board.x,
          y: op.y ?? board.y,
          w: op.w ?? board.w,
          h: op.h ?? board.h,
        };
        break;
      }
      case "reorderBoard": {
        const index = boards.findIndex((board) => board.id === op.id);
        if (index < 0) fail(`no artboard ${op.id}`);
        const [board] = boards.splice(index, 1);
        const to =
          op.to === "front"
            ? boards.length
            : op.to === "back"
              ? 0
              : Math.max(0, Math.min(boards.length, op.to));
        boards.splice(to, 0, board!);
        break;
      }
      case "upsertNote": {
        const index = notes.findIndex((note) => note.id === op.note.id);
        if (index >= 0)
          notes[index] = (
            op.replace
              ? { ...withoutUndefined(op.note) }
              : { ...notes[index]!, ...withoutUndefined(op.note) }
          ) as DesignNote;
        else
          notes.push({
            kind: "sticky",
            x: 0,
            y: 0,
            text: "",
            page: pages[0]!.id,
            ...withoutUndefined(op.note),
          } as DesignNote);
        break;
      }
      case "deleteNote":
        if (!notes.some((note) => note.id === op.id)) fail(`no note ${op.id}`);
        notes = notes.filter((note) => note.id !== op.id);
        break;
      case "upsertPage": {
        const index = pages.findIndex((page) => page.id === op.page.id);
        if (index >= 0) pages[index] = op.page;
        else if (op.index === undefined) pages.push(op.page);
        else pages.splice(Math.max(0, Math.min(pages.length, op.index)), 0, op.page);
        break;
      }
      case "deletePage": {
        if (pages.length <= 1) fail("a design needs at least one page");
        if (!pages.some((page) => page.id === op.id)) fail(`no page ${op.id}`);
        pages = pages.filter((page) => page.id !== op.id);
        boards = boards.filter((board) => board.page !== op.id);
        notes = notes.filter((note) => note.page !== op.id);
        break;
      }
      case "setLaunch": {
        const { launch: _drop, ...others } = rest;
        rest = op.launch ? { ...others, launch: op.launch } : others;
        break;
      }
      case "setTheme":
        rest = { ...rest, theme: op.theme };
        break;
      case "setThumbnail": {
        const { thumbnailBoardId: _drop, ...others } = rest;
        rest = op.id ? { ...others, thumbnailBoardId: op.id } : others;
        break;
      }
      case "upsertComponent": {
        const index = components.findIndex((entry) => entry.id === op.component.id);
        if (index >= 0) components[index] = op.component;
        else components.push(op.component);
        break;
      }
      case "deleteComponent":
        if (!components.some((entry) => entry.id === op.id)) fail(`no component ${op.id}`);
        components = components.filter((entry) => entry.id !== op.id);
        break;
      case "setSystem":
        system = op.system;
        break;
      case "setOwnSystem": {
        const { ownSystem: _drop, ...others } = rest;
        rest = op.tokens ? { ...others, ownSystem: op.tokens } : others;
        break;
      }
    }
  }
  return parseDesignCanvas(current());
}

// ─── Diff ───────────────────────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** What an op touches: `board:<id>`, `note:<id>`, `page:<id>`, `component:<id>`, or a canvas field. */
export function designOpKey(op: DesignOp): string {
  switch (op.op) {
    case "upsertBoard":
      return `board:${op.board.id}`;
    case "deleteBoard":
    case "moveBoard":
      return `board:${op.id}`;
    case "reorderBoard":
      return "order";
    case "upsertNote":
      return `note:${op.note.id}`;
    case "deleteNote":
      return `note:${op.id}`;
    case "upsertPage":
      return `page:${op.page.id}`;
    case "deletePage":
      return `page:${op.id}`;
    case "upsertComponent":
      return `component:${op.component.id}`;
    case "deleteComponent":
      return `component:${op.id}`;
    case "setLaunch":
      return "launch";
    case "setTheme":
      return "theme";
    case "setThumbnail":
      return "thumbnail";
    case "setSystem":
      return "system";
    case "setOwnSystem":
      return "ownSystem";
  }
}

/**
 * The ops that turn `from` into `to`, whole entities at a time: changed artboards, notes and
 * components are replaced, removed ones deleted, the artboard order set when it differs. Applying
 * them to `from` gives `to`; applying them to a canvas someone else also changed keeps their
 * changes to everything these ops do not name (the live room and per-person undo rely on this).
 */
export function diffDesignCanvas(from: DesignCanvas, to: DesignCanvas): DesignOp[] {
  const ops: DesignOp[] = [];
  const pagesBefore = new Map(from.pages.map((page) => [page.id, page]));
  to.pages.forEach((page, index) => {
    const before = pagesBefore.get(page.id);
    if (!before) ops.push({ op: "upsertPage", page, index });
    else if (!same(before, page)) ops.push({ op: "upsertPage", page });
  });
  const boardsAfter = new Map(to.boards.map((board) => [board.id, board]));
  for (const board of from.boards)
    if (!boardsAfter.has(board.id)) ops.push({ op: "deleteBoard", id: board.id });
  const boardsBefore = new Map(from.boards.map((board) => [board.id, board]));
  to.boards.forEach((board, index) => {
    const before = boardsBefore.get(board.id);
    if (!before) ops.push({ op: "upsertBoard", board, index });
    else if (!same(before, board)) ops.push({ op: "upsertBoard", board, replace: true });
  });
  const kept = from.boards.filter((board) => boardsAfter.has(board.id)).map((board) => board.id);
  const order = to.boards.filter((board) => boardsBefore.has(board.id)).map((board) => board.id);
  if (!same(kept, order))
    to.boards.forEach((board, index) => ops.push({ op: "reorderBoard", id: board.id, to: index }));
  const notesAfter = new Map(to.notes.map((note) => [note.id, note]));
  for (const note of from.notes)
    if (!notesAfter.has(note.id)) ops.push({ op: "deleteNote", id: note.id });
  const notesBefore = new Map(from.notes.map((note) => [note.id, note]));
  for (const note of to.notes) {
    const before = notesBefore.get(note.id);
    if (!before) ops.push({ op: "upsertNote", note });
    else if (!same(before, note)) ops.push({ op: "upsertNote", note, replace: true });
  }
  const componentsAfter = new Map((to.components ?? []).map((entry) => [entry.id, entry]));
  for (const component of from.components ?? [])
    if (!componentsAfter.has(component.id)) ops.push({ op: "deleteComponent", id: component.id });
  const componentsBefore = new Map((from.components ?? []).map((entry) => [entry.id, entry]));
  for (const component of to.components ?? [])
    if (!same(componentsBefore.get(component.id), component))
      ops.push({ op: "upsertComponent", component });
  const pagesAfter = new Set(to.pages.map((page) => page.id));
  for (const page of from.pages)
    if (!pagesAfter.has(page.id)) ops.push({ op: "deletePage", id: page.id });
  if (!same(from.launch ?? null, to.launch ?? null))
    ops.push({ op: "setLaunch", launch: to.launch ?? null });
  if ((from.theme ?? "light") !== (to.theme ?? "light"))
    ops.push({ op: "setTheme", theme: to.theme ?? "light" });
  if ((from.thumbnailBoardId ?? null) !== (to.thumbnailBoardId ?? null))
    ops.push({ op: "setThumbnail", id: to.thumbnailBoardId ?? null });
  if (!same(from.system, to.system)) ops.push({ op: "setSystem", system: to.system });
  if (!same(from.ownSystem ?? null, to.ownSystem ?? null))
    ops.push({ op: "setOwnSystem", tokens: to.ownSystem ?? null });
  return ops;
}

/**
 * Applies `ops` as far as they still fit: an op that names something another person removed is
 * dropped instead of failing the rest. Returns the result and the ops that applied.
 */
export function applyDesignOpsLeniently(
  canvas: DesignCanvas,
  ops: readonly DesignOp[],
): { canvas: DesignCanvas; applied: DesignOp[] } {
  try {
    return { canvas: applyDesignOps(canvas, ops), applied: [...ops] };
  } catch {
    let working = canvas;
    const applied: DesignOp[] = [];
    for (const op of ops) {
      try {
        working = applyDesignOps(working, [op]);
        applied.push(op);
      } catch {
        // Someone else removed what this op names, or it no longer validates.
      }
    }
    return { canvas: working, applied };
  }
}

/** The artboards of a page in reading order: rows top to bottom, each left to right. */
export function boardsInReadingOrder(canvas: DesignCanvas, page: string): DesignBoard[] {
  return canvas.boards
    .filter((board) => board.page === page)
    .sort((a, b) => (Math.abs(a.y - b.y) < 40 ? a.x - b.x : a.y - b.y));
}
