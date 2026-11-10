// FILE: deckPptx.ts
// Purpose: Deck v2 ⇄ PowerPoint. Export writes a real .pptx with editable text boxes (per
//          paragraph alignment, lists, levels), shapes, lines, tables, native charts, pictures
//          (with crop), backgrounds, transitions, sections and speaker notes. Import reads the
//          same back into an editable deck and reports what it could not keep.
// Layer: Shared model (web export/import menus, server agent export/import tools)
// Why: @office-kit/pptx (MIT) runs in Node and the browser, so the person and the agent get
//      the same file from the same code.

import {
  addSlide,
  addSlideChart,
  addSlideImage,
  addSlideLine,
  addSlideShape,
  addSlideTable,
  addSlideTextBox,
  createPresentation,
  emu,
  findSlideLayoutByType,
  findSlidePlaceholder,
  getGroupChildren,
  getParagraphAlignment,
  getParagraphBullet,
  getParagraphLevel,
  getShapeBoundsResolved,
  getShapeFillEffective,
  getShapeImageBytes,
  getShapeImageCrop,
  getShapeKind,
  getShapeName,
  getShapeParagraphCount,
  getShapeParagraphElements,
  getShapePreset,
  getShapeRotation,
  getShapeRunFormatEffective,
  getShapeStrokeEffective,
  getShapeTextAnchor,
  getSlideBackground,
  getSlideCharts,
  getSlideNotes,
  getSlideSections,
  getSlideShapes,
  getSlideSize,
  getSlides,
  getSlideTransition,
  getTableCellFill,
  getTableCellParagraphs,
  getTableCells,
  getTableColumnWidths,
  getTableRowHeights,
  isSlideHidden,
  isTableShape,
  loadPresentation,
  savePresentation,
  setParagraphAlignment,
  setParagraphBullet,
  setParagraphLevel,
  setShapeFill,
  setShapeGradientFill,
  setShapeHyperlink,
  setShapeImageCrop,
  setShapeNoFill,
  setShapeNoStroke,
  setShapeRotation,
  setShapeRunFormat,
  setShapeShadow,
  setShapeStroke,
  setShapeStrokeArrow,
  setShapeStrokeDash,
  setShapeText,
  setShapeTextAnchor,
  setShapeTextAutoFit,
  setShapeTextFormat,
  setShapeTextMargins,
  setSlideBackground,
  setSlideHidden,
  setSlideNotes,
  setSlideSections,
  setSlideTransition,
  setTableCellFill,
  setTableCellTextFormat,
  type PresentationData,
  type SlideData,
  type SlideShapeData,
  type TextFormat,
} from "@office-kit/pptx";

import {
  compact,
  DEFAULT_DECK_THEME,
  makeTextBody,
  newSlideId,
  parseSlidesDeck,
  resolveDeckColors,
  resolveTextStyle,
  SLIDE_HEIGHT,
  SLIDE_SHAPES,
  SLIDE_WIDTH,
  type DeckSection,
  type Fill,
  type Paragraph,
  type Run,
  type Slide,
  type SlideElement,
  type SlideShape,
  type SlidesDeck,
  type SlideTransition,
  type TextBody,
} from "./slidesDeck";

/** A 16:9 PowerPoint slide is 12 192 000 EMU wide; 1920 px → 6350 EMU per px. */
const EMU_PER_PX = 6350;
/** 1920 px = 13.333 in → 144 px per inch → 1 pt = 2 px. */
const PX_PER_PT = 2;
const px = (value: number) => emu(Math.round(value * EMU_PER_PX));
const hex = (color: string) => color.replace(/^#/u, "").toUpperCase();
const pt = (size: number) => Math.round((size / PX_PER_PT) * 2) / 2;

const SHAPE_PRESET: Record<SlideShape, string> = {
  rect: "rect",
  roundRect: "roundRect",
  ellipse: "ellipse",
  diamond: "diamond",
  triangle: "triangle",
  arrowRight: "rightArrow",
  arrowLeft: "leftArrow",
  arrowUp: "upArrow",
  arrowDown: "downArrow",
};
const PRESET_SHAPE: Record<string, SlideShape> = Object.fromEntries(
  Object.entries(SHAPE_PRESET).map(([shape, preset]) => [preset, shape as SlideShape]),
);

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(
    (globalThis as unknown as { Buffer: { from(v: string, e: string): Uint8Array } }).Buffer.from(
      value,
      "base64",
    ),
  );
}
function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192)
      binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  }
  return (
    globalThis as unknown as {
      Buffer: { from(v: Uint8Array): { toString(e: string): string } };
    }
  ).Buffer.from(bytes).toString("base64");
}

export type ImageLoader = (src: string) => Promise<Uint8Array | null>;
const inlineImage = (src: string): Uint8Array | null => {
  const match = /^data:image\/[a-z+]+;base64,(.+)$/u.exec(src);
  return match ? decodeBase64(match[1]!) : null;
};
const defaultLoader: ImageLoader = async (src) => {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(src);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
};

export interface PptxExportReport {
  readonly bytes: Uint8Array;
  /** Things PowerPoint will show differently, in plain Chinese, one per kind. */
  readonly notes: string[];
}

function runFormat(run: Run, body: TextBody, deck: SlidesDeck): TextFormat {
  const style = resolveTextStyle(body, deck.theme);
  return compact({
    font: run.font ?? style.font,
    fontEastAsian: run.font ?? style.font,
    size: pt(run.size ?? style.size),
    color: hex(run.color ?? style.color),
    bold: run.bold ?? style.weight >= 600,
    italic: run.italic === true || undefined,
    underline: run.underline === true || undefined,
    strike: run.strike === true || undefined,
    spc: style.letterSpacing ? Math.round(style.letterSpacing * 50) : undefined,
  }) as TextFormat;
}

/** Writes a text body into a shape that already holds one paragraph per line. */
function writeBody(
  shape: SlideShapeData,
  body: TextBody,
  deck: SlidesDeck,
  notes: Set<string>,
): void {
  const paragraphs = body.paragraphs.length ? body.paragraphs : [{ runs: [{ text: "" }] }];
  // One run per paragraph: mixed formatting inside a paragraph keeps its longest run's look.
  setShapeText(
    shape,
    paragraphs
      .map((p) =>
        p.runs
          .map((r) => r.text)
          .join("")
          .replaceAll("\n", " "),
      )
      .join("\n"),
  );
  setShapeTextFormat(shape, runFormat({ text: "" }, body, deck));
  paragraphs.forEach((paragraph: Paragraph, index) => {
    const main = [...paragraph.runs].sort((a, b) => b.text.length - a.text.length)[0];
    if (paragraph.runs.length > 1) {
      const looks = new Set(paragraph.runs.map((r) => JSON.stringify({ ...r, text: "" })));
      if (looks.size > 1) notes.add("同一段里混合的文字格式在 PowerPoint 中按整段的主要格式保存。");
    }
    // An empty paragraph has no run to format; office-kit throws for it.
    const safe = (write: () => void) => {
      try {
        write();
      } catch {
        /* nothing to format */
      }
    };
    if (main && main.text)
      safe(() => setShapeRunFormat(shape, index, 0, runFormat(main, body, deck)));
    safe(() => setParagraphAlignment(shape, index, paragraph.align ?? body.align));
    if (paragraph.list) safe(() => setParagraphBullet(shape, index, paragraph.list!));
    if (paragraph.level) safe(() => setParagraphLevel(shape, index, paragraph.level!));
  });
  setShapeTextAnchor(
    shape,
    body.vAlign === "middle" ? "center" : body.vAlign === "bottom" ? "bottom" : "top",
  );
  setShapeTextAutoFit(
    shape,
    body.autofit === "shrink" ? "normal" : body.autofit === "grow" ? "shape" : "none",
  );
  setShapeTextMargins(shape, { left: emu(0), right: emu(0), top: emu(0), bottom: emu(0) });
}

function applyAppearance(shape: SlideShapeData, element: SlideElement, notes: Set<string>) {
  const fill = element.fill;
  if (fill?.type === "solid") setShapeFill(shape, hex(fill.color));
  else if (fill?.type === "gradient")
    setShapeGradientFill(shape, {
      stops: [
        { offset: 0, color: hex(fill.from) },
        { offset: 1, color: hex(fill.to) },
      ],
      angleDeg: fill.angle,
    });
  else if (fill?.type === "image") notes.add("图片填充的形状导出为纯色。");
  else if (element.type !== "shape") setShapeNoFill(shape);
  if (element.border && element.border.width > 0) {
    setShapeStroke(shape, {
      color: hex(element.border.color),
      widthEmu: Math.round(element.border.width * EMU_PER_PX),
    });
    if (element.border.dash !== "solid") setShapeStrokeDash(shape, element.border.dash);
  } else setShapeNoStroke(shape);
  if (element.shadow)
    setShapeShadow(shape, {
      color: hex(element.shadow.color),
      blurEmu: Math.round(element.shadow.blur * EMU_PER_PX),
      offsetEmu: Math.round(Math.hypot(element.shadow.x, element.shadow.y) * EMU_PER_PX),
      angleDeg: (Math.atan2(element.shadow.y, element.shadow.x) * 180) / Math.PI,
      opacity: element.shadow.opacity,
    });
  if (element.rotation) setShapeRotation(shape, element.rotation);
  if (element.link && "url" in element.link) setShapeHyperlink(shape, element.link.url);
  if (element.opacity !== undefined && element.opacity < 1)
    notes.add("元素透明度在 PowerPoint 中不保留。");
}

const TRANSITION: Record<SlideTransition, string | null> = {
  none: null,
  fade: "fade",
  push: "push",
  wipe: "wipe",
};

/** Deck → .pptx bytes plus notes on what PowerPoint shows differently. */
export async function exportDeckToPptx(
  deck: SlidesDeck,
  options: { loadImage?: ImageLoader; slideIds?: readonly string[] } = {},
): Promise<PptxExportReport> {
  deck = resolveDeckColors(deck);
  const load = options.loadImage ?? defaultLoader;
  const notes = new Set<string>();
  const pres = createPresentation({ size: "16:9" });
  const blank = findSlideLayoutByType(pres, "blank");
  if (!blank) throw new Error("The PowerPoint writer has no blank layout");
  const wanted = options.slideIds ? new Set(options.slideIds) : null;
  const written = new Map<string, SlideData>();
  for (const source of deck.slides) {
    if (wanted && !wanted.has(source.id)) continue;
    const slide = addSlide(pres, { layout: blank });
    written.set(source.id, slide);
    await writeBackground(slide, source.background, load, notes);
    for (const element of source.elements) await writeElement(slide, element, deck, load, notes);
    if (source.notes.trim()) setSlideNotes(slide, source.notes);
    if (source.hidden) setSlideHidden(slide, true);
    const effect = TRANSITION[source.transition];
    if (effect) setSlideTransition(slide, { effect, speed: "med" });
  }
  if (deck.sections.length && !wanted) {
    const groups: { name: string; slides: SlideData[] }[] = [];
    for (const source of deck.slides) {
      const name =
        deck.sections.find((section) => section.id === source.sectionId)?.title || "默认节";
      const last = groups[groups.length - 1];
      if (last && last.name === name) last.slides.push(written.get(source.id)!);
      else groups.push({ name, slides: [written.get(source.id)!] });
    }
    setSlideSections(pres, groups);
  }
  return { bytes: await savePresentation(pres), notes: [...notes] };
}

async function writeBackground(
  slide: SlideData,
  background: Fill,
  load: ImageLoader,
  notes: Set<string>,
) {
  if (background.type === "solid") setSlideBackground(slide, hex(background.color));
  else if (background.type === "gradient") {
    setSlideBackground(slide, hex(background.from));
    notes.add("渐变背景在 PowerPoint 中以起始色保存。");
  } else if (background.type === "image") {
    const bytes = inlineImage(background.src) ?? (await load(background.src));
    if (bytes) {
      const picture = addSlideImage(slide, bytes, {
        x: px(0),
        y: px(0),
        w: px(SLIDE_WIDTH),
        h: px(SLIDE_HEIGHT),
        name: "背景",
      });
      void picture;
    } else notes.add("有背景图片无法读取，已跳过。");
  }
}

async function writeElement(
  slide: SlideData,
  element: SlideElement,
  deck: SlidesDeck,
  load: ImageLoader,
  notes: Set<string>,
) {
  const box = { x: px(element.x), y: px(element.y), w: px(element.w), h: px(element.h) };
  const name = element.name ? { name: element.name } : {};
  switch (element.type) {
    case "text": {
      const shape = addSlideTextBox(slide, { ...box, text: "", ...name });
      writeBody(shape, element.body, deck, notes);
      applyAppearance(shape, element, notes);
      return;
    }
    case "shape": {
      const shape = addSlideShape(slide, { preset: SHAPE_PRESET[element.shape], ...box, ...name });
      if (element.body) writeBody(shape, element.body, deck, notes);
      applyAppearance(shape, element, notes);
      return;
    }
    case "image": {
      const bytes = inlineImage(element.src) ?? (await load(element.src));
      if (!bytes) {
        notes.add("有图片无法读取，已跳过。");
        return;
      }
      const shape = addSlideImage(slide, bytes, {
        ...box,
        fit: element.fit === "contain" ? "contain" : "fill",
        name: element.alt || element.name || "图片",
      });
      if (element.crop)
        setShapeImageCrop(shape, {
          left: element.crop.l,
          top: element.crop.t,
          right: element.crop.r,
          bottom: element.crop.b,
        });
      if (element.rotation) setShapeRotation(shape, element.rotation);
      if (element.radius) notes.add("图片圆角在 PowerPoint 中不保留。");
      return;
    }
    case "line": {
      const shape = addSlideLine(slide, {
        from: { x: px(element.points[0].x), y: px(element.points[0].y) },
        to: { x: px(element.points[1].x), y: px(element.points[1].y) },
        color: hex(element.stroke.color),
        widthEmu: Math.round(element.stroke.width * EMU_PER_PX),
        ...name,
      });
      if (element.stroke.dash !== "solid") setShapeStrokeDash(shape, element.stroke.dash);
      if (element.endArrow && element.endArrow !== "none")
        setShapeStrokeArrow(shape, "tail", {
          type: element.endArrow === "dot" ? "oval" : "triangle",
        });
      if (element.startArrow && element.startArrow !== "none")
        setShapeStrokeArrow(shape, "head", {
          type: element.startArrow === "dot" ? "oval" : "triangle",
        });
      return;
    }
    case "table": {
      const shape = addSlideTable(slide, {
        ...box,
        rows: element.rows.map((row) =>
          row.cells.map((cell) =>
            cell.body.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n"),
          ),
        ),
        colWidths: element.columns.map((width) => px(width)),
        rowHeights: element.rows.map((row) => px(row.height)),
        firstRow: element.header,
        bandRow: element.banded,
        ...name,
      });
      const cells = getTableCells(shape);
      element.rows.forEach((row, r) =>
        row.cells.forEach((cell, c) => {
          const target = cells[r]?.[c];
          if (!target) return;
          const header = element.header && r === 0;
          const fill =
            cell.fill ??
            (header
              ? element.style.headerFill
              : element.banded && r % 2 === 0 && element.style.bandFill
                ? element.style.bandFill
                : null);
          if (fill) setTableCellFill(target, hex(fill));
          const first = cell.body.paragraphs[0]?.runs[0];
          setTableCellTextFormat(
            target,
            compact({
              size: pt(cell.body.size ?? element.style.fontSize),
              color: hex(
                header
                  ? element.style.headerText
                  : (first?.color ?? cell.body.color ?? deck.theme.colors.text),
              ),
              bold: header || first?.bold === true || undefined,
              font: resolveTextStyle(cell.body, deck.theme).font,
            }) as TextFormat,
          );
        }),
      );
      return;
    }
    case "chart": {
      addSlideChart(slide, {
        ...box,
        ...name,
        spec: {
          kind: element.kind === "donut" ? "doughnut" : element.kind,
          categories: element.labels,
          series: element.series.map((series, i) => ({
            name: series.name,
            values: series.values,
            color: hex(
              series.color ??
                [
                  deck.theme.colors.accent,
                  deck.theme.colors.accent2 ?? deck.theme.colors.muted,
                  deck.theme.colors.text,
                ][i % 3]!,
            ),
          })),
          ...(element.showValues
            ? {
                dataLabels: {
                  showValue: true,
                  showCategory: false,
                  showSeriesName: false,
                  showPercent: false,
                },
              }
            : {}),
        } as Parameters<typeof addSlideChart>[1]["spec"],
      });
      return;
    }
  }
}

// ── Import ──────────────────────────────────────────────────────────────────────────────

export interface PptxImportReport {
  readonly deck: SlidesDeck;
  /** Shapes that could not become editable elements (SmartArt, video, unsupported charts…). */
  readonly skipped: number;
  readonly notes: string[];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function colorOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/^#/u, "");
  return /^[0-9A-Fa-f]{6}$/u.test(clean) ? `#${clean.toUpperCase()}` : null;
}
function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "webp";
  return null;
}

/** Stores a picture somewhere durable; returns its src, or null to inline it. */
export type ImageStore = (bytes: Uint8Array, mime: string, name: string) => Promise<string | null>;

const ALIGN_IN: Record<string, Paragraph["align"]> = {
  l: "left",
  left: "left",
  ctr: "center",
  center: "center",
  r: "right",
  right: "right",
  just: "justify",
  justify: "justify",
  dist: "justify",
  distribute: "justify",
};

/** .pptx bytes → editable deck. `storeImage` keeps pictures out of the deck JSON when it can. */
export async function importPptxToDeck(
  bytes: ArrayBuffer | Uint8Array,
  options: { storeImage?: ImageStore } = {},
): Promise<PptxImportReport> {
  const pres = await loadPresentation(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const size = getSlideSize(pres);
  if (!size || size.width <= 0 || size.height <= 0) throw new Error("这个演示文稿的页面尺寸无效。");
  const scale = Math.min(SLIDE_WIDTH / size.width, SLIDE_HEIGHT / size.height);
  const offsetX = (SLIDE_WIDTH - size.width * scale) / 2;
  const offsetY = (SLIDE_HEIGHT - size.height * scale) / 2;
  const ptToPx = 12700 * scale;
  const notes = new Set<string>();
  let skipped = 0;
  let inlineBytes = 0;

  const toBox = (bounds: { x: number; y: number; w: number; h: number }) => ({
    id: newSlideId("e"),
    x: clamp(Math.round(bounds.x * scale + offsetX), -SLIDE_WIDTH, SLIDE_WIDTH * 2),
    y: clamp(Math.round(bounds.y * scale + offsetY), -SLIDE_HEIGHT, SLIDE_HEIGHT * 2),
    w: clamp(Math.round(bounds.w * scale), 0, SLIDE_WIDTH * 3),
    h: clamp(Math.round(bounds.h * scale), 0, SLIDE_HEIGHT * 3),
  });
  const keepImage = async (raw: Uint8Array, name: string): Promise<string | null> => {
    const mime = imageMime(raw);
    if (!mime) return null;
    const stored = options.storeImage ? await options.storeImage(raw, `image/${mime}`, name) : null;
    if (stored) return stored;
    if (raw.length > 900_000 || inlineBytes + raw.length > 1_200_000) return null;
    inlineBytes += raw.length;
    return `data:image/${mime};base64,${encodeBase64(raw)}`;
  };
  const readBody = (shape: SlideShapeData, isTitle: boolean): TextBody | null => {
    try {
      return readBodyUnsafe(shape, isTitle);
    } catch {
      // Shapes without a text body (plain rectangles, pictures in frames) have no words.
      return null;
    }
  };
  const readBodyUnsafe = (shape: SlideShapeData, isTitle: boolean): TextBody | null => {
    const count = getShapeParagraphCount(shape);
    const paragraphs: Paragraph[] = [];
    let firstSize: number | null = null;
    for (let p = 0; p < count; p++) {
      const runs: Run[] = [];
      let r = 0;
      for (const part of getShapeParagraphElements(shape, p)) {
        if (part.kind === "br") {
          runs.push({ text: "\n" });
          continue;
        }
        let format: TextFormat | null = null;
        if (part.kind === "r") {
          try {
            format = getShapeRunFormatEffective(pres, shape, p, r);
          } catch {
            format = part.format;
          }
          r++;
        } else format = part.format;
        const sizePx = format?.size ? Math.round(format.size * ptToPx) : undefined;
        if (firstSize === null && sizePx) firstSize = sizePx;
        runs.push(
          compact({
            text: part.text,
            bold: format?.bold === true || undefined,
            italic: format?.italic === true || undefined,
            underline:
              (format?.underline && format.underline !== "none") || undefined ? true : undefined,
            color: colorOf(format?.color ?? null) ?? undefined,
            size: sizePx,
            font: format?.fontEastAsian ?? format?.font ?? undefined,
          }),
        );
      }
      const bullet = getParagraphBullet(shape, p);
      const level = Math.min(3, getParagraphLevel(shape, p)) as 0 | 1 | 2 | 3;
      const align = ALIGN_IN[getParagraphAlignment(shape, p) ?? ""] ?? undefined;
      paragraphs.push(
        compact({
          runs: runs.length ? runs : [{ text: "" }],
          align,
          list:
            bullet === "number" || (typeof bullet === "object" && bullet && "autoNum" in bullet)
              ? ("number" as const)
              : bullet === "bullet" || (typeof bullet === "object" && bullet && "char" in bullet)
                ? ("bullet" as const)
                : undefined,
          level: level || undefined,
        }),
      );
    }
    const text = paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("");
    if (!text.trim()) return null;
    // Runs that all share the first size move it to the body, so style changes still apply.
    const sizes = new Set(paragraphs.flatMap((p) => p.runs.map((r) => r.size)));
    const anchor = getShapeTextAnchor(shape);
    return {
      ...makeTextBody("", isTitle ? "title" : "body", {
        ...(sizes.size === 1 && firstSize ? { size: firstSize } : {}),
        vAlign: anchor === "center" ? "middle" : anchor === "bottom" ? "bottom" : "top",
        autofit: "none",
      }),
      paragraphs: paragraphs.map((p) =>
        sizes.size === 1
          ? { ...p, runs: p.runs.map((r) => compact({ ...r, size: undefined })) }
          : p,
      ),
    };
  };

  const readShape = async (
    shape: SlideShapeData,
    title: SlideShapeData | null,
    out: SlideElement[],
  ): Promise<void> => {
    const kind = getShapeKind(shape);
    if (kind === "group") {
      for (const child of getGroupChildren(shape)) await readShape(child, title, out);
      return;
    }
    if (kind === "graphicFrame") {
      if (isTableShape(shape)) {
        out.push(readTable(shape));
        return;
      }
      // Charts are collected per slide below; anything else (SmartArt, OLE) is skipped.
      return;
    }
    const bounds = getShapeBoundsResolved(pres, shape);
    if (!bounds) {
      skipped++;
      return;
    }
    const box = toBox(bounds);
    const rotation = getShapeRotation(shape);
    const extra = compact({
      rotation: rotation ? Math.round(rotation * 100) / 100 : undefined,
      name: getShapeName(shape) || undefined,
    });
    if (kind === "picture") {
      const raw = getShapeImageBytes(shape);
      const src = raw ? await keepImage(raw, getShapeName(shape) || "图片") : null;
      if (!src) {
        skipped++;
        notes.add("有图片太大或格式不支持，已跳过。");
        return;
      }
      const crop = getShapeImageCrop(shape);
      out.push(
        compact({
          ...box,
          ...extra,
          type: "image" as const,
          src,
          fit: "cover" as const,
          crop: crop
            ? {
                l: clamp(crop.left ?? 0, 0, 0.95),
                t: clamp(crop.top ?? 0, 0, 0.95),
                r: clamp(crop.right ?? 0, 0, 0.95),
                b: clamp(crop.bottom ?? 0, 0, 0.95),
              }
            : undefined,
        }),
      );
      return;
    }
    const strokeInfo = getShapeStrokeEffective(pres, shape);
    const border =
      strokeInfo.kind === "solid" && colorOf(strokeInfo.color)
        ? {
            color: colorOf(strokeInfo.color)!,
            width: Math.max(1, Math.round((strokeInfo.widthEmu ?? 12700) / EMU_PER_PX)),
            dash: "solid" as const,
          }
        : undefined;
    if (kind === "connector") {
      out.push({
        ...box,
        ...extra,
        type: "line",
        points: [
          { x: box.x, y: box.y },
          { x: box.x + box.w, y: box.y + box.h },
        ],
        stroke: border ?? { color: "#252420", width: 2, dash: "solid" },
      });
      return;
    }
    const fillInfo = getShapeFillEffective(pres, shape);
    const fillColor = fillInfo.kind === "solid" ? colorOf(fillInfo.color) : null;
    const fill: Fill | undefined = fillColor ? { type: "solid", color: fillColor } : undefined;
    const body = readBody(shape, shape === title);
    const preset = getShapePreset(shape) ?? "rect";
    const known =
      PRESET_SHAPE[preset] ??
      ((SLIDE_SHAPES as readonly string[]).includes(preset) ? (preset as SlideShape) : null);
    if (!known && preset !== "rect" && (fill || border)) notes.add("部分特殊形状已转为矩形。");
    if ((fill || border) && (known ?? "rect") !== "rect") {
      out.push(
        compact({
          ...box,
          ...extra,
          type: "shape" as const,
          shape: known ?? "rect",
          fill,
          border,
          body: body ?? undefined,
        }),
      );
      return;
    }
    if (body) {
      out.push(
        compact({
          ...box,
          ...extra,
          type: "text" as const,
          role: shape === title ? ("title" as const) : undefined,
          body,
          fill,
          border,
        }),
      );
      return;
    }
    if (fill || border)
      out.push(
        compact({ ...box, ...extra, type: "shape" as const, shape: "rect" as const, fill, border }),
      );
  };

  const readTable = (shape: SlideShapeData): SlideElement => {
    const bounds = getShapeBoundsResolved(pres, shape) ?? {
      x: 0,
      y: 0,
      w: size.width,
      h: size.height,
    };
    const box = toBox(bounds);
    const widths = getTableColumnWidths(shape).map((w) =>
      Math.max(4, Math.round(Number(w) * scale)),
    );
    const heights = getTableRowHeights(shape).map((h) =>
      Math.max(8, Math.round(Number(h) * scale)),
    );
    const rows = getTableCells(shape)
      .slice(0, 30)
      .map((row, r) => ({
        height: heights[r] ?? 64,
        cells: row.slice(0, 12).map((cell) => {
          const paragraphs = getTableCellParagraphs(cell).map(
            (paragraph): Paragraph =>
              compact({
                runs: paragraph.elements.map((part) =>
                  part.kind === "br"
                    ? { text: "\n" }
                    : compact({
                        text: part.text,
                        bold: part.format?.bold === true || undefined,
                        color: colorOf(part.format?.color ?? null) ?? undefined,
                      }),
                ),
                align: ALIGN_IN[paragraph.align ?? ""] ?? undefined,
              }),
          );
          const fillColor = colorOf(getTableCellFill(cell));
          return compact({
            body: {
              ...makeTextBody("", "body", { autofit: "none", vAlign: "middle" }),
              paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }],
            },
            fill: fillColor ?? undefined,
          });
        }),
      }));
    return {
      ...box,
      type: "table",
      columns: widths.slice(0, 12),
      rows,
      header: false,
      banded: false,
      style: {
        headerFill: "#252420",
        headerText: "#FFFFFF",
        border: { color: "#DEDBD3", width: 1, dash: "solid" },
        fontSize: 22,
      },
    };
  };

  const sectionsIn = getSlideSections(pres);
  const sections: DeckSection[] = [];
  const sectionOf = new Map<SlideData, string>();
  for (const section of sectionsIn.slice(0, 40)) {
    const id = newSlideId("sec");
    sections.push({ id, title: section.name.slice(0, 200) });
    for (const slide of section.slides) sectionOf.set(slide, id);
  }

  const slides: Slide[] = [];
  for (const source of getSlides(pres).slice(0, 300)) {
    const title =
      findSlidePlaceholder(source, "title") ?? findSlidePlaceholder(source, "ctrTitle") ?? null;
    const elements: SlideElement[] = [];
    for (const shape of getSlideShapes(source)) await readShape(shape, title, elements);
    for (const chart of getSlideCharts(source)) {
      const bounds = getShapeBoundsResolved(pres, chart.shape);
      const spec = chart.spec;
      const kind =
        spec?.kind === "doughnut"
          ? "donut"
          : spec && ["bar", "column", "line", "pie"].includes(spec.kind)
            ? spec.kind
            : null;
      if (!bounds || !spec || !kind) {
        skipped++;
        notes.add("部分图表类型无法编辑，已跳过。");
        continue;
      }
      elements.push({
        ...toBox(bounds),
        type: "chart",
        kind: kind as "bar" | "column" | "line" | "pie" | "donut",
        labels: spec.categories.slice(0, 60).map(String),
        series: spec.series.slice(0, 12).map((series) =>
          compact({
            name: series.name || "系列",
            values: series.values.slice(0, 60).map((v) => (typeof v === "number" ? v : 0)),
            color: colorOf(series.color ?? null) ?? undefined,
          }),
        ),
        legend: true,
        showValues: spec.dataLabels?.showValue === true,
      });
    }
    const background = getSlideBackground(source);
    const transition = getSlideTransition(source)?.effect;
    slides.push(
      compact({
        id: newSlideId("s"),
        sectionId: sectionOf.get(source) ?? null,
        layout: "blank" as const,
        background: {
          type: "solid" as const,
          color: (background.kind === "solid" ? colorOf(background.color) : null) ?? "#FFFFFF",
        },
        transition: (["fade", "push", "wipe"].includes(String(transition))
          ? transition
          : "none") as SlideTransition,
        hidden: isSlideHidden(source) || undefined,
        notes: (getSlideNotes(source) ?? "").slice(0, 20_000),
        elements: elements.slice(0, 120),
      }),
    );
    if (elements.length > 120) notes.add("有幻灯片元素超过 120 个，多余的已省略。");
  }
  if (slides.length === 0) throw new Error("这个演示文稿里没有幻灯片。");
  return {
    deck: parseSlidesDeck({
      version: 2,
      theme: { ...DEFAULT_DECK_THEME, name: "导入" },
      sections,
      slides,
    }),
    skipped,
    notes: [...notes],
  };
}

export type { PresentationData };
