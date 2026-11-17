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

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
// Read tokens left to right, as CSS does: a url( inside a string loads nothing, and a quote in an
// unquoted url( is not a string. A quoted url() that is not data: or #id keeps `url(` for the check.
const URL_OR_STRING =
  /url\((?![ \t\n\f\r]*["'])[^)]*|url\([ \t\n\f\r]*("[^"\n\r\f]*"|'[^'\n\r\f]*')|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi;

function fetchesByText(code: string): boolean {
  const outsideStrings = code.replace(URL_OR_STRING, (token, urlString: string | undefined) => {
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
  { selector: "[data-messages-timeline-root]", styles: "chat area, behind the messages" },
  { selector: "[data-chat-scroll-container]", styles: "chat scroller" },
  { selector: "[data-timeline-row-kind]", styles: 'chat row, such as ="message" or ="work"' },
  { selector: '[data-message-role="user"]', styles: "user message row" },
  { selector: "[data-user-message-bubble]", styles: "user message bubble" },
  { selector: '[data-message-role="assistant"]', styles: "assistant message row" },
  { selector: ".chat-markdown", styles: "message text" },
  { selector: ".chat-markdown-codeblock", styles: "code block" },
  { selector: "[data-chat-composer-form]", styles: "composer" },
  { selector: "[data-chat-composer-surface]", styles: "composer card" },
  { selector: "[data-right-dock-content]", styles: "right dock panel" },
  { selector: "[data-settings-dialog]", styles: "settings window" },
  { selector: '[data-slot="button"]', styles: "button" },
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
  "It cannot load files: no @import, no image-set(), and url() only with data: or #id. A value with a backslash is dropped.",
  "It cannot write text: content, quotes and list-style only take empty strings, without var(), attr() or images.",
  `A background image must be embedded as a data: address. \`css\` holds ${THEME_CSS_MAX_LENGTH.toLocaleString("en-US")} characters, so keep the image near 30 KB.`,
  "Colors live in variables set on the root element; override one with !important, or better, set the matching field.",
  "Moss's own rules can be more specific. If a rule has no effect, add !important.",
  "",
  "Stable selectors (other class names change between releases, so do not use them):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "",
  "You cannot see the result. Make small changes, then ask the person how it looks.",
  `To undo, call moss_theme_set with reset true and nothing else. The person can also press ${THEME_RESET_SHORTCUT_LABEL} in Moss, or reset the theme in Settings > Appearance.`,
].join("\n");
