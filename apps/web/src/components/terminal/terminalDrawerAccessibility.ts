// FILE: terminalDrawerAccessibility.ts
// Purpose: Keep a closing terminal drawer out of pointer and keyboard interaction immediately.
// Layer: Terminal drawer presentation logic

export interface TerminalDrawerAccessibilityState {
  ariaHidden: true | undefined;
  inert: true | undefined;
  isInteractive: boolean;
}

export function resolveTerminalDrawerAccessibilityState(input: {
  isVisible: boolean;
  isWorkspaceMode: boolean;
}): TerminalDrawerAccessibilityState {
  const isInteractive = input.isWorkspaceMode || input.isVisible;
  return {
    ariaHidden: isInteractive ? undefined : true,
    inert: isInteractive ? undefined : true,
    isInteractive,
  };
}
