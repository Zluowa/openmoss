import { ProjectId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  buildRailItemOrder,
  railItemShowsPanel,
  railProjectShortcutKey,
  resolveActiveRailShortcutKey,
  resolveRailShortcuts,
  toggleRailShortcutKey,
  railItemForPathname,
  reconcileActiveRailItem,
  normalizeHiddenRailItems,
  normalizeRailItemOrder,
  isRailItemAvailable,
  RAIL_ORDERABLE_ITEM_IDS,
  DEFAULT_HIDDEN_RAIL_ITEMS,
} from "./appRail.logic";

describe("rail item order", () => {
  it("updates the previous shipped default while preserving customized ordering and visibility", () => {
    expect(
      normalizeRailItemOrder([
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
      ]),
    ).toEqual(RAIL_ORDERABLE_ITEM_IDS);
    expect(normalizeRailItemOrder(["home", "images", "library", "inbox"]).slice(0, 4)).toEqual([
      "home",
      "images",
      "library",
      "inbox",
    ]);
    expect(normalizeHiddenRailItems(["spaces", "kanban", "tasks", "studio"])).toContain("skills");
  });

  it("completes a saved order with new items and drops unknown or duplicate ids", () => {
    expect(normalizeRailItemOrder(["automations", "gone", "home", "automations"])).toEqual([
      "automations",
      "home",
      "inbox",
      "mossbot",
      "library",
      "images",
      "pullRequests",
      "skills",
      "kanban",
      "tasks",
    ]);
  });

  it("drops the removed Spaces and Hubs items from saved orders without leaving a gap", () => {
    // The default order saved by builds that still had Spaces ("spaces") and Hubs ("studio").
    const savedWithRemovedItems = [
      "home",
      "mossbot",
      "library",
      "automations",
      "images",
      "inbox",
      "pullRequests",
      "skills",
      "spaces",
      "kanban",
      "tasks",
      "studio",
    ];
    expect(normalizeRailItemOrder(savedWithRemovedItems)).toEqual(RAIL_ORDERABLE_ITEM_IDS);
    // A user who pinned both to the top keeps the rest of their order.
    expect(normalizeRailItemOrder(["spaces", "studio", "images", "home"]).slice(0, 2)).toEqual([
      "images",
      "home",
    ]);
    expect(normalizeRailItemOrder(["spaces", "studio"])).not.toContain("spaces");
    // Hidden lists that still name them: the current default maps to the new default, and a
    // custom list just loses the removed ids.
    expect(normalizeHiddenRailItems(["spaces", "kanban", "tasks", "studio", "skills"])).toEqual(
      DEFAULT_HIDDEN_RAIL_ITEMS,
    );
    expect(normalizeHiddenRailItems(["spaces"])).toEqual([]);
    expect(normalizeHiddenRailItems(["studio", "images"])).toEqual(["images"]);
  });

  it("slots Inbox next to Home in orders saved before it shipped, then keeps its place", () => {
    expect(normalizeRailItemOrder(["kanban", "home"])).toEqual([
      "kanban",
      "home",
      "inbox",
      "mossbot",
      "library",
      "automations",
      "images",
      "pullRequests",
      "skills",
      "tasks",
    ]);
    expect(normalizeRailItemOrder(["home", "images", "inbox"]).slice(0, 3)).toEqual([
      "home",
      "images",
      "inbox",
    ]);
  });

  it("never keeps Home hidden", () => {
    expect(normalizeHiddenRailItems(["home", "kanban", "gone", "kanban"])).toEqual(["kanban"]);
  });

  it("drops hidden items unless active, and Inbox or Images unless available", () => {
    const order = normalizeRailItemOrder([]);
    expect(
      buildRailItemOrder({
        order,
        hidden: new Set(["automations"]),
        activeItem: "automations",
        inboxAvailable: false,
        imagesAvailable: false,
      }),
    ).toEqual([
      "home",
      "mossbot",
      "library",
      "automations",
      "pullRequests",
      "skills",
      "kanban",
      "tasks",
    ]);
    expect(
      buildRailItemOrder({
        order,
        hidden: new Set(),
        activeItem: "home",
        inboxAvailable: true,
        imagesAvailable: true,
      }),
    ).toEqual(order);
  });

  it("offers Inbox and Images in Customize only where they exist", () => {
    const stable = { inboxAvailable: false, imagesAvailable: false };
    expect(RAIL_ORDERABLE_ITEM_IDS.filter((id) => isRailItemAvailable(id, stable))).toEqual([
      "home",
      "mossbot",
      "library",
      "automations",
      "pullRequests",
      "skills",
      "kanban",
      "tasks",
    ]);
    expect(isRailItemAvailable("inbox", { inboxAvailable: true, imagesAvailable: false })).toBe(
      true,
    );
    // The host advertises its surface independently of account admission.
    expect(isRailItemAvailable("images", { inboxAvailable: false, imagesAvailable: true })).toBe(
      true,
    );
    expect(isRailItemAvailable("images", { inboxAvailable: false })).toBe(false);
  });
});

describe("restored Codex destination defaults", () => {
  it("places the real Scheduled destination after Home and data spaces", () => {
    expect(normalizeRailItemOrder([]).slice(0, 4)).toEqual([
      "home",
      "mossbot",
      "library",
      "automations",
    ]);
    expect(DEFAULT_HIDDEN_RAIL_ITEMS).not.toContain("automations");
    expect(
      normalizeHiddenRailItems(["spaces", "kanban", "tasks", "studio", "automations", "skills"]),
    ).toEqual(DEFAULT_HIDDEN_RAIL_ITEMS);
    expect(normalizeHiddenRailItems(["automations", "images"])).toEqual(["automations", "images"]);
    expect(normalizeRailItemOrder(["images", "home", "automations"]).slice(0, 4)).toEqual([
      "images",
      "home",
      "inbox",
      "automations",
    ]);
  });
});

describe("rail shortcuts", () => {
  const alpha = ProjectId.makeUnsafe("project-alpha");

  it("keeps saved project shortcuts that still exist, in order, without duplicates", () => {
    const shortcuts = resolveRailShortcuts({
      keys: [
        railProjectShortcutKey(alpha),
        "project:gone",
        railProjectShortcutKey(alpha),
        "unknown",
      ],
      projectIds: new Set([alpha]),
    });
    expect(shortcuts.map((shortcut) => shortcut.key)).toEqual([railProjectShortcutKey(alpha)]);
  });

  it("drops Space shortcuts saved by builds that still had Spaces", () => {
    const shortcuts = resolveRailShortcuts({
      keys: ["space:__void__", "space:space-work", railProjectShortcutKey(alpha)],
      projectIds: new Set([alpha]),
    });
    expect(shortcuts).toEqual([
      { kind: "project", key: railProjectShortcutKey(alpha), projectId: alpha },
    ]);
  });

  it("toggles a shortcut in and out at the end of the rail", () => {
    const key = railProjectShortcutKey(alpha);
    expect(toggleRailShortcutKey(["a"], key)).toEqual(["a", key]);
    expect(toggleRailShortcutKey(["a", key], key)).toEqual(["a"]);
  });

  it("marks the pinned project the project panel shows", () => {
    const shortcuts = resolveRailShortcuts({
      keys: [railProjectShortcutKey(alpha)],
      projectIds: new Set([alpha]),
    });
    const base = { shortcuts, railProjectId: alpha };
    expect(resolveActiveRailShortcutKey({ ...base, activeItem: "project" })).toBe(
      railProjectShortcutKey(alpha),
    );
    expect(resolveActiveRailShortcutKey({ ...base, activeItem: "home" })).toBeNull();
    expect(resolveActiveRailShortcutKey({ ...base, activeItem: "kanban" })).toBeNull();
  });
});

describe("railItemShowsPanel", () => {
  it("hides the panel only for the full-width sections", () => {
    expect(railItemShowsPanel("kanban")).toBe(false);
    expect(railItemShowsPanel("tasks")).toBe(false);
    expect(railItemShowsPanel("pullRequests")).toBe(false);
    expect(railItemShowsPanel("inbox")).toBe(false);
    expect(railItemShowsPanel("skills")).toBe(false);
    expect(railItemShowsPanel("mossbot")).toBe(true);
    for (const id of ["home", "project", "automations", "settings", "images", "library"] as const) {
      expect(railItemShowsPanel(id)).toBe(true);
    }
  });
});

describe("railItemForPathname", () => {
  it("maps route prefixes to their rail item and everything else to null", () => {
    expect(railItemForPathname("/inbox")).toBe("inbox");
    expect(railItemForPathname("/kanban")).toBe("kanban");
    expect(railItemForPathname("/tasks")).toBe("tasks");
    expect(railItemForPathname("/pull-requests/42")).toBe("pullRequests");
    expect(railItemForPathname("/automations")).toBe("automations");
    expect(railItemForPathname("/mossbot")).toBe("mossbot");
    expect(railItemForPathname("/skills")).toBe("skills");
    expect(railItemForPathname("/skills/manage")).toBe("skills");
    // Hubs were removed; their old paths redirect Home and own no rail item.
    expect(railItemForPathname("/studio/abc")).toBeNull();
    expect(railItemForPathname("/groups")).toBeNull();
    expect(railItemForPathname("/hubs")).toBeNull();
    expect(railItemForPathname("/settings")).toBe("settings");
    expect(railItemForPathname("/kanbanish")).toBeNull();
    expect(railItemForPathname("/")).toBeNull();
    expect(railItemForPathname("/thread-1")).toBeNull();
  });
});

describe("reconcileActiveRailItem", () => {
  it("lets a route match win and otherwise falls back to the current panel", () => {
    const base = { panelView: "project" } as const;
    expect(reconcileActiveRailItem({ ...base, current: "project", pathname: "/kanban" })).toBe(
      "kanban",
    );
    expect(reconcileActiveRailItem({ ...base, current: "kanban", pathname: "/thread-1" })).toBe(
      "project",
    );
  });

  it("keeps Mossbot active on a Mossbot chat's plain thread path", () => {
    expect(
      reconcileActiveRailItem({
        current: "mossbot",
        pathname: "/thread-1",
        onMossbotSurface: true,
        panelView: "home",
      }),
    ).toBe("mossbot");
  });
});
