// FILE: themeCss.ts
// Purpose: The rules theme CSS must pass, the selectors it may rely on, and the guide an agent
//          reads before it restyles Moss.
// Layer: Shared runtime utility
// Origin: Ported from packages/shared/src/themeCss.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8 (PR #35247, #36656, #36696).
//   Moss changes: the selector list and guide describe Moss's own DOM and theme model, and
//   text-producing properties are refused too (`themeCssDeclarationBlocked`), so theme CSS
//   cannot write words into the app. See THIRD_PARTY_NOTICES.md.

import { THEME_CSS_MAX_LENGTH } from "@moss/contracts";

/**
 * Pictures a theme uses are files in Moss's own store, named by the SHA-256 of their bytes and
 * their real type. Theme CSS names one as `url(moss-theme-image:<id>)`; only the client turns
 * that into an address, always Moss's own theme image route on the server it is connected to.
 */
export const THEME_IMAGE_SCHEME = "moss-theme-image:";
export const THEME_IMAGE_ROUTE_PREFIX = "/api/theme-images/";
/** POST raw bytes here to store a picture; the answer holds its id and reference. */
export const THEME_IMAGE_UPLOAD_ROUTE_PATH = "/api/theme-image-upload";
/**
 * POST `{ "ids": [...] }` here: the pictures this window's saved themes use. Each report keeps
 * those files from cleanup; loads alone cannot, because browsers serve them from cache.
 */
export const THEME_IMAGE_KEEP_ROUTE_PATH = "/api/theme-image-keep";
export const THEME_IMAGE_KEEP_MAX_IDS = 64;
export const THEME_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const THEME_IMAGE_EXTENSIONS = ["png", "jpg", "webp", "gif", "avif"] as const;
export type ThemeImageExtension = (typeof THEME_IMAGE_EXTENSIONS)[number];
export const THEME_IMAGE_CONTENT_TYPES: Readonly<Record<ThemeImageExtension, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};
const THEME_IMAGE_ID = /^[0-9a-f]{64}\.(?:png|jpg|webp|gif|avif)$/;
// Case-sensitive on purpose: the id is lower-case hex, so a reference has exactly one spelling.
// Only CSS whitespace may pad it, as in URL_NOT_LOCAL below.
const THEME_IMAGE_URL =
  /url\([ \t\n\f\r]*(["']?)moss-theme-image:([0-9a-f]{64}\.(?:png|jpg|webp|gif|avif))\1[ \t\n\f\r]*\)/g;

export function isThemeImageId(id: string): boolean {
  return THEME_IMAGE_ID.test(id);
}

export function themeImageReference(id: string): string {
  return `${THEME_IMAGE_SCHEME}${id}`;
}

/** Ids of the pictures `css` refers to, each once, in order of first use. */
export function themeCssImageIds(css: string): string[] {
  return [...new Set([...css.matchAll(THEME_IMAGE_URL)].map((match) => match[2]!))];
}

/**
 * Replace each picture reference in a checked declaration value with the address `resolve`
 * gives for its id. Only the client calls this, after the guard has accepted the value.
 */
export function resolveThemeCssImages(value: string, resolve: (id: string) => string): string {
  return value.replace(THEME_IMAGE_URL, (_match, _quote, id: string) => {
    // The resolver builds the address from the checked id; a quote or line break could still
    // end the string, so they are percent-encoded.
    const address = resolve(id).replace(/["'\\\n\r\f]/g, encodeURIComponent);
    return `url("${address}")`;
  });
}

// Functions that load what they are given, a string included: image-set() (and -webkit-),
// src(), image(), cross-fade() and element().
const FETCHES_BY_STRING = /image-set\(|\bsrc\(|\bimage\(|cross-fade\(|\belement\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
// Read tokens left to right, as CSS does: a url( inside a string loads nothing, and a quote in an
// unquoted url( is not a string. A quoted url() that is not data: or #id keeps `url(` for the check.
const URL_OR_STRING =
  /url\((?![ \t\n\f\r]*["'])[^)]*|url\([ \t\n\f\r]*("[^"\n\r\f]*"|'[^'\n\r\f]*')|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi;

function fetchesByText(code: string): boolean {
  // A picture reference loads only Moss's own theme image route, so it is not a remote file.
  const outsideStrings = code
    .replace(THEME_IMAGE_URL, "")
    .replace(URL_OR_STRING, (token, urlString: string | undefined) => {
      if (urlString !== undefined) return /^["'](?:data:|#)/i.test(urlString) ? "" : "url(";
      return token.startsWith('"') || token.startsWith("'") ? "" : token;
    });
  return FETCHES_BY_STRING.test(outsideStrings) || URL_NOT_LOCAL.test(outsideStrings);
}

/**
 * Whether one declaration value can load a remote file. Clients drop those declarations.
 * A value with var() stays unparsed until use, and an escape can spell `var` or `url` in it,
 * so every value that still has a backslash is refused.
 */
export function themeCssValueFetches(value: string): boolean {
  return value.includes("\\") || fetchesByText(value);
}

// Properties whose value can put words on screen. Theme CSS may decorate (`content: ""`), but it
// must not write text: no product name of its own, no fake prompt.
const TEXT_PROPERTIES: ReadonlySet<string> = new Set([
  "content",
  "quotes",
  "list-style",
  "list-style-type",
  "text-overflow",
  // A string here is drawn: the hyphen mark, or the emphasis mark over each letter.
  "hyphenate-character",
  "text-emphasis",
  "text-emphasis-style",
]);
const NON_EMPTY_STRING = /"[^"]+"|'[^']+'/;
// var() and env() are resolved later, attr() copies page text, and an image can hold words.
const LATE_OR_EXTERNAL_TEXT =
  /\b(?:var|env|attr|url|image|image-set|element|cross-fade)\(|gradient\(/i;

/**
 * Whether a client drops one declaration of theme CSS. `property` is the name the browser
 * reports after parsing (a longhand, or a `--custom` property).
 */
export function themeCssDeclarationBlocked(property: string, value: string): boolean {
  if (themeCssValueFetches(value)) return true;
  if (!TEXT_PROPERTIES.has(property.trim().toLowerCase())) return false;
  return NON_EMPTY_STRING.test(value) || LATE_OR_EXTERNAL_TEXT.test(value);
}

/** A text check for early feedback. CSS escapes can dodge it; the client check is the guard. */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return /@import/i.test(code) || fetchesByText(code);
}

export { THEME_CSS_MAX_LENGTH };

/**
 * Selectors that theme CSS may rely on. Other class names are Tailwind utilities and change
 * between releases. apps/web/src/theme/themeCssHooks.test.ts fails when one leaves the source.
 */
export const THEME_CSS_HOOKS = [
  { selector: '[data-slot="sidebar"]', styles: "app sidebar" },
  { selector: '[data-slot="sidebar-inner"]', styles: "sidebar surface" },
  { selector: "[data-thread-item]", styles: "sidebar chat row" },
  { selector: '[data-sidebar-layout="rail"]', styles: "app window in the rail layout" },
  { selector: "[data-chat-header]", styles: "chat header" },
  {
    selector: '[data-workspace-area="conversation"]',
    styles: "chat background: the whole chat column, composer included, on a new chat too",
  },
  {
    selector: "[data-messages-timeline-root]",
    styles:
      "message list area, behind the messages; in a chat with no messages yet, the empty message area",
  },
  { selector: "[data-chat-scroll-container]", styles: "chat scroller" },
  { selector: "[data-timeline-row-kind]", styles: 'chat row, such as ="message" or ="work"' },
  { selector: '[data-message-role="user"]', styles: "user message row" },
  { selector: "[data-user-message-bubble]", styles: "user message bubble" },
  { selector: '[data-message-role="assistant"]', styles: "assistant message row" },
  { selector: ".chat-markdown", styles: "message text" },
  { selector: ".chat-markdown-codeblock", styles: "code block" },
  { selector: "[data-chat-composer-form]", styles: "composer" },
  { selector: "[data-chat-composer-surface]", styles: "composer card" },
  { selector: "[data-composer-editor]", styles: "composer text" },
  { selector: "[data-right-dock-content]", styles: "right dock panel" },
  { selector: "[data-settings-dialog]", styles: "settings window" },
  { selector: '[data-slot="button"]', styles: "button" },
  {
    selector: '[data-slot="central-icon"]',
    styles: "icon: a mask filled with background-color (the text colour by default)",
  },
  { selector: '[data-slot="input"]', styles: "text input" },
  { selector: '[data-slot="textarea"]', styles: "multi-line text input" },
  { selector: '[data-slot="switch"]', styles: "switch" },
  { selector: '[data-slot="select-trigger"]', styles: "select" },
  { selector: '[data-slot="badge"]', styles: "badge" },
  { selector: '[data-slot="kbd"]', styles: "keyboard key" },
  { selector: '[data-slot="dialog-popup"]', styles: "dialog" },
  { selector: '[data-slot="popover-popup"]', styles: "popover" },
  { selector: '[data-slot="menu-popup"]', styles: "menu" },
  { selector: '[data-slot="tooltip-popup"]', styles: "tooltip" },
  { selector: '[data-slot="scroll-area-scrollbar"]', styles: "overlay scrollbar" },
  { selector: '[data-slot="scroll-area-thumb"]', styles: "overlay scrollbar thumb" },
] as const;

// What the stable selectors are built from, so a selector outside them can be named to the agent.
const HOOK_ATTRIBUTES: ReadonlySet<string> = new Set(
  THEME_CSS_HOOKS.flatMap((hook) => [...hook.selector.matchAll(/\[([a-z-]+)/g)].map((m) => m[1]!)),
);
const HOOK_SLOTS: ReadonlySet<string> = new Set(
  THEME_CSS_HOOKS.flatMap((hook) => {
    const slot = /^\[data-slot="([a-z-]+)"\]$/.exec(hook.selector)?.[1];
    return slot ? [slot] : [];
  }),
);
// `.dark` marks the dark appearance; the others are hook classes.
const HOOK_CLASSES: ReadonlySet<string> = new Set([
  "dark",
  ...THEME_CSS_HOOKS.flatMap((hook) =>
    [...hook.selector.matchAll(/\.([a-z-]+)/gi)].map((m) => m[1]!),
  ),
]);

/** Whether one selector is built only from stable hooks, `.dark`, element names and pseudos. */
function selectorIsStable(selector: string): boolean {
  // Pseudo-class arguments such as :not(...) and :has(...) hold selectors of their own.
  const code = selector.replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted.replace(/[.#[\]]/g, "_"));
  if (/#[a-z_-]/i.test(code)) return false;
  for (const match of selector.matchAll(
    /\[\s*([a-z0-9_-]+)\s*(?:[~|^$*]?=\s*["']?([^"'\]]*)["']?)?\s*\]/gi,
  )) {
    const attribute = match[1]!.toLowerCase();
    if (attribute === "data-slot") {
      if (match[2] === undefined || !HOOK_SLOTS.has(match[2])) return false;
    } else if (!HOOK_ATTRIBUTES.has(attribute)) {
      return false;
    }
  }
  for (const match of code.matchAll(/(?<![\w-])\.(-?[a-z_][\w-]*)/gi)) {
    if (!HOOK_CLASSES.has(match[1]!)) return false;
  }
  return true;
}

/**
 * Selectors in `css` that use a class, id or attribute outside the stable hooks. They may match
 * nothing now or stop matching after an update, so the theme tool names them to the agent.
 * A text scan for feedback, not a guard: it reads selector lists before each `{`.
 */
export function themeCssUnstableSelectors(css: string): string[] {
  const code = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Declaration values can hold braces in strings; a selector cannot follow them anyway.
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (quoted) => quoted.replace(/[{};]/g, " "));
  const found = new Set<string>();
  let prelude = "";
  for (const char of code) {
    if (char === "{") {
      const text = prelude.trim();
      prelude = "";
      // At-rule preludes (@media, @keyframes), keyframe selectors and nested declarations.
      if (
        text.length === 0 ||
        text.startsWith("@") ||
        /^(?:from|to|[\d.]+%)(?:\s*,|$)/i.test(text)
      ) {
        continue;
      }
      for (const selector of splitSelectorList(text)) {
        if (!selectorIsStable(selector)) found.add(selector);
      }
    } else if (char === "}" || char === ";") {
      prelude = "";
    } else {
      prelude += char;
    }
  }
  return [...found];
}

/** Split a selector list on top-level commas (not those inside :is(...) or [...]). */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * Presets a theme pack can start from, by id, with the appearances each one has. The web theme
 * catalog (`CODE_THEME_OPTIONS` in apps/web/src/theme/theme.logic.ts) must list the same ids;
 * theme.logic.test.ts checks that.
 */
export const MOSS_THEME_PRESETS: ReadonlyArray<{
  readonly id: string;
  readonly variants: ReadonlyArray<"light" | "dark">;
}> = [
  { id: "absolutely", variants: ["light", "dark"] },
  { id: "ayu", variants: ["dark"] },
  { id: "catppuccin", variants: ["light", "dark"] },
  { id: "codex", variants: ["light", "dark"] },
  { id: "moss", variants: ["light", "dark"] },
  { id: "dracula", variants: ["dark"] },
  { id: "everforest", variants: ["light", "dark"] },
  { id: "github", variants: ["light", "dark"] },
  { id: "gruvbox", variants: ["light", "dark"] },
  { id: "linear", variants: ["light", "dark"] },
  { id: "lobster", variants: ["dark"] },
  { id: "material", variants: ["dark"] },
  { id: "matrix", variants: ["dark"] },
  { id: "monokai", variants: ["dark"] },
  { id: "night-owl", variants: ["dark"] },
  { id: "nord", variants: ["dark"] },
  { id: "notion", variants: ["light", "dark"] },
  { id: "one", variants: ["light", "dark"] },
  { id: "oscurange", variants: ["dark"] },
  { id: "proof", variants: ["light"] },
  { id: "raycast", variants: ["light", "dark"] },
  { id: "rose-pine", variants: ["light", "dark"] },
  { id: "sentry", variants: ["dark"] },
  { id: "soft", variants: ["light", "dark"] },
  { id: "solarized", variants: ["light", "dark"] },
  { id: "temple", variants: ["dark"] },
  { id: "tokyo-night", variants: ["dark"] },
  { id: "vercel", variants: ["light", "dark"] },
  { id: "vscode-plus", variants: ["light", "dark"] },
];

export function isMossThemePreset(id: string, variant: "light" | "dark"): boolean {
  return MOSS_THEME_PRESETS.some((preset) => preset.id === id && preset.variants.includes(variant));
}

/**
 * Keys that restore Moss's default look (both packs, custom CSS cleared) when a theme has made
 * the app unusable. The listener sits outside the themed UI (apps/web/src/hooks/useTheme.ts).
 */
export const THEME_RESET_SHORTCUT_LABEL = "Ctrl+Alt+Shift+Backspace";

/** What an agent needs to restyle Moss. `moss_theme_read` returns it. */
export const MOSS_THEME_GUIDE = [
  "Themes restyle Moss on this computer's desktop app and in the web app this server serves.",
  "Moss has a light pack and a dark pack. `appearance` picks light, dark, or system.",
  "",
  "Each pack: `preset` (a preset id to start from), then `accent`, `surface` (background), `ink` (text), `sidebar` (null follows surface), `contrast` (0-100), `opaqueWindows`, `uiFont`, `codeFont`, `diffAdded`, `diffRemoved`, `skill`. Colors are #rrggbb. Moss derives every other color from these, so prefer them over CSS.",
  "Fields you leave out keep the person's current value, unless `reset` is true: then the theme starts from Moss's default look.",
  "",
  "CSS: `css` applies after Moss's styles while that pack is active. Top-level `css` goes to both packs.",
  "It cannot load files from anywhere else: no @import, no image-set(), and url() only with data:, #id or a stored picture (moss-theme-image:). A value with a backslash is dropped.",
  "It cannot write text: content, quotes and list-style only take empty strings, without var(), attr() or images.",
  `Pictures: pass each file in \`images\` by a name you choose, as an absolute path ({"hero": "C:\\\\Users\\\\me\\\\picture.png"}), and write url(moss-theme-image:hero) in css. Moss stores the file at full quality (PNG, JPEG, WebP, GIF or AVIF by content, up to ${THEME_IMAGE_MAX_BYTES / 1024 / 1024} MB; SVG is refused) and the result gives its stored reference (moss-theme-image:<64 hex>.<type>) with its width and height. Keep that reference as it is when you change the theme later. Use this for any picture larger than an icon; do not shrink a picture to fit.`,
  `A data: address is for small icons only: \`css\` holds ${THEME_CSS_MAX_LENGTH.toLocaleString("en-US")} characters.`,
  'A picture or color behind the chat goes on [data-workspace-area="conversation"]: it covers the whole chat column, composer included, and shows on a new chat too. Messages, the composer and the header stay on top of it.',
  "Colors live in variables set on the root element; override one with !important, or better, set the matching field. The selected sidebar row draws --sidebar-selected over its row, and a hovered row --sidebar-accent.",
  "Moss's own rules can be more specific. If a rule has no effect, add !important.",
  "It cannot reach the terminal text (drawn on a canvas), the code inside diffs, or the inside of web pages and documents shown in panels. Use the pack fields for those.",
  "Native scrollbars take ::-webkit-scrollbar and ::-webkit-scrollbar-thumb.",
  'Icons are [data-slot="central-icon"]: a mask filled with background-color, which is the text color unless you set it. Size them with width and height; stroke properties do nothing.',
  "",
  "Stable selectors (other class names change between releases, so do not use them):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "Any element and pseudo-class may be combined with these, and `.dark` or `:root:not(.dark)` limits a rule to one appearance.",
  "",
  "You cannot see the result, and moss_theme_set succeeding only means the theme was saved and sent to Moss windows, not that every rule shows. Its result names selectors outside the stable list. Make small changes, then ask the person what they see.",
  `To undo, call moss_theme_set with reset true and nothing else. The person can also press ${THEME_RESET_SHORTCUT_LABEL} in Moss, or reset the theme in Settings > Appearance.`,
].join("\n");
