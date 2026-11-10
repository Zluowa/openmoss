// FILE: htmlRenderComments.ts
// Purpose: The page side and the wire format of comments on a visual page: in comment mode
//   a framed page outlines the element under the pointer and reports the one the reader
//   clicks; afterwards it reports where each commented element sits, so its client can keep
//   the comment pins on them while the page scrolls and reflows.
// Layer: Shared html_render bridge
// Spec: docs/design/annotate-and-comment/SPEC.md, "Page comments".

const COMMENT_MODE_METHOD = "moss/comments/mode";
const COMMENT_ANCHORS_METHOD = "moss/comments/anchors";
const COMMENT_REVEAL_METHOD = "moss/comments/reveal";
const COMMENT_PICK_METHOD = "moss/notifications/comment-pick";
const COMMENT_RECTS_METHOD = "moss/notifications/comment-rects";

export const HTML_RENDER_COMMENT_MAX_SELECTOR_LENGTH = 512;
export const HTML_RENDER_COMMENT_MAX_LABEL_LENGTH = 64;
export const HTML_RENDER_COMMENT_MAX_TEXT_LENGTH = 280;
const MAX_ANCHORS = 200;

/** A box in the page's viewport, in CSS pixels. */
export interface HtmlRenderCommentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HtmlRenderCommentPick {
  readonly selector: string;
  readonly label: string;
  readonly text: string;
  readonly rect: HtmlRenderCommentRect;
}

export interface HtmlRenderCommentAnchor {
  readonly id: string;
  readonly selector: string;
}

export interface HtmlRenderCommentRects {
  /** Null for an anchor whose element is gone or has no box. */
  readonly rects: Readonly<Record<string, HtmlRenderCommentRect | null>>;
}

export function htmlRenderCommentModeMessage(on: boolean) {
  return { jsonrpc: "2.0", method: COMMENT_MODE_METHOD, params: { on } } as const;
}

export function htmlRenderCommentAnchorsMessage(anchors: readonly HtmlRenderCommentAnchor[]) {
  return {
    jsonrpc: "2.0",
    method: COMMENT_ANCHORS_METHOD,
    params: { anchors: anchors.slice(0, MAX_ANCHORS) },
  } as const;
}

export function htmlRenderCommentRevealMessage(selector: string) {
  return { jsonrpc: "2.0", method: COMMENT_REVEAL_METHOD, params: { selector } } as const;
}

function readRect(value: unknown): HtmlRenderCommentRect | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x, y, width, height] = value as unknown[];
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number" &&
    [x, y, width, height].every(Number.isFinite) &&
    width >= 0 &&
    height >= 0
    ? { x, y, width, height }
    : null;
}

function notificationParams(data: unknown, method: string): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || message.method !== method) return undefined;
  return typeof message.params === "object" && message.params !== null
    ? (message.params as Record<string, unknown>)
    : undefined;
}

const clip = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The element a reader clicked in comment mode. */
export function readHtmlRenderCommentPick(data: unknown): HtmlRenderCommentPick | undefined {
  const params = notificationParams(data, COMMENT_PICK_METHOD);
  if (!params) return undefined;
  const selector = clip(params.selector, HTML_RENDER_COMMENT_MAX_SELECTOR_LENGTH);
  const rect = readRect(params.rect);
  if (!selector || !rect) return undefined;
  return {
    selector,
    label: clip(params.label, HTML_RENDER_COMMENT_MAX_LABEL_LENGTH) || "element",
    text: clip(params.text, HTML_RENDER_COMMENT_MAX_TEXT_LENGTH),
    rect,
  };
}

/** Where each commented element sits now. */
export function readHtmlRenderCommentRects(data: unknown): HtmlRenderCommentRects | undefined {
  const params = notificationParams(data, COMMENT_RECTS_METHOD);
  if (!params || typeof params.rects !== "object" || params.rects === null) return undefined;
  const rects: Record<string, HtmlRenderCommentRect | null> = {};
  for (const [id, value] of Object.entries(params.rects as Record<string, unknown>).slice(
    0,
    MAX_ANCHORS,
  )) {
    rects[id] = readRect(value);
  }
  return { rects };
}

// Runs in every framed visual page, after the theme bootstrap. Comment mode takes the
// page's pointer: hover outlines the element under it with its `tag#id` label, and a click
// reports that element instead of reaching the page. The outline lives in a closed shadow
// root on <html>, so page styles cannot restyle it and page scripts cannot read it.
// Anchors are re-measured on the next frame after a scroll, resize or DOM change.
export const HTML_RENDER_COMMENT_BRIDGE_SCRIPT = `(function(){if(window.parent===window)return;var on=false,A=[],raf=0,box,tag,root,hov=null;
function P(m,p){window.parent.postMessage({jsonrpc:"2.0",method:m,params:p},"*");}
function esc(v){return window.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,"\\\\$&");}
function sel(el){var parts=[],n=el;while(n&&n.nodeType===1&&n!==document.documentElement){if(n.id&&document.querySelectorAll("#"+esc(n.id)).length===1){parts.unshift("#"+esc(n.id));break;}var t=n.tagName.toLowerCase(),i=1,s=n;while((s=s.previousElementSibling))if(s.tagName===n.tagName)i++;parts.unshift(t+":nth-of-type("+i+")");n=n.parentElement;}return parts.join(">")||"html";}
function lab(el){var t=el.tagName.toLowerCase();if(el.id)return t+"#"+el.id;var c=el.classList&&el.classList.item(0);return c?t+"."+c:t;}
function ui(){if(root)return;var h=document.createElement("moss-comment-layer");h.style.cssText="all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";root=h.attachShadow({mode:"closed"});root.innerHTML='<style>.b{position:fixed;border:1.5px solid var(--a);background:color-mix(in srgb,var(--a) 8%,transparent);border-radius:2px;display:none}.t{position:fixed;padding:2px 6px;border-radius:4px;background:var(--a);color:#fff;font:500 11px/14px ui-monospace,Consolas,monospace;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;display:none}</style><div class="b"></div><div class="t"></div>';h.style.setProperty("--a",getComputedStyle(document.documentElement).getPropertyValue("--ring").trim()||"#2a78d6");box=root.querySelector(".b");tag=root.querySelector(".t");document.documentElement.appendChild(h);}
function paint(){if(!box)return;if(!on||!hov||!hov.isConnected){box.style.display=tag.style.display="none";return;}var r=hov.getBoundingClientRect();box.style.display=tag.style.display="block";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";tag.textContent=lab(hov);var th=18;tag.style.left=Math.max(0,r.left)+"px";tag.style.top=(r.top-th>=0?r.top-th:r.top)+"px";}
function report(){raf=0;paint();if(!A.length)return;var o={};A.forEach(function(a){var el=null;try{el=document.querySelector(a.selector);}catch(x){}if(!el){o[a.id]=null;return;}var r=el.getBoundingClientRect();o[a.id]=r.width||r.height?[r.left,r.top,r.width,r.height]:null;});P(${JSON.stringify(COMMENT_RECTS_METHOD)},{rects:o});}
function soon(){if(!raf)raf=requestAnimationFrame(report);}
function mine(e){return on&&e.isTrusted;}
["pointerdown","mousedown","pointerup","mouseup","dblclick","contextmenu"].forEach(function(k){window.addEventListener(k,function(e){if(!mine(e))return;e.preventDefault();e.stopPropagation();},true);});
window.addEventListener("mousemove",function(e){if(!mine(e))return;var t=e.composedPath()[0];if(t&&t.nodeType===1&&t!==hov){hov=t;paint();}},true);
window.addEventListener("click",function(e){if(!mine(e))return;e.preventDefault();e.stopPropagation();var t=e.composedPath()[0];if(!t||t.nodeType!==1)return;var r=t.getBoundingClientRect();P(${JSON.stringify(COMMENT_PICK_METHOD)},{selector:sel(t),label:lab(t),text:(t.innerText||t.textContent||"").replace(/\\s+/g," ").trim().slice(0,${HTML_RENDER_COMMENT_MAX_TEXT_LENGTH}),rect:[r.left,r.top,r.width,r.height]});},true);
window.addEventListener("scroll",soon,true);window.addEventListener("resize",soon);
if(window.ResizeObserver)new ResizeObserver(soon).observe(document.documentElement);
new MutationObserver(soon).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});
window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0"||!p)return;if(d.method===${JSON.stringify(COMMENT_MODE_METHOD)}){on=p.on===true;ui();document.documentElement.style.cursor=on?"crosshair":"";if(!on)hov=null;paint();}else if(d.method===${JSON.stringify(COMMENT_ANCHORS_METHOD)}&&Array.isArray(p.anchors)){A=p.anchors.filter(function(a){return a&&typeof a.id==="string"&&typeof a.selector==="string";});soon();}else if(d.method===${JSON.stringify(COMMENT_REVEAL_METHOD)}&&typeof p.selector==="string"){var el=null;try{el=document.querySelector(p.selector);}catch(x){}if(el)el.scrollIntoView({block:"center",behavior:"smooth"});}});
})();`;
