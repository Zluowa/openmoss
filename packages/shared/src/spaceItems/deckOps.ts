// FILE: deckOps.ts
// Purpose: Ordered deck edits (slides, elements, sections, theme) shared by the agent tools, AI
//          change drafts and the editor; building a deck from an outline; and a slide/element
//          diff used to show what a draft changes.
// Layer: Shared model (server applies agent ops; web/canvas apply accepted drafts)

import { createSlide, layoutElements, type LayoutContent } from "./deckLayouts";
import { findDeckTheme } from "./deckThemes";
import {
  compact,
  DEFAULT_DECK_THEME,
  newSlideId,
  parseDeckTheme,
  parseSlideElement,
  parseSlidesDeck,
  SLIDE_HEIGHT,
  SLIDE_LAYOUTS,
  SLIDE_WIDTH,
  withBodyText,
  type DeckSection,
  type DeckTheme,
  type Fill,
  type Slide,
  type SlideElement,
  type SlideLayout,
  type SlidesDeck,
  type SlideTransition,
} from "./slidesDeck";

export type DeckOp =
  | {
      readonly op: "add-slide";
      readonly layout?: SlideLayout;
      readonly index?: number;
      readonly sectionId?: string | null;
      readonly content?: LayoutContent;
      readonly notes?: string;
      /** A full slide (elements etc.); its id is kept when free, else replaced. */
      readonly slide?: Record<string, unknown>;
    }
  | {
      readonly op: "update-slide";
      readonly slideId: string;
      readonly set: {
        readonly background?: Fill | string;
        readonly transition?: SlideTransition;
        readonly hidden?: boolean;
        readonly notes?: string;
        readonly sectionId?: string | null;
        readonly layout?: SlideLayout;
      };
      /** Re-lays the slide out from this content (keeps pictures and free shapes). */
      readonly content?: LayoutContent;
    }
  | { readonly op: "delete-slide"; readonly slideId: string }
  | { readonly op: "move-slide"; readonly slideId: string; readonly index: number }
  | { readonly op: "duplicate-slide"; readonly slideId: string }
  | {
      readonly op: "add-element";
      readonly slideId: string;
      readonly element: Record<string, unknown>;
      readonly index?: number;
    }
  | {
      readonly op: "update-element";
      readonly slideId: string;
      readonly elementId: string;
      readonly set: Record<string, unknown>;
    }
  | { readonly op: "delete-element"; readonly slideId: string; readonly elementId: string }
  | {
      readonly op: "reorder-element";
      readonly slideId: string;
      readonly elementId: string;
      readonly index: number;
    }
  | {
      readonly op: "set-text";
      readonly slideId: string;
      readonly elementId: string;
      readonly text: string;
    }
  | {
      readonly op: "apply-theme";
      /** A built-in theme id/name, or theme fields to merge. */
      readonly theme: string | Record<string, unknown>;
      /** Recolor slides and elements that used the old theme's colors (default true). */
      readonly restyle?: boolean;
    }
  | { readonly op: "upsert-section"; readonly section: DeckSection; readonly index?: number }
  | { readonly op: "delete-section"; readonly sectionId: string }
  /** 设为封面: the slide 资料空间 cards show. */
  | { readonly op: "set-cover"; readonly slideId: string };

export const DECK_OP_NAMES = [
  "add-slide",
  "update-slide",
  "delete-slide",
  "move-slide",
  "duplicate-slide",
  "add-element",
  "update-element",
  "delete-element",
  "reorder-element",
  "set-text",
  "apply-theme",
  "upsert-section",
  "delete-section",
  "set-cover",
] as const;

export class DeckOpError extends Error {}
function fail(message: string): never {
  throw new DeckOpError(`Invalid deck operation: ${message}`);
}
const clampIndex = (index: number | undefined, length: number) =>
  index === undefined || !Number.isFinite(index)
    ? length
    : Math.max(0, Math.min(length, Math.trunc(index)));

function recolor(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value.toUpperCase()) ?? value;
  if (Array.isArray(value)) return value.map((item) => recolor(item, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = key === "src" || key === "text" || key === "id" ? item : recolor(item, map);
    return out;
  }
  return value;
}

function themeFrom(input: string | Record<string, unknown>, current: DeckTheme): DeckTheme {
  if (typeof input === "string") {
    const found = findDeckTheme(input);
    if (!found) fail(`unknown theme ${input}`);
    return found;
  }
  return parseDeckTheme(input, current);
}

/** Every id used in the deck, so new ids never collide. */
const usedIds = (slides: readonly Slide[]) =>
  new Set(slides.flatMap((slide) => [slide.id, ...slide.elements.map((element) => element.id)]));

function freshIds(slide: Slide, used: Set<string>): Slide {
  const id = !slide.id || used.has(slide.id) ? newSlideId("s") : slide.id;
  used.add(id);
  return {
    ...slide,
    id,
    elements: slide.elements.map((element) => {
      const elementId = used.has(element.id) ? newSlideId("e") : element.id;
      used.add(elementId);
      return { ...element, id: elementId };
    }),
  };
}

export function applyDeckOps(deck: SlidesDeck, ops: readonly DeckOp[]): SlidesDeck {
  if (ops.length === 0) fail("send at least one operation");
  if (ops.length > 200) fail("at most 200 operations per call");
  let theme = deck.theme;
  let coverSlideId = deck.coverSlideId;
  let sections: DeckSection[] = [...deck.sections];
  let slides: Slide[] = [...deck.slides];
  const slideAt = (id: string) => {
    const index = slides.findIndex((slide) => slide.id === id);
    if (index < 0) fail(`no slide with id ${id}`);
    return index;
  };
  const elementAt = (slide: Slide, id: string) => {
    const index = slide.elements.findIndex((element) => element.id === id);
    if (index < 0) fail(`slide ${slide.id} has no element ${id}`);
    return index;
  };
  const setElements = (at: number, elements: SlideElement[]) => {
    slides[at] = { ...slides[at]!, elements };
  };

  ops.forEach((op, n) => {
    const where = `ops[${n}] (${(op as { op?: string }).op ?? "?"})`;
    switch (op.op) {
      case "add-slide": {
        let slide: Slide;
        if (op.slide) {
          // Validate a whole slide through the deck validator.
          const parsed = parseSlidesDeck({
            version: 2,
            theme,
            sections,
            slides: [{ id: newSlideId("s"), ...op.slide }],
          }).slides[0]!;
          slide = freshIds(parsed, usedIds(slides));
        } else {
          const layout = op.layout ?? "title-body";
          if (!SLIDE_LAYOUTS.includes(layout)) fail(`${where}: unknown layout ${layout}`);
          slide = createSlide(layout, theme, op.content ?? {}, { notes: op.notes ?? "" });
        }
        if (op.sectionId !== undefined) slide = { ...slide, sectionId: op.sectionId };
        else if (!op.slide) {
          // A new slide joins the section of the slide before it.
          const before = slides[clampIndex(op.index, slides.length) - 1];
          slide = { ...slide, sectionId: before?.sectionId ?? null };
        }
        slides.splice(clampIndex(op.index, slides.length), 0, slide);
        break;
      }
      case "update-slide": {
        const at = slideAt(op.slideId);
        let slide = slides[at]!;
        const set = op.set ?? {};
        if (op.content || (set.layout && set.layout !== slide.layout)) {
          const layout = set.layout ?? slide.layout;
          if (!SLIDE_LAYOUTS.includes(layout)) fail(`${where}: unknown layout ${layout}`);
          const kept = slide.elements.filter(
            (element) => element.type === "image" || (element.type === "shape" && !element.body),
          );
          const fresh = layoutElements(layout, theme, op.content ?? {});
          const replacedImage =
            fresh.some((element) => element.type === "image") || op.content?.image !== undefined;
          slide = {
            ...slide,
            layout,
            elements: [
              ...(replacedImage ? kept.filter((e) => e.type !== "image") : kept),
              ...fresh,
            ],
          };
        }
        slide = compact({
          ...slide,
          ...(set.background === undefined
            ? {}
            : {
                background:
                  typeof set.background === "string"
                    ? ({ type: "solid", color: set.background } as Fill)
                    : set.background,
              }),
          ...(set.transition === undefined ? {} : { transition: set.transition }),
          ...(set.hidden === undefined ? {} : { hidden: set.hidden || undefined }),
          ...(set.notes === undefined ? {} : { notes: set.notes }),
          ...(set.sectionId === undefined ? {} : { sectionId: set.sectionId }),
        });
        slides[at] = slide;
        break;
      }
      case "delete-slide":
        slides.splice(slideAt(op.slideId), 1);
        break;
      case "move-slide": {
        const [slide] = slides.splice(slideAt(op.slideId), 1);
        slides.splice(clampIndex(op.index, slides.length), 0, slide!);
        break;
      }
      case "duplicate-slide": {
        const at = slideAt(op.slideId);
        slides.splice(at + 1, 0, freshIds({ ...slides[at]!, id: "" }, usedIds(slides)));
        break;
      }
      case "add-element": {
        const at = slideAt(op.slideId);
        const used = usedIds(slides);
        const raw = { ...op.element };
        if (typeof raw.id !== "string" || used.has(raw.id)) raw.id = newSlideId("e");
        const element = parseSlideElement(raw, `${where}.element`);
        const elements = [...slides[at]!.elements];
        elements.splice(clampIndex(op.index, elements.length), 0, element);
        setElements(at, elements);
        break;
      }
      case "update-element": {
        const at = slideAt(op.slideId);
        const index = elementAt(slides[at]!, op.elementId);
        const current = slides[at]!.elements[index]!;
        const { id: _ignoredId, type: _ignoredType, ...set } = op.set ?? {};
        // Shallow merge; `null` removes an optional field. Text style fields may be given at the
        // top level for convenience and land in the body.
        const merged: Record<string, unknown> = { ...current };
        const bodyKeys = [
          "font",
          "size",
          "weight",
          "lineHeight",
          "letterSpacing",
          "color",
          "align",
          "vAlign",
          "autofit",
          "style",
        ];
        for (const [key, value] of Object.entries(set)) {
          if (key === "text" && (current.type === "text" || current.type === "shape")) {
            merged.body = withBodyText(
              (merged.body as never) ?? {
                paragraphs: [],
                style: "body",
                align: "center",
                vAlign: "middle",
                autofit: "shrink",
              },
              String(value ?? ""),
            );
          } else if (
            bodyKeys.includes(key) &&
            (current.type === "text" || current.type === "shape")
          ) {
            const body = (merged.body ?? { text: "" }) as Record<string, unknown>;
            merged.body = value === null ? omit(body, key) : { ...body, [key]: value };
          } else if (value === null) delete merged[key];
          else merged[key] = value;
        }
        const elements = [...slides[at]!.elements];
        elements[index] = parseSlideElement(merged, `${where}.set`);
        setElements(at, elements);
        break;
      }
      case "delete-element": {
        const at = slideAt(op.slideId);
        const index = elementAt(slides[at]!, op.elementId);
        setElements(
          at,
          slides[at]!.elements.filter((_, i) => i !== index),
        );
        break;
      }
      case "reorder-element": {
        const at = slideAt(op.slideId);
        const elements = [...slides[at]!.elements];
        const [element] = elements.splice(elementAt(slides[at]!, op.elementId), 1);
        elements.splice(clampIndex(op.index, elements.length), 0, element!);
        setElements(at, elements);
        break;
      }
      case "set-text": {
        const at = slideAt(op.slideId);
        const index = elementAt(slides[at]!, op.elementId);
        const element = slides[at]!.elements[index]!;
        if (element.type !== "text" && element.type !== "shape")
          fail(`${where}: element ${op.elementId} is a ${element.type}, not text`);
        const body = element.body ?? {
          paragraphs: [],
          style: "body" as const,
          align: "center" as const,
          vAlign: "middle" as const,
          autofit: "shrink" as const,
        };
        const elements = [...slides[at]!.elements];
        elements[index] = { ...element, body: withBodyText(body, op.text) } as SlideElement;
        setElements(at, elements);
        break;
      }
      case "apply-theme": {
        const next = themeFrom(op.theme, theme);
        if (op.restyle !== false) {
          const map = new Map<string, string>();
          for (const key of Object.keys(theme.colors) as (keyof DeckTheme["colors"])[]) {
            const from = theme.colors[key];
            const to = next.colors[key];
            if (typeof from === "string" && typeof to === "string" && !map.has(from))
              map.set(from, to);
          }
          // Text style colors follow the theme through `style`; explicit colors are remapped.
          slides = slides.map((slide) => recolor(slide, map) as Slide);
        }
        theme = next;
        break;
      }
      case "upsert-section": {
        const section = { id: op.section.id || newSlideId("sec"), title: op.section.title ?? "" };
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(section.id)) fail(`${where}: bad section id`);
        const existing = sections.findIndex((item) => item.id === section.id);
        if (existing >= 0) sections[existing] = section;
        else sections.splice(clampIndex(op.index, sections.length), 0, section);
        break;
      }
      case "delete-section":
        sections = sections.filter((item) => item.id !== op.sectionId);
        slides = slides.map((slide) =>
          slide.sectionId === op.sectionId ? { ...slide, sectionId: null } : slide,
        );
        break;
      case "set-cover":
        slideAt(op.slideId);
        coverSlideId = op.slideId;
        break;
      default:
        fail(`${where}: op must be one of ${DECK_OP_NAMES.join(", ")}`);
    }
  });
  // Re-validate the whole result: colors, sizes, ids and limits are checked in one place.
  return parseSlidesDeck({ ...deck, coverSlideId, theme, sections, slides });
}

function omit(value: Record<string, unknown>, key: string) {
  const { [key]: _drop, ...rest } = value;
  return rest;
}

/** An outline an agent (or 从大纲生成) turns into a deck. */
export interface DeckOutline {
  readonly title: string;
  readonly subtitle?: string;
  readonly theme?: string;
  readonly sections?: readonly {
    readonly title: string;
    readonly slides: readonly OutlineSlide[];
  }[];
  readonly slides?: readonly OutlineSlide[];
  readonly closing?: string | false;
}
export interface OutlineSlide extends LayoutContent {
  readonly layout?: SlideLayout;
  readonly notes?: string;
}

/** Picks a layout from the content when the outline does not name one. */
export function guessLayout(slide: OutlineSlide): SlideLayout {
  if (slide.layout) return slide.layout;
  if (slide.table?.length) return "table";
  if (slide.quote) return "quote";
  if (slide.image) return "image-caption";
  if (slide.left || slide.right) return "two-columns";
  if (slide.bullets?.length) return "bullets";
  if (slide.body) return "title-body";
  return "section";
}

export function deckFromOutline(outline: DeckOutline): SlidesDeck {
  const theme = (outline.theme && findDeckTheme(outline.theme)) || DEFAULT_DECK_THEME;
  const slides: Slide[] = [
    createSlide("title", theme, { title: outline.title, subtitle: outline.subtitle ?? "" }),
  ];
  const sections: DeckSection[] = [];
  const add = (item: OutlineSlide, sectionId: string | null) =>
    slides.push(
      createSlide(guessLayout(item), theme, item, { notes: item.notes ?? "", sectionId }),
    );
  for (const item of outline.slides ?? []) add(item, null);
  for (const section of outline.sections ?? []) {
    const id = newSlideId("sec");
    sections.push({ id, title: section.title });
    if (!section.slides.length || section.slides[0]?.layout !== "section")
      slides.push(createSlide("section", theme, { title: section.title }, { sectionId: id }));
    for (const item of section.slides) add(item, id);
  }
  if (outline.closing !== false)
    slides.push(
      createSlide("closing", theme, {
        title: typeof outline.closing === "string" ? outline.closing : "谢谢",
      }),
    );
  if (sections.length) {
    // The cover joins the first section so the overview opens with it.
    slides[0] = { ...slides[0]!, sectionId: sections[0]!.id };
    slides[slides.length - 1] = {
      ...slides[slides.length - 1]!,
      sectionId: slides[slides.length - 1]!.sectionId ?? sections[sections.length - 1]!.id,
    };
  }
  return parseSlidesDeck({
    version: 2,
    size: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
    theme,
    sections,
    slides,
  });
}

export interface DeckDiff {
  readonly addedSlides: string[];
  readonly removedSlides: string[];
  readonly movedSlides: string[];
  /** slideId → changed/added element ids (removed ones are listed under `removedElements`). */
  readonly changedElements: Record<string, string[]>;
  readonly removedElements: Record<string, string[]>;
  readonly changedSlides: string[];
  readonly themeChanged: boolean;
}

/** What `after` changes relative to `before`, by id: drives draft highlights and summaries. */
export function diffDecks(before: SlidesDeck, after: SlidesDeck): DeckDiff {
  const beforeSlides = new Map(before.slides.map((slide) => [slide.id, slide]));
  const afterIds = new Set(after.slides.map((slide) => slide.id));
  const kept = after.slides.filter((slide) => beforeSlides.has(slide.id)).map((s) => s.id);
  const keptBefore = before.slides.filter((slide) => afterIds.has(slide.id)).map((s) => s.id);
  const changedElements: Record<string, string[]> = {};
  const removedElements: Record<string, string[]> = {};
  const changedSlides: string[] = [];
  for (const slide of after.slides) {
    const old = beforeSlides.get(slide.id);
    if (!old) continue;
    const oldElements = new Map(old.elements.map((element) => [element.id, element]));
    const changed = slide.elements
      .filter((element) => JSON.stringify(oldElements.get(element.id)) !== JSON.stringify(element))
      .map((element) => element.id);
    const newIds = new Set(slide.elements.map((element) => element.id));
    const removed = old.elements.filter((element) => !newIds.has(element.id)).map((e) => e.id);
    if (changed.length) changedElements[slide.id] = changed;
    if (removed.length) removedElements[slide.id] = removed;
    const { elements: _a, ...restA } = slide;
    const { elements: _b, ...restB } = old;
    if (
      changed.length ||
      removed.length ||
      JSON.stringify(restA) !== JSON.stringify(restB) ||
      slide.elements.map((e) => e.id).join() !== old.elements.map((e) => e.id).join()
    )
      changedSlides.push(slide.id);
  }
  return {
    addedSlides: after.slides.filter((slide) => !beforeSlides.has(slide.id)).map((s) => s.id),
    removedSlides: before.slides.filter((slide) => !afterIds.has(slide.id)).map((s) => s.id),
    movedSlides: kept.filter((id, i) => keptBefore[i] !== id),
    changedElements,
    removedElements,
    changedSlides,
    themeChanged: JSON.stringify(before.theme) !== JSON.stringify(after.theme),
  };
}

/** Ops that turn `before` into `after` wholesale (filling a blank deck, or a full rewrite draft). */
export function replaceDeckOps(before: SlidesDeck, after: SlidesDeck): DeckOp[] {
  return [
    { op: "apply-theme", theme: after.theme as unknown as Record<string, unknown>, restyle: false },
    ...before.sections.map((section): DeckOp => ({ op: "delete-section", sectionId: section.id })),
    ...after.sections.map((section, index): DeckOp => ({ op: "upsert-section", section, index })),
    ...before.slides.map((slide): DeckOp => ({ op: "delete-slide", slideId: slide.id })),
    ...after.slides.map(
      (slide): DeckOp => ({ op: "add-slide", slide: slide as unknown as Record<string, unknown> }),
    ),
    ...(after.coverSlideId ? [{ op: "set-cover", slideId: after.coverSlideId } as DeckOp] : []),
  ];
}

/**
 * A deck nobody has written anything into yet (a fresh 新建幻灯片, whose cover only repeats the
 * item title): safe for an agent to fill.
 */
export function isBlankDeck(deck: SlidesDeck, title = ""): boolean {
  const words = (
    body: { paragraphs: readonly { runs: readonly { text: string }[] }[] } | undefined,
  ) =>
    (body?.paragraphs ?? [])
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join(" ")
      .trim();
  return (
    deck.slides.length <= 1 &&
    deck.slides.every((slide) =>
      slide.elements.every((element) => {
        if (element.type !== "text" && element.type !== "shape") return false;
        const text = words(element.body);
        return text === "" || text === title.trim();
      }),
    )
  );
}
