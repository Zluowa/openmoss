// FILE: svgSanitize.ts
// Purpose: Rewrites an uploaded SVG to an allowlist of drawing elements and
// attributes, dropping scripts, event handlers, foreign content, external
// references and entity declarations. Served SVGs also carry a CSP sandbox,
// so this is the first of two locks, not the only one.
// Layer: Server pages/apps extensions (pure)

const ELEMENTS = new Set(
  [
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "defs",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "symbol",
    "use",
    "title",
    "desc",
    "marker",
    "image",
    "filter",
    "feGaussianBlur",
    "feOffset",
    "feBlend",
    "feColorMatrix",
    "feComposite",
    "feFlood",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feDropShadow",
    "feComponentTransfer",
    "feFuncR",
    "feFuncG",
    "feFuncB",
    "feFuncA",
    "metadata",
  ].map((name) => name.toLowerCase()),
);
const ATTRIBUTE_NAME = /^[A-Za-z_][-A-Za-z0-9_.:]*$/u;
const SAFE_IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/iu;
const MAX_INPUT_CHARS = 5_000_000;

function safeAttribute(element: string, name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (!ATTRIBUTE_NAME.test(name) || lower.startsWith("on")) return false;
  if (lower === "xmlns" || lower.startsWith("xmlns:")) return true;
  const compact = value.replace(/[\s\u0000-\u001f]/gu, "").toLowerCase();
  if (
    compact.includes("javascript:") ||
    compact.includes("vbscript:") ||
    compact.includes("data:text")
  )
    return false;
  if (lower === "href" || lower === "xlink:href" || lower === "src") {
    if (value.trim().startsWith("#")) return true;
    return element === "image" && SAFE_IMAGE_DATA.test(value.trim());
  }
  if (/url\((?!\s*['"]?#)/iu.test(value)) return false;
  if (lower === "style" && /@import|expression\s*\(|behavior\s*:|-moz-binding/iu.test(value))
    return false;
  return true;
}

const escapeAttribute = (value: string) =>
  value
    .replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/giu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/"/gu, "&quot;");

const ATTRIBUTE_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

/** Returns the cleaned SVG, or null when there is no `<svg>` root to keep. */
export function sanitizeSvg(input: string): string | null {
  if (input.length > MAX_INPUT_CHARS) return null;
  const source = input.replace(/^﻿/u, "");
  let out = "";
  let skipDepth = 0;
  const stack: string[] = [];
  let sawRoot = false;
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt < 0) {
      if (skipDepth === 0 && stack.length > 0) out += source.slice(index).replace(/>/gu, "&gt;");
      break;
    }
    if (skipDepth === 0 && stack.length > 0) out += source.slice(index, lt).replace(/>/gu, "&gt;");
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      // Character data only appears in <style>/<script>, neither of which is kept.
      const end = source.indexOf("]]>", lt);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      // DOCTYPE (with any entity subset) and processing instructions are dropped.
      let depth = 0;
      let cursor = lt + 2;
      for (; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        else if (char === ">" && depth <= 0) break;
      }
      index = cursor + 1;
      continue;
    }
    const gt = source.indexOf(">", lt);
    if (gt < 0) break;
    const raw = source.slice(lt + 1, gt);
    index = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      if (skipDepth > 0) {
        skipDepth -= 1;
        continue;
      }
      if (stack.length > 0 && stack[stack.length - 1] === name) {
        stack.pop();
        out += `</${name === "textpath" ? "textPath" : canonical(name)}>`;
      }
      continue;
    }
    const selfClosing = raw.trimEnd().endsWith("/");
    const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw;
    const nameMatch = /^([A-Za-z][-A-Za-z0-9_.:]*)/u.exec(body);
    if (!nameMatch) continue;
    const tag = nameMatch[1]!;
    const lower = tag.toLowerCase();
    if (skipDepth > 0 || !ELEMENTS.has(lower) || (!sawRoot && lower !== "svg")) {
      if (!selfClosing) skipDepth += 1;
      continue;
    }
    sawRoot = true;
    const attributes: string[] = [];
    for (const match of body.slice(tag.length).matchAll(ATTRIBUTE_RE)) {
      const name = match[1]!;
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (safeAttribute(lower, name, value))
        attributes.push(` ${name}="${escapeAttribute(value)}"`);
    }
    out += `<${tag}${attributes.join("")}${selfClosing ? "/" : ""}>`;
    if (!selfClosing) stack.push(lower);
  }
  if (!sawRoot) return null;
  while (stack.length > 0) out += `</${canonical(stack.pop()!)}>`;
  return out;
}

const CANONICAL = new Map(
  [
    "textPath",
    "linearGradient",
    "radialGradient",
    "clipPath",
    "feGaussianBlur",
    "feOffset",
    "feBlend",
    "feColorMatrix",
    "feComposite",
    "feFlood",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feDropShadow",
    "feComponentTransfer",
    "feFuncR",
    "feFuncG",
    "feFuncB",
    "feFuncA",
  ].map((name) => [name.toLowerCase(), name]),
);
const canonical = (lower: string) => CANONICAL.get(lower) ?? lower;
