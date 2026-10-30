import { describe, expect, it, vi } from "vitest";

import {
  buildContextMenuTemplate,
  CONTEXT_MENU_MAX_CHILDREN_PER_MENU,
  CONTEXT_MENU_MAX_DEPTH,
  CONTEXT_MENU_MAX_ID_LENGTH,
  CONTEXT_MENU_MAX_LABEL_LENGTH,
  CONTEXT_MENU_MAX_NODE_COUNT,
  createContextMenuOneShotResolver,
  normalizeContextMenuItems,
  type NormalizedContextMenuNode,
} from "./contextMenu";

function countNodes(nodes: readonly NormalizedContextMenuNode[]): number {
  return nodes.reduce(
    (count, node) =>
      count + 1 + ("children" in node && node.children ? countNodes(node.children) : 0),
    0,
  );
}

describe("context-menu normalization", () => {
  it("keeps flat leaves and recursively normalizes children/aliases", () => {
    const normalized = normalizeContextMenuItems([
      { id: "rename", label: "Rename" },
      {
        label: "Project",
        children: [
          { id: "open", label: "Open" },
          { label: "Copy", items: [{ id: "path", label: "Copy path" }] },
          { label: "Empty", children: [] },
        ],
      },
      { label: "Section", submenu: [{ id: "move", label: "Move" }] },
    ]);

    expect(normalized).toEqual([
      { id: "rename", label: "Rename" },
      {
        label: "Project",
        children: [
          { id: "open", label: "Open" },
          { label: "Copy", children: [{ id: "path", label: "Copy path" }] },
        ],
      },
      { label: "Section", children: [{ id: "move", label: "Move" }] },
    ]);
  });

  it("drops malformed, ambiguous, empty, and cyclic nodes without throwing", () => {
    const cyclic: Record<string, unknown> = { label: "Cycle", children: [] };
    (cyclic.children as unknown[]).push(cyclic);

    expect(
      normalizeContextMenuItems([
        null,
        { id: "", label: "Missing id" },
        { id: "ok", label: "   " },
        { id: "ok", label: "Ok", children: [] },
        { label: "Ambiguous", children: [], items: [] },
        { label: "Not an array", children: "bad" },
        cyclic,
      ]),
    ).toEqual([]);
  });

  it("enforces depth, node, child, id, and label limits", () => {
    const tooLongId = "x".repeat(CONTEXT_MENU_MAX_ID_LENGTH + 1);
    const tooLongLabel = "x".repeat(CONTEXT_MENU_MAX_LABEL_LENGTH + 1);
    const tooManyRootChildren = Array.from(
      { length: CONTEXT_MENU_MAX_CHILDREN_PER_MENU + 4 },
      (_, index) => ({ id: `root-${index}`, label: `Root ${index}` }),
    );

    const normalized = normalizeContextMenuItems([
      ...tooManyRootChildren,
      { id: tooLongId, label: "Long id" },
      { id: "long-label", label: tooLongLabel },
    ]);
    expect(normalized).toHaveLength(CONTEXT_MENU_MAX_CHILDREN_PER_MENU);

    const heavilyNested = Array.from(
      { length: CONTEXT_MENU_MAX_CHILDREN_PER_MENU },
      (_, index) => ({
        label: `Group ${index}`,
        children: Array.from({ length: CONTEXT_MENU_MAX_CHILDREN_PER_MENU }, (_, childIndex) => ({
          id: `${index}-${childIndex}`,
          label: `Child ${childIndex}`,
        })),
      }),
    );
    const bounded = normalizeContextMenuItems(heavilyNested);
    expect(countNodes(bounded)).toBeLessThanOrEqual(CONTEXT_MENU_MAX_NODE_COUNT);

    let tooDeep: Record<string, unknown> = { id: "leaf", label: "Leaf" };
    for (let depth = CONTEXT_MENU_MAX_DEPTH; depth >= 0; depth -= 1) {
      tooDeep = { label: `Depth ${depth}`, children: [tooDeep] };
    }
    expect(normalizeContextMenuItems([tooDeep])).toEqual([]);
  });

  it("retains only the closed trusted presentation vocabulary", () => {
    expect(
      normalizeContextMenuItems([
        {
          id: "pin",
          label: "Pin",
          iconKey: "pin",
          shortcutKey: "pin",
        },
        {
          id: "unknown-icon",
          label: "Unknown icon",
          iconKey: "raw-svg",
          shortcutKey: "Cmd+R",
        },
        {
          label: "Nested",
          iconKey: "rename",
          shortcutKey: "archive",
          children: [
            { id: "archive", label: "Archive", iconKey: "archive", shortcutKey: "archive" },
          ],
        },
      ]),
    ).toEqual([
      { id: "pin", label: "Pin", iconKey: "pin", shortcutKey: "pin" },
      { id: "unknown-icon", label: "Unknown icon" },
      {
        label: "Nested",
        iconKey: "rename",
        children: [{ id: "archive", label: "Archive", iconKey: "archive", shortcutKey: "archive" }],
      },
    ]);
  });

  it("keeps a valid node when an optional presentation getter is hostile", () => {
    const hostile = { id: "safe", label: "Safe" } as Record<string, unknown>;
    Object.defineProperties(hostile, {
      iconKey: {
        get: () => {
          throw new Error("hostile icon getter");
        },
      },
      shortcutKey: {
        get: () => {
          throw new Error("hostile shortcut getter");
        },
      },
    });

    expect(normalizeContextMenuItems([hostile])).toEqual([{ id: "safe", label: "Safe" }]);
  });
});

describe("context-menu native template", () => {
  it("translates every level, preserves groups, and wires only leaves", () => {
    const normalized = normalizeContextMenuItems([
      { id: "rename", label: "Rename" },
      {
        label: "Project",
        children: [
          { id: "open", label: "Open" },
          { id: "delete", label: "Delete", destructive: true },
        ],
      },
      { id: "delete-all", label: "Delete all", destructive: true },
    ]);
    const selected: string[] = [];
    const template = buildContextMenuTemplate(normalized, {
      translateLabel: (label) => `zh:${label}`,
      onLeafSelected: (id) => selected.push(id),
    });

    expect(template.map((item) => item.type ?? "item")).toEqual([
      "item",
      "item",
      "separator",
      "item",
    ]);
    expect(template[0]?.label).toBe("zh:Rename");
    expect(template[1]?.label).toBe("zh:Project");
    expect(template[1]?.click).toBeUndefined();
    expect(template[1]?.submenu).toEqual([
      { label: "zh:Open", click: expect.any(Function) },
      { type: "separator" },
      { label: "zh:Delete", click: expect.any(Function) },
    ]);

    const projectItems = template[1]?.submenu as Array<{ click?: () => void }>;
    projectItems[0]?.click?.();
    projectItems[2]?.click?.();
    expect(selected).toEqual(["open", "delete"]);
  });

  it("keeps explicit separators at each recursive level and settles native results once", () => {
    const normalized = normalizeContextMenuItems([
      { id: "one", label: "One" },
      {
        label: "Nested",
        separatorBefore: true,
        children: [
          { id: "two", label: "Two" },
          { id: "three", label: "Three", separatorBefore: true },
        ],
      },
    ]);
    const resolve = vi.fn<(id: string | null) => void>();
    const settle = createContextMenuOneShotResolver(resolve);
    const template = buildContextMenuTemplate(normalized, {
      translateLabel: (label) => label,
      onLeafSelected: settle,
    });
    expect(template[1]).toEqual({ type: "separator" });
    const submenu = template[2]?.submenu as Array<{ type?: string; click?: () => void }>;
    expect(submenu[1]).toEqual({ type: "separator" });
    submenu[2]?.click?.();
    submenu[2]?.click?.();
    settle(null);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("three");
  });

  it("maps trusted decorations without letting resolver failures drop rows", () => {
    const normalized = normalizeContextMenuItems([
      { id: "pin", label: "Pin", iconKey: "pin", shortcutKey: "pin" },
      { id: "rename", label: "Rename", iconKey: "rename", shortcutKey: "rename" },
      { id: "unread", label: "Unread", iconKey: "mark-unread", shortcutKey: "mark-unread" },
      { id: "archive", label: "Archive", iconKey: "archive", shortcutKey: "archive" },
      { id: "delete", label: "Delete", iconKey: "delete", destructive: true },
    ]);
    const template = buildContextMenuTemplate(normalized, {
      translateLabel: (label) => label,
      onLeafSelected: () => undefined,
      resolveIcon: (key) => (key === "rename" ? undefined : `icon:${key}`),
      resolveShortcut: (key) => (key === "archive" ? undefined : `shortcut:${key}`),
    });

    expect(
      template.map((item) => ({
        label: item.label,
        icon: item.icon,
        accelerator: item.accelerator,
      })),
    ).toEqual([
      { label: "Pin", icon: "icon:pin", accelerator: "shortcut:pin" },
      { label: "Rename", icon: undefined, accelerator: "shortcut:rename" },
      { label: "Unread", icon: "icon:mark-unread", accelerator: "shortcut:mark-unread" },
      { label: "Archive", icon: "icon:archive", accelerator: undefined },
      { label: undefined, icon: undefined, accelerator: undefined },
      { label: "Delete", icon: "icon:delete", accelerator: undefined },
    ]);
  });
});
