// FILE: windowsExitPriority.ts
// Purpose: Lets the backend process finish exiting on a busy Windows machine.
// Layer: Server Windows platform runtime
//
// The backend's own shutdown is done in well under a second, but Windows still has to tear
// the process down, on whichever thread exits last. In the packaged app that is often the
// background-priority thread of Electron's Node mode, and with the CPUs busy (a fresh
// install being scanned, first-run probes) it waits 10-60 s for a turn: the desktop gives
// up waiting, and the process cannot be force-stopped because it is already exiting.

import { raiseProcessPriorityForExit } from "@moss/shared/platformProcess";

/**
 * Raises this process's priority as it exits, after every finalizer has run. Called once
 * from the server entry point on Windows.
 */
export function installWindowsExitPriority(
  target: Pick<NodeJS.Process, "once"> = process,
  raise: () => void = () => {
    raiseProcessPriorityForExit(0);
  },
): void {
  target.once("exit", () => raise());
}
