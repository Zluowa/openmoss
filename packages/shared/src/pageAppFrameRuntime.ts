// FILE: pageAppFrameRuntime.ts
// Purpose: Builds the script inlined at the top of every served 应用页. It
// defines `window.moss.use(name)` and talks to the Moss shell over
// postMessage only; the page itself has no network access (CSP
// `connect-src 'none'`). Capability namespaces come from frame plugins.
// Layer: Shared (string building only; the output runs inside the page)

import { PAGE_APP_PROTOCOL, PAGE_APP_USE_TIMEOUT_MS } from "@moss/contracts";
import { injectHtmlHeadMarkup } from "./htmlMarkup";
import { HTML_RENDER_COMMENT_BRIDGE_SCRIPT } from "./htmlRenderComments";
import { PAGE_APP_ERROR_SCREEN_SCRIPT, runPageScriptsAfterBody } from "./pageAppDocumentReady";

import type { PageAppFramePlugin } from "./pageAppCapabilityPlugin";
import { aiFramePlugin } from "./pageAppFramePlugins/ai";
import { dbFramePlugin } from "./pageAppFramePlugins/db";
import { desktopFramePlugin } from "./pageAppFramePlugins/desktop";
import { PAGE_APP_EXTENSION_FRAME_PLUGINS } from "./pageAppFramePlugins/extensions";
import { downloadsFramePlugin } from "./pageAppFramePlugins/downloads";
import { pageFramePlugin } from "./pageAppFramePlugins/page";
import { permissionsFramePlugin } from "./pageAppFramePlugins/permissions";
import { userFramePlugin } from "./pageAppFramePlugins/user";
import { buildPageAppThumbnailRuntime } from "./pageAppThumbnailRuntime";

export {
  PAGE_APP_THUMBNAIL_PROTOCOL,
  PAGE_APP_THUMBNAIL_WIDTH,
  PAGE_APP_THUMBNAIL_HEIGHT,
  PAGE_APP_THUMBNAIL_MAX_BYTES,
  PAGE_APP_THUMBNAIL_TIMEOUT_MS,
} from "./pageAppThumbnailRuntime";

/** Frame halves of every capability this build ships. One line per capability. */
export const PAGE_APP_FRAME_PLUGINS: readonly PageAppFramePlugin[] = [
  dbFramePlugin,
  aiFramePlugin,
  downloadsFramePlugin,
  userFramePlugin,
  permissionsFramePlugin,
  pageFramePlugin,
  desktopFramePlugin,
  ...PAGE_APP_EXTENSION_FRAME_PLUGINS,
];

export interface PageAppFrameRuntimeOptions {
  /** Exact origin of the Moss shell that frames the page. */
  readonly parentOrigin: string;
  readonly plugins?: readonly PageAppFramePlugin[];
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Returns the runtime as one self-invoking script. Safe to place inside a
 * `<script>` element: `</` is escaped so the page HTML cannot be closed early.
 */
export function buildPageAppFrameRuntime(options: PageAppFrameRuntimeOptions): string {
  const plugins = options.plugins ?? PAGE_APP_FRAME_PLUGINS;
  const guardedCommentBridge =
    'if(typeof document!=="undefined"&&typeof MutationObserver==="function"){' +
    HTML_RENDER_COMMENT_BRIDGE_SCRIPT +
    "}";
  // No capabilities means no host negotiation, watches, resize or thumbnail work.
  if (plugins.length === 0)
    return (
      `(function(){Object.defineProperty(window,"moss",{value:Object.freeze({use:function(){return Promise.resolve(null);}}),writable:false,configurable:false});})();\n` +
      guardedCommentBridge
    ).replace(/<\//gu, "<\\/");
  const factories = plugins
    .filter((plugin) => PLUGIN_NAME.test(plugin.name))
    .map((plugin) => `${JSON.stringify(plugin.name)}: (${plugin.frameSource.trim()})`)
    .join(",\n");
  const source = `(function () {
"use strict";
var PROTOCOL = ${JSON.stringify(PAGE_APP_PROTOCOL)};
var PARENT_ORIGIN = ${JSON.stringify(options.parentOrigin)};
var USE_TIMEOUT_MS = ${PAGE_APP_USE_TIMEOUT_MS};
var FACTORIES = {
${factories}
};
var host = window.parent;
if (!host || host === window) {
  var hasStandaloneDesktop = !!(window.mossDesktop || window.mossApps);
  var standaloneMemo = new Map();
  Object.defineProperty(window, "moss", {
    value: Object.freeze({
      use: function (name) {
        if (name !== "desktop" || !hasStandaloneDesktop || !Object.prototype.hasOwnProperty.call(FACTORIES, "desktop")) {
          return Promise.resolve(null);
        }
        if (standaloneMemo.has("desktop")) return standaloneMemo.get("desktop");
        var localBridge = Object.freeze({
          call: function () { return Promise.reject(makeError("unavailable", "No parent shell.")); },
          watch: function () { return function () {}; },
          error: makeError,
          use: function (n) { return window.moss.use(n); },
        });
        var p;
        try { p = Promise.resolve(deepFreeze(FACTORIES.desktop(localBridge))); }
        catch (e) { p = Promise.resolve(null); }
        standaloneMemo.set("desktop", p);
        return p;
      },
    }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return;
}
var nextId = 1;
var pending = new Map();
var watches = new Map();
var served = null;
var servedWaiters = [];
var memo = new Map();

function post(message) {
  message.protocol = PROTOCOL;
  try { host.postMessage(message, PARENT_ORIGIN); } catch (e) { /* shell gone */ }
}
function makeError(code, message) {
  return Object.freeze({ code: String(code), message: String(message) });
}
function deepFreeze(value) {
  if (value && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      var desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc && "value" in desc) deepFreeze(desc.value);
    });
  }
  return value;
}
function setServed(list) {
  if (served !== null) return;
  served = Array.isArray(list) ? list.filter(function (n) { return typeof n === "string"; }) : [];
  var waiters = servedWaiters; servedWaiters = [];
  waiters.forEach(function (resolve) { resolve(served); });
}
function whenServed() {
  if (served !== null) return Promise.resolve(served);
  return new Promise(function (resolve) { servedWaiters.push(resolve); });
}
window.addEventListener("message", function (event) {
  if (event.source !== host || event.origin !== PARENT_ORIGIN) return;
  var m = event.data;
  if (!m || m.protocol !== PROTOCOL) return;
  if (m.kind === "init") { setServed(m.served); return; }
  if (m.kind === "result") {
    var p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(makeError(m.error && m.error.code || "unavailable", m.error && m.error.message || "Failed."));
    return;
  }
  if (m.kind === "event") {
    var w = watches.get(m.id);
    if (w) { try { w.next(m.value); } catch (e) { setTimeout(function () { throw e; }); } }
    return;
  }
  if (m.kind === "end") {
    var w2 = watches.get(m.id);
    if (!w2) return;
    watches.delete(m.id);
    try { w2.end(m.error ? makeError(m.error.code, m.error.message) : undefined); } catch (e) { setTimeout(function () { throw e; }); }
    return;
  }
  if (m.kind === "pick-mode") { setPickMode(!!m.active, m.theme); return; }
  if (m.kind === "sync-markers") { syncMarkers(m.markers); }
});
function makeBridge(name) {
  return Object.freeze({
    call: function (method, args) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        post({ kind: "call", id: id, capability: name, method: String(method), args: args === undefined ? null : args });
      });
    },
    watch: function (method, args, next, end) {
      var id = nextId++;
      var done = false;
      watches.set(id, {
        next: next,
        end: function (error) { done = true; if (end) end(error); },
      });
      post({ kind: "watch", id: id, capability: name, method: String(method), args: args === undefined ? null : args });
      return function cancel() {
        if (done || !watches.has(id)) return;
        watches.delete(id);
        done = true;
        post({ kind: "unwatch", id: id });
      };
    },
    error: makeError,
    use: use,
  });
}
function use(name) {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(FACTORIES, name)) {
    return Promise.resolve(null);
  }
  var existing = memo.get(name);
  if (existing) return existing;
  var promise = whenServed().then(function (list) {
    if (list.indexOf(name) < 0) return null;
    try { return deepFreeze(FACTORIES[name](makeBridge(name))); } catch (e) { return null; }
  });
  memo.set(name, promise);
  return promise;
}
Object.defineProperty(window, "moss", {
  value: Object.freeze({ use: use }),
  writable: false,
  configurable: false,
  enumerable: true,
});
setTimeout(function () { setServed([]); }, USE_TIMEOUT_MS);
post({ kind: "hello" });
var lastHeight = 0;
function reportHeight() {
  var doc = document.documentElement;
  if (!doc) return;
  var height = Math.ceil(Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0));
  if (Math.abs(height - lastHeight) < 2) return;
  lastHeight = height;
  post({ kind: "resize", height: height });
}
function startResize() {
  reportHeight();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
}
var lastSelKey = "";
var selTimer = null;
function isEditableSelection(node) {
  var el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}
function describeSelectionAnchor(node) {
  var el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el) return null;
  var tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "text";
  var id = typeof el.id === "string" && el.id.trim() ? "#" + el.id.trim().slice(0, 64) : "";
  var cls = !id && typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\\s+/)[0].slice(0, 48)
    : "";
  var heading = typeof el.closest === "function" ? el.closest("section, article, main, div, p, li, h1, h2, h3") : null;
  var headingEl = heading && typeof heading.querySelector === "function" ? heading.querySelector("h1, h2, h3") : null;
  var labelSource = headingEl && headingEl.textContent ? headingEl.textContent : "";
  return {
    target: (tag + id + cls).slice(0, 256),
    label: String(labelSource).trim().replace(/\\s+/g, " ").slice(0, 160),
  };
}
function reportSelection() {
  if (typeof window.getSelection !== "function") return;
  var sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    if (lastSelKey !== "") {
      lastSelKey = "";
      post({ kind: "selection", text: "", rect: null, anchor: null });
    }
    return;
  }
  if (isEditableSelection(sel.anchorNode) || isEditableSelection(sel.focusNode)) {
    if (lastSelKey !== "") {
      lastSelKey = "";
      post({ kind: "selection", text: "", rect: null, anchor: null });
    }
    return;
  }
  var text = String(sel.toString() || "").trim().replace(/\\s+/g, " ");
  if (text.length < 2) {
    if (lastSelKey !== "") {
      lastSelKey = "";
      post({ kind: "selection", text: "", rect: null, anchor: null });
    }
    return;
  }
  var range = sel.getRangeAt(0);
  var rect = range && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  if (!rect || (rect.width <= 0 && rect.height <= 0)) return;
  var clipped = text.slice(0, 2000);
  var rounded = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  var anchor = describeSelectionAnchor(range.commonAncestorContainer || sel.anchorNode);
  if (anchor && !anchor.label) {
    anchor.label = clipped.slice(0, 48);
  }
  var key = clipped + "@" + rounded.x + "," + rounded.y + "," + rounded.width + "," + rounded.height;
  if (key === lastSelKey) return;
  lastSelKey = key;
  post({ kind: "selection", text: clipped, rect: rounded, anchor: anchor });
}
function scheduleSelectionReport(delay) {
  if (selTimer !== null && typeof clearTimeout === "function") clearTimeout(selTimer);
  selTimer = setTimeout(function () {
    selTimer = null;
    reportSelection();
  }, typeof delay === "number" ? delay : 80);
}
var lastTopHeading = null;
function detectTopHeading() {
  try {
    if (!document || !document.body || typeof document.body.querySelectorAll !== "function") return;
    var found = false;
    var explicit = typeof document.body.querySelector === "function" ? document.body.querySelector("[data-moss-top-heading]") : null;
    if (explicit) {
      found = true;
    } else {
      var headings = document.body.querySelectorAll("h1, h2");
      for (var i = 0; i < headings.length && i < 6; i += 1) {
        var h = headings[i];
        if (!h || typeof h.getBoundingClientRect !== "function") continue;
        var t = String(h.textContent || "").trim();
        if (!t) continue;
        var rect = h.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top >= -4 && rect.top <= 180) {
          found = true;
          break;
        }
      }
    }
    if (found !== lastTopHeading) {
      lastTopHeading = found;
      post({ kind: "heading", hasTopHeading: found });
    }
  } catch (e) { /* ignore heading probe errors */ }
}

var pickActive = false;
var pickBox = null;
var pickTag = null;
var pickTheme = { accent: "#2563eb", surface: "#ffffff", text: "#111111" };
var hoveredPickEl = null;
var currentMarkers = [];
var markerLayer = null;

function isRuntimeOverlayNode(node) {
  return !!(node && typeof node.closest === "function" && node.closest("[data-moss-pick-overlay], [data-moss-marker-layer]"));
}
function escapeCssIdent(value) {
  if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
}
function buildElementSelector(el) {
  if (!el || el.nodeType !== 1) return "body";
  if (el.id && document && typeof document.querySelectorAll === "function") {
    var byId = "#" + escapeCssIdent(el.id);
    try { if (document.querySelectorAll(byId).length === 1) return byId.slice(0, 1024); } catch (e) {}
  }
  var parts = [];
  var cur = el;
  for (var depth = 0; depth < 6 && cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement; depth += 1) {
    var tag = String(cur.tagName || "div").toLowerCase();
    if (cur.id) {
      parts.unshift("#" + escapeCssIdent(cur.id));
      break;
    }
    var part = tag;
    var parent = cur.parentElement;
    if (parent && parent.children) {
      var sameTag = [];
      for (var i = 0; i < parent.children.length; i += 1) {
        if (String(parent.children[i].tagName || "").toLowerCase() === tag) sameTag.push(parent.children[i]);
      }
      if (sameTag.length > 1) {
        var idx = sameTag.indexOf(cur);
        if (idx >= 0) part += ":nth-of-type(" + (idx + 1) + ")";
      }
    }
    parts.unshift(part);
    cur = parent;
  }
  return (parts.join(" > ") || "body").slice(0, 1024);
}
function describePickTag(el) {
  var tag = String(el && el.tagName ? el.tagName : "element").toLowerCase();
  if (el && el.id) return tag + "#" + String(el.id).slice(0, 48);
  var cls = el && el.classList && typeof el.classList.item === "function" ? el.classList.item(0) : null;
  if (!cls && el && typeof el.className === "string" && el.className.trim()) {
    cls = el.className.trim().split(/\\s+/)[0];
  }
  return cls ? tag + "." + String(cls).slice(0, 48) : tag;
}
function applyPickThemeStyles() {
  if (pickBox) {
    pickBox.style.borderColor = pickTheme.accent;
    pickBox.style.background = "color-mix(in srgb, " + pickTheme.accent + " 8%, transparent)";
  }
  if (pickTag) {
    pickTag.style.background = pickTheme.accent;
  }
}
function ensurePickBox() {
  if (pickBox || !document || !document.createElement || !document.documentElement) return pickBox;
  var box = document.createElement("div");
  box.setAttribute("data-moss-pick-overlay", "true");
  box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:1.5px solid " + pickTheme.accent + ";background:color-mix(in srgb, " + pickTheme.accent + " 8%, transparent);border-radius:4px;display:none;box-sizing:border-box;transition:all 60ms ease-out;";
  document.documentElement.appendChild(box);
  pickBox = box;
  var pill = document.createElement("div");
  pill.setAttribute("data-moss-pick-overlay", "true");
  pill.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;padding:2px 6px;border-radius:4px;background:" + pickTheme.accent + ";color:#ffffff;font:500 11px/14px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;display:none;box-shadow:0 2px 6px rgba(0,0,0,0.18);";
  document.documentElement.appendChild(pill);
  pickTag = pill;
  return box;
}
function updatePickBox(target) {
  var box = ensurePickBox();
  if (!box) return;
  if (!pickActive || !target || typeof target.getBoundingClientRect !== "function") {
    box.style.display = "none";
    if (pickTag) pickTag.style.display = "none";
    return;
  }
  var r = target.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) {
    box.style.display = "none";
    if (pickTag) pickTag.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.left = Math.round(r.left) + "px";
  box.style.top = Math.round(r.top) + "px";
  box.style.width = Math.max(1, Math.round(r.width)) + "px";
  box.style.height = Math.max(1, Math.round(r.height)) + "px";
  if (pickTag) {
    pickTag.textContent = describePickTag(target);
    pickTag.style.display = "block";
    pickTag.style.left = Math.round(Math.max(0, r.left)) + "px";
    pickTag.style.top = Math.round(r.top - 18 >= 0 ? r.top - 18 : r.top) + "px";
  }
}
function renderMarkers() {
  if (!document || !document.documentElement || typeof document.createElement !== "function") return;
  if (!currentMarkers || currentMarkers.length === 0) {
    if (markerLayer && markerLayer.parentNode) markerLayer.parentNode.removeChild(markerLayer);
    markerLayer = null;
    return;
  }
  if (!markerLayer) {
    markerLayer = document.createElement("div");
    markerLayer.setAttribute("data-moss-marker-layer", "true");
    markerLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483645;";
    document.documentElement.appendChild(markerLayer);
  }
  while (markerLayer.firstChild) markerLayer.removeChild(markerLayer.firstChild);
  for (var i = 0; i < currentMarkers.length && i < 32; i += 1) {
    var m = currentMarkers[i];
    if (!m || typeof m.selector !== "string" || typeof document.querySelector !== "function") continue;
    var target = null;
    try { target = document.querySelector(m.selector); } catch (e) { target = null; }
    if (!target || typeof target.getBoundingClientRect !== "function") continue;
    var r = target.getBoundingClientRect();
    if (!r || (r.width <= 0 && r.height <= 0)) continue;
    var badge = document.createElement("div");
    badge.textContent = String(m.ordinal || (i + 1));
    badge.style.cssText = "position:fixed;min-width:20px;height:20px;padding:0 5px;border-radius:9999px;background:" + pickTheme.accent + ";color:#ffffff;font:600 11px/20px system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,0.22);transform:translate(-50%,-50%);";
    badge.style.left = Math.round(Math.max(14, Math.min((window.innerWidth || 1280) - 14, r.right))) + "px";
    badge.style.top = Math.round(Math.max(14, Math.min((window.innerHeight || 720) - 14, r.top))) + "px";
    markerLayer.appendChild(badge);
  }
}
function syncMarkers(list) {
  currentMarkers = Array.isArray(list) ? list : [];
  renderMarkers();
}
function setPickMode(next, nextTheme) {
  if (nextTheme && typeof nextTheme === "object") {
    if (typeof nextTheme.accent === "string" && nextTheme.accent.trim()) pickTheme.accent = nextTheme.accent.trim();
    if (typeof nextTheme.surface === "string" && nextTheme.surface.trim()) pickTheme.surface = nextTheme.surface.trim();
    if (typeof nextTheme.text === "string" && nextTheme.text.trim()) pickTheme.text = nextTheme.text.trim();
    applyPickThemeStyles();
    if (currentMarkers && currentMarkers.length > 0) renderMarkers();
  }
  pickActive = !!next;
  if (!pickActive) {
    hoveredPickEl = null;
    updatePickBox(null);
    if (document && document.documentElement && document.documentElement.style) document.documentElement.style.cursor = "";
    return;
  }
  if (document && document.documentElement && document.documentElement.style) document.documentElement.style.cursor = "crosshair";
}
function onPickMove(event) {
  if (!pickActive || !document || typeof document.elementFromPoint !== "function") return;
  var el = document.elementFromPoint(event.clientX, event.clientY);
  if (!el || isRuntimeOverlayNode(el)) return;
  if (el !== hoveredPickEl) {
    hoveredPickEl = el;
    updatePickBox(el);
  }
}
function onPickClick(event) {
  if (!pickActive) return;
  var el =
    event &&
    event.target &&
    event.target.nodeType === 1 &&
    (event.clientX === 0 && event.clientY === 0)
      ? event.target
      : document && typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(event.clientX, event.clientY)
        : event.target;
  if (!el || isRuntimeOverlayNode(el)) return;
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  var r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
  var roleAttr = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  var labelAttr = typeof el.getAttribute === "function"
    ? (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("placeholder") || "")
    : "";
  var rawText = String(el.textContent || "").trim().replace(/\\s+/g, " ");
  var outer = typeof el.outerHTML === "string" ? el.outerHTML.slice(0, 1200) : null;
  post({
    kind: "element-picked",
    selector: buildElementSelector(el),
    tagName: String(el.tagName || "div").toLowerCase().slice(0, 64),
    role: roleAttr ? String(roleAttr).slice(0, 64) : null,
    name: labelAttr ? String(labelAttr).trim().slice(0, 256) : null,
    text: rawText ? rawText.slice(0, 280) : null,
    html: outer,
    rect: {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    },
    viewport: {
      width: Number(window.innerWidth) || 0,
      height: Number(window.innerHeight) || 0,
    },
  });
}
function onPickKeyDown(event) {
  if (!pickActive || !event || event.key !== "Escape") return;
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  setPickMode(false);
  post({ kind: "pick-ended", reason: "escape" });
}
if (typeof document.addEventListener === "function") {
  document.addEventListener("selectionchange", function () { scheduleSelectionReport(90); });
  document.addEventListener("mouseup", function () { scheduleSelectionReport(20); });
  document.addEventListener("keyup", function () { scheduleSelectionReport(60); });
  document.addEventListener("mousemove", onPickMove, true);
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKeyDown, true);
}
if (typeof window.addEventListener === "function") {
  window.addEventListener("scroll", function () {
    if (lastSelKey !== "") {
      lastSelKey = "";
      post({ kind: "selection", text: "", rect: null, anchor: null });
    }
    if (currentMarkers && currentMarkers.length > 0) renderMarkers();
    if (pickActive && hoveredPickEl) updatePickBox(hoveredPickEl);
  }, true);
  window.addEventListener("resize", function () {
    if (currentMarkers && currentMarkers.length > 0) renderMarkers();
  });
}
if (document.readyState === "loading" && typeof document.addEventListener === "function") {
  document.addEventListener("DOMContentLoaded", function () { startResize(); detectTopHeading(); });
} else {
  startResize();
  detectTopHeading();
}
})();`;
  return `${source}\n${buildPageAppThumbnailRuntime(options.parentOrigin)}\n${guardedCommentBridge}`.replace(
    /<\//gu,
    "<\\/",
  );
}

/**
 * Inserts the runtime as the first script the page runs, and makes the page's own scripts run
 * against a ready document (see pageAppDocumentReady).
 */
export function injectPageAppFrameRuntime(html: string, runtime: string): string {
  return injectHtmlHeadMarkup(
    runPageScriptsAfterBody(html),
    `<script>${runtime}</script><script>${PAGE_APP_ERROR_SCREEN_SCRIPT}</script>`,
  );
}
