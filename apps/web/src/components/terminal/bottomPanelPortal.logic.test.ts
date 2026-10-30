import { describe, expect, it } from "vitest";

import { resolveBottomPanelRenderTarget } from "./bottomPanelPortal.logic";

describe("resolveBottomPanelRenderTarget", () => {
  it("keeps quick chat and terminal workspace free of the drawer", () => {
    expect(
      resolveBottomPanelRenderTarget({
        isQuickChat: true,
        bottomPanelPresent: true,
        terminalWorkspaceOpen: false,
        externalHost: undefined,
      }),
    ).toBe("hidden");
    expect(
      resolveBottomPanelRenderTarget({
        isQuickChat: false,
        bottomPanelPresent: true,
        terminalWorkspaceOpen: true,
        externalHost: undefined,
      }),
    ).toBe("hidden");
  });

  it("uses the inline fallback when a surface does not opt into a route host", () => {
    expect(
      resolveBottomPanelRenderTarget({
        isQuickChat: false,
        bottomPanelPresent: true,
        terminalWorkspaceOpen: false,
        externalHost: undefined,
      }),
    ).toBe("inline");
  });

  it("waits for an opted-in route host instead of mounting inline and remounting xterm", () => {
    expect(
      resolveBottomPanelRenderTarget({
        isQuickChat: false,
        bottomPanelPresent: true,
        terminalWorkspaceOpen: false,
        externalHost: null,
      }),
    ).toBe("pending-host");
  });

  it("portals the drawer once the route host exists", () => {
    expect(
      resolveBottomPanelRenderTarget({
        isQuickChat: false,
        bottomPanelPresent: true,
        terminalWorkspaceOpen: false,
        externalHost: {} as HTMLElement,
      }),
    ).toBe("external");
  });
});
