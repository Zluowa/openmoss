// FILE: slidesHtml.ts
// Purpose: 下载 → 网页 (.html): the deck as one self-contained page. Each slide is laid out by
//          SlideView off screen (so fitted text keeps its measured size) and kept as live HTML
//          text; pictures are inlined as data URLs, shrunk for 更好 / 好. Arrow keys, Space,
//          PageUp/PageDown, Home/End and a click page through it; F toggles full screen.
// Layer: 资料空间 幻灯片 export
// Exports: exportDeckToHtml, deckHtmlDocument

import { SLIDE_HEIGHT, SLIDE_WIDTH, type SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";

import { createElement } from "react";

import { paint } from "./slidesPdf";
import { SlideView } from "./SlideView";

export type HtmlQuality = "good" | "better" | "best";

/** Longest picture side kept per quality; 最佳 keeps pictures as they are. */
const MAX_PICTURE_SIDE: Record<HtmlQuality, number | null> = {
  good: 1280,
  better: 1920,
  best: null,
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** A picture as a data URL, scaled down to `maxSide` when it is larger (re-encoded as JPEG,
 *  or PNG when it has transparency). Null when it cannot be read. */
async function inlinePicture(src: string, maxSide: number | null): Promise<string | null> {
  if (src.startsWith("data:") && maxSide === null) return src;
  try {
    const response = await fetch(src, { credentials: "same-origin" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (maxSide === null || blob.type === "image/svg+xml" || blob.type === "image/gif")
      return blobToDataUrl(blob);
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close();
      return blobToDataUrl(blob);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const type =
      blob.type === "image/png" || blob.type === "image/webp" ? "image/png" : "image/jpeg";
    return canvas.toDataURL(type, 0.86);
  } catch {
    return null;
  }
}

/** Replaces every `<img src>` and CSS `url(...)` in the slides' markup with an inlined copy. */
async function inlinePictures(markup: string[], quality: HtmlQuality): Promise<string[]> {
  const sources = new Set<string>();
  const IMG = /<(?:img\b[^>]*?\ssrc|video\b[^>]*?\sposter)="([^"]+)"/gu;
  const CSS_URL = /url\(&quot;([^&]+?)&quot;\)|url\("([^"]+?)"\)|url\(([^)"'&]+?)\)/gu;
  for (const html of markup) {
    for (const match of html.matchAll(IMG)) sources.add(match[1]!);
    for (const match of html.matchAll(CSS_URL)) sources.add((match[1] ?? match[2] ?? match[3])!);
  }
  const inlined = new Map<string, string>();
  await Promise.all(
    [...sources].map(async (raw) => {
      const src = raw.replace(/&amp;/gu, "&");
      const data = await inlinePicture(src, MAX_PICTURE_SIDE[quality]);
      if (data) inlined.set(raw, data);
    }),
  );
  return markup.map((html) => {
    let out = html;
    for (const [raw, data] of inlined) out = out.split(raw).join(data);
    return out;
  });
}

/** The page around the slides: fit to the window, one slide at a time. */
export function deckHtmlDocument(
  title: string,
  slides: readonly string[],
  background: string,
): string {
  const body = slides
    .map(
      (html, index) =>
        `<section class="slide" data-index="${index}" aria-label="${index + 1} / ${slides.length}"${index ? " hidden" : ""}>${html}</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Moss">
<title>${escapeHtml(title)}</title>
<style>
html, body { margin: 0; height: 100%; background: ${background}; overflow: hidden; }
body { display: grid; place-items: center; font-family: "Inter Variable", Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; }
.deck { position: relative; width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; transform-origin: center; }
.slide { position: absolute; inset: 0; overflow: hidden; }
.slide[hidden] { display: none; }
.count { position: fixed; right: 16px; bottom: 12px; font: 13px/1 system-ui, sans-serif; color: rgb(128 128 128 / 0.9); }
@media print { html, body { overflow: visible; height: auto; } body { display: block; } .deck { transform: none !important; height: auto; }
  .slide, .slide[hidden] { display: block; position: relative; page-break-after: always; width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; } .count { display: none; } }
</style>
</head>
<body>
<main class="deck" id="deck">
${body}
</main>
<div class="count" id="count" aria-live="polite"></div>
<script>
(function () {
  var deck = document.getElementById("deck"), count = document.getElementById("count");
  var slides = Array.prototype.slice.call(deck.querySelectorAll(".slide")), at = 0;
  function fit() { var s = Math.min(innerWidth / ${SLIDE_WIDTH}, innerHeight / ${SLIDE_HEIGHT}); deck.style.transform = "scale(" + s + ")"; }
  function show(n) { at = Math.max(0, Math.min(slides.length - 1, n)); slides.forEach(function (el, i) { el.hidden = i !== at; }); count.textContent = (at + 1) + " / " + slides.length; if (history.replaceState) history.replaceState(null, "", "#slide-" + (at + 1)); }
  addEventListener("resize", fit);
  addEventListener("keydown", function (e) {
    if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].indexOf(e.key) >= 0) { e.preventDefault(); show(at + 1); }
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].indexOf(e.key) >= 0) { e.preventDefault(); show(at - 1); }
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(slides.length - 1);
    else if (e.key === "f" || e.key === "F") { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); }
  });
  addEventListener("click", function (e) { if (!e.target.closest || !e.target.closest("a")) show(at + (e.clientX < innerWidth / 3 ? -1 : 1)); });
  var m = /^#slide-(\\d+)$/.exec(location.hash);
  fit(); show(m ? Number(m[1]) - 1 : 0);
})();
</script>
</body>
</html>
`;
}

/** The deck (the given slides, else every slide not skipped) as one self-contained web page. */
export async function exportDeckToHtml(
  deck: SlidesDeck,
  title: string,
  options: { slideIds?: readonly string[]; quality?: HtmlQuality } = {},
): Promise<string> {
  const wanted = options.slideIds?.length ? new Set(options.slideIds) : null;
  const slides = deck.slides.filter((slide) => (wanted ? wanted.has(slide.id) : !slide.hidden));
  const list = slides.length ? slides : deck.slides;
  if (!list.length) throw new Error("这个演示文稿里没有幻灯片。");
  // Live: web embeds keep running in the page and videos keep their player (Claude's web page
  // runs embeds too); pictures and video posters are inlined below.
  const markup = await paint(
    deck,
    list,
    async (node) => node.outerHTML,
    undefined,
    (slide) =>
      createElement(SlideView, { slide, theme: deck.theme, width: SLIDE_WIDTH, live: true }),
  );
  const inlined = await inlinePictures(markup, options.quality ?? "best");
  return deckHtmlDocument(title, inlined, "rgb(17 17 16)");
}
