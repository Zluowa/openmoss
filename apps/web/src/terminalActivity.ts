import type { TerminalEvent } from "@moss/contracts";
import type { TerminalActivityState } from "@moss/shared/terminalThreads";

export interface TerminalActivityUpdate {
  agentState: TerminalActivityState | null;
  hasRunningSubprocess: boolean;
}

export function terminalActivityFromEvent(event: TerminalEvent): TerminalActivityUpdate | null {
  switch (event.type) {
    case "activity":
      return {
        hasRunningSubprocess: event.hasRunningSubprocess,
        agentState: event.agentState,
      };
    case "started":
    case "restarted":
    case "exited":
      return {
        hasRunningSubprocess: false,
        agentState: null,
      };
    default:
      return null;
  }
}
