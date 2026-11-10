// FILE: pageAppFrameRuntime.ts
// Purpose: Builds the script inlined at the top of every served 应用页. It
// defines `window.moss.use(name)` and talks to the Moss shell over
// postMessage only; the page itself has no network access (CSP
// `connect-src 'none'`). Capability namespaces come from frame plugins.
// Layer: Shared (string building only; the output runs inside the page)

import { PAGE_APP_PROTOCOL, PAGE_APP_USE_TIMEOUT_MS } from "@moss/contracts";
import { injectHtmlHeadMarkup } from "./htmlMarkup";

import type { PageAppFramePlugin } from "./pageAppCapabilityPlugin";
import { aiFramePlugin } from "./pageAppFramePlugins/ai";
import { dbFramePlugin } from "./pageAppFramePlugins/db";
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
  // No capabilities means no host negotiation, watches, resize or thumbnail work.
  if (plugins.length === 0)
    return `(function(){Object.defineProperty(window,"moss",{value:Object.freeze({use:function(){return Promise.resolve(null);}}),writable:false,configurable:false});})();`;
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
  Object.defineProperty(window, "moss", { value: Object.freeze({ use: function () { return Promise.resolve(null); } }) });
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
  }
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
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startResize);
else startResize();
})();`;
  return `${source}\n${buildPageAppThumbnailRuntime(options.parentOrigin)}`.replace(
    /<\//gu,
    "<\\/",
  );
}

/** Inserts the runtime as the first script the page runs. */
export function injectPageAppFrameRuntime(html: string, runtime: string): string {
  return injectHtmlHeadMarkup(html, `<script>${runtime}</script>`);
}
