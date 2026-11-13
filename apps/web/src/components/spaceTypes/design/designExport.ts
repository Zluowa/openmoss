// FILE: designExport.ts
// Purpose: Exports 设计 artboards: PNG at 1×/2×/3× (one, or several in a .zip), SVG, a PDF with
//          one page per artboard at its own size or a tall artboard broken onto A4/Letter pages,
//          an HTML .zip (one page per artboard, links between them kept), and copying one
//          artboard or element as PNG, SVG or HTML.
// Layer: 资料空间 设计 export (web)
// Why: Every picture is painted from the artboard's own document in a hidden script-less frame,
//      the same document the canvas shows, so exports match the screen.

import {
  boardSrcdoc,
  boardFragment,
  sanitizeFragment,
  tweakAttributes,
  tweakCss,
} from "./designDocument";
import {
  DESIGN_PAPER,
  type DesignBoard,
  type DesignCanvas,
  type DesignPaper,
} from "@moss/shared/spaceItems/designCanvas";
import { designSystemCss } from "@moss/shared/spaceItems/designSystems";

import { writeJpegPdf, type JpegPage } from "../slides/jpegPdf";

const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function paintOptions(board: DesignBoard, scale: number) {
  return {
    width: board.w,
    height: board.h,
    pixelRatio: scale,
    cacheBust: false,
    skipFonts: false,
    imagePlaceholder: PLACEHOLDER,
    style: { width: `${board.w}px`, height: `${board.h}px` },
  };
}

export const DESIGN_EXPORT_SCALES = [1, 2, 3] as const;
export type DesignExportScale = (typeof DESIGN_EXPORT_SCALES)[number];

/** File-system-safe name for an artboard or design. */
export function exportName(name: string, fallback = "设计"): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
      .trim()
      .slice(0, 80) || fallback
  );
}

function uniqueNames(boards: readonly DesignBoard[], extension: string): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const board of boards) {
    const base = exportName(board.name, board.id);
    let name = `${base}.${extension}`;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} ${n}.${extension}`;
    used.add(name.toLowerCase());
    names.set(board.id, name);
  }
  return names;
}

/** Loads the artboard's document in a hidden frame and resolves its root once fonts and images settle. */
async function withBoardDocument<T>(
  board: DesignBoard,
  canvas: DesignCanvas,
  use: (root: HTMLElement) => Promise<T>,
): Promise<T> {
  const frame = window.document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${board.w}px`,
    height: `${board.h}px`,
    border: "0",
  });
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  frame.srcdoc = boardSrcdoc(board, canvas, "export");
  window.document.body.appendChild(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    if (!doc) throw new Error("画板没有加载出来");
    await doc.fonts?.ready.catch(() => undefined);
    await Promise.all(
      [...doc.images].map((image) =>
        image.complete ? undefined : image.decode().catch(() => undefined),
      ),
    );
    return await use(doc.documentElement);
  } finally {
    frame.remove();
  }
}

async function paint(
  board: DesignBoard,
  canvas: DesignCanvas,
  format: "png" | "jpeg",
  scale: number,
): Promise<Blob> {
  const { toBlob, toJpeg } = await import("html-to-image");
  return withBoardDocument(board, canvas, async (root) => {
    const options = paintOptions(board, scale);
    if (format === "jpeg") {
      const url = await toJpeg(root, { ...options, quality: 0.92, backgroundColor: "white" });
      return (await fetch(url)).blob();
    }
    const blob = await toBlob(root, options);
    if (!blob) throw new Error("这张画板画不出图片");
    return blob;
  });
}

export async function exportBoardPng(
  board: DesignBoard,
  canvas: DesignCanvas,
  scale: DesignExportScale,
) {
  return {
    blob: await paint(board, canvas, "png", scale),
    filename: `${exportName(board.name, board.id)}.png`,
  };
}

export async function exportBoardsPngZip(
  boards: readonly DesignBoard[],
  canvas: DesignCanvas,
  scale: DesignExportScale,
  title: string,
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const names = uniqueNames(boards, "png");
  for (const board of boards)
    zip.file(names.get(board.id)!, await paint(board, canvas, "png", scale));
  return { blob: await zip.generateAsync({ type: "blob" }), filename: `${exportName(title)}.zip` };
}

/**
 * Where to break a tall artboard into pages of `pageHeight` (CSS px): at a line with no text,
 * picture or box crossing it, searched upward from each page end; a hard cut only when none is
 * near.
 */
export function flowBreaks(
  boxes: ReadonlyArray<{ top: number; bottom: number }>,
  total: number,
  pageHeight: number,
): number[] {
  const points = [0];
  let at = 0;
  while (at + pageHeight < total - 1) {
    let cut = at + pageHeight;
    for (let y = Math.floor(at + pageHeight); y > at + pageHeight * 0.6; y -= 2) {
      if (!boxes.some((box) => box.top < y && box.bottom > y)) {
        cut = y;
        break;
      }
    }
    points.push(Math.round(cut));
    at = cut;
  }
  points.push(total);
  return points;
}

/** The pieces a page break must not cut: leaf elements, pictures and text blocks. */
function unbreakableBoxes(doc: Document): { top: number; bottom: number }[] {
  const boxes: { top: number; bottom: number }[] = [];
  for (const element of [...doc.body.querySelectorAll("*")].slice(0, 4_000)) {
    const leaf =
      element.children.length === 0 ||
      /^(IMG|VIDEO|SVG|svg|P|H1|H2|H3|H4|H5|H6|LI|BUTTON|TR|FIGURE)$/u.test(element.tagName);
    if (!leaf) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.height < 2_000) boxes.push({ top: rect.top, bottom: rect.bottom });
  }
  return boxes;
}

/** A tall artboard as pages of `paper`, at 2×. */
async function flowPages(
  board: DesignBoard,
  canvas: DesignCanvas,
  paper: DesignPaper,
): Promise<JpegPage[]> {
  const { toCanvas } = await import("html-to-image");
  const size = DESIGN_PAPER[paper];
  const pageHeight = board.w * (size.h / size.w);
  return withBoardDocument(board, canvas, async (root) => {
    const breaks = flowBreaks(unbreakableBoxes(root.ownerDocument), board.h, pageHeight);
    const whole = await toCanvas(root, { ...paintOptions(board, 2), backgroundColor: "white" });
    const pages: JpegPage[] = [];
    for (let index = 0; index + 1 < breaks.length; index += 1) {
      const top = breaks[index]!;
      const bottom = breaks[index + 1]!;
      const sheet = window.document.createElement("canvas");
      sheet.width = board.w * 2;
      sheet.height = Math.round(pageHeight * 2);
      const context = sheet.getContext("2d");
      if (!context) throw new Error("浏览器画不出 PDF 页面");
      context.fillStyle = "white";
      context.fillRect(0, 0, sheet.width, sheet.height);
      context.drawImage(
        whole,
        0,
        top * 2,
        board.w * 2,
        (bottom - top) * 2,
        0,
        0,
        board.w * 2,
        (bottom - top) * 2,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        sheet.toBlob(resolve, "image/jpeg", 0.92),
      );
      if (!blob) throw new Error("浏览器画不出 PDF 页面");
      pages.push({
        jpeg: new Uint8Array(await blob.arrayBuffer()),
        width: sheet.width,
        height: sheet.height,
        pageSize: { width: size.w, height: size.h },
      });
    }
    return pages;
  });
}

/**
 * A PDF of the artboards: one page per artboard at its own size, or, for an artboard set to
 * flow (or every artboard when `flow` is given), its content broken onto A4/Letter pages.
 */
export async function exportBoardsPdf(
  boards: readonly DesignBoard[],
  canvas: DesignCanvas,
  title: string,
  flow?: DesignPaper,
) {
  const pages: JpegPage[] = [];
  for (const board of boards) {
    const paper = flow ?? (board.print === "flow" ? (board.paper ?? "a4") : null);
    if (paper) {
      pages.push(...(await flowPages(board, canvas, paper)));
      continue;
    }
    const blob = await paint(board, canvas, "jpeg", 2);
    pages.push({
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      width: board.w * 2,
      height: board.h * 2,
      pageSize: { width: Math.round(board.w * 0.75), height: Math.round(board.h * 0.75) },
    });
  }
  const bytes = writeJpegPdf(pages);
  return {
    blob: new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }),
    filename: `${exportName(title)}.pdf`,
  };
}

/** A standalone page for one artboard: its system and tweak variables, links to sibling files. */
export function standaloneBoardHtml(
  board: DesignBoard,
  canvas: DesignCanvas,
  files: ReadonlyMap<string, string>,
): string {
  const fragment = sanitizeFragment(boardFragment(board.html), "play").replace(
    /href="board:([A-Za-z0-9_-]+)"/gu,
    (match, id: string) => (files.has(id) ? `href="${encodeURI(files.get(id)!)}"` : match),
  );
  const system = canvas.system
    ? designSystemCss(canvas.system.tokens, canvas.theme ?? "light")
    : "";
  const title = board.name.replace(/[<>&]/gu, "");
  return `<!doctype html>\n<html lang="zh-CN"${tweakAttributes(board)}>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>${system}${tweakCss(board)}html,body{margin:0}</style>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
}

export async function exportBoardsHtmlZip(
  boards: readonly DesignBoard[],
  canvas: DesignCanvas,
  title: string,
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const files = uniqueNames(boards, "html");
  for (const board of boards)
    zip.file(files.get(board.id)!, standaloneBoardHtml(board, canvas, files));
  const list = boards
    .map(
      (board) =>
        `<li><a href="${encodeURI(files.get(board.id)!)}">${board.name.replace(/[<>&]/gu, "")}</a> <small>${board.w}×${board.h}</small></li>`,
    )
    .join("\n");
  zip.file(
    "index.html",
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>${title.replace(/[<>&]/gu, "")}</title>\n<style>body{font-family:system-ui,sans-serif;margin:40px;line-height:1.6}</style>\n</head>\n<body>\n<h1>${title.replace(/[<>&]/gu, "")}</h1>\n<ul>\n${list}\n</ul>\n</body>\n</html>\n`,
  );
  return { blob: await zip.generateAsync({ type: "blob" }), filename: `${exportName(title)}.zip` };
}

export async function copyBoardPng(board: DesignBoard, canvas: DesignCanvas) {
  const blob = await paint(board, canvas, "png", 2);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

const svgText = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

/** The artboard as an SVG file (its HTML inside a foreignObject, as every browser shows it). */
export async function boardSvg(board: DesignBoard, canvas: DesignCanvas): Promise<string> {
  const { toSvg } = await import("html-to-image");
  return withBoardDocument(board, canvas, async (root) =>
    svgText(await toSvg(root, paintOptions(board, 1))),
  );
}

/** One element of an open artboard as SVG. */
export async function elementSvg(element: HTMLElement): Promise<string> {
  const { toSvg } = await import("html-to-image");
  const rect = element.getBoundingClientRect();
  return svgText(
    await toSvg(element, {
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
      cacheBust: false,
      imagePlaceholder: PLACEHOLDER,
      style: { margin: "0", left: "0", top: "0", position: "static", transform: "none" },
    }),
  );
}

export async function exportBoardSvg(board: DesignBoard, canvas: DesignCanvas) {
  return {
    blob: new Blob([await boardSvg(board, canvas)], { type: "image/svg+xml" }),
    filename: `${exportName(board.name, board.id)}.svg`,
  };
}

/** Copies SVG as an image where the browser allows it, and always as text. */
export async function copySvg(svg: string) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/svg+xml": new Blob([svg], { type: "image/svg+xml" }),
        "text/plain": new Blob([svg], { type: "text/plain" }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(svg);
  }
}

export async function copyHtml(html: string) {
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([html], { type: "text/plain" }),
    }),
  ]);
}
