// FILE: contextMenuIcons.tsx
// Purpose: Icons for imperative context menus, matching the glyphs the same actions use in React UI.
// Layer: web UI utility
// Exports: THREAD_CONTEXT_MENU_ICONS, menuIcon
// Why: Native menus cannot render React components. Every UI glyph is a Central outline icon, so
//      menus receive its basename; anything outside that set falls back to SVG markup.

import { renderToStaticMarkup } from "react-dom/server";

import { THREAD_ARCHIVE_ICON } from "~/components/ThreadArchiveActionButton";
import {
  BELL_ICON_NAME,
  centralIconNameOf,
  ClockIcon,
  COPY_ICON_NAME,
  DeviceLaptopIcon,
  EYE_OPEN_ICON_NAME,
  FolderOpenIcon,
  GitBranchIcon,
  HandoffIcon,
  type LucideIcon,
  PENCIL_ICON_NAME,
  PIN_ICON_NAME,
  TerminalIcon,
  Trash2,
  UsersIcon,
  WorktreeIcon,
} from "./icons";

/** The string an imperative menu item takes for the same glyph a React row renders. */
export function menuIcon(Icon: LucideIcon): string {
  return centralIconNameOf(Icon) ?? renderToStaticMarkup(<Icon />);
}

export const THREAD_CONTEXT_MENU_ICONS = {
  rename: PENCIL_ICON_NAME,
  // Same glyph as the sidebar's guest-message chip and the waiting-messages card.
  shareGuest: menuIcon(UsersIcon),
  pin: PIN_ICON_NAME,
  clearNotification: BELL_ICON_NAME,
  markUnread: EYE_OPEN_ICON_NAME,
  // Same glyph as the chat header's Hand off button.
  handoff: menuIcon(HandoffIcon),
  // Fork shares the branch glyph (see GitForkIcon); its targets match the env-mode glyphs.
  fork: menuIcon(GitBranchIcon),
  forkLocal: menuIcon(DeviceLaptopIcon),
  forkWorktree: menuIcon(WorktreeIcon),
  // Same glyph as the project rows' open folder.
  group: menuIcon(FolderOpenIcon),
  // Same glyph as the composer's snooze notice.
  snooze: menuIcon(ClockIcon),
  copy: COPY_ICON_NAME,
  openInTerminal: menuIcon(TerminalIcon),
  // Same glyph as the thread row's hover archive button.
  archive: menuIcon(THREAD_ARCHIVE_ICON),
  // Same glyph as the delete rows in the sidebar project and space menus.
  delete: menuIcon(Trash2),
} as const;
