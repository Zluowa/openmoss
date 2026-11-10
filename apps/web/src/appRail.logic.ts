// FILE: appRail.logic.ts
// Purpose: Pure rules for the rail layout's tab strip: item ids, route item order, and
//          which item is active for a pathname, plus the projects pinned to the rail.
// Layer: Web shell logic
// Exports: rail item ids/types, rail item order and visibility, railItemForPathname,
//          reconcileActiveRailItem, rail project shortcuts

import type { ProjectId } from "@moss/contracts";

import { normalizeIdOrder, normalizeKnownIds, placeNewIdAfter } from "./lib/orderedIds";
import type { SidebarNavItemId } from "./sidebarNavOrdering";

/**
 * Rail items that switch the panel content instead of navigating: Home (projects and chats)
 * and "project", the panel a project pinned to the rail opens (that project's chats).
 * Spaces and Hubs were removed (2026-11-10); their saved ids drop out on read.
 */
export const RAIL_PANEL_ITEM_IDS = ["home", "project"] as const;
export type RailPanelItemId = (typeof RAIL_PANEL_ITEM_IDS)[number];
/**
 * Rail items that navigate to a route. "New thread" stays in the panel, never the rail;
 * Inbox is available in Stable and Beta (see INBOX_ON).
 */
export type RailRouteItemId =
  | Exclude<SidebarNavItemId, "newThread">
  | "settings"
  | "skills"
  | "mossbot";
/** Moss native-surface destinations: rail items that open an in-shell surface, not a route. */
export type RailSurfaceItemId = "images" | "library";
export type RailItemId = RailPanelItemId | RailRouteItemId | RailSurfaceItemId;

/**
 * Rail items the user orders and hides from Customize. Settings stays pinned at the bottom.
 * The reference rail leads with Home, Library, Images and activity. Extra destinations
 * remain reachable from More; user-customized orders still take precedence.
 */
export const RAIL_ORDERABLE_ITEM_IDS = [
  "home",
  "mossbot",
  "library",
  "automations",
  "images",
  "inbox",
  "pullRequests",
  "skills",
  "kanban",
  "tasks",
] as const;
export type RailOrderableItemId = (typeof RAIL_ORDERABLE_ITEM_IDS)[number];
/**
 * Moss rail spec: only the Codex destinations show by default. The Kanban/Tasks board slot
 * stays in Customize and the "…" menu but off the rail.
 */
export const DEFAULT_HIDDEN_RAIL_ITEMS: readonly RailOrderableItemId[] = [
  "kanban",
  "tasks",
  "skills",
];

const RAIL_ORDERABLE_ITEM_ID_SET: ReadonlySet<string> = new Set(RAIL_ORDERABLE_ITEM_IDS);

export function isRailOrderableItemId(value: string): value is RailOrderableItemId {
  return RAIL_ORDERABLE_ITEM_ID_SET.has(value);
}

/** Home is the rail's anchor for the panel: it can move but never be hidden. */
export function railItemCanHide(id: RailOrderableItemId): boolean {
  return id !== "home";
}

/**
 * A saved rail order as current ids. Ids of removed destinations (Spaces "spaces", Hubs
 * "studio") are dropped, so an old saved order never leaves a gap or a dead item.
 */
export function normalizeRailItemOrder(order: readonly string[]): RailOrderableItemId[] {
  if (order.length === 0) return [...RAIL_ORDERABLE_ITEM_IDS];
  const previousCodexDefault = [
    "home",
    "library",
    "images",
    "inbox",
    "pullRequests",
    "automations",
    "skills",
    "spaces",
    "kanban",
    "tasks",
    "studio",
  ];
  if (
    order.length === previousCodexDefault.length &&
    order.every((id, i) => id === previousCodexDefault[i])
  )
    return [...RAIL_ORDERABLE_ITEM_IDS];
  // Replace only the previous shipped default, never a user's reordered rail.
  const previousDefault = [
    "home",
    "inbox",
    "automations",
    "pullRequests",
    "images",
    "library",
    "skills",
    "spaces",
    "kanban",
    "tasks",
    "studio",
  ];
  if (
    order.length === previousDefault.length &&
    order.every((id, i) => id === previousDefault[i])
  ) {
    return [...RAIL_ORDERABLE_ITEM_IDS];
  }
  const normalized = normalizeIdOrder(order, RAIL_ORDERABLE_ITEM_IDS, isRailOrderableItemId);
  // Inbox shipped after users saved an order: it joins next to Home, as by default.
  return placeNewIdAfter(normalized, order, "inbox", "home");
}

export function normalizeHiddenRailItems(hidden: readonly string[]): RailOrderableItemId[] {
  const previousDefault = ["spaces", "kanban", "tasks", "studio"];
  const previousCodexDefault = [...previousDefault, "automations", "skills"];
  if (
    (hidden.length === previousDefault.length &&
      hidden.every((id, i) => id === previousDefault[i])) ||
    (hidden.length === previousCodexDefault.length &&
      hidden.every((id, i) => id === previousCodexDefault[i]))
  ) {
    return [...DEFAULT_HIDDEN_RAIL_ITEMS];
  }
  return normalizeKnownIds(hidden, isRailOrderableItemId).filter(railItemCanHide);
}

export interface RailAvailability {
  /** Whether this host offers Inbox. */
  readonly inboxAvailable: boolean;
  /** Whether this host ships the Images surface; account checks happen on use. */
  readonly imagesAvailable?: boolean;
}

/** Whether an item exists on this host at all: the rail and its Customize list agree. */
export function isRailItemAvailable(id: RailOrderableItemId, availability: RailAvailability) {
  if (id === "inbox") return availability.inboxAvailable;
  if (id === "images") return availability.imagesAvailable ?? false;
  return true;
}

/**
 * The rail's top items in the user's order. Hidden items drop out unless they are the
 * active item, so hiding a section never strands the user in it.
 */
export function buildRailItemOrder(
  input: {
    order: readonly RailOrderableItemId[];
    hidden: ReadonlySet<RailOrderableItemId>;
    activeItem: RailItemId;
  } & RailAvailability,
): RailOrderableItemId[] {
  return input.order.filter(
    (id) => isRailItemAvailable(id, input) && (!input.hidden.has(id) || id === input.activeItem),
  );
}

/** A project the user added to the rail from its "…" menu. */
export type RailShortcut = {
  readonly kind: "project";
  readonly key: string;
  readonly projectId: ProjectId;
};

const PROJECT_SHORTCUT_PREFIX = "project:";

export function railProjectShortcutKey(projectId: ProjectId): string {
  return `${PROJECT_SHORTCUT_PREFIX}${projectId}`;
}

/**
 * The persisted shortcut keys that still point at something, in their saved order: unknown,
 * deleted, and duplicate entries drop out, and so do the "space:…" keys older builds saved
 * when Spaces could be pinned.
 */
export function resolveRailShortcuts(input: {
  keys: readonly string[];
  projectIds: ReadonlySet<ProjectId>;
}): RailShortcut[] {
  const seen = new Set<string>();
  const shortcuts: RailShortcut[] = [];
  for (const key of input.keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key.startsWith(PROJECT_SHORTCUT_PREFIX)) {
      const id = key.slice(PROJECT_SHORTCUT_PREFIX.length) as ProjectId;
      if (input.projectIds.has(id)) shortcuts.push({ kind: "project", key, projectId: id });
    }
  }
  return shortcuts;
}

/** Adds a shortcut at the end of the rail, or removes it when it is already there. */
export function toggleRailShortcutKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

/**
 * The shortcut that stands for what the panel shows, so exactly one rail item is active:
 * a pinned project while the project panel shows its chats.
 */
export function resolveActiveRailShortcutKey(input: {
  activeItem: RailItemId;
  railProjectId: ProjectId | null;
  shortcuts: readonly RailShortcut[];
}): string | null {
  if (input.activeItem !== "project") return null;
  return (
    input.shortcuts.find((shortcut) => shortcut.projectId === input.railProjectId)?.key ?? null
  );
}

/**
 * Whether the panel column shows next to the rail for the active item. Every section either
 * owns a panel (Home and a pinned project: projects and threads; Automations, Settings: their own
 * lists) or takes the full width: Kanban, Tasks, Pull requests, Inbox, and Plugins each own
 * their page layout. Images/Library keep the panel: their surfaces replace only the route
 * column, like the pre-merge Moss shell.
 */
export function railItemShowsPanel(id: RailItemId): boolean {
  return (
    id !== "kanban" && id !== "tasks" && id !== "pullRequests" && id !== "inbox" && id !== "skills"
  );
}

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** The route rail item that owns a pathname, or null for thread and chat-index routes. */
export function railItemForPathname(pathname: string): RailRouteItemId | null {
  if (matchesRoute(pathname, "/mossbot")) return "mossbot";
  if (matchesRoute(pathname, "/inbox")) return "inbox";
  if (matchesRoute(pathname, "/kanban")) return "kanban";
  if (matchesRoute(pathname, "/tasks")) return "tasks";
  if (matchesRoute(pathname, "/pull-requests")) return "pullRequests";
  if (matchesRoute(pathname, "/automations")) return "automations";
  // Plugins (stored id "skills") owns the Codex Skills & Apps route family.
  if (matchesRoute(pathname, "/skills")) return "skills";
  if (matchesRoute(pathname, "/settings")) return "settings";
  return null;
}

/**
 * Re-syncs the active item after navigation: a route item wins when the pathname is its
 * route (shortcut, deep link, command palette); a Mossbot chat lives at a plain thread
 * path, so the sidebar's Mossbot detection counts as the Mossbot route; anywhere else the
 * current panel item is active, so exactly one rail item is active at a time.
 */
export function reconcileActiveRailItem(input: {
  current: RailItemId;
  pathname: string;
  onMossbotSurface?: boolean;
  panelView: RailPanelItemId;
}): RailItemId {
  return (
    railItemForPathname(input.pathname) ?? (input.onMossbotSurface ? "mossbot" : input.panelView)
  );
}
