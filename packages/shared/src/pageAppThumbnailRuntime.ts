// FILE: pageAppThumbnailRuntime.ts
// Purpose: Owner-requested, bounded DOM previews inside the existing app sandbox.
// Layer: Shared (script generation only; no desktop or cross-frame capture)

export const PAGE_APP_THUMBNAIL_PROTOCOL = "moss-app-thumbnail/1";
export const PAGE_APP_THUMBNAIL_WIDTH = 480;
export const PAGE_APP_THUMBNAIL_HEIGHT = 300;
export const PAGE_APP_THUMBNAIL_MAX_BYTES = 150_000;
export const PAGE_APP_THUMBNAIL_TIMEOUT_MS = 8_000;

export function buildPageAppThumbnailRuntime(parentOrigin: string): string {
  return `(function () {
"use strict";
var host = window.parent;
if (!host || host === window) return;
var protocol = ${JSON.stringify(PAGE_APP_THUMBNAIL_PROTOCOL)};
var origin = ${JSON.stringify(parentOrigin)};
var NativeFunction = Function;
var used = false;
var active = null;
var deadline = null;
var excluded = /^(SCRIPT|STYLE|LINK|META|BASE|TEMPLATE|IFRAME|OBJECT|EMBED|VIDEO|AUDIO)$/;
function rasterData(value) { return new RegExp("^data:image/(?:png|jpeg|gif|webp);base64,", "i").test(value); }
function safeStyle(node, pseudo) {
  var style = window.getComputedStyle(node, pseudo);
  var properties = ["background-image", "mask-image", "-webkit-mask-image", "border-image-source", "list-style-image", "content", "cursor", "filter", "clip-path", "shape-outside", "offset-path"];
  for (var i = 0; i < properties.length; i++) {
    var urls = style.getPropertyValue(properties[i]).matchAll(/url\\(\\s*["']?([^"')]+)["']?\\s*\\)/gi);
    for (var match of urls) if (!rasterData(match[1]) && !/^#[A-Za-z0-9_-]+$/.test(match[1])) return false;
  }
  return true;
}
function safeNode(node) {
  if (node.ownerSVGElement && /^(script|style|foreignobject)$/i.test(node.tagName)) return false;
  if (excluded.test(node.tagName || "")) return true;
  if (node.shadowRoot || (node.tagName === "INPUT" && node.type === "image")) return false;
  if (node.tagName === "IMG" && (!rasterData(node.getAttribute("src") || "") || node.hasAttribute("srcset"))) return false;
  if ((node.tagName === "IMG" && node.naturalWidth * node.naturalHeight > 4_000_000) || (node.tagName === "CANVAS" && node.width * node.height > 4_000_000)) return false;
  if (node.tagName === "SOURCE" || /^(image|feimage|use)$/.test(node.tagName.toLowerCase())) return false;
  return safeStyle(node, null) && safeStyle(node, "::before") && safeStyle(node, "::after");
}
function stop() {
  active = null;
  if (deadline !== null) clearTimeout(deadline);
  deadline = null;
}
window.addEventListener("pagehide", stop, { once: true });
window.addEventListener("message", function (event) {
  if (event.source !== host || event.origin !== origin) return;
  var message = event.data;
  if (!message || message.protocol !== protocol || typeof message.nonce !== "string") return;
  if (message.kind === "cancel" && message.nonce === active) { stop(); return; }
  if (message.kind !== "capture" || used || message.nonce.length > 80) return;
  if (typeof message.renderer !== "string" || message.renderer.length > 50_000) return;
  used = true;
  active = message.nonce;
  var nonce = active;
  deadline = setTimeout(stop, ${PAGE_APP_THUMBNAIL_TIMEOUT_MS});
  Promise.resolve().then(function () {
    if (active !== nonce || !document.body) throw new Error("Unavailable");
    var nodes = document.body.querySelectorAll("*");
    if (nodes.length > 2_000 || document.body.outerHTML.length > 2_000_000) throw new Error("Too large");
    // cloneNode(false) may load img/srcset before the renderer's fetch hook.
    // Reject resource-bearing content before creating any clone, including root styles.
    if (!safeNode(document.body)) throw new Error("Unsupported resource");
    for (var i = 0; i < nodes.length; i++) if (!safeNode(nodes[i])) throw new Error("Unsupported resource");
    // The renderer is the shell's bundled html-to-image, never app-provided code.
    var module = { exports: {} };
    NativeFunction("module", "exports", message.renderer)(module, module.exports);
    var noFetch = new AbortController();
    noFetch.abort();
    var width = Math.min(1_600, Math.max(1, window.innerWidth));
    var height = Math.round(width * ${PAGE_APP_THUMBNAIL_HEIGHT / PAGE_APP_THUMBNAIL_WIDTH});
    var bodyBackground = window.getComputedStyle(document.body).backgroundColor;
    var backdrop = window.getComputedStyle(document.documentElement).backgroundColor;
    if (!backdrop || backdrop === "transparent" || backdrop === "rgba(0, 0, 0, 0)") backdrop = "#ffffff";
    return module.exports.toJpeg(document.body, {
      width: width, height: height,
      canvasWidth: ${PAGE_APP_THUMBNAIL_WIDTH}, canvasHeight: ${PAGE_APP_THUMBNAIL_HEIGHT},
      pixelRatio: 1, quality: 0.72, backgroundColor: backdrop, skipFonts: true,
      // Only already embedded resources: no credentialed or external fetches.
      fetchRequestInit: { signal: noFetch.signal, credentials: "omit" },
      filter: function (node) {
        if (active !== nonce) throw new Error("Cancelled");
        return !excluded.test(node.tagName || "") &&
          !(node.tagName === "INPUT" && node.type === "password");
      },
      // html-to-image applies backgroundColor to both canvas and the clone.
      // Preserve the app's body color after choosing an opaque JPEG backdrop.
      style: { margin: "0", overflow: "hidden", backgroundColor: bodyBackground }
    });
  }).then(function (thumbnail) {
    if (active !== nonce) return;
    if (typeof thumbnail !== "string" || thumbnail.length > ${Math.ceil(PAGE_APP_THUMBNAIL_MAX_BYTES / 3) * 4 + 23}) throw new Error("Too large");
    host.postMessage({ protocol: protocol, kind: "result", nonce: nonce, thumbnail: thumbnail }, origin);
    stop();
  }).catch(function (error) {
    // A bounded error category helps local diagnostics; never send page content or URLs.
    if (active === nonce) host.postMessage({ protocol: protocol, kind: "result", nonce: nonce, thumbnail: null, error: error && error.name === "SecurityError" ? "security" : "unavailable" }, origin);
    stop();
  });
});
})();`;
}
