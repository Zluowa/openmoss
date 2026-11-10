// FILE: deckLayouts.ts
// Purpose: The ten slide layouts (空白 / 标题 / 章节 / 标题+正文 / 要点 / 两栏 / 表格 / 引用 /
//          图片+说明 / 结尾) as element sets on the 1920×1080 stage, filled from plain content.
// Layer: Shared model (agent tools, outline import, the editor's 新建幻灯片 picker via the host)

import {
  makeTextBody,
  newSlideId,
  type DeckTheme,
  type Fill,
  type Slide,
  type SlideElement,
  type SlideLayout,
  type TableElement,
  type TextElement,
  type TextRole,
  type TextStyleId,
} from "./slidesDeck";

/** Words (and optional picture/table) a layout is filled with. Every field is optional. */
export interface LayoutContent {
  readonly title?: string;
  readonly subtitle?: string;
  readonly body?: string;
  readonly bullets?: readonly string[];
  readonly left?: string;
  readonly right?: string;
  readonly leftTitle?: string;
  readonly rightTitle?: string;
  readonly quote?: string;
  readonly attribution?: string;
  readonly image?: string;
  readonly imageAlt?: string;
  readonly caption?: string;
  readonly table?: readonly (readonly string[])[];
  readonly eyebrow?: string;
}

export const LAYOUT_LABELS: Record<SlideLayout, { zh: string; en: string }> = {
  blank: { zh: "空白", en: "Blank" },
  title: { zh: "标题", en: "Title" },
  section: { zh: "章节", en: "Section" },
  "title-body": { zh: "标题 + 正文", en: "Title + body" },
  bullets: { zh: "要点", en: "Bullets" },
  "two-columns": { zh: "两栏", en: "Two columns" },
  table: { zh: "表格", en: "Table" },
  quote: { zh: "引用", en: "Quote" },
  "image-caption": { zh: "图片 + 说明", en: "Image + caption" },
  closing: { zh: "结尾", en: "Closing" },
};

const M = 128; // outer margin, matches the 128 px guides people snap to
const W = 1920 - M * 2;

function text(
  role: TextRole,
  style: TextStyleId,
  box: { x: number; y: number; w: number; h: number },
  value: string,
  options: Partial<
    Pick<TextElement["body"], "align" | "vAlign" | "color" | "weight" | "size">
  > = {},
): TextElement {
  return {
    id: newSlideId("e"),
    type: "text",
    role,
    ...box,
    body: makeTextBody(value, style, options),
  };
}

const bulletsText = (items: readonly string[] | undefined, fallback?: string) =>
  items?.length ? items.map((item) => `- ${item}`).join("\n") : (fallback ?? "");

export function layoutElements(
  layout: SlideLayout,
  theme: DeckTheme,
  content: LayoutContent = {},
): SlideElement[] {
  const eyebrow = content.eyebrow
    ? [
        text("label", "label", { x: M, y: M, w: W, h: 40 }, content.eyebrow, {
          color: theme.colors.accent,
        }),
      ]
    : [];
  const header = (title: string | undefined) =>
    text("title", "heading", { x: M, y: M + (content.eyebrow ? 56 : 0), w: W, h: 96 }, title ?? "");
  const top = M + (content.eyebrow ? 56 : 0) + 96 + 48;
  switch (layout) {
    case "blank":
      return [];
    case "title":
      return [
        ...(content.eyebrow
          ? [
              text("label", "label", { x: M, y: 500, w: W, h: 40 }, content.eyebrow, {
                color: theme.colors.accent,
              }),
            ]
          : []),
        text("title", "display", { x: M, y: 560, w: W, h: 200 }, content.title ?? "", {
          vAlign: "bottom",
        }),
        text("subtitle", "subheading", { x: M, y: 780, w: W, h: 80 }, content.subtitle ?? ""),
      ];
    case "section":
      return [
        {
          id: newSlideId("e"),
          type: "shape",
          shape: "rect",
          x: M,
          y: 470,
          w: 120,
          h: 10,
          fill: { type: "solid", color: theme.colors.accent },
        },
        text("label", "label", { x: M, y: 410, w: W, h: 40 }, content.eyebrow ?? "", {
          color: theme.colors.accent,
        }),
        text("title", "title", { x: M, y: 510, w: W, h: 120 }, content.title ?? ""),
        text("subtitle", "subheading", { x: M, y: 650, w: W, h: 70 }, content.subtitle ?? ""),
      ];
    case "title-body":
      return [
        ...eyebrow,
        header(content.title),
        text("body", "body", { x: M, y: top, w: W, h: 1080 - top - M }, content.body ?? ""),
      ];
    case "bullets":
      return [
        ...eyebrow,
        header(content.title),
        text(
          "body",
          "body",
          { x: M, y: top, w: W, h: 1080 - top - M },
          bulletsText(content.bullets, content.body),
        ),
      ];
    case "two-columns": {
      const colW = (W - 96) / 2;
      const hasHeads = !!(content.leftTitle || content.rightTitle);
      const bodyTop = top + (hasHeads ? 72 : 0);
      return [
        ...eyebrow,
        header(content.title),
        ...(hasHeads
          ? [
              text(
                "label",
                "subheading",
                { x: M, y: top, w: colW, h: 56 },
                content.leftTitle ?? "",
                {
                  color: theme.colors.text,
                  weight: 600,
                },
              ),
              text(
                "label",
                "subheading",
                { x: M + colW + 96, y: top, w: colW, h: 56 },
                content.rightTitle ?? "",
                { color: theme.colors.text, weight: 600 },
              ),
            ]
          : []),
        text(
          "body",
          "body",
          { x: M, y: bodyTop, w: colW, h: 1080 - bodyTop - M },
          content.left ?? "",
        ),
        text(
          "body",
          "body",
          { x: M + colW + 96, y: bodyTop, w: colW, h: 1080 - bodyTop - M },
          content.right ?? "",
        ),
      ];
    }
    case "table": {
      const rows = content.table?.length
        ? content.table
        : [
            ["项目", "状态", "负责人"],
            ["", "", ""],
            ["", "", ""],
          ];
      const columns = Math.max(1, ...rows.map((row) => row.length));
      const rowH = Math.min(88, Math.floor((1080 - top - M) / rows.length));
      const table: TableElement = {
        id: newSlideId("e"),
        type: "table",
        x: M,
        y: top,
        w: W,
        h: rowH * rows.length,
        columns: Array.from({ length: columns }, () => Math.round((W / columns) * 100) / 100),
        rows: rows.map((row) => ({
          height: rowH,
          cells: Array.from({ length: columns }, (_, c) => ({
            body: makeTextBody(row[c] ?? "", "body", {
              autofit: "none",
              vAlign: "middle",
              size: 24,
            }),
          })),
        })),
        header: true,
        banded: true,
        style: {
          headerFill: theme.colors.text,
          headerText: theme.colors.background,
          bandFill: theme.colors.surface,
          border: { color: theme.colors.border ?? theme.colors.muted, width: 1, dash: "solid" },
          fontSize: 24,
        },
      };
      return [...eyebrow, header(content.title), table];
    }
    case "quote":
      return [
        text(
          "body",
          "title",
          { x: 240, y: 330, w: 1440, h: 300 },
          content.quote ?? content.title ?? "",
          {
            align: "center",
            vAlign: "middle",
          },
        ),
        text("caption", "caption", { x: 240, y: 680, w: 1440, h: 60 }, content.attribution ?? "", {
          align: "center",
        }),
      ];
    case "image-caption": {
      const imageTop = M + 96 + 32;
      const image: SlideElement = content.image
        ? {
            id: newSlideId("e"),
            type: "image",
            x: M,
            y: imageTop,
            w: W,
            h: 1080 - imageTop - M - 80,
            src: content.image,
            ...(content.imageAlt ? { alt: content.imageAlt } : {}),
            fit: "cover",
            radius: 12,
          }
        : {
            id: newSlideId("e"),
            type: "shape",
            shape: "roundRect",
            name: "图片占位",
            x: M,
            y: imageTop,
            w: W,
            h: 1080 - imageTop - M - 80,
            radius: 12,
            fill: { type: "solid", color: theme.colors.surface },
            border: { color: theme.colors.border ?? theme.colors.muted, width: 2, dash: "dash" },
          };
      return [
        text("title", "heading", { x: M, y: M, w: W, h: 96 }, content.title ?? ""),
        image,
        text(
          "caption",
          "caption",
          { x: M, y: 1080 - M - 56, w: W, h: 56 },
          content.caption ?? content.body ?? "",
        ),
      ];
    }
    case "closing":
      return [
        text("title", "display", { x: M, y: 400, w: W, h: 180 }, content.title ?? "谢谢", {
          vAlign: "bottom",
        }),
        text("subtitle", "subheading", { x: M, y: 600, w: W, h: 80 }, content.subtitle ?? ""),
      ];
  }
}

export function createSlide(
  layout: SlideLayout,
  theme: DeckTheme,
  content: LayoutContent = {},
  extra: { notes?: string; sectionId?: string | null; background?: Fill } = {},
): Slide {
  return {
    id: newSlideId("s"),
    sectionId: extra.sectionId ?? null,
    layout,
    background: extra.background ?? { type: "solid", color: theme.colors.background },
    transition: "none",
    notes: extra.notes ?? "",
    elements: layoutElements(layout, theme, content),
  };
}
