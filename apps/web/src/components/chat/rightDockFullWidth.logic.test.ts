// FILE: rightDockFullWidth.logic.test.ts
// Purpose: Locks the Codex-style full-width right-panel lifecycle and shell chrome contract.
// Layer: Chat right-dock unit tests
// Depends on: Pure right-dock full-width state and presentation helpers.

import { describe, expect, it } from "vitest";
import { formatMossTranslation, translateMoss } from "~/localization";

import {
  RIGHT_DOCK_FULL_WIDTH_AUTO_EXIT_MAX_WIDTH_PX,
  createRightDockFullWidthState,
  formatRightDockSurfaceControlTooltip,
  reduceRightDockFullWidthState,
  resolveRightDockChromeContract,
  resolveRightDockEffectiveFullWidth,
  resolveRightDockSurfaceControlShortcutLabels,
  shouldHideMainChatHeaderForRightDock,
} from "./rightDockFullWidth.logic";

describe("right dock full-width lifecycle", () => {
  it("snapshots full width while temporarily closed and restores it on reopen", () => {
    const expanded = reduceRightDockFullWidthState(createRightDockFullWidthState(), {
      type: "set-full-width",
      fullWidth: true,
    });
    const closed = reduceRightDockFullWidthState(expanded, { type: "temporary-close" });

    expect(closed).toEqual({
      fullWidth: false,
      restoreFullWidthOnNextOpen: true,
    });
    expect(reduceRightDockFullWidthState(closed, { type: "open" })).toEqual({
      fullWidth: true,
      restoreFullWidthOnNextOpen: false,
    });
    expect(resolveRightDockEffectiveFullWidth(closed, true)).toBe(true);
    expect(resolveRightDockEffectiveFullWidth(closed, false)).toBe(false);
  });

  it("clears both active and pending full width at the narrow-shell breakpoint", () => {
    const pendingRestore = {
      fullWidth: false,
      restoreFullWidthOnNextOpen: true,
    } as const;

    expect(
      reduceRightDockFullWidthState(pendingRestore, {
        type: "shell-resized",
        width: RIGHT_DOCK_FULL_WIDTH_AUTO_EXIT_MAX_WIDTH_PX,
      }),
    ).toEqual({
      fullWidth: false,
      restoreFullWidthOnNextOpen: false,
    });
    expect(
      reduceRightDockFullWidthState(createRightDockFullWidthState(), {
        type: "set-full-width",
        fullWidth: true,
        shellWidth: RIGHT_DOCK_FULL_WIDTH_AUTO_EXIT_MAX_WIDTH_PX,
      }),
    ).toEqual(createRightDockFullWidthState());
  });

  it("does not hide the main header while the dock is closed", () => {
    expect(
      shouldHideMainChatHeaderForRightDock({ rightDockOpen: true, rightDockFullWidth: true }),
    ).toBe(true);
    expect(
      shouldHideMainChatHeaderForRightDock({ rightDockOpen: false, rightDockFullWidth: true }),
    ).toBe(false);
  });
});

describe("right dock full-width chrome", () => {
  it("removes every divider and resize affordance in full-width mode", () => {
    const contract = resolveRightDockChromeContract(true);

    expect(contract.panelClassName).not.toContain("border-l");
    expect(contract.showSidebarRail).toBe(false);
    expect(contract.resizable).toBe(false);
  });

  it("keeps regular-mode divider, resizer, and rail", () => {
    const contract = resolveRightDockChromeContract(false);

    expect(contract.panelClassName).toContain("border-l");
    expect(contract.showSidebarRail).toBe(true);
    expect(contract.resizable).toBe(true);
  });

  it("formats replacement tooltips from the supplied keybinding label", () => {
    expect(formatRightDockSurfaceControlTooltip("切换底部面板显示", "Ctrl+Shift+Y")).toBe(
      "切换底部面板显示 (Ctrl+Shift+Y)",
    );
    expect(formatRightDockSurfaceControlTooltip("显示/隐藏侧边栏", null)).toBe("显示/隐藏侧边栏");
    expect(
      formatMossTranslation("en", "rightDock.toggleBottomPanelShortcut", {
        shortcut: "Ctrl+Shift+Y",
      }),
    ).toBe("Toggle bottom panel (Ctrl+Shift+Y)");
    expect(
      formatMossTranslation("zh-CN", "rightDock.toggleBottomPanelShortcut", {
        shortcut: "Ctrl+Shift+Y",
      }),
    ).toBe("切换底部面板显示（Ctrl+Shift+Y）");
    expect(translateMoss("en", "rightDock.toggleRightSidebar")).toBe("Toggle right sidebar");
    expect(translateMoss("zh-CN", "rightDock.toggleRightSidebar")).toBe("显示/隐藏侧边栏");
  });

  it("resolves replacement labels from the active keybinding configuration", () => {
    const labels = resolveRightDockSurfaceControlShortcutLabels(
      [
        {
          command: "terminal.toggle",
          shortcut: {
            key: "y",
            metaKey: false,
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            modKey: false,
          },
        },
        {
          command: "rightPanel.toggle",
          shortcut: {
            key: "u",
            metaKey: false,
            ctrlKey: true,
            shiftKey: false,
            altKey: true,
            modKey: false,
          },
        },
      ],
      "Win32",
    );

    expect(labels).toEqual({
      bottomPanel: "Ctrl+Shift+Y",
      rightPanel: "Ctrl+Alt+U",
    });
  });
});
