// FILE: settingsSidebarNavStyles.ts
// Purpose: Settings sidebar navigation layout tokens (section labels, groups).
// Layer: UI styling helper
// Exports: settings-specific section tokens; row tokens re-exported from sidebarRowStyles

import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "./sidebarRowStyles";

/** Codex settings nav: a 16px gap separates each expanded group. */
export const SETTINGS_SIDEBAR_SECTION_CLASS_NAME = "flex flex-col gap-1";

/** Section labels use an 8px start inset and no vertical padding. */
export const SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME =
  "flex items-center justify-between gap-2 pe-0.5 ps-2 text-ui-lg font-medium leading-[18px] text-muted-foreground opacity-75";

/** Nav row — same chrome as project/chat sidebar header rows. */
export const SETTINGS_SIDEBAR_ITEM_CLASS_NAME =
  "flex h-[31px] items-center gap-2 rounded-full px-2 py-[5px] text-ui-lg leading-[21px]";

export const SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME =
  "min-w-0 flex-1 truncate text-ui-lg leading-[21px]";

/** Inner glyph size; tone is set at each call site to `text-inherit` so the glyph tracks the row text. */
export const SETTINGS_SIDEBAR_ICON_CLASS_NAME = "size-[18px] shrink-0";

/**
 * Idle nav rows rest at the same foreground as primary sidebar item rows (thread/project
 * names) so settings navigation reads as part of the sidebar instead of a muted secondary
 * list. The leading icon inherits this via `tone="text-inherit"` at the call site, so label
 * and glyph track together through hover and the active fill.
 */
export const SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME = [
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
].join(" ");

export const SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME = SIDEBAR_ROW_ACTIVE_CLASS_NAME;

export const SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME = "gap-px";
