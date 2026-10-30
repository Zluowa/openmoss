// FILE: bottomPanelPortal.logic.ts
// Purpose: Chooses the stable drawer mount point without remounting terminal runtimes.
// Layer: Pure app-shell presentation policy

export type BottomPanelRenderTarget = "hidden" | "inline" | "pending-host" | "external";

export function resolveBottomPanelRenderTarget(input: {
  isQuickChat: boolean;
  bottomPanelPresent: boolean;
  terminalWorkspaceOpen: boolean;
  externalHost: HTMLElement | null | undefined;
}): BottomPanelRenderTarget {
  if (input.isQuickChat || !input.bottomPanelPresent || input.terminalWorkspaceOpen) {
    return "hidden";
  }
  if (input.externalHost === undefined) {
    return "inline";
  }
  if (input.externalHost === null) {
    return "pending-host";
  }
  return "external";
}
