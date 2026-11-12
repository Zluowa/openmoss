// FILE: pageAppDocumentReady.ts
// Purpose: Makes an agent-written 应用页 run against a ready document. Agents often put their
//          code in <head> and reach for `document.getElementById("root")` at once, which finds
//          nothing there and leaves a blank page. Serving moves those scripts, in order, to the
//          end of <body>; a page that still fails and shows nothing gets a plain message
//          instead of a blank frame. Applied every time a page is served, so saved pages are
//          covered too.
// Layer: Shared (string building only)

import { blankHtmlNonMarkup } from "./htmlMarkup";

const SCRIPT_ELEMENT =
  /<script(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>[\s\S]*?(?:<\/script\s*>|$)/giu;
const CLASSIC_SCRIPT_TYPE =
  /^(?:|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/iu;

const attribute = (attributes: string, name: string): string | null => {
  const match = new RegExp(
    `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?(?=\\s|/|$)`,
    "iu",
  ).exec(attributes);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
};

/** A script the browser runs at once, where it stands (not a module, not deferred or async). */
const runsImmediately = (attributes: string) => {
  const type = attribute(attributes, "type");
  if (type !== null && !CLASSIC_SCRIPT_TYPE.test(type.trim())) return false;
  return attribute(attributes, "defer") === null && attribute(attributes, "async") === null;
};

/**
 * Moves the scripts in <head> that would run before <body> exists into <body>, keeping their
 * order: just before the body's own first script (which may use them), else at the end. Modules, deferred and async scripts, import maps and data blocks stay where they
 * are. A document with no <head> scripts comes back unchanged.
 */
export function runPageScriptsAfterBody(html: string): string {
  const scan = blankHtmlNonMarkup(html);
  const scripts = blankHtmlNonMarkup(html, ["script"]);
  const bodyStart = /<body(?=[\s/>])/iu.exec(scan)?.index;
  const headEnd = /<\/head\s*>/iu.exec(scan)?.index;
  const end = Math.min(headEnd ?? Infinity, bodyStart ?? Infinity);
  if (end === Infinity) return html;
  const moved: Array<{ start: number; end: number }> = [];
  for (const match of scripts.slice(0, end).matchAll(SCRIPT_ELEMENT)) {
    if (runsImmediately(match[1] ?? "")) {
      moved.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (moved.length === 0) return html;
  const kept: string[] = [];
  let at = 0;
  for (const range of moved) {
    kept.push(html.slice(at, range.start));
    at = range.end;
  }
  kept.push(html.slice(at));
  const rest = kept.join("");
  const block = moved.map((range) => html.slice(range.start, range.end)).join("\n");
  const removed = moved.reduce((total, range) => total + range.end - range.start, 0);
  // Before the body's own first script, so they still run before it, else at the end of <body>.
  let target: number | undefined;
  for (const match of scripts.slice(end).matchAll(SCRIPT_ELEMENT)) {
    if (runsImmediately(match[1] ?? "")) {
      target = end + match.index;
      break;
    }
  }
  target ??= [...scan.matchAll(/<\/body\s*>/giu)].at(-1)?.index;
  if (target === undefined) return `${rest}\n${block}`;
  const insertAt = target - removed;
  return `${rest.slice(0, insertAt)}${block}\n${rest.slice(insertAt)}`;
}

/**
 * Shows a plain message when the page's own code failed and left nothing on screen. It never
 * replaces a page that drew something, and the error stays in the console.
 */
export const PAGE_APP_ERROR_SCREEN_SCRIPT = `(function () {
var failed = false;
addEventListener("error", function () { failed = true; });
addEventListener("unhandledrejection", function () { failed = true; });
function blank(body) {
  if (!body) return true;
  if ((body.innerText || "").trim()) return false;
  var drawn = body.querySelectorAll("canvas, svg, img, video, iframe, input, button");
  for (var i = 0; i < drawn.length; i++) {
    var box = drawn[i].getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return false;
  }
  return true;
}
function check() {
  if (!failed || !blank(document.body)) return;
  var zh = /^zh/i.test(navigator.language || "");
  var box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText = "font: 14px/1.6 system-ui, sans-serif; color: #6b6b6b; padding: 32px 24px; text-align: center;";
  box.textContent = zh
    ? "这个应用页运行出错，没能显示内容。可以在对话里让智能体修复它。"
    : "This app page hit an error and couldn't show anything. Ask the agent in the chat to fix it.";
  document.body.replaceChildren(box);
}
addEventListener("load", function () { setTimeout(check, 300); });
})();`;
