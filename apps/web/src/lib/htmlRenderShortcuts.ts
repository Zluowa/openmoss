// FILE: htmlRenderShortcuts.ts
// Purpose: Which app shortcuts an agent HTML render may forward to Moss after the reader
//   clicks into it, and whether a forwarded key press is one of them.
// Layer: Web UI helpers
// Origin: Adapted from HtmlRenderDocument in apps/web/src/components/files/BrowserDocumentFrame.tsx
//   in T3 Code (https://github.com/pingdotgg/t3code, MIT) at
//   08a463e29976617134de01e9341f898bc881d0eb (PR #18898), for Moss's own commands and key
//   matching. See THIRD_PARTY_NOTICES.md.

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type ResolvedKeybindingsConfig,
  SPACE_JUMP_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@synara/contracts";
import type { HtmlRenderKeyDown, HtmlRenderShortcut } from "@synara/shared/htmlRender";

import {
  effectiveKeybindingRules,
  matchesShortcut,
  type ShortcutEventLike,
  shortcutConflictKey,
} from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";

/**
 * The page reports the keys, and a page script can report any key it likes, so only
 * commands that change what the reader sees are here, never one that changes a thread,
 * runs something, or waits for a key release the page would keep.
 */
export const HTML_RENDER_SHORTCUT_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "sidebar.toggle",
  "sidebar.floatToggle",
  "sidebar.search",
  "sidebar.activity",
  "space.previous",
  "space.next",
  ...SPACE_JUMP_KEYBINDING_COMMANDS,
  "terminal.toggle",
  "rightPanel.toggle",
  "preview.toggle",
  "browser.toggle",
  "device.toggle",
  "diff.toggle",
  "composer.focus.toggle",
  "chat.find",
  "search.files",
  "search.content",
  "sidechat.toggle",
  "chat.visible.next",
  "chat.visible.previous",
  "chat.attention.next",
  "threadTab.next",
  "threadTab.previous",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
]);

export interface HtmlRenderShortcutPolicy {
  /** Cmd/Ctrl chords bound to an allowed command, which a page forwards. */
  readonly shortcuts: ReadonlyArray<HtmlRenderShortcut>;
  /** Every chord bound to any other command, which a page never forwards. */
  readonly blocked: ReadonlyArray<HtmlRenderShortcut>;
}

const resolveShortcut = (shortcut: KeybindingShortcut, mac: boolean): HtmlRenderShortcut => ({
  key: shortcut.key,
  metaKey: shortcut.metaKey || (shortcut.modKey && mac),
  ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
  shiftKey: shortcut.shiftKey,
  altKey: shortcut.altKey,
});

/**
 * Only Cmd/Ctrl chords that no other command claims, whatever its `when` clause, are
 * forwarded: a plain key belongs to the page, and resolving `when` against live state
 * could otherwise send a key the page meant for itself to the composer.
 */
export function htmlRenderShortcutPolicy(
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
): HtmlRenderShortcutPolicy {
  const mac = isMacPlatform(platform);
  const rules = effectiveKeybindingRules(keybindings);
  const blocked = rules
    .filter((rule) => !HTML_RENDER_SHORTCUT_COMMANDS.has(rule.command))
    .map((rule) => resolveShortcut(rule.shortcut, mac));
  const shortcuts = new Map<string, HtmlRenderShortcut>();
  for (const { command, shortcut } of rules) {
    if (
      HTML_RENDER_SHORTCUT_COMMANDS.has(command) &&
      (shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
    ) {
      shortcuts.set(shortcutConflictKey(shortcut, platform), resolveShortcut(shortcut, mac));
    }
  }
  return { shortcuts: [...shortcuts.values()], blocked };
}

/**
 * Whether a key press a page forwarded is an allowed shortcut. A page can forge any
 * key/code pair, so a press that also matches a blocked chord is refused, and a named key
 * (Enter, an arrow) must be the shortcut's own key rather than match through its code.
 */
export function isHtmlRenderShortcut(
  key: HtmlRenderKeyDown,
  policy: HtmlRenderShortcutPolicy,
  platform: string,
): boolean {
  const matches = (event: ShortcutEventLike) => (shortcut: HtmlRenderShortcut) =>
    matchesShortcut(event, { ...shortcut, modKey: false }, platform);
  const allowed = policy.shortcuts.filter(matches(key));
  if (allowed.length === 0 || policy.blocked.some(matches(key))) return false;
  // Without its code, a named key matches only as itself.
  const named = key.key.length > 1 && key.key !== "Dead";
  return !named || allowed.some(matches({ ...key, code: "" }));
}
