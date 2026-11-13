// FILE: slidesPdf.ts
// Purpose: Exports a deck to PDF (one full-bleed page per slide) and single slides to PNG:
//          each slide is painted by SlideView off screen and rasterized.
// Layer: 资料空间 幻灯片 export

import { createElement, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { toJpeg, toPng } from "html-to-image";

import {
  resolveColor,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Slide,
  type SlidesDeck,
} from "@moss/shared/spaceItems/slidesDeck";

import { writeJpegPdf, type JpegPage } from "./jpegPdf";
import { SlideView } from "./SlideView";

/** 好 / 更好 / 最佳: smaller pages and stronger JPEG compression make a smaller file. */
const PDF_QUALITY = {
  good: { ratio: 0.75, jpeg: 0.72 },
  better: { ratio: 1, jpeg: 0.85 },
  best: { ratio: 1.5, jpeg: 0.92 },
} as const;

function dataUrlToBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function imagesReady(root: HTMLElement) {
  await Promise.all(
    [...root.querySelectorAll("img")].map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          }),
    ),
  );
  await document.fonts?.ready;
}

/** Paints slides one by one off screen (laid out, so text measuring and html-to-image work). */
/** A 包含备注 page: the slide on the left, its speaker notes on the right (same 16:9 page). */
function notesPage(deck: SlidesDeck, slide: Slide, number: number): ReactElement {
  return createElement(
    "div",
    {
      style: {
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        display: "flex",
        gap: 64,
        padding: 96,
        boxSizing: "border-box",
        background: "#FFFFFF",
        color: "#252420",
        fontFamily:
          '"Inter Variable", Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      },
    },
    createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 16 } },
      createElement(
        "div",
        { style: { border: "2px solid #DEDBD3", borderRadius: 12, overflow: "hidden" } },
        createElement(SlideView, { slide, theme: deck.theme, width: 1040 }),
      ),
      createElement("span", { style: { fontSize: 24, color: "#6B6A66" } }, `第 ${number} 张`),
    ),
    createElement(
      "div",
      {
        style: {
          flex: 1,
          fontSize: 30,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
        },
      },
      slide.notes || "（没有备注）",
    ),
  );
}

export async function paint<T>(
  deck: SlidesDeck,
  slides: readonly Slide[],
  render: (node: HTMLElement, slide: Slide) => Promise<T>,
  onProgress?: (done: number, total: number) => void,
  view: (slide: Slide, index: number) => ReactElement = (slide) =>
    createElement(SlideView, { slide, theme: deck.theme, width: SLIDE_WIDTH }),
): Promise<T[]> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-${SLIDE_WIDTH * 2}px;top:0;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;pointer-events:none`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const out: T[] = [];
    for (const [index, slide] of slides.entries()) {
      flushSync(() => root.render(view(slide, index)));
      await imagesReady(host);
      out.push(await render(host.firstElementChild as HTMLElement, slide));
      onProgress?.(index + 1, slides.length);
    }
    return out;
  } finally {
    root.unmount();
    host.remove();
  }
}

const background = (deck: SlidesDeck, slide: Slide) =>
  slide.background.type === "solid"
    ? resolveColor(slide.background.color, deck.theme)
    : deck.theme.colors.background;

export async function exportDeckToPdf(
  deck: SlidesDeck,
  onProgress?: (done: number, total: number) => void,
  options: {
    includeHidden?: boolean;
    slideIds?: readonly string[];
    includeNotes?: boolean;
    /** 图片质量: pixel density and JPEG quality of each page (最佳 by default). */
    quality?: "good" | "better" | "best";
  } = {},
) {
  const { ratio, jpeg } = PDF_QUALITY[options.quality ?? "best"];
  const wanted = options.slideIds?.length ? new Set(options.slideIds) : null;
  const slides = deck.slides.filter((slide) =>
    wanted ? wanted.has(slide.id) : options.includeHidden || !slide.hidden,
  );
  const list = slides.length ? slides : deck.slides;
  const pages = await paint<JpegPage>(
    deck,
    list,
    async (node, slide) => {
      const url = await toJpeg(node, {
        quality: jpeg,
        pixelRatio: ratio,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundColor: background(deck, slide),
        cacheBust: false,
        // Web-font CSS from other origins cannot be read (CSP); system fonts paint the text.
        skipFonts: true,
      });
      return {
        jpeg: dataUrlToBytes(url),
        width: Math.round(SLIDE_WIDTH * ratio),
        height: Math.round(SLIDE_HEIGHT * ratio),
      };
    },
    onProgress,
    options.includeNotes
      ? (slide) => notesPage(deck, slide, deck.slides.indexOf(slide) + 1)
      : undefined,
  );
  return writeJpegPdf(pages);
}

/** One slide as a 1920×1080 PNG. */
export async function exportSlideToPng(deck: SlidesDeck, slideId: string): Promise<Uint8Array> {
  const slide = deck.slides.find((item) => item.id === slideId) ?? deck.slides[0];
  if (!slide) throw new Error("这个演示文稿里没有幻灯片。");
  const [png] = await paint(deck, [slide], async (node) =>
    dataUrlToBytes(
      await toPng(node, {
        pixelRatio: 1,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundColor: background(deck, slide),
        cacheBust: false,
        // Web-font CSS from other origins cannot be read (CSP); system fonts paint the text.
        skipFonts: true,
      }),
    ),
  );
  return png!;
}

/** A small PNG data URL of a slide, for cards. */
export async function slideThumbnail(deck: SlidesDeck, slide: Slide, width = 480): Promise<string> {
  const [url] = await paint(deck, [slide], (node) =>
    toPng(node, {
      pixelRatio: width / SLIDE_WIDTH,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      backgroundColor: background(deck, slide),
      cacheBust: false,
      skipFonts: true,
    }),
  );
  return url!;
}
