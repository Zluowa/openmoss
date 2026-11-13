// FILE: designDocument.ts
// Purpose: Turns a 设计 artboard into the document its frame shows (design-system and tweak
//          variables, a content security policy, the play-mode link bridge) and addresses the
//          elements inside it by path, so edits made on the frame's DOM go back into the source.
// Layer: 资料空间 设计 (web)
// Why: The artboard source is the HTML the agent wrote. Editing happens on a parsed copy in a
//      same-origin frame with scripts off; serializing the body gives the new source, so what the
//      person sees and what is stored never drift.

import type {
  DesignBoard,
  DesignCanvas,
  DesignTweak,
  DesignTweakValue,
} from "@moss/shared/spaceItems/designCanvas";
import { designSystemCss } from "@moss/shared/spaceItems/designSystems";

import { bundledFontFaces, bundledFontOrigins } from "./designFontFaces";

export type DesignFrameMode = "edit" | "play" | "export";

/** Message a playing artboard posts when a `board:` link is followed. */
export const DESIGN_NAV_MESSAGE = "moss-design-nav";

/** Message a playing artboard posts when one of its scripts throws. */
export const DESIGN_ERROR_MESSAGE = "moss-design-error";

/** The frame's policy: pictures, video and fonts only from data, blob, https and Moss itself. */
function csp(mode: DesignFrameMode): string {
  const fonts = `font-src data: blob: 'self' ${bundledFontOrigins()} https://fonts.gstatic.com;`;
  const base = `default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; ${fonts}`;
  return mode === "play" ? `${base} script-src 'unsafe-inline';` : base;
}

/** The artboard's markup as a body fragment: a full document keeps its head styles and body. */
export function boardFragment(html: string): string {
  if (!/<(html|body|head)[\s>]/iu.test(html)) return html;
  const head = /<head[^>]*>([\s\S]*?)<\/head>/iu.exec(html)?.[1] ?? "";
  const body =
    /<body[^>]*>([\s\S]*?)<\/body>/iu.exec(html)?.[1] ??
    html.replace(/<\/?(html|head|body)[^>]*>/giu, "");
  const styles = [...head.matchAll(/<(style|link)\b[\s\S]*?(<\/style>|>)/giu)]
    .map((match) => match[0])
    .join("\n");
  return `${styles}${styles ? "\n" : ""}${body}`.trim();
}

/** Strips what must never run or navigate the editor: base, refresh, frames and plugins. */
export function sanitizeFragment(fragment: string, mode: DesignFrameMode): string {
  let out = fragment
    .replace(/<base\b[^>]*>/giu, "")
    .replace(/<meta\b[^>]*http-equiv[^>]*>/giu, "")
    .replace(/<(iframe|object|embed|frame|frameset)\b[\s\S]*?(<\/\1>|\/?>)/giu, "");
  if (mode !== "play") out = out.replace(/<script\b[\s\S]*?<\/script>/giu, "");
  return out;
}

function tweakValue(
  tweak: DesignTweak,
  values: Readonly<Record<string, DesignTweakValue>> | undefined,
): DesignTweakValue {
  return values?.[tweak.name] ?? tweak.default;
}

export function tweakCss(board: DesignBoard): string {
  const lines: string[] = [];
  for (const tweak of board.tweaks ?? []) {
    const value = tweakValue(tweak, board.tweakValues);
    if (typeof value === "boolean") continue;
    const text = String(value).replace(/[;{}<>]/gu, "");
    lines.push(
      `--tweak-${tweak.name}: ${tweak.editor === "range" && tweak.unit ? `${text}${tweak.unit}` : text};`,
    );
  }
  return lines.length ? `:root{${lines.join("")}}` : "";
}

export function tweakAttributes(board: DesignBoard): string {
  return (board.tweaks ?? [])
    .map((tweak) => {
      const value = String(tweakValue(tweak, board.tweakValues)).replace(/["<>&]/gu, "");
      return ` data-tweak-${tweak.name}="${value}"`;
    })
    .join("");
}

const PLAY_BRIDGE = `<script>(function(){document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(h.indexOf('board:')===0){e.preventDefault();parent.postMessage({type:'${DESIGN_NAV_MESSAGE}',board:h.slice(6)},'*');}else if(/^https?:/i.test(h)){e.preventDefault();parent.postMessage({type:'${DESIGN_NAV_MESSAGE}',url:h},'*');}},true);document.addEventListener('submit',function(e){e.preventDefault();},true);var sent=0;function report(m){if(sent++<5)parent.postMessage({type:'${DESIGN_ERROR_MESSAGE}',message:String(m).slice(0,400)},'*');}window.addEventListener('error',function(e){report(e.message||'脚本出错');});window.addEventListener('unhandledrejection',function(e){report(e.reason&&e.reason.message||e.reason||'脚本出错');});})();</script>`;

/** The whole document a frame shows for this artboard. */
export function boardSrcdoc(
  board: DesignBoard,
  canvas: DesignCanvas,
  mode: DesignFrameMode,
): string {
  const theme = canvas.theme ?? "light";
  const system = canvas.system ? designSystemCss(canvas.system.tokens, theme) : "";
  const base = `html,body{margin:0}body{min-height:100%;-webkit-font-smoothing:antialiased}${
    mode === "edit" ? "a,button,input,select,textarea,label{cursor:default}" : ""
  }`;
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}"${tweakAttributes(board)}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(
    mode,
  )}"><style data-moss-design="base">${bundledFontFaces()}${system}${tweakCss(board)}${base}</style></head><body>${sanitizeFragment(
    boardFragment(board.html),
    mode,
  )}${mode === "play" ? PLAY_BRIDGE : ""}</body></html>`;
}

// ─── Element paths ──────────────────────────────────────────────────────────────────────

/** `2.0.1`: element-child indices from the body down. */
export type DesignElementPath = string;

export function elementPath(element: Element, body: HTMLElement): DesignElementPath | null {
  const parts: number[] = [];
  let node: Element | null = element;
  while (node && node !== body) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    parts.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === body && parts.length ? parts.join(".") : null;
}

export function elementAt(body: HTMLElement, path: DesignElementPath): HTMLElement | null {
  let node: Element = body;
  for (const part of path.split(".")) {
    const child = node.children[Number(part)];
    if (!child) return null;
    node = child;
  }
  return node instanceof (body.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)
    ? (node as HTMLElement)
    : null;
}

export function parentPath(path: DesignElementPath): DesignElementPath | null {
  const index = path.lastIndexOf(".");
  return index < 0 ? null : path.slice(0, index);
}

/** Elements a person can select: not head-like nodes the editor never shows. */
export function isSelectable(element: Element): boolean {
  return !/^(STYLE|SCRIPT|LINK|META|TITLE|TEMPLATE|NOSCRIPT|BR)$/u.test(element.tagName);
}

const TAG_NAMES: Record<string, string> = {
  H1: "标题 1",
  H2: "标题 2",
  H3: "标题 3",
  H4: "标题 4",
  H5: "标题 5",
  H6: "标题 6",
  P: "段落",
  SPAN: "文字",
  STRONG: "粗体",
  EM: "斜体",
  A: "链接",
  BUTTON: "按钮",
  IMG: "图片",
  VIDEO: "视频",
  SVG: "图形",
  svg: "图形",
  UL: "列表",
  OL: "编号列表",
  LI: "列表项",
  INPUT: "输入框",
  TEXTAREA: "文本框",
  SELECT: "下拉选择",
  LABEL: "标签",
  FORM: "表单",
  TABLE: "表格",
  TR: "表格行",
  TD: "单元格",
  TH: "表头",
  NAV: "导航",
  HEADER: "页头",
  FOOTER: "页脚",
  MAIN: "主体",
  SECTION: "区块",
  ARTICLE: "文章",
  ASIDE: "侧栏",
  FIGURE: "插图",
  HR: "分隔线",
};

export type DesignLayerKind = "text" | "image" | "shape" | "frame" | "other";

export function layerKind(element: Element): DesignLayerKind {
  if (element.tagName === "IMG" || element.tagName === "VIDEO" || element.tagName === "PICTURE")
    return "image";
  if (element.tagName.toLowerCase() === "svg") return "shape";
  const hasElementChildren = [...element.children].some(isSelectable);
  if (!hasElementChildren && (element.textContent ?? "").trim()) return "text";
  if (element.tagName === "DIV" || element.tagName === "SECTION") {
    const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
    if (display === "flex" || display === "grid" || display === "inline-flex") return "frame";
    return hasElementChildren ? "frame" : "shape";
  }
  return hasElementChildren ? "frame" : "other";
}

/** What a layer row and a breadcrumb call an element: its words, alt, or its kind. */
export function layerLabel(element: Element): string {
  const named = element.getAttribute("data-name") ?? element.getAttribute("aria-label");
  if (named) return named.slice(0, 60);
  if (element.tagName === "IMG") return (element.getAttribute("alt") || "图片").slice(0, 60);
  const kind = layerKind(element);
  const words = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
  if (kind === "text" && words) return words.slice(0, 60);
  const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
  if (kind === "frame" && display.includes("flex"))
    return element.ownerDocument.defaultView
      ?.getComputedStyle(element)
      .flexDirection.startsWith("column")
      ? "纵向排列"
      : "横向排列";
  if (kind === "frame" && display.includes("grid")) return "网格";
  return TAG_NAMES[element.tagName] ?? (kind === "shape" ? "形状" : "容器");
}

export interface DesignLayerNode {
  readonly path: DesignElementPath;
  readonly label: string;
  readonly kind: DesignLayerKind;
  readonly hidden: boolean;
  readonly children: readonly DesignLayerNode[];
}

/** The element tree of an artboard, as the layers panel lists it (≤ 2000 nodes). */
export function layerTree(body: HTMLElement): DesignLayerNode[] {
  let budget = 2_000;
  const walk = (parent: Element, prefix: string): DesignLayerNode[] => {
    const nodes: DesignLayerNode[] = [];
    [...parent.children].forEach((child, index) => {
      if (budget <= 0 || !isSelectable(child)) return;
      budget -= 1;
      const path = prefix ? `${prefix}.${index}` : String(index);
      const style = (child as HTMLElement).style;
      nodes.push({
        path,
        label: layerLabel(child),
        kind: layerKind(child),
        hidden: style?.display === "none" || style?.visibility === "hidden",
        children: child.tagName.toLowerCase() === "svg" ? [] : walk(child, path),
      });
    });
    return nodes;
  };
  return walk(body, "");
}

/** The serialized artboard source after an edit on the frame's DOM. */
export function serializeBody(body: HTMLElement): string {
  return body.innerHTML
    .replace(/\s+contenteditable="(true|plaintext-only)"/gu, "")
    .replace(/\s+data-moss-editing=""/gu, "");
}
