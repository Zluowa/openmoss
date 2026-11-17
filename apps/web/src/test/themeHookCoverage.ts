// FILE: themeHookCoverage.ts
// Purpose: Which rendered test proves each theme hook. theme/themeCssHooks.test.ts fails when a
//          hook in THEME_CSS_HOOKS is in none of these lists, so a new hook needs a rendered check.
// Layer: Browser test helper

/** Proven on the mounted chat screen by components/ThemeCssHooks.browser.tsx. */
export const CHAT_HOOKS = [
  '[data-slot="sidebar"]',
  '[data-slot="sidebar-inner"]',
  "[data-thread-item]",
  '[data-sidebar-layout="rail"]',
  "[data-chat-header]",
  '[data-workspace-area="conversation"]',
  "[data-messages-timeline-root]",
  "[data-chat-scroll-container]",
  "[data-timeline-row-kind]",
  '[data-message-role="user"]',
  "[data-user-message-bubble]",
  '[data-message-role="assistant"]',
  ".chat-markdown",
  ".chat-markdown-codeblock",
  "[data-chat-composer-form]",
  "[data-chat-composer-surface]",
  "[data-composer-editor]",
  '[data-slot="button"]',
  '[data-slot="central-icon"]',
] as const;

/** Proven in the open Settings window by components/ThemeCssHooks.browser.tsx. */
export const SETTINGS_HOOKS = [
  "[data-settings-dialog]",
  '[data-slot="switch"]',
  '[data-slot="select-trigger"]',
] as const;

/** Proven on the real primitives and panels by components/ui/ThemeCssHooks.primitives.browser.tsx. */
export const PRIMITIVE_HOOKS = [
  '[data-slot="input"]',
  '[data-slot="textarea"]',
  '[data-slot="badge"]',
  '[data-slot="kbd"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="tooltip-popup"]',
  '[data-slot="scroll-area-scrollbar"]',
  '[data-slot="scroll-area-thumb"]',
  "[data-right-dock-content]",
] as const;

/**
 * Hooks that promise layout rather than a surface: their own background sits under a child that
 * covers it by design (the composer form under its card at narrow widths), so the check paints
 * an outline instead.
 */
export const OUTLINE_PROBED_HOOKS: ReadonlySet<string> = new Set(["[data-chat-composer-form]"]);

/**
 * Hooks on icons: a mask filled with the background colour, so only the glyph paints. Their
 * check compares the probe colour with the same glyphs in a reference colour.
 */
export const MASK_PROBED_HOOKS: ReadonlySet<string> = new Set(['[data-slot="central-icon"]']);
