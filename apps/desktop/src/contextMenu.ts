// FILE: contextMenu.ts
// Purpose: Validate recursive renderer context-menu data and build safe native templates.
// Layer: Desktop main-process helper (pure)
// Exports: context-menu limits, recursive normalization, and native template construction.

import type { MenuItemConstructorOptions } from "electron";
import type {
  ContextMenuIconKey,
  ContextMenuNode,
  ContextMenuShortcutKey,
  ContextMenuSubmenu,
} from "@synara/contracts";

/** Maximum submenu depth, counting the root menu as depth zero. */
export const CONTEXT_MENU_MAX_DEPTH = 4;
/** Maximum number of candidate nodes visited for one context-menu request. */
export const CONTEXT_MENU_MAX_NODE_COUNT = 128;
/** Maximum number of child candidates considered at any menu level. */
export const CONTEXT_MENU_MAX_CHILDREN_PER_MENU = 32;
/** Maximum UTF-16 code units in an action id. */
export const CONTEXT_MENU_MAX_ID_LENGTH = 128;
/** Maximum UTF-16 code units in a visible menu label. */
export const CONTEXT_MENU_MAX_LABEL_LENGTH = 256;

export interface NormalizedContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly separatorBefore?: boolean;
  readonly destructive?: boolean;
  readonly iconKey?: ContextMenuIconKey;
  readonly shortcutKey?: ContextMenuShortcutKey;
}

export interface NormalizedContextMenuSubmenu {
  readonly label: string;
  readonly children: readonly NormalizedContextMenuNode[];
  readonly separatorBefore?: boolean;
  readonly destructive?: boolean;
  readonly iconKey?: ContextMenuIconKey;
}

export type NormalizedContextMenuNode = NormalizedContextMenuItem | NormalizedContextMenuSubmenu;

export interface NativeContextMenuTemplateOptions {
  readonly translateLabel: (label: string) => string;
  readonly onLeafSelected: (id: string) => void;
  readonly destructiveIcon?: MenuItemConstructorOptions["icon"] | undefined;
  /** Resolves only the closed, trusted artwork vocabulary in the main process. */
  readonly resolveIcon?: (
    iconKey: ContextMenuIconKey,
  ) => MenuItemConstructorOptions["icon"] | undefined;
  /** Resolves only the closed, trusted shortcut vocabulary in the main process. */
  readonly resolveShortcut?: (
    shortcutKey: ContextMenuShortcutKey,
  ) => MenuItemConstructorOptions["accelerator"] | undefined;
}

/**
 * Creates the one-shot settlement used by the native context-menu IPC path.
 * Electron can report both a leaf click and popup dismissal for one menu, so
 * the first result wins and every later callback is intentionally ignored.
 */
export function createContextMenuOneShotResolver<T>(
  resolve: (value: T) => void,
): (value: T) => void {
  let settled = false;
  return (value: T) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
}

type ContextMenuRecord = Record<string, unknown>;

interface NormalizationState {
  visitedNodeCount: number;
  readonly seenObjects: WeakSet<object>;
}

function isRecord(value: unknown): value is ContextMenuRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: ContextMenuRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length > maxLength || value.trim().length === 0) {
    return null;
  }
  return value;
}

function readBoolean(
  record: ContextMenuRecord,
  key: "separatorBefore" | "destructive",
): true | undefined {
  return record[key] === true ? true : undefined;
}

function readContextMenuIconKey(value: unknown): ContextMenuIconKey | undefined {
  switch (value) {
    case "pin":
    case "rename":
    case "mark-unread":
    case "clear-notification":
    case "archive":
    case "handoff":
    case "copy":
    case "copy-path":
    case "copy-thread-id":
    case "open-with":
    case "open-path-in-terminal":
    case "return-to-single-chat":
    case "delete":
      return value;
    default:
      return undefined;
  }
}

function readContextMenuShortcutKey(value: unknown): ContextMenuShortcutKey | undefined {
  switch (value) {
    case "pin":
    case "rename":
    case "mark-unread":
    case "archive":
      return value;
    default:
      return undefined;
  }
}

function readOptionalMetadata<T>(reader: () => T): T | undefined {
  try {
    return reader();
  } catch {
    // A hostile optional field must not invalidate an otherwise usable node.
    return undefined;
  }
}

function readChildren(record: ContextMenuRecord): readonly unknown[] | null | undefined {
  const childKeys = ["children", "items", "submenu"] as const;
  const presentKeys = childKeys.filter((key) => hasOwn(record, key));
  if (presentKeys.length === 0) return undefined;
  if (presentKeys.length !== 1) return null;

  const children = record[presentKeys[0]!];
  return Array.isArray(children) ? children : null;
}

function normalizeChildren(
  input: readonly unknown[],
  depth: number,
  state: NormalizationState,
): NormalizedContextMenuNode[] {
  if (depth > CONTEXT_MENU_MAX_DEPTH) return [];

  const normalized: NormalizedContextMenuNode[] = [];
  const candidateCount = Math.min(input.length, CONTEXT_MENU_MAX_CHILDREN_PER_MENU);
  for (let index = 0; index < candidateCount; index += 1) {
    const node = normalizeNode(input[index], depth, state);
    if (node) normalized.push(node);
  }
  return normalized;
}

function normalizeNode(
  value: unknown,
  depth: number,
  state: NormalizationState,
): NormalizedContextMenuNode | null {
  if (state.visitedNodeCount >= CONTEXT_MENU_MAX_NODE_COUNT || !isRecord(value)) {
    return null;
  }
  state.visitedNodeCount += 1;
  if (state.seenObjects.has(value)) return null;
  state.seenObjects.add(value);

  try {
    const label = readBoundedString(value.label, CONTEXT_MENU_MAX_LABEL_LENGTH);
    if (!label) return null;

    const children = readChildren(value);
    if (children !== undefined) {
      if (children === null || depth >= CONTEXT_MENU_MAX_DEPTH) return null;
      const normalizedChildren = normalizeChildren(children, depth + 1, state);
      if (normalizedChildren.length === 0) return null;

      return {
        label,
        children: normalizedChildren,
        ...(() => {
          const separatorBefore = readOptionalMetadata(() => readBoolean(value, "separatorBefore"));
          const destructive = readOptionalMetadata(() => readBoolean(value, "destructive"));
          const iconKey = readOptionalMetadata(() => readContextMenuIconKey(value.iconKey));
          return {
            ...(separatorBefore ? { separatorBefore } : {}),
            ...(destructive ? { destructive } : {}),
            ...(iconKey ? { iconKey } : {}),
          };
        })(),
      };
    }

    const id = readBoundedString(value.id, CONTEXT_MENU_MAX_ID_LENGTH);
    if (!id) return null;
    const separatorBefore = readOptionalMetadata(() => readBoolean(value, "separatorBefore"));
    const destructive = readOptionalMetadata(() => readBoolean(value, "destructive"));
    const iconKey = readOptionalMetadata(() => readContextMenuIconKey(value.iconKey));
    const shortcutKey = readOptionalMetadata(() => readContextMenuShortcutKey(value.shortcutKey));
    return {
      id,
      label,
      ...(separatorBefore ? { separatorBefore } : {}),
      ...(destructive ? { destructive } : {}),
      ...(iconKey ? { iconKey } : {}),
      ...(shortcutKey ? { shortcutKey } : {}),
    };
  } catch {
    // Renderer payloads are untrusted data. A hostile getter or proxy must not
    // take down the desktop main process while a menu is being opened.
    return null;
  }
}

/**
 * Recursively sanitizes renderer-owned menu data into a bounded, plain tree.
 * Malformed nodes and empty submenus are dropped without throwing.
 */
export function normalizeContextMenuItems(input: unknown): readonly NormalizedContextMenuNode[] {
  try {
    if (!Array.isArray(input)) return [];
    return normalizeChildren(input, 0, {
      visitedNodeCount: 0,
      seenObjects: new WeakSet<object>(),
    });
  } catch {
    return [];
  }
}

function isSubmenu(node: NormalizedContextMenuNode): node is NormalizedContextMenuSubmenu {
  return "children" in node;
}

function translateLabel(label: string, translator: (label: string) => string): string {
  try {
    const translated = translator(label);
    return typeof translated === "string" && translated.length > 0 ? translated : label;
  } catch {
    return label;
  }
}

function resolveNativeDecoration<T>(
  resolver: ((key: T) => MenuItemConstructorOptions["icon"] | undefined) | undefined,
  key: T | undefined,
): MenuItemConstructorOptions["icon"] | undefined {
  if (!resolver || key === undefined) return undefined;
  try {
    return resolver(key);
  } catch {
    // A missing platform image must not remove or abort the menu row.
    return undefined;
  }
}

function resolveNativeAccelerator(
  resolver: NativeContextMenuTemplateOptions["resolveShortcut"],
  key: ContextMenuShortcutKey | undefined,
): MenuItemConstructorOptions["accelerator"] | undefined {
  if (!resolver || key === undefined) return undefined;
  try {
    return resolver(key);
  } catch {
    // A shortcut resolver is decoration-only and must not make a row unusable.
    return undefined;
  }
}

function buildTemplate(
  nodes: readonly NormalizedContextMenuNode[],
  options: NativeContextMenuTemplateOptions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  let hasInsertedDestructiveSeparator = false;

  for (const node of nodes) {
    const isDestructive = node.destructive === true || (!isSubmenu(node) && node.id === "delete");
    const shouldInsertSeparator =
      node.separatorBefore === true ||
      (isDestructive && !hasInsertedDestructiveSeparator && template.length > 0);
    if (shouldInsertSeparator && template.length > 0) {
      template.push({ type: "separator" });
    }

    if (isSubmenu(node)) {
      const submenu = buildTemplate(node.children, options);
      if (submenu.length === 0) continue;
      const item: MenuItemConstructorOptions = {
        label: translateLabel(node.label, options.translateLabel),
        submenu,
      };
      const icon =
        resolveNativeDecoration(options.resolveIcon, node.iconKey) ??
        (isDestructive ? options.destructiveIcon : undefined);
      if (icon) {
        item.icon = icon;
      }
      template.push(item);
    } else {
      const item: MenuItemConstructorOptions = {
        label: translateLabel(node.label, options.translateLabel),
        click: () => options.onLeafSelected(node.id),
      };
      const icon =
        resolveNativeDecoration(options.resolveIcon, node.iconKey) ??
        (isDestructive ? options.destructiveIcon : undefined);
      if (icon) {
        item.icon = icon;
      }
      const accelerator = resolveNativeAccelerator(options.resolveShortcut, node.shortcutKey);
      if (accelerator) {
        item.accelerator = accelerator;
      }
      template.push(item);
    }

    if (isDestructive) {
      hasInsertedDestructiveSeparator = true;
    }
  }
  return template;
}

/** Builds an Electron template with click handlers on leaves only. */
export function buildContextMenuTemplate(
  nodes: readonly NormalizedContextMenuNode[],
  options: NativeContextMenuTemplateOptions,
): MenuItemConstructorOptions[] {
  return buildTemplate(nodes, options);
}

/** Explicit name for callers that want to distinguish native template output. */
export const buildNativeContextMenuTemplate = buildContextMenuTemplate;

/** Keep the recursive wire type discoverable from the desktop boundary. */
export type ContextMenuWireNode = ContextMenuNode<string>;
/** Keep the submenu wire type discoverable from the desktop boundary. */
export type ContextMenuWireSubmenu = ContextMenuSubmenu<string>;
