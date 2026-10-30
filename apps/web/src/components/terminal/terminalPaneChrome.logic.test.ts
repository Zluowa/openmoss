import { describe, expect, it } from "vitest";

import { resolveTerminalPaneChrome } from "./terminalPaneChrome.logic";

const everyCapability = {
  canCloseDrawer: true,
  canCloseTerminal: true,
  canMoveTerminalToGroup: true,
  canNewTerminalTab: true,
  canSplitTerminalDown: true,
  canSplitTerminalRight: true,
  canTogglePanel: true,
  canTogglePresentationMode: true,
} as const;

describe("resolveTerminalPaneChrome", () => {
  it("keeps the drawer header to tabs, add, and one non-destructive close control", () => {
    expect(
      resolveTerminalPaneChrome({
        presentationMode: "drawer",
        ...everyCapability,
      }),
    ).toEqual({
      showInlineTabClose: false,
      showNewTerminalTab: true,
      trailingActions: ["close-drawer-terminal"],
    });
  });

  it("never leaks workspace controls into drawer chrome", () => {
    const plan = resolveTerminalPaneChrome({
      presentationMode: "drawer",
      ...everyCapability,
    });

    expect(plan.trailingActions).not.toContain("move-to-own-group");
    expect(plan.trailingActions).not.toContain("split-right");
    expect(plan.trailingActions).not.toContain("split-down");
    expect(plan.trailingActions).not.toContain("toggle-presentation");
    expect(plan.trailingActions).not.toContain("toggle-side-panel");
    expect(plan.trailingActions).not.toContain("delete-active-terminal");
  });

  it("omits unavailable drawer add and close controls", () => {
    expect(
      resolveTerminalPaneChrome({
        presentationMode: "drawer",
        ...everyCapability,
        canCloseDrawer: false,
        canNewTerminalTab: false,
      }),
    ).toEqual({
      showInlineTabClose: false,
      showNewTerminalTab: false,
      trailingActions: [],
    });
  });

  it("keeps drawer close non-destructive and independent from terminal deletion", () => {
    expect(
      resolveTerminalPaneChrome({
        presentationMode: "drawer",
        ...everyCapability,
        canCloseTerminal: false,
      }).trailingActions,
    ).toEqual(["close-drawer-terminal"]);

    expect(
      resolveTerminalPaneChrome({
        presentationMode: "drawer",
        ...everyCapability,
        canCloseDrawer: false,
      }).trailingActions,
    ).toEqual([]);
  });

  it("preserves the existing capability-driven workspace action order", () => {
    expect(
      resolveTerminalPaneChrome({
        presentationMode: "workspace",
        ...everyCapability,
      }),
    ).toEqual({
      showInlineTabClose: true,
      showNewTerminalTab: true,
      trailingActions: [
        "move-to-own-group",
        "split-right",
        "split-down",
        "toggle-presentation",
        "toggle-side-panel",
        "delete-active-terminal",
      ],
    });
  });

  it("filters unavailable workspace actions without changing the surviving order", () => {
    expect(
      resolveTerminalPaneChrome({
        presentationMode: "workspace",
        ...everyCapability,
        canCloseTerminal: false,
        canMoveTerminalToGroup: false,
        canSplitTerminalDown: false,
        canTogglePanel: false,
      }),
    ).toEqual({
      showInlineTabClose: false,
      showNewTerminalTab: true,
      trailingActions: ["split-right", "toggle-presentation"],
    });
  });
});
