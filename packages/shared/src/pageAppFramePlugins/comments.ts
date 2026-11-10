// FILE: comments.ts
// Purpose: Frame half of the `comments` capability: ask Moss to open its
// comment composer beside an element, list and watch the page's comments
// (to draw markers), find the element a comment points at, and resolve or
// remove comments.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const commentsFramePlugin: PageAppFramePlugin = {
  name: "comments",
  frameSource: String.raw`function (bridge) {
  var ATTR = "data-moss-comment";
  function cssPath(element) {
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 12) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift("#" + node.id); break; }
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName; });
        if (same.length > 1) tag += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(tag);
      node = parent;
    }
    return parts.join(" > ");
  }
  function resolveElement(target) {
    if (typeof target === "string") return document.querySelector(target);
    if (target && target.nodeType === 1) return target;
    return null;
  }
  function anchorOf(element, options) {
    var opts = options || {};
    var key = element.getAttribute(ATTR);
    var label = element.getAttribute("aria-label") || (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) || element.tagName.toLowerCase();
    var quote = null;
    try {
      var selection = window.getSelection();
      if (selection && selection.rangeCount && element.contains(selection.anchorNode)) quote = String(selection).trim().slice(0, 500) || null;
    } catch (e) { quote = null; }
    if (typeof opts.quote === "string") quote = opts.quote;
    return {
      target: key ? "[" + ATTR + "=\"" + key.replace(/"/g, "") + "\"]" : cssPath(element),
      label: typeof opts.label === "string" ? opts.label : label,
      x: typeof opts.x === "number" ? opts.x : 0.5,
      y: typeof opts.y === "number" ? opts.y : 0.5,
      quote: quote,
    };
  }
  return {
    open: function (target, options) {
      var element = resolveElement(target);
      if (!element) return Promise.reject(bridge.error("invalid_argument", "open() takes an element or a selector that matches one."));
      var box = element.getBoundingClientRect();
      return bridge.call("open", {
        anchor: anchorOf(element, options),
        rect: { x: box.left, y: box.top, width: box.width, height: box.height },
      });
    },
    list: function () { return bridge.call("list", null).then(function (result) { return result.comments; }); },
    onChange: function (listener) {
      if (typeof listener !== "function") throw new TypeError("onChange() needs a function.");
      return bridge.watch("watch", null, function (value) { if (value) listener(value.comments); }, function () {});
    },
    find: function (comment) {
      var target = comment && comment.anchor ? comment.anchor.target : comment;
      if (typeof target !== "string") return null;
      try { return document.querySelector(target); } catch (e) { return null; }
    },
    resolve: function (id, resolved) { return bridge.call("resolve", { id: String(id), resolved: resolved !== false }); },
    edit: function (id, body) { return bridge.call("edit", { id: String(id), body: String(body) }); },
    delete: function (id) { return bridge.call("delete", { id: String(id) }); },
  };
}`,
};
