// FILE: threadContextMenu.ts
// Purpose: Lets a surface outside the sidebar (the open-thread tabs) open the sidebar's own
//          thread context menu, optionally with rows of its own.
// Layer: web UI utility
// Exports: registerThreadContextMenu, showThreadContextMenu, ThreadContextMenuOptions
// Why: A thread has one menu wherever it is right-clicked. Its actions (rename, pin, handoff,
//      fork, archive, delete) live in the sidebar, which is mounted next to every chat, so
//      other surfaces call into it instead of rebuilding the menu.

import type {
  ContextMenuIconKey,
  ContextMenuItem,
  ContextMenuNode,
  ContextMenuShortcutKey,
  ThreadId,
} from "@synara/contracts";

export interface ThreadContextMenuOptions {
  /** Rows the calling surface adds to the thread's menu, such as a tab's close actions. */
  extraItems?: readonly ContextMenuItem[] | undefined;
  /** Runs when one of {@link extraItems} (or one of their submenu rows) is chosen. */
  onExtraAction?: ((itemId: string) => Promise<void> | void) | undefined;
}

type ThreadContextMenuHandler = (
  threadId: ThreadId,
  position: { x: number; y: number },
  options?: ThreadContextMenuOptions,
) => Promise<void>;

let activeThreadContextMenuHandler: ThreadContextMenuHandler | null = null;

export function registerThreadContextMenu(handler: ThreadContextMenuHandler): () => void {
  activeThreadContextMenuHandler = handler;
  return () => {
    if (activeThreadContextMenuHandler === handler) {
      activeThreadContextMenuHandler = null;
    }
  };
}

/**
 * Opens the thread's menu at `position`. Returns false when no sidebar is mounted to show
 * it (a phone with the sidebar sheet closed), so the caller can fall back to its own rows.
 */
export function showThreadContextMenu(
  threadId: ThreadId,
  position: { x: number; y: number },
  options?: ThreadContextMenuOptions,
): boolean {
  if (!activeThreadContextMenuHandler) {
    return false;
  }
  void activeThreadContextMenuHandler(threadId, position, options);
  return true;
}

/** Localized visible strings supplied by Moss's localization source. */
export interface ThreadContextMenuCopy {
  readonly pin: string;
  readonly unpin: string;
  readonly rename: string;
  readonly markUnread: string;
  readonly clearNotification: string;
  readonly archive: string;
  readonly section?: {
    readonly title: string;
    readonly newSection: string;
    readonly removeFromSection: string;
    readonly defaultSection: string;
  };
  readonly handoff: string;
  readonly handoffTo: (targetLabel: string) => string;
  readonly copy: string;
  readonly copyPath: string;
  readonly copyThreadId: string;
  readonly openWith: string;
  readonly openPathInTerminal: string;
  readonly delete: string;
}

export interface ThreadContextMenuHandoffTarget {
  readonly instanceId: string;
  readonly label: string;
}

export interface ThreadContextMenuSection {
  readonly id: string;
  readonly label: string;
}

export interface BuildThreadContextMenuInput {
  readonly copy: ThreadContextMenuCopy;
  readonly isPinned: boolean;
  readonly hasDismissibleNotification: boolean;
  readonly canArchive: boolean;
  readonly sections?: readonly ThreadContextMenuSection[];
  readonly currentSectionId?: string | null;
  readonly handoffTargets?: readonly ThreadContextMenuHandoffTarget[];
  readonly hasWorkspacePath: boolean;
  readonly extraItems?: readonly ContextMenuItem<"return-to-single-chat">[];
}

function leaf(
  id: string,
  label: string,
  iconKey?: ContextMenuIconKey,
  options: { readonly shortcutKey?: ContextMenuShortcutKey } = {},
): ContextMenuItem<string> {
  return {
    id,
    label,
    ...(iconKey ? { iconKey } : {}),
    ...(options.shortcutKey ? { shortcutKey: options.shortcutKey } : {}),
  };
}

/**
 * Builds the supported thread context-menu tree without consulting UI state or
 * performing side effects. Sidebar supplies already-localized Moss copy and
 * keeps all action handling outside this presentation-only module.
 */
export function buildThreadContextMenuItems(
  input: BuildThreadContextMenuInput,
): readonly ContextMenuNode<string>[] {
  const { copy } = input;
  const items: ContextMenuNode<string>[] = [
    leaf("toggle-pin", input.isPinned ? copy.unpin : copy.pin, "pin", {
      shortcutKey: "pin",
    }),
    leaf("rename", copy.rename, "rename", { shortcutKey: "rename" }),
    leaf("mark-unread", copy.markUnread, "mark-unread", { shortcutKey: "mark-unread" }),
  ];

  if (input.hasDismissibleNotification) {
    items.push(leaf("clear-notification", copy.clearNotification, "clear-notification"));
  }
  if (input.canArchive) {
    items.push(leaf("archive", copy.archive, "archive", { shortcutKey: "archive" }));
  }

  if (copy.section && input.sections) {
    const currentSectionId = input.currentSectionId ?? null;
    items.push({
      label: copy.section.title,
      separatorBefore: true,
      children: [
        ...input.sections.map((section) => leaf("section:" + section.id, section.label)),
        leaf(
          "section:default",
          currentSectionId === null ? copy.section.defaultSection : copy.section.removeFromSection,
        ),
        leaf("section:new", copy.section.newSection),
      ],
    });
  }

  const handoffTargets = input.handoffTargets ?? [];
  if (handoffTargets.length > 0) {
    items.push({
      label: copy.handoff,
      iconKey: "handoff",
      separatorBefore: true,
      children: handoffTargets.map((target) =>
        leaf(`handoff:${target.instanceId}`, copy.handoffTo(target.label), "handoff"),
      ),
    });
  }

  items.push({
    label: copy.copy,
    iconKey: "copy",
    separatorBefore: true,
    children: [
      leaf("copy-path", copy.copyPath, "copy-path"),
      leaf("copy-thread-id", copy.copyThreadId, "copy-thread-id"),
    ],
  });

  if (input.hasWorkspacePath) {
    items.push({
      label: copy.openWith,
      iconKey: "open-with",
      separatorBefore: true,
      children: [leaf("open-path-in-terminal", copy.openPathInTerminal, "open-path-in-terminal")],
    });
  }

  if (input.extraItems && input.extraItems.length > 0) {
    items.push(
      ...input.extraItems.map((item) => ({
        ...item,
        iconKey: "return-to-single-chat" as const,
      })),
    );
  }

  items.push({
    id: "delete",
    label: copy.delete,
    iconKey: "delete",
    destructive: true,
    separatorBefore: true,
  });
  return items;
}
