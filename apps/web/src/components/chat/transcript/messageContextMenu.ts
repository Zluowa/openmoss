// FILE: messageContextMenu.ts
// Purpose: The desktop chat's right-click menu on a transcript message: what is under
//          the pointer first (selected text, a code block, a link), then the message
//          itself (plain or as Markdown), then the message actions (fork, pin).
// Layer: Chat transcript behavior
// Exports: MessageContextMenuId, MessageContextTarget, buildMessageContextMenuItems,
//          readMessageContextTarget, showMessageContextMenu

import type { ContextMenuItem } from "@moss/contracts";

import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { contextMenuGroup } from "~/lib/contextMenuGroup";
import { formatMossTranslation, type TranslationKey } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";
import { readNativeApi } from "~/nativeApi";

export type MessageContextMenuId =
  | "copy"
  | "copy-selection"
  | "copy-code"
  | "copy-link"
  | "copy-message"
  | "copy-markdown"
  | "fork"
  | "pin";

/** What the pointer was on when the menu opened. */
export interface MessageContextTarget {
  selectionText: string | null;
  code: { text: string; block: boolean } | null;
  linkHref: string | null;
}

export function buildMessageContextMenuItems(input: {
  target: MessageContextTarget;
  canCopyMessage: boolean;
  canFork: boolean;
  pinned: boolean | null;
  t: (key: TranslationKey) => string;
}): ContextMenuItem<MessageContextMenuId>[] {
  const { target, t } = input;
  const items: ContextMenuItem<MessageContextMenuId>[] = [];
  if (target.selectionText) items.push({ id: "copy-selection", label: t("transcript.menu.copy") });
  if (target.code) {
    items.push({
      id: "copy-code",
      label: target.code.block ? t("transcript.menu.copyCodeBlock") : t("transcript.menu.copyCode"),
    });
  }
  if (target.linkHref) items.push({ id: "copy-link", label: t("transcript.menu.copyLink") });
  if (input.canCopyMessage) {
    items.push(
      {
        id: "copy-message",
        label: t("transcript.menu.copyMessage"),
        separatorBefore: items.length > 0,
      },
      { id: "copy-markdown", label: t("transcript.menu.copyMarkdown") },
    );
  }
  const actions: ContextMenuItem<MessageContextMenuId>[] = [];
  if (input.canFork) actions.push({ id: "fork", label: t("transcript.menu.fork") });
  if (input.pinned !== null) {
    actions.push({
      id: "pin",
      label: input.pinned ? t("transcript.chapter.unpin") : t("transcript.chapter.pin"),
    });
  }
  if (actions.length > 0 && items.length > 0)
    actions[0] = { ...actions[0]!, separatorBefore: true };
  return [...contextMenuGroup({ id: "copy", label: t("transcript.menu.copy") }, items), ...actions];
}

/** Reads the selection, code and link under a right-click inside `root`. */
export function readMessageContextTarget(
  event: { target: EventTarget | null },
  root: HTMLElement,
): MessageContextTarget {
  const element = event.target instanceof Element ? event.target : null;
  const selection = root.ownerDocument.getSelection();
  const selected = selection && !selection.isCollapsed ? selection.toString().trim() : "";
  const selectionInside =
    selection !== null &&
    selection.rangeCount > 0 &&
    root.contains(selection.getRangeAt(0).commonAncestorContainer);
  const pre = element?.closest("pre");
  const code = element?.closest("code");
  const link = element?.closest("a[href]");
  return {
    selectionText: selectionInside && selected.length >= 2 ? selected : null,
    code: pre
      ? { text: pre.textContent ?? "", block: true }
      : code
        ? { text: code.textContent ?? "", block: false }
        : null,
    linkHref: link?.getAttribute("href") ?? null,
  };
}

export async function showMessageContextMenu(input: {
  position: { x: number; y: number };
  target: MessageContextTarget;
  locale: MossLocaleCode;
  plainText: (() => string) | null;
  markdown: (() => string) | null;
  onFork: (() => void) | null;
  pinned: boolean | null;
  onTogglePin: (() => void) | null;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const t = (key: TranslationKey) => formatMossTranslation(input.locale, key, {});
  const items = buildMessageContextMenuItems({
    target: input.target,
    canCopyMessage: input.plainText !== null && input.markdown !== null,
    canFork: input.onFork !== null,
    pinned: input.onTogglePin ? input.pinned : null,
    t,
  });
  if (items.length === 0) return;
  const clicked = await api.contextMenu.show(items, input.position);
  switch (clicked) {
    case "copy-selection":
      if (input.target.selectionText) await copyTextToClipboard(input.target.selectionText);
      return;
    case "copy-code":
      if (input.target.code) await copyTextToClipboard(input.target.code.text);
      return;
    case "copy-link":
      if (input.target.linkHref) await copyTextToClipboard(input.target.linkHref);
      return;
    case "copy-message":
      if (input.plainText) await copyTextToClipboard(input.plainText());
      return;
    case "copy-markdown":
      if (input.markdown) await copyTextToClipboard(input.markdown());
      return;
    case "fork":
      input.onFork?.();
      return;
    case "pin":
      input.onTogglePin?.();
      return;
    default:
      return;
  }
}
